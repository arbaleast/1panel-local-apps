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
 *
 * 注意：`skipped` / `neutral` 的处理**依赖该检查是否必需**（见 waitForChecks 内注释）：
 *   · **必需检查**被 skipped/neutral → 未满足合并条件 → 判失败（目标 §六.3）
 *   · **非必需检查**被 skipped/neutral → 中性，不阻断
 *     （GitHub 会把被自身 `if:` 跳过的 job 也记成一条 check run，
 *      本仓写操作 job 在 `pull_request` 事件下必然被跳过 → 目标 PR 上恒有一条）
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
 * 自动更新 PR 的**分支前缀**（识别自动更新 PR 的唯一依据）
 *
 * 审计 P2-9：旧实现靠 PR title 前缀字符串识别「重复批次 PR」，人工 PR 只要
 * 标题撞上就会被误判。这里改用**分支前缀**——只有 `auto-update/` 开头的分支
 * 才是自动更新产物，人工分支（feat/fix/docs/...）永远不会被认领、覆盖或关闭。
 */
export const AUTO_UPDATE_BRANCH_PREFIX = 'auto-update/';

/**
 * 目标 PR 上**必须**通过的检查（默认清单）
 *
 * 审计 P0-1（核心红线）：旧实现的 waitForChecks 只要求「该 SHA 上至少有一个
 * check run 且全部成功」，**完全没有校验「仓库配置的必需检查是否已经出现」**。
 * 结果：只要 SHA 上存在任何一个**无关的**成功 check run（例如第三方 App、
 * 或路径过滤导致本仓 workflow 未触发的历史 check），就会判定 success →
 * 直接进入 mergePullRequest → **提前合并未经验证的 PR**。
 *
 * 现在必须**逐个**确认 requiredChecks 里的检查已经出现且 completed+success；
 * 缺失任何一个都视为「未满足合并条件」，继续等待直至超时，绝不合并。
 *
 * 名称必须与 auto-update.yml 里 validate job 的 `name:` 完全一致；
 * workflow.test.mjs 会锁定两者一致，改名时不会漏改。
 */
export const DEFAULT_REQUIRED_CHECKS = Object.freeze(['只读校验（单测 + 跨文件一致性 lint）']);


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
      // 审计 P2-10：**必须**把 HTTP 状态码写进 message —— 旧实现只带 GitHub 的
      // message 字段（如 "Validation Failed"），状态码 422/403/404 全部丢失，
      // 调用方只打印 e.message → 日志里看不到真正的失败原因。
      const apiMessage = (data && (data.message || data.error)) || '(无响应体)';
      const detail = data && data.errors ? ` ${JSON.stringify(data.errors)}` : '';
      throw new GitHubApiError(
        `GitHub API ${method} ${path} 失败: HTTP ${res.status} ${apiMessage}${detail}`,
        {
          status: res.status,
          method,
          path,
          details: data,
        },
      );
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
   * 读取单个 PR（用于重新确认 head SHA / 状态）
   * @param {{owner: string, repo: string, number: number}} params
   * @returns {Promise<object>}
   */
  async function getPullRequest({ owner, repo, number }) {
    return await request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  }

  /**
   * 找出**自动更新**产生的 open PR（按分支前缀识别，绝不碰人工 PR）
   *
   * 审计 P2-9：旧实现按 PR **标题前缀字符串**识别重复批次 PR → 人工 PR 撞标题
   * 就会被误判。这里只认 `head.ref` 以 `auto-update/` 开头的 PR。
   *
   * @param {{owner: string, repo: string, base?: string}} params
   * @returns {Promise<Array<object>>}
   */
  async function findAutoUpdatePullRequests({ owner, repo, base }) {
    const open = await listOpenPullRequests({ owner, repo });
    return open.filter(pr => {
      const headRef = pr && pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : '';
      if (!headRef.startsWith(AUTO_UPDATE_BRANCH_PREFIX)) return false;
      if (!base) return true;
      return pr.base && pr.base.ref ? pr.base.ref === base : true;
    });
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

  /**
   * 更新已有 PR 的标题 / 正文（幂等复用已有自动更新 PR 时使用）
   *
   * 只用于**自动更新分支**上的 PR（由 findAutoUpdatePullRequests 按分支前缀筛出），
   * 绝不用于人工 PR。
   *
   * @param {{owner: string, repo: string, number: number, title?: string, body?: string}} params
   * @returns {Promise<object>}
   */
  async function updatePullRequest({ owner, repo, number, title, body }) {
    const path = `/repos/${owner}/${repo}/pulls/${number}`;
    const payload = {};
    if (typeof title === 'string') payload.title = title;
    if (typeof body === 'string') payload.body = body;
    const data = await request('PATCH', path, payload);
    if (!data || typeof data.number !== 'number') {
      throw new GitHubApiError('GitHub API 更新 PR 未返回编号（number），判定为失败', {
        method: 'PATCH',
        path,
        details: data,
      });
    }
    return data;
  }

  /**
   * 合并 PR，返回 { merged, message }
   *
   * @param {object} params
   * @param {string} params.expectedHeadSha 期望合并的 head SHA（可选但强烈建议传入）：
   *   GitHub 在 head 已移动时返回 409，避免合并未经验证的提交。
   */
  async function mergePullRequest({ owner, repo, number, mergeMethod = 'merge', expectedHeadSha }) {
    const path = `/repos/${owner}/${repo}/pulls/${number}/merge`;
    const body = { merge_method: mergeMethod };
    // sha 护栏：只允许合并「等待检查的那个 head SHA」。
    // 若等待期间 PR head 被再次推送，GitHub 返回 409（Head branch was modified），
    // 从而杜绝「合并未经验证的新提交」。
    if (expectedHeadSha) body.sha = expectedHeadSha;
    const data = await request('PUT', path, body);
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
   *   · `timeout` —— 超时仍有检查在跑，或**始终没有出现任何 check run**，
   *                   或**必需检查始终没有出现**；
   *   · `unknown` —— API 调用本身失败（网络错误 / 非 2xx），或未配置必需检查；
   *   · `sha-changed` —— 等待期间 PR 的 head SHA 变了（由 resolveHeadSha 检测）。
   *
   * `now` / `sleep` 可注入，便于单测（不依赖真实定时器）。
   *
   * @param {{owner: string, repo: string, ref: string, requiredChecks?: string[],
   *          timeoutMs?: number, intervalMs?: number,
   *          now?: () => number, sleep?: (ms: number) => Promise<void>,
   *          resolveHeadSha?: () => Promise<string|null>}} params
   * @returns {Promise<{status: 'success'|'failure'|'timeout'|'unknown'|'sha-changed',
   *                    checks: Array<{name: string, status: string, conclusion: string|null}>,
   *                    missing?: string[], currentSha?: string|null, error?: string}>}
   */
  async function waitForChecks({
    owner,
    repo,
    ref,
    requiredChecks = DEFAULT_REQUIRED_CHECKS,
    timeoutMs = 1800000,
    intervalMs = 30000,
    now = () => Date.now(),
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    resolveHeadSha = null,
  }) {
    const start = now();
    let checks = [];

    // 审计 P0-1：没有必需检查清单就**无法判定"必需检查已通过"** →
    // 直接 unknown，绝不返回 success（否则又回到"任意一个成功 check 就能合并"的漏洞）。
    const required = Array.isArray(requiredChecks)
      ? requiredChecks.map(c => String(c).trim()).filter(Boolean)
      : [];
    if (required.length === 0) {
      return {
        status: 'unknown',
        checks,
        error: '未配置必需检查（requiredChecks），无法判定目标 PR 的必需检查是否通过 → 拒绝合并',
      };
    }

    // 最多轮询到超时（每轮至少 sleep 一次，保证 now 能推进）
    for (;;) {
      // 审计 P2-11：等待期间 PR 可能被再次推送 → head SHA 变化 → 旧 SHA 的检查结论作废。
      if (typeof resolveHeadSha === 'function') {
        let currentSha = null;
        try {
          currentSha = await resolveHeadSha();
        } catch (e) {
          return { status: 'unknown', checks, error: `读取 PR 最新 head SHA 失败: ${e.message}` };
        }
        if (currentSha && currentSha !== ref) {
          return { status: 'sha-changed', checks, currentSha };
        }
      }

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
      //
      //    `skipped` / `neutral` 需要**分必需性**处理（2026-11 实况修正）：
      //    GitHub 会把「被自身 `if:` 条件跳过」的 job 也记成一条 check run，
      //    conclusion = 'skipped'。本仓 auto-update.yml 的写操作 job 在
      //    `pull_request` 事件下必然被 `if:` 跳过 → 目标 PR 的 head SHA 上
      //    **必然**存在一条 skipped 的「检测镜像更新并开 PR」check。
      //    若把 skipped 一律当失败，自动更新 PR 将**永远**无法通过合并门禁
      //    （表现为门禁恒超时 / 判 failure）。
      //    正确语义：
      //      · **必需检查**被 skipped/neutral → 未满足合并条件 → 判 failure（目标 §六.3）
      //      · **非必需检查**被 skipped/neutral → 中性（例如被 `if:` 跳过的写操作 job）
      //        → 不阻断
      for (const c of checks) {
        const conclusion = c.conclusion;
        if (!conclusion) continue;
        if (conclusion === 'skipped' || conclusion === 'neutral') {
          if (required.includes(c.name)) {
            return { status: 'failure', checks, missing: [c.name] };
          }
          continue;
        }
        if (FAILING_CONCLUSIONS.has(conclusion)) {
          return { status: 'failure', checks };
        }
      }
      // 2) 合并 commit status 失败 → 判定失败
      if (combined && combined.state === 'failure') {
        return { status: 'failure', checks };
      }

      // 3) 全部通过 —— 且**每一个必需检查都必须已经出现**（审计 P0-1 核心）
      //    「绿」的判定：必需检查必须 completed + success；
      //    非必需检查允许 completed + success，或被 `if:` 跳过（skipped/neutral）。
      const isGreen = (c) => {
        if (c.status !== 'completed') return false;
        if (c.conclusion === 'success') return true;
        return (
          (c.conclusion === 'skipped' || c.conclusion === 'neutral') &&
          !required.includes(c.name)
        );
      };
      const allPassed = checks.length > 0 && checks.every(isGreen);
      const combinedPending = combined && combined.state === 'pending';
      const missing = required.filter(name => !checks.some(c => c.name === name));
      const requiredNotGreen = required.filter(name => {
        const c = checks.find(x => x.name === name);
        return !c || c.status !== 'completed' || c.conclusion !== 'success';
      });
      if (allPassed && !combinedPending && missing.length === 0 && requiredNotGreen.length === 0) {
        return { status: 'success', checks, missing: [] };
      }

      // 4) 超时（检查仍在跑、始终没有出现任何 check run、或必需检查始终没有出现）
      if (now() - start >= timeoutMs) {
        const stillMissing = required.filter(name => !checks.some(c => c.name === name));
        return {
          status: 'timeout',
          checks,
          missing: stillMissing,
          error:
            stillMissing.length > 0
              ? `超时：必需检查未出现（${stillMissing.join(', ')}）`
              : '超时：检查仍未跑完',
        };
      }

      await sleep(intervalMs);
    }
  }

  return {
    request,
    listOpenPullRequests,
    getPullRequest,
    findAutoUpdatePullRequests,
    createPullRequest,
    updatePullRequest,
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
