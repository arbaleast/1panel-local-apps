// lib/semver.mjs — 语义版本解析与比较工具
//
// 本模块刻意区分两套语义，禁止混用：
//
//   1. 严格 SemVer 2.0.0（parseSemver / compareSemver / isValidSemver / isSemver）
//      —— 只承认 `major.minor.patch[-prerelease][+build]`（允许单个前导 v/V）。
//      —— latest / nightly / dev / edge / 2026091410-arm64 / 26.04.5.1.1 /
//         full-v1.12.2-arm64 / a2b-stable-25-08-12 等镜像 tag 一律判为非法。
//
//   2. 宽松“数字段比较”（parse / compare / compareVersionsLoose）
//      —— 剥掉 v 前缀与 `-`/`+` 之后的部分，按 `.` 拆数字段逐段比，
//         非数字段按 0 处理。
//      —— 只允许用于“已知形态 tag”的排序 / 版本目录归档选择，
//         **绝不可用于 SemVer 判定**（否则日期型 tag 2026091410 会压过 10.11.11）。
//
// ⚠️ 关键修复（audit task 4）：`latest` / `nightly` / `dev` 这类**不含数字**的 tag
//    以前会被宽松解析成 `[0]`（等价 0.0.0），既污染比较结果，也会被 pickLatest
//    当成“最新版本”选出去。现在 `parse()` 对无数字输入一律返回 `null`，
//    `compare()` 改为 null 安全（非版本排在最低位），`pickLatest()` 直接忽略它们。

// ---------------------------------------------------------------------------
// 严格 SemVer
// ---------------------------------------------------------------------------

// major.minor.patch 三段 + 可选 prerelease + 可选 build
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i;
// 纯数字标识符：不允许前导零（"0" 本身合法）
const NUMERIC_ID_RE = /^(?:0|[1-9]\d*)$/;
// prerelease 标识符：纯数字（无前导零）或含字母/连字符的字母数字串
const PRERELEASE_ID_RE = /^(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/;
// build 标识符：任意字母数字与连字符
const BUILD_ID_RE = /^[0-9A-Za-z-]+$/;
// 纯 semver（三段，无 prerelease / build）—— pickLatest 的第一优先层
const PURE_SEMVER_RE = /^v?\d+\.\d+\.\d+$/;

/**
 * 严格解析 SemVer 2.0.0 版本串
 *
 * 规则：可选单个前导 `v`；`major.minor.patch` 三段数字段且**不允许前导零**；
 * 可选 prerelease（`-` + 点分标识符，纯数字标识符不允许前导零）；
 * 可选 build metadata（`+` + 点分字母数字标识符）。其余一律返回 null。
 *
 * ⚠️ 注意：形如 `v3.2.18-arm32v7` 的**架构后缀**在 SemVer 2.0.0 里其实是
 *    一个 prerelease 标识符（`arm32v7`），因此它**是**合法严格 SemVer；
 *    但跨不同后缀组（如 `3.2.18-arm32v7` vs `3.2.18-arm64v8`）比较**没有意义**，
 *    调用方必须先按后缀分组，再在组内比较。
 *
 * @param {string} v 版本字符串
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string[],raw:string}|null}
 */
export function parseSemver(v) {
  if (typeof v !== 'string' || v.length === 0) return null;

  const m = SEMVER_RE.exec(v);
  if (!m) return null;

  const [, majStr, minStr, patStr, preStr, buildStr] = m;

  // 前导零检查
  if (!NUMERIC_ID_RE.test(majStr) || !NUMERIC_ID_RE.test(minStr) || !NUMERIC_ID_RE.test(patStr)) {
    return null;
  }

  const prerelease = preStr === undefined ? [] : preStr.split('.');
  for (const id of prerelease) {
    if (!PRERELEASE_ID_RE.test(id)) return null;
  }

  const build = buildStr === undefined ? [] : buildStr.split('.');
  for (const id of build) {
    if (!BUILD_ID_RE.test(id)) return null;
  }

  return {
    major: Number(majStr),
    minor: Number(minStr),
    patch: Number(patStr),
    prerelease,
    build,
    raw: v,
  };
}

/**
 * 是否为严格合法的 SemVer 2.0.0 版本串
 * @param {string} v
 * @returns {boolean}
 */
export function isValidSemver(v) {
  return parseSemver(v) !== null;
}

/**
 * isSemver —— isValidSemver 的别名（历史命名，保持向后兼容）
 * @param {string} v
 * @returns {boolean}
 */
export function isSemver(v) {
  return isValidSemver(v);
}

/**
 * 比较两段 prerelease 标识符列表（SemVer 优先级规则）
 *
 * ⚠️ 本函数原先是模块私有。lib/version.mjs 的版本引擎需要它来比较
 *    **多段数字版本**（如 `26.04.5.1.1`）的预发布后缀 —— 那类版本
 *    无法用三段 SemVer 对象表达，但 prerelease 标识符的优先级规则
 *    与 SemVer 2.0.0 完全一致。导出为纯增量，不改变任何既有行为。
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {-1|0|1}
 */
export function comparePrerelease(a, b) {
  // 无 prerelease 的版本优先级更高
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    // 标识符更少者优先级更低（1.0.0-alpha < 1.0.0-alpha.1）
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const x = a[i];
    const y = b[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);

    if (xNum && yNum) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum) {
      return -1; // 纯数字标识符优先级低于字母数字标识符
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII 字典序
    }
  }
  return 0;
}

/**
 * 把入参规整成 parseSemver 的结果结构
 * @param {string|{major:number,minor:number,patch:number,prerelease?:string[],build?:string[],raw?:string}} v
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string[],raw:string}|null}
 */
function toSemver(v) {
  if (typeof v === 'string') return parseSemver(v);
  if (v && typeof v === 'object'
    && Number.isInteger(v.major) && Number.isInteger(v.minor) && Number.isInteger(v.patch)
    && (v.prerelease === undefined || Array.isArray(v.prerelease))
    && (v.build === undefined || Array.isArray(v.build))) {
    return {
      major: v.major,
      minor: v.minor,
      patch: v.patch,
      prerelease: v.prerelease ?? [],
      build: v.build ?? [],
      raw: typeof v.raw === 'string' ? v.raw : `${v.major}.${v.minor}.${v.patch}`,
    };
  }
  return null;
}

/**
 * 严格比较两个 SemVer 版本（SemVer 2.0.0 优先级）
 *
 * - 先按 major / minor / patch 数值比较；
 * - 带 prerelease 的版本优先级**低于**同版本号的正式版；
 * - prerelease 标识符从左到右比较：纯数字按数值比，纯字母数字按 ASCII 字典序比，
 *   纯数字优先级低于纯字母数字；全部相等而长度不同时，短者优先级更低；
 * - build metadata **不参与**比较。
 *
 * @param {string|{major:number,minor:number,patch:number,prerelease?:string[],build?:string[],raw?:string}} a 版本串或 parseSemver 的结果对象
 * @param {string|{major:number,minor:number,patch:number,prerelease?:string[],build?:string[],raw?:string}} b 版本串或 parseSemver 的结果对象
 * @returns {-1|0|1}
 * @throws {TypeError} 任一参数不是合法的严格 SemVer（版本串或结构对象）
 */
export function compareSemver(a, b) {
  const pa = toSemver(a);
  const pb = toSemver(b);
  if (!pa) throw new TypeError(`invalid semver: ${JSON.stringify(a)}`);
  if (!pb) throw new TypeError(`invalid semver: ${JSON.stringify(b)}`);

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  return comparePrerelease(pa.prerelease, pb.prerelease);
}

// ---------------------------------------------------------------------------
// 宽松数字段比较（非 SemVer）
// ---------------------------------------------------------------------------

/**
 * 剥掉 build metadata（`+...`）与 prerelease（`-...`）
 *
 * ⚠️ prerelease 只在“连字符之前已经完全是一个纯数字点分核心”时才剥掉，
 *    否则 `server-cuda12-v0.4.1` 会被截成 `server`（丢掉真正的 0.4.1）。
 *
 * @param {string} s
 * @returns {string}
 */
function stripSuffix(s) {
  // build metadata 一律剥掉
  let out = s.replace(/\+.*$/, '');
  // prerelease：`-` 之前必须是纯数字点分核心
  const m = /^(\d+(?:\.\d+)*)-(.*)$/.exec(out);
  if (m) out = m[1];
  return out;
}

/**
 * 宽松解析：剥掉前导 v 与 `-`/`+` 之后的部分，按 `.` 拆数字段，缺位补 0
 *
 * 规则：
 *  - 非字符串输入 → `null`；
 *  - **完全不含数字**的输入（`latest` / `nightly` / `dev` / `edge` / `''` …）→ `null`
 *    （修复：以前这些 tag 会被当成 `[0]`，即 0.0.0）；
 *  - 含数字但某段不是数字（`server-cuda12-v0.4.1`）→ 保持历史宽松语义，
 *    该段按 0 处理。
 *
 * @param {string} v
 * @returns {number[]|null}
 */
export function parse(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/^v/i, '');
  s = stripSuffix(s);
  if (!/\d/.test(s)) return null;
  return s.split('.').map((seg) => {
    const m = /^\d+/.exec(seg);
    return m ? Number(m[0]) : 0;
  });
}

/**
 * 宽松逐段比较两个版本（null 安全）
 *
 * - 两侧都解析不出版本（null）→ 0；
 * - 仅 a 为 null → -1（非版本排在最低位，保持 `latest < 1.0.0` 的历史序）；
 * - 仅 b 为 null → 1；
 * - 否则逐段数值比较，缺位补 0（`compare('1.0.0','1.0.0.0') === 0`）。
 *
 * ⚠️ 该比较**不是** SemVer 比较：它会把 `2026091410-arm64` 看成 [2026091410]，
 * 把 `1.2.0-rc.1` 看成 [1,2,0]。只可用于“已知形态 tag”的排序 / 归档选择。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 负数 a<b，正数 a>b，0 相等
 */
export function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * 宽松解析（历史语义）：不返回 null，无数字段一律按 0 段处理
 *
 * ⚠️ 与 `parse()` 的差别：这里 `beta` / `latest` 仍会被当成 `[0]`（0.0.0），
 *    仅供 `compareVersionsLoose` 这种“排序启发式”场景使用。
 *
 * @param {string} v
 * @returns {number[]}
 */
function parseLegacy(v) {
  if (typeof v !== 'string') return [0];
  let s = v.replace(/^v/i, '').replace(/\+.*$/, '');
  const m = /^(\d+(?:\.\d+)*)-(.*)$/.exec(s);
  if (m) s = m[1];
  if (!/\d/.test(s)) return [0];
  return s.split('.').map((seg) => {
    const d = /^\d+/.exec(seg);
    return d ? Number(d[0]) : 0;
  });
}

/**
 * compareVersionsLoose —— 宽松“数字段比较”的显式命名入口
 *
 * ⚠️ 非 SemVer 语义，仅用于已知形态 tag 的排序 / 版本目录归档选择，
 *    **不得**用于任何 SemVer 判定。
 *    与 `compare()` 的差别：这里两侧都不是版本时仍然视为相等（0），
 *    而不是把非版本排到最低位。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersionsLoose(a, b) {
  const pa = parseLegacy(a);
  const pb = parseLegacy(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 稳定性黑名单
// ---------------------------------------------------------------------------

/**
 * 判断版本是否稳定（非预发布/非 daily-build）
 * 黑名单：latest, nightly, dev, edge, alpha, beta, rc, main, master（不区分大小写）
 * @param {string} v 版本字符串
 * @returns {boolean}
 */
export function isStable(v) {
  const UNSTABLE_RE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i;
  if (typeof v !== 'string') return false;
  // 取第一段（去 v 前缀后）判断
  const first = v.replace(/^v/i, '').split('.')[0].split('-')[0].split('+')[0];
  return !UNSTABLE_RE.test(first);
}

/**
 * 从列表中选取最新版本
 *
 * 规则（分层）：
 *  1. 先过滤掉**不是版本**的条目（`parse(entry) === null`）：
 *     `latest` / `nightly` / `dev` / `edge` 等永远不会被当成 0.0.0 选出去。
 *  2. 第一优先层：**纯 semver**（`/^v?\d+\.\d+\.\d+$/`，无 prerelease / build）。
 *     只要存在纯 semver 候选，就只在它们里面取最大
 *     （这是防止 4 段及以上数字版本镜像被历史遗留 3 段版本抢占的关键偏好）。
 *  3. 第二优先层（仅当第一层为空）：其余“版本样”条目，
 *     两侧都是严格 SemVer 时按 SemVer 优先级比较，否则按宽松数字段比较；
 *     相同则按 localeCompare 取字典序大者。
 *
 * ⚠️ 架构后缀形态（`v3.2.18-arm32v7`）严格来说是一个 prerelease 标识符，
 *    跨后缀组比较没有意义——调用方应先按后缀分组再调用本函数。
 *
 * @param {string[]} list 版本字符串数组
 * @returns {string|null} 没有版本样条目时返回 null
 */
export function pickLatest(list) {
  if (!Array.isArray(list) || list.length === 0) return null;

  const versionLike = list.filter(t => typeof t === 'string' && t.length > 0 && parse(t) !== null);
  if (versionLike.length === 0) return null;

  const pure = versionLike.filter(t => PURE_SEMVER_RE.test(t));
  const pool = pure.length > 0 ? pure : versionLike;

  let best = pool[0];
  for (const t of pool.slice(1)) {
    if (compareCandidates(t, best) > 0) best = t;
  }
  return best;
}
