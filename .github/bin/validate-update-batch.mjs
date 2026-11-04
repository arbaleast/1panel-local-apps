#!/usr/bin/env node
// bin/validate-update-batch.mjs — 批次配置校验 CLI（薄入口）
//
// 校验**当前工作树**里的自动更新批次：
//   · 若存在 updates.json 且其中有更新记录 → **BATCH 模式**：只校验本批次
//     涉及的应用，且只对**本批次改动过的** service 判镜像 tag 错误
//     （历史遗留债务如 firecrawl 的 playwright-service:latest 只告警，
//     不会把合法批次永久堵死）；
//   · 否则 → **AUDIT 模式**：校验全仓（每个应用的根 data.yml + 当前版本目录），
//     所有发现按 error 报出（供人工审计）。
//
// 输出 errors / warnings；有 errors 时以非零码退出（可作为 CI 门禁）。
// 用法：node .github/bin/validate-update-batch.mjs   （无需任何参数）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateUpdateBatch, loadAliasByDir } from '../lib/validate-batch.mjs';

// 仓库根 = 本脚本所在 .github/bin 的上上级
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
}

// ─── 读取 updates.json（可选）──────────────────────────────────────────────

let updates = [];
let scope = '全仓';
let mode = 'audit';
const updatesPath = path.join(ROOT, 'updates.json');
if (fs.existsSync(updatesPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(updatesPath, 'utf8'));
    if (Array.isArray(parsed.updates)) updates = parsed.updates;
    scope = `updates.json 中的 ${new Set(updates.map(u => u && u.app).filter(Boolean)).size} 个应用`;
    mode = updates.length ? 'batch' : 'audit';
  } catch (e) {
    fail(`[ERROR] updates.json 解析失败: ${e.message}`);
    process.exit(1);
  }
} else {
  log('[INFO] 未找到 updates.json，改为校验全仓应用');
}
log(
  `[INFO] 校验模式：${
    mode === 'batch'
      ? 'BATCH（只对本批次改动过的内容下重判；历史遗留债务只告警）'
      : 'AUDIT（全仓审计，所有发现按 error 报出）'
  }`,
);

// ─── 执行校验 ─────────────────────────────────────────────────────────────

const { errors, warnings } = validateUpdateBatch({
  root: ROOT,
  updates,
  aliasByDir: loadAliasByDir(ROOT),
});

if (warnings.length) {
  log(`\n[WARN] ${warnings.length} 条规约告警（不阻断）：`);
  for (const w of warnings) log(`  · ${w}`);
}

if (errors.length) {
  fail(`\n[ERROR] 批次校验失败：${errors.length} 个错误（校验范围：${scope}）`);
  for (const e of errors) fail(`  · ${e}`);
  process.exit(1);
}

log(`\n[OK] 批次校验通过（校验范围：${scope}，${warnings.length} 条告警）`);
process.exit(0);
