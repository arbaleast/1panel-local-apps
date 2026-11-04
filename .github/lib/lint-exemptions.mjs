// lib/lint-exemptions.mjs — SSOT 校验豁免机制（阶段 3）
//
// 设计原则（Gate 1 获批决策 3）：
//   1. 数据驱动：豁免登记在 .github/lint-exemptions.yml，不散落代码 if；
//   2. 最小粒度：app（必填）→ version（可选）→ value（可选）逐级收窄；
//   3. 强制 reason：没有说明的豁免一律拒绝（防止「懒得改就豁免」）；
//   4. 不腐化：死亡条目（app/版本/规则已不存在）由 lint 报 error，强制清理；
//   5. 无全局开关：不存在「全部豁免」写法。
//
// 文件结构：
//   exemptions:
//     - app: linkwarden
//       ruleId: tag.dir
//       version: v1.56.1       # 可选；省略 = 应用全部版本
//       value: '...'           # 可选；仅对 finding.actual 等于此值的条目生效
//       reason: '...'          # 必填非空

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { RULE_IDS } from './consistency.mjs';

export const EXEMPTIONS_FILE = '.github/lint-exemptions.yml';
const ENTRY_KEYS = new Set(['app', 'ruleId', 'version', 'value', 'reason']);
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i; // 应用目录名/ruleId 的放宽一点的标识符

/**
 * 解析并结构校验豁免文件。
 * @returns {{ list: Array, schemaErrors: string[], fileUsed: boolean }}
 *   list 永远是数组（含仅结构上可用的条目；schemaErrors 非空时调用方必须先报 error）。
 */
export function loadExemptions(root) {
  const file = join(root, EXEMPTIONS_FILE);
  if (!existsSync(file)) return { list: [], schemaErrors: [], fileUsed: false };
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch (err) {
    return { list: [], schemaErrors: [`${EXEMPTIONS_FILE}: YAML 解析失败 — ${err.message}`], fileUsed: true };
  }
  const schemaErrors = [];
  const list = [];
  // 纯注释文件（doc === null）= 「占位但零豁免」，合法状态；故意不开全局开关
  const raw = doc === null ? [] : Array.isArray(doc?.exemptions) ? doc.exemptions : null;
  if (!raw) {
    schemaErrors.push(`${EXEMPTIONS_FILE}: 顶层必须是 exemptions: 列表`);
    return { list, schemaErrors, fileUsed: true };
  }
  const seenKey = new Set(); // 同一 app+ruleId+version+value 的完全重复条目视作死条目
  raw.forEach((e, i) => {
    const at = `${EXEMPTIONS_FILE} #${i + 1}`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      schemaErrors.push(`${at}: 条目必须是对象`);
      return;
    }
    const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k));
    if (unknown.length) schemaErrors.push(`${at}: 未知字段 ${unknown.join(', ')}（允许 app|ruleId|version|value|reason）`);
    for (const req of ['app', 'ruleId', 'reason']) {
      if (typeof e[req] !== 'string' || e[req].trim() === '') schemaErrors.push(`${at}: 缺少必填项 ${req}`);
    }
    if (e.version !== undefined && (e.version === null || typeof e.version !== 'string' || e.version.trim() === '')) {
      schemaErrors.push(`${at}: version 须为非空字符串`);
    }
    if (e.value !== undefined && (e.value === null || typeof e.value !== 'string' || e.value.trim() === '')) {
      schemaErrors.push(`${at}: value 须为非空字符串`);
    }
    if (typeof e.app === 'string' && !NAME_RE.test(e.app)) schemaErrors.push(`${at}: app="${e.app}" 不是合法目录名`);
    if (typeof e.ruleId === 'string' && !RULE_IDS.has(e.ruleId)) {
      schemaErrors.push(`${at}: 未知 ruleId="${e.ruleId}"（合法：${[...RULE_IDS].sort().join(', ')}）`);
    }
    const dedupe = `${e.app ?? ''}|${e.ruleId ?? ''}|${e.version ?? ''}|${e.value ?? ''}`;
    if (seenKey.has(dedupe)) schemaErrors.push(`${at}: 与先前条目完全重复（app/ruleId/version/value 相同）`);
    seenKey.add(dedupe);
    list.push(e);
  });
  return { list, schemaErrors, fileUsed: true };
}

/**
 * 匹配单条豁免（与 .github/lint-exemptions.yml 头部注释同义）：
 *   - version 省略 → 豁免该应用此规则下的全部 finding（版本级 + 应用级）；
 *   - version 填写 → 仅命中该版本目录的 finding（应用级 finding version=null 永不命中）；
 *   - value 填写 → 额外要求 finding.actual 精确相等。
 */
export function exemptionMatches(entry, f) {
  if (entry.app !== f.app) return false;
  if (entry.ruleId !== f.ruleId) return false;
  if (entry.version !== undefined && f.version !== entry.version) return false;
  if (entry.value !== undefined && entry.value !== f.actual) return false;
  return true;
}

/** 套用豁免：{ active, waived } */
export function applyWaivers(findings, list) {
  const active = [];
  const waived = [];
  for (const f of findings) {
    const hit = list.find((e) => exemptionMatches(e, f));
    (hit ? waived : active).push(hit ? { ...f, waivedBy: hit } : f);
  }
  return { active, waived };
}

/**
 * 死亡条目检测（lint 出 error，强制清理，保证豁免文件不腐化）。
 * @param {Array} list 豁免条目
 * @param {Map<string, Map<string, Set<string>>>} observed
 *   app → ruleId → Set(版本目录名 ∪ finding.actual)；由 bin 层采集（豁免前全量 finding）。
 * @returns {{ entry, reason }[]}
 */
export function findDeadExemptions(list, observed) {
  const dead = [];
  for (const e of list) {
    const byRule = observed.get(e.app);
    if (!byRule) { dead.push({ entry: e, reason: `应用目录 "${e.app}" 不存在` }); continue; }
    const bucket = byRule.get(e.ruleId);
    if (!bucket) { dead.push({ entry: e, reason: `应用 "${e.app}" 近期未产生 ruleId=${e.ruleId} 的 finding` }); continue; }
    if (e.version !== undefined && !bucket.has(e.version)) {
      dead.push({ entry: e, reason: `应用 "${e.app}" 目录 "${e.version}" 不存在或不产生该 rule 的 finding` });
      continue;
    }
    if (e.value !== undefined && !bucket.has(e.value)) {
      dead.push({ entry: e, reason: `应用 "${e.app}" 不存在 actual=${e.value} 的实际 finding` });
    }
  }
  return dead;
}
