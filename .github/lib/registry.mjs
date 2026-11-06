// lib/registry.mjs — Registry 传输层（认证 / 分页 / 超时 / 重试 / 去重 / 并发）
//
// ── 分层（审计收敛后的唯一事实来源）──────────────────────────────────────
//   lib/image-ref.mjs  镜像引用解析（**唯一**解析实现）
//   lib/version.mjs    版本分类与选型（**唯一**版本引擎）
//   lib/registry.mjs   本模块：**只负责传输** —— 取回上游 tag 列表
//
// ⚠️ 旧实现在本文件内联了「4 级形态级联 + 全局 pickLatest 回退」。
//    那段回退**忽略当前轨道**，直接导致 postgres:16-alpine 被降级为 9.6.24、
//    rabbitmq:3-management 被改写为 3.13.7（详见 docs/postmortems.md 的同类事故）。
//    现在选型一律委托给 version.mjs 的 selectCandidate：同轨道才可比，
//    跨轨道一律拒绝（宁缺毋滥）。

import { parseImageReference } from './image-ref.mjs';
import { selectCandidate, isNonVersionTag } from './version.mjs';
import { extractPlatforms, extractConfigDigest, extractImageConfig, toRepoArch } from './manifest.mjs';

// 默认请求超时（~30s）。测试可通过构造参数注入更短的超时。
const DEFAULT_TIMEOUT_MS = 30000;

// 默认重试策略（审计 P2-3：旧实现对 429 / 5xx / 网络抖动**一次都不重试**，
// 可恢复故障被固化成整轮红）。
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 4000;
/** Retry-After 允许的最大等待（防止被上游指示卡死整轮检测） */
const MAX_RETRY_AFTER_MS = 30000;

// ── Registry 端点（可用环境变量覆盖，供**离线** E2E 测试指向本地 mock）──────
// 与 lib/github.mjs 的 GITHUB_API_BASE 同一套注入约定（见 .github/lib/pr-flow-e2e.test.mjs）。
export const DOCKERHUB_API_BASE = () => process.env.DOCKERHUB_API_BASE || 'https://hub.docker.com';
export const GHCR_API_BASE = () => process.env.GHCR_API_BASE || 'https://ghcr.io';

// 全局并发上限（防止同时打满 registry / 触发限流）
const DEFAULT_MAX_CONCURRENCY = 4;

/** 默认 sleep（可注入，便于 node:test 断言重试次数而不真的等待） */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 指数退避延迟计算（纯函数，便于单测）
 * @param {number} attempt 第几次尝试（0 起）
 * @param {{baseDelayMs?: number, maxDelayMs?: number}} [opts]
 * @returns {number}
 */
export function computeRetryDelay(attempt, { baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS, maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS } = {}) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
}

/**
 * 判断一个 HTTP 状态码是否**值得重试**
 *
 * · 429（限流）→ 重试
 * · 5xx（服务端错误）→ 重试
 * · 404 / 4xx（客户端错误）→ **不重试**（重试也不会变好，只会浪费时间）
 *
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  if (status === 429) return true;
  return typeof status === 'number' && status >= 500 && status <= 599;
}

/**
 * 解析 `Retry-After` 响应头（秒数或 HTTP-date 两种形态）。
 *
 * @param {string|null|undefined} value
 * @param {number} [nowMs]
 * @returns {number|null} 毫秒；无法解析返回 null
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(raw) * 1000);
  }
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return null;
  const delta = ts - nowMs;
  if (delta <= 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, delta);
}

/**
 * 带重试与指数退避的 fetch
 *
 * 语义：
 *   · 2xx → 直接返回 Response
 *   · 429 / 5xx → 退避后重试；重试耗尽 → **返回最后一个 Response**（由调用方抛带 status 的错误）
 *   · 404 及其它 4xx → 立即返回 Response（不重试）
 *   · 网络异常 → 退避后重试；重试耗尽 → 抛出最后一次异常
 *   · 429 带 `Retry-After` 头时优先遵从上游指定的等待时间（上限 30s）
 *
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} [opts]
 * @param {{retries?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: Function}} [retry]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(
  fetchImpl,
  url,
  opts = {},
  { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS, maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS, sleep = defaultSleep } = {},
) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, opts);
    } catch (e) {
      lastError = e;
      if (attempt === retries) throw e;
      await sleep(computeRetryDelay(attempt, { baseDelayMs, maxDelayMs }));
      continue;
    }
    if (res && res.ok) return res;
    if (!isRetryableStatus(res && res.status)) return res; // 4xx 不重试
    if (attempt === retries) return res; // 重试耗尽 → 交给调用方报错
    const retryAfter = parseRetryAfter(res?.headers?.get?.('retry-after'));
    const delay = retryAfter !== null
      ? retryAfter
      : computeRetryDelay(attempt, { baseDelayMs, maxDelayMs });
    await sleep(delay);
  }
  if (lastError) throw lastError;
  throw new Error(`Registry 请求失败: ${url}`);
}

/**
 * 校验上游响应形状：**字段缺失 / 类型不对 → 抛错**
 *
 * 审计 P1-1：旧实现用 `data?.results ?? []` / `data?.tags ?? []` ——
 * 上游返回 HTTP 200 但结构异常（字段改名 / 错误体 / 空对象）时被静默归一为
 * 「空 tag 列表」→ detect 判成 success + no-update（"已是最新"）→ **漏检且 CI 绿灯**。
 * 与「请求成功但确实没有稳定 tag」（返回 null）严格区分。
 *
 * @param {unknown} data 上游 JSON
 * @param {'dockerhub'|'ghcr'} kind
 * @param {string} url
 * @returns {string[]} 解析出的 tag 名数组（DockerHub 是 results 对象的 name 字段）
 * @throws {RegistryRequestError} 字段缺失或不是数组
 */
export function assertTagArray(data, kind, url) {
  const field = kind === 'dockerhub' ? 'results' : 'tags';
  const arr = data && typeof data === 'object' ? data[field] : undefined;
  if (!Array.isArray(arr)) {
    const actual = arr === undefined ? '缺失' : Array.isArray(arr) ? '非数组' : typeof arr;
    throw new RegistryRequestError(
      `Registry 响应结构异常：期望 ${field} 为数组，实际为 ${actual}（${kind}）`,
      { url },
    );
  }
  if (kind === 'dockerhub') {
    // DockerHub 的 results 是对象数组，每项必须带字符串 name
    return arr.map(t => {
      if (!t || typeof t !== 'object' || typeof t.name !== 'string') {
        throw new RegistryRequestError(
          `Registry 响应结构异常：results 条目缺少字符串 name 字段（${kind}）`,
          { url },
        );
      }
      return { name: t.name };
    });
  }
  return arr.filter(t => typeof t === 'string');
}

/**
 * Registry 请求失败错误。
 *
 * 语义（task-2）：网络异常 / HTTP 非 2xx / JSON 解析失败 / 翻页中途失败
 * 一律抛此错误，**禁止**吞成 null。只有"请求成功但没有可用稳定 tag"
 * 或 "选型无可用候选" 才返回 null。
 */
export class RegistryRequestError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, url?: string, cause?: unknown, partial?: { page: number, tags: number } }} [info]
   */
  constructor(message, { status, url, cause, partial } = {}) {
    super(message);
    this.name = 'RegistryRequestError';
    this.status = status;
    this.url = url;
    if (cause !== undefined) this.cause = cause;
    if (partial !== undefined) this.partial = partial;
  }
}

/**
 * 给翻页失败补充"已拿到多少 tag"的诊断信息。
 *
 * 动机（task-2）：GHCR 的 tags/list 返回顺序是 **字典序**（不是"最新在前"），
 * 第一页装的是**最旧**的 tag。翻页中途失败时若静默沿用半截数据算"最新版本"，
 * 必然选到远古版本——这正是 AGENTS.md 记录的 traefik 3.0.3 事故。
 * 因此翻页失败必须抛错，同时把"第几页失败 / 已经拿到多少 tag"附在错误上，
 * 供调用方（detect-updates.mjs）写进失败日志。
 *
 * @param {unknown} err
 * @param {number} page 当前页号（从 1 开始）
 * @param {number} tags 已累计拿到的 tag 数量
 * @returns {Error}
 */
function withPartial(err, page, tags) {
  if (err instanceof RegistryRequestError) {
    if (err.partial === undefined) {
      err.partial = { page, tags };
    }
    return err;
  }
  const wrapped = new RegistryRequestError(
    `Registry 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    { url: undefined, cause: err },
  );
  wrapped.partial = { page, tags };
  return wrapped;
}

// ───────────────────────────────────────────────────────────────────────────
// 镜像解析（薄封装：唯一实现位于 lib/image-ref.mjs）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 解析镜像字符串，返回**兼容旧契约**的结构化信息。
 *
 * ⚠️ 这是 lib/image-ref.mjs 的薄封装 —— 真正的解析逻辑只有一份。
 *    这里只做**字段形状**的向后兼容映射（旧契约用 `registry:'dockerhub'`
 *    而新契约用规范化的 `'docker.io'`，且缺失字段用 `undefined` 而非 `null`）。
 *
 * 形态覆盖：
 *   - 'nginx'                       → { registry: 'dockerhub', repo: 'nginx' }
 *   - 'nginx:1.25'                  → + tag
 *   - 'kragleer/anirss:v1.2.3'      → + tag
 *   - 'ghcr.io/org/repo:v1.2.3'     → { registry: 'ghcr.io' }
 *   - 'docker.io/library/nginx:1.25'→ { registry: 'dockerhub', repo: 'library/nginx' }
 *   - 'localhost:5000/app:1.0'      → { registry: 'localhost:5000', kind: 'custom' }
 *   - 'nginx@sha256:abc'            → + digest（无 tag）
 *   - 'nginx:1.25@sha256:abc'       → + tag + digest
 *
 * 非法输入（空串 / 含空白 / 含 '$' / repo 为空 / tag 为空）→ null
 *
 * @param {string} image 完整镜像字符串
 * @returns {{ registry: string, repo: string, tag?: string, digest?: string, kind: string }|null}
 */
export function parseImage(image) {
  const ref = parseImageReference(image);
  if (!ref) return null;
  return {
    registry: ref.source === 'dockerhub' ? 'dockerhub' : ref.registry,
    repo: ref.repo,
    tag: ref.tag === null ? undefined : ref.tag,
    digest: ref.digest === null ? undefined : ref.digest,
    kind: ref.source,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 请求去重（同一运行周期内复用同一仓库的 tag 列表）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 创建一个 tag 列表缓存（**显式注入**，不做隐式全局状态）。
 *
 * 动机（目标 §五.2）：一个仓库被多个应用 / 多个 service 引用时，
 * 旧实现会对同一 URL 反复请求，容易触发 registry 限流。
 *
 * 用法：调用方（detect-updates.mjs）创建一个实例并传给所有 adapter。
 * 单测不注入 → 行为与旧实现一致（每次都真请求）。
 *
 * @param {{ttlMs?: number}} [opts]
 */
export function createTagCache({ ttlMs = 5 * 60 * 1000 } = {}) {
  /** @type {Map<string, {promise: Promise<string[]>, at: number}>} */
  const entries = new Map();
  return {
    ttlMs,
    /**
     * 取（并登记）某仓库的 tag 列表 promise。
     * @param {string} key
     * @param {() => Promise<string[]>} factory
     * @returns {Promise<string[]>}
     */
    get(key, factory) {
      const hit = entries.get(key);
      const now = Date.now();
      if (hit && (now - hit.at) < ttlMs) return hit.promise;
      const promise = factory();
      entries.set(key, { promise, at: now });
      // 失败不缓存（否则一次网络抖动会毒化整轮检测）
      promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
      return promise;
    },
    /** 清空缓存 */
    clear() { entries.clear(); },
    /** 当前缓存条目数（诊断用） */
    get size() { return entries.size; },
  };
}

/**
 * 全局并发限流器（简单信号量）。
 * @param {number} limit
 */
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const acquire = () => new Promise(resolve => {
    if (active < limit) {
      active += 1;
      resolve();
      return;
    }
    queue.push(resolve);
  });
  const release = () => {
    const next = queue.shift();
    if (next) {
      // 槽位直接移交给下一个等待者（active 计数不变）
      next();
      return;
    }
    active -= 1;
  };
  return async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** 全局并发闸门（默认 4 并发） */
const globalLimiter = createLimiter(DEFAULT_MAX_CONCURRENCY);

// ───────────────────────────────────────────────────────────────────────────
// 适配器
// ───────────────────────────────────────────────────────────────────────────

/**
 * 适配器基类：承载**共用的传输 + 选型**逻辑。
 *
 * 子类只需实现 `fetchTags(repo)`（各自的 API 形态与分页方式不同）。
 */
class BaseAdapter {
  /**
   * @param {{
   *   fetchImpl?: Function,
   *   timeoutMs?: number,
   *   retries?: number,
   *   retryBaseDelayMs?: number,
   *   sleep?: Function,
   *   cache?: ReturnType<typeof createTagCache>,
   *   maxConcurrency?: number,
   * }} [opts]
   */
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS, sleep, cache = null, maxConcurrency = DEFAULT_MAX_CONCURRENCY } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.sleep = sleep;
    this.cache = cache;
    this.maxConcurrency = maxConcurrency;
    // 单适配器的并发闸门（可**收紧**全局上限；全局硬上限仍是 DEFAULT_MAX_CONCURRENCY）
    this.limiter = createLimiter(maxConcurrency);
  }

  /** 子类实现：取回某仓库的全部 tag 名 */
  // eslint-disable-next-line no-unused-vars
  async fetchTags(repo) {
    throw new Error('fetchTags 未实现');
  }

  /** 本适配器负责的 registry 判定 */
  // eslint-disable-next-line no-unused-vars
  matches(parsed) {
    return false;
  }

  canHandle(image) {
    const parsed = parseImageReference(image);
    return !!parsed && this.matches(parsed);
  }

  /**
   * 带超时 + 重试 + 并发限流的 fetch 包装
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<Response>}
   */
  async request(url, opts = {}) {
    const options = { ...opts };
    if (!options.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(this.timeoutMs);
    }
    // 两级闸门：全局硬上限（防打满 registry）+ 单适配器上限（可进一步收紧）
    try {
      return await globalLimiter(() => this.limiter(() => fetchWithRetry(this.fetchImpl, url, options, {
        retries: this.retries,
        baseDelayMs: this.retryBaseDelayMs,
        sleep: this.sleep || defaultSleep,
      })));
    } catch (e) {
      if (e instanceof RegistryRequestError) throw e;
      throw new RegistryRequestError(`Registry 请求失败: ${e.message}`, { url, cause: e });
    }
  }

  /**
   * 取回 tag 列表（带去重缓存）。
   * @param {string} repo
   * @returns {Promise<string[]>}
   */
  async fetchTagsCached(repo) {
    if (!this.cache) return this.fetchTags(repo);
    const key = `${this.constructor.adapterKey}:${repo}`;
    return this.cache.get(key, () => this.fetchTags(repo));
  }

  /**
   * 取回某镜像仓库的全部 tag（**传输层**对外接口）。
   *
   * 选型不放在这里 —— 由 lib/decision.mjs 统一负责（目标 §七）。
   *
   * @param {string} image 完整镜像字符串
   * @returns {Promise<string[]>}
   */
  async fetchAllTags(image) {
    const parsed = parseImageReference(image);
    if (!parsed) {
      throw new RegistryRequestError(`镜像字符串无法解析: ${image}`);
    }
    return this.fetchTagsCached(parsed.repo);
  }

  /**
   * 选型：同轨道内取最优候选（**唯一**实现入口）。
   *
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag
   * @returns {{tag:string|null, comparison:string, reason:string}}
   */
  async selectLatestTag(image, currentTag) {
    const parsed = parseImageReference(image);
    if (!parsed) {
      throw new RegistryRequestError(`镜像字符串无法解析: ${image}`);
    }
    // ⚠️ digest 锁定的镜像**不参与版本更新**：版本由摘要内容决定，不是 tag
    //    （目标 §六.2：不得把 digest 差异误判成应用版本差异）。
    if (parsed.digest) {
      return {
        tag: null,
        comparison: 'uncomparable',
        reason: `镜像由 digest 锁定（${parsed.digest}），不参与版本更新`,
      };
    }
    const all = await this.fetchTagsCached(parsed.repo);
    // 浮动 tag 不参与版本比较（latest / nightly / dev / edge / stable …）
    const stable = all.filter(t => typeof t === 'string' && !isNonVersionTag(t));
    if (stable.length === 0) {
      return { tag: null, comparison: 'uncomparable', reason: 'Registry 未返回可用的稳定 tag' };
    }
    // ⚠️ `currentTag === undefined`（调用方没给当前版本）与 `currentTag === 'latest'`
    //    （当前版本就是滚动 tag）是**两回事**：
    //      · 前者 → 无上下文模式，只在单一轨道内取最大（向后兼容旧契约）
    //      · 后者 → 显式拒绝（滚动 tag 不参与版本更新，目标 §七决策铁律）
    const selection = selectCandidate(currentTag === undefined ? null : currentTag, stable);
    return { tag: selection.tag, comparison: selection.comparison, reason: selection.reason };
  }

  /**
   * 获取最新稳定 tag（兼容旧契约：返回 tag 字符串或 null）。
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag
   * @returns {Promise<string|null>}
   */
  async getLatestTag(image, currentTag) {
    const selection = await this.selectLatestTag(image, currentTag);
    return selection.tag ?? null;
  }
}

/**
 * Docker Hub 适配器：查询 hub.docker.com 获取最新 tag
 */
export class DockerHubAdapter extends BaseAdapter {
  static adapterKey = 'dockerhub';

  constructor(opts = {}) {
    super(opts);
    // page_size=100 + 翻页兜底：anirss/handbrake/scrob/syncthing 等 hardcode 应用
    // 单个镜像 30+ tag（每个 semver 配多架构后缀），page_size=20 会把 arm32v7 等变体截断到 page 1 之外，
    // 导致同 suffix 匹配失败、arm32v7 变体永远不生成新版本目录（PR #19 复盘）。
    // 见 AGENTS.md "anirss 不更新根因复盘（2026-09-08）" 与本页注释。
    // 上限 5 页（500 tag）覆盖当前所有 known 应用（最大 scrob ~80 tag）。
    this.pageSize = 100;
    this.maxPages = 5;
  }

  matches(parsed) {
    return parsed.source === 'dockerhub';
  }

  /**
   * 拉取全部 tag（分页 + 形状校验 + 截断抛错）
   * @param {string} repo
   * @returns {Promise<string[]>}
   */
  async fetchTags(repo) {
    const baseUrl = `${DOCKERHUB_API_BASE()}/v2/repositories/${repo}/tags/?page_size=${this.pageSize}&ordering=last_updated`;
    const allResults = [];
    let nextUrl = baseUrl;
    for (let page = 0; page < this.maxPages && nextUrl; page++) {
      const currentPage = page + 1;
      let res;
      try {
        res = await this.request(nextUrl);
      } catch (e) {
        throw withPartial(e, currentPage, allResults.length);
      }

      if (!res.ok) {
        throw withPartial(
          new RegistryRequestError(
            `DockerHub 返回 HTTP ${res.status}`,
            { status: res.status, url: nextUrl },
          ),
          currentPage,
          allResults.length,
        );
      }

      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw withPartial(
          new RegistryRequestError(`DockerHub 响应 JSON 解析失败: ${e.message}`, {
            url: nextUrl,
            cause: e,
          }),
          currentPage,
          allResults.length,
        );
      }

      // 审计 P1-1：字段缺失 / 类型不对 → **抛错**（不再 `?? []` 静默归一为空列表）
      let results;
      try {
        results = assertTagArray(data, 'dockerhub', nextUrl);
      } catch (e) {
        throw withPartial(e, currentPage, allResults.length);
      }
      allResults.push(...results);

      // DockerHub 返回 next 为 null 时表示已到末页
      const next = data?.next;
      if (!next) {
        nextUrl = null; // 明确标记「已到末页」，避免被误判成翻页截断
        break;
      }
      nextUrl = next;
    }

    // 审计 P2-4：翻页达上限且仍有下一页 → **不能静默用半截数据**
    // （GHCR tag 是字典序，半截数据必然选到远古版本 → traefik 3.0.3 同型事故）
    if (nextUrl) {
      throw withPartial(
        new RegistryRequestError(
          `DockerHub 翻页达到上限（${this.maxPages} 页）仍有下一页，tag 列表不完整`,
          { url: nextUrl },
        ),
        this.maxPages,
        allResults.length,
      );
    }

    return allResults.map(t => t.name);
  }
}

/**
 * GitHub Container Registry 适配器：查询 ghcr.io OCI API 获取最新 tag
 */
export class GhcrAdapter extends BaseAdapter {
  static adapterKey = 'ghcr';

  constructor(opts = {}) {
    super(opts);
    // GHCR 的 tags/list 单页上限 n=1000，且返回顺序是 tag 字典序
    // （不是"最新在前"）。tag 总数超过 1000 的镜像（如 ghcr.io/traefik/traefik 有 2700+ 个，
    // 字典序前 1000 个只到 v2.0.0-alpha6-*）如果只取第一页，v3.x 这类较新 tag 根本不在
    // 候选集里。2026-11-01 auto-update 事故：本仓把 traefik 切到 ghcr 后，cron 检出 3.0.3 并
    // 生成了 traefik/3.0.3/ 版本目录（旧镜像）。修复：跟随 Link rel="next" 翻页。
    this.pageSize = 1000;
    this.maxPages = 10;
  }

  matches(parsed) {
    return parsed.source === 'ghcr';
  }

  /**
   * 获取匿名 pull token（不重试 —— 它只是可选优化，失败直接匿名降级）。
   *
   * ⚠️ token 只存在于请求头，**绝不**进入日志 / 错误消息。
   * @param {string} repo
   * @returns {Promise<string|null>}
   */
  async fetchAnonymousToken(repo) {
    try {
      const tokenUrl = `${GHCR_API_BASE()}/token?scope=repository:${repo}:pull`;
      const tokenOpts = {};
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        tokenOpts.signal = AbortSignal.timeout(this.timeoutMs);
      }
      const tokenRes = await this.fetchImpl(tokenUrl, tokenOpts);
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        return tokenData?.token ?? null;
      }
    } catch (_) {
      // token 获取失败，降级为匿名调用
    }
    return null;
  }

  /**
   * 拉取全部 tag（Bearer token + Link 头分页）
   * @param {string} repo
   * @returns {Promise<string[]>}
   */
  async fetchTags(repo) {
    const token = await this.fetchAnonymousToken(repo);

    // 构建请求头
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const allTags = [];
    let nextUrl = `${GHCR_API_BASE()}/v2/${repo}/tags/list?n=${this.pageSize}`;
    for (let page = 0; page < this.maxPages && nextUrl; page++) {
      const currentPage = page + 1;
      let res;
      try {
        res = await this.request(nextUrl, { headers });
      } catch (e) {
        throw withPartial(e, currentPage, allTags.length);
      }

      if (!res.ok) {
        throw withPartial(
          new RegistryRequestError(
            `GHCR 返回 HTTP ${res.status}`,
            { status: res.status, url: nextUrl },
          ),
          currentPage,
          allTags.length,
        );
      }

      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw withPartial(
          new RegistryRequestError(`GHCR 响应 JSON 解析失败: ${e.message}`, {
            url: nextUrl,
            cause: e,
          }),
          currentPage,
          allTags.length,
        );
      }
      // 审计 P1-1：字段缺失 / 类型不对 → **抛错**（不再 `?? []` 静默归一为空列表）
      let tags;
      try {
        tags = assertTagArray(data, 'ghcr', nextUrl);
      } catch (e) {
        throw withPartial(e, currentPage, allTags.length);
      }
      allTags.push(...tags);

      // Link: </v2/<repo>/tags/list?last=<tag>&n=1000>; rel="next"
      const link = res.headers?.get?.('link') ?? '';
      const next = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
      nextUrl = next ? (next[1].startsWith('http') ? next[1] : `${GHCR_API_BASE()}${next[1]}`) : null;
    }

    // 审计 P2-4：翻页达上限且仍有下一页 → **不能静默用半截数据**
    if (nextUrl) {
      throw withPartial(
        new RegistryRequestError(
          `GHCR 翻页达到上限（${this.maxPages} 页）仍有下一页，tag 列表不完整`,
          { url: nextUrl },
        ),
        this.maxPages,
        allTags.length,
      );
    }

    return [...new Set(allTags)];
  }
}

/**
 * 工厂函数：根据镜像名自动选择适配器
 *
 * 语义（task-2）：
 *   - 镜像字符串解析失败 → null
 *   - 不支持的 registry（如自建 harbor）→ null（**不得**误用 DockerHub API）
 *   - docker.io / 无前缀 → DockerHubAdapter；ghcr.io → GhcrAdapter
 *
 * @param {string} image
 * @param {{ fetchImpl?: Function, timeoutMs?: number, cache?: object, sleep?: Function, retries?: number }} [opts]
 * @returns {DockerHubAdapter|GhcrAdapter|null}
 */
export function createAdapter(image, opts = {}) {
  const parsed = parseImageReference(image);
  if (!parsed) return null;
  if (parsed.source === 'ghcr') {
    return new GhcrAdapter(opts);
  }
  if (parsed.source === 'dockerhub') {
    return new DockerHubAdapter(opts);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Manifest 能力（阶段 3：CPU 多架构兼容性核验）
//
// ⚠️ 边界：**只取 JSON 元数据，绝不 pull 镜像层**。
//    只请求 /manifests/<tag> 与 /blobs/<image-config digest>，
//    永远不会请求 /blobs/<layer digest>。
// ───────────────────────────────────────────────────────────────────────────

/** 拉取 manifest 所需的 Accept 头（OCI index + Docker manifest list + 两种单架构 manifest） */
export const MANIFEST_ACCEPT = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json';

/** Docker Hub registry 基址（可用环境变量覆盖，供离线测试指向本地 mock） */
const DOCKERHUB_REGISTRY_BASE = () => process.env.DOCKERHUB_REGISTRY_BASE || 'https://registry-1.docker.io';
/** Docker Hub token 端点 */
const DOCKERHUB_TOKEN_BASE = () => process.env.DOCKERHUB_TOKEN_BASE || 'https://auth.docker.io';

/**
 * manifest 拉取失败（内部异常载体）。
 *
 * 语义：对外一律转成 `status:'unverified'`，**不抛给调用方**；
 * 内部抛出只是为了让「失败不缓存」的缓存语义成立（promise reject → 缓存条目移除）。
 */
class ManifestFetchError extends Error {
  /**
   * @param {string} reason 人类可读原因
   * @param {{status?: number, url?: string, cause?: unknown}} [info]
   */
  constructor(reason, { status, url, cause } = {}) {
    super(reason);
    this.name = 'ManifestFetchError';
    this.reason = reason;
    if (status !== undefined) this.status = status;
    if (url !== undefined) this.url = url;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 创建一个 manifest 结果缓存（与 `createTagCache` 同构：**失败不缓存**）。
 *
 * 语义：
 *   · `get(key, factory)` → 命中返回同一个 promise；未命中则调用 factory 并登记
 *   · factory **reject**（拉取失败）→ 该条目立即移除，下次会重新请求
 *     （一次网络抖动不能毒化整轮核验）
 *   · `clear()` 清空；`size` 当前条目数
 *
 * @param {{ttlMs?: number}} [opts]
 * @returns {{ttlMs: number, get: Function, clear: Function, size: number}}
 */
export function createManifestCache({ ttlMs = 10 * 60 * 1000 } = {}) {
  /** @type {Map<string, {promise: Promise<unknown>, at: number}>} */
  const entries = new Map();
  return {
    ttlMs,
    /**
     * 取（并登记）某 key 的 manifest 结果 promise。
     * @param {string} key
     * @param {() => Promise<unknown>} factory
     * @returns {Promise<unknown>}
     */
    get(key, factory) {
      const hit = entries.get(key);
      const now = Date.now();
      if (hit && (now - hit.at) < ttlMs) return hit.promise;
      const promise = factory();
      entries.set(key, { promise, at: now });
      // 失败不缓存（否则一次网络抖动会毒化整轮核验）
      promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
      return promise;
    },
    /** 清空缓存 */
    clear() { entries.clear(); },
    /** 当前缓存条目数（诊断用） */
    get size() { return entries.size; },
  };
}

/**
 * 依据 registry 来源给出 token / manifest / blob 三个端点。
 *
 * @param {{source: string, repoPath: string}} ctx
 * @returns {{tokenUrl: string, manifestUrl: string, blobUrl: (digest: string) => string}}
 */
function manifestEndpoints({ source, repoPath }) {
  if (source === 'ghcr') {
    const base = GHCR_API_BASE();
    return {
      tokenUrl: `${base}/token?scope=repository:${repoPath}:pull&service=ghcr.io`,
      manifestUrl: `${base}/v2/${repoPath}/manifests/`,
      blobUrl: (digest) => `${base}/v2/${repoPath}/blobs/${digest}`,
    };
  }
  const base = DOCKERHUB_REGISTRY_BASE();
  return {
    tokenUrl: `${DOCKERHUB_TOKEN_BASE()}/token?service=registry.docker.io&scope=repository:${repoPath}:pull`,
    manifestUrl: `${base}/v2/${repoPath}/manifests/`,
    blobUrl: (digest) => `${base}/v2/${repoPath}/blobs/${digest}`,
  };
}

/**
 * 轻量拉取镜像 tag 的 manifest（**只取 JSON 元数据，绝不 pull 镜像层**）。
 *
 * 行为：
 *   · 多架构 index（manifest list）→ 返回平台集合（来自 `manifests[].platform`）
 *   · 单架构 manifest → 再取一次 image config blob，给出平台与默认运行身份
 *   · 任何失败（401/403/404/其它非 2xx/网络异常/JSON 解析失败/不支持的 registry）
 *     → 返回 `status:'unverified'` 并给出原因，**不抛错**
 *
 * ⚠️ `digest` 取的是响应头 `docker-content-digest`，即 **index digest**，
 *    **不是**子 manifest 的 digest（见 lib/manifest.mjs 文件头说明）。
 *
 * @param {string} image 完整镜像引用（repo:tag）
 * @param {{fetchImpl?: Function, timeoutMs?: number, retries?: number, sleep?: Function, cache?: object, maxConcurrency?: number}} [opts]
 * @returns {Promise<{
 *   status: 'ok'|'unverified',
 *   kind?: 'index'|'manifest',
 *   platforms?: string[],
 *   rawPlatforms?: Array<object>,
 *   digest?: string|null,
 *   configDigest?: string|null,
 *   imageConfig?: {os: string|null, architecture: string|null, variant: string|null, user: string|null, env: string[]}|null,
 *   mediaType?: string|null,
 *   reason?: string,
 * }>}
 */
export async function fetchManifest(image, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    sleep,
    cache = null,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  } = opts;

  const parsed = parseImageReference(image);
  if (!parsed) {
    return { status: 'unverified', reason: `镜像引用无法解析: ${image}` };
  }
  if (parsed.source === 'custom') {
    return { status: 'unverified', reason: `不支持的 registry（${parsed.registry}）：仅支持 DockerHub 与 GHCR` };
  }
  if (!parsed.tag) {
    return { status: 'unverified', reason: `镜像未指定 tag，无法定位 manifest: ${image}` };
  }

  // registry 路径：DockerHub 官方镜像需补 library/ 命名空间
  const repoPath = parsed.namespace ? `${parsed.namespace}/${parsed.repository}` : parsed.repository;
  const key = `${parsed.registry}/${parsed.repo}:${parsed.tag}`;

  const limiter = createLimiter(maxConcurrency);
  const request = async (url, headers) => {
    const options = { headers };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(timeoutMs);
    }
    try {
      return await globalLimiter(() => limiter(() => fetchWithRetry(fetchImpl, url, options, {
        retries,
        sleep: sleep || defaultSleep,
      })));
    } catch (e) {
      throw new ManifestFetchError(`请求失败：${e instanceof Error ? e.message : String(e)}`, { url, cause: e });
    }
  };

  /** 取匿名 pull token（失败降级为不带 Authorization 匿名访问） */
  const fetchToken = async (tokenUrl) => {
    try {
      const res = await request(tokenUrl, {});
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data?.token === 'string' && data.token !== '' ? data.token : null;
    } catch (_) {
      return null; // token 获取失败 → 降级匿名
    }
  };

  const doFetch = async () => {
    const { tokenUrl, manifestUrl, blobUrl } = manifestEndpoints({ source: parsed.source, repoPath });
    const token = await fetchToken(tokenUrl);

    const buildHeaders = (withToken) => {
      const headers = { Accept: MANIFEST_ACCEPT };
      if (withToken && token) headers.Authorization = `Bearer ${token}`;
      return headers;
    };

    const url = `${manifestUrl}${parsed.tag}`;
    let res = await request(url, buildHeaders(true));

    // 拿到 token 仍被拒（401/403）→ 退回匿名再试一次
    if (token && (res.status === 401 || res.status === 403)) {
      res = await request(url, buildHeaders(false));
    }

    if (res.status === 401 || res.status === 403) {
      throw new ManifestFetchError(`registry 拒绝访问（HTTP ${res.status}）`, { status: res.status, url });
    }
    if (res.status === 404) {
      throw new ManifestFetchError(`registry 未找到该 tag（HTTP 404）`, { status: 404, url });
    }
    if (!res.ok) {
      throw new ManifestFetchError(`registry 返回 HTTP ${res.status}`, { status: res.status, url });
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new ManifestFetchError(`manifest JSON 解析失败：${e instanceof Error ? e.message : String(e)}`, { url, cause: e });
    }

    const digest = res.headers?.get?.('docker-content-digest') ?? null;
    const mediaType = res.headers?.get?.('content-type') ?? null;
    const platforms = extractPlatforms(body);

    if (platforms.kind === 'index') {
      return {
        status: 'ok',
        kind: 'index',
        platforms: platforms.platforms,
        rawPlatforms: platforms.rawPlatforms,
        digest,
        configDigest: extractConfigDigest(body),
        imageConfig: null,
        mediaType,
      };
    }

    // 单架构 manifest：架构信息在 image config 里 → 再取一次 config blob
    const configDigest = extractConfigDigest(body);
    let imageConfig = null;
    let archPlatforms = [];
    if (configDigest) {
      try {
        const blobRes = await request(blobUrl(configDigest), buildHeaders(true));
        if (blobRes.ok) {
          const configBody = await blobRes.json();
          imageConfig = extractImageConfig(configBody);
          const repoArch = toRepoArch(imageConfig);
          archPlatforms = repoArch ? [repoArch] : [];
        }
      } catch (_) {
        // config blob 取不到 → 仍然算成功，只是平台信息未知
        imageConfig = null;
        archPlatforms = [];
      }
    }

    return {
      status: 'ok',
      kind: 'manifest',
      platforms: archPlatforms,
      rawPlatforms: [],
      digest,
      configDigest,
      imageConfig,
      mediaType,
    };
  };

  try {
    if (cache) {
      return await cache.get(key, doFetch);
    }
    return await doFetch();
  } catch (e) {
    if (e instanceof ManifestFetchError) {
      return { status: 'unverified', reason: e.reason };
    }
    return { status: 'unverified', reason: e instanceof Error ? e.message : String(e) };
  }
}
