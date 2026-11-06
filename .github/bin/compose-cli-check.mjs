// bin/compose-cli-check.mjs — `docker compose config` 真实渲染校验（可选，bin 层：允许 fs + 进程调用）
//
// 定位：**阶段 2 的「1Panel 上下文模拟渲染」的第二条腿**。
//   · 第一条腿：lib/compose-render.mjs 的**纯 JS/YAML AST 静态降级校验**（永远可用，零依赖）。
//   · 第二条腿：把**原始 compose** + **按 1Panel 上下文生成的 .env** 交给真实的
//     `docker compose config` 解析一遍 —— 这是 compose 自己的插值/校验语义，权威性最高。
//
// ⚠️ 关键设计：**写原始 compose + .env，让 compose 自己插值**（而不是写插值后的 YAML）。
//    这样才能真正验证 compose 的插值语义（例如 `${VAR:?msg}` 会让 compose 直接失败）。
//
// ⚠️ CLI 不可用时**必须降级**（返回 {available:false}），并由调用方在报告里显式标注
//    「compose CLI 不可用，已降级为静态 AST 校验」——**不得把降级说成 compose config 通过**。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 探测 `docker compose` CLI 是否可用。
 * @param {{spawn?:Function}} [opts]
 * @returns {{available:boolean, version:string|null, reason:string|null}}
 */
export function detectComposeCli(opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  try {
    const res = spawn('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 20000 });
    if (res?.error) return { available: false, version: null, reason: res.error.message };
    if (res?.status === 0) {
      const version = String(res.stdout ?? '').trim().split('\n')[0] ?? null;
      return { available: true, version, reason: null };
    }
    return { available: false, version: null, reason: `docker compose version 退出码 ${res?.status ?? '未知'}` };
  } catch (err) {
    return { available: false, version: null, reason: err?.message ?? String(err) };
  }
}

/**
 * 用真实的 `docker compose config` 校验一个 compose 文件。
 *
 * @param {object} params
 * @param {string} params.composeRaw - 原始 compose 文本（**不要**预先插值）
 * @param {Record<string,string>} params.env - 1Panel 上下文变量
 * @param {string} params.label - 用于报错信息的标识（如 `<app>/<version>/docker-compose.yml`）
 * @param {{spawn?:Function, timeoutMs?:number}} [opts]
 * @returns {{ok:boolean, error:string|null, stderr:string|null}}
 */
export function checkComposeWithCli({ composeRaw, env, label }, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const timeoutMs = opts.timeoutMs ?? 60000;

  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), '1panel-compose-cfg-'));
    const composePath = join(dir, 'docker-compose.yml');
    writeFileSync(composePath, composeRaw, 'utf8');
    // .env 只需写值；compose 会自动读取同目录的 .env
    const envLines = Object.entries(env ?? {})
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`);
    writeFileSync(join(dir, '.env'), `${envLines.join('\n')}\n`, 'utf8');

    const res = spawn('docker', ['compose', '--project-directory', dir, '-f', composePath, 'config', '-q'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, COMPOSE_PROJECT_NAME: '1panel_compose_cfg_check', DOCKER_CONFIG: join(dir, '.docker') },
      cwd: dir,
    });
    if (res.status === 0) return { ok: true, error: null, stderr: null };
    const stderr = String(res.stderr ?? '').trim();
    return { ok: false, error: stderr || `docker compose config 退出码 ${res.status}`, stderr };
  } catch (err) {
    return { ok: false, error: `调用 docker compose 失败: ${err?.message ?? String(err)}`, stderr: null };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻断主流程 */ } }
  }
}
