#!/usr/bin/env node
// bin/lint-apps.mjs — 扫描所有应用 data.yml 并校验 schema 合规性
// zod 依赖仅在此层（bin/）引入，lib/ 层保持零第三方依赖（仅 js-yaml）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { listApps, getAppMeta } from '../lib/apps.mjs';
import { checkImagePolicy } from '../lib/image-policy.mjs';
import {
  validateFormField,
  validateKeyMatch,
  normalizeFormField,
  validateUrlField,
  FORMFIELD_TYPE_WHITELIST,
  TYPE_ENUM,
  ROOT_REQUIRED_FIELDS,
} from '../lib/schema.mjs';
import {
  RULE_IDS,
  stripCommentedLines,
  runVersionChecks,
  checkReadmeVars,
} from '../lib/consistency.mjs';
import {
  loadExemptions,
  findDeadExemptions,
  applyWaivers,
  EXEMPTIONS_FILE,
} from '../lib/lint-exemptions.mjs';
import { runDeployCompatChecks, panelEnvOf } from '../lib/deploy-compat.mjs';
import { collectManifests } from './manifest-collector.mjs';
import { detectComposeCli, checkComposeWithCli } from './compose-cli-check.mjs';

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

// 本文件所在的**仓库根**（恒定）。
// 本文件位于 `.github/bin/`，仓库根是上两级（`../../`）；写成 `..` 会落到 `.github/`，
// 导致 listApps() 扫到 0 个应用、lint 永远打印 "PASSED"（假绿）。
// 用 fileURLToPath + URL 解析（Node >= 12 即可），不依赖 20.11+ 才有的 import.meta.dirname。
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 读取 `--<name> <value>` 形式的命令行参数值
 * @param {string} name 参数名（含 --）
 * @param {string[]} [argv]
 * @returns {string|null}
 */
function argValue(name, argv = process.argv) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return null;
  return v;
}

// 扫描目标：默认整个仓库；`--root <dir>` 可指向任意目录。
// 审计 P1-7：自动更新链路需要在 **staging 目录**上复用同一套 SSOT 校验，
// 而旧实现的 ROOT 硬编码、core 函数未导出 → 根本无法校验 staging。
//
// `--root` 模式是**局部扫描**（partial scan）：
//   · 豁免表仍从真实仓库读（豁免是仓库级 SSOT 产物，不属于被扫描内容）
//   · 跳过「死亡豁免条目」判定（局部视图无法判定条目是否已失效）
//   · 跳过镜像 hardcode 策略的全仓不变式（那是仓库级不变量，不是单应用规则）
const rootArg = argValue('--root');
const SCAN_ROOT = rootArg ? resolve(rootArg) : REPO_ROOT;
const IS_PARTIAL_SCAN = SCAN_ROOT !== REPO_ROOT;

const apps = listApps(SCAN_ROOT);

// ─── 镜像 manifest 采集（可选，--manifest）────────────────────────────────
// 阶段 3 的 CPU 架构核验需要外部 registry 的 OCI 元数据。
// 默认**不启用**：保持 `npm run lint` 完全离线、秒级、无外部请求（PR 上可无脑跑）。
// `--manifest` 才发起**只读** HTTP 请求（只拉 JSON 元数据，绝不 pull 镜像层）。
const useManifest = process.argv.includes('--manifest');
/** @type {Map<string, object>|null} 镜像 → manifest 结果；null = 离线模式 */
let manifestMap = null;
if (useManifest) {
  const cacheFile = process.env.MANIFEST_CACHE_FILE
    || join(REPO_ROOT, '.agent_cache', 'manifest-cache.json');
  const collected = await collectManifests(SCAN_ROOT, {
    cacheFile,
    log: (m) => console.error(`manifest: ${m}`),
  });
  manifestMap = collected.manifests;
}

let totalErrors = 0;
let totalWarnings = 0;
let totalUnverified = 0;

// ─── `docker compose config` 真实渲染校验（可选，--compose-cli）──────────
// 阶段 2 的第二条腿：把**原始 compose + 1Panel 上下文 .env** 交给真实的 compose CLI 解析。
// CLI 不可用时**降级**为静态 AST 校验，并把降级事实写进摘要 —— 绝不把降级说成「compose config 通过」。
const useComposeCli = process.argv.includes('--compose-cli');
const composeCli = useComposeCli ? detectComposeCli() : { available: false, version: null, reason: '未启用（--compose-cli）' };
if (useComposeCli) {
  if (composeCli.available) console.error(`compose-cli: ${composeCli.version}`);
  else console.error(`compose-cli: 不可用（${composeCli.reason}）→ 已降级为静态 AST 校验`);
}

for (const app of apps) {
  const fullPath = join(SCAN_ROOT, app.dir);

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

// ─── 镜像 hardcode 策略（AGENTS.md §6）────────────────────────────────────
// 变量型镜像只允许出现在例外清单内；清单见 lib/image-policy.mjs。
// 过去这条规则只写在文档里、没有守卫，2026-11 迁移因此漏掉 music-tag-web/2.8.1。
const policy = IS_PARTIAL_SCAN ? { errors: [] } : checkImagePolicy(SCAN_ROOT);
for (const err of policy.errors) console.error(`ERROR   ${err}`);
totalErrors += policy.errors.length;

// ─── SSOT 跨文件一致性校验（docs/compose-conventions.md 的代码化下游）───────
// 规则以 lib/consistency.mjs 为唯一事实来源；豁免登记在 .github/lint-exemptions.yml。
// 本段只做编排（扫描/装载/豁免/输出），不含任何规则本体。

const showJson = process.argv.includes('--json');
let findings = [];        // 豁免前全量（死亡条目判定依赖它）
const observed = new Map(); // app → ruleId → Set(版本目录名 ∪ actual 值)

for (const app of apps) {
  const appPath = join(SCAN_ROOT, app.dir);

  // 根级 data.yml（宽松装载：zod 校验已单独负责结构合法性）
  let rootDoc = null;
  const rootDataPath = join(appPath, 'data.yml');
  if (existsSync(rootDataPath)) {
    try { rootDoc = yaml.load(readFileSync(rootDataPath, 'utf8')); } catch { /* 由 zod 段报解析错误 */ }
  }

  // 版本目录（口径与 lintAllVersionDirs 一致）
  let entries = [];
  try { entries = readdirSync(appPath, { withFileTypes: true }); } catch { /* 由 listApps 段负责 */ }
  const versionDirs = entries.filter((e) =>
    e.isDirectory() && e.name !== 'data' && e.name !== 'scripts' && !e.name.startsWith('.'));

  const versionDocs = [];
  // README（应用级）：部署兼容性规则（GPU 前置条件说明 / 权限说明漂移）需要读它，
  // 故在版本循环**之前**读一次，避免每个版本目录重复读盘。
  const readmeAbs = join(appPath, 'README.md');
  let readmeRaw = null;
  if (existsSync(readmeAbs)) {
    try { readmeRaw = readFileSync(readmeAbs, 'utf8'); } catch { /* 由 checkReadmeVars 段负责 */ }
  }
  const readmePath = `${app.dir}/README.md`;

  for (const ve of versionDirs) {
    const versionPath = join(appPath, ve.name);
    const hasDataYml  = existsSync(join(versionPath, 'data.yml'));
    const hasCompose  = existsSync(join(versionPath, 'docker-compose.yml'));
    if (!hasDataYml && !hasCompose) continue;

    let versionDoc = null;
    let versionRaw = '';
    if (hasDataYml) {
      try { versionRaw = readFileSync(join(versionPath, 'data.yml'), 'utf8'); } catch { /* 由 zod 段报 */ }
      try { versionDoc = yaml.load(versionRaw); } catch { /* 由 zod 段报 */ }
    }
    let composeRaw = '';
    if (hasCompose) {
      try { composeRaw = readFileSync(join(versionPath, 'docker-compose.yml'), 'utf8'); } catch { /* 同上 */ }
    }
    let composeDoc = null;
    if (composeRaw) {
      // 与 registry/更新链路同口径：剥注释行后再解析，文档样例不影响结构判断
      try { composeDoc = yaml.load(stripCommentedLines(composeRaw).map((l) => l.text).join('\n')); } catch { /* 结构缺失时逐规则静默降级 */ }
    }
    // 版本脚本目录全文（formField 可能由 init.sh 等钩子消费，见 goal §5.3「未通过 .env/脚本」）
    let scriptsText = '';
    const scriptsDir = join(versionPath, 'scripts');
    if (existsSync(scriptsDir)) {
      for (const se of readdirSync(scriptsDir, { withFileTypes: true })) {
        if (!se.isFile()) continue;
        try { scriptsText += `\n${readFileSync(join(scriptsDir, se.name), 'utf8')}`; } catch { /* 二进制等不可读内容按空处理 */ }
      }
    }

    const ctx = {
      app: app.dir,
      version: ve.name,
      dataPath: `${app.dir}/${ve.name}/data.yml`,
      composePath: `${app.dir}/${ve.name}/docker-compose.yml`,
      readmePath,
      rootDoc, versionDoc, composeRaw, versionRaw, composeDoc, scriptsText, readmeRaw,
      // 阶段 3 架构核验的镜像元数据；离线模式（默认）为 null → 相关规则不产出 finding
      manifests: manifestMap,
    };
    findings.push(...runVersionChecks(ctx));
    // 阶段 2 / 4 / 5 / 6 的部署兼容性规则（与既有规则共用 finding 形状与豁免机制）
    findings.push(...runDeployCompatChecks(ctx));
    // 阶段 2 第二条腿：真实 `docker compose config` 校验（CLI 可用时）
    if (composeCli.available && composeRaw) {
      const cli = checkComposeWithCli({
        composeRaw,
        env: panelEnvOf(ctx),
        label: `${app.dir}/${ve.name}/docker-compose.yml`,
      });
      if (!cli.ok) {
        findings.push({
          severity: 'P0',
          ruleId: 'compose.render',
          app: app.dir,
          version: ve.name,
          file: `${app.dir}/${ve.name}/docker-compose.yml`,
          line: null,
          message: `docker compose config 校验失败：${cli.error}`,
          actual: String(cli.error).split('\n').slice(0, 3).join(' | '),
          expected: 'compose 在 1Panel 变量上下文下可被 docker compose 零错误解析',
        });
      }
    }
    versionDocs.push(versionDoc);
  }

  // README（应用级，version=null）
  if (readmeRaw !== null) {
    findings.push(...checkReadmeVars({
      app: app.dir,
      version: null,
      readmePath,
      readmeRaw,
      versionDocs,
    }));
  }
}

// 死亡条目观察表（豁免前全量）
// ⚠️ **P3（UNVERIFIED）不参与死亡条目判定**：UNVERIFIED 是「环境查不到」的瞬时状态
//    （网络波动 / 限流 / 私有源），不是稳定的「规则被触发」信号。
//    否则离线扫描（无 --manifest）会把 arch.unverified 类的豁免误判成死条目并报 error。
for (const f of findings) {
  if (f.severity === 'P3') continue;
  if (!observed.has(f.app)) observed.set(f.app, new Map());
  const byRule = observed.get(f.app);
  if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, new Set());
  const bucket = byRule.get(f.ruleId);
  if (f.version) bucket.add(f.version);
  if (f.actual) bucket.add(String(f.actual));
}

// 豁免：结构错误与死亡条目都是 error（强制说明 + 强制清理）
const { list: exemptionList, schemaErrors: exemptionSchemaErrors } = loadExemptions(REPO_ROOT);
for (const msg of exemptionSchemaErrors) {
  console.error(`ERROR   ${EXEMPTIONS_FILE}: ${msg}`);
  totalErrors += 1;
}
// 死亡条目判定：只在**全仓扫描**时做 —— 局部扫描（staging）只看到 1 个应用 / 1 个版本目录，
// 其余豁免条目会被误判成"死亡"（审计 P1-7 的局部扫描语义）。
if (!IS_PARTIAL_SCAN) {
  for (const { entry, reason } of findDeadExemptions(exemptionList, observed)) {
    console.error(`ERROR   ${EXEMPTIONS_FILE}: 死亡条目 ${reason}（app=${entry.app} ruleId=${entry.ruleId}${entry.version ? ` version=${entry.version}` : ''}）`);
    totalErrors += 1;
  }
}

const { active, waived } = applyWaivers(findings, exemptionList);
for (const f of active) {
  const loc  = `${f.file}${f.line ? `:${f.line}` : ''}`;
  const tail = f.actual != null ? ` | actual=${f.actual}${f.expected != null ? ` ⇨ expected=${f.expected}` : ''}` : '';
  // 三态分级：P0/P1 → ERROR（阻塞）；P2 → WARN（不阻塞）；P3 → UNVERIFIED（单列，不影响 exit code）
  if (f.severity === 'P2') { console.warn(`WARN    [${f.ruleId}] ${loc} - ${f.message}${tail}`); totalWarnings += 1; }
  else if (f.severity === 'P3') { console.warn(`UNVERIF [${f.ruleId}] ${loc} - ${f.message}${tail}`); totalUnverified += 1; }
  else                     { console.error(`ERROR   [${f.ruleId}] ${loc} - ${f.message}${tail}`); totalErrors   += 1; }
}

if (showJson) {
  // 机器可读视图：P0/P1 为 errors，P2 为 warnings，P3 为 unverified；waived 单列出豁免命中
  const pick = ({ ruleId, app, version, file, line, message, actual, expected }) =>
    ({ ruleId, app, version, file, line, message, actual, expected });
  console.log(JSON.stringify({
    apps: apps.length,
    scanRoot: SCAN_ROOT,
    partialScan: IS_PARTIAL_SCAN,
    manifestMode: useManifest,
    errors: totalErrors,
    warnings: totalWarnings,
    unverified: totalUnverified,
    waived: waived.length,
    findings: {
      errors: active.filter((f) => f.severity !== 'P2' && f.severity !== 'P3').map(pick),
      warnings: active.filter((f) => f.severity === 'P2').map(pick),
      unverified: active.filter((f) => f.severity === 'P3').map(pick),
      waived: waived.map((f) => ({ ...pick(f), waivedBy: f.waivedBy.reason })),
    },
  }, null, 2));
}

// ─── 输出摘要 ───────────────────────────────────────────────────────────────

if (!showJson) {
  console.log(`\n── lint summary ──────────────────────────────`);
  console.log(`apps scanned : ${apps.length}`);
  console.log(`errors       : ${totalErrors}`);
  console.log(`warnings     : ${totalWarnings}`);
  console.log(`unverified   : ${totalUnverified}`);
  console.log(`waived       : ${waived.length}`);
  console.log(`manifest     : ${useManifest ? 'enabled' : 'disabled (offline)'}`);
  console.log(`compose-cli  : ${useComposeCli ? (composeCli.available ? composeCli.version : `unavailable (${composeCli.reason}) → 静态 AST 降级`) : 'disabled'}`);
}

// 用 exitCode 而非 process.exit()：后者会在管道输出未刷新时截断 --json（文件重定向不受影响）
if (totalErrors > 0) {
  if (!showJson) console.log(`\nFAILED — ${totalErrors} error(s) found`);
  process.exitCode = 1;
} else if (totalWarnings > 0) {
  if (!showJson) console.log(`\nPASSED (with warnings)`);
} else {
  if (!showJson) console.log(`\nPASSED`);
}