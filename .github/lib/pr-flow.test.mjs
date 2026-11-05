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
    assert.match(r.stderr, /缺少 PAT_TOKEN/);
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

  it('P2-a: 推送**不使用任何 force**（rebase 到远端 tip 后快进推送）', () => {
    // 2026-11 治理：旧实现用 `git push --force-with-lease` 覆盖远端同名日期分支，
    // 新实现改成「远端 tip 之上 rebase → 普通 push」—— 目标是**零 force**。
    // 只看**可执行行**（注释里可以讨论 force-with-lease 是什么）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /'push',\s*'--force/, '推送不得带任何 force 参数');
    assert.doesNotMatch(code, /--force-with-lease/, '推送不得带 --force-with-lease');
    assert.match(code, /'push',\s*'origin',\s*branch/, '推送必须是普通快进 push');
    // 覆盖远端已有提交前，先 rebase 到远端 tip 之上
    assert.match(code, /'rebase',\s*'--onto',\s*'FETCH_HEAD'/);
    assert.match(code, /'fetch',\s*'origin',\s*branch/);
  });

  it('P2-b: PR 查询失败 → 强 abort（不再 warn 后继续创建）', () => {
    assert.doesNotMatch(src, /\[WARN\] 查询.*失败.*继续尝试创建/);
    assert.match(src, /查询既有自动更新 PR 失败[\s\S]{0,200}return 1/);
  });

  it('P2-b2: 自动更新 PR 按**分支前缀**识别（不靠标题字符串，不碰人工 PR）', () => {
    assert.match(src, /findAutoUpdatePullRequests/, '必须用按分支前缀识别的查询');
    assert.doesNotMatch(src, /PR_TITLE_PREFIX/, '不得再用 PR 标题前缀识别自动更新 PR');
  });

  it('P0-3: 重复批次 PR **不再静默跳过**（改为复用；复用不了则显式失败）', () => {
    // 旧实现：发现已有批次 PR → `return 0` → workflow 全绿但更新被静默丢弃
    assert.doesNotMatch(
      src,
      /\[SKIP\][\s\S]{0,120}已存在[\s\S]{0,120}return 0;/,
      '不得存在「已存在 → 打印 SKIP → return 0」的静默跳过路径',
    );
    assert.match(src, /\[REUSE\] 复用既有自动更新 PR/, '必须走复用路径');
    assert.match(src, /updatePullRequest/, '复用时必须更新既有 PR');
    assert.match(src, /存在 \$\{autoPrs\.length\} 个未合并的自动更新 PR/, '多个 PR 时必须显式失败');
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

  it('P2-d: 缺少 PAT_TOKEN 必须**显式中止**（不退化到 GITHUB_TOKEN），且不回显 token 值', () => {
    const r = runScript({
      GITHUB_EVENT_NAME: 'schedule',
      PAT_TOKEN: '',
      GITHUB_TOKEN: 'gsh_secret_value',
      GITHUB_REPOSITORY: 'owner/repo',
    });
    assert.equal(r.status, 1, '缺少 PAT_TOKEN 必须非零退出');
    assert.match(r.stderr, /拒绝用 GITHUB_TOKEN/);
    assert.match(r.stderr, /PAT_TOKEN/);
    // 绝不把 token 值打进日志
    assert.doesNotMatch(r.stderr, /gsh_secret_value/);
    // 回退路径不得走到开 PR
    assert.doesNotMatch(r.stdout, /\[OK\] PR 已开/);
  });

  it('P0-1: 合并门禁必须绑定**必需检查白名单**（缺任一 → 绝不合并）', () => {
    assert.match(src, /requiredChecks:\s*REQUIRED_CHECKS/, 'waitForChecks 必须传 requiredChecks');
    assert.match(src, /REQUIRED_CHECKS/, '必须读取 REQUIRED_CHECKS');
    assert.match(src, /resolveHeadSha/, '必须检测 head SHA 变化并重新验证');
  });

  it('P2-7: git add 使用**路径白名单**，不得 `git add -A`', () => {
    assert.doesNotMatch(src, /'add',\s*'-A'/, '不得使用 git add -A（会把工作区残留卷进 PR）');
    assert.match(src, /'add',\s*'--'/, 'git add 必须限定路径');
  });

  it('P2-15: 批次校验必须在 git add / commit / push **之前**', () => {
    const validateIdx = src.indexOf('validateUpdateBatch({');
    const addIdx = src.indexOf("'add', '--'");
    const pushIdx = src.indexOf("'push', 'origin', branch");
    assert.ok(validateIdx > 0, '找不到批次校验');
    assert.ok(addIdx > 0, '找不到 git add');
    assert.ok(pushIdx > 0, '找不到 git push');
    assert.ok(validateIdx < addIdx, '批次校验必须早于 git add');
    assert.ok(validateIdx < pushIdx, '批次校验必须早于 git push');
  });

  it('合并必须带 expectedHeadSha 护栏（只合并等待过检查的那个 SHA）', () => {
    // 回归：曾只传 merge_method，若等待检查期间 head 被再次推送，
    // 就会合并未经验证的新提交（目标 §1.3.5 核心核查项）。
    const m = /client\.mergePullRequest\(\{([\s\S]*?)\}\)/.exec(src);
    assert.ok(m, '找不到 mergePullRequest 调用');
    assert.match(m[1], /expectedHeadSha/, '合并调用必须传 expectedHeadSha');
    // 且必须用「等待检查用的那个 SHA」，不是另取
    assert.match(m[1], /expectedHeadSha:\s*headSha/);
  });

  it('head SHA 无法确定时不得合并', () => {
    const m = /if \(!headSha\) \{([\s\S]*?)return 1;/.exec(src);
    assert.ok(m, '找不到 head SHA 缺失分支');
    assert.match(m[1], /不合并|不能验证/);
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
