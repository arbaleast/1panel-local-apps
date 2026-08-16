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

  async getLatestTag(image) {
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
    // 过滤不稳定标签，取最新（按 last_updated 排序，首位即最新）
    const stable = results.filter(t => !this.UNSTABLE_RE.test(t.name));
    if (stable.length === 0) return null;
    return stable[0].name;
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

  async getLatestTag(image) {
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

    // 使用 pickLatest 选出版本号
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
