// lib/decision.mjs — 统一更新决策引擎（Update Decision Engine）
//
// ── 职责 ──────────────────────────────────────────────────────────────────
// 把「当前镜像 / 当前 tag / 上游候选 tag」收敛成**一个**标准化结构化决策对象。
// 所有调用方（detect-updates / 未来其它消费方）只读这一个对象，
// 杜绝「每个脚本各写一套 if 判断」导致的口径漂移。
//
// ── 决策铁律（目标 §九）──────────────────────────────────────────────────
//  L1 只有 comparisonResult === 'upgradable' 且版本策略完全可信时，
//     shouldUpdate 才允许为 true。
//  L2 以下情形 shouldUpdate 一律 false，并记录精确 reason：
//     · 相同版本（含仅构建元数据 `+build` 不同）
//     · 无法比较（uncomparable）
//     · 跨变体 / 跨方案不兼容（incompatible）
//     · 浮动 Tag（rolling-tag，未开启摘要追踪）
//     · 疑似降级（候选低于当前）
//  L3 错误（Registry 故障等）→ comparisonResult='error'，shouldUpdate=false。
//
// ── 字段与目标 §七的 JSON 契约一一对应 ───────────────────────────────────
//   { appKey, currentImage, currentVersion, candidateVersion,
//     versionScheme, comparisonResult, shouldUpdate, reason, source }

import { classifyVersion, selectCandidate, COMPARISON_RESULTS, SCHEMES } from './version.mjs';
import { parseImageReference } from './image-ref.mjs';

export { COMPARISON_RESULTS, SCHEMES };

/**
 * 构造一个 Decision Result（字段与目标 §七契约严格一致）。
 *
 * @param {{
 *   appKey?: string,
 *   currentImage?: string,
 *   currentVersion?: string|null,
 *   candidateVersion?: string|null,
 *   versionScheme?: string,
 *   comparisonResult?: string,
 *   shouldUpdate?: boolean,
 *   reason?: string,
 *   source?: string,
 * }} [init]
 * @returns {object}
 */
export function createDecisionResult(init = {}) {
  const comparisonResult = init.comparisonResult || COMPARISON_RESULTS.UNCOMPARABLE;
  return {
    appKey: init.appKey || '',
    currentImage: init.currentImage || '',
    currentVersion: init.currentVersion ?? null,
    candidateVersion: init.candidateVersion ?? null,
    versionScheme: init.versionScheme || SCHEMES.UNKNOWN,
    comparisonResult,
    // L1：shouldUpdate 由 comparisonResult 唯一推导，杜绝两处口径不一致
    shouldUpdate: comparisonResult === COMPARISON_RESULTS.UPGRADABLE,
    reason: init.reason || '',
    source: init.source || 'custom',
  };
}

/**
 * 决策引擎主入口。
 *
 * @param {{
 *   appKey?: string,
 *   currentImage?: string,     // 当前完整镜像引用（含 tag）
 *   currentTag?: string,       // 当前 tag（缺省时从 currentImage 解析）
 *   candidates?: string[],      // 上游候选 tag 列表
 *   source?: string,           // 'dockerhub' | 'ghcr' | 'custom'
 *   error?: Error|string|null, // 上游故障（Registry 报错等）
 *   tagSuffix?: string,        // per-app tag 后缀亲和（如 'ce' → 只在 -ce 变体内选型；透传给 selectCandidate R6）
 * }} input
 * @returns {object} Decision Result
 */
export function decideUpdate(input = {}) {
  const { appKey = '', currentImage = '', candidates = [], error = null } = input;

  // ── 错误分级：Registry 故障 / 限流 → error（**绝不能**当成"无更新"）────
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createDecisionResult({
      appKey,
      currentImage,
      comparisonResult: COMPARISON_RESULTS.ERROR,
      reason: `Registry 查询失败：${message}`,
      source: input.source,
    });
  }

  const parsed = currentImage ? parseImageReference(currentImage) : null;
  const currentTag = input.currentTag ?? (parsed ? parsed.tag : null);
  const source = input.source || (parsed ? parsed.source : 'custom');

  if (!currentTag) {
    return createDecisionResult({
      appKey,
      currentImage,
      comparisonResult: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: '当前镜像没有 tag，无法进行版本判定',
      source,
    });
  }

  const current = classifyVersion(currentTag);
  if (!current) {
    return createDecisionResult({
      appKey,
      currentImage,
      currentVersion: currentTag,
      comparisonResult: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: `当前 tag「${currentTag}」无法识别，需人工确认`,
      source,
    });
  }

  // ── 浮动 Tag（latest / stable / nightly …）→ 不参与版本判定 ────────────
  if (current.scheme === SCHEMES.ROLLING) {
    return createDecisionResult({
      appKey,
      currentImage,
      currentVersion: currentTag,
      versionScheme: SCHEMES.ROLLING,
      comparisonResult: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: current.reason || `浮动 tag「${currentTag}」不参与版本检测`,
      source,
    });
  }

  // ── Digest 锁定 → 版本由摘要决定，不参与版本更新 ─────────────────────
  if (parsed && parsed.digest) {
    return createDecisionResult({
      appKey,
      currentImage,
      currentVersion: currentTag,
      versionScheme: SCHEMES.PINNED_DIGEST,
      comparisonResult: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: '镜像由 digest 锁定（摘要决定版本），不参与版本更新',
      source,
    });
  }

  // 上游**完全没有**可比版本（只有 latest/nightly 等滚动 tag）→ 无稳定 tag
  const hasComparable = candidates.some(t => {
    const c = classifyVersion(t);
    return !!c && c.comparable;
  });
  if (!hasComparable) {
    return createDecisionResult({
      appKey,
      currentImage,
      currentVersion: currentTag,
      versionScheme: current.scheme,
      comparisonResult: COMPARISON_RESULTS.UNCOMPARABLE,
      reason: 'Registry 未返回可用的稳定 tag',
      source,
    });
  }

  const selection = selectCandidate(
    currentTag,
    candidates,
    input.tagSuffix != null ? { tagSuffix: input.tagSuffix } : {},
  );

  const decision = createDecisionResult({
    appKey,
    currentImage,
    currentVersion: currentTag,
    candidateVersion: selection.tag ?? null,
    versionScheme: current.scheme,
    comparisonResult: selection.comparison,
    reason: selection.reason,
    source,
  });

  return decision;
}

/**
 * 判定两个 tag 是否属于同一更新轨道（变体同轨保护的可复用入口）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameUpdateTrack(a, b) {
  const ca = classifyVersion(a);
  const cb = classifyVersion(b);
  if (!ca || !cb) return false;
  return ca.track === cb.track;
}
