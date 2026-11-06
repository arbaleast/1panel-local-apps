// lib/manifest.mjs — OCI manifest / image config 的**纯函数**解析层
//
// ── 职责（唯一）────────────────────────────────────────────────────────────
// 从 manifest JSON 与 image config JSON 中提取「平台（架构）」信息，
// 以及 image config 的默认运行身份（User / Env）。
//
// ── 分层约束（CONTRIBUTING.md §4）────────────────────────────────────────
// 本模块**必须 100% 纯**：无 fs / 无网络 / 无 process。
// 网络取数统一在 lib/registry.mjs（`fetchManifest`）里做。
//
// ── ⚠️ 关键坑：index digest ≠ 子 manifest digest（目标 §五.3）─────────────
// 一个多架构镜像（manifest list / OCI index）在 registry 里存在**两层摘要**：
//   1. **index digest**：整个多架构清单自身的 digest
//      （响应头 `Docker-Content-Digest`，或 index body 里的 `manifests[i].digest` 列表）。
//   2. **子 manifest digest**：index 内部**某一个架构条目**自身的 digest
//      （`manifests[i].digest`，例如 linux/amd64 那一条）。
//
// 这两者**绝不能混用**：把 index digest 当成「amd64 镜像的摘要」，
// 会导致按架构核对时把「整个清单的摘要」错配给单个架构；
// 反之把子 manifest digest 当成 index digest，则会让「镜像整体身份」随架构漂移。
// 本模块因此只负责**提取结构**（哪个 digest 是哪个层级由调用方按语义取用）：
//   · `extractPlatforms` → 平台集合（来自 index 的 manifests[].platform）
//   · `extractConfigDigest` → **单架构 manifest** 的 image config digest
//     （`config.digest`，属于**子 manifest** 层级，**不是** index digest）

/** 需要跳过的占位架构：buildx attestation manifest 的占位条目（不是真实平台） */
const ATTESTATION_ARCH = 'attestation-manifest';
/** buildx attestation 的占位架构名（与真实平台同为 unknown 的情形） */
const UNKNOWN_ARCH = 'unknown';
/** buildx attestation 在 manifest 上的注解键 */
const ATTESTATION_REF_TYPE = 'vnd.docker.reference.type';

/**
 * 判断一个 platform 条目是否为「占位条目」（attestation / unknown），需要跳过。
 *
 * buildx 在构建多架构镜像时会额外塞入 attestation manifest 占位条目，
 * 它的 `architecture` 可能是 `unknown`，也可能带
 * `vnd.docker.reference.type=attestation-manifest` 注解 —— 两者都不是真实平台，
 * 计入架构集合会凭空多出「一个不存在的架构」。
 *
 * @param {unknown} platform
 * @returns {boolean}
 */
function isPlaceholderPlatform(platform) {
  if (!platform || typeof platform !== 'object') return true;
  const arch = platform.architecture;
  if (typeof arch !== 'string' || arch === '') return true;
  if (arch === UNKNOWN_ARCH) return true;
  if (arch === ATTESTATION_ARCH) return true;
  const annotations = platform.annotations;
  if (annotations && typeof annotations === 'object'
    && annotations[ATTESTATION_REF_TYPE] === ATTESTATION_REF_TYPE) {
    return true;
  }
  return false;
}

/**
 * OCI platform → 1Panel 仓库架构名。
 *
 * 映射规则：
 *   - `os` 不是 `linux` → null（Windows / Darwin 等本仓不发布）
 *   - `architecture` 缺失 → null
 *   - `amd64` → `amd64`
 *   - `arm64` → `arm64`
 *   - `386` → `386`
 *   - `arm` → `arm`（无 variant 时）；带 variant 时 → `arm/<variant>`（如 `arm/v7`）
 *   - 其它架构 → null
 *
 * @param {{os?: string, architecture?: string, variant?: string}|null|undefined} platform
 * @returns {string|null} 仓库架构名；无法映射时返回 null
 */
export function toRepoArch(platform) {
  if (!platform || typeof platform !== 'object') return null;
  const os = platform.os;
  const arch = platform.architecture;
  if (typeof os !== 'string' || os !== 'linux') return null;
  if (typeof arch !== 'string' || arch === '') return null;

  if (arch === 'amd64' || arch === 'arm64' || arch === '386') return arch;
  if (arch === 'arm') {
    const variant = platform.variant;
    if (typeof variant === 'string' && variant !== '') return `arm/${variant}`;
    return 'arm';
  }
  return null;
}

/**
 * 从 manifest body 提取平台集合。
 *
 * - **index**（`body.manifests` 是数组，即 manifest list / OCI index）：
 *   遍历 `manifests[].platform`，跳过 `unknown` 与 `attestation-manifest` 占位条目，
 *   `platforms` 为去重并排序后的仓库架构名数组，`rawPlatforms` 保留原始平台三元组。
 * - **manifest**（单架构 manifest，`body.manifests` 不是数组）：
 *   `kind='manifest'`，`platforms=[]`（此时架构信息在 image config 里），
 *   `rawPlatforms=[]`。
 *
 * @param {unknown} manifestBody manifest JSON body
 * @returns {{kind: 'index'|'manifest', platforms: string[], rawPlatforms: Array<{os: string, architecture: string, variant: string|null}>}}
 */
export function extractPlatforms(manifestBody) {
  const body = manifestBody && typeof manifestBody === 'object' ? manifestBody : {};
  const manifests = body.manifests;
  if (!Array.isArray(manifests)) {
    return { kind: 'manifest', platforms: [], rawPlatforms: [] };
  }
  const rawPlatforms = [];
  const archSet = new Set();
  for (const entry of manifests) {
    const platform = entry && typeof entry === 'object' ? entry.platform : null;
    if (isPlaceholderPlatform(platform)) continue;
    rawPlatforms.push({
      os: platform.os ?? null,
      architecture: platform.architecture ?? null,
      variant: platform.variant ?? null,
    });
    const repoArch = toRepoArch(platform);
    if (repoArch) archSet.add(repoArch);
  }
  return {
    kind: 'index',
    platforms: [...archSet].sort(),
    rawPlatforms,
  };
}

/**
 * 取单架构 manifest 的 image config digest。
 *
 * ⚠️ 这是**子 manifest 层级**的 config digest，与 index digest 无关（见文件头说明）。
 *
 * @param {unknown} manifestBody manifest JSON body
 * @returns {string|null}
 */
export function extractConfigDigest(manifestBody) {
  const body = manifestBody && typeof manifestBody === 'object' ? manifestBody : {};
  const digest = body.config?.digest;
  return typeof digest === 'string' && digest !== '' ? digest : null;
}

/**
 * 从 image config body 提取平台与默认运行身份。
 *
 * - `user` = `configBody.config.User`，**原样保留**：`null` 与空字符串都原样返回
 *   （空字符串与 null 在语义上不同，不能互相归一）。
 * - `env` = `configBody.config.Env` 数组；缺失 / 非数组 → `[]`。
 *
 * @param {unknown} configBody image config JSON body
 * @returns {{os: string|null, architecture: string|null, variant: string|null, user: string|null, env: string[]}}
 */
export function extractImageConfig(configBody) {
  const body = configBody && typeof configBody === 'object' ? configBody : {};
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  const rawEnv = config.Env;
  return {
    os: typeof body.os === 'string' ? body.os : null,
    architecture: typeof body.architecture === 'string' ? body.architecture : null,
    variant: typeof body.variant === 'string' ? body.variant : null,
    user: config.User === undefined ? null : config.User,
    env: Array.isArray(rawEnv) ? rawEnv.filter(e => typeof e === 'string') : [],
  };
}
