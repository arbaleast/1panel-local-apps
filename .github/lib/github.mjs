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
 * 创建 GitHub REST 客户端
 * @param {{token: string, baseUrl?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {{request: Function, listOpenPullRequests: Function, createPullRequest: Function,
 *            mergePullRequest: Function, deleteBranch: Function}}
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

  return { request, listOpenPullRequests, createPullRequest, mergePullRequest, deleteBranch };
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

  parts.push('---', '🤖 由 `.github/workflows/auto-update.yml` 自动生成并自动合并。', '');
  return parts.join('\n');
}

/**
 * 构造 commit message（拆成 subject / body 两段，交给 `git commit -m`）
 * 旧实现把 "\n" 写进 shell 双引号里，git 收到的是**字面量** \n（不是换行）。
 *
 * @param {{today: string}} params
 * @returns {{subject: string, body: string}}
 */
export function buildCommitMessage({ today }) {
  return {
    subject: `chore(deps): auto-update ${today}`,
    // [skip ci] 放 body 首行：GitHub Actions 按整条 commit message 判定跳过
    body: [
      '[skip ci]',
      '',
      '本批次自动检测到的更新（含 README 同步）。',
      '',
      '🤖 Generated by .github/workflows/auto-update.yml',
    ].join('\n'),
  };
}
