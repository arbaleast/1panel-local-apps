// lib/detect-updates-e2e.test.mjs — detect 链路的**离线**端到端验证
//
// ── 目的（目标 §十 / §十一.5）────────────────────────────────────────────
// 用一个**本地 mock registry**（HTTP server）驱动真实的 detect-updates.mjs，
// 端到端验证「镜像解析 → 版本分类 → 轨道亲和 → 更新决策 → 版本目录命名」整条链路。
//
// ⚠️ 严禁依赖实时外网 Registry：这里全程只打本机临时端口。
//
// ── 验证的 P0 回归（这些缺陷在改造前是**活的**）────────────────────────
//   · postgres:16-alpine   → 旧实现选 9.6.24（降级 12 个大版本）
//   · rabbitmq:3-management → 旧实现选 3.13.7（丢失 management 变体）
//   · pgvector 变体         → 旧实现丢 -pg18-trixie 后缀
//   · photopea 两段式       → 旧实现降级到 2.1.0
//   · 版本目录名             → 不得被副作用 service 的 tag 劫持

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DETECT = path.join(REPO_ROOT, '.github', 'scripts', 'detect-updates.mjs');

/**
 * mock registry 的 tag 表：repo → tag 列表。
 * 刻意放入旧实现会误选的"危险"tag。
 */
const TAG_TABLE = {
  // ── linkwarden ──────────────────────────────────────────────────────
  'linkwarden/linkwarden': ['v2.16.1', 'v2.16.2', 'v2.16.3', 'latest'],
  'postgres': ['latest', '16-alpine', '17-alpine', '9.6.24', '16.3-alpine', 'alpine'],
  'meilisearch/meilisearch': ['v1.13.3', 'v1.53.1', 'v1.55.0'],
  // ── firecrawl ───────────────────────────────────────────────────────
  'firecrawl/firecrawl': ['2.11.14', '2.11.202', '2.11.209', '2.11.642', '2.11.643', '2.11.678'],
  'firecrawl/playwright-service': ['latest'],
  'rabbitmq': ['latest', '3-management', '4-management', '3.13.7', '3.13.7-management'],
  // ── pgvector ────────────────────────────────────────────────────────
  'pgvector/pgvector': ['0.8.6-pg18-trixie', '0.8.7-pg18-trixie', '0.8.8-pg18-trixie', '0.9.0', '0.9.1'],
  // ── photopea（两段式版本）──────────────────────────────────────────
  'ramuses/photopea': ['2.1.0', '2.2', '2.3'],
};

let server = null;
let baseUrl = '';

/** 启动本地 mock registry */
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // GHCR 匿名 token
    if (p === '/token') return send(200, { token: 'anon-token' });

    // GHCR tags/list：/v2/<repo>/tags/list
    if (p.startsWith('/v2/') && p.endsWith('/tags/list')) {
      const repo = p.slice('/v2/'.length, -'/tags/list'.length);
      return send(200, { name: repo, tags: TAG_TABLE[repo] || [] });
    }

    // DockerHub tags：/v2/repositories/<repo>/tags/
    const m = p.match(/^\/v2\/repositories\/(.+)\/tags\/$/);
    if (m) {
      const repo = m[1];
      const tags = TAG_TABLE[repo] || [];
      return send(200, {
        count: tags.length,
        next: null,
        results: tags.map(name => ({ name })),
      });
    }

    return send(404, { message: 'not found' });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

/**
 * 构造子进程 env —— **必须剔除** GitHub Actions 的输出文件变量。
 *
 * 事故（2026-11-05）：本文件原先直接 `...process.env`，CI 里
 * `GITHUB_STEP_SUMMARY` 被子进程继承 → detect 脚本把自己的检测汇总
 * **追加进 CI 的真 step summary** → 6 个用例刷出 6 段
 * 「detect-updates 检测汇总」（扫描应用数 1/1/1/1/2/4，正好对上 6 次 runDetect）。
 *
 * 职责边界：**生产代码写 CI 输出，测试不得冒充生产写入。**
 *
 * @param {Record<string, string>} [extra] 额外环境变量
 * @returns {Record<string, string>}
 */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    'GITHUB_STEP_SUMMARY',
    'GITHUB_OUTPUT',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'GITHUB_STATE',
  ]) {
    delete env[key];
  }
  return env;
}

/**
 * 以 dry-run 模式跑一次 detect（不写仓库）。
 *
 * ⚠️ 必须用**异步** spawn：mock registry 跑在**同一个进程**里，
 *    spawnSync 会阻塞事件循环 → mock server 永远无法响应 → 死锁。
 *
 * @param {string[]} apps 应用目录名
 * @returns {Promise<{stdout:string, stderr:string, status:number}>}
 */
function runDetect(apps) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DETECT, '--dry-run', ...apps], {
      cwd: REPO_ROOT,
      env: childEnv({
        DOCKERHUB_API_BASE: baseUrl,
        GHCR_API_BASE: baseUrl,
        GITHUB_EVENT_NAME: 'schedule',
      }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, status: code ?? 0 }));
  });
}

describe('detect 链路离线 E2E（mock registry）', () => {
  it('postgres:16-alpine 不得被降级到 9.6.24（P0 回归）', async () => {
    const { stdout, stderr, status } = await runDetect(['linkwarden']);
    assert.equal(status, 0, `detect 应成功退出，stderr:\n${stderr}`);
    assert.ok(!stdout.includes('9.6.24'), `不得出现 9.6.24：\n${stdout}`);
    assert.ok(stdout.includes('16-alpine -> 17-alpine'),
      `postgres 应在同轨道内升到 17-alpine：\n${stdout}`);
  });

  it('rabbitmq:3-management 不得被改写为 3.13.7（P0 回归）', async () => {
    const { stdout, stderr, status } = await runDetect(['firecrawl']);
    assert.equal(status, 0, `detect 应成功退出，stderr:\n${stderr}`);
    assert.ok(!stdout.includes('3.13.7'), `不得出现 3.13.7：\n${stdout}`);
    assert.ok(stdout.includes('3-management -> 4-management'),
      `rabbitmq 应在 management 轨道内升级：\n${stdout}`);
  });

  it('pgvector 必须保留 -pg18-trixie 变体后缀', async () => {
    const { stdout, stderr, status } = await runDetect(['pgvector']);
    assert.equal(status, 0, `detect 应成功退出，stderr:\n${stderr}`);
    assert.ok(stdout.includes('0.8.7-pg18-trixie -> 0.8.8-pg18-trixie'),
      `变体后缀必须保留（应升到 0.8.8-pg18-trixie）：${stdout}`);
    assert.ok(!stdout.includes('-> 0.9.'), `不得跳到无变体轨道：\n${stdout}`);
  });

  it('photopea 两段式版本不得降级到 2.1.0', async () => {
    const { stdout, stderr, status } = await runDetect(['photopea']);
    assert.equal(status, 0, `detect 应成功退出，stderr:\n${stderr}`);
    assert.ok(!stdout.includes('2.1.0'), `不得出现 2.1.0：\n${stdout}`);
    assert.ok(stdout.includes('2.2 -> 2.3'), `应在两段式轨道内升级：\n${stdout}`);
  });

  it('版本目录名不得被副作用 service 的 tag 劫持', async () => {
    const { stdout, stderr, status } = await runDetect(['linkwarden', 'firecrawl']);
    assert.equal(status, 0, `detect 应成功退出，stderr:\n${stderr}`);
    // linkwarden 的主服务是 ghcr.io/linkwarden/linkwarden（v2.16.3），
    // 版本目录名必须来自**主服务**，而不是 postgres 的 tag
    assert.ok(!stdout.includes('linkwarden/16-alpine'), `版本目录名不得来自 postgres：\n${stdout}`);
    assert.ok(!stdout.includes('linkwarden/17-alpine'), `版本目录名不得来自 postgres：\n${stdout}`);
    assert.ok(!stdout.includes('firecrawl/4-management'), `版本目录名不得来自 rabbitmq：\n${stdout}`);
  });

  it('dry-run 不写仓库（工作树保持干净）', async () => {
    await runDetect(['linkwarden', 'firecrawl', 'pgvector', 'photopea']);
    const status = spawnSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const dirty = (status.stdout || '').trim();
    assert.ok(!dirty.includes('linkwarden/'), `dry-run 不得写版本目录：\n${dirty}`);
    assert.ok(!dirty.includes('firecrawl/'), `dry-run 不得写版本目录：\n${dirty}`);
    assert.ok(!dirty.includes('pgvector/'), `dry-run 不得写版本目录：\n${dirty}`);
    assert.ok(!dirty.includes('photopea/'), `dry-run 不得写版本目录：\n${dirty}`);
  });
});
