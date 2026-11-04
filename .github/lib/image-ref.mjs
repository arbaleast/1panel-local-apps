// lib/image-ref.mjs — 全局唯一的镜像引用解析器（Image Reference Parser）
//
// ── 为什么是这个模块 ───────────────────────────────────────────────────────
// 审计发现仓库里存在**两套**镜像解析实现：
//   1. lib/registry.mjs  parseImage()      —— 检测链路用
//   2. lib/validate-batch.mjs parseImageRef() —— 校验链路用（手搓 lastIndexOf）
// 二者的 `repo` 语义还不一致（前者不含 registry 前缀，后者含），
// 与 lib/compose.mjs 里"统一走 parseImage"的既有政策直接冲突。
//
// 本模块是**唯一**的解析实现；registry.mjs 的 parseImage() 与
// validate-batch.mjs 的 parseImageRef() 均改为薄封装（保留旧导出以兼容既有测试）。
//
// ── 解析规则（严格按 OCI / Docker 引用语法）──────────────────────────────
//  1. **先剥离并校验 Digest**：`repo:tag@sha256:...` → 先切 `@`，校验 `算法:内容`，
//     再在剩余部分提取 Tag（目标 §四.3 复合格式）。
//  2. **端口与 Tag 消歧**：最后一个 `/` 之后的 `:` 才是 Tag；
//     最后一个 `/` 之前的 `:` 是 Registry 端口（目标 §四.2）。
//  3. **Registry 判定**：首段含 `.` 或 `:` 或等于 `localhost` → 是 Registry；
//     否则是 Docker Hub 命名空间。
//  4. **namespace / repository 拆分**：官方单级镜像（Docker Hub + 单段）
//     自动补齐 namespace='library'（目标 §四.1）。
//
// 解析失败一律返回 **null**（绝不猜测、绝不部分解析）。

/** Docker Hub 的规范域名（目标 §四.1：registry 默认值为 docker.io） */
export const DEFAULT_REGISTRY = 'docker.io';

/** Docker Hub 的等价写法，全部归一到 DEFAULT_REGISTRY */
export const DOCKER_HUB_HOSTS = Object.freeze(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/** 官方镜像（Docker Hub 单段命名空间）自动补齐的命名空间 */
export const OFFICIAL_NAMESPACE = 'library';

/** 引用类别（referenceKind） */
export const REFERENCE_KINDS = Object.freeze({
  /** 带 tag 的硬编码镜像 —— 参与版本检测 */
  HARDCODED: 'hardcoded',
  /** 只有 digest，没有 tag —— 版本由摘要锁定，不参与版本检测 */
  DIGEST: 'digest',
  /** 既无 tag 也无 digest —— 等价于 latest，禁止使用 */
  NO_TAG: 'no-tag',
  /** 变量型镜像模板（${IMAGE} / ${APP_VERSION}）—— 由 compose 层解析 */
  VARIABLE: 'variable',
  /** 非法镜像字符串 */
  INVALID: 'invalid',
});

/** Registry 来源（与目标 §七 Decision Result 的 `source` 同义） */
export const SOURCES = Object.freeze({
  DOCKERHUB: 'dockerhub',
  GHCR: 'ghcr',
  CUSTOM: 'custom',
});

// repo 路径段：段首必须是字母或数字，其余可含 . _ -
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// digest：`<算法>:<十六进制内容>`（算法可含 + . _ -）
const DIGEST_RE = /^[A-Za-z0-9_+.-]+:[A-Za-z0-9]+$/;

/**
 * 把 registry 主机归一到来源分类。
 * @param {string|null} host
 * @returns {'dockerhub'|'ghcr'|'custom'}
 */
export function classifyRegistryHost(host) {
  if (host === null || host === undefined) return SOURCES.DOCKERHUB;
  if (DOCKER_HUB_HOSTS.includes(host)) return SOURCES.DOCKERHUB;
  if (host === 'ghcr.io') return SOURCES.GHCR;
  return SOURCES.CUSTOM;
}

/**
 * 解析镜像引用字符串（**全局唯一入口**）。
 *
 * @param {string} image 完整镜像引用
 * @returns {{
 *   registry: string,        // 规范化的 registry（docker.io / ghcr.io / host[:port]）
 *   namespace: string,       // 命名空间（官方单级镜像自动补齐 'library'）
 *   repository: string,      // 命名空间之后的路径（支持多级）
 *   repo: string,            // 不含 registry 前缀的完整路径（兼容旧 API）
 *   tag: string|null,        // 标签（未指定为 null）
 *   digest: string|null,     // digest（未指定为 null）
 *   original: string,        // 原始引用字符串
 *   source: 'dockerhub'|'ghcr'|'custom',
 *   referenceKind: 'hardcoded'|'digest'|'no-tag'|'variable'|'invalid',
 * }|null} 非法输入返回 null
 */
export function parseImageReference(image) {
  if (typeof image !== 'string') return null;
  // 前后空白 / 内部空白 → 非法（compose 模板里出现空白说明拼接出错）
  if (image.trim() !== image) return null;
  if (image.length === 0) return null;
  if (/[\s$]/.test(image)) return null;
  if (image.includes('?') || image.includes('#')) return null;

  // ── 变量型镜像：交给 compose 层解析（不是错误，也不是硬编码）────────────
  if (image.includes('${')) {
    return null;
  }

  // ── 1. 先剥离并校验 Digest（复合格式：先 digest，后 tag）───────────────
  let base = image;
  let digest = null;
  const atIdx = image.indexOf('@');
  if (atIdx !== -1) {
    digest = image.slice(atIdx + 1);
    base = image.slice(0, atIdx);
    if (!DIGEST_RE.test(digest)) return null;
  }

  // ── 2. registry 前缀判定 ────────────────────────────────────────────────
  // 首段含 '.' 或 ':' 或等于 localhost → 是 Registry；否则是命名空间。
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

  // ── 3. Tag 提取：最后一个 '/' 之后的 ':' 才是 Tag（端口消歧）────────────
  let tag = null;
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!tag) return null;
  }

  // ── 4. 路径校验 ────────────────────────────────────────────────────────
  if (!rest) return null;
  if (rest.startsWith('/') || rest.endsWith('/')) return null;
  if (rest.includes('//')) return null;
  const segments = rest.split('/');
  for (const seg of segments) {
    if (!REPO_SEGMENT_RE.test(seg)) return null;
  }

  // ── 5. registry 归一 + namespace / repository 拆分 ──────────────────────
  const source = classifyRegistryHost(registryHost);
  const registry = registryHost === null ? DEFAULT_REGISTRY : registryHost;

  let namespace;
  let repository;
  if (segments.length === 1) {
    // 单段：Docker Hub 官方镜像自动补齐 library；其它 registry 无命名空间
    namespace = source === SOURCES.DOCKERHUB ? OFFICIAL_NAMESPACE : '';
    repository = segments[0];
  } else {
    namespace = segments[0];
    repository = segments.slice(1).join('/');
  }

  const referenceKind = tag
    ? REFERENCE_KINDS.HARDCODED
    : (digest ? REFERENCE_KINDS.DIGEST : REFERENCE_KINDS.NO_TAG);

  return {
    registry,
    namespace,
    repository,
    repo: rest,
    tag,
    digest,
    original: image,
    source,
    referenceKind,
  };
}

/**
 * 变量型镜像模板判定（compose 层用）。
 * @param {unknown} image
 * @returns {boolean}
 */
export function isVariableImage(image) {
  return typeof image === 'string' && image.includes('${');
}

/**
 * 变量型镜像的参考类别（不进入解析）。
 * @param {string} image
 * @returns {'variable'|'invalid'}
 */
export function classifyVariableOrInvalid(image) {
  if (isVariableImage(image)) return REFERENCE_KINDS.VARIABLE;
  return REFERENCE_KINDS.INVALID;
}
