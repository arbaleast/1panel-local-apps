#!/usr/bin/env node
// bin/lint-apps.mjs — 扫描所有应用 data.yml 并校验 schema 合规性
// zod 依赖仅在此层（bin/）引入，lib/ 层保持零第三方依赖（仅 js-yaml）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { listApps, getAppMeta } from '../lib/apps.mjs';
import {
  validateFormField,
  validateKeyMatch,
  normalizeFormField,
  validateUrlField,
  FORMFIELD_TYPE_WHITELIST,
  TYPE_ENUM,
  ROOT_REQUIRED_FIELDS,
} from '../lib/schema.mjs';

// ─── Zod schema（bin/ 层可用 zod，lib/ 层禁止引入）──────────────────────────

// formField Zod schema（结构校验，规则校验由 lib/schema.mjs 补充）
const formFieldZodSchema = z.object({
  envKey:  z.string().min(1),
  label:   z.record(z.string()).optional(),
  labelEn: z.string().optional(),
  labelZh: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  type:    z.string(),
  required: z.boolean().optional(),
  edit:    z.boolean().optional(),
  rule:    z.string().optional(),
  values:  z.array(z.object({ label: z.union([z.string(), z.number()]), value: z.union([z.string(), z.number()]) })).optional(),
  random:  z.boolean().optional(),
});

// 根级 additionalProperties schema
const rootAdditionalPropertiesSchema = z.object({
  key:                z.string().min(1),
  name:               z.string().min(1),
  type:               z.enum(TYPE_ENUM).default('tool'),
  tags:               z.array(z.string()).optional(),
  shortDescZh:        z.string().optional(),
  shortDescEn:        z.string().optional(),
  description:        z.record(z.string()).optional(),
  architectures:      z.array(z.enum(['amd64', 'arm64', 'arm/v7', '386'])).optional(),
  crossVersionUpdate: z.boolean().optional(),
  limit:              z.number().int().min(0).optional(),
  recommend:          z.number().int().min(0).optional(),
  website:            z.string().optional(),
  github:            z.string().optional(),
  document:           z.string().optional(),
  formFields:         z.array(formFieldZodSchema).optional(),
});

// 根级 data.yml：{ additionalProperties: {...} }
const rootDataYmlSchema = z.object({
  additionalProperties: rootAdditionalPropertiesSchema,
});

// 版本级 additionalProperties（formFields 必填）
const versionAdditionalPropertiesSchema = rootAdditionalPropertiesSchema.extend({
  formFields: z.array(formFieldZodSchema),
});

// 版本级 data.yml 两种格式
const versionDataYmlSchema = z.union([
  z.object({ additionalProperties: versionAdditionalPropertiesSchema }),
  z.object({
    name:               z.string().optional(),
    title:              z.string().optional(),
    description:        z.record(z.string()).optional(),
    additionalProperties: versionAdditionalPropertiesSchema,
  }),
]);

// ─── 校验函数 ──────────────────────────────────────────────────────────────

/**
 * 校验根级 data.yml
 * @param {string} appDir - 应用目录名（不含路径）
 * @param {string} fullPath - 应用完整路径
 * @returns {{ errors: string[], warnings: string[] }}
 */
function lintRootDataYml(appDir, fullPath) {
  const errors = [];
  const warnings = [];
  const metaPath = join(fullPath, 'data.yml');

  if (!existsSync(metaPath)) return { errors, warnings };

  let data;
  try {
    data = yaml.load(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    errors.push(`${appDir}/data.yml: YAML 解析失败 — ${err.message}`);
    return { errors, warnings };
  }

  const result = rootDataYmlSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? `${appDir}/data.yml:${issue.path.join('.')}` : `${appDir}/data.yml`;
      errors.push(`${path}: ${issue.message}`);
    }
    return { errors, warnings };
  }

  const props = result.data.additionalProperties;

  // 必须字段
  for (const field of ROOT_REQUIRED_FIELDS) {
    if (!props[field]) {
      errors.push(`${appDir}/data.yml: 缺少必需字段 additionalProperties.${field}`);
    }
  }

  // key 须与目录名一致
  errors.push(...validateKeyMatch(props.key || '', appDir, `${appDir}/data.yml:additionalProperties.key`));

  // URL 字段格式
  for (const field of ['website', 'github', 'document']) {
    errors.push(...validateUrlField(props[field], field, `${appDir}/data.yml:additionalProperties`));
  }

  // formFields 结构校验（补充 lib/schema.mjs 的规则校验）
  if (props.formFields) {
    for (let i = 0; i < props.formFields.length; i++) {
      const field = normalizeFormField(props.formFields[i]);
      const path = `${appDir}/data.yml:additionalProperties.formFields[${i}].envKey=${field.envKey}`;
      // formFieldZodSchema 已做结构校验，此处补充规则校验
      errors.push(...validateFormField(field, path));
    }
  }

  // 警告：若 formFields 出现在根级（非标准用法）
  if (props.formFields && props.formFields.length > 0) {
    warnings.push(`${appDir}/data.yml: additionalProperties.formFields 在根级 data.yml 中通常不填（应填在版本子目录 data.yml 中）`);
  }

  return { errors, warnings };
}

/**
 * 校验版本级 data.yml
 * @param {string} appDir - 应用目录名
 * @param {string} versionDir - 版本目录名
 * @param {string} fullPath - 版本完整路径
 * @returns {{ errors: string[], warnings: string[] }}
 */
function lintVersionDataYml(appDir, versionDir, fullPath) {
  const errors = [];
  const warnings = [];
  const metaPath = join(fullPath, 'data.yml');

  if (!existsSync(metaPath)) return { errors, warnings };

  let data;
  try {
    data = yaml.load(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    errors.push(`${appDir}/${versionDir}/data.yml: YAML 解析失败 — ${err.message}`);
    return { errors, warnings };
  }

  const result = versionDataYmlSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0
        ? `${appDir}/${versionDir}/data.yml:${issue.path.join('.')}`
        : `${appDir}/${versionDir}/data.yml`;
      errors.push(`${path}: ${issue.message}`);
    }
    return { errors, warnings };
  }

  // 提取 additionalProperties（两种格式统一）
  const props = result.data.additionalProperties || result.data;

  // key 须与目录名一致
  errors.push(...validateKeyMatch(props.key || '', appDir, `${appDir}/${versionDir}/data.yml:additionalProperties.key`));

  // formFields 规则校验
  if (props.formFields) {
    for (let i = 0; i < props.formFields.length; i++) {
      const field = normalizeFormField(props.formFields[i]);
      const path = `${appDir}/${versionDir}/data.yml:formFields[${i}].envKey=${field.envKey}`;
      errors.push(...validateFormField(field, path));
    }
  }

  return { errors, warnings };
}

/**
 * 扫描应用的所有版本目录
 * @param {string} appDir
 * @param {string} fullPath
 * @returns {{ errors: string[], warnings: string[] }}
 */
function lintAllVersionDirs(appDir, fullPath) {
  const errors = [];
  const warnings = [];

  let entries;
  try {
    entries = readdirSync(fullPath, { withFileTypes: true });
  } catch (_) {
    return { errors, warnings };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'data' || entry.name === 'scripts') continue;
    if (entry.name.startsWith('.')) continue; // 过滤隐藏目录，避免被误识别为版本

    const versionPath = join(fullPath, entry.name);
    const hasDataYml  = existsSync(join(versionPath, 'data.yml'));
    const hasCompose  = existsSync(join(versionPath, 'docker-compose.yml'));

    if (!hasDataYml && !hasCompose) continue;

    const { errors: ve, warnings: vw } = lintVersionDataYml(appDir, entry.name, versionPath);
    errors.push(...ve);
    warnings.push(...vw);
  }

  return { errors, warnings };
}

// ─── 主逻辑 ─────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const apps = listApps(ROOT);

let totalErrors = 0;
let totalWarnings = 0;

for (const app of apps) {
  const fullPath = join(ROOT, app.dir);

  // 根级 data.yml 校验
  const { errors: re, warnings: rw } = lintRootDataYml(app.dir, fullPath);
  for (const err of re)   console.error(`ERROR   ${err}`);
  for (const warn of rw)  console.warn  (`WARN    ${warn}`);
  totalErrors   += re.length;
  totalWarnings += rw.length;

  // 版本目录校验
  const { errors: ve, warnings: vw } = lintAllVersionDirs(app.dir, fullPath);
  for (const err of ve)   console.error(`ERROR   ${err}`);
  for (const warn of vw)  console.warn  (`WARN    ${warn}`);
  totalErrors   += ve.length;
  totalWarnings += vw.length;
}

// ─── 输出摘要 ───────────────────────────────────────────────────────────────

console.log(`\n── lint summary ──────────────────────────────`);
console.log(`apps scanned : ${apps.length}`);
console.log(`errors       : ${totalErrors}`);
console.log(`warnings     : ${totalWarnings}`);

if (totalErrors > 0) {
  console.log(`\nFAILED — ${totalErrors} error(s) found`);
  process.exit(1);
} else if (totalWarnings > 0) {
  console.log(`\nPASSED (with warnings)`);
  process.exit(0);
} else {
  console.log(`\nPASSED`);
  process.exit(0);
}
