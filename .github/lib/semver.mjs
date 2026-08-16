// lib/semver.mjs — 语义版本解析与比较工具

/**
 * 解析版本字符串，去前导 v、前置 pre-release、拆分为数字段数组
 * 缺位补 0 以便统一比较
 * @param {string} v 版本字符串
 * @returns {number[]} 数字段数组
 */
export function parse(v) {
  // 去除前导 v（大小写不敏感）
  let s = v.replace(/^v/i, '');
  // 去除 pre-release 后缀（如 -alpha、-rc1、+sha.abc）
  s = s.replace(/-.*$/, '').replace(/\+.*$/, '');
  // 按 . 分割，每段转数字，缺失补 0
  return s.split('.').map(Number).map(n => isNaN(n) ? 0 : n);
}

/**
 * 逐段比较两个版本
 * @param {string} a 版本字符串 a
 * @param {string} b 版本字符串 b
 * @returns {number} 负数 a<b，正数 a>b，0 相等
 */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    // 循环补 0：超出长度的段视为 0
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * 判断版本是否稳定（非预发布/非 daily-build）
 * 黑名单：latest, nightly, dev, edge, alpha, beta, rc, main, master（不区分大小写）
 * @param {string} v 版本字符串
 * @returns {boolean}
 */
export function isStable(v) {
  const UNSTABLE_RE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i;
  // 取第一段（去 v 前缀后）判断
  const first = v.replace(/^v/i, '').split('.')[0].split('-')[0].split('+')[0];
  return !UNSTABLE_RE.test(first);
}

/**
 * 从列表中选取最新版本
 * 策略：纯 semver（/^v?\d+\.\d+\.\d+$/）优先，若无纯 semver 则全表字典序
 * @param {string[]} list 版本字符串数组
 * @returns {string|null}
 */
export function pickLatest(list) {
  if (!list || list.length === 0) return null;

  // 纯 semver 过滤：仅 x.y.z 格式（允许前导 v）
  const PURE_SEMVER_RE = /^v?\d+\.\d+\.\d+$/;
  const pure = list.filter(t => PURE_SEMVER_RE.test(t));

  let candidates;
  if (pure.length > 0) {
    // 纯 semver 非空 → 以这些为准
    candidates = pure;
  } else {
    // 无纯 semver，退化为全表
    candidates = list;
  }

  // 按 compare 升序；compare 相等时用 localeCompare(a,b) 作 tiebreak，
  // 使得字典序小的排在后面，这样取末位时得到字典序小的（同语义版本内选"保守"的）
  candidates.sort((a, b) => {
    const r = compare(a, b);
    if (r !== 0) return r;
    return a.localeCompare(b);
  });
  return candidates[candidates.length - 1];
}
