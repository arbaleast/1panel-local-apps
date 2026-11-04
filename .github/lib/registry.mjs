// lib/registry.mjs — 镜像解析与版本适配器
import { pickLatest } from './semver.mjs';

// 默认请求超时（~30s）。测试可通过构造参数注入更短的超时。
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Registry 请求失败错误。
 *
 * 语义（task-2）：网络异常 / HTTP 非 2xx / JSON 解析失败 / 翻页中途失败
 * 一律抛此错误，**禁止**吞成 null。只有"请求成功但没有可用稳定 tag"
 * 或 "pickLatest 返回 null" 才返回 null。
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

/**
 * 解析镜像字符串，返回结构化信息
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
  if (typeof image !== 'string') return null;
  // 前后空白 / 内部空白 → 非法（compose 模板里出现空白说明拼接出错）
  if (image.trim() !== image) return null;
  if (image.length === 0) return null;
  if (/[\s$]/.test(image)) return null;
  if (image.includes('?') || image.includes('#')) return null;

  let base = image;
  let digest;
  const atIdx = image.indexOf('@');
  if (atIdx !== -1) {
    digest = image.slice(atIdx + 1);
    base = image.slice(0, atIdx);
    if (!/^[A-Za-z0-9_+.-]+:[A-Za-z0-9]+$/.test(digest)) return null;
  }

  // registry 前缀：首个路径段含 '.' 或 ':'，或等于 localhost
  let registryHost = null;
  let rest = base;
  const firstSlash = base.indexOf('/');
  if (firstSlash !== -1) {
    const first = base.slice(0, firstSlash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registryHost = first;
      rest = base.slice(firstSlash + 1);
    }
  }

  // tag：最后一个 ':' 必须出现在最后一个 '/' 之后（否则是 registry 端口）
  let tag;
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!tag) return null;
  }

  // repo 校验
  if (!rest) return null;
  if (rest.startsWith('/') || rest.endsWith('/')) return null;
  if (rest.includes('//')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(rest)) return null;

  // registry 归一
  let registry;
  let kind;
  if (registryHost === null) {
    registry = 'dockerhub';
    kind = 'dockerhub';
  } else if (registryHost === 'docker.io' || registryHost === 'index.docker.io' || registryHost === 'registry-1.docker.io') {
    registry = 'dockerhub';
    kind = 'dockerhub';
  } else if (registryHost === 'ghcr.io') {
    registry = 'ghcr.io';
    kind = 'ghcr';
  } else {
    registry = registryHost;
    kind = 'custom';
  }

  return { registry, repo: rest, tag, digest, kind };
}

/**
 * 判断镜像是否带 tag（不含 digest 也不算 tag）
 * @param {{tag?: string}} parsed
 */
function hasTag(parsed) {
  return typeof parsed.tag === 'string' && parsed.tag.length > 0;
}

/**
 * Docker Hub 适配器：查询 hub.docker.com 获取最新 tag
 */
export class DockerHubAdapter {
  // DockerHub 不稳定标签黑名单（比 GHCR 少 alpha/beta/rc/main/master）
  UNSTABLE_RE = /^(latest|nightly|dev|edge)$/i;

  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  canHandle(image) {
    const parsed = parseImage(image);
    return !!parsed && parsed.registry === 'dockerhub';
  }

  /**
   * 带超时的 fetch 包装
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<Response>}
   */
  async request(url, opts = {}) {
    const options = { ...opts };
    if (!options.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(this.timeoutMs);
    }
    try {
      return await this.fetchImpl(url, options);
    } catch (e) {
      throw new RegistryRequestError(`Registry 请求失败: ${e.message}`, { url, cause: e });
    }
  }

  /**
   * 获取最新稳定 tag
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag（用于变体匹配，如 pg -> pg-1.16.0）
   * @returns {Promise<string|null>} null = 请求成功但没有可用稳定 tag
   */
  async getLatestTag(image, currentTag) {
    const parsed = parseImage(image);
    if (!parsed) {
      throw new RegistryRequestError(`镜像字符串无法解析: ${image}`);
    }
    const { repo } = parsed;
    // DockerHub API v2
    // page_size=100 + 翻页兜底：anirss/handbrake/scrob/syncthing 等 hardcode 应用
    // 单个镜像 30+ tag（每个 semver 配多架构后缀），page_size=20 会把 arm32v7 等变体截断到 page 1 之外，
    // 导致形态 3 同 suffix 匹配失败、arm32v7 变体永远不生成新版本目录（PR #19 复盘）。
    // 见 AGENTS.md "anirss 不更新根因复盘（2026-09-08）" 与本页注释。
    // 上限 5 页（500 tag）覆盖当前所有 known 应用（最大 scrob ~80 tag）；超出时 fallback 到
    // 已拉到的所有 tag，不影响"返回最新稳定 tag"主语义。
    const PAGE_SIZE = 100;
    const MAX_PAGES = 5;
    const baseUrl = `https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=${PAGE_SIZE}&ordering=last_updated`;

    const allResults = [];
    let nextUrl = baseUrl;
    for (let page = 0; page < MAX_PAGES && nextUrl; page++) {
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

      const results = data?.results ?? [];
      allResults.push(...results);

      // DockerHub 返回 next 为 null 时表示已到末页
      if (!data?.next) break;
      nextUrl = data.next;
    }

    // 过滤不稳定标签
    const stable = allResults.filter(t => !this.UNSTABLE_RE.test(t.name));
    if (stable.length === 0) return null;

    // 如果有当前 tag，尝试按"变体维度"匹配同 suffix 的版本化 tag。
    // 支持 4 种 currentTag 形态：
    //   1. 裸变体: 'pg'            → 匹配 'pg-1.16.0'（prefix = 'pg', suffix = undefined）
    //   2. 变体+版本: 'pg-1.16.0'  → 匹配 'pg-1.16.1'（prefix = 'pg', suffix = undefined）
    //   3. semver+后缀: 'v3.2.18-arm32v7' → 匹配 'v3.2.29-arm32v7'（prefix = 'v', suffix = 'arm32v7'）
    //   4. 多段数字版本: '26.04.5.1.1' → 只在"同段数"的数字 tag 里选最新
    //
    // 形态 1/2 行为不变（AGENTS.md 业务：anythingllm/railway 等需要）；形态 3 修复 anirss/handbrake 类
    // hardcode 应用的"丢后缀"bug（9 个 versionDir 全收敛到 v3.2.29，v3.2.29-arm32v7 永远不生成）。
    if (currentTag) {
      // 形态 4：4 段及以上的纯数字版本（collabora/code 的 26.04.5.1.1 这类）
      // 动机: 某些镜像同时存在"历史遗留的 3 段纯 semver"和"当前的多段数字版本"
      // （collabora/code 有 2017 年的 2.1.2 ~ 2.1.5 与当前的 26.04.5.1.1），
      // 而 pickLatest 的"纯 semver 优先"策略会让 2.1.5 压过 26.04.5.1.1，
      // 导致 auto-update 把版本目录写成 2.1.5。按段数收敛候选集即可避免该误报。
      const multiSegmentMatch = currentTag.match(/^\d+(?:\.\d+){3,}$/);
      if (multiSegmentMatch) {
        const segmentCount = currentTag.split('.').length;
        const sameShape = stable.filter(
          (t) => /^\d+(?:\.\d+)*$/.test(t.name) && t.name.split('.').length === segmentCount
        );
        if (sameShape.length > 0) {
          return pickLatest(sameShape.map((t) => t.name));
        }
        // 同段数的 tag 不存在 → 走 fallback，避免误报
      }

      // 形态 3：vX.Y.Z-suffix（pure semver base + 短横线后缀）
      const semverSuffixMatch = currentTag.match(/^v\d+\.\d+\.\d+-([a-z0-9][a-z0-9-]*)$/i);
      if (semverSuffixMatch) {
        const suffix = semverSuffixMatch[1]; // 如 'arm32v7'
        const variantTags = stable
          .filter(t => /^v\d+\.\d+\.\d+-([a-z0-9][a-z0-9-]*)$/i.test(t.name))
          .filter(t => t.name.toLowerCase().endsWith(`-${suffix.toLowerCase()}`));
        if (variantTags.length > 0) {
          return pickLatest(variantTags.map(t => t.name));
        }
        // 同 suffix 的版本不存在（如上游删了 arm32v7）→ 走 fallback，避免误报
      }

      // 形态 0：当前 tag 是纯 semver（vX.Y.Z）→ 只在"同为纯 semver"的 tag 里选。
      // 动机：上游仓库常同时存在纯 semver tag 与多段数字 / 字母前缀 tag，
      // semver.mjs 的 pickLatest 会判定形态冲突并返回 null（保守不报）。
      // 先按形态收敛候选集，既保留"不误报"的保守性，又不漏掉正常更新。
      const pureSemverMatch = currentTag.match(/^v?\d+\.\d+\.\d+$/i);
      if (pureSemverMatch) {
        const sameShape = stable.filter(t => /^v?\d+\.\d+\.\d+$/i.test(t.name));
        if (sameShape.length > 0) {
          return pickLatest(sameShape.map(t => t.name));
        }
        // 同形态候选不存在 → 走 fallback，避免误报
      }

      // 形态 1/2：字母开头的变体（pg / railway / pg-1.16.0）
      const variantMatch = currentTag.match(/^([a-zA-Z][a-zA-Z0-9]*)(?:-|$)/);
      if (variantMatch) {
        const prefix = variantMatch[1];
        // 排除 vX.Y.Z-* 形态被这里误捕获（理论上 semverSuffixMatch 已先匹配，但保留防御）
        if (!/^v\d/i.test(prefix)) {
          const variantTags = stable.filter(t => t.name.startsWith(`${prefix}-`));
          if (variantTags.length > 0) {
            return pickLatest(variantTags.map(t => t.name));
          }
        }
      }
    }

    // 回退：从所有稳定 tag 中选最新
    const allStable = stable.map(t => t.name);
    return pickLatest(allStable);
  }
}

/**
 * GitHub Container Registry 适配器：查询 ghcr.io OCI API 获取最新 tag
 */
export class GhcrAdapter {
  // GHCR 不稳定标签黑名单（全量）
  UNSTABLE_RE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i;

  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  canHandle(image) {
    const parsed = parseImage(image);
    return !!parsed && parsed.registry === 'ghcr.io';
  }

  /**
   * 带超时的 fetch 包装
   * @param {string} url
   * @param {object} [opts]
   * @returns {Promise<Response>}
   */
  async request(url, opts = {}) {
    const options = { ...opts };
    if (!options.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(this.timeoutMs);
    }
    try {
      return await this.fetchImpl(url, options);
    } catch (e) {
      throw new RegistryRequestError(`Registry 请求失败: ${e.message}`, { url, cause: e });
    }
  }

  /**
   * 获取最新稳定 tag
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag（用于变体匹配，如 pg -> pg-1.16.0）
   * @returns {Promise<string|null>} null = 请求成功但没有可用稳定 tag
   */
  async getLatestTag(image, currentTag) {
    const parsed = parseImage(image);
    if (!parsed) {
      throw new RegistryRequestError(`镜像字符串无法解析: ${image}`);
    }
    const { repo } = parsed;
    let token = null;

    // 优先尝试获取匿名 pull token（无需认证）。
    // token 端点失败 → 降级为匿名调用（不视为失败）。
    try {
      const tokenRes = await this.request(
        `https://ghcr.io/token?scope=repository:${repo}:pull`
      );
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        token = tokenData?.token ?? null;
      }
    } catch (_) {
      // token 获取失败，降级为匿名调用
      token = null;
    }

    // 构建请求头
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // 翻页拉取全部 tag。GHCR 的 tags/list 单页上限 n=1000，且返回顺序是 tag 字典序
    // （不是"最新在前"）。tag 总数超过 1000 的镜像（如 ghcr.io/traefik/traefik 有 2700+ 个，
    // 字典序前 1000 个只到 v2.0.0-alpha6-*）如果只取第一页，v3.x 这类较新 tag 根本不在
    // 候选集里，pickLatest 只能在 1.x / 2.x 里选，于是把"最新版本"误判成 3.0.3。
    // 2026-11-01 auto-update 事故：本仓把 traefik 切到 ghcr 后，cron 检出 3.0.3 并
    // 生成了 traefik/3.0.3/ 版本目录（旧镜像）。修复：跟随 Link rel="next" 翻页，
    // 上限 MAX_PAGES 页（1000 tag/页）兜底，避免无界请求。
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 10;
    const allTags = [];
    let nextUrl = `https://ghcr.io/v2/${repo}/tags/list?n=${PAGE_SIZE}`;
    for (let page = 0; page < MAX_PAGES && nextUrl; page++) {
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
      allTags.push(...(data?.tags ?? []));

      // Link: </v2/<repo>/tags/list?last=<tag>&n=1000>; rel="next"
      const link = res.headers?.get?.('link') ?? '';
      const next = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
      nextUrl = next ? (next[1].startsWith('http') ? next[1] : `https://ghcr.io${next[1]}`) : null;
    }

    const stable = [...new Set(allTags)].filter(t => !this.UNSTABLE_RE.test(t));
    if (stable.length === 0) return null;

    // 如果有当前 tag，尝试按"变体维度"匹配同 suffix 的版本化 tag。
    // 支持 4 种 currentTag 形态（与 DockerHubAdapter 一致）：
    //   1. 裸变体: 'pg'            → 匹配 'pg-1.16.0'
    //   2. 变体+版本: 'pg-1.16.0'  → 匹配 'pg-1.16.1'
    //   3. semver+后缀: 'v3.2.18-arm32v7' → 匹配 'v3.2.29-arm32v7'
    //   4. 多段数字版本: '26.04.5.1.1' → 只在"同段数"的数字 tag 里选最新
    if (currentTag) {
      // 形态 4：4 段及以上的纯数字版本（按段数收敛候选集，避免历史遗留的 3 段纯 semver 抢占）
      const multiSegmentMatch = currentTag.match(/^\d+(?:\.\d+){3,}$/);
      if (multiSegmentMatch) {
        const segmentCount = currentTag.split('.').length;
        const sameShape = stable.filter(
          (t) => /^\d+(?:\.\d+)*$/.test(t) && t.split('.').length === segmentCount
        );
        if (sameShape.length > 0) {
          return pickLatest(sameShape);
        }
        // 同段数的 tag 不存在 → 走 fallback
      }

      // 形态 3：vX.Y.Z-suffix
      const semverSuffixMatch = currentTag.match(/^v\d+\.\d+\.\d+-([a-z0-9][a-z0-9-]*)$/i);
      if (semverSuffixMatch) {
        const suffix = semverSuffixMatch[1];
        const variantTags = stable
          .filter(t => /^v\d+\.\d+\.\d+-([a-z0-9][a-z0-9-]*)$/i.test(t))
          .filter(t => t.toLowerCase().endsWith(`-${suffix.toLowerCase()}`));
        if (variantTags.length > 0) {
          return pickLatest(variantTags);
        }
        // 同 suffix 的版本不存在 → 走 fallback
      }

      // 形态 0：当前 tag 是纯 semver（vX.Y.Z）→ 只在"同为纯 semver"的 tag 里选
      // （与 DockerHubAdapter 对称；避免 pickLatest 因形态冲突返回 null 而漏检）
      const pureSemverMatch = currentTag.match(/^v?\d+\.\d+\.\d+$/i);
      if (pureSemverMatch) {
        const sameShape = stable.filter(t => /^v?\d+\.\d+\.\d+$/i.test(t));
        if (sameShape.length > 0) {
          return pickLatest(sameShape);
        }
        // 同形态候选不存在 → 走 fallback，避免误报
      }

      // 形态 1/2：字母开头的变体
      const variantMatch = currentTag.match(/^([a-zA-Z][a-zA-Z0-9]*)(?:-|$)/);
      if (variantMatch) {
        const prefix = variantMatch[1];
        if (!/^v\d/i.test(prefix)) {
          const variantTags = stable.filter(t => t.startsWith(`${prefix}-`));
          if (variantTags.length > 0) {
            return pickLatest(variantTags);
          }
        }
      }
    }

    // 回退：从所有稳定 tag 中选最新
    return pickLatest(stable);
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
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {DockerHubAdapter|GhcrAdapter|null}
 */
export function createAdapter(image, opts = {}) {
  const parsed = parseImage(image);
  if (!parsed) return null;
  if (parsed.registry === 'ghcr.io') {
    return new GhcrAdapter(opts);
  }
  if (parsed.registry === 'dockerhub') {
    return new DockerHubAdapter(opts);
  }
  return null;
}
