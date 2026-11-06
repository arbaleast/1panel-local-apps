// lib/arch-map.mjs — 架构映射与「木桶效应」交集计算的**纯函数**层
//
// ── 职责（唯一）────────────────────────────────────────────────────────────
// 1. 把 1Panel **版本目录名**映射成它的架构变体（`archFromVersionDir`）
// 2. 判定某个目录名是否是 **GPU 变体**目录（`isGpuVariantDir`）
// 3. 多个镜像/服务之间的架构**交集**计算（木桶效应）
// 4. 声明架构与实际发布架构的**差集**（多声明 / 少声明）
//
// ── 分层约束（CONTRIBUTING.md §4）────────────────────────────────────────
// 本模块**必须 100% 纯**：无 fs / 无网络 / 无 process。
//
// ── ⚠️ 语义坑：「空集合」≠「不支持任何架构」────────────────────────────────
// `effectiveArch` 的 `archs === null` 表示**未核实**（某个必需服务的架构集合
// 未知），**不是**「这套镜像没有任何架构」。两者在下游决策里的处置完全不同，
// 因此这里用 `null` 而不是空数组 `[]` 表达「未知」。

/** 1Panel 仓库支持的架构名（**唯一**事实来源） */
export const REPO_ARCHS = Object.freeze(['amd64', 'arm64', 'arm/v7', '386']);

/** 版本目录后缀 → arm64 */
const ARM64_SUFFIX_RE = /^arm64(v\d+)?$/;
/** 版本目录后缀 → arm/v7（两种常见写法） */
const ARMV7_SUFFIX_RE = /^arm(32)?v7$/;
/** 版本目录后缀 → arm32vN（仅 v7 归一，其余视为未知架构） */
const ARM32_SUFFIX_RE = /^arm32v(\d+)$/;

/**
 * GPU 变体目录关键字（大小写不敏感）
 *
 * 覆盖：cuda / rocm / vulkan / gpu / nvidia / amd
 */
const GPU_KEYWORD_RE = /cuda|rocm|vulkan|gpu|nvidia|amd/i;
/** 纯 CUDA tag 形态目录名（如 `cu124`） */
const CUDA_TAG_DIR_RE = /^cu\d+$/i;

/**
 * 从版本目录名推断其架构变体。
 *
 * 规则：**只看最后一个 `-` 之后的后缀**（前面的部分可能是版本号，也可能含 `-`）。
 *   - `/^arm64(v\d+)?$/` → `'arm64'`（`arm64`、`arm64v8` 都算 arm64）
 *   - `/^arm(32)?v7$/` → `'arm/v7'`（`armv7`、`arm32v7`）
 *   - `/^arm32v(\d+)$/` → 仅 `v7` 归一为 `'arm/v7'`，其余（v6/v8…）→ null
 *   - 其它 → null
 *
 * 典型例子：
 *   - `2026091410-arm64` → `'arm64'`
 *   - `full-v1.12.2-arm64` → `'arm64'`
 *   - `v2.5.0-arm64v8` → `'arm64'`
 *   - `v3.2.32-arm32v7` → `'arm/v7'`
 *   - `2026091410` → `null`（普通版本目录）
 *   - `1.11.2-ls41` → `null`（linuxserver 构建号变体，不是架构）
 *   - `server-cuda12-v0.4.9` → `null`（GPU 变体，不是架构变体）
 *   - `latest` / `v0.3.8` → `null`
 *
 * @param {string} dirName 版本目录名
 * @returns {string|null} 架构名；非架构变体目录返回 null
 */
export function archFromVersionDir(dirName) {
  if (typeof dirName !== 'string' || dirName === '') return null;
  const idx = dirName.lastIndexOf('-');
  const suffix = idx === -1 ? dirName : dirName.slice(idx + 1);
  if (suffix === '') return null;

  if (ARM64_SUFFIX_RE.test(suffix)) return 'arm64';
  if (ARMV7_SUFFIX_RE.test(suffix)) return 'arm/v7';
  const arm32 = ARM32_SUFFIX_RE.exec(suffix);
  if (arm32) return arm32[1] === '7' ? 'arm/v7' : null;
  return null;
}

/**
 * 判定目录名是否为 **GPU 变体**目录。
 *
 * 命中关键字：`cuda` / `rocm` / `vulkan` / `gpu` / `nvidia` / `amd`
 *（大小写不敏感），以及纯 CUDA tag 形态目录名（如 `cu124`）。
 *
 * 典型命中：`gpu-nvidia-latest`、`gpu-amd-latest`、`server-cuda12-v0.4.9`、
 * `server-vulkan-v0.4.9`、`261029-cuda`、`cu124`。
 *
 * @param {string} dirName 目录名
 * @returns {boolean}
 */
export function isGpuVariantDir(dirName) {
  if (typeof dirName !== 'string' || dirName === '') return false;
  if (GPU_KEYWORD_RE.test(dirName)) return true;
  return CUDA_TAG_DIR_RE.test(dirName);
}

/**
 * 多集合交集（保序去重）。
 *
 * 结果顺序沿用**第一个集合**的顺序；某个元素在所有集合中都出现才保留。
 *
 * @param {string[][]} sets 架构集合数组
 * @returns {string[]} 交集
 */
export function intersectArchs(sets) {
  if (!Array.isArray(sets) || sets.length === 0) return [];
  const first = Array.isArray(sets[0]) ? sets[0] : [];
  const rest = sets.slice(1).map(s => (Array.isArray(s) ? s : []));
  const out = [];
  for (const arch of first) {
    if (out.includes(arch)) continue; // 保序去重
    if (rest.every(s => s.includes(arch))) out.push(arch);
  }
  return out;
}

/**
 * 多镜像**木桶效应**：所有必需服务镜像架构的交集。
 *
 * 语义：
 * - 全部集合都非空 → `archs` = 交集，`unverified = false`
 * - **任一**集合为空 / 缺失 → `archs = null`、`unverified = true`
 *   （⚠️ **不得**当成「不支持任何架构」——那是「未核实」，处置方式不同）
 *
 * @param {string[][]} imageArchSets 每个必需服务的架构集合
 * @returns {{archs: string[]|null, unverified: boolean}}
 */
export function effectiveArch(imageArchSets) {
  if (!Array.isArray(imageArchSets) || imageArchSets.length === 0) {
    return { archs: null, unverified: true };
  }
  const sets = imageArchSets.map(s => (Array.isArray(s) ? s : []));
  if (sets.some(s => s.length === 0)) {
    return { archs: null, unverified: true };
  }
  return { archs: intersectArchs(sets), unverified: false };
}

/**
 * 声明架构 vs 实际发布架构的差集。
 *
 * - `overdeclared` = declared 中**不在** actual 里的（声明了镜像未发布的架构）
 * - `underdeclared` = actual 中**不在** declared 里的（镜像发布了但未声明）
 *
 * @param {string[]} declared 声明的架构
 * @param {string[]} actual 实际发布的架构
 * @returns {{overdeclared: string[], underdeclared: string[]}}
 */
export function diffDeclared(declared, actual) {
  const d = Array.isArray(declared) ? declared : [];
  const a = Array.isArray(actual) ? actual : [];
  return {
    overdeclared: d.filter(x => !a.includes(x)),
    underdeclared: a.filter(x => !d.includes(x)),
  };
}
