// lib/schema.mjs — data.yml 结构定义（纯数据结构，无第三方依赖）
// 实际 Zod 校验逻辑在 bin/lint-apps.mjs 中（zod 依赖仅允许在 bin/ 层引入）
// lib/ 唯一第三方依赖：js-yaml（用于数据解析，校验层不依赖）

/**
 * formField type 白名单（1Panel 前端 params/index.vue）
 * boolean 不在白名单中——参见 AGENTS.md Common Pitfalls
 */
export const FORMFIELD_TYPE_WHITELIST = new Set([
  'text', 'number', 'password', 'service', 'select', 'apps',
]);

/**
 * formField rule 值白名单
 */
export const FORMFIELD_RULE_WHITELIST = new Set([
  'paramImageTag', 'paramPort', 'paramPath',
  'paramCommon', 'paramSelect', 'paramComplexity',
]);

/**
 * i18n 语言标签白名单
 */
export const I18N_LANGS = new Set([
  'en', 'zh', 'zh-Hant', 'ja', 'ko', 'ru', 'ms', 'pt-br',
  'es-es', 'tr', // 部分应用有这些
]);

/**
 * 根级 data.yml 必须字段
 */
export const ROOT_REQUIRED_FIELDS = ['key', 'name', 'type'];

/**
 * 根级 data.yml type 枚举
 */
export const TYPE_ENUM = ['tool', 'media', 'library'];

/**
 * 架构枚举
 */
export const ARCH_ENUM = ['amd64', 'arm64', 'arm/v7', '386'];

/**
 * 校验 formField 单条规则
 * @param {object} field
 * @param {string} path - 字段路径（如 "formFields[3].envKey=PANEL_APP_PORT_HTTP"）
 * @returns {string[]} 错误信息数组，空 = 通过
 */
export function validateFormField(field, path) {
  const errors = [];

  // type 白名单
  if (!FORMFIELD_TYPE_WHITELIST.has(field.type)) {
    errors.push(`${path}: type="${field.type}" 不在白名单内（text|number|password|service|select|apps）`);
  }

  // rule 白名单
  if (field.rule && !FORMFIELD_RULE_WHITELIST.has(field.rule)) {
    errors.push(`${path}: rule="${field.rule}" 不在白名单内`);
  }

  // select 类型必须有 values
  if (field.type === 'select' && !field.values) {
    errors.push(`${path}: type=select 但缺少 values 数组`);
  }

  // boolean 类型明确不可用
  if (field.type === 'boolean') {
    errors.push(`${path}: type=boolean 在 1Panel UI 中不渲染（应改用 type=select + values）`);
  }

  // number 类型 default 须可转为数字
  if (field.type === 'number' && field.default !== undefined) {
    const num = Number(field.default);
    if (Number.isNaN(num)) {
      errors.push(`${path}: type=number 但 default="${field.default}" 无法转为数字`);
    }
  }

  // values 数组元素格式
  if (field.values) {
    for (let i = 0; i < field.values.length; i++) {
      const v = field.values[i];
      if (typeof v.label === 'undefined' && typeof v.value === 'undefined') {
        errors.push(`${path}.values[${i}]: 每项须有 label 和 value`);
      }
    }
  }

  // label 对象每个值须为字符串
  if (field.label) {
    for (const [lang, val] of Object.entries(field.label)) {
      if (typeof val !== 'string') {
        errors.push(`${path}.label.${lang}: 值须为字符串`);
      }
    }
  }

  return errors;
}

/**
 * 校验 additionalProperties.key 与目录名是否一致
 * @param {string} key
 * @param {string} appDir
 * @param {string} path
 * @returns {string[]} 错误信息数组
 */
export function validateKeyMatch(key, appDir, path) {
  const dirName = appDir.split('/').pop();
  if (key !== dirName) {
    return [`${path}: additionalProperties.key="${key}" 与目录名 "${dirName}" 不一致`];
  }
  return [];
}

/**
 * 校验 URL 字段格式（宽松：仅检查 https:// 前缀）
 * @param {string|undefined} val
 * @param {string} fieldName
 * @param {string} path
 * @returns {string[]}
 */
export function validateUrlField(val, fieldName, path) {
  if (val === undefined) return [];
  if (typeof val !== 'string') return [`${path}.${fieldName}: 须为字符串`];
  if (val.length > 0 && !val.startsWith('https://') && !val.startsWith('http://')) {
    return [`${path}.${fieldName}: URL 应以 https:// 或 http:// 开头`];
  }
  return [];
}

/**
 * 规范化 formField：补充 label 对象（向后兼容 labelEn/labelZh）
 * @param {object} field
 * @returns {object}
 */
export function normalizeFormField(field) {
  if (!field.label && (field.labelEn || field.labelZh)) {
    const label = {};
    if (field.labelEn) label.en = field.labelEn;
    if (field.labelZh) label.zh = field.labelZh;
    return { ...field, label };
  }
  return field;
}
