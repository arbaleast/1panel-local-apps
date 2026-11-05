// lib/report.mjs — detect-updates 汇总报告纯函数（**唯一**的聚合与渲染实现）
//
// 职责：把每个应用的检测结果（{app, status, stage, reason, error?, updates}）
// 聚合成统计 + 渲染控制台文本 / GitHub Step Summary markdown；
// 并渲染端到端执行轨迹（PR / CI / 合并阶段）。
//
// 设计约束（audit task 2 follow-up）：
//   - 本模块是 **唯一** 的计数与渲染来源。入口脚本（.github/scripts/detect-updates.mjs）
//     与 CI 工作流（node -e 直接 import 本模块渲染 step summary）都从这里取实现，
//     入口脚本里不再 inline 重复实现（AGENTS.md："入口脚本应优先复用 lib/ 模块，
//     不在入口内 inline 重复实现"）。
//   - 纯函数，无 IO；输入是**普通对象数组**（updates.json 的 JSON 往返结果可直接传入），
//     不含类实例 / 函数，因此 CI 可以 `require('./updates.json').results` 直接渲染。
//   - 每个应用恰好一条记录；status ∈ 'success' | 'skipped' | 'failed'。
//
// ── 端到端执行结果（2026-11 治理，目标 §七）────────────────────────────────
//   renderExecutionMarkdown / renderExecutionSummary 渲染**端到端**执行轨迹：
//   批次分支 / PR（编号 + 链接 + 是否复用）/ CI 检查状态 / 自动合并状态 / 阶段明细，
//   并给出「成功更新 / 无更新 / 幂等跳过 / 警告 / 失败」五类统计。
//   Schema 与聚合在 lib/execution-result.mjs（唯一事实来源）。

// 端到端执行结果的 schema / 聚合（唯一事实来源）
import {
  aggregateExecutionResults,
  toExecutionResults,
  EXEC_STATUS,
  EXEC_STATUSES,
  EXEC_STAGE,
  EXEC_STAGES,
  DETECT_STATUS,
  DETECT_STATUSES,
  createExecutionResult,
  withStage,
  statusFromDetectResult,
  detectStatusFromResult,
  exitCodeForExecutionResults,
} from './execution-result.mjs';

// re-export：调用方只依赖 report.mjs 一个入口
export {
  aggregateExecutionResults,
  toExecutionResults,
  EXEC_STATUS,
  EXEC_STATUSES,
  EXEC_STAGE,
  EXEC_STAGES,
  DETECT_STATUS,
  DETECT_STATUSES,
  createExecutionResult,
  withStage,
  statusFromDetectResult,
  detectStatusFromResult,
  exitCodeForExecutionResults,
};

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
 */// ─── 输出收敛（2026-11-05）──────────────────────────────────────────────
//
// 实况：60 个应用的批次，step summary 里 60 个应用被**列了两遍**
// （detect 汇总表 + 执行轨迹表，共 178 行 / 8.4 KiB，内容近乎重复），
// stdout 还另有一张 60 行表；workflow log 里另有 detect 脚本逐应用 /
// 逐 service 的数百行日志。整体观感：**太杂太乱**。
//
// 结论：**信息不删，形态收敛**——
//   · 每应用结果只渲染**一张**表，且只列「需要关注」的应用（有更新 / 幂等跳过 / 失败）
//   · 「无更新」的几十个应用折叠进 <details>，只给计数
//   · stdout 只给分类计数 + 更新/失败明细（不再逐行刷全表）
//   · detect 脚本的常规路径日志降级为 debug（DETECT_LOG=debug 打开），
//     异常与变更仍是 info —— 需要全量明细时随时能打开

/**
 * 把检测结果拆成「需要关注」与「无更新」两桶（保持与输入的索引对应）
 * @param {Array<object>} results
 * @returns {{rows: Array<object>, attention: Array<object>, noUpdate: Array<object>}}
 */
function buildRows(results) {
  const list = Array.isArray(results) ? results : [];
  const exec = toExecutionResults(list);
  const rows = exec.map((e, i) => ({ e, raw: list[i] || {} }));
  return {
    rows,
    attention: rows.filter(r => r.e.status !== EXEC_STATUS.NO_UPDATE),
    noUpdate: rows.filter(r => r.e.status === EXEC_STATUS.NO_UPDATE),
  };
}

/**
 * 追加「每应用结果」段：需要关注的列表 + 折叠的无更新列表
 * @param {string[]} lines
 * @param {Array<object>} results
 */
function pushAppTable(lines, results) {
  const { attention, noUpdate } = buildRows(results);
  if (attention.length === 0) {
    lines.push('### 每应用结果');
    lines.push('');
    lines.push('_（无需要关注的应用）_');
    lines.push('');
  } else {
    lines.push(`### 需要关注（${attention.length}）`);
    lines.push('');
    lines.push('| app | 检测状态 | 当前版本 | 上游版本 | 状态 | 原因 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const { e, raw } of attention) {
      const reason = [raw.reason || e.reason || '', raw.error ? `（${raw.error}）` : '']
        .join('')
        .trim();
      lines.push(
        `| ${escapeCell(e.appKey)} | ${escapeCell(raw.detectStatus || '')} | ` +
          `${escapeCell(e.currentVersion ?? '')} | ${escapeCell(e.latestVersion ?? '')} | ` +
          `${escapeCell(e.status)} | ${escapeCell(reason)} |`,
      );
    }
    lines.push('');
  }

  if (noUpdate.length > 0) {
    lines.push(`<details><summary>无更新（${noUpdate.length}）—— 点击展开应用列表</summary>`);
    lines.push('');
    lines.push(noUpdate.map(r => escapeCell(r.e.appKey)).join('、'));
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

/**
 * 渲染检测结果的控制台文本（**紧凑**版）
 *
 * 旧实现输出 60 行逐应用表格；现在只给分类计数 + 需要关注的明细。
 *
 * @param {Array<object>} results
 * @returns {string}
 */
export function renderSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const agg = aggregateResults(list);
  // 五类计数用**端到端**聚合（updated / noUpdate / skipped / warning / failed）
  const execAgg = aggregateExecutionResults(toExecutionResults(list));
  const { attention } = buildRows(list);

  const lines = [];
  lines.push('=== 检测汇总 ===');
  lines.push(
    `扫描 ${agg.total} | 更新 ${execAgg.updated} | 无更新 ${execAgg.noUpdate} | ` +
      `跳过 ${execAgg.skipped} | 警告 ${execAgg.warning} | 失败 ${execAgg.failed}`,
  );

  // 只列需要关注的应用（更新 / 幂等跳过 / 失败 / 警告）
  const interesting = attention.filter(
    r => r.e.status !== EXEC_STATUS.NO_UPDATE && r.e.status !== EXEC_STATUS.SKIPPED,
  );
  for (const { e, raw } of interesting) {
    const detail = raw.error ? ` — ${raw.error}` : '';
    const stage = raw.stage ? `[${raw.stage}] ` : '';
    lines.push(
      `[${e.status}] ${e.appKey} ${stage}` +
        (e.currentVersion || e.latestVersion
          ? ` (${e.currentVersion || '?'} → ${e.latestVersion || '?'})`
          : '') +
        `: ${raw.reason || ''}${detail}`,
    );
  }

  // 说明：失败应用的 error 已并入上面的逐应用行，不再重复输出「失败明细」块

  // reason 分布（机器可读口径的补充）
  const reasons = Object.keys(agg.byReason).sort();
  if (reasons.length > 0) {
    lines.push(
      '--- reason 分布 --- ' +
        reasons.map(r => `${r}: ${agg.byReason[r]}`).join(' · '),
    );
  }

  return lines.join('\n');
}

/**
 * 渲染检测结果的 markdown（GitHub Step Summary 口径，**紧凑**版）
 *
 * @param {Array<object>} results
 * @param {{title?: string, timestamp?: string}} [opts]
 * @returns {string}
 */
export function renderMarkdown(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const agg = aggregateResults(list);
  const execAgg = aggregateExecutionResults(toExecutionResults(list));
  const lines = [];

  lines.push(`## ${opts.title ?? 'detect-updates 检测汇总'}`);
  lines.push('');
  if (opts.timestamp) lines.push(`- 时间: \`${escapeCell(opts.timestamp)}\``);
  lines.push(`- 扫描应用: **${agg.total}**`);
  lines.push(
    `- 更新 **${execAgg.updated}** / 无更新 ${execAgg.noUpdate} / 跳过 ${execAgg.skipped} / ` +
      `警告 ${execAgg.warning} / 失败 **${execAgg.failed}**`,
  );
  lines.push('');

  pushAppTable(lines, list);

  return lines.join('\n');
}

/**
 * 渲染端到端执行结果的 **markdown**（GitHub Step Summary）
 *
 * 内容：批次概览（分支 / PR / CI / 合并）+ 每应用结果（**一张**表）+
 * 阶段明细。检测阶段与执行阶段**不再各渲染一张重复的表**。
 *
 * @param {object} execution - execution.json 的内容
 * @param {{title?: string, results?: Array<object>, appTable?: boolean}} [opts]
 *   `results` = updates.json 的 results 数组（用于每应用结果与五类统计）
 *   `appTable` = 是否渲染每应用结果表。**默认 true**；
 *     workflow 里由 detect 脚本自己写「每应用结果」段（它才有该数据），
 *     避免同一张表被渲染两遍（2026-11-05 输出收敛）。
 * @returns {string}
 */
export function renderExecutionMarkdown(execution, opts = {}) {
  const ex = execution && typeof execution === 'object' ? execution : {};
  const lines = [];

  lines.push(`## ${opts.title ?? '自动更新执行结果'}`);
  lines.push('');
  if (ex.timestamp) lines.push(`- 时间: \`${escapeCell(ex.timestamp)}\``);
  if (ex.branch) lines.push(`- 批次分支: \`${escapeCell(ex.branch)}\``);

  // PR
  const pr = ex.pr || null;
  if (pr && pr.number) {
    const link = pr.url ? `[#${pr.number}](${pr.url})` : `#${pr.number}`;
    lines.push(`- PR: ${link}${pr.reused ? '（复用既有自动更新 PR）' : ''}`);
  } else {
    lines.push('- PR: 未创建');
  }

  // CI
  const ci = ex.ci || null;
  if (ci) {
    const missing = (ci.missing || []).length > 0 ? `（缺失必需检查: ${ci.missing.join(', ')}）` : '';
    lines.push(`- CI 检查: \`${escapeCell(ci.status)}\`${missing}`);
    if (ci.sha) lines.push(`- 检查对应 head SHA: \`${escapeCell(ci.sha)}\``);
    if (ci.error) lines.push(`- CI 原因: ${escapeCell(ci.error)}`);
  } else {
    lines.push('- CI 检查: 未执行');
  }

  // 合并
  const merge = ex.merge || null;
  if (merge) {
    lines.push(
      `- 自动合并: \`${escapeCell(merge.status)}\`${merge.message ? ` — ${escapeCell(merge.message)}` : ''}`,
    );
  } else {
    lines.push('- 自动合并: 未执行');
  }
  lines.push('');

  // 五类统计（紧凑一行 + 分类计数）
  const results = Array.isArray(opts.results) ? opts.results : [];
  const wantAppTable = opts.appTable !== false;
  if (wantAppTable && results.length > 0) {
    const agg = aggregateExecutionResults(toExecutionResults(results));
    lines.push(
      `**分类**：成功更新 ${agg.updated} ｜ 无更新 ${agg.noUpdate} ｜ 幂等跳过 ${agg.skipped} ｜ 警告 ${agg.warning} ｜ 失败 ${agg.failed}`,
    );
    lines.push('');
    pushAppTable(lines, results);
  }

  // 阶段明细
  const steps = Array.isArray(ex.steps) ? ex.steps : [];
  if (steps.length > 0) {
    lines.push('### 阶段明细');
    lines.push('');
    lines.push('| 阶段 | 结果 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const s of steps) {
      lines.push(`| ${escapeCell(s?.name)} | ${escapeCell(s?.outcome)} | ${escapeCell(s?.detail ?? '')} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 渲染端到端执行结果的 **控制台文本**（本地 / 非 Actions 环境降级输出）
 *
 * @param {object} execution
 * @param {{results?: Array<object>}} [opts]
 * @returns {string}
 */
export function renderExecutionSummary(execution, opts = {}) {
  const ex = execution && typeof execution === 'object' ? execution : {};
  const lines = [];
  lines.push('=== 自动更新执行结果 ===');
  if (ex.branch) lines.push(`批次分支: ${ex.branch}`);
  const pr = ex.pr || null;
  lines.push(
    pr && pr.number
      ? `PR: #${pr.number}${pr.reused ? '（复用）' : ''} ${pr.url || ''}`
      : 'PR: 未创建',
  );
  const ci = ex.ci || null;
  lines.push(`CI: ${ci ? ci.status : '未执行'}`);
  const merge = ex.merge || null;
  lines.push(`合并: ${merge ? merge.status : '未执行'}`);

  const results = Array.isArray(opts.results) ? opts.results : [];
  if (results.length > 0) {
    const agg = aggregateExecutionResults(toExecutionResults(results));
    lines.push(
      `分类: 成功更新 ${agg.updated} | 无更新 ${agg.noUpdate} | 幂等跳过 ${agg.skipped} | 警告 ${agg.warning} | 失败 ${agg.failed}`,
    );
  }

  const steps = Array.isArray(ex.steps) ? ex.steps : [];
  for (const s of steps) {
    lines.push(`  - ${s?.name}: ${s?.outcome}${s?.detail ? ` — ${s.detail}` : ''}`);
  }
  return lines.join('\n');
}
