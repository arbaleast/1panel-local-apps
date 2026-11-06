// lib/compose-render.mjs — 1Panel 上下文模拟渲染（compose 变量插值 + 规范化序列化）
//
// 用途：在**没有 docker daemon** 的前提下，按 1Panel 实际部署时的语义渲染一个 compose 文件，
// 从而在 CI / 单元测试里校验「这份 compose 在 1Panel 里能不能起得来」。
//
// ⚠️ 关键坑：**必须先 yaml.load 解析成对象，再对「字符串叶子」做插值，最后 yaml.dump 序列化。**
//    如果先做文本替换（把 ${VAR} 直接替换成字面量）再 yaml.load，像
//    `command: ['${ZIM_FILES}']` + ZIM_FILES='*.zim' 就会变成 `command: ['*.zim']`，
//    而 `*` 是 YAML alias 指示符 → 解析直接报错（"unknown alias"）。
//    正确顺序是：yaml.load → 插值（此时 '*zim' 还是一个普通字符串，不会被 YAML 重新解析）
//    → yaml.dump（dump 时才会决定是否需要引号）。
//
// 本模块是纯逻辑：不做 fs / 网络 / 进程副作用，第三方依赖仅 js-yaml。

import yaml from 'js-yaml';

/** 1Panel 内置变量的合成值（与 AGENTS.md §6 的 6 个内置变量一致） */
export const PANEL_BUILTIN_ENV = Object.freeze({
  CONTAINER_NAME: 'smoke_container',
  HOST_IP: '127.0.0.1',
  HOST_ADDRESS: '127.0.0.1',
  PANEL_DB_PORT: '3306',
  CPUS: '1',
  MEMORY_LIMIT: '512M',
});

/** 合成密码时使用的固定假值——绝不能是真密钥 */
const SYNTH_PASSWORD = 'smoke-not-a-real-secret';

/**
 * 判断 formField 是否带有一个「可用的 default」
 * @param {{default?: unknown}} field
 * @returns {boolean}
 */
function hasUsableDefault(field) {
  const d = field?.default;
  if (d === undefined || d === null) return false;
  if (typeof d === 'string' && d === '') return false;
  return true;
}

/**
 * 为单个 formField 生成安全的合成值。
 *
 * 规则：有非空 default → 用 default；否则按 type 合成
 * （number/password/select/service/apps/text，text 且 rule==='paramPath' 走 paramPath 特例）。
 *
 * @param {{type?:string, default?:unknown, rule?:string, values?:Array<{value:unknown}>}} field
 * @returns {string}
 */
export function synthValueForField(field) {
  const f = field ?? {};
  if (hasUsableDefault(f)) return String(f.default);

  switch (f.type) {
    case 'number':
      return '1024';
    case 'password':
      return SYNTH_PASSWORD;
    case 'select': {
      const first = Array.isArray(f.values) && f.values.length > 0 ? f.values[0] : null;
      if (first && first.value !== undefined && first.value !== null) return String(first.value);
      return 'smoke';
    }
    case 'service':
      return '127.0.0.1';
    case 'apps':
      return '';
    case 'text':
    default:
      return f.rule === 'paramPath' ? '/tmp/smoke' : 'smoke';
  }
}

/**
 * 构造 1Panel 虚拟环境变量上下文。
 *
 * @param {Array<object>} fields - 版本级 data.yml 的 formFields 数组
 * @param {{builtins?:Record<string,string>}} [opts] - builtins 可覆盖内置变量
 * @returns {{env:Record<string,string>, synthesized:string[], declared:string[], missing:string[]}}
 *   env        — 变量名 → 值（全部为字符串）
 *   synthesized— 本次用合成值填充的变量名（必填但 default 为空/缺失的那些）
 *   declared   — 全部声明过的变量名
 *   missing    — 声明了但既无 default 又无法合成（当前实现应恒为空数组）
 */
export function buildPanelEnv(fields, opts = {}) {
  const env = {};
  for (const [k, v] of Object.entries(PANEL_BUILTIN_ENV)) env[k] = String(v);
  for (const [k, v] of Object.entries(opts.builtins ?? {})) env[k] = String(v);

  const synthesized = [];
  const declared = [];

  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field !== 'object') continue;
    const envKey = field.envKey;
    if (typeof envKey !== 'string' || envKey === '') continue;
    if (!declared.includes(envKey)) declared.push(envKey);
    if (hasUsableDefault(field)) {
      env[envKey] = String(field.default);
    } else {
      env[envKey] = synthValueForField(field);
      if (!synthesized.includes(envKey)) synthesized.push(envKey);
    }
  }

  return { env, synthesized, declared, missing: [] };
}

/**
 * 解析单个 `${...}` 占位符内部的内容。
 * @param {string} inner - `${}` 内部的原文
 * @returns {{name:string, op:string, def:string}|null} null = 不是合法占位符
 */
function parsePlaceholder(inner) {
  const m = /^([A-Za-z_][A-Za-z0-9_.]*)([\s\S]*)$/.exec(inner);
  if (!m) return null;
  const name = m[1];
  const rest = m[2];
  if (rest === '') return { name, op: '', def: '' };
  if (rest.startsWith(':-')) return { name, op: ':-', def: rest.slice(2) };
  if (rest.startsWith(':?')) return { name, op: ':?', def: rest.slice(2) };
  if (rest.startsWith('-')) return { name, op: '-', def: rest.slice(1) };
  if (rest.startsWith('?')) return { name, op: '?', def: rest.slice(1) };
  return null;
}

/**
 * 对单个字符串做 compose 语义的变量插值。
 *
 * 支持形态：
 *   ${VAR}        未定义 → 留空并记入 unresolved（compose 行为）
 *   ${VAR:-def}  未定义**或空串** → def
 *   ${VAR-def}   仅未定义 → def
 *   ${VAR:?msg}  未定义**或空串** → 报错（compose 直接失败）
 *   ${VAR?msg}   仅未定义 → 报错
 *   $$            转义的字面 $（$$VAR → $VAR，不插值）
 *
 * @param {string} value
 * @param {Record<string,string>} env
 * @returns {{value:string, unresolved:string[], error:string|null}}
 *   error 非 null 表示触发了 `${VAR:?msg}` / `${VAR?msg}` 的强制错误（compose 会直接失败）
 */
export function interpolateValue(value, env) {
  if (typeof value !== 'string') {
    return { value, unresolved: [], error: null };
  }
  const context = env ?? {};
  let out = '';
  const unresolved = [];
  let error = null;

  const pushUnresolved = (name) => {
    if (!unresolved.includes(name)) unresolved.push(name);
  };

  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '$' && value[i + 1] === '$') {
      // 转义的字面 $：$$VAR → $VAR
      out += '$';
      i += 2;
      continue;
    }
    if (ch === '$' && value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2);
      if (end === -1) {
        out += ch;
        i += 1;
        continue;
      }
      const inner = value.slice(i + 2, end);
      const ph = parsePlaceholder(inner);
      if (!ph) {
        // 不是合法占位符 → 原样保留
        out += value.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      const defined = Object.prototype.hasOwnProperty.call(context, ph.name);
      const raw = defined ? context[ph.name] : undefined;
      const val = raw === undefined || raw === null ? '' : String(raw);
      const isEmpty = val === '';

      switch (ph.op) {
        case '':
          if (!defined) pushUnresolved(ph.name);
          out += val;
          break;
        case ':-':
          out += defined && !isEmpty ? val : ph.def;
          break;
        case '-':
          out += defined ? val : ph.def;
          break;
        case ':?':
          if (!defined || isEmpty) {
            if (error === null) error = ph.def || `required variable ${ph.name} is missing a value`;
          } else {
            out += val;
          }
          break;
        case '?':
          if (!defined) {
            if (error === null) error = ph.def || `required variable ${ph.name} is missing a value`;
          } else {
            out += val;
          }
          break;
        default:
          out += val;
          break;
      }
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { value: out, unresolved, error };
}

/**
 * 深度遍历 compose 文档，对所有**字符串叶子**做插值（不是文本替换）。
 *
 * @param {object} doc
 * @param {Record<string,string>} env
 * @returns {{doc:object, unresolved:string[], error:string|null}}
 */
export function interpolateCompose(doc, env) {
  const unresolved = [];
  let error = null;

  const walk = (node) => {
    if (typeof node === 'string') {
      const r = interpolateValue(node, env);
      for (const name of r.unresolved) if (!unresolved.includes(name)) unresolved.push(name);
      if (r.error !== null && error === null) error = r.error;
      return r.value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    // 数字 / 布尔 / null / undefined 原样返回
    return node;
  };

  return { doc: walk(doc), unresolved, error };
}

/**
 * 完整渲染：插值 → 重新序列化（等价于 compose 写出的规范化配置）。
 *
 * @param {object} composeDoc - 已解析的 compose 文档
 * @param {Record<string,string>} env
 * @returns {{ok:boolean, error:string|null, doc:object|null, unresolved:string[]}}
 */
export function renderCompose(composeDoc, env) {
  const { doc, unresolved, error } = interpolateCompose(composeDoc, env);
  if (error !== null) {
    return { ok: false, error, doc: null, unresolved };
  }
  try {
    yaml.dump(doc);
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), doc: null, unresolved };
  }
  return { ok: true, error: null, doc, unresolved };
}
