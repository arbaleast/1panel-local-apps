#!/usr/bin/env node
// bin/smoke-test.mjs — 隔离沙箱实际部署冒烟测试（阶段 7 执行器）
//
// ── 沙箱安全隔离铁律（逐条落实，勿绕过）────────────────────────────────────
//   1. 完全隔离命名空间：
//        · 工作目录 = os.tmpdir() 下的 mkdtemp 随机目录
//        · COMPOSE_PROJECT_NAME = 1panel_smoke_<app>_<timestamp>
//        · 测试网络 = 1panel_smoke_net_<timestamp>（compose 自行创建，**绝不**碰宿主机 1panel-network）
//   2. 端口与数据隔离：
//        · 宿主机端口 = 动态分配的空闲随机端口，全部绑到 127.0.0.1
//        · 所有 bind mount = 临时目录下的新建子目录；具名卷加冒烟前缀
//        · **绝不**挂载任何真实用户路径（compose 里的宿主机绝对路径 → 条件跳过）
//   3. 强制清理兜底：
//        · try/finally + SIGINT/SIGTERM/exit 处理 → docker compose down -v --remove-orphans + 删临时目录
//        · 清理函数**幂等**；清理失败 = 冒烟 FAILED（残留即失败）
//
// ── 三态语义（严禁把「未验证」伪装成「已通过」）────────────────────────────
//   PASSED     — 9 步全过
//   FAILED     — 明确观察到故障（容器起不来 / Permission denied / 日志致命错误 / 清理残留）
//   UNVERIFIED — 环境不具备（无 docker / 条件跳过：GPU / 外部 DB / host 网络 / 特权 / 真实路径）
//
// 用法：
//   node .github/bin/smoke-test.mjs --app kiwix-serve
//   node .github/bin/smoke-test.mjs --app kiwix-serve --version latest --json

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import yaml from 'js-yaml';
import { stripCommentedLines } from '../lib/consistency.mjs';
import { buildPanelEnv } from '../lib/compose-render.mjs';
import { buildSmokePlan, detectSkipConditions } from '../lib/smoke-plan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 9 步流程的步骤标识（顺序固定，报告与 CI 依赖它） */
export const SMOKE_STEPS = Object.freeze(['plan', 'config', 'pull', 'up', 'status', 'health', 'persist', 'logs', 'cleanup']);

/** 容器日志里的致命模式（命中即 FAILED） */
const FATAL_LOG_PATTERNS = [
  /permission denied/i,
  /segmentation fault/i,
  /core dumped/i,
  /out of memory/i,
  /oomkilled/i,
  /panic:/i,
  /fatal error/i,
  /fatal:/i,
];

/** 清理阶段的异常信息（不作为致命日志，但必须报告） */
const CLEANUP_LOG_PATTERN = /fatal error/i;

// ─── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 把应用/项目名清洗成 compose 允许的字符集（`[a-z0-9_-]`）。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/**
 * 分配一个当前空闲的宿主机端口。
 * @returns {Promise<number>}
 */
export function allocateFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/**
 * TCP 探活。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probeTcp(port, timeoutMs = 3000) {
  return new Promise((done) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* ignore */ } done(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

/**
 * 列出某应用下的版本目录（口径与 lint 一致：排除 data/scripts/点目录）。
 * @param {string} appDirAbs
 * @returns {string[]}
 */
function listVersionDirs(appDirAbs) {
  let entries = [];
  try { entries = readdirSync(appDirAbs, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'data' && e.name !== 'scripts' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((v) => existsSync(join(appDirAbs, v, 'data.yml')) || existsSync(join(appDirAbs, v, 'docker-compose.yml')))
    .sort();
}

/**
 * 解析 compose（剥注释，与仓库其它链路同口径）。
 * @param {string} p
 * @returns {object|null}
 */
function parseCompose(p) {
  try {
    const raw = readFileSync(p, 'utf8');
    return yaml.load(stripCommentedLines(raw).map((l) => l.text).join('\n'));
  } catch { return null; }
}

/**
 * 解析 data.yml（宽松）。
 * @param {string} p
 * @returns {object|null}
 */
function parseDataYml(p) {
  try { return yaml.load(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 从 compose 文档里收集需要分配宿主机端口的键。
 * @param {object} composeDoc
 * @returns {string[]} 变量名或 `#literal:<service>:<index>` 合成键
 */
export function collectPortKeys(composeDoc) {
  const keys = [];
  for (const [name, svc] of Object.entries(composeDoc?.services ?? {})) {
    const list = Array.isArray(svc?.ports) ? svc.ports : [];
    list.forEach((spec, i) => {
      if (typeof spec !== 'string') return;
      const body = spec.replace(/\/(tcp|udp|sctp)$/i, '');
      // 尊重 ${} 内的冒号
      const segs = [];
      let cur = ''; let depth = 0;
      for (const ch of body) {
        if (ch === '$' && body.includes('{')) { /* noop */ }
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
        if (ch === ':' && depth === 0) { segs.push(cur); cur = ''; continue; }
        cur += ch;
      }
      segs.push(cur);
      if (segs.length < 2) return; // 仅容器端口 → 不占宿主机端口
      const hostSegment = segs.length >= 3 ? segs[1] : segs[0];
      const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(hostSegment);
      keys.push(m ? m[1] : `#literal:${name}:${i}`);
    });
  }
  return [...new Set(keys)];
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 跑一次隔离冒烟测试。
 *
 * @param {object} opts
 * @param {string} opts.app
 * @param {string} [opts.version]
 * @param {string} [opts.root]
 * @param {string} [opts.dockerBin='docker']
 * @param {Function} [opts.log]
 * @param {number} [opts.timeoutMs=180000]
 * @param {Function} [opts.portAllocator]
 * @param {boolean} [opts.pull=true]
 * @returns {Promise<object>}
 */
export async function runSmokeTest(opts) {
  const o = opts ?? {};
  const root = resolve(o.root ?? REPO_ROOT);
  const dockerBin = o.dockerBin ?? 'docker';
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? 180000;
  const portAllocator = o.portAllocator ?? allocateFreePort;
  const doPull = o.pull !== false;

  /** @type {Array<{step:string, ok:boolean, detail:string, skipped?:boolean}>} */
  const steps = [];
  /**
   * 记录一步。
   * @param {string} step
   * @param {boolean} ok
   * @param {string} detail
   * @param {boolean} [skipped]
   */
  const record = (step, ok, detail, skipped = false) => {
    steps.push({ step, ok, detail, ...(skipped ? { skipped: true } : {}) });
    log(`[${ok ? 'ok' : 'FAIL'}] ${step}: ${detail}`);
  };

  const timestamp = Date.now();
  const projectName = `1panel_smoke_${sanitizeName(o.app)}_${timestamp}`;
  const testNetwork = `1panel_smoke_net_${timestamp}`;

  /** @type {string|null} */
  let tmpDir = null;
  /** @type {string|null} */
  let composeFile = null;
  /** @type {string|null} */
  let envFile = null;
  let composeDownRan = false;
  let tmpRemoved = false;
  let cleanupOk = true;

  /** 执行一条 docker 命令 */
  const run = (args, opts2 = {}) => {
    const res = spawnSync(dockerBin, args, {
      encoding: 'utf8',
      timeout: opts2.timeoutMs ?? 60000,
      cwd: opts2.cwd ?? tmpDir ?? root,
      env: { ...process.env, COMPOSE_PROJECT_NAME: projectName, ...(opts2.env ?? {}) },
    });
    return {
      status: res.status,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      error: res.error ?? null,
    };
  };

  /** compose 子命令的公共前缀 */
  const composeArgs = (sub) => [
    'compose',
    '-f', composeFile ?? '',
    '--env-file', envFile ?? '',
    '--project-name', projectName,
    ...sub,
  ];

  /**
   * 清理（幂等）：down -v --remove-orphans + 删临时目录。
   * @returns {Promise<boolean>} 是否清理成功
   */
  const cleanup = async () => {
    if (composeFile && tmpDir && existsSync(tmpDir)) {
      try {
        const res = run(composeArgs(['down', '-v', '--remove-orphans']), { timeoutMs: 60000 });
        composeDownRan = true;
        if (res.status !== 0) {
          cleanupOk = false;
          log(`[cleanup] docker compose down 退出码 ${res.status}: ${res.stderr.slice(0, 300)}`);
        }
      } catch (err) {
        cleanupOk = false;
        log(`[cleanup] docker compose down 抛错: ${err?.message ?? err}`);
      }
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpRemoved = !existsSync(tmpDir);
      } catch (err) {
        cleanupOk = false;
        tmpRemoved = false;
        log(`[cleanup] 临时目录删除失败: ${err?.message ?? err}`);
      }
    } else {
      // 从未创建临时目录 → 无残留可清（不是失败）
      tmpRemoved = true;
    }
    return cleanupOk;
  };

  // 信号兜底：中断也要清干净
  // ⚠️ 必须用具名 handler + 在 finally 里 `off` 摘除 —— `--changed` 模式会逐个应用循环调用
  //    runSmokeTest，匿名 `once` 监听器会累积（10 个应用 = 20 个）并触发
  //    MaxListenersExceededWarning。
  const onSignal = (sig) => {
    try { void cleanup(); } catch { /* ignore */ }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let status = 'FAILED';
  let skip = null;
  let logsTail = null;
  /** 实际选中的版本目录 */
  let resolvedVersion = null;

  // ── 步骤主体（放在内层函数里，保证 finally 一定在 return 之前执行）──────
  const runSteps = async () => {
    // ── 步 1：plan ────────────────────────────────────────────────────────
    const appDir = join(root, o.app);
    if (!existsSync(appDir)) {
      record('plan', false, `应用目录不存在: ${appDir}`);
      return 'FAILED';
    }
    const versions = listVersionDirs(appDir);
    if (!versions.length) {
      record('plan', false, `应用 ${o.app} 没有可测的版本目录`);
      return 'FAILED';
    }
    const version = o.version && versions.includes(o.version) ? o.version : versions[versions.length - 1];
    resolvedVersion = version;
    const vDir = join(appDir, version);
    const composeDoc = parseCompose(join(vDir, 'docker-compose.yml'));
    if (!composeDoc) {
      record('plan', false, `${version}/docker-compose.yml 解析失败`);
      return 'FAILED';
    }
    const versionDoc = parseDataYml(join(vDir, 'data.yml'));
    const fields = versionDoc?.additionalProperties?.formFields ?? versionDoc?.formFields ?? [];

    // 条件跳过判定（GPU / 外部 DB / host 网络 / 特权 / 真实路径 / 可选设备）
    const skips = detectSkipConditions({ composeDoc, versionDoc, versionDir: version });
    if (skips.length) {
      skip = { reason: skips.map((s) => `${s.condition}: ${s.reason}`).join('；') };
      record('plan', true, `条件跳过（${skips.map((s) => s.condition).join(', ')}）—— 不执行任何容器动作`, true);
      return 'UNVERIFIED';
    }

    // docker CLI 探测
    const probe = run(['compose', 'version'], { timeoutMs: 20000, cwd: root });
    if (probe.status !== 0) {
      skip = { reason: 'no-docker' };
      record('plan', true, `环境无 docker compose CLI（${probe.error?.message ?? `退出码 ${probe.status}`}）→ 条件跳过`, true);
      return 'UNVERIFIED';
    }

    // env（1Panel 上下文）+ 端口分配
    const built = buildPanelEnv(fields);
    const env = { ...built.env, CONTAINER_NAME: projectName };
    const portMap = {};
    for (const key of collectPortKeys(composeDoc)) {
      portMap[key] = await portAllocator();
    }

    tmpDir = mkdtempSync(join(tmpdir(), `1panel-smoke-${sanitizeName(o.app)}-`));
    composeFile = join(tmpDir, 'docker-compose.yml');
    envFile = join(tmpDir, '.env');

    const plan = buildSmokePlan({
      app: o.app,
      version,
      composeDoc,
      versionDoc,
      env,
      projectName,
      testNetwork,
      tmpDir,
      portMap,
    });
    if (plan.skip) {
      skip = { reason: plan.skipReasons.join('；') };
      record('plan', true, `条件跳过（${plan.skipReasons.join('；')}）`, true);
      return 'UNVERIFIED';
    }

    writeFileSync(composeFile, yaml.dump(plan.composeDoc), 'utf8');
    writeFileSync(envFile, `${Object.entries(plan.env).map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`).join('\n')}\n`, 'utf8');
    record('plan', true, `计划就绪：project=${projectName} network=${testNetwork} 端口=${JSON.stringify(portMap)} 挂载=${plan.mounts.length} 条`);

    // ── 步 2：config ─────────────────────────────────────────────────────
    const cfg = run(composeArgs(['config', '-q']));
    if (cfg.status !== 0) {
      record('config', false, `docker compose config 失败: ${(cfg.stderr || cfg.stdout).slice(0, 300)}`);
      return 'FAILED';
    }
    record('config', true, 'docker compose config 零错误通过');

    // ── 步 3：pull ───────────────────────────────────────────────────────
    if (!doPull) {
      record('pull', true, '按参数跳过拉取', true);
    } else {
      const pull = run(composeArgs(['pull']), { timeoutMs: timeoutMs });
      if (pull.status !== 0) {
        record('pull', false, `镜像拉取失败: ${(pull.stderr || pull.stdout).slice(0, 300)}`);
        return 'FAILED';
      }
      record('pull', true, '镜像拉取完成');
    }

    // ── 步 4：up ─────────────────────────────────────────────────────────
    const up = run(composeArgs(['up', '-d']), { timeoutMs: timeoutMs });
    if (up.status !== 0) {
      record('up', false, `容器启动失败: ${(up.stderr || up.stdout).slice(0, 300)}`);
      return 'FAILED';
    }
    record('up', true, '容器已启动');

    // ── 步 5：status（轮询）──────────────────────────────────────────────
    const deadline = Date.now() + timeoutMs;
    let bad = null;
    let psText = '';
    while (Date.now() < deadline) {
      const ps = run(composeArgs(['ps', '--format', 'json']), { timeoutMs: 30000 });
      psText = ps.stdout;
      const entries = parsePsJson(ps.stdout);
      for (const e of entries) {
        const state = String(e.State ?? e.state ?? '').toLowerCase();
        const statusTxt = String(e.Status ?? e.status ?? '').toLowerCase();
        if (state === 'restarting' || /restarting/.test(statusTxt)) { bad = `${e.Service ?? e.Name}: Restarting`; break; }
        if (state === 'exited' || /exited/.test(statusTxt)) { bad = `${e.Service ?? e.Name}: ${e.Status ?? e.status ?? 'Exited'}`; break; }
        if (/oomkilled/.test(statusTxt)) { bad = `${e.Service ?? e.Name}: OOMKilled`; break; }
      }
      if (bad) break;
      const allUp = entries.length > 0 && entries.every((e) => {
        const state = String(e.State ?? e.state ?? '').toLowerCase();
        return state === 'running' || /up /.test(String(e.Status ?? e.status ?? '').toLowerCase());
      });
      if (allUp) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (bad) {
      record('status', false, `容器异常状态：${bad}`);
      return 'FAILED';
    }
    record('status', true, `容器状态正常（ps 输出 ${psText.trim().split('\n').filter(Boolean).length} 行）`);

    // ── 步 6：health（healthcheck 或端口探活）────────────────────────────
    // ── 步 6：health ─────────────────────────────────────────────────────
    // 口径（对齐目标 §九 第 6 步「healthcheck 状态（若有定义）**或**端口连通性」）：
    //   · **有 healthcheck 的服务 → 以 healthcheck 为准**（healthy 即通过；
    //     不再因端口探活失败而判 FAILED —— 否则会把「端口存在但服务只监听其它接口」
    //     这类合法配置误判成故障）。
    //   · **没有 healthcheck 的服务 → 才用 TCP 端口探活兜底**。
    const svcEntries = Object.entries(plan.composeDoc.services ?? {})
      .filter(([, s]) => s && typeof s.container_name === 'string');
    let healthChecked = 0;
    /** 没有 healthcheck 的服务（用端口探活兜底） */
    const noHealth = [];
    for (const [name, svc] of svcEntries) {
      if (!svc?.healthcheck) { noHealth.push([name, svc]); continue; }
      const insp = run(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', svc.container_name]);
      const st = insp.stdout.trim();
      healthChecked += 1;
      if (st && st !== 'healthy' && st !== 'none') {
        record('health', false, `容器 ${svc.container_name} 的 healthcheck 状态为 ${st}`);
        return 'FAILED';
      }
    }
    let portOk = 0;
    let portTotal = 0;
    for (const [name] of noHealth) {
      const published = plan.ports.filter((p) => p.service === name && p.kind === 'host-published');
      for (const p of published) {
        portTotal += 1;
        const ok = await probeTcp(Number(p.hostPort));
        if (ok) portOk += 1;
        else {
          record('health', false, `端口探活失败：127.0.0.1:${p.hostPort}（容器内 ${p.containerPort}，该服务无 healthcheck）`);
          return 'FAILED';
        }
      }
    }
    if (healthChecked === 0 && portTotal === 0) {
      record('health', true, '无 healthcheck 且无宿主机端口映射 → 跳过该项（不算失败）', true);
    } else {
      record('health', true, `healthcheck ${healthChecked} 个全部正常；无 healthcheck 服务的端口探活 ${portOk}/${portTotal} 正常`);
    }

    // ── 步 7：persist（挂载目录 + Permission denied）────────────────────
    const logs = run(composeArgs(['logs', '--no-color']), { timeoutMs: 30000 });
    const logText = `${logs.stdout}\n${logs.stderr}`;
    logsTail = logText.slice(-2000);
    if (/permission denied/i.test(logText)) {
      record('persist', false, '容器日志出现 Permission denied（持久化目录权限异常）');
      return 'FAILED';
    }
    const mountDirs = plan.mounts.filter((m) => m.kind === 'relative' || m.kind === 'variable');
    let created = 0;
    for (const m of mountDirs) {
      const dir = m.rewritten;
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        if (readdirSync(dir).length > 0) created += 1;
      } catch { /* 目录不可读 → 不计 */ }
    }
    record('persist', true, `挂载目录检查通过（${mountDirs.length} 个挂载点，其中 ${created} 个已被容器写入）`);

    // ── 步 8：logs（致命错误扫描）────────────────────────────────────────
    const fatal = FATAL_LOG_PATTERNS.filter((re) => re.test(logText));
    if (fatal.length) {
      record('logs', false, `容器日志命中致命模式：${fatal.map((r) => r.source).join(', ')}`);
      return 'FAILED';
    }
    record('logs', true, `日志未命中致命模式（扫描 ${logText.length} 字符）`);

    return 'PASSED';
  };

  try {
    status = await runSteps();
  } catch (err) {
    record('plan', false, `冒烟执行异常: ${err?.message ?? String(err)}`);
    status = 'FAILED';
  } finally {
    // ── 步 9：cleanup（finally 兜底，绝不跳过）───────────────────────────
    // 摘掉信号监听器，避免 --changed 模式循环调用时累积监听器
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await cleanup();
    const ok = cleanupOk && tmpRemoved;
    const nothingToClean = !tmpDir;
    record(
      'cleanup',
      ok,
      `清理完成（compose down=${composeDownRan ? '已执行' : '未执行'}，临时目录已删除=${tmpRemoved}）`,
      nothingToClean,
    );
    if (!ok && status === 'PASSED') status = 'FAILED'; // 残留即失败
  }

  return {
    status,
    app: o.app,
    version: resolvedVersion,
    projectName,
    steps,
    cleanup: { composeDownRan, tmpRemoved, ok: cleanupOk && tmpRemoved },
    skip,
    logsTail,
  };
}

/**
 * 解析 `docker compose ps --format json` 的输出（数组或逐行 JSON 都支持）。
 * @param {string} text
 * @returns {Array<object>}
 */
export function parsePsJson(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch { /* 逐行 JSON */ }
  const out = [];
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/**
 * 列出相对某个 git base ref **发生变化的应用目录**。
 *
 * 用途：Level 3 冒烟测试「针对变更的轻量应用」——只测本次 PR 动过的应用，
 * 不对全仓 60 个应用重复拉镜像。
 *
 * @param {string} root - 仓库根
 * @param {string} baseRef - base ref（如 `origin/main`）
 * @returns {string[]} 应用目录名（去重、排序）
 */
export function changedApps(root, baseRef) {
  const res = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    encoding: 'utf8',
    cwd: root,
    timeout: 30000,
  });
  if (res.status !== 0) return [];
  const apps = new Set();
  for (const line of String(res.stdout ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const top = s.split('/')[0];
    // 只认「顶层应用目录」：必须有该目录下的 data.yml
    if (['.github', 'docs', 'scripts', 'node_modules'].includes(top)) continue;
    if (existsSync(join(root, top, 'data.yml'))) apps.add(top);
  }
  return [...apps].sort();
}

/**
 * 追加到 GitHub Step Summary（不存在时静默跳过）。
 * @param {string} md
 */
function appendStepSummary(md) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try { appendFileSync(target, md, 'utf8'); } catch { /* 无 summary 目标时不影响主流程 */ }
}

/**
 * 把一批冒烟结果渲染成 Step Summary（Level 3 三态显式呈现）。
 * @param {Array<object>} results
 */
function renderSmokeSummary(results) {
  const md = [];
  md.push('## Level 3 · 隔离沙箱冒烟测试');
  md.push('');
  md.push('> 三态语义：**PASSED = 已实机验证通过**；**FAILED = 观察到故障**；**UNVERIFIED = 环境不具备，未验证**（未验证 ≠ 通过）。');
  md.push('');
  md.push('| 应用 | 状态 | 说明 |');
  md.push('| --- | --- | --- |');
  for (const r of results) {
    const note = r.skip
      ? r.skip.reason
      : (r.steps.find((s) => !s.ok)?.detail ?? '9 步全部通过');
    md.push(`| ${r.app} | **${r.status}** | ${String(note).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |`);
  }
  md.push('');
  const passed = results.filter((r) => r.status === 'PASSED').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;
  const unv = results.filter((r) => r.status === 'UNVERIFIED').length;
  md.push(`**PASSED ${passed} ｜ FAILED ${failed} ｜ UNVERIFIED ${unv}**（Level 3 不阻塞 PR 合并）`);
  md.push('');
  appendStepSummary(md.join('\n'));
}

/**
 * CLI 入口。
 * @param {string[]} argv
 * @returns {Promise<number>} 0 = PASSED / UNVERIFIED；1 = FAILED
 */
export async function main(argv) {
  const args = argv ?? process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args[i + 1];
    return v && !v.startsWith('--') ? v : null;
  };
  const asJson = args.includes('--json');
  const root = arg('--root') ?? REPO_ROOT;

  // ── 模式 A：--changed <baseRef> → 对本次变更涉及的应用逐个冒烟 ──────────
  const changedRef = arg('--changed');
  if (changedRef) {
    const apps = changedApps(root, changedRef);
    if (!apps.length) {
      console.log(`changed-apps: 无（相对 ${changedRef} 没有应用目录变更）`);
      return 0;
    }
    console.log(`changed-apps: ${apps.join(', ')}`);
    const results = [];
    let failed = 0;
    for (const app of apps) {
      const r = await runSmokeTest({
        app,
        root,
        pull: !args.includes('--no-pull'),
        log: (m) => console.log(m),
      });
      results.push(r);
      if (r.status === 'FAILED') failed += 1;
    }
    if (asJson) console.log(JSON.stringify(results, null, 2));
    else {
      console.log('');
      console.log('── smoke summary ─────────────────────────────');
      for (const r of results) {
        console.log(`${r.app.padEnd(18)} ${r.status.padEnd(11)} ${r.skip ? r.skip.reason : (r.steps.find((s) => !s.ok)?.detail ?? '')}`);
      }
      console.log(`PASSED ${results.filter((r) => r.status === 'PASSED').length} ｜ FAILED ${failed} ｜ UNVERIFIED ${results.filter((r) => r.status === 'UNVERIFIED').length}`);
    }
    renderSmokeSummary(results);
    // Level 3 不阻塞：即使有 FAILED 也返回 0（由 CI 决定是否提示）
    return 0;
  }

  // ── 模式 B：--app <应用名> ──────────────────────────────────────────────
  const app = arg('--app');
  if (!app) {
    console.error('用法: node .github/bin/smoke-test.mjs --app <应用名> [--version <版本目录>] [--json]');
    console.error('      node .github/bin/smoke-test.mjs --changed <baseRef> [--json]');
    return 1;
  }
  const result = await runSmokeTest({
    app,
    version: arg('--version'),
    root,
    pull: !args.includes('--no-pull'),
    log: (m) => console.log(m),
  });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log('── smoke summary ─────────────────────────────');
    console.log(`app        : ${result.app}`);
    console.log(`version    : ${result.version ?? '-'}`);
    console.log(`project    : ${result.projectName}`);
    console.log(`status     : ${result.status}`);
    if (result.skip) console.log(`skip       : ${result.skip.reason}`);
    console.log(`cleanup    : down=${result.cleanup.composeDownRan} tmpRemoved=${result.cleanup.tmpRemoved}`);
    console.log(`steps      : ${result.steps.map((s) => `${s.step}=${s.skipped ? 'SKIP' : s.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
  }
  return result.status === 'FAILED' ? 1 : 0;
}

// 仅在直接执行时跑 CLI（被 import 时不自动执行）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
