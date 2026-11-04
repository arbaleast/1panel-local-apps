// lib/version.mjs — 全局唯一的版本识别与比较引擎（Version Classifier + Comparator）
//
// ── 分层 ──────────────────────────────────────────────────────────────────
//   lib/semver.mjs   低层：**严格 SemVer 2.0.0** 原语（parseSemver / compareSemver /
//                    isValidSemver）。这一层已存在且经审计验证正确，是本引擎的地基。
//   lib/version.mjs  本层：在 SemVer 原语之上建立
//                      ① 版本分类器 classifyVersion（scheme / 轨道 / 变体 / 预发布）
//                      ② 轨道亲和性 sameTrack（变体同轨保护）
//                      ③ 跨方案比较 compareVersions（不可比时返回 null，绝不猜测）
//                      ④ 候选选型 selectCandidate（同轨道内取最大）
//
// ── 概念边界（目标 §六.1：四者必须严格区分）─────────────────────────────────
//   ① **应用语义版本号**（本模块处理的对象）：'1.2.3' / 'v2.16.3' / '16-alpine' ——
//      用来决定「1Panel UI 的版本参数」与「版本目录名」。
//   ② **Tag**：指向某个**顶层多架构索引**（Manifest List / OCI Image Index）的可读别名。
//      Tag 本身**不是**架构 —— 一个 Tag 可同时提供 linux/amd64、linux/arm64、linux/arm/v7。
//   ③ **单架构子 Manifest**：索引下某个平台的子清单。它的 digest 与索引 digest **不同**，
//      但**不构成新的应用版本** —— 不得因架构不同就判成"有新版本"（否则同一镜像会反复误报更新）。
//   ④ **镜像内容 Digest**（'@sha256:...'）：锁定**镜像内容**，与版本号无关。
//      digest 锁定的镜像**不参与版本更新**（见 decideUpdate 的 pinned-digest 分支）。
//
// 本模块只处理 ①；②③④ 的边界由 lib/decision.mjs 与 lib/registry.mjs 保证：
//   · 架构专属 Tag（'1.2.0-amd64' / '1.2.0-arm64v8'）自成一轨，主轨**不得**吸收；
//   · digest 引用一律判为 pinned-digest / 不参与版本判定；
//   · 不同架构子 Manifest 的 digest 差异**从不**参与版本比较。

// ── 铁律 ──────────────────────────────────────────────────────────────────
//   R1 不可比即 null：跨方案（CalVer vs SemVer）、跨轨道（变体不同）、
//      不可识别的 tag 一律返回 null / 'uncomparable'，**严禁**降级为数字比较。
//   R2 轨道亲和性：'1.2.0' 与 '1.2.0-alpine' 不同轨道；候选必须与当前**同轨道**。
//   R3 正式版不升预发布：当前是正式版时，预发布候选一律拒绝。
//   R4 禁止降级：候选低于当前 → 拒绝（'incompatible'）。
//   R5 构建元数据无关：'1.2.0+build.1' 与 '1.2.0+build.2' 版本相等，**不得**触发升级。
//   R6 不猜前缀：'v' / 'V' 前缀仅做归一化，原始格式保留在 original 供回写。
//
// ── 轨道（track）语义 ────────────────────────────────────────────────────
//   轨道 = 版本**形态**，不是主版本号。'1.2.0' 与 '2.0.0' 同轨道（可跨大版本升级），
//   但 '1.2.0' 与 '1.2.0-alpine' 不同轨道（禁止跨变体升级）。
//   num:<段数>            纯数字点分段（1/2/3/N 段）
//   num:<段数>@<变体>     带变体后缀（-alpine / -ls36 / -pg18-trixie / -arm32v7 …）
//   calver                日期版本（2026.10.19 / 2026081705 / 260919）
//   pfx:<前缀>@<内轨道>   变体前缀形态（pg-1.16.0 / server-cuda12-v0.4.1）
//
// ── 存量特例（不破坏已验证有效的策略）────────────────────────────────────
//   · tdarr 前导零版本 '3.00.00'      → 归一化去零后比较，轨道与 '3.0.0' 一致
//   · photopea 两段式 '2.2'          → 独立轨道 num:2（不与三段式混排）
//   · collabora 多段式 '26.04.5.1.1'  → 轨道 num:5（与 '2.1.5' 的 num:3 不混排）
//   · searxng CalVer+SHA              → SHA 视为构建标识，不参与轨道与比较
//   · anirss 'v3.2.13-arm32v7'        → 变体轨道 num:3@arm32v7

import { compareSemver, comparePrerelease, isValidSemver, compareVersionsLoose } from './semver.mjs';

// ── 方案（scheme）──────────────────────────────────────────────────────────
// 取值与目标 §七 Decision Result 的 `versionScheme` 枚举**完全一致**。
export const SCHEMES = Object.freeze({
  SEMVER: 'semver',
  CALVER: 'calver',
  VARIANT: 'variant-semver',
  PINNED_DIGEST: 'pinned-digest',
  ROLLING: 'rolling-tag',
  UNKNOWN: 'unknown',
});

/** 决策结论（comparisonResult） */
export const COMPARISON_RESULTS = Object.freeze({
  UPGRADABLE: 'upgradable',
  UP_TO_DATE: 'up-to-date',
  INCOMPATIBLE: 'incompatible',
  UNCOMPARABLE: 'uncomparable',
  ERROR: 'error',
});

/**
 * 不可比较 / 不参与版本检测的浮动 tag。
 *
 * 与 validate-batch.mjs 的 NON_VERSION_TAGS 保持一致（避免 lint 行为漂移），
 * 额外收录 'stable'（目标 §六明确列为浮动 tag）。
 */
export const NON_VERSION_TAGS = new Set([
  'latest', 'nightly', 'dev', 'edge', 'alpha', 'beta', 'rc', 'main', 'master', 'stable',
]);

/** 判定是否为"非版本词"（大小写不敏感）。 */
export function isNonVersionTag(tag) {
  return typeof tag === 'string' && NON_VERSION_TAGS.has(tag.toLowerCase());
}

/**
 * 预发布标识符关键词（SemVer prerelease 的首个标识符命中即视为预发布）。
 * 未命中且非纯数字的后缀一律视为**变体后缀**（variant）。
 */
export const PRERELEASE_KEYWORDS = new Set([
  'alpha', 'beta', 'rc', 'pre', 'preview', 'dev', 'nightly', 'snapshot',
  'next', 'canary', 'exp', 'cr', 'milestone', 'm',
]);

/** 数字点分段核心（可带 v/V 前缀）+ 可选变体后缀 + 可选构建元数据 */
const VERSION_BODY_RE = /^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
/** 纯哈希 / 提交号形态：sha-xxxx 或 7~40 位十六进制 */
const SHA_LIKE_RE = /^(?:sha[-_])?[0-9a-f]{7,40}$/i;
/** 变体前缀形态的前缀段（允许内部连字符：server-cuda12 / gpu-amd） */
const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;

/**
 * 解析 CalVer 日期值。
 *
 * 支持形态：
 *   · YYYYMMDD            (8 位)
 *   · YYYYMMDDHHMM        (10 位)
 *   · YYYYMMDDHHMMSS      (12 位)
 *   · YYMMDD              (6 位，20xx/19xx 按 00-69 / 70-99 判定)
 *   · YYYY.M.D / YYYY-MM-DD（点分或连字符，3 段且首段为 4 位年份）
 *
 * @param {string} core 纯数字 / 数字点分核心
 * @returns {{date:number, precision:'ymd'}|null} 非 CalVer 返回 null
 */
export function parseCalverDate(core) {
  if (typeof core !== 'string' || core.length === 0) return null;

  // 点分 / 连字符形态：3 段，首段必须是 4 位年份
  const parts = core.split(/[.-]/);
  if (parts.length === 3 && parts.every(p => /^\d+$/.test(p)) && /^\d{4}$/.test(parts[0])) {
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (year >= 1970 && year <= 2999 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { date: year * 10000 + month * 100 + day, precision: 'ymd' };
    }
    return null;
  }

  // 紧凑形态
  if (!/^\d+$/.test(core)) return null;
  const digits = core;
  const len = digits.length;
  let year = null;
  let month = null;
  let day = null;

  if (len === 8 || len === 10 || len === 12) {
    year = Number(digits.slice(0, 4));
    month = Number(digits.slice(4, 6));
    day = Number(digits.slice(6, 8));
  } else if (len === 6) {
    const yy = Number(digits.slice(0, 2));
    year = yy >= 70 ? 1900 + yy : 2000 + yy;
    month = Number(digits.slice(2, 4));
    day = Number(digits.slice(4, 6));
  } else {
    return null;
  }

  if (year < 1970 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { date: year * 10000 + month * 100 + day, precision: 'ymd' };
}

/**
 * 判断后缀是"预发布"还是"变体"。
 *
 * · 纯数字后缀（'1'）        → 预发布（SemVer 规范）
 * · 命中预发布关键词（'rc'）  → 预发布
 * · 其余（'alpine'/'ls36'…） → **变体后缀**
 *
 * @param {string} suffix '-' 之后的标识符串
 * @returns {{kind:'prerelease'|'variant', ids:string[]}}
 */
export function classifySuffix(suffix) {
  if (typeof suffix !== 'string' || suffix.length === 0) {
    return { kind: 'variant', ids: [] };
  }
  const ids = suffix.split('.');
  const first = ids[0];
  if (/^\d+$/.test(first)) return { kind: 'prerelease', ids };
  if (PRERELEASE_KEYWORDS.has(first.toLowerCase())) return { kind: 'prerelease', ids };
  return { kind: 'variant', ids };
}

/** 去掉数字段的前导零（'03.06.00' → [3,6,0]）；保留 0 本身。 */
function normalizeSegments(numbers) {
  return numbers.map(n => {
    const s = String(n);
    const stripped = s.replace(/^0+(?=\d)/, '');
    return Number(stripped);
  });
}

/**
 * 把数字段数组补齐到 3 段并构造 SemVer 比较对象。
 * @param {number[]} numbers
 * @param {string[]} prerelease
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string[],raw:string}}
 */
function toSemverObject(numbers, prerelease) {
  const n = numbers.slice(0, 3);
  while (n.length < 3) n.push(0);
  return {
    major: n[0], minor: n[1], patch: n[2],
    prerelease: prerelease || [],
    build: [],
    raw: n.join('.'),
  };
}

/**
 * 判定一个 tag 是否为「变体前缀形态」（`pg-1.16.0` / `server-cuda12-v0.4.1`）。
 *
 * 做法：按 '-' 从左到右尝试切分，取**第一个**使右侧能解析为可比版本的切点。
 *
 * @param {string} tag
 * @returns {{prefix:string, rest:string}|null}
 */
export function splitVariantPrefix(tag) {
  if (typeof tag !== 'string') return null;
  let idx = tag.indexOf('-');
  while (idx > 0) {
    const prefix = tag.slice(0, idx);
    const rest = tag.slice(idx + 1);
    if (PREFIX_RE.test(prefix)) {
      const inner = classifyVersionBody(rest);
      if (inner && inner.comparable) return { prefix, rest };
    }
    idx = tag.indexOf('-', idx + 1);
  }
  return null;
}

/**
 * 解析版本主体（不含变体前缀的部分）。
 * @param {string} body
 * @returns {object|null}
 */
function classifyVersionBody(body) {
  if (typeof body !== 'string' || body.length === 0) return null;

  // 纯浮动词（latest / stable / nightly …）→ 滚动 tag
  if (isNonVersionTag(body)) {
    return {
      scheme: SCHEMES.ROLLING,
      track: `rolling:${body.toLowerCase()}`,
      comparable: false,
      reason: `浮动/分支 tag（${body}）不参与版本比较`,
      original: body,
    };
  }

  // 虚线 CalVer：YYYY-MM-DD（**整体**是一个核心，不能被 '-' 后缀切分）
  // ⚠️ 必须早于 VERSION_BODY_RE —— 否则 '2026-11-04' 会被切成 core='2026' + suffix='11-04'
  const dashedCalver = /^\d{4}-\d{2}-\d{2}$/.test(body);
  const m = dashedCalver ? null : VERSION_BODY_RE.exec(body);
  if (dashedCalver) {
    const calver = parseCalverDate(body);
    if (calver) {
      return {
        scheme: SCHEMES.CALVER,
        track: 'calver',
        comparable: true,
        kind: 'calver',
        core: { kind: 'calver', date: calver.date, numbers: [] },
        variant: null,
        prerelease: null,
        build: null,
        isRelease: true,
        segmentCount: null,
        original: body,
        reason: null,
      };
    }
  }
  if (!m) {
    // 变体前缀 + 浮动词（a2b-latest / gpu-amd-latest）→ 滚动 tag
    // ⚠️ 只能在「整体不是版本形态」之后才生效：'1.2.0-alpha' 是**预发布版本**，
    //    不是滚动 tag（否则预发布会被误判成不可比较）。
    const lastDash = body.lastIndexOf('-');
    if (lastDash > 0 && isNonVersionTag(body.slice(lastDash + 1))) {
      return {
        scheme: SCHEMES.ROLLING,
        track: `rolling:${body.toLowerCase()}`,
        comparable: false,
        reason: `浮动/分支 tag（${body}）不参与版本比较`,
        original: body,
      };
    }

    // 提交号形态（sha-xxxx / 7~40 位十六进制）→ 不可比较
    // ⚠️ 必须在数字形态判定**之后**：'20220121' 既是合法十六进制、又是合法日期。
    if (SHA_LIKE_RE.test(body)) {
      return {
        scheme: SCHEMES.UNKNOWN,
        track: `sha:${body.toLowerCase()}`,
        comparable: false,
        reason: `提交号形态 tag（${body}）不可比较`,
        original: body,
      };
    }
    return {
      scheme: SCHEMES.UNKNOWN,
      track: `unknown:${body.toLowerCase()}`,
      comparable: false,
      reason: `无法识别的版本形态（${body}）`,
      original: body,
    };
  }

  const [, coreStr, suffix, build] = m;
  const rawSegments = coreStr.split('.');
  const numbers = normalizeSegments(rawSegments);
  const segmentCount = rawSegments.length;

  const suffixInfo = suffix ? classifySuffix(suffix) : { kind: 'variant', ids: [] };
  const isPrerelease = suffixInfo.kind === 'prerelease';
  const variant = !isPrerelease && suffix ? suffix : null;

  // ── CalVer 判定：核心整体是日期 ──────────────────────────────────────
  const calver = parseCalverDate(coreStr);
  if (calver) {
    // CalVer 的后缀视为构建标识（searxng 的 commit SHA / jellyfin 的 arm64），
    // **不参与轨道与比较** —— 否则每个 SHA 都会自成一轨，永远无法升级。
    return {
      scheme: SCHEMES.CALVER,
      track: 'calver',
      comparable: true,
      kind: 'calver',
      core: { kind: 'calver', date: calver.date, numbers },
      variant: null,
      prerelease: null,
      build: build ? build.split('.') : null,
      isRelease: true,
      segmentCount,
      original: body,
      reason: null,
    };
  }

  // ── 数字点分段族（semver / 两段式 / 多段式 / 变体）──────────────────
  const track = variant ? `num:${segmentCount}@${variant.toLowerCase()}` : `num:${segmentCount}`;
  const semverObj = toSemverObject(numbers, isPrerelease ? suffixInfo.ids : []);

  return {
    scheme: variant ? SCHEMES.VARIANT : SCHEMES.SEMVER,
    track,
    comparable: true,
    kind: 'numeric',
    core: { kind: 'numeric', numbers, semver: semverObj },
    variant,
    prerelease: isPrerelease ? suffixInfo.ids : null,
    build: build ? build.split('.') : null,
    isRelease: !isPrerelease,
    segmentCount,
    original: body,
    reason: null,
  };
}

/**
 * **版本分类器**（全局唯一入口）。
 *
 * @param {string} tag 镜像 tag
 * @returns {{
 *   original: string,
 *   scheme: string,        // SCHEMES.*
 *   track: string,         // 轨道键；只有同轨道才可比较
 *   comparable: boolean,
 *   prefix: string|null,   // 变体前缀（pg / server-cuda12 …）
 *   variant: string|null,  // 变体后缀（alpine / ls36 / arm32v7 …）
 *   prerelease: string[]|null,
 *   build: string[]|null,
 *   isRelease: boolean,
 *   segmentCount: number|null,
 *   core: object|null,
 *   reason: string|null,   // 不可比较的原因
 * }|null}
 */
export function classifyVersion(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (trimmed.length === 0) return null;

  // ── 裸变体前缀（'pg' / 'railway'）────────────────────────────────────
  // 形态：`pg` → 候选是 `pg-1.16.0`。上游把「变体名」单独作为 tag 发布时使用。
  // 这里把裸词视作**前缀轨道**，具体版本由候选的 `pg-<版本>` 提供。
  // ⚠️ 必须排除 Commit SHA 形态：'a1b2c3d' / 'deadbeef' 是 7~40 位十六进制，
  //    不是变体前缀（否则会被当成可比较的裸前缀轨道）。
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed) && !isNonVersionTag(trimmed) && !SHA_LIKE_RE.test(trimmed)) {
    return {
      original: trimmed,
      scheme: SCHEMES.UNKNOWN,
      track: `pfx:${trimmed.toLowerCase()}@*`,
      comparable: true,
      kind: 'prefix-only',
      prefix: trimmed,
      variant: null,
      prerelease: null,
      build: null,
      isRelease: true,
      segmentCount: null,
      core: null,
      reason: null,
    };
  }

  // ── 变体前缀形态：pg-1.16.0 / server-cuda12-v0.4.1 ───────────────────
  const prefixSplit = splitVariantPrefix(trimmed);
  if (prefixSplit) {
    const inner = classifyVersionBody(prefixSplit.rest);
    if (inner) {
      return {
        ...inner,
        prefix: prefixSplit.prefix,
        track: `pfx:${prefixSplit.prefix.toLowerCase()}@${inner.track}`,
        original: trimmed,
      };
    }
  }

  const body = classifyVersionBody(trimmed);
  if (!body) return null;
  return { ...body, prefix: null, original: trimmed };
}

/**
 * 轨道亲和性：两个 tag 是否属于**同一轨道**（可安全比较）。
 * @param {string|object} a tag 或 classifyVersion 的结果
 * @param {string|object} b
 * @returns {boolean}
 */
export function sameTrack(a, b) {
  const ca = typeof a === 'string' ? classifyVersion(a) : a;
  const cb = typeof b === 'string' ? classifyVersion(b) : b;
  if (!ca || !cb) return false;
  if (!ca.comparable || !cb.comparable) return false;
  return ca.track === cb.track;
}

/**
 * 比较两个版本。
 *
 * @param {string|object} a
 * @param {string|object} b
 * @returns {-1|0|1|null} null = 不可比较（跨方案 / 跨轨道 / 不可识别）
 */
export function compareVersions(a, b) {
  const ca = typeof a === 'string' ? classifyVersion(a) : a;
  const cb = typeof b === 'string' ? classifyVersion(b) : b;
  if (!ca || !cb) return null;
  if (!ca.comparable || !cb.comparable) return null;
  // 跨轨道 → 不可比（R2：变体不同绝不混比）
  if (ca.track !== cb.track) return null;

  if (ca.core.kind === 'calver' && cb.core.kind === 'calver') {
    if (ca.core.date !== cb.core.date) return ca.core.date < cb.core.date ? -1 : 1;
    return 0;
  }

  if (ca.core.kind === 'numeric' && cb.core.kind === 'numeric') {
    const na = ca.core.numbers;
    const nb = cb.core.numbers;
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
      const va = na[i] ?? 0;
      const vb = nb[i] ?? 0;
      if (va !== vb) return va < vb ? -1 : 1;
    }
    // 数值段相同 → 比较预发布（SemVer 优先级：预发布 < 正式版）
    const pa = ca.prerelease || [];
    const pb = cb.prerelease || [];
    if (pa.length === 0 && pb.length === 0) return 0;
    if (pa.length === 0) return 1;   // 正式版高于同号预发布版
    if (pb.length === 0) return -1;
    return comparePrerelease(pa, pb);
  }

  return null;
}

/**
 * 候选选型：**只在与当前同轨道的候选里**取最大版本。
 *
 * 铁律落地：
 *   R2 同轨道过滤（跨变体 / 跨方案一律出局）
 *   R3 正式版不升预发布
 *   R4 禁止降级
 *   R5 构建元数据不触发升级（比较只看 SemVer 优先级）
 *
 * @param {string} currentTag 当前使用的 tag
 * @param {string[]} candidates 上游候选 tag 列表
 * @param {{exclude?:(t:string)=>boolean, include?:(t:string)=>boolean}} [options]
 * @returns {{
 *   tag: string|null,
 *   comparison: 'upgradable'|'up-to-date'|'incompatible'|'uncomparable',
 *   reason: string,
 *   current: object|null,
 *   candidate: object|null,
 * }}
 */
export function selectCandidate(currentTag, candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];

  // ── 无当前上下文（调用方未给 currentTag）─────────────────────────────
  // 此时无法做轨道亲和判定，只能在**单一轨道内**取最大（绝不跨轨道混选）。
  if (!currentTag) {
    const comparable = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      if (options.include && !options.include(raw)) continue;
      if (options.exclude && options.exclude(raw)) continue;
      const c = classifyVersion(raw);
      if (!c || !c.comparable) continue;
      comparable.push(c);
    }
    if (comparable.length === 0) {
      return {
        tag: null,
        comparison: COMPARISON_RESULTS.UNCOMPARABLE,
        reason: '上游没有可识别的版本 tag',
        current: null,
        candidate: null,
      };
    }
    const groups = new Map();
    for (const c of comparable) {
      if (!groups.has(c.track)) groups.set(c.track, []);
      groups.get(c.track).push(c);
    }
    // 优先选「无变体后缀」的主轨道，其次取第一个轨道
    let pool = groups.get('num:3');
    if (!pool) {
      pool = [...groups.values()].find(g => g.every(x => !x.variant)) || [...groups.values()][0];
    }
    let best = pool[0];
    for (const c of pool.slice(1)) {
      const r = compareVersions(c, best);
      if (r !== null && r > 0) best = c;
    }
    return {
      tag: best.original,
      comparison: COMPARISON_RESULTS.UPGRADABLE,
      reason: `（无当前版本上下文）选出同轨道最新：${best.original}`,
      current: null,
      candidate: best,
    };
  }

  const current = classifyVersion(currentTag);
  if (!current) {
    return {
      tag: null,
      comparison: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: `当前 tag「${currentTag}」无法识别，需人工确认`,
      current: null,
      candidate: null,
    };
  }
  if (!current.comparable) {
    return {
      tag: null,
      comparison: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: current.reason || `当前 tag「${currentTag}」不可比较，需人工确认`,
      current,
      candidate: null,
    };
  }

  // ── 裸变体前缀当前（'pg' → 'pg-1.16.0'）────────────────────────────
  if (current.kind === 'prefix-only') {
    const eligible = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      if (options.include && !options.include(raw)) continue;
      if (options.exclude && options.exclude(raw)) continue;
      const c = classifyVersion(raw);
      if (!c || !c.comparable) continue;
      if (c.kind === 'prefix-only') continue;
      if (c.prefix && c.prefix.toLowerCase() === current.prefix.toLowerCase()) eligible.push(c);
    }
    if (eligible.length === 0) {
      return {
        tag: current.original,
        comparison: COMPARISON_RESULTS.UP_TO_DATE,
        reason: `上游没有变体前缀「${current.prefix}」的版本化 tag，保持不变`,
        current,
        candidate: null,
      };
    }
    let best = eligible[0];
    for (const c of eligible.slice(1)) {
      const r = compareVersions(c, best);
      if (r !== null && r > 0) best = c;
    }
    if (best.original === current.original) {
      return {
        tag: best.original,
        comparison: COMPARISON_RESULTS.UP_TO_DATE,
        reason: `已是最新（${current.original}）`,
        current,
        candidate: best,
      };
    }
    return {
      tag: best.original,
      comparison: COMPARISON_RESULTS.UPGRADABLE,
      reason: `${current.original} → ${best.original}`,
      current,
      candidate: best,
    };
  }

  const eligible = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (options.include && !options.include(raw)) continue;
    if (options.exclude && options.exclude(raw)) continue;
    const c = classifyVersion(raw);
    if (!c || !c.comparable) continue;
    if (c.track !== current.track) continue;      // R2 轨道亲和
    if (current.isRelease && !c.isRelease) continue; // R3 正式版不升预发布
    eligible.push(c);
  }

  if (eligible.length === 0) {
    return {
      tag: null,
      comparison: COMPARISON_RESULTS.INCOMPATIBLE,
      reason: `上游没有与当前轨道「${current.track}」兼容的候选 tag（严禁跨轨道升级）`,
      current,
      candidate: null,
    };
  }

  // 同轨道内取最大（比较只看 SemVer 优先级，构建元数据不参与 → R5）
  let best = eligible[0];
  for (const c of eligible.slice(1)) {
    const r = compareVersions(c, best);
    if (r === null) continue;
    if (r > 0) best = c;
  }

  const cmp = compareVersions(best, current);
  if (cmp === null) {
    return {
      tag: null,
      comparison: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: `候选「${best.original}」与当前「${current.original}」不可比较，需人工确认`,
      current,
      candidate: best,
    };
  }
  if (cmp < 0) {
    return {
      tag: null,
      comparison: COMPARISON_RESULTS.INCOMPATIBLE,
      reason: `候选「${best.original}」低于当前「${current.original}」，拒绝未授权降级`,
      current,
      candidate: best,
    };
  }
  if (cmp === 0) {
    return {
      tag: best.original,
      comparison: COMPARISON_RESULTS.UP_TO_DATE,
      reason: `已是最新（${current.original}）`,
      current,
      candidate: best,
    };
  }
  return {
    tag: best.original,
    comparison: COMPARISON_RESULTS.UPGRADABLE,
    reason: `${current.original} → ${best.original}`,
    current,
    candidate: best,
  };
}

// ── lint 侧：版本"形态"判定（保持既有语义，仅收敛实现位置）────────────────

/**
 * tag 是否为**可识别的版本形态**（lint 校验用）。
 *
 * ⚠️ 与 classifyVersion 的区别：这里只回答"长得像不像版本"，
 *    不回答"能不能比较"。'16-alpine' / '3-management' 是**形态合法**的
 *    （lint 不应报错），但**不可比较**（detect 必须跳过）。
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isVersionShapedTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) return false;
  if (isNonVersionTag(tag)) return false;
  if (!/\d/.test(tag)) return false;
  if (isValidSemver(tag)) return true;
  // 数字 / v+数字 起头，后续段可带字母
  if (/^v?\d+(?:[.-][0-9A-Za-z][0-9A-Za-z.-]*)*$/.test(tag)) return true;
  // 字母起头，形如 a2b-stable-25-08-12 / full-v1.12.2-arm64
  if (/^[A-Za-z][0-9A-Za-z]*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)+$/.test(tag)) return true;
  return false;
}

// ── lint 侧：版本目录名归一化（保持既有语义，仅收敛实现位置）───────────────

/** 变体尾巴（与 consistency.mjs 既有实现逐字一致，行为保持不变） */
const TAG_STRIP_TAIL_RE = /-(ls\d+|arm32v\d|arm64v\d|amd64|aarch64|alpine|slim|fon|nvidia|cuda[\d.a-z]*|cu\d+|vulkan|apache|py\d\.\d+)$/i;

/**
 * 版本目录 / tag 归一化（lint 的 tag↔dir 判定用）。
 * @param {string} str
 * @returns {string}
 */
export function normalizeVersionToken(str) {
  let s = String(str);
  // 功能前缀（anythingllm 的 pg-1.16.0 是 postgres 打包变体，主线版本就是 1.16.0）
  s = s.replace(/^(pg-|server-)/i, '');
  // 版本前缀 v（后随数字才剥离，避免把 v-name 撞成空）
  s = s.replace(/^v(?=[0-9])/, '');
  // 变体尾巴：-ls36 / -arm32v7 / -alpine / -cu124 / -vulkan / -fon …
  s = s.replace(TAG_STRIP_TAIL_RE, '');
  // 变体尾巴可能连缀（如 26.08.2-1-fon → 剥 -fon 后仍是 26.08.2-1，不再继续剥）
  s = s.replace(/-arm\d*v\d+|-(arm64|amd64|aarch64)$/i, '');
  // 日期型（silo/co WJ 格式）：RELEASE.2026-08-01 → 2026-08-01
  s = s.replace(/^RELEASE\./, '');
  return s.toLowerCase();
}

/**
 * 版本目录是否可参与 tag.dir 校验的准入门槛。
 * @param {string} dirName
 * @returns {boolean}
 */
export function isVersionShapedDir(dirName) {
  const n = normalizeVersionToken(dirName);
  return /^(?:\d+(?:[.-]\d+){0,3}|\d{4,13})$/.test(n) || /^\d{4}[.-]\d{1,2}(-\d{1,2})?/.test(n);
}

// ── 版本目录选型（收敛两处重复实现，行为按 mode 显式区分）───────────────

/**
 * 从版本目录名列表中选出"最新"的目录名。
 *
 * @param {string[]} dirs
 * @param {'strict'|'archive'} [mode]
 *   · 'strict'  —— tier-1 只认**严格 SemVer** 目录，tier-2 只认 `v?数字` 目录。
 *                   detect 的跨版本保护（maxKnown）用这个口径。
 *   · 'archive' —— 历史归档口径：全部候选按数字段比较，数字段相同时取目录名字典序大者。
 *                   README「当前版本」列与批次校验用这个口径（**行为必须保持不变**）。
 * @returns {string|null}
 */
export function pickNewestVersionDir(dirs, mode = 'strict') {
  if (!Array.isArray(dirs) || dirs.length === 0) return null;
  const names = dirs.filter(d => typeof d === 'string' && d.length > 0);
  if (names.length === 0) return null;

  const pickByLoose = (pool) => {
    let best = pool[0];
    for (const d of pool.slice(1)) {
      const r = compareVersionsLooseNumeric(d, best);
      if (r > 0 || (r === 0 && d.localeCompare(best) > 0)) best = d;
    }
    return best;
  };

  if (mode === 'archive') {
    return pickByLoose(names);
  }

  const semverDirs = names.filter(isValidSemver);
  if (semverDirs.length > 0) return pickByLoose(semverDirs);
  const numeric = names.filter(d => /^v?\d/i.test(d));
  if (numeric.length === 0) return null;
  return pickByLoose(numeric);
}

/**
 * 宽松"数字段比较"（仅用于**版本目录归档选择**，不是 SemVer 比较）。
 *
 * ⚠️ 本函数**委托**给 semver.mjs 的 compareVersionsLoose（唯一实现），
 *    此处只保留一个语义明确的别名，避免出现第二份比较逻辑。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 负数 a<b，正数 a>b，0 相等
 */
export function compareVersionsLooseNumeric(a, b) {
  return compareVersionsLoose(a, b);
}
