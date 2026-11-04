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
  buildPullRequestTitle,
  isAuthorizedWriteEvent,
  GitHubApiError,
} from '../lib/github.mjs';
import { validateUpdateBatch, loadAliasByDir } from '../lib/validate-batch.mjs';

// ─── 环境 ────────────────────────────────────────────────────────────────

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';
// ⚠️ GITHUB_TOKEN 回退必须显式警告（audit P2-d）：
//    GITHUB_TOKEN 开出的 PR **不会**再触发 pull_request 工作流（GitHub 防 re-run 循环的
//    内置机制），必需检查永远不会出现 → 合并门禁 waitForChecks 必然超时 → 批次死锁。
//    正确做法是配置仓库 secret PAT_TOKEN（classic PAT，勾选 repo 写权限）。
let PAT_TOKEN = process.env.PAT_TOKEN || '';
if (!PAT_TOKEN && process.env.GITHUB_TOKEN) {
  PAT_TOKEN = process.env.GITHUB_TOKEN;
  console.warn(
    '[WARN] 未设置 PAT_TOKEN，回退使用 GITHUB_TOKEN：' +
      'GITHUB_TOKEN 创建的 PR 不会触发 pull_request 工作流（GitHub 防自触发机制），' +
      '本 PR 的必需检查将永远 pending → 合并门禁超时，批次无法自动合并。' +
      '请改用仓库 secret PAT_TOKEN（有 repo 写权限的 classic PAT）。'
  );
}
const BASE_BRANCH = process.env.GITHUB_BASE_REF || 'main';
// 等待必需检查通过的超时时间（默认 30 分钟）
const MERGE_TIMEOUT_MS = Number(process.env.MERGE_TIMEOUT_MS || 1800000);
// 轮询间隔（默认 30 秒）
const CHECK_POLL_INTERVAL_MS = Number(process.env.CHECK_POLL_INTERVAL_MS || 30000);
// PR title 前缀：用于识别「重复的批次 PR」
const PR_TITLE_PREFIX = 'chore(deps): auto-update';
// 仅用于本地 E2E 验证（打 mock API）；CI 不设置，走官方 api.github.com
const API_BASE = process.env.GITHUB_API_BASE || undefined;

// ─── 事件护栏（防御纵深）──────────────────────────────────────────────────
// 工作流的 `if:` 已把 PR 事件排除在写 job 外；这里是脚本层第二道防线：
// 即使工作流被误改成在 pull_request / pull_request_target 下运行，本脚本也拒绝
// 执行任何 git 写操作 / GitHub 写请求（PR 代码不得间接获得 PAT 写权限）。
if (!isAuthorizedWriteEvent(GITHUB_EVENT_NAME)) {
  console.error(
    `[ERROR] 事件 "${GITHUB_EVENT_NAME}" 不允许执行自动更新写操作（仅允许 schedule / workflow_dispatch / push）`
  );
  console.error('[ERROR] pull_request / pull_request_target 属于只读事件，拒绝推送分支 / 开 PR / 合并');
  process.exit(1);
}

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
    // audit P2-b：查询失败必须强 abort，不能带着「未知是否已有 PR」继续往下创建
    // （旧实现 warn 后继续 → 可能开出重复批次 PR / 重复关闭合并门禁）。
    console.error(`[ERROR] 查询今日已有 PR 失败，无法判断是否重复 → 中止: ${e.message}`);
    console.error('[说明] 可重跑 workflow_dispatch；查询成功前不会创建任何分支 / PR。');
    return 1;
  }

  // 1b) 防重复：是否已有「同 base 分支」的批次 PR（第二个批次 PR 会与第一个重复）
  try {
    const openPrs = await client.listOpenPullRequests({ owner, repo });
    const duplicate = openPrs.find(
      pr =>
        pr &&
        typeof pr.title === 'string' &&
        pr.title.startsWith(PR_TITLE_PREFIX) &&
        (pr.base && pr.base.ref ? pr.base.ref === BASE_BRANCH : true),
    );
    if (duplicate) {
      console.log(
        `[SKIP] 已存在同 base 分支 (${BASE_BRANCH}) 的批次 PR #${duplicate.number}` +
          `（${duplicate.title}），跳过以避免重复 PR`,
      );
      return 0;
    }
  } catch (e) {
    // audit P2-b：同上，重复 PR 查询失败也不允许继续（未知状态下开 PR = 开重复批次）。
    console.error(`[ERROR] 查询重复批次 PR 失败，无法判断是否重复 → 中止: ${e.message}`);
    console.error('[说明] 可重跑 workflow_dispatch；查询成功前不会创建任何分支 / PR。');
    return 1;
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
  // audit P2-a：--force-with-lease 替代裸 --force。
  // 分支由 -B 重建（今日分支可能本地残留），推送仍需覆盖远端；但 lease 能在
  // 远端有「我们不知道的新提交」（如本地 clone 的 remote-tracking 已过期 /
  // 出现第三方推入）时拒绝覆盖，避免静默吞掉别人的批次提交。
  gitInherit(['push', '--force-with-lease', 'origin', branch]);
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

  // ⚠️ PR title / commit message **都不能**带 [skip ci] 之类 skip 指令：
  //    GitHub 对 pull_request 事件判定的是 PR 的 HEAD commit message（以及 PR title），
  //    命中 skip 会让本 PR 的 validate workflow 被整体跳过 → 必需检查永远不出现 →
  //    waitForChecks 只能超时 → PR 永远无法自动合并（门禁死锁）。
  //    合并后的 push 递归触发由 workflow 的 on.push.paths 过滤防住，不需要 skip 指令。
  const prTitle = buildPullRequestTitle({ today });
  const prBody = buildPullRequestBody({ updates, changedFiles, generatedAt, today });

  // 6) **开 PR 前**做批次配置校验（有 errors 就不开 PR）
  //    校验失败时**保留**已推送的远程分支（与其它失败路径同一策略）。
  //    批次模式（updates 非空）只对**本批次改动过的**内容下重判：
  //    历史遗留债务（如 firecrawl 的 playwright-service:latest）只报 warning，
  //    不会把合法批次永久堵死。
  if (!updates.length) {
    console.warn('[WARN] updates.json 中没有更新记录，跳过批次校验');
  } else {
    const { errors: validationErrors, warnings: validationWarnings } = validateUpdateBatch({
      root: process.cwd(),
      updates,
      aliasByDir: loadAliasByDir(process.cwd()),
    });
    for (const w of validationWarnings) {
      console.warn(`[WARN] ${w}`);
    }
    if (validationErrors.length > 0) {
      console.error(`[ERROR] 批次校验失败（${validationErrors.length} 个错误），不开 PR：`);
      for (const e of validationErrors) console.error(`  · ${e}`);
      console.error(`[保留] 远程分支 ${branch} 已保留，可修复后重跑 / 手动开 PR:`);
      console.error(`       https://github.com/${GITHUB_REPOSITORY}/compare/${BASE_BRANCH}...${branch}`);
      return 1;
    }
    console.log('[OK] 批次校验通过');
  }

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

  // 7) **等待必需检查通过**（只有 success 才允许合并）
  //    head sha：优先取 PR 响应里的 head.sha，回退到本地 git rev-parse HEAD
  let headSha = pr && pr.head && pr.head.sha ? pr.head.sha : '';
  if (!headSha) {
    try {
      headSha = git(['rev-parse', 'HEAD']).trim();
    } catch (e) {
      console.warn(`[WARN] 无法确定 head SHA: ${e.message}`);
    }
  }
  if (!headSha) {
    console.error('[ERROR] 无法确定 PR head SHA，不能验证检查状态 → 不合并');
    console.error(`[保留] PR #${pr.number} 与远程分支 ${branch} 已保留`);
    return 1;
  }

  console.log(
    `[WAIT] 等待必需检查通过（sha=${headSha.slice(0, 8)}，超时 ${MERGE_TIMEOUT_MS}ms，轮询 ${CHECK_POLL_INTERVAL_MS}ms）`,
  );
  const checkResult = await client.waitForChecks({
    owner,
    repo,
    ref: headSha,
    timeoutMs: MERGE_TIMEOUT_MS,
    intervalMs: CHECK_POLL_INTERVAL_MS,
  });

  if (checkResult.status !== 'success') {
    console.error(`[ERROR] 检查状态为 "${checkResult.status}" → 不合并`);
    if (checkResult.error) console.error(`       API 调用失败: ${checkResult.error}`);
    for (const c of checkResult.checks || []) {
      console.error(`       - ${c.name}: ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ''}`);
    }
    console.error(`[保留] PR #${pr.number} 与远程分支 ${branch} 已保留，可修复后手动合并`);
    return 1;
  }
  console.log(`[OK] 检查全部通过（${checkResult.checks.length} 项）`);

  // 8) 合并 PR
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
