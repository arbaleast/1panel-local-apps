// lib/report.mjs — detect-updates 汇总报告纯函数（**唯一**的聚合与渲染实现）
//
// 职责：把每个应用的检测结果（{app, status, stage, reason, error?, updates}）
// 聚合成统计 + 渲染控制台文本 / GitHub Step Summary markdown。
//
// 设计约束（audit task 2 follow-up）：
//   - 本模块是 **唯一** 的计数与渲染来源。入口脚本（.github/scripts/detect-updates.mjs）
//     与 CI 工作流（node -e 直接 import 本模块渲染 step summary）都从这里取实现，
//     入口脚本里不再 inline 重复实现（AGENTS.md："入口脚本应优先复用 lib/ 模块，
//     不在入口内 inline 重复实现"）。
//   - 纯函数，无 IO；输入是**普通对象数组**（updates.json 的 JSON 往返结果可直接传入），
//     不含类实例 / 函数，因此 CI 可以 `require('./updates.json').results` 直接渲染。
//   - 每个应用恰好一条记录；status ∈ 'success' | 'skipped' | 'failed'。

/**
 * 结果状态枚举
 * @type {readonly string[]}
 */
export const STATUSES = Object.freeze(['success', 'skipped', 'failed']);

/**
 * 聚合结果统计（唯一计数实现）
 * @param {Array<{app?: string, status?: string, stage?: string, reason?: string, error?: string|null, updates?: number}>} results
 * @returns {{
 *   total: number,
 *   success: number,
 *   skipped: number,
 *   failed: number,
 *   updates: number,
 *   byStatus: Record<string, number>,
 *   byReason: Record<string, number>,
 *   failures: Array<object>,
 * }}
 */
export function aggregateResults(results) {
  const list = Array.isArray(results) ? results : [];
  const byStatus = { success: 0, skipped: 0, failed: 0 };
  const byReason = {};
  const failures = [];
  let updates = 0;

  for (const r of list) {
    const status = r?.status ?? 'failed';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const reason = r?.reason ?? 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const n = Number(r?.updates ?? 0);
    if (Number.isFinite(n) && n > 0) updates += n;
    if (status === 'failed') failures.push(r);
  }

  return {
    total: list.length,
    success: byStatus.success,
    skipped: byStatus.skipped,
    failed: byStatus.failed,
    updates,
    byStatus,
    byReason,
    failures,
  };
}

/**
 * 由结果集决定进程退出码：存在 failed → 2，否则 → 0
 *
 * 契约（detect-updates.mjs 的退出码约定）：
 *   0 = 扫描完成且没有应用失败（含"完全没有更新"）
 *   2 = 至少一个应用 failed
 *
 * @param {Array<{status?: string}>} results
 * @returns {number} 0 | 2
 */
export function exitCodeForResults(results) {
  const list = Array.isArray(results) ? results : [];
  return list.some(r => r?.status === 'failed') ? 2 : 0;
}

/**
 * 转义 markdown 表格单元格（竖线 → \|，换行 → 空格）
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * 转义控制台表格单元格（换行/制表符 → 空格，避免破坏表格结构）
 * @param {unknown} value
 * @returns {string}
 */
function consoleCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
}

/**
 * 渲染控制台汇总文本（唯一 console 渲染实现）
 *
 * 内容：每应用结果表（app / status / stage / reason）+ 计数行 + reason 分布 + 失败明细。
 * @param {Array<object>} results
 * @returns {string}
 */
export function renderSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const agg = aggregateResults(list);
  const lines = [];

  lines.push('=== detect-updates 每应用检测结果 ===');
  lines.push('应用\t状态\t阶段\t原因');
  for (const r of list) {
    lines.push(
      [
        consoleCell(r?.app),
        consoleCell(r?.status),
        consoleCell(r?.stage),
        consoleCell(r?.reason),
      ].join('\t'),
    );
  }
  lines.push(
    `汇总: 共 ${agg.total} 个应用 | success ${agg.success} | skipped ${agg.skipped} | failed ${agg.failed} | 更新 ${agg.updates} 条`,
  );
  lines.push(
    `扫描应用: ${agg.total}  success: ${agg.success}  skipped: ${agg.skipped}  failed: ${agg.failed}  版本更新: ${agg.updates}`,
  );

  const reasons = Object.keys(agg.byReason).sort();
  if (reasons.length > 0) {
    lines.push('--- reason 分布 ---');
    for (const reason of reasons) {
      lines.push(`  ${reason}: ${agg.byReason[reason]}`);
    }
  }

  if (agg.failures.length > 0) {
    lines.push('--- failed 明细 ---');
    for (const f of agg.failures) {
      lines.push(`  ${f.app} [stage=${f.stage}] reason=${f.reason}: ${f.error ?? '(无错误信息)'}`);
    }
  }

  return lines.join('\n');
}

/**
 * 渲染 GitHub Step Summary markdown（唯一 markdown 渲染实现）
 *
 * 内容：计数 + **每应用结果表**（app | status | stage | reason | error）+ reason 分布 +
 * 失败明细。CI 的 step summary 需要每应用视图，因此表格在这里统一生成。
 *
 * 输入可直接取自 updates.json 的 `results` 字段（JSON 往返后的普通对象数组）。
 *
 * @param {Array<object>} results
 * @param {{title?: string, timestamp?: string}} [opts]
 * @returns {string}
 */
export function renderMarkdown(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const agg = aggregateResults(list);
  const lines = [];

  lines.push(`## ${opts.title ?? 'detect-updates 检测汇总'}`);
  lines.push('');
  if (opts.timestamp) {
    lines.push(`- 时间: \`${escapeCell(opts.timestamp)}\``);
  }
  lines.push(`- 扫描应用: **${agg.total}**`);
  lines.push(`- success: **${agg.success}** / skipped: **${agg.skipped}** / failed: **${agg.failed}**`);
  lines.push(`- 版本更新: **${agg.updates}**`);
  lines.push('');

  lines.push('### 每应用结果');
  lines.push('');
  if (list.length === 0) {
    lines.push('_（无结果）_');
  } else {
    lines.push('| app | status | stage | reason | error |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of list) {
      lines.push(
        `| ${escapeCell(r?.app)} | ${escapeCell(r?.status)} | ${escapeCell(r?.stage)} | ${escapeCell(r?.reason)} | ${escapeCell(r?.error ?? '')} |`,
      );
    }
  }
  lines.push('');

  lines.push('### reason 分布');
  lines.push('');
  const reasons = Object.keys(agg.byReason).sort();
  if (reasons.length === 0) {
    lines.push('_（无结果）_');
  } else {
    lines.push('| reason | 数量 |');
    lines.push('| --- | --- |');
    for (const reason of reasons) {
      lines.push(`| ${escapeCell(reason)} | ${agg.byReason[reason]} |`);
    }
  }
  lines.push('');

  lines.push('### 失败明细');
  lines.push('');
  if (agg.failures.length === 0) {
    lines.push('_（无失败）_');
  } else {
    lines.push('| app | stage | reason | error |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of agg.failures) {
      lines.push(
        `| ${escapeCell(f.app)} | ${escapeCell(f.stage)} | ${escapeCell(f.reason)} | ${escapeCell(f.error ?? '')} |`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
