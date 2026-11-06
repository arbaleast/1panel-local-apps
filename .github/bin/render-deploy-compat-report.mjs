#!/usr/bin/env node
// bin/render-deploy-compat-report.mjs — 把 lint --json 结果渲染成 CI 分级报告
//
// 定位：CI 的**渲染层**，只做「结构化 findings → annotations + Step Summary」。
//   · 不含任何规则判定（规则在 lib/deploy-compat.mjs / lib/consistency.mjs）
//   · 不改退出码语义（Level 1 error → exit 1 阻塞；Level 2 warning / UNVERIFIED → 不阻塞）
//   · 复用 lib/report.mjs#escapeCell（**不另写一套表格转义**）
//
// 三态分级（目标 §十）：
//   Level 1  P0/P1 → error    → 阻塞 PR 合并（exit 1）
//   Level 2  P2    → warning  → ::warning:: 注解 + Summary，不阻塞
//   UNVERIFIED P3  → notice   → ::notice:: 注解 + Summary，**明确写「未验证」而非「通过」**
//
// 用法：node .github/bin/render-deploy-compat-report.mjs <lint-json 路径>

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { escapeCell } from '../lib/report.mjs';

/** GitHub 单个 step 同类型 annotation 上限 10 条 */
const ANNOTATION_LIMIT = 10;

/**
 * 输出一条 annotation。
 * @param {'warning'|'notice'|'error'} level
 * @param {string} message
 * @param {{file?:string, line?:number|null, title?:string}} [opts]
 */
function annotate(level, message, opts = {}) {
  // GitHub annotation 格式：`::warning file=...,line=...,title=...::message`
  // ⚠️ level 之后**必须有空格**，否则 GitHub 解析不出属性。
  const attrs = [];
  if (opts.file) attrs.push(`file=${opts.file}`);
  if (opts.line) attrs.push(`line=${opts.line}`);
  if (opts.title) attrs.push(`title=${opts.title}`);
  const head = attrs.length ? `::${level} ${attrs.join(',')}` : `::${level}`;
  console.log(`${head}::${String(message).replace(/\r?\n/g, ' ')}`);
}

/**
 * 追加到 GitHub Step Summary（不存在时静默跳过）。
 * @param {string} md
 */
function appendSummary(md) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try { appendFileSync(target, md, 'utf8'); } catch { /* 无 summary 目标时不影响主流程 */ }
}

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {number} 退出码：存在 Level 1 error → 1
 */
export function main(argv) {
  const file = argv[2];
  if (!file || !existsSync(file)) {
    console.error(`用法: node .github/bin/render-deploy-compat-report.mjs <lint-json 路径>（找不到 ${file ?? '(未指定)'}）`);
    return 1;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`无法解析 ${file}: ${err.message}`);
    return 1;
  }

  const findings = data?.findings ?? {};
  const errors = Array.isArray(findings.errors) ? findings.errors : [];
  const warnings = Array.isArray(findings.warnings) ? findings.warnings : [];
  const unverified = Array.isArray(findings.unverified) ? findings.unverified : [];
  const waived = Array.isArray(findings.waived) ? findings.waived : [];

  // ── Level 2：warning 注解 ───────────────────────────────────────────────
  for (const f of warnings.slice(0, ANNOTATION_LIMIT)) {
    annotate('warning', f.message, { file: f.file, line: f.line, title: f.ruleId });
  }
  if (warnings.length > ANNOTATION_LIMIT) {
    annotate('warning', `另有 ${warnings.length - ANNOTATION_LIMIT} 条 Level 2 警告未逐一标注（GitHub 单 step 上限 ${ANNOTATION_LIMIT} 条），完整清单见 lint 日志与 Step Summary`, { title: 'deploy-compat' });
  }

  // ── UNVERIFIED：notice 注解（**不阻塞**，且明确写「未验证」）────────────
  for (const f of unverified.slice(0, ANNOTATION_LIMIT)) {
    annotate('notice', `未验证（不阻塞）：${f.message}`, { file: f.file, line: f.line, title: f.ruleId });
  }
  if (unverified.length > ANNOTATION_LIMIT) {
    annotate('notice', `另有 ${unverified.length - ANNOTATION_LIMIT} 条未验证项未逐一标注，完整清单见 Step Summary`, { title: 'deploy-compat' });
  }

  // ── Step Summary ────────────────────────────────────────────────────────
  const md = [];
  md.push('## 部署兼容性分级报告');
  md.push('');
  md.push(`- 应用数：**${data?.apps ?? '?'}** ｜ manifest 模式：${data?.manifestMode ? '开启' : '关闭（离线）'}`);
  md.push(`- **Level 1（阻塞）**：${errors.length} ｜ **Level 2（警告）**：${warnings.length} ｜ **UNVERIFIED（未验证）**：${unverified.length} ｜ 已豁免：${waived.length}`);
  md.push('');

  if (errors.length) {
    md.push('### Level 1 · 必须通过（阻塞 PR 合并）');
    md.push('');
    md.push('| 规则 | 应用 | 版本 | 位置 | 说明 |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const f of errors) {
      md.push(`| \`${escapeCell(f.ruleId)}\` | ${escapeCell(f.app)} | ${escapeCell(f.version ?? '-')} | ${escapeCell(f.file)} | ${escapeCell(f.message)} |`);
    }
    md.push('');
  }

  if (warnings.length) {
    md.push('### Level 2 · 警告提示（非阻塞）');
    md.push('');
    md.push('| 规则 | 应用 | 版本 | 位置 | 说明 |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const f of warnings) {
      md.push(`| \`${escapeCell(f.ruleId)}\` | ${escapeCell(f.app)} | ${escapeCell(f.version ?? '-')} | ${escapeCell(f.file)} | ${escapeCell(f.message)} |`);
    }
    md.push('');
  }

  if (unverified.length) {
    md.push('### UNVERIFIED · 未验证（非阻塞，**不等于通过**）');
    md.push('');
    md.push('| 规则 | 应用 | 版本 | 原因 |');
    md.push('| --- | --- | --- | --- |');
    for (const f of unverified) {
      md.push(`| \`${escapeCell(f.ruleId)}\` | ${escapeCell(f.app)} | ${escapeCell(f.version ?? '-')} | ${escapeCell(f.actual ?? f.message)} |`);
    }
    md.push('');
  }

  if (!errors.length && !warnings.length && !unverified.length) {
    md.push('_无发现项。_');
    md.push('');
  }

  appendSummary(md.join('\n'));

  console.log(`deploy-compat: Level1 errors=${errors.length} ｜ Level2 warnings=${warnings.length} ｜ unverified=${unverified.length} ｜ waived=${waived.length}`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('render-deploy-compat-report.mjs')) {
  process.exitCode = main(process.argv);
}
