// lib/validate-batch.mjs — 自动更新批次的**全量配置校验**（纯函数，无副作用）
//
// ── 为什么有这个模块 ─────────────────────────────────────────────────────
// 2026-11 审计（audit task 3）：旧的 bin/open-update-pr.mjs 推完分支就直接开 PR，
// **完全没有校验**生成的配置——坏掉的 data.yml / 缺 docker-compose.yml 的版本目录
// / 写了 `latest` 的镜像 tag / README 版本没同步，全部直接落进 PR，
// 要等 1Panel 同步时才炸。
//
// 本模块把校验做成 lib 层的纯函数，便于单测；bin/ 层只有两个薄入口：
//   · bin/validate-update-batch.mjs —— CLI（校验当前工作树）
//   · bin/open-update-pr.mjs        —— 开 PR 前调用（errors → 不开 PR）
//
// 校验分两类：
//   · **errors**   —— 结构性问题（YAML 语法错、缺文件、schema 不符、**本批次更新的**
//                    镜像 tag 非法、README 版本不一致），必须阻断开 PR；
//   · **warnings** —— 仓库规约偏差 + **历史遗留债务**（compose 未声明 restart /
//                    未挂 1panel-network / 未被本批次触碰的 service 用了 `latest` 等），
//                    只提示不阻断。
//
// ── 两种模式 ───────────────────────────────────────────────────────────────
//   · **BATCH 模式**（`updates` 非空）：只对**本批次实际改动过的**内容下重判。
//     镜像 tag 只检查 `updates[].services[].name` 里列出的 service；其它 service
//     的 tag 问题（历史遗留，例如 firecrawl 的 `playwright-service:latest`）
//     降级为 warning——否则一个合法的批次会被历史债务永久堵死。
//   · **AUDIT 模式**（`updates` 为空 / CLI 无 updates.json）：全仓审计，
//     所有发现都按 error 报出（供人工审计命令使用）。
//
// 依赖：仅 js-yaml + Node 内置模块（lib/ 层禁用的第三方依赖仅 js-yaml）。

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  validateFormField,
  validateKeyMatch,
  validateUrlField,
  ROOT_REQUIRED_FIELDS,
  TYPE_ENUM,
} from './schema.mjs';
import { getCurrentVersion, listApps } from './apps.mjs';
import { isValidSemver } from './semver.mjs';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 明确禁止作为镜像 tag / 版本号使用的“非版本词”
 * （AGENTS.md：禁止使用 latest 作为版本目录名或镜像 tag）
 */
export const NON_VERSION_TAGS = new Set([
  'latest', 'nightly', 'dev', 'edge', 'alpha', 'beta', 'rc', 'main', 'master',
]);

/** 仓库统一的外部网络名 */
export const PANEL_NETWORK = '1panel-network';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/**
 * 读取并解析 YAML 文件
 * @param {string} filePath
 * @returns {{doc: unknown, errors: string[]}}
 */
export function parseYamlFile(filePath) {
  const errors = [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { doc: null, errors: [`${filePath}: 无法读取文件（${e.message}）`] };
  }
  try {
    return { doc: yaml.load(text), errors };
  } catch (e) {
    errors.push(`${filePath}: YAML 语法错误（${e.message}）`);
    return { doc: null, errors };
  }
}

/**
 * 读取别名表（.github/app-aliases.yml），构造 dir → alias 的映射
 *
 * 映射项额外带 `_shortName`（README 表格里显示的名字）与 `dir`（实际目录名）。
 *
 * @param {string} root - 仓库根目录
 * @returns {Map<string, {dir: string, _shortName: string, preferred_version?: string}>}
 */
export function loadAliasByDir(root) {
  const map = new Map();
  const file = path.join(root, '.github', 'app-aliases.yml');
  if (!fs.existsSync(file)) return map;
  let data;
  try {
    data = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return map;
  }
  const aliases = (data && data.aliases) || {};
  for (const [name, conf] of Object.entries(aliases)) {
    if (!conf || typeof conf !== 'object') continue;
    const dir = conf.dir || name;
    map.set(dir, { ...conf, dir, _shortName: name });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 镜像 tag 判定
// ---------------------------------------------------------------------------

/**
 * 判断一个字符串是否是“非版本词”（latest / nightly / dev / edge …）
 * @param {string} tag
 * @returns {boolean}
 */
export function isNonVersionTag(tag) {
  return typeof tag === 'string' && NON_VERSION_TAGS.has(tag.toLowerCase());
}

/**
 * 判断镜像 tag 是否是**可识别的版本形态**
 *
 * 本仓出现过的合法形态（见 AGENTS.md）：
 *   · 严格 SemVer：`1.2.3` / `v1.2.3`（含 prerelease / build）
 *   · SemVer + 架构后缀：`v3.2.18-arm32v7`
 *   · 日期型：`260919` / `2024.08`
 *   · 日期 + 哈希：`2026.9.7-3e454637f`
 *   · 多段数字：`26.04.5.1.1`
 *   · 数字 + 变体后缀：`16-alpine` / `3-management` / `1.11.2-ls41`
 *   · 字母前缀形态：`full-v1.12.2-arm64` / `a2b-stable-25-08-12`
 *
 * 判定规则：必须**含数字**，且形如「数字（可带 v 前缀）起头」或
 * 「字母起头 + 含数字的段」——既排除 `latest` / `nightly` / `dev` 这类词，
 * 也排除 `not-a-version` 这种完全不含数字的噪声。
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isRecognisableVersionTag(tag) {
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

/**
 * 解析 compose 的 image 引用
 *
 * @param {unknown} image
 * @returns {{repo: string, tag: string|null}|null}
 *   null = 不是需要校验的镜像引用（变量型镜像 / digest 固定摘要）
 */
export function parseImageRef(image) {
  if (typeof image !== 'string') return null;
  const s = image.trim();
  if (!s) return null;
  // 变量型镜像（${IMAGE} / ${APP_IMAGE}:${APP_VERSION}）不在校验范围
  if (s.includes('${')) return null;
  // digest 固定摘要（nginx@sha256:…）自带版本，跳过
  if (s.includes('@')) return null;

  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > slash) {
    return { repo: s.slice(0, colon), tag: s.slice(colon + 1) };
  }
  return { repo: s, tag: null };
}

/**
 * 校验 compose 中镜像的 tag
 *
 * @param {object} doc - compose 文档（已解析）
 * @param {{label?: string, updatedServices?: Set<string>|null, inheritedFrom?: string}} [options]
 *   · `updatedServices` 为 null → AUDIT 模式：所有 service 的 tag 问题都是 error；
 *   · `updatedServices` 为 Set → BATCH 模式：只有集合内的 service（本批次更新过的）
 *     的 tag 问题算 error；集合外的 service 降级为 warning（历史遗留债务）。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateImageTags(doc, { label = 'compose', updatedServices = null, inheritedFrom = '' } = {}) {
  const errors = [];
  const warnings = [];
  const services = (doc && doc.services) || {};
  if (typeof services !== 'object') return { errors, warnings };

  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const ref = parseImageRef(svc.image);
    if (!ref) continue;

    let problem = null;
    if (ref.tag === null) {
      problem = `镜像 "${ref.repo}" 未指定 tag（等价于 latest，禁止使用）`;
    } else if (isNonVersionTag(ref.tag)) {
      problem = `镜像 tag "${ref.tag}" 是非版本词（latest/nightly/dev/edge 等），禁止使用`;
    } else if (!isRecognisableVersionTag(ref.tag)) {
      problem = `镜像 tag "${ref.tag}" 既不是合法 SemVer，也不是可识别的版本形态`;
    }
    if (!problem) continue;

    const message = `${label}.services.${name}: ${problem}`;
    // BATCH 模式：本批次没碰过的 service → 历史遗留，只警告
    const isUpdated = updatedServices instanceof Set && updatedServices.has(name);
    if (updatedServices instanceof Set && !isUpdated) {
      const src = inheritedFrom ? `继承自 ${inheritedFrom}，` : '';
      warnings.push(`${message}（${src}非本批次引入，不阻断）`);
    } else {
      errors.push(message);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// data.yml 校验
// ---------------------------------------------------------------------------

/**
 * 校验 data.yml 的结构（schema 层）
 *
 * ⚠️ `type` 缺失**不是**错误：bin/lint-apps.mjs 的 zod schema 用 `.default('tool')`，
 *    缺失时按 `tool` 处理（lint 0 错）。此处保持一致：缺失 → warning，
 *    存在但不在 TYPE_ENUM 内 → error。
 *
 * @param {unknown} doc - 已解析的 data.yml
 * @param {{label?: string, appDir?: string}} options
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateDataYamlDocument(doc, { label = 'data.yml', appDir = '' } = {}) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(`${label}: 顶层不是映射（data.yml 必须是 { additionalProperties: {...} } 结构）`);
    return { errors, warnings };
  }
  const ap = doc.additionalProperties;
  if (!ap || typeof ap !== 'object' || Array.isArray(ap)) {
    errors.push(`${label}: 缺少 additionalProperties 块（data.yml 必须是 { additionalProperties: {...} } 结构）`);
    return { errors, warnings };
  }

  // 必填字段：key / name（type 缺失按默认 tool 处理，见上）
  for (const field of ROOT_REQUIRED_FIELDS) {
    if (field === 'type') continue;
    const v = ap[field];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors.push(`${label}: additionalProperties.${field} 缺失或为空`);
    }
  }

  // type：缺失 → warning（与 lint 的 .default('tool') 口径一致）；非法值 → error
  const typeValue = ap.type;
  if (typeValue === undefined || typeValue === null || String(typeValue).trim() === '') {
    warnings.push(`${label}: additionalProperties.type 缺失，按默认 "tool" 处理（与 npm run lint 口径一致）`);
  } else if (!TYPE_ENUM.includes(typeValue)) {
    errors.push(
      `${label}: additionalProperties.type="${typeValue}" 不在白名单内（${TYPE_ENUM.join(' | ')}）`,
    );
  }

  // additionalProperties.key 必须等于应用目录名
  if (typeof ap.key === 'string' && appDir) {
    errors.push(...validateKeyMatch(ap.key, appDir, `${label}.additionalProperties`));
  }

  // URL 字段
  for (const urlField of ['website', 'github', 'document']) {
    errors.push(...validateUrlField(ap[urlField], urlField, `${label}.additionalProperties`));
  }

  // formFields
  const fields = ap.formFields;
  if (fields !== undefined && fields !== null) {
    if (!Array.isArray(fields)) {
      errors.push(`${label}: additionalProperties.formFields 不是数组`);
    } else {
      fields.forEach((field, i) => {
        const p = `${label}.additionalProperties.formFields[${i}]`;
        if (!field || typeof field !== 'object' || Array.isArray(field)) {
          errors.push(`${p}: 不是映射`);
          return;
        }
        if (typeof field.envKey !== 'string' || field.envKey.trim() === '') {
          errors.push(`${p}: envKey 缺失或为空`);
        }
        const typeMissing = typeof field.type !== 'string' || field.type.trim() === '';
        if (typeMissing) {
          errors.push(`${p}: type 缺失或为空`);
        }
        for (const err of validateFormField(field, p)) {
          // type 缺失时 schema 层会再报一次白名单错误，去重
          if (typeMissing && err.startsWith(`${p}: type=`)) continue;
          errors.push(err);
        }
      });
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// compose 校验
// ---------------------------------------------------------------------------

/**
 * 校验 compose 文档
 *
 * - **errors**：YAML 结构问题（无 services / services 为空）
 * - **warnings**：仓库规约偏差（restart / 1panel-network / external），
 *   本仓存在历史遗留应用，只提示不阻断
 *
 * @param {unknown} doc - 已解析的 compose
 * @param {{label?: string, checkImages?: boolean, updatedServices?: Set<string>|null,
 *          inheritedFrom?: string}} [options]
 *   · `updatedServices` 为 null → AUDIT 模式（所有镜像 tag 问题都是 error）；
 *   · `updatedServices` 为 Set → BATCH 模式（只对集合内 service 判 error，
 *     其余降级为 warning——历史遗留债务不阻断本批次）。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateComposeDocument(
  doc,
  { label = 'compose', checkImages = true, updatedServices = null, inheritedFrom = '' } = {},
) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(`${label}: 顶层不是映射`);
    return { errors, warnings };
  }

  const services = doc.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    errors.push(`${label}: 缺少 services 映射`);
  } else if (Object.keys(services).length === 0) {
    errors.push(`${label}: services 为空`);
  } else {
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;
      // restart（规约）
      if (svc.restart === undefined || svc.restart === null || svc.restart === '') {
        warnings.push(`${label}.services.${name}: 未声明 restart（仓库规约要求 restart: always）`);
      }
      // networks（规约）
      const nets = svc.networks;
      let attached = false;
      if (Array.isArray(nets)) {
        attached = nets.includes(PANEL_NETWORK);
      } else if (nets && typeof nets === 'object') {
        attached = Object.prototype.hasOwnProperty.call(nets, PANEL_NETWORK);
      }
      if (!attached) {
        warnings.push(
          `${label}.services.${name}: 未挂载 ${PANEL_NETWORK}（仓库规约要求 networks: [${PANEL_NETWORK}]）`,
        );
      }
    }
  }

  // 顶层 networks：1panel-network 必须是 external
  const topNets = doc.networks;
  if (!topNets || typeof topNets !== 'object' || Array.isArray(topNets)) {
    warnings.push(`${label}: 未声明顶层 networks（应声明 ${PANEL_NETWORK}: { external: true }）`);
  } else if (!topNets[PANEL_NETWORK]) {
    warnings.push(`${label}: 顶层 networks 未声明 ${PANEL_NETWORK}`);
  } else {
    const def = topNets[PANEL_NETWORK];
    if (!def || typeof def !== 'object' || def.external !== true) {
      warnings.push(`${label}: networks.${PANEL_NETWORK} 未声明 external: true`);
    }
  }

  if (checkImages) {
    const img = validateImageTags(doc, { label, updatedServices, inheritedFrom });
    errors.push(...img.errors);
    warnings.push(...img.warnings);
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 目录结构校验
// ---------------------------------------------------------------------------

/**
 * 校验应用 / 版本目录结构
 *
 * @param {string} root - 仓库根
 * @param {string} appDir - 应用目录（可含 /）
 * @param {string|null} [versionDir] - 版本目录名（可空 = 只校验应用根）
 * @returns {string[]} 错误信息数组
 */
export function validateAppStructure(root, appDir, versionDir = null) {
  const errors = [];
  const appPath = path.join(root, appDir);

  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    errors.push(`应用目录不存在: ${appDir}`);
    return errors;
  }
  if (!fs.existsSync(path.join(appPath, 'data.yml'))) {
    errors.push(`${appDir}/data.yml 不存在`);
  }

  if (versionDir) {
    const vPath = path.join(appPath, versionDir);
    if (!fs.existsSync(vPath) || !fs.statSync(vPath).isDirectory()) {
      errors.push(`版本目录不存在: ${appDir}/${versionDir}`);
      return errors;
    }
    if (!fs.existsSync(path.join(vPath, 'data.yml'))) {
      errors.push(`${appDir}/${versionDir}/data.yml 不存在`);
    }
    if (!fs.existsSync(path.join(vPath, 'docker-compose.yml'))) {
      errors.push(`${appDir}/${versionDir}/docker-compose.yml 不存在`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// README 版本一致性
// ---------------------------------------------------------------------------

/**
 * 解析根 README.md 的「## 应用列表」表格
 * @param {string} root
 * @returns {Map<string, string>} 应用名 → 当前版本
 */
export function readReadmeVersionTable(root) {
  const table = new Map();
  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) return table;

  const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '## 应用列表') {
      inSection = true;
      continue;
    }
    if (inSection && t.startsWith('## ')) break;
    if (!inSection) continue;
    if (!t.startsWith('|')) continue;

    const cells = t.split('|').slice(1, -1).map(s => s.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0])) continue; // 表格分隔行
    table.set(cells[0], cells[2]);
  }
  return table;
}

/**
 * 校验 README 中某个应用的版本号与实际当前版本是否一致
 *
 * 期望值优先级：别名表 preferred_version > getCurrentVersion(root, appDir)
 *
 * @param {string} root
 * @param {string} appDir
 * @param {object|null} alias - 别名表条目
 * @param {Map<string,string>} table - readReadmeVersionTable 的结果
 * @returns {string[]} 错误信息数组
 */
export function validateReadmeVersion(root, appDir, alias, table) {
  const errors = [];
  const expected = (alias && alias.preferred_version) || getCurrentVersion(root, appDir);
  if (!expected) return errors; // 没有版本目录 → 无从校验

  const shortName = (alias && alias._shortName) || appDir;
  const actual = table.get(shortName);
  if (actual === undefined) {
    errors.push(`README.md 的「应用列表」缺少应用 "${shortName}"`);
    return errors;
  }
  if (actual !== expected) {
    errors.push(
      `README.md 中 "${shortName}" 的当前版本为 "${actual}"，应为 "${expected}"（README 未重新同步）`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 批次校验
// ---------------------------------------------------------------------------

/**
 * 从 updates 记录里收集某个应用涉及到的版本目录
 * @param {Array<object>} updates
 * @param {string} appDir
 * @returns {string[]} 版本目录名数组
 */
export function collectVersionDirs(updates, appDir) {
  const dirs = new Set();
  for (const u of updates) {
    if (!u || u.app !== appDir) continue;
    if (u.versionDir) dirs.add(u.versionDir);
    if (u.versionCopy && u.versionCopy.toDir) dirs.add(u.versionCopy.toDir);
    for (const c of u.changes || []) {
      if (!c || typeof c.path !== 'string') continue;
      const parts = c.path.split('/');
      if (parts.length >= 3 && parts[0] === appDir) dirs.add(parts[1]);
    }
  }
  return [...dirs];
}

/**
 * 收集某个应用每个版本目录下**本批次更新过的 service 名**
 *
 * @param {Array<object>} updates
 * @param {string} appDir
 * @returns {Map<string, {services: Set<string>, source: string}>}
 *   key = 版本目录名；value.services = 该目录下被本批次改过的 service 名；
 *   value.source = 来源版本目录（用于告警文案"继承自 <src>"）
 */
export function collectUpdatedServices(updates, appDir) {
  const map = new Map();
  for (const u of updates) {
    if (!u || u.app !== appDir) continue;
    const names = new Set();
    for (const s of u.services || []) {
      if (s && typeof s.name === 'string' && s.name) names.add(s.name);
    }
    const source = u.versionCopy && u.versionCopy.fromDir ? u.versionCopy.fromDir : u.versionDir;

    const dirs = new Set();
    if (u.versionDir) dirs.add(u.versionDir);
    if (u.versionCopy && u.versionCopy.toDir) dirs.add(u.versionCopy.toDir);
    for (const c of u.changes || []) {
      if (!c || typeof c.path !== 'string') continue;
      const parts = c.path.split('/');
      if (parts.length >= 3 && parts[0] === appDir) dirs.add(parts[1]);
    }

    for (const d of dirs) {
      const prev = map.get(d);
      if (prev) {
        for (const n of names) prev.services.add(n);
        if (!prev.source && source) prev.source = source;
      } else {
        map.set(d, { services: new Set(names), source: source || '' });
      }
    }
  }
  return map;
}

/**
 * 校验一个自动更新批次（整批）
 *
 * 两种模式：
 *   · **BATCH 模式**（`updates` 非空）：只对**本批次改动过的**内容下重判——
 *     镜像 tag 只检查 `updates[].services[].name` 里的 service，其余 service 的
 *     tag 问题降级为 warning（历史遗留债务不阻断本批次）；
 *   · **AUDIT 模式**（`updates` 为空）：全仓审计，所有发现按 error 报出。
 *
 * @param {{root: string, updates?: Array<object>, aliasByDir?: Map}} params
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateUpdateBatch({ root, updates = [], aliasByDir } = {}) {
  const errors = [];
  const warnings = [];

  const aliasMap = aliasByDir instanceof Map ? aliasByDir : loadAliasByDir(root);
  const list = Array.isArray(updates) ? updates.filter(u => u && u.app) : [];
  const batchMode = list.length > 0;

  // 无 updates → 全仓模式：校验每个应用的根 data.yml 与「当前版本目录」
  const appDirs = batchMode
    ? [...new Set(list.map(u => u.app))]
    : listApps(root, aliasMap).map(a => a.dir);

  const table = readReadmeVersionTable(root);

  for (const appDir of appDirs) {
    errors.push(...validateAppStructure(root, appDir, null));

    // 应用根 data.yml
    const rootData = path.join(root, appDir, 'data.yml');
    if (fs.existsSync(rootData)) {
      const { doc, errors: yerr } = parseYamlFile(rootData);
      errors.push(...yerr);
      if (doc !== null && doc !== undefined) {
        const r = validateDataYamlDocument(doc, { label: `${appDir}/data.yml`, appDir });
        errors.push(...r.errors);
        warnings.push(...r.warnings);
      }
    }

    // 版本目录
    let versionDirs = collectVersionDirs(list, appDir);
    if (!versionDirs.length) {
      const cur = getCurrentVersion(root, appDir);
      if (cur) versionDirs = [cur];
    }

    // 本批次每个版本目录更新过的 service（BATCH 模式）
    const updatedByDir = collectUpdatedServices(list, appDir);

    for (const versionDir of versionDirs) {
      errors.push(...validateAppStructure(root, appDir, versionDir));

      const dataPath = path.join(root, appDir, versionDir, 'data.yml');
      if (fs.existsSync(dataPath)) {
        const { doc, errors: yerr } = parseYamlFile(dataPath);
        errors.push(...yerr);
        if (doc !== null && doc !== undefined) {
          const r = validateDataYamlDocument(doc, {
            label: `${appDir}/${versionDir}/data.yml`,
            appDir,
          });
          errors.push(...r.errors);
          warnings.push(...r.warnings);
        }
      }

      const composePath = path.join(root, appDir, versionDir, 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        const { doc, errors: yerr } = parseYamlFile(composePath);
        errors.push(...yerr);
        if (doc !== null && doc !== undefined) {
          // BATCH 模式：只有本批次改过的 service 的 tag 问题算 error；
          // AUDIT 模式：updatedServices = null → 全部按 error。
          const info = updatedByDir.get(versionDir);
          const updatedServices = batchMode ? (info ? info.services : new Set()) : null;
          const source = info && info.source ? `${appDir}/${info.source}` : `${appDir}/${versionDir}`;
          const r = validateComposeDocument(doc, {
            label: `${appDir}/${versionDir}/docker-compose.yml`,
            updatedServices,
            inheritedFrom: source,
          });
          errors.push(...r.errors);
          warnings.push(...r.warnings);
        }
      }
    }

    // README 版本一致性
    errors.push(...validateReadmeVersion(root, appDir, aliasMap.get(appDir), table));
  }

  return { errors, warnings };
}
