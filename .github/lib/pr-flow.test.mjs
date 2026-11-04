// .github/lib/pr-flow.test.mjs
// 锁死 .github/bin/open-update-pr.mjs 的**脚本层事件护栏**与前置校验。
//
// 背景（audit 任务 1 / 3）：工作流的 `if:` 已经把 PR 事件排除在写操作 job 之外，
// 但脚本本身也必须能独立拒绝 PR 事件——否则一旦工作流被误改，PR 代码就能间接
// 通过这个脚本推送分支 / 开 PR / 合并 PR（PAT 写权限）。
//
// 这里用子进程跑真实 CLI（不注入 fetch / 不触网）：护栏必须在任何 git 或
// GitHub API 调用之前生效，所以这些 case 只会看到退出码与 stderr。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(ROOT, '.github', 'bin', 'open-update-pr.mjs');

/** 用给定环境变量跑脚本，返回 { status, stdout, stderr } */
function runScript(env) {
  // 只传必要变量，避免宿主机上的 GITHUB_* 污染测试
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'owner/repo',
      PAT_TOKEN: 'dummy-token',
      ...env,
    },
    timeout: 15000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('open-update-pr.mjs 事件护栏', () => {
  it('pull_request 事件 → 非零退出，且不执行任何写操作', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不允许执行自动更新写操作/);
    assert.match(r.stderr, /pull_request/);
    // 护栏在任何 git/API 调用前生效：不会打印 PR/推送相关日志
    assert.doesNotMatch(r.stdout, /\[OK\] 推送分支/);
    assert.doesNotMatch(r.stdout, /\[OK\] PR 已开/);
  });

  it('pull_request_target 事件 → 非零退出', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'pull_request_target' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不允许执行自动更新写操作/);
  });

  it('未知事件（不在白名单）→ 非零退出', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'issues' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不允许执行自动更新写操作/);
  });

  it('缺少 token → 非零退出（不会静默降级）', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'schedule', PAT_TOKEN: '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /缺少 GITHUB_TOKEN \/ PAT_TOKEN/);
  });

  it('非法 GITHUB_REPOSITORY → 非零退出', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'not-a-repo' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /缺少或非法的 GITHUB_REPOSITORY/);
  });

  it('护栏优先于 token 校验：PR 事件即使没有 token 也先报事件不允许', () => {
    const r = runScript({ GITHUB_EVENT_NAME: 'pull_request', PAT_TOKEN: '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不允许执行自动更新写操作/);
  });
});
