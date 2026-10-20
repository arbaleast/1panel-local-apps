#!/usr/bin/env node
// bin/open-update-pr.mjs — 自动开 PR 并合并（detect-and-pr job 的编排逻辑）
// 由 .github/workflows/auto-update.yml 调用，接收 GITHUB_TOKEN / PAT_TOKEN 环境变量
// 职责：git 配置 → 创建分支 → 暂存提交 → 推送 → 开 PR → 合并 → 清理远程分支
//
// ── 2026-10-20 事故复盘（改写本脚本的直接原因）────────────────────────────
// 旧实现把 PR body 拼进 shell 命令：
//     execSync(`curl -s -X POST ... -d ${JSON.stringify(JSON.stringify(payload))} ...`)
// body 里的 markdown 反引号（`v3.2.51`、`anirss/v3.2.51/data.yml`）被 POSIX shell
// 当成**命令替换**执行：
//     /bin/sh: 1: 2026-10-20T03:03:25.637Z: not found
//     /bin/sh: 1: v3.2.49: not found
//     /bin/sh: 1: anirss/v3.2.51/data.yml: Permission denied
// 后果链：body 被掏空 → GitHub 返回错误对象（无 number / html_url）→
// 旧代码只判 `JSON.parse` 成功就打印 "[OK] PR 已开: undefined" →
// merge 打到 /pulls/undefined/merge 得到 "Not Found" →
// **旧代码仍继续执行并删掉了刚推送的远程分支** → 整批更新在 GitHub 上凭空消失
// （2026-10-20 批次 42 个文件全部丢失，事后核对 GitHub 确认该分支 PR 从未创建）。
//
// 现在的做法：
//   · API 调用走 Node 内置 fetch（**不经过 shell**）→ 没有注入面，token 也不进 ps
//   · git 调用走 execFileSync（参数数组）→ 不经过 shell
//   · 响应做形状校验：没有 number 一律判失败，绝不打印假 OK
//   · 失败一律非零退出，且**保留**远程分支（可人工开 PR / 重跑）
//   · 远程分支只在 PR **合并成功后**才删除

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import {
  createGitHubClient,
  buildPullRequestBody,
  buildCommitMessage,
  GitHubApiError,
} from '../lib/github.mjs';

// ─── 环境 ────────────────────────────────────────────────────────────────

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN || '';
const BASE_BRANCH = process.env.GITHUB_BASE_REF || 'main';
// 仅用于本地 E2E 验证（打 mock API）；CI 不设置，走官方 api.github.com
const API_BASE = process.env.GITHUB_API_BASE || undefined;

if (!/^[^/\s]+\/[^/\s]+$/.test(GITHUB_REPOSITORY)) {
  console.error('[ERROR] 缺少或非法的 GITHUB_REPOSITORY（应为 owner/repo）');
  process.exit(1);
}
if (!PAT_TOKEN) {
  console.error('[ERROR] 缺少 GITHUB_TOKEN / PAT_TOKEN 环境变量');
  process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split('/');

// ─── git 助手（execFileSync：参数数组，不经 shell）─────────────────────────

/** 执行 git 并捕获输出 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** 执行 git 并把输出直接透传到终端 */
function gitInherit(args) {
  execFileSync('git', args, { stdio: 'inherit' });
}

// ─── 分支名 ──────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const branch = `auto-update/${today}`;

if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
  console.error(`[ERROR] 非法分支名 ${branch}`);
  process.exit(1);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  const client = createGitHubClient({ token: PAT_TOKEN, baseUrl: API_BASE });

  // 1) 今日是否已有 open PR
  try {
    const existing = await client.listOpenPullRequests({
      owner,
      repo,
      head: `${owner}:${branch}`,
    });
    if (existing.length > 0) {
      console.log(`[SKIP] 今日 (${today}) 已存在 PR #${existing[0].number}，跳过`);
      return 0;
    }
  } catch (e) {
    // 网络错误时继续尝试创建（与旧行为一致）
    console.warn(`[WARN] 查询已有 PR 失败（继续尝试创建）: ${e.message}`);
  }

  // 2) git 配置 + 切分支
  gitInherit(['config', 'user.name', 'github-actions[bot]']);
  gitInherit(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

  try {
    // -B 强制重建：若同日本地残留分支（罕见），从头再来
    gitInherit(['checkout', '-B', branch]);
  } catch (e) {
    console.error(`[ERROR] 创建/切换分支 ${branch} 失败:`, e.message);
    return 1;
  }

  // 校验：必须在目标分支上，避免 main / master 上 commit
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== branch) {
    console.error(`[ERROR] checkout 后 HEAD 仍在 ${current}（期望 ${branch}），中止`);
    return 1;
  }

  // 3) 暂存 + 提交
  gitInherit(['add', '-A']);
  if (!git(['status', '--porcelain']).trim()) {
    console.log('[SKIP] 无文件改动，跳过');
    return 0;
  }

  const { subject, body } = buildCommitMessage({ today });
  gitInherit(['commit', '-m', subject, '-m', body]);

  // 4) 推送分支
  gitInherit(['push', '--force', 'origin', branch]);
  console.log(`[OK] 推送分支 ${branch}`);

  // 5) 组装 PR body
  const changedFiles = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  let updates = [];
  let generatedAt = new Date().toISOString();
  if (existsSync('updates.json')) {
    try {
      const parsed = JSON.parse(readFileSync('updates.json', 'utf8'));
      if (Array.isArray(parsed.updates)) updates = parsed.updates;
      if (parsed.timestamp) generatedAt = parsed.timestamp;
    } catch (e) {
      console.warn(`[WARN] updates.json 解析失败（PR body 退化为简版）: ${e.message}`);
    }
  }

  const prTitle = `chore(deps): auto-update ${today} [skip ci]`;
  const prBody = buildPullRequestBody({ updates, changedFiles, generatedAt, today });

  // 6) 开 PR —— 失败时**保留**远程分支
  let pr;
  try {
    pr = await client.createPullRequest({
      owner,
      repo,
      head: branch,
      base: BASE_BRANCH,
      title: prTitle,
      body: prBody,
    });
  } catch (e) {
    console.error(`[ERROR] 创建 PR 失败: ${e.message}`);
    console.error(`[保留] 远程分支 ${branch} 已保留，可手动开 PR:`);
    console.error(`       https://github.com/${GITHUB_REPOSITORY}/compare/${BASE_BRANCH}...${branch}`);
    return 1;
  }
  console.log(`[OK] PR 已开: ${pr.html_url} (#${pr.number})`);

  // 7) 合并 PR
  let merged = false;
  try {
    const result = await client.mergePullRequest({
      owner,
      repo,
      number: pr.number,
      mergeMethod: 'merge',
    });
    merged = result.merged;
    if (merged) {
      console.log(`[OK] PR #${pr.number} 已合并到 ${BASE_BRANCH}`);
    } else {
      console.warn(`[WARN] PR #${pr.number} 合并状态: ${result.message}`);
    }
  } catch (e) {
    console.error(`[ERROR] 合并 PR #${pr.number} 失败: ${e.message}`);
  }

  // 8) 清理远程分支 —— 只在合并成功后才删（否则会把 PR 一起关掉 / 丢批次）
  if (merged) {
    try {
      await client.deleteBranch({ owner, repo, branch });
      console.log(`[OK] 远程分支 ${branch} 已删除`);
    } catch (e) {
      console.warn(`[WARN] 删除远程分支失败（非致命）: ${e.message}`);
    }
  } else {
    console.warn(`[保留] PR #${pr.number} 未合并，远程分支 ${branch} 保留以便重试 / 人工处理`);
  }

  return merged ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    if (err instanceof GitHubApiError) {
      console.error(`[ERROR] GitHub API 调用失败: ${err.message}`);
    } else {
      console.error('[ERROR] 未捕获异常:', err);
    }
    process.exit(1);
  });
