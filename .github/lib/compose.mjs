// lib/compose.mjs — compose image 模板解析与 formField 重组
//
// detect-updates.mjs 变量型分支依赖此模块。支持的 image 模板形态：
//   1. hardcode:  'ghcr.io/foo/bar:1.2.3'             → 跳过此模块（detect 在 hardcode 路径处理）
//   2. 单 envKey: 'ghcr.io/foo/bar:${VERSION}'        → field.default 持有完整镜像字符串
//   3. 双 envKey: '${IMAGE}:${VERSION}'                → IMAGE.default = repo, VERSION.default = tag
//
// 形态 2/3 共用 resolveImageTemplate(image, fields) 一个出口，由调用方决定 continue 还是写入 changes。
// 形态 3 是 bookorbit/photoprism/mineru/onenav/cinny/music-tag-web/navi-homepage/newapi/xunlei
// 共 9 个应用的现状（2026-10-14 排查时确认），原变量型分支对形态 3 静默失败。

/**
 * 解析 compose image 模板，提取镜像 repo 与当前 tag
 * @param {string} image - compose 中 svc.image 原始字符串
 * @param {Array<{envKey?: string, default?: string}>} fields - data.yml formFields 列表
 * @returns {null | {imageRepo: string, currentTag: string, envKey: string, defaultVal: string, newDefaultVal: string}}
 *   - null：非变量型模板（hardcode）或 envKey 在 fields 中找不到 / 拼不出合法 (imageRepo, currentTag)
 *   - 对象：可用于 registry 查询。newDefaultVal 是把 currentTag 替换为新 tag 后的完整字符串
 *     （供 detect 写入 formField.default）；currentTag === newDefaultVal 的"无更新"由调用方判定
 */
export function resolveImageTemplate(image, fields) {
  if (typeof image !== 'string') return null;
  // hardcode（无 ${}）不归本模块管
  if (!image.includes('${')) return null;

  // 提取 image 中所有 ${VAR} 名（去重保序）
  const seen = new Set();
  const varNames = [];
  for (const m of image.matchAll(/\$\{([^}]+)\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      varNames.push(m[1]);
    }
  }
  if (varNames.length === 0) return null;

  const fieldByKey = new Map();
  for (const f of fields || []) {
    if (f && typeof f.envKey === 'string') fieldByKey.set(f.envKey, f);
  }

  // 形态 2：单 envKey，且 envKey.default 持有完整镜像字符串（含 ':'）
  if (varNames.length === 1) {
    const envKey = varNames[0];
    const field = fieldByKey.get(envKey);
    if (!field) return null;
    const defaultVal = String(field.default ?? '');
    if (!defaultVal) return null;
    const colonIdx = defaultVal.lastIndexOf(':');
    if (colonIdx <= 0 || colonIdx === defaultVal.length - 1) return null;
    const imageRepo = defaultVal.slice(0, colonIdx);
    const currentTag = defaultVal.slice(colonIdx + 1);
    if (!imageRepo || !currentTag) return null;
    return {
      imageRepo,
      currentTag,
      envKey,
      defaultVal,
      newDefaultVal: defaultVal, // 调用方根据查询结果替换 tag 后再回填
    };
  }

  // 形态 3：多 envKey。约定第一个 envKey 持有 repo（不含 ':'），最后一个持有 tag（不含 ':'）。
  // 中间出现其它 ${} 一律按字面拼接参与 image 字符串，但目前 9 个应用都是恰好 2 个 envKey。
  // 为安全起见：只处理恰好 2 个 envKey 的情况，其它形态返回 null（保守放弃）。
  if (varNames.length === 2) {
    const [repoKey, tagKey] = varNames;
    const repoField = fieldByKey.get(repoKey);
    const tagField = fieldByKey.get(tagKey);
    if (!repoField || !tagField) return null;
    const repoVal = String(repoField.default ?? '');
    const tagVal = String(tagField.default ?? '');
    if (!repoVal || !tagVal) return null;
    if (repoVal.includes(':')) return null; // repo 部分不应含 tag
    if (tagVal.includes(':')) return null; // tag 部分不应含 repo
    // 镜像中间可能还有字面量（如 "${IMAGE}:${TAG}-extra"），用 image 模板为骨架
    // 把 ${repoKey} 替换成 repoVal、${tagKey} 替换成 tagVal，模拟最终镜像字符串
    const composed = image
      .replaceAll(`\${${repoKey}}`, repoVal)
      .replaceAll(`\${${tagKey}}`, tagVal);
    const colonIdx = composed.lastIndexOf(':');
    if (colonIdx <= 0 || colonIdx === composed.length - 1) return null;
    const imageRepo = composed.slice(0, colonIdx);
    const currentTag = composed.slice(colonIdx + 1);
    if (!imageRepo || !currentTag) return null;
    // envKey 用 tagKey（detect 写回 formField.default 时只动 tag 那个字段；repo 不变）
    return {
      imageRepo,
      currentTag,
      envKey: tagKey,
      defaultVal: tagVal,        // 即 tagField.default，写回时直接覆盖
      newDefaultVal: tagVal,
    };
  }

  // 3+ envKey：暂不支持，保守放弃
  return null;
}

/**
 * 把 formField.default 替换成新 tag 后的完整镜像字符串（用于 detect 写回 data.yml）
 * 形态 2（单 envKey，default 持有完整字符串）：直接替换最后一个 ':tag'
 * 形态 3（双 envKey）：只覆盖 tagKey 那个 field 的 default（newTag 即可）
 * @param {string} image - 原 compose image 模板
 * @param {string} envKey - 形态 2 用单 envKey；形态 3 用 tagKey
 * @param {string} imageRepo - 形态 2 必须传入（与 default 中 repo 段一致）
 * @param {string} newTag
 * @returns {string} 新的镜像字符串（形态 2）或新 tag（形态 3）
 */
export function rebuildImageDefault(image, envKey, imageRepo, newTag) {
  const varNames = [];
  const seen = new Set();
  for (const m of image.matchAll(/\$\{([^}]+)\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      varNames.push(m[1]);
    }
  }
  if (varNames.length === 1 && varNames[0] === envKey) {
    return `${imageRepo}:${newTag}`;
  }
  if (varNames.length === 2 && varNames[1] === envKey) {
    return newTag;
  }
  // 兜底：无法识别时返回 newTag（detect 写到 formField.default 时至少不会写错 repo）
  return newTag;
}
