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
//
// ⚠️ 镜像字符串解析**统一走 lib/registry.mjs 的 parseImage()**（audit task 5）：
//    本模块不再用 `lastIndexOf(':')` 之类的重复实现拆 repo/tag —— registry 端口
//    （`localhost:5000/app`）、`docker.io/` 前缀、digest 镜像都交给同一个解析器，
//    解析失败一律返回 null（保守放弃，不误判为可更新镜像）。

import { parseImage } from './registry.mjs';

/**
 * 用唯一镜像解析器拆出「原样 repo + tag」
 *
 * 返回的 imageRepo 是**原字符串去掉 `:tag` 后缀**（保留 registry 前缀原样写法），
 * 这样 detect 用 `${imageRepo}:${newTag}` 回调 registry 时不会改写用户的 repo 写法。
 *
 * @param {string} image 完整镜像字符串（无变量占位）
 * @returns {{imageRepo: string, currentTag: string}|null}
 *   null = 不是「repo:tag」形态（无 tag / digest 固定摘要 / 非法镜像名）
 */
function splitImageRepoTag(image) {
  const parsed = parseImage(image);
  if (!parsed) return null;
  // digest 固定摘要的镜像版本由摘要锁定，自动更新无意义 → 保守放弃
  if (parsed.digest) return null;
  if (typeof parsed.tag !== 'string' || parsed.tag.length === 0) return null;
  const suffix = `:${parsed.tag}`;
  if (!image.endsWith(suffix)) return null;
  const imageRepo = image.slice(0, image.length - suffix.length);
  if (!imageRepo) return null;
  return { imageRepo, currentTag: parsed.tag };
}

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

  // 形态 2：单 envKey，且 envKey.default 持有完整镜像字符串（repo:tag）
  if (varNames.length === 1) {
    const envKey = varNames[0];
    const field = fieldByKey.get(envKey);
    if (!field) return null;
    const defaultVal = String(field.default ?? '');
    if (!defaultVal) return null;
    const split = splitImageRepoTag(defaultVal);
    if (!split) return null;
    return {
      imageRepo: split.imageRepo,
      currentTag: split.currentTag,
      envKey,
      defaultVal,
      newDefaultVal: defaultVal, // 调用方根据查询结果替换 tag 后再回填
    };
  }

  // 形态 3：多 envKey。约定第一个 envKey 持有 repo（可含 registry 域名/端口），
  // 最后一个持有 tag。中间出现其它字面量一律按 image 模板拼接。
  // 为安全起见：只处理恰好 2 个 envKey 的情况，其它形态返回 null（保守放弃）。
  if (varNames.length === 2) {
    const [repoKey, tagKey] = varNames;
    const repoField = fieldByKey.get(repoKey);
    const tagField = fieldByKey.get(tagKey);
    if (!repoField || !tagField) return null;
    const repoVal = String(repoField.default ?? '');
    const tagVal = String(tagField.default ?? '');
    if (!repoVal || !tagVal) return null;
    // 用 image 模板为骨架，把 ${repoKey}/${tagKey} 替换成默认值，模拟最终镜像字符串
    const composed = image
      .replaceAll(`\${${repoKey}}`, repoVal)
      .replaceAll(`\${${tagKey}}`, tagVal);
    // 统一用 parseImage 拆 repo/tag：能正确处理 registry 端口（localhost:5000/app）
    // 与 docker.io 前缀；digest / 非法镜像名 → null。
    const split = splitImageRepoTag(composed);
    if (!split) return null;
    // 保守校验：模板里 tag 的位置必须正好是 tag 字段本身。
    // 若模板带额外字面量（如 "${IMAGE}:${TAG}-extra"），composed 的 tag 会变成
    // "值-extra"，写回时只改 TAG 字段会丢字面量 → 直接放弃，不做不可靠更新。
    if (split.currentTag !== tagVal) return null;
    // envKey 用 tagKey（detect 写回 formField.default 时只动 tag 那个字段；repo 不变）
    return {
      imageRepo: split.imageRepo,
      currentTag: split.currentTag,
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
