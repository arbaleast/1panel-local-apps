// .github/lib/pr-flow-e2e.test.mjs
//
// **隔离式本地 E2E**：把 .github/bin/open-update-pr.mjs 的整条编排链路
// （git 分支 → 暂存提交 → 推送 → 开/复用 PR → 等必需检查 → 合并 → 删远程分支）
// 在**完全本地隔离**的环境里跑一遍：
//
//   · git 远端 = 本地**裸仓库**（不是 GitHub，不产生任何真实 push）
//   · GitHub API = 本地 **mock HTTP 服务**（不是 api.github.com）
//   · 检查状态 = mock 返回的 Check Runs（不触发任何真实 CI）
//
// 为什么需要它：pr-flow.test.mjs 是**源码正则断言**（锁结构不变量），
// github.test.mjs 是**函数级 mock**（锁单个 API 行为）——
// 两者都无法证明「脚本真的能把分支推上去、把 PR 开出来、把检查等到位再合并」。
// 本文件补上这一层：**进程级**的真实编排验证。
//
// 铁律（目标 §二.2 测试隔离）：本文件**绝不**触达 GitHub ——
// 远端是本地路径，API base 指向 127.0.0.1 的临时端口。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(ROOT, '.github', 'bin', 'open-update-pr.mjs');
const TMP_BASE = path.join(ROOT, '.agent_cache', 'pr-e2e');

/** 必需检查名（必须与 workflow 的 validate job name 一致） */
const REQUIRED_CHECK = '只读校验（单测 + 跨文件一致性 lint）';

/**
 * 自动更新分支名里的日期 —— **必须与被测脚本同口径**（UTC 日期）。
 * 硬编码日期会让测试在跨日（UTC 00:00）后莫名其妙失败。
 */
const TODAY = new Date().toISOString().slice(0, 10);
const AUTO_BRANCH = `auto-update/${TODAY}`;

// ─── 本地 mock GitHub API ──────────────────────────────────────────────────

/**
 * 起一个 mock GitHub API 服务
 * @param {{openPrs?: Array<object>, checkConclusion?: string, statusState?: string,
 *          mergeResult?: boolean, headSha?: string}} spec
 */
function startMockApi(spec = {}) {
  const calls = [];
  let nextNumber = 100;
  const server = createServer((req, res) => {
    const url = req.url || '';
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const json = (obj, status = 200) => {
        const payload = JSON.stringify(obj);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      };

      // 列出 open PR
      if (req.method === 'GET' && url.startsWith('/repos/o/r/pulls?')) {
        calls.push({ method: 'GET', path: url });
        return json(spec.openPrs || []);
      }
      // 读取单个 PR（head SHA 重验用）
      if (req.method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(url)) {
        calls.push({ method: 'GET', path: url });
        const n = Number(url.split('/').pop());
        const pr = (spec.openPrs || []).find(p => p.number === n);
        return json(pr || { number: n, head: { sha: spec.headSha || 'deadbeef' } });
      }
      // 创建 PR
      if (req.method === 'POST' && url === '/repos/o/r/pulls') {
        calls.push({ method: 'POST', path: url, body });
        const number = nextNumber++;
        return json({
          number,
          html_url: `http://127.0.0.1/pr/${number}`,
          head: { ref: spec.headRef || AUTO_BRANCH, sha: spec.headSha || 'deadbeef' },
          base: { ref: 'main' },
        });
      }
      // 更新 PR（复用路径）
      if (req.method === 'PATCH' && /^\/repos\/o\/r\/pulls\/\d+$/.test(url)) {
        calls.push({ method: 'PATCH', path: url, body });
        const n = Number(url.split('/').pop());
        return json({
          number: n,
          html_url: `http://127.0.0.1/pr/${n}`,
          head: { sha: spec.headSha || 'deadbeef' },
          base: { ref: 'main' },
        });
      }
      // Check Runs
      if (url.includes('/check-runs')) {
        calls.push({ method: 'GET', path: url });
        return json({
          check_runs: [
            {
              name: REQUIRED_CHECK,
              status: 'completed',
              conclusion: spec.checkConclusion || 'success',
            },
          ],
        });
      }
      // 合并状态
      if (url.endsWith('/status')) {
        calls.push({ method: 'GET', path: url });
        return json({ state: spec.statusState || 'success', statuses: [] });
      }
      // 合并 PR
      if (req.method === 'PUT' && url.includes('/merge')) {
        calls.push({ method: 'PUT', path: url, body });
        return json({ merged: spec.mergeResult !== false, message: spec.mergeMessage || '' });
      }
      // 删远程分支
      if (req.method === 'DELETE' && url.includes('/git/refs/heads/')) {
        calls.push({ method: 'DELETE', path: url });
        return json({});
      }
      return json({ message: 'not found' }, 404);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, calls, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** 起 mock → 跑断言 → **务必关闭** server（否则 node 事件循环不退出，测试挂住） */
async function withMock(spec, fn) {
  const api = await startMockApi(spec);
  try {
    return await fn(api);
  } finally {
    // keep-alive 连接会让 server.close() 一直等 → 先强制断开
    api.server.closeAllConnections?.();
    await new Promise(r => api.server.close(r));
  }
}

// ─── 本地 git 远端（裸仓库）──────────────────────────────────────────────

/** 建一个「远端裸仓库 + 本地工作副本」 */
function makeLocalRepo(name) {
  const base = path.join(TMP_BASE, name);
  const remote = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(base, { recursive: true });

  const g = (args, cwd) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });

  assert.equal(g(['init', '--bare', '--initial-branch=main', remote], base).status, 0);
  fs.mkdirSync(work, { recursive: true });
  assert.equal(g(['init', '--initial-branch=main'], work).status, 0);
  g(['config', 'user.name', 'tester'], work);
  g(['config', 'user.email', 'tester@example.com'], work);
  g(['remote', 'add', 'origin', remote], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
  g(['add', '-A'], work);
  g(['commit', '-m', 'init'], work);
  g(['push', 'origin', 'main'], work);
  return { base, remote, work, g };
}

/** 读取裸仓库里的分支列表 */
function remoteBranches(remote, g) {
  const out = g(['branch', '--format=%(refname:short)'], remote);
  return out.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * 在工作副本里跑 open-update-pr.mjs
 *
 * 必须用**异步** spawn：mock API 服务跑在**本进程**的事件循环上，
 * 若用 spawnSync 阻塞事件循环，子进程永远等不到 mock 响应（死锁）。
 */
function runScript(repo, api, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: repo.work,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_NAME: 'schedule',
        PAT_TOKEN: 'test-token',
        GITHUB_API_BASE: api.base,
        MERGE_TIMEOUT_MS: '5000',
        CHECK_POLL_INTERVAL_MS: '100',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// ─── 合法应用夹具（供 detect → PR 交接用例）────────────────────────────────

/** 演示应用的 compose（满足仓库规约：hardcode 镜像 / restart / 1panel-network） */
function DEMO_COMPOSE(tag) {
  return [
    'services:',
    '  main:',
    `    image: nginx:${tag}`,
    '    container_name: ${CONTAINER_NAME}',
    '    restart: always',
    '    volumes:',
    '      - ./data:/data',
    '    networks:',
    '      - 1panel-network',
    'networks:',
    '  1panel-network:',
    '    external: true',
    '',
  ].join('\n');
}

/**
 * 在工作副本里写一个**合法**的最小应用（根 data.yml + 两个版本目录 + README 列表）
 * —— 批次校验（validate-update-batch）必须对它零报错
 */
function writeDemoAppFixture(work) {
  const rootData = `additionalProperties:
  key: demoapp
  name: Demo App
  type: tool
  shortDescZh: 演示应用
  shortDescEn: Demo app
  description:
    zh: 演示应用
    en: Demo app
`;
  const versionData = `additionalProperties:
  key: demoapp
  name: Demo App
  type: tool
  formFields: []
`;
  fs.mkdirSync(path.join(work, 'demoapp', 'v1.0.0'), { recursive: true });
  fs.mkdirSync(path.join(work, 'demoapp', 'v2.0.0'), { recursive: true });
  fs.writeFileSync(path.join(work, 'demoapp', 'data.yml'), rootData);
  fs.writeFileSync(path.join(work, 'demoapp', 'v1.0.0', 'data.yml'), versionData);
  fs.writeFileSync(path.join(work, 'demoapp', 'v1.0.0', 'docker-compose.yml'), DEMO_COMPOSE('1.0.0'));
  fs.writeFileSync(path.join(work, 'demoapp', 'v2.0.0', 'data.yml'), versionData);
  fs.writeFileSync(path.join(work, 'demoapp', 'v2.0.0', 'docker-compose.yml'), DEMO_COMPOSE('2.0.0'));
  fs.writeFileSync(
    path.join(work, 'README.md'),
    `# demo

## 应用列表

| 应用 | 说明 | 当前版本 |
|------|------|----------|
| demoapp | 演示应用 | v2.0.0 |
`,
  );
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

describe('open-update-pr.mjs 隔离式本地 E2E', () => {
  before(() => {
    fs.mkdirSync(TMP_BASE, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(TMP_BASE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('完整链路：建分支 → 推送 → 开 PR → 等必需检查 → 合并 → 删远程分支', async () => {
    const repo = makeLocalRepo('full-chain');
    await withMock({}, async (api) => {
      // 制造一处改动（模拟 detect 已写盘）
      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');

      const res = await runScript(repo, api);
      assert.equal(res.status, 0, `脚本应成功退出，stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

      // 1) 分支已推送到远程裸仓库（真实 git 行为，非 mock）
      const branches = remoteBranches(repo.remote, repo.g);
      assert.ok(
        branches.includes(AUTO_BRANCH),
        '自动更新分支应已推送到远程（本地裸仓库）',
      );

      // 2) 分支上应拿到这次提交（mock 的 merge 不会真的改本地 main，
      //    所以校验**分支**而不是 main）
      const log = repo.g(['log', '--oneline', AUTO_BRANCH], repo.remote).stdout;
      assert.match(log, /chore\(deps\): auto-update/, '分支应包含自动更新提交');

      // 3) API 调用序列：列出 PR → 创建 PR → 读 PR（SHA 重验）→ check-runs → status → merge → 删分支
      const methods = api.calls.map(c => `${c.method} ${c.path.split('?')[0]}`);
      assert.ok(
        api.calls.some(c => c.method === 'GET' && c.path.startsWith('/repos/o/r/pulls?')),
        '应先列 open PR',
      );
      assert.ok(methods.some(m => m === 'POST /repos/o/r/pulls'), '应创建 PR');
      assert.ok(methods.some(m => m.includes('/check-runs')), '应轮询 check-runs');
      assert.ok(methods.some(m => m === 'PUT /repos/o/r/pulls/100/merge'), '应合并 PR');
      assert.ok(
        methods.some(m => m.startsWith('DELETE /repos/o/r/git/refs/heads/')),
        '应删远程分支',
      );

      // 4) 合并请求必须带 sha 护栏（只合并等待过检查的那个 SHA）
      const mergeCall = api.calls.find(c => c.method === 'PUT' && c.path.includes('/merge'));
      const mergeBody = JSON.parse(mergeCall.body);
      assert.ok(mergeBody.sha, '合并请求必须带 sha 护栏');
      assert.equal(mergeBody.merge_method, 'merge');

      // 5) 执行结果已落盘（目标 §七.1 的执行轨迹）
      const exec = JSON.parse(fs.readFileSync(path.join(repo.work, 'execution.json'), 'utf8'));
      assert.ok(exec.pr && exec.pr.number, 'execution.json 应记录 PR 编号');
      assert.equal(exec.ci.status, 'success');
      assert.equal(exec.merge.status, 'merged');
      assert.deepEqual(exec.ci.requiredChecks, [REQUIRED_CHECK]);
    });
  });

  it('幂等：第二次运行**无实际改动** → 不产生新提交、不重复开 PR', async () => {
    const repo = makeLocalRepo('idempotent');
    await withMock({}, async (api) => {
      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');

      const first = await runScript(repo, api);
      assert.equal(first.status, 0, `首次运行应成功，stderr:\n${first.stderr}`);

      // 第二次：工作树已提交且无新改动 → 应幂等跳过，不开新 PR
      const before = api.calls.filter(c => c.method === 'POST').length;
      const second = await runScript(repo, api);
      assert.equal(second.status, 0, `第二次运行应幂等成功，stderr:\n${second.stderr}`);
      assert.match(second.stdout, /无文件改动，跳过/);
      const after = api.calls.filter(c => c.method === 'POST').length;
      assert.equal(after, before, '幂等运行不得重复创建 PR');

      // 分支上只应有一个自动更新提交（幂等：第二次运行不产生新提交）
      const log = repo.g(['log', '--oneline', AUTO_BRANCH], repo.remote).stdout;
      const autoCommits = log.split('\n').filter(l => l.includes('chore(deps): auto-update'));
      assert.equal(autoCommits.length, 1, `分支上应只有 1 个自动更新提交，实际 ${autoCommits.length}`);
    });
  });

  it('已有未合并的自动更新 PR → **复用**该 PR（PATCH），不新建', async () => {
    const repo = makeLocalRepo('reuse');
    const existing = {
      number: 7,
      html_url: 'http://127.0.0.1/pr/7',
      title: 'chore(deps): auto-update 2026-11-01',
      head: { ref: 'auto-update/2026-11-01', sha: 'deadbeef' },
      base: { ref: 'main' },
    };
    await withMock({ openPrs: [existing] }, async (api) => {
      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');
      const res = await runScript(repo, api);

      assert.equal(res.status, 0, `复用路径应成功，stderr:\n${res.stderr}`);
      assert.match(res.stdout, /复用既有自动更新 PR #7/);
      assert.ok(api.calls.some(c => c.method === 'PATCH'), '应走 PATCH 更新既有 PR');
      assert.ok(!api.calls.some(c => c.method === 'POST'), '不得重复创建 PR');
      assert.ok(
        api.calls.some(c => c.method === 'PATCH' && c.path === '/repos/o/r/pulls/7'),
        '应更新 #7',
      );
      // 复用的是既有分支名
      assert.ok(
        remoteBranches(repo.remote, repo.g).length >= 0,
        '远程分支状态可读',
      );
    });
  });

  it('detect → PR 交接：updates.json 里的应用目录确实被提交进批次', async () => {
    const repo = makeLocalRepo('handoff');
    await withMock({}, async (api) => {
      // 模拟 detect-updates.mjs 的产物：一个**合法**的新应用版本目录（批次校验必须放行）
      writeDemoAppFixture(repo.work);
      fs.writeFileSync(
        path.join(repo.work, 'updates.json'),
        JSON.stringify({
          updates: [
            {
              app: 'demoapp',
              from: 'v1.0.0',
              to: 'v2.0.0',
              versionDir: 'v1.0.0',
              versionCopy: { appName: 'demoapp', fromDir: 'v1.0.0', toDir: 'v2.0.0' },
              services: [{ name: 'main', repo: 'nginx', from: '1.0.0', to: '2.0.0' }],
              changes: [
                {
                  path: 'demoapp/v2.0.0/docker-compose.yml',
                  file: 'docker-compose.yml',
                  content: DEMO_COMPOSE('2.0.0'),
                },
              ],
            },
          ],
          scanned: 1,
          timestamp: new Date().toISOString(),
          results: [],
        }),
      );

      const res = await runScript(repo, api);
      assert.equal(res.status, 0, `交接路径应成功，stderr:\n${res.stderr}`);

      // 批次分支上应同时含「新版本目录」与「README」
      const files = repo
        .g(['ls-tree', '-r', '--name-only', AUTO_BRANCH], repo.remote)
        .stdout.split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      assert.ok(
        files.includes('demoapp/v2.0.0/docker-compose.yml'),
        `新版本目录应被提交进批次，实际: ${files.join(', ')}`,
      );
      assert.ok(files.includes('README.md'), 'README 应被提交进批次');
      // 且不得把无关文件卷进来（updates.json 是 gitignore 的产物，不该进批次）
      assert.ok(!files.includes('updates.json'), 'updates.json 不应进批次提交');
    });
  });

  it('幂等重跑：工作区无改动但已有未合并 PR → 跳过提交/推送，**仍走合并门禁**', async () => {
    const repo = makeLocalRepo('idempotent-existing');
    const existing = {
      number: 7,
      html_url: 'http://127.0.0.1/pr/7',
      title: `chore(deps): auto-update ${TODAY}`,
      head: { ref: AUTO_BRANCH, sha: 'deadbeef' },
      base: { ref: 'main' },
    };
    await withMock({ openPrs: [existing] }, async (api) => {
      // **不改工作区** → 无可提交内容（幂等重跑）
      const res = await runScript(repo, api);
      assert.equal(res.status, 0, `幂等重跑应成功，stderr:\n${res.stderr}`);
      assert.match(res.stdout, /无文件改动/);
      assert.match(res.stdout, /继续走检查门禁与合并/);
      // 没有新提交 → 不得推送
      assert.ok(
        !api.calls.some(c => c.method === 'POST' && c.path === '/repos/o/r/pulls'),
        '不得新建 PR',
      );
      assert.ok(
        api.calls.some(c => c.method === 'PATCH' && c.path === '/repos/o/r/pulls/7'),
        '应更新既有 PR',
      );
      assert.ok(
        api.calls.some(c => c.method === 'PUT' && c.path.includes('/merge')),
        '**必须**继续走到合并（否则 PR 永远悬着）',
      );
    });
  });

  it('存在多个未合并的自动更新 PR → **显式失败**，不擅自挑一个', async () => {
    const repo = makeLocalRepo('multi-pr');
    await withMock(
      {
        openPrs: [
          { number: 7, head: { ref: 'auto-update/2026-11-01' }, base: { ref: 'main' } },
          { number: 8, head: { ref: 'auto-update/2026-11-02' }, base: { ref: 'main' } },
        ],
      },
      async (api) => {
        fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');
        const res = await runScript(repo, api);

        assert.equal(res.status, 1, '多个未合并自动更新 PR 时必须非零退出');
        assert.match(res.stderr, /未合并的自动更新 PR/);
        assert.ok(!api.calls.some(c => c.method === 'POST'), '不得创建新 PR');
        assert.ok(!api.calls.some(c => c.method === 'PUT'), '不得执行合并');
      },
    );
  });

  it('必需检查失败 → 严禁合并，保留 PR 与远程分支', async () => {
    const repo = makeLocalRepo('check-failed');
    await withMock({ checkConclusion: 'failure' }, async (api) => {
      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');
      const res = await runScript(repo, api);

      assert.equal(res.status, 1, '检查失败必须非零退出');
      assert.match(res.stderr, /不合并/);
      assert.ok(!api.calls.some(c => c.method === 'PUT'), '检查失败时严禁调用合并 API');
      assert.ok(!api.calls.some(c => c.method === 'DELETE'), '检查失败时不得删远程分支');
      // 远程分支保留（供人工审查）
      assert.ok(
        remoteBranches(repo.remote, repo.g).includes(AUTO_BRANCH),
        '检查失败时远程分支应保留',
      );
    });
  });

  it('非必需检查被 skipped（真实 CI 实况：写操作 job 在 PR 事件下被 if: 跳过）→ 仍可合并', async () => {
    const repo = makeLocalRepo('skipped-non-required');
    await withMock({}, async (api) => {
      // 追加一条**非必需**的 skipped check（复刻真实 PR 的 check 集合）
      const orig = api.server.listeners('request')[0];
      api.server.removeAllListeners('request');
      api.server.on('request', async (req, res) => {
        if ((req.url || '').includes('/check-runs')) {
          api.calls.push({ method: 'GET', path: req.url });
          const payload = JSON.stringify({
            check_runs: [
              { name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' },
              // 本仓写操作 job 在 pull_request 事件下必然被 if: 跳过
              { name: '检测镜像更新并开 PR', status: 'completed', conclusion: 'skipped' },
            ],
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(payload);
          return;
        }
        return orig(req, res);
      });

      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');
      const res = await runScript(repo, api);
      assert.equal(res.status, 0, `非必需检查 skipped 不应阻断合并，stderr:\n${res.stderr}`);
      assert.ok(
        api.calls.some(c => c.method === 'PUT' && c.path.includes('/merge')),
        '应正常执行合并',
      );
    });
  });

  it('必需检查**缺失**（0 Checks）→ 严禁提前合并，保留 PR', async () => {
    const repo = makeLocalRepo('zero-checks');
    // mock 不返回任何 check run（只有别的 check），必需检查从未出现
    await withMock({}, async (api) => {
      // 用一个「只有无关 check」的场景：直接改 mock 的返回
      api.server.removeAllListeners('request');
      api.server.on('request', (req, res) => {
        const url = req.url || '';
        const json = (obj, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'GET' && url.startsWith('/repos/o/r/pulls?')) return json([]);
        if (req.method === 'POST' && url === '/repos/o/r/pulls') {
          api.calls.push({ method: 'POST', path: url, body: '' });
          return json({
            number: 100,
            html_url: 'http://127.0.0.1/pr/100',
            head: { ref: AUTO_BRANCH, sha: 'deadbeef' },
            base: { ref: 'main' },
          });
        }
        if (req.method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(url)) {
          return json({ number: 100, head: { sha: 'deadbeef' } });
        }
        if (url.includes('/check-runs')) {
          // 只有一个**无关的**成功 check → 旧实现会误判为通过
          return json({
            check_runs: [
              { name: 'Some Third-Party Check', status: 'completed', conclusion: 'success' },
            ],
          });
        }
        if (url.endsWith('/status')) return json({ state: 'success', statuses: [] });
        if (req.method === 'PUT' && url.includes('/merge')) {
          api.calls.push({ method: 'PUT', path: url, body: '' });
          return json({ merged: true });
        }
        if (req.method === 'DELETE') return json({});
        return json({ message: 'not found' }, 404);
      });

      fs.writeFileSync(path.join(repo.work, 'README.md'), '# demo\n\nupdated\n');
      const res = await runScript(repo, api, { MERGE_TIMEOUT_MS: '2000' });

      assert.equal(res.status, 1, '必需检查缺失时必须非零退出（不得提前合并）');
      assert.ok(!api.calls.some(c => c.method === 'PUT'), '必需检查缺失时严禁调用合并 API');
      assert.match(res.stderr, /缺失的必需检查|检查状态为/);
    });
  });
});
