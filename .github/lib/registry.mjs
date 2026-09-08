// lib/registry.mjs — 镜像解析与版本适配器
import { pickLatest } from './semver.mjs';

/**
 * 解析镜像字符串，返回结构化信息
 * @param {string} image 完整镜像字符串
 * @returns {{ registry: string, repo: string, tag?: string, digest?: string }}
 */
export function parseImage(image) {
  // 提取 digest（@sha256:xxx）
  const atSha = image.indexOf('@');
  const digestPart = atSha !== -1 ? image.slice(atSha + 1) : undefined;
  const base = atSha !== -1 ? image.slice(0, atSha) : image;

  // 提取 tag（:tag）
  const lastColon = base.lastIndexOf(':');
  const firstSlash = base.indexOf('/');
  // 无 slash 时有冒号即为 tag；有 slash 时需冒号在 slash 之后（排除 registry:port）
  const hasTag = firstSlash === -1 ? lastColon !== -1 : lastColon > firstSlash;
  const tag = hasTag ? base.slice(lastColon + 1) : undefined;
  const repoPart = hasTag ? base.slice(0, lastColon) : base;

  // 判断 registry
  if (repoPart.startsWith('ghcr.io/')) {
    return {
      registry: 'ghcr.io',
      repo: repoPart.slice('ghcr.io/'.length),
      tag,
      digest: digestPart,
    };
  }

  // DockerHub
  return {
    registry: 'dockerhub',
    repo: repoPart,
    tag,
    digest: digestPart,
  };
}

/**
 * Docker Hub 适配器：查询 hub.docker.com 获取最新 tag
 */
export class DockerHubAdapter {
  // DockerHub 不稳定标签黑名单（比 GHCR 少 alpha/beta/rc/main/master）
  UNSTABLE_RE = /^(latest|nightly|dev|edge)$/i;

  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  canHandle(image) {
    return !image.startsWith('ghcr.io/');
  }

  /**
   * 获取最新稳定 tag
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag（用于变体匹配，如 pg -> pg-1.16.0）
   * @returns {Promise<string|null>}
   */
  async getLatestTag(image, currentTag) {
    const { repo } = parseImage(image);
    // DockerHub API v2
    const url = `https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=20&ordering=last_updated`;
    let res;
    try {
      res = await this.fetchImpl(url);
    } catch (_) {
      return null;
    }
    if (!res.ok) return null;

    let data;
    try {
      data = await res.json();
    } catch (_) {
      return null;
    }

    const results = data?.results ?? [];
    // 过滤不稳定标签
    const stable = results.filter(t => !this.UNSTABLE_RE.test(t.name));
    if (stable.length === 0) return null;

    // 如果有当前 tag，尝试按"变体维度"匹配同 suffix 的版本化 tag。
    // 支持 3 种 currentTag 形态：
    //   1. 裸变体: 'pg'            → 匹配 'pg-1.16.0'（prefix = 'pg', suffix = undefined）
    //   2. 变体+版本: 'pg-1.16.0'  → 匹配 'pg-1.16.1'（prefix = 'pg', suffix = undefined）
    //   3. semver+后缀: 'v3.2.18-arm32v7' → 匹配 'v3.2.29-arm32v7'（prefix = 'v', suffix = 'arm32v7'）
    //
    // 形态 1/2 行为不变（AGENTS.md 业务：anythingllm/railway 等需要）；形态 3 修复 anirss/handbrake 类
    // hardcode 应用的"丢后缀"bug（9 个 versionDir 全收敛到 v3.2.29，v3.2.29-arm32v7 永远不生成）。
    if (currentTag) {
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

  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  canHandle(image) {
    return image.startsWith('ghcr.io/');
  }

  /**
   * 获取最新稳定 tag
   * @param {string} image 完整镜像字符串
   * @param {string} [currentTag] 当前使用的 tag（用于变体匹配，如 pg -> pg-1.16.0）
   * @returns {Promise<string|null>}
   */
  async getLatestTag(image, currentTag) {
    const { repo } = parseImage(image);
    let token = null;

    // 优先尝试获取匿名 pull token（无需认证）
    try {
      const tokenRes = await this.fetchImpl(
        `https://ghcr.io/token?scope=repository:${repo}:pull`
      );
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json();
        token = tokenData?.token ?? null;
      }
    } catch (_) {
      // token 获取失败，降级为匿名调用
    }

    // 构建请求头
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let res;
    try {
      res = await this.fetchImpl(
        `https://ghcr.io/v2/${repo}/tags/list?n=1000`,
        { headers }
      );
    } catch (_) {
      return null;
    }
    if (!res.ok) return null;

    let data;
    try {
      data = await res.json();
    } catch (_) {
      return null;
    }

    const allTags = data?.tags ?? [];
    const stable = allTags.filter(t => !this.UNSTABLE_RE.test(t));
    if (stable.length === 0) return null;

    // 如果有当前 tag，尝试按"变体维度"匹配同 suffix 的版本化 tag。
    // 支持 3 种 currentTag 形态（与 DockerHubAdapter 一致）：
    //   1. 裸变体: 'pg'            → 匹配 'pg-1.16.0'
    //   2. 变体+版本: 'pg-1.16.0'  → 匹配 'pg-1.16.1'
    //   3. semver+后缀: 'v3.2.18-arm32v7' → 匹配 'v3.2.29-arm32v7'
    if (currentTag) {
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
 * @param {string} image
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {DockerHubAdapter|GhcrAdapter}
 */
export function createAdapter(image, opts = {}) {
  // 按 canHandle 分流
  if (new GhcrAdapter(opts).canHandle(image)) {
    return new GhcrAdapter(opts);
  }
  return new DockerHubAdapter(opts);
}
