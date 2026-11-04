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
import { readFileSync } from 'node:fs';
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

describe('open-update-pr.mjs 安全收口（audit P2）', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('P2-a: 推送使用 --force-with-lease，且不再出现裸 --force', () => {
    assert.match(src, /'push',\s*'--force-with-lease'/);
    // 裸 --force（不带 -with-lease 后缀）不允许再出现
    assert.doesNotMatch(src, /'push',\s*'--force'/);
  });

  it('P2-b: PR 查询失败 → 强 abort（不再 warn 后继续创建）', () => {
    assert.doesNotMatch(src, /\[WARN\] 查询.*失败.*继续尝试创建/);
    assert.match(src, /查询今日已有 PR 失败[\s\S]{0,200}return 1/);
    assert.match(src, /查询重复批次 PR 失败[\s\S]{0,200}return 1/);
  });

  it('P2-c: 创建 PR 失败时的 catch 不做任何删除分支动作', () => {
    // 定位 createPullRequest 的 catch 块：从 catch (e) 到 return 1
    const m = /client\.createPullRequest\([\s\S]*?\}\s*catch \(e\) \{([\s\S]*?)return 1;/.exec(src);
    assert.ok(m, '找不到 createPullRequest 的 catch 块');
    assert.doesNotMatch(m[1], /deleteBranch/, '创建 PR 失败路径不允许删除远程分支');
    assert.match(m[1], /保留/);
  });

  it('P2-c: 检查失败 / 超时 → 不合并且保留 PR 与分支', () => {
    const m = /checkResult\.status !== 'success'([\s\S]*)return 1;/.exec(src);
    assert.ok(m, '找不到检查失败分支');
    assert.doesNotMatch(m[1], /deleteBranch/, '检查失败路径不允许删除远程分支');
    assert.match(m[1], /不合并|保留|保留/);
  });

  it('P2-d: PAT 回退必须显式警告，且不回显 token 值', () => {
    const r = runScript({
      GITHUB_EVENT_NAME: 'schedule',
      PAT_TOKEN: '',
      GITHUB_TOKEN: 'gsh_secret_value',
      GITHUB_REPOSITORY: 'bad repo name',
    });
    assert.equal(r.status, 1); // repo 校验失败，但回退警告应一并打印
    assert.match(r.stderr, /回退使用 GITHUB_TOKEN/);
    assert.match(r.stderr, /PAT_TOKEN/);
    // 绝不把 token 值打进日志
    assert.doesNotMatch(r.stderr, /gsh_secret_value/);
  });

  it('PR title / commit message 构造不自带 [skip ci]', async () => {
    // github.mjs 内注释里提到 [skip ci]（教学说明），这里锁的是**实际生成**的字符串
    const gh = await import(path.join(ROOT, '.github', 'lib', 'github.mjs'));
    const title = gh.buildPullRequestTitle({ today: '2026-01-01' });
    const commit = gh.buildCommitMessage({ today: '2026-01-01' });
    const text = `${title}\n${commit.subject}\n${commit.body}`;
    assert.doesNotMatch(text, /\[skip ci\]/i);
    assert.doesNotMatch(text, /\[ci skip\]/i);
    // 源码层面：可执行行（去行注释 + 块注释后）不得出现 skip 指令
    const src = readFileSync(
      path.join(ROOT, '.github', 'lib', 'github.mjs'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\[skip ci\]/i);
  });
});
