#!/usr/bin/env node
// bin/open-update-pr.mjs — 自动开 PR 并合并（detect-and-pr job 的编排逻辑）
// 由 .github/workflows/auto-update.yml 调用，接收 GITHUB_TOKEN / PAT_TOKEN 环境变量
// 职责：git 配置 → 创建/复用分支 → 暂存提交 → 推送 → 开/复用 PR → 等检查 → 合并 → 清理远程分支
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
//
// ── 2026-11 可靠性治理（本次审计的靶向加固）──────────────────────────────
//   · P0-3：旧实现发现「今日已有 PR」/「已有同 base 的批次 PR」时直接 `return 0`
//           → workflow 全绿，但 detect 检出的更新**被静默丢弃**。现在改为
//             **复用既有自动更新 PR**（幂等更新），复用不了就**显式失败**。
//   · P0-3 附带：自动更新 PR 的识别从「PR 标题前缀字符串」改为「**分支前缀**
//             auto-update/**」→ 人工 PR 永远不会被认领、覆盖或关闭。
//   · P0-1：合并门禁改为**必需检查白名单**（github.mjs waitForChecks 的 requiredChecks），
//           缺任一必需检查 → 绝不合并；等待期间 head SHA 变化 → 作废旧结论重新验证。
//   · 去掉 `git push --force-with-lease`：新流程是「远端 tip 之上 rebase 后快进推送」，
//     **不需要任何 force**（目标红线：不使用 git push --force）。
//   · P2-7：`git add -A` 改为**按本次改动的应用目录白名单**添加，避免把工作区
//     残留文件（临时目录 / 半写版本目录）卷进批次 PR。
//   · P2-15：批次校验**前移到 git add / commit / push 之前**——坏内容不再先进远端分支。
//   · P2-12：回退到 GITHUB_TOKEN 时**直接中止**（GITHUB_TOKEN 开出的 PR 不会触发
//             pull_request 工作流 → 必需检查永远不会出现 → 必然 15 分钟超时死锁）。

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  createGitHubClient,
  buildPullRequestBody,
  buildCommitMessage,
  buildPullRequestTitle,
  isAuthorizedWriteEvent,
  DEFAULT_REQUIRED_CHECKS,
  GitHubApiError,
} from '../lib/github.mjs';
import { validateUpdateBatch, loadAliasByDir } from '../lib/validate-batch.mjs';

// ─── 环境 ────────────────────────────────────────────────────────────────

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';
const BASE_BRANCH = process.env.GITHUB_BASE_REF || 'main';
// 等待必需检查通过的超时时间（默认 30 分钟）
const MERGE_TIMEOUT_MS = Number(process.env.MERGE_TIMEOUT_MS || 1800000);
// 轮询间隔（默认 30 秒）
const CHECK_POLL_INTERVAL_MS = Number(process.env.CHECK_POLL_INTERVAL_MS || 30000);
// 目标 PR 上**必须**通过的检查（缺任一 → 绝不合并）
const REQUIRED_CHECKS = (process.env.REQUIRED_CHECKS || DEFAULT_REQUIRED_CHECKS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// head SHA 变化后的重验次数上限
const MAX_SHA_REVALIDATIONS = Number(process.env.MAX_SHA_REVALIDATIONS || 3);
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

// ⚠️ GITHUB_TOKEN 回退必须**显式中止**（audit P2-12）：
//    GITHUB_TOKEN 开出的 PR **不会**再触发 pull_request 工作流（GitHub 防 re-run 循环的
//    内置机制），必需检查永远不会出现 → 合并门禁 waitForChecks 必然超时 → 批次死锁。
//    正确做法是配置仓库 secret PAT_TOKEN（classic PAT，勾选 repo 写权限）。
//    放在事件护栏之后：PR 事件下的拒绝必须优先于一切其它判断。
let PAT_TOKEN = process.env.PAT_TOKEN || '';
if (!PAT_TOKEN && process.env.GITHUB_TOKEN) {
  console.error(
    '[ERROR] 未设置 PAT_TOKEN，拒绝使用 GITHUB_TOKEN 开 PR：' +
      'GITHUB_TOKEN 创建的 PR 不会触发 pull_request 工作流（GitHub 防自触发机制），' +
      '本 PR 的必需检查将永远不出现 → 合并门禁必然超时，批次无法自动合并。' +
      '请在仓库 secret 中配置 PAT_TOKEN（有 repo 写权限的 classic PAT）后重跑。',
  );
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

/**
 * 读取远端分支 tip 的 SHA（分支不存在 → 返回空串）
 * @param {string} branch
 * @returns {string}
 */
function remoteTipSha(branch) {
  try {
    const out = git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    return out.trim().split(/\s+/)[0] || '';
  } catch (e) {
    console.warn(`[WARN] 读取远端分支 ${branch} 失败: ${e.message}`);
    return '';
  }
}

// ─── 分支名 ──────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const defaultBranch = `auto-update/${today}`;

if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
  console.error(`[ERROR] 非法分支名 ${defaultBranch}`);
  process.exit(1);
}

// ─── 执行结果（写入 execution.json，供 workflow summary 渲染）─────────────

/**
 * 结构化执行结果（目标 §七.1）
 * @type {{pr: object|null, ci: object|null, merge: object|null, steps: Array<object>}}
 */
const execution = {
  timestamp: new Date().toISOString(),
  branch: null,
  reusedPr: false,
  pr: null,
  ci: null,
  merge: null,
  steps: [],
};

/** 记录一个阶段结果 */
function step(name, outcome, detail = '') {
  execution.steps.push({ name, outcome, detail });
  console.log(`[STEP] ${name}: ${outcome}${detail ? ` — ${detail}` : ''}`);
}

/** 落盘执行结果（失败也写，便于诊断） */
function flushExecution() {
  try {
    writeFileSync('execution.json', JSON.stringify(execution, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[WARN] 写 execution.json 失败: ${e.message}`);
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

async function main() {
  const client = createGitHubClient({ token: PAT_TOKEN, baseUrl: API_BASE });

  // ── 1) 识别既有自动更新 PR（按**分支前缀**，绝不碰人工 PR）────────────
  let existingPr = null;
  try {
    const autoPrs = await client.findAutoUpdatePullRequests({
      owner,
      repo,
      base: BASE_BRANCH,
    });
    if (autoPrs.length > 1) {
      console.error(
        `[ERROR] 存在 ${autoPrs.length} 个未合并的自动更新 PR（${autoPrs
          .map(p => `#${p.number}(${p.head?.ref})`)
          .join(', ')}）` +
          ' → 无法安全判断复用哪一支，拒绝继续（请先人工合并或关闭多余的 PR）',
      );
      step('pr-discover', 'failed', '存在多个未合并的自动更新 PR');
      flushExecution();
      return 1;
    }
    existingPr = autoPrs[0] || null;
  } catch (e) {
    // 查询失败必须强 abort：带着「未知是否已有 PR」继续 → 可能开重复批次 PR
    console.error(`[ERROR] 查询既有自动更新 PR 失败，无法判断是否重复 → 中止: ${e.message}`);
    console.error('[说明] 可重跑 workflow_dispatch；查询成功前不会创建任何分支 / PR。');
    step('pr-discover', 'failed', e.message);
    flushExecution();
    return 1;
  }

  // 复用既有自动更新 PR 的分支；没有则用今天的默认分支
  const branch =
    existingPr && existingPr.head && typeof existingPr.head.ref === 'string'
      ? existingPr.head.ref
      : defaultBranch;
  const reuse = Boolean(existingPr);
  execution.branch = branch;
  execution.reusedPr = reuse;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    console.error(`[ERROR] 非法分支名 ${branch}`);
    return 1;
  }
  console.log(
    reuse
      ? `[REUSE] 复用既有自动更新 PR #${existingPr.number}（分支 ${branch}）`
      : `[NEW] 将创建新的自动更新分支 ${branch}`,
  );

  // ── 2) git 配置 + 切分支 ──────────────────────────────────────────────
  gitInherit(['config', 'user.name', 'github-actions[bot]']);
  gitInherit(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

  const baseSha = git(['rev-parse', 'HEAD']).trim();

  try {
    // -B 强制重建本地分支：从当前 HEAD（base）出发，绝不带着别的分支的历史
    gitInherit(['checkout', '-B', branch]);
  } catch (e) {
    console.error(`[ERROR] 创建/切换分支 ${branch} 失败:`, e.message);
    step('checkout', 'failed', e.message);
    flushExecution();
    return 1;
  }

  // 校验：必须在目标分支上，避免 main / master 上 commit
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (current !== branch) {
    console.error(`[ERROR] checkout 后 HEAD 仍在 ${current}（期望 ${branch}），中止`);
    return 1;
  }

  // ── 3) 读取 updates.json（批次内容）──────────────────────────────────
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

  // ── 4) **批次校验前置**（在 git add / commit / push 之前）──────────────
  //    旧实现在 push 之后才校验 → 坏内容先进远端分支才被拦。
  //    批次模式（updates 非空）只对**本批次改动过的**内容下重判：
  //    历史遗留债务（如 firecrawl 的 playwright-service:latest）只报 warning，
  //    不会把合法批次永久堵死。
  if (!updates.length) {
    console.warn('[WARN] updates.json 中没有更新记录，跳过批次校验');
    step('validate-batch', 'skipped', 'updates.json 无更新记录');
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
      console.error(`[ERROR] 批次校验失败（${validationErrors.length} 个错误），不提交 / 不推送 / 不开 PR：`);
      for (const e of validationErrors) console.error(`  · ${e}`);
      step('validate-batch', 'failed', `${validationErrors.length} 个错误`);
      flushExecution();
      return 1;
    }
    console.log('[OK] 批次校验通过');
    step('validate-batch', 'ok');
  }

  // ── 5) 暂存 + 提交（**按路径白名单**，避免卷进工作区残留）──────────────
  const addPaths = [];
  for (const u of updates) {
    if (!u || typeof u.app !== 'string') continue;
    const dirs = new Set();
    if (typeof u.versionDir === 'string') dirs.add(u.versionDir);
    if (u.versionCopy && typeof u.versionCopy.toDir === 'string') dirs.add(u.versionCopy.toDir);
    for (const c of u.changes || []) {
      if (c && typeof c.path === 'string') {
        const parts = c.path.split('/');
        if (parts.length >= 2) dirs.add(parts[1]);
      }
    }
    for (const d of dirs) addPaths.push(`${u.app}/${d}`);
  }
  // README 同步（sync-readme.mjs）改的是仓库根 README.md
  addPaths.push('README.md');

  // 本次是否产生了新提交（幂等重跑时为 false → 跳过推送）
  let noNewCommit = false;

  // 去重
  const addPathList = [...new Set(addPaths.filter(Boolean))];
  if (addPathList.length > 0) {
    gitInherit(['add', '--', ...addPathList]);
  }
  // 幂等保护：**已暂存**内容为空 → 无实际变化 → 不产生空提交。
  // 注意：不能用 `git status --porcelain` 判断 —— 工作区里可能存在与本批次无关的
  // 改动（例如 detect 之外的文件），那不代表本批次有内容可提交。
  if (!git(['diff', '--cached', '--name-only']).trim()) {
    if (!existingPr) {
      // 没有既有 PR 且本批次无改动 → 确实无事可做，直接收工
      console.log('[SKIP] 无文件改动，跳过');
      step('commit', 'skipped', '无文件改动（幂等）');
      flushExecution();
      return 0;
    }
    // **已有未合并的自动更新 PR** → 不能在此收工：
    // 该 PR 可能已通过全部必需检查、只差最后一步合并。此时直接返回 0 会让
    // PR 永远悬着（实测 PR #50 的必需检查早已 success，门禁却卡满 15 分钟，
    // 重跑又因「无改动」提前退出 → 批次永远合不进去）。
    // 正确做法：跳过提交/推送，**继续走**「等待必需检查 → 合并」流程。
    console.log('[SKIP] 无文件改动（幂等），但存在未合并的自动更新 PR → 继续走检查门禁与合并');
    step('commit', 'skipped', '无文件改动（幂等），沿用既有 PR 继续合并流程');
    noNewCommit = true;
  } else {
    const { subject, body } = buildCommitMessage({ today });
    gitInherit(['commit', '-m', subject, '-m', body]);
    step('commit', 'ok');
  }

  // ── 6) 推送分支（**快进推送，全程不使用 force**）────────────────────────
  //    若远端已存在同名分支（复用既有 PR / 上次残留），先把本次提交 rebase 到
  //    远端 tip 之上，再快进推送 → 不覆盖任何人的提交，也不会 force。
  //
  //    ⚠️ 幂等重跑（无新提交）时**必须跳过推送**：远端分支已含上一批提交，
  //    本地 HEAD 停在 base 上，此时 push 会被判非快进而失败 → 永远走不到合并。
  if (noNewCommit) {
    console.log(`[SKIP] 无新提交，沿用远端分支 ${branch} 的现状（不推送）`);
    step('push', 'skipped', '无新提交（幂等），不推送');
  } else {
    const remoteTip = remoteTipSha(branch);
    if (remoteTip) {
      try {
        gitInherit(['fetch', 'origin', branch]);
        gitInherit(['rebase', '--onto', 'FETCH_HEAD', baseSha]);
        console.log(`[OK] 已把本次提交 rebase 到远端 ${branch}（${remoteTip.slice(0, 8)}）之上`);
      } catch (e) {
        console.error(`[ERROR] rebase 到远端分支 ${branch} 失败（可能有冲突）: ${e.message}`);
        try {
          gitInherit(['rebase', '--abort']);
          console.error('[说明] 已中止 rebase，远端分支与本地提交均未改变。');
        } catch {
          /* ignore */
        }
        step('push', 'failed', 'rebase 冲突');
        flushExecution();
        return 1;
      }
    }
    try {
      gitInherit(['push', 'origin', branch]);
      console.log(`[OK] 推送分支 ${branch}`);
      step('push', 'ok');
    } catch (e) {
      console.error(`[ERROR] 推送分支 ${branch} 失败: ${e.message}`);
      console.error('[保留] 本地提交未丢失；远端状态未被覆盖。请检查并发后重跑。');
      step('push', 'failed', e.message);
      flushExecution();
      return 1;
    }
  }

  // ── 7) 组装 PR body / title ──────────────────────────────────────────
  const changedFiles = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  // ⚠️ PR title / commit message **都不能**带 [skip ci] 之类 skip 指令：
  //    GitHub 对 pull_request 事件判定的是 PR 的 HEAD commit message（以及 PR title），
  //    命中 skip 会让本 PR 的 validate workflow 被整体跳过 → 必需检查永远不出现 →
  //    waitForChecks 只能超时 → PR 永远无法自动合并（门禁死锁）。
  //    合并后的 push 递归触发由 workflow 的 on.push.paths 过滤防住，不需要 skip 指令。
  const prTitle = buildPullRequestTitle({ today });
  const prBody = buildPullRequestBody({ updates, changedFiles, generatedAt, today });

  // ── 8) 开 PR / 复用既有 PR ───────────────────────────────────────────
  let pr;
  try {
    if (reuse) {
      pr = await client.updatePullRequest({
        owner,
        repo,
        number: existingPr.number,
        title: prTitle,
        body: prBody,
      });
      console.log(`[OK] 已复用并更新 PR #${pr.number}: ${pr.html_url}`);
    } else {
      pr = await client.createPullRequest({
        owner,
        repo,
        head: branch,
        base: BASE_BRANCH,
        title: prTitle,
        body: prBody,
      });
      console.log(`[OK] PR 已开: ${pr.html_url} (#${pr.number})`);
    }
  } catch (e) {
    console.error(`[ERROR] ${reuse ? '更新' : '创建'} PR 失败: ${e.message}`);
    console.error(`[保留] 远程分支 ${branch} 已保留，可手动开 PR:`);
    console.error(`       https://github.com/${GITHUB_REPOSITORY}/compare/${BASE_BRANCH}...${branch}`);
    step('pr', 'failed', e.message);
    flushExecution();
    return 1;
  }
  execution.pr = {
    number: pr.number,
    url: pr.html_url || '',
    reused: reuse,
    title: prTitle,
  };
  step('pr', 'ok', `#${pr.number}${reuse ? '（复用）' : ''}`);

  // ── 9) **等待必需检查通过**（只有 requiredChecks 全部 success 才允许合并）──
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
    step('ci', 'failed', '无法确定 head SHA');
    flushExecution();
    return 1;
  }

  console.log(
    `[WAIT] 等待必需检查通过（sha=${headSha.slice(0, 8)}，必需检查=${REQUIRED_CHECKS.join(', ')}，` +
      `超时 ${MERGE_TIMEOUT_MS}ms，轮询 ${CHECK_POLL_INTERVAL_MS}ms）`,
  );

  let checkResult = null;
  for (let attempt = 0; attempt <= MAX_SHA_REVALIDATIONS; attempt++) {
    checkResult = await client.waitForChecks({
      owner,
      repo,
      ref: headSha,
      requiredChecks: REQUIRED_CHECKS,
      timeoutMs: MERGE_TIMEOUT_MS,
      intervalMs: CHECK_POLL_INTERVAL_MS,
      // 等待期间 PR 可能被再次推送 → head SHA 变化 → 旧 SHA 的检查结论作废
      resolveHeadSha: async () => {
        const fresh = await client.getPullRequest({ owner, repo, number: pr.number });
        return (fresh && fresh.head && fresh.head.sha) || null;
      },
    });
    if (checkResult.status === 'sha-changed' && checkResult.currentSha) {
      console.log(`[RETRY] PR head SHA 已变化 → 作废旧结论，改用新 SHA 重新验证`);
      headSha = checkResult.currentSha;
      continue;
    }
    break;
  }

  if (checkResult.status !== 'success') {
    console.error(`[ERROR] 检查状态为 "${checkResult.status}" → 不合并`);
    if (checkResult.error) console.error(`       原因: ${checkResult.error}`);
    if (checkResult.missing && checkResult.missing.length > 0) {
      console.error(`       缺失的必需检查: ${checkResult.missing.join(', ')}`);
    }
    for (const c of checkResult.checks || []) {
      console.error(`       - ${c.name}: ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ''}`);
    }
    console.error(`[保留] PR #${pr.number} 与远程分支 ${branch} 已保留，可修复后手动合并`);
    execution.ci = {
      status: checkResult.status,
      sha: headSha,
      requiredChecks: REQUIRED_CHECKS,
      missing: checkResult.missing || [],
      checks: checkResult.checks || [],
      error: checkResult.error || null,
    };
    step('ci', 'failed', checkResult.status);
    flushExecution();
    return 1;
  }
  console.log(`[OK] 检查全部通过（${checkResult.checks.length} 项）`);
  execution.ci = {
    status: 'success',
    sha: headSha,
    requiredChecks: REQUIRED_CHECKS,
    missing: [],
    checks: checkResult.checks || [],
  };
  step('ci', 'ok', `${checkResult.checks.length} 项`);

  // ── 10) 合并 PR ──────────────────────────────────────────────────────
  let merged = false;
  let mergeMessage = '';
  try {
    const result = await client.mergePullRequest({
      owner,
      repo,
      number: pr.number,
      mergeMethod: 'merge',
      // sha 护栏：只合并「等待检查通过的那个 head SHA」。
      // 等待期间若分支被再次推送，GitHub 返回 409 → 不会合并未经验证的提交。
      expectedHeadSha: headSha,
    });
    merged = result.merged;
    mergeMessage = result.message || '';
    if (merged) {
      console.log(`[OK] PR #${pr.number} 已合并到 ${BASE_BRANCH}`);
    } else {
      console.warn(`[WARN] PR #${pr.number} 合并状态: ${mergeMessage}`);
    }
  } catch (e) {
    console.error(`[ERROR] 合并 PR #${pr.number} 失败: ${e.message}`);
    mergeMessage = e.message;
  }
  execution.merge = { status: merged ? 'merged' : 'not-merged', message: mergeMessage };
  step('merge', merged ? 'ok' : 'failed', mergeMessage);

  // ── 11) 清理远程分支 —— 只在合并成功后才删（否则会把 PR 一起关掉 / 丢批次）
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

  flushExecution();
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
    flushExecution();
    process.exit(1);
  });
