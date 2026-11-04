// lib/github.mjs — GitHub REST 客户端 + PR 文案构造
//
// ── 为什么有这个模块 ─────────────────────────────────────────────────────
// 2026-10-20 auto-update 事故：旧版 bin/open-update-pr.mjs 用
//   execSync(`curl ... -d ${JSON.stringify(JSON.stringify(payload))} ...`)
// 把 PR body 拼进 shell 命令。body 里的 markdown 反引号（`v3.2.51`、
// `anirss/v3.2.51/data.yml`）被 POSIX shell 当成**命令替换**执行：
//
//   /bin/sh: 1: 2026-10-20T03:03:25.637Z: not found      ← 检测时间被吃掉
//   /bin/sh: 1: v3.2.49: not found                       ← before/after 被吃掉
//   /bin/sh: 1: anirss/v3.2.51/data.yml: Permission denied
//
// 后果链：body 被掏空 → GitHub 返回错误对象（无 number / html_url）→
// 脚本只判断 JSON.parse 成功就打印 "[OK] PR 已开: undefined" →
// merge 请求打到 /pulls/undefined/merge 得到 "Not Found" →
// **脚本仍继续执行并删掉了刚推送的远程分支** → 整批更新在 GitHub 上凭空消失。
//
// 修法：API 调用一律走 Node 内置 fetch（Node >= 18），**不经过 shell**；
// 响应做形状校验，错误对象不再被当成成功；失败时保留远程分支并非零退出。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   const client = createGitHubClient({ token });
//   const pr = await client.createPullRequest({ owner, repo, head, base, title, body });
//
// 本模块无第三方依赖（仅用 Node 内置 fetch / URL / URLSearchParams）。

export const GITHUB_API_BASE = 'https://api.github.com';

/** GitHub API 调用失败（HTTP 非 2xx，或响应形状不符合预期） */
export class GitHubApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, method?: string, path?: string, details?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = info.status;
    this.method = info.method;
    this.path = info.path;
    this.details = info.details;
  }
}

/**
 * 会被判定为「检查失败」的 conclusion 集合
 * （注意：`skipped` / `neutral` 也按失败处理——不通过就等于没通过）
 */
export const FAILING_CONCLUSIONS = new Set([
  'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped',
]);

/**
 * 允许执行「自动更新写操作」的 GitHub 事件白名单。
 * `pull_request` / `pull_request_target` 永远不在白名单里：
 * 这两个事件会执行 PR 作者的代码，绝不能拿到 PAT 写权限。
 */
export const AUTHORIZED_WRITE_EVENTS = new Set(['schedule', 'workflow_dispatch', 'push']);

/**
 * 判断当前事件是否允许执行自动更新写操作（脚本层防御纵深）
 *
 * 工作流的 `if:` 是第一道防线；本函数是第二道——即使工作流配置被改错，
 * 写脚本在 PR 事件下也会直接拒绝执行（不碰 git、不发写请求）。
 *
 * 注意：`eventName` 为空视为本地手动运行（无 GITHUB_EVENT_NAME 环境变量），允许执行。
 *
 * @param {string|undefined|null} eventName
 * @returns {boolean}
 */
export function isAuthorizedWriteEvent(eventName) {
  if (!eventName) return true;
  return AUTHORIZED_WRITE_EVENTS.has(String(eventName));
}

/**
 * 创建 GitHub REST 客户端
 * @param {{token: string, baseUrl?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {{request: Function, listOpenPullRequests: Function, createPullRequest: Function,
 *            mergePullRequest: Function, deleteBranch: Function,
 *            listCheckRuns: Function, getCombinedStatus: Function, waitForChecks: Function}}
 */
export function createGitHubClient({ token, baseUrl = GITHUB_API_BASE, fetchImpl } = {}) {
  if (!token) throw new Error('createGitHubClient: 缺少 token');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createGitHubClient: 当前运行环境没有 fetch（需要 Node >= 18）');
  }

  /**
   * 发起一次 GitHub API 请求。**不使用 shell**，body 由 JSON.stringify 序列化，
   * 任何字符（反引号 / $ / 引号 / 换行）都不会被 shell 二次解释。
   */
  async function request(method, path, body) {
    const url = `${baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': '1panel-local-apps-auto-update',
    };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await doFetch(url, { method, headers, body: payload });
    } catch (e) {
      throw new GitHubApiError(`GitHub API ${method} ${path} 网络错误: ${e.message}`, {
        method,
        path,
      });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const apiMessage = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      const detail = data && data.errors ? ` (${JSON.stringify(data.errors)})` : '';
      throw new GitHubApiError(`GitHub API ${method} ${path} 失败: ${apiMessage}${detail}`, {
        status: res.status,
        method,
        path,
        details: data,
      });
    }
    return data;
  }

  /** 列出 open 状态的 PR；head 形如 "owner:branch" */
  async function listOpenPullRequests({ owner, repo, head }) {
    const params = new URLSearchParams({ state: 'open' });
    if (head) params.set('head', head);
    const data = await request('GET', `/repos/${owner}/${repo}/pulls?${params.toString()}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 创建 PR。**必须**拿到 number，否则视为失败（2026-10-20 事故就是
   * 错误对象被当成 PR，导致 "PR 已开: undefined"）。
   */
  async function createPullRequest({ owner, repo, head, base, title, body }) {
    const path = `/repos/${owner}/${repo}/pulls`;
    const data = await request('POST', path, { title, head, base, body });
    if (!data || typeof data.number !== 'number') {
      throw new GitHubApiError('GitHub API 创建 PR 未返回编号（number），判定为失败', {
        method: 'POST',
        path,
        details: data,
      });
    }
    return data;
  }

  /** 合并 PR，返回 { merged, message } */
  async function mergePullRequest({ owner, repo, number, mergeMethod = 'merge' }) {
    const path = `/repos/${owner}/${repo}/pulls/${number}/merge`;
    const data = await request('PUT', path, { merge_method: mergeMethod });
    return {
      merged: Boolean(data && data.merged),
      message: (data && data.message) || '',
    };
  }

  /** 删除远程分支（PR 合并成功后才调用） */
  async function deleteBranch({ owner, repo, branch }) {
    await request('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
    return true;
  }

  /**
   * 列出某个 ref（commit / 分支）上的 check runs
   *
   * @param {{owner: string, repo: string, ref: string}} params
   * @returns {Promise<Array<{name: string, status: string, conclusion: string|null}>>}
   */
  async function listCheckRuns({ owner, repo, ref }) {
    const data = await request(
      'GET',
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    const runs = (data && data.check_runs) || [];
    if (!Array.isArray(runs)) return [];
    return runs.map(r => ({
      name: r.name || '',
      status: r.status || '',
      conclusion: r.conclusion === undefined ? null : r.conclusion,
    }));
  }

  /**
   * 获取某个 ref 的**合并 commit status**（legacy commit status API）
   * @param {{owner: string, repo: string, ref: string}} params
   * @returns {Promise<{state: string, statuses: Array<object>}>}
   */
  async function getCombinedStatus({ owner, repo, ref }) {
    const data = await request(
      'GET',
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`,
    );
    return {
      state: (data && data.state) || 'unknown',
      statuses: (data && Array.isArray(data.statuses)) ? data.statuses : [],
    };
  }

  /**
   * 轮询等待某个 ref 的必需检查跑完
   *
   * 返回值语义（调用方必须只对 `success` 执行合并）：
   *   · `success` —— 至少有一个 check run，且全部 completed + conclusion=success，
   *                  同时合并状态不是 failure / pending；
   *   · `failure` —— 任一 check run 的 conclusion 在失败集合里，或合并状态为 failure；
   *   · `timeout` —— 超时仍有检查在跑，或**始终没有出现任何 check run**；
   *   · `unknown` —— API 调用本身失败（网络错误 / 非 2xx）。
   *
   * `now` / `sleep` 可注入，便于单测（不依赖真实定时器）。
   *
   * @param {{owner: string, repo: string, ref: string, timeoutMs?: number,
   *          intervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} params
   * @returns {Promise<{status: 'success'|'failure'|'timeout'|'unknown',
   *                    checks: Array<{name: string, status: string, conclusion: string|null}>,
   *                    error?: string}>}
   */
  async function waitForChecks({
    owner,
    repo,
    ref,
    timeoutMs = 1800000,
    intervalMs = 30000,
    now = () => Date.now(),
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  }) {
    const start = now();
    let checks = [];

    // 最多轮询到超时（每轮至少 sleep 一次，保证 now 能推进）
    for (;;) {
      let runs;
      let combined;
      try {
        runs = await listCheckRuns({ owner, repo, ref });
        combined = await getCombinedStatus({ owner, repo, ref });
      } catch (e) {
        // API 调用失败 → 状态未知，调用方**不得**合并
        return { status: 'unknown', checks, error: e.message };
      }

      checks = runs;

      // 1) 任一检查失败 → 立即判定失败
      for (const c of checks) {
        if (c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion)) {
          return { status: 'failure', checks };
        }
      }
      // 2) 合并 commit status 失败 → 判定失败
      if (combined && combined.state === 'failure') {
        return { status: 'failure', checks };
      }

      // 3) 全部通过
      const allPassed =
        checks.length > 0 &&
        checks.every(c => c.status === 'completed' && c.conclusion === 'success');
      const combinedPending = combined && combined.state === 'pending';
      if (allPassed && !combinedPending) {
        return { status: 'success', checks };
      }

      // 4) 超时（检查仍在跑，或始终没有出现任何 check run）
      if (now() - start >= timeoutMs) {
        return { status: 'timeout', checks };
      }

      await sleep(intervalMs);
    }
  }

  return {
    request,
    listOpenPullRequests,
    createPullRequest,
    mergePullRequest,
    deleteBranch,
    listCheckRuns,
    getCombinedStatus,
    waitForChecks,
  };
}

/**
 * 构造 PR body（Markdown）
 *
 * 反引号原样保留 —— 这是 2026-10-20 事故的核心回归点：body 现在不再经过
 * shell，反引号是纯文本，不会被当成命令替换。
 *
 * @param {{updates?: Array, changedFiles?: string[], generatedAt?: string, today?: string}} [params]
 * @returns {string}
 */
export function buildPullRequestBody({ updates = [], changedFiles = [], generatedAt, today = '' } = {}) {
  const parts = [];
  const list = Array.isArray(updates) ? updates.filter(u => u && u.app) : [];

  if (list.length > 0) {
    const stamp = generatedAt || new Date().toISOString();
    parts.push('## 自动检测到的新版本', '', `检测时间：\`${stamp}\``, '');

    // updates.json 是"每个版本目录一条"（同一 app 会有多条），
    // 这里按 app 聚合，避免 PR body 里出现十几个重复的 "### anirss" 标题。
    const byApp = new Map();
    for (const u of list) {
      if (!byApp.has(u.app)) byApp.set(u.app, []);
      byApp.get(u.app).push(u);
    }

    for (const [app, entries] of byApp) {
      parts.push(`### ${app}`, '');
      parts.push('| service | image | before | after |');
      parts.push('|---------|-------|--------|-------|');
      const seen = new Set();
      for (const u of entries) {
        for (const svc of u.services || []) {
          const key = `${svc.name}|${svc.repo}|${svc.from}|${svc.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          parts.push(`| ${svc.name} | ${svc.repo} | \`${svc.from}\` | \`${svc.to}\` |`);
        }
      }
      parts.push('');
    }

    parts.push('## 修改文件', '');
    for (const f of changedFiles || []) {
      if (f) parts.push(`- \`${f}\``);
    }
    parts.push('');
  } else {
    parts.push(`自动更新 ${today}`, '');
  }

  parts.push(
    '---',
    '🤖 由 `.github/workflows/auto-update.yml` 自动生成；**仅在必需检查全部通过后**才会自动合并。',
    '',
  );
  return parts.join('\n');
}

/**
 * 构造自动更新 PR 的标题
 *
 * ⚠️ **绝不能**包含 `[skip ci]` 之类的 skip 指令：GitHub 会据此跳过该 PR 的
 * `pull_request` workflow，导致必需检查永远不出现、合并门禁永远超时。
 *
 * @param {{today: string}} params
 * @returns {string}
 */
export function buildPullRequestTitle({ today }) {
  return `chore(deps): auto-update ${today}`;
}

/**
 * 构造 commit message（拆成 subject / body 两段，交给 `git commit -m`）
 * 旧实现把 "\n" 写进 shell 双引号里，git 收到的是**字面量** \n（不是换行）。
 *
 * ⚠️ **绝不能**在 commit message / PR title 里放 `[skip ci]` 之类 skip 指令：
 *    GitHub 对 `pull_request` 事件判定的是 **PR 的 HEAD commit message**——
 *    skip 指令会让自动更新 PR 的 `pull_request` workflow 整体被跳过，
 *    于是「必需检查」永远不会出现，`waitForChecks` 只能超时 → PR 永远无法自动合并
 *    （GitHub 文档：skip 指令命中时检查会停留在 Pending，受保护的 PR 无法合并）。
 *    合并后的「push 递归触发」由工作流 `on.push.paths` 过滤防住
 *    （push 只对 `.github/**` 等自动更新链路自身文件触发，应用配置 / README 不在其中），
 *    因此不需要 skip 指令。
 *
 * @param {{today: string}} params
 * @returns {{subject: string, body: string}}
 */
export function buildCommitMessage({ today }) {
  return {
    subject: `chore(deps): auto-update ${today}`,
    body: [
      '本批次自动检测到的更新（含 README 同步）。',
      '',
      // 说明合并门禁，便于人工 reviewing 时理解为什么 PR 不会立刻合并
      '仅在必需 GitHub Checks 全部通过后由 workflow 自动合并。',
      '',
      '🤖 Generated by .github/workflows/auto-update.yml',
    ].join('\n'),
  };
}
