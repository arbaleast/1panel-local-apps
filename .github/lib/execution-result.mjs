// lib/execution-result.mjs — **端到端**执行结果对象（Execution Result Schema）
//
// ── 为什么有这个模块 ─────────────────────────────────────────────────────
// 审计 P1-11 / P1-12：旧实现的 updates.json 只记录**检测阶段**的结果
// （{app,status,stage,reason,code,error,updates}），目标 §七.1 要求的
// 「各阶段结果：版本检测 → 目录生成 → SSOT 配置校验 → PR 创建/复用 → CI 检查 → 自动合并」
// 与「五类清单：成功更新 / 无更新 / 幂等跳过 / 警告 / 失败」**完全没有承载对象**。
//
// 本模块定义那个对象：
//   {
//     appKey, currentVersion, latestVersion,
//     status: UPDATED | NO_UPDATE | SKIPPED | WARNING | FAILED,
//     stages: { detect, generate, lint, pr, ci, merge },
//     pr: { number, url, reused },
//     reason, errorStage
//   }
//
// 分层：纯数据 + 纯函数，零 IO、零第三方依赖（CONTRIBUTING §4）。
// 渲染实现在 lib/report.mjs（本模块是唯一 schema / 聚合来源）。

/** 端到端最终状态枚举（目标 §七.1） */
export const EXEC_STATUS = Object.freeze({
  UPDATED: 'UPDATED',
  NO_UPDATE: 'NO_UPDATE',
  SKIPPED: 'SKIPPED',
  WARNING: 'WARNING',
  FAILED: 'FAILED',
});

/**
 * **检测阶段**的状态枚举（目标 §三.1）
 *
 * 与端到端状态分开：检测阶段只回答「这次检测对某个应用得出了什么结论」，
 * 而端到端状态还要叠加目录生成 / 校验 / PR / CI / 合并各阶段的结果。
 *
 * `HAS_UPDATE` / `NO_UPDATE` / `SKIPPED` / `FAILED` 四态严格互斥：
 * 网络异常、限流、解析失败**永远**是 `FAILED`，绝不落到 `NO_UPDATE`。
 */
export const DETECT_STATUS = Object.freeze({
  HAS_UPDATE: 'HAS_UPDATE',
  NO_UPDATE: 'NO_UPDATE',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
});

/** 检测阶段状态全集（有序） */
export const DETECT_STATUSES = Object.freeze([
  DETECT_STATUS.HAS_UPDATE,
  DETECT_STATUS.NO_UPDATE,
  DETECT_STATUS.SKIPPED,
  DETECT_STATUS.FAILED,
]);

/**
 * 由检测结果推导**检测阶段状态**（目标 §三.1 的四态枚举）
 *
 * @param {{status?: string, code?: string}} detectResult
 * @returns {string} DETECT_STATUS 之一
 */
export function detectStatusFromResult(detectResult) {
  if (!detectResult || typeof detectResult !== 'object') return DETECT_STATUS.SKIPPED;
  const status = detectResult.status;
  if (status === 'failed') return DETECT_STATUS.FAILED;
  if (status === 'skipped') return DETECT_STATUS.SKIPPED;
  if (status === 'success') {
    // 只认机器码字段 `code`（`reason` 是人读文本，回退会误判）
    const code = detectResult.code;
    return code === 'update-found' ? DETECT_STATUS.HAS_UPDATE : DETECT_STATUS.NO_UPDATE;
  }
  return DETECT_STATUS.SKIPPED;
}


/** 端到端状态全集（有序，便于稳定渲染） */
export const EXEC_STATUSES = Object.freeze([
  EXEC_STATUS.UPDATED,
  EXEC_STATUS.NO_UPDATE,
  EXEC_STATUS.SKIPPED,
  EXEC_STATUS.WARNING,
  EXEC_STATUS.FAILED,
]);

/** 阶段枚举（目标 §七.1 的六个阶段） */
export const EXEC_STAGE = Object.freeze({
  DETECT: 'detect',
  GENERATE: 'generate',
  LINT: 'lint',
  PR: 'pr',
  CI: 'ci',
  MERGE: 'merge',
});

/** 阶段全集（有序） */
export const EXEC_STAGES = Object.freeze([
  EXEC_STAGE.DETECT,
  EXEC_STAGE.GENERATE,
  EXEC_STAGE.LINT,
  EXEC_STAGE.PR,
  EXEC_STAGE.CI,
  EXEC_STAGE.MERGE,
]);

/** 阶段结果：'ok' | 'skipped' | 'failed' | 'pending' | 'n/a' */
export const STAGE_OUTCOME = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PENDING: 'pending',
  NA: 'n/a',
});

/**
 * 创建一个执行结果对象（补齐缺省字段，保证 schema 稳定）
 *
 * 字段说明（目标 §七 Decision Result 的落点）：
 *   · candidateVersion  最佳候选版本（无则 null）
 *   · versionScheme     semver | calver | variant-semver | pinned-digest | rolling-tag | unknown
 *   · comparisonResult  upgradable | up-to-date | incompatible | uncomparable | error
 *   · shouldUpdate      仅当 comparisonResult === 'upgradable' 才为 true
 *   · decisions         该应用下**每个 service** 的完整 Decision Result 列表
 *
 * @param {{appKey?: string, currentVersion?: string|null, latestVersion?: string|null,
 *          candidateVersion?: string|null, versionScheme?: string|null,
 *          comparisonResult?: string|null, shouldUpdate?: boolean, decisions?: object[],
 *          status?: string, stages?: object, pr?: object|null,
 *          reason?: string|null, errorStage?: string|null}} [input]
 * @returns {object}
 */
export function createExecutionResult(input = {}) {
  const stages = {};
  for (const s of EXEC_STAGES) {
    const v = input.stages && input.stages[s];
    stages[s] = v ? { outcome: v.outcome || STAGE_OUTCOME.NA, detail: v.detail || '' } : null;
  }
  return {
    appKey: input.appKey || '',
    currentVersion: input.currentVersion ?? null,
    latestVersion: input.latestVersion ?? null,
    candidateVersion: input.candidateVersion ?? input.latestVersion ?? null,
    versionScheme: input.versionScheme ?? null,
    comparisonResult: input.comparisonResult ?? null,
    shouldUpdate: Boolean(input.shouldUpdate ?? false),
    decisions: Array.isArray(input.decisions) ? input.decisions : [],
    status: input.status || EXEC_STATUS.NO_UPDATE,
    stages,
    pr: input.pr
      ? {
          number: input.pr.number ?? null,
          url: input.pr.url || '',
          reused: Boolean(input.pr.reused),
        }
      : null,
    reason: input.reason ?? null,
    errorStage: input.errorStage ?? null,
  };
}

/**
 * 把某个阶段的结果写回执行结果对象（不可变：返回新对象）
 *
 * @param {object} result
 * @param {string} stage EXEC_STAGE 之一
 * @param {{outcome: string, detail?: string}} stageResult
 * @returns {object}
 */
export function withStage(result, stage, stageResult) {
  const next = createExecutionResult(result);
  if (!EXEC_STAGES.includes(stage)) return next;
  next.stages[stage] = {
    outcome: stageResult.outcome || STAGE_OUTCOME.NA,
    detail: stageResult.detail || '',
  };
  return next;
}

/**
 * 把检测阶段的结果映射为端到端状态
 *
 * 映射规则（detect-updates.mjs 的 status/code → EXEC_STATUS）：
 *   failed                       → FAILED
 *   success + update-found       → UPDATED
 *   success + no-update          → NO_UPDATE
 *   skipped                      → SKIPPED
 *
 * @param {{status?: string, code?: string}} detectResult
 * @returns {string} EXEC_STATUS 之一
 */
export function statusFromDetectResult(detectResult) {
  if (!detectResult || typeof detectResult !== 'object') return EXEC_STATUS.SKIPPED;
  const status = detectResult.status;
  if (status === 'failed') return EXEC_STATUS.FAILED;
  if (status === 'skipped') return EXEC_STATUS.SKIPPED;
  if (status === 'success') {
    // 只认机器码字段 `code`（`reason` 是人读文本，回退会误判）
    const code = detectResult.code;
    return code === 'update-found' ? EXEC_STATUS.UPDATED : EXEC_STATUS.NO_UPDATE;
  }
  // 未知状态 → **不猜**：既不是"无更新"也不是"有更新"，按跳过处理
  return EXEC_STATUS.SKIPPED;
}

/**
 * 由检测阶段结果构造执行结果数组（检测阶段之后的阶段先留空）
 *
 * `currentVersion` / `latestVersion` 优先取检测结果自带的字段
 * （detect-updates.mjs 记录的应用当前版本目录名与上游新 tag），
 * 其次取 `versions` 映射兜底。
 *
 * @param {Array<object>} detectResults
 * @param {Map<string, {currentVersion?: string, latestVersion?: string}>} [versions]
 * @returns {Array<object>}
 */
export function toExecutionResults(detectResults, versions = new Map()) {
  const list = Array.isArray(detectResults) ? detectResults : [];
  return list.map(r => {
    const key = r?.app ?? '';
    const v = versions.get(key) || {};
    // 每个 service 的 Decision Result（detect 产出）
    const decisions = Array.isArray(r?.decisions) ? r.decisions : [];
    // 应用级结论 = 第一个「可升级」的 service 决策（没有则取第一个决策的结论）
    const updatable = decisions.find(d => d?.shouldUpdate) || null;
    return createExecutionResult({
      appKey: key,
      currentVersion: r?.currentVersion ?? v.currentVersion ?? null,
      latestVersion: r?.latestVersion ?? v.latestVersion ?? null,
      candidateVersion: updatable?.candidateVersion ?? r?.latestVersion ?? v.latestVersion ?? null,
      versionScheme: updatable?.versionScheme ?? decisions[0]?.versionScheme ?? null,
      comparisonResult: updatable?.comparisonResult ?? decisions[0]?.comparisonResult ?? null,
      shouldUpdate: Boolean(updatable),
      decisions,
      status: statusFromDetectResult(r),
      reason: r?.reason ?? null,
      errorStage: r?.status === 'failed' ? (r?.stage || 'detect') : null,
      stages: {
        [EXEC_STAGE.DETECT]: {
          outcome:
            r?.status === 'failed'
              ? STAGE_OUTCOME.FAILED
              : r?.status === 'skipped'
                ? STAGE_OUTCOME.SKIPPED
                : STAGE_OUTCOME.OK,
          detail: r?.reason || '',
        },
      },
    });
  });
}

/**
 * 聚合端到端结果 → 五类统计
 *
 * @param {Array<object>} results
 * @returns {{total: number, updated: number, noUpdate: number, skipped: number,
 *            warning: number, failed: number, byStatus: Record<string, number>,
 *            updatedApps: string[], noUpdateApps: string[], skippedApps: string[],
 *            warningApps: string[], failedApps: string[]}}
 */
export function aggregateExecutionResults(results) {
  const list = Array.isArray(results) ? results : [];
  const byStatus = {};
  for (const s of EXEC_STATUSES) byStatus[s] = 0;
  const buckets = {
    [EXEC_STATUS.UPDATED]: [],
    [EXEC_STATUS.NO_UPDATE]: [],
    [EXEC_STATUS.SKIPPED]: [],
    [EXEC_STATUS.WARNING]: [],
    [EXEC_STATUS.FAILED]: [],
  };
  for (const r of list) {
    const s = EXEC_STATUSES.includes(r?.status) ? r.status : EXEC_STATUS.FAILED;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    buckets[s].push(r?.appKey || '');
  }
  return {
    total: list.length,
    updated: byStatus[EXEC_STATUS.UPDATED],
    noUpdate: byStatus[EXEC_STATUS.NO_UPDATE],
    skipped: byStatus[EXEC_STATUS.SKIPPED],
    warning: byStatus[EXEC_STATUS.WARNING],
    failed: byStatus[EXEC_STATUS.FAILED],
    byStatus,
    updatedApps: buckets[EXEC_STATUS.UPDATED],
    noUpdateApps: buckets[EXEC_STATUS.NO_UPDATE],
    skippedApps: buckets[EXEC_STATUS.SKIPPED],
    warningApps: buckets[EXEC_STATUS.WARNING],
    failedApps: buckets[EXEC_STATUS.FAILED],
  };
}

/**
 * 由端到端结果决定进程退出码
 *
 * 契约（目标 §三.3）：
 *   - 有 FAILED → 非零（2）：部分失败也必须显式暴露，禁止全绿
 *   - 否则 → 0
 *
 * @param {Array<object>} results
 * @returns {number} 0 | 2
 */
export function exitCodeForExecutionResults(results) {
  const list = Array.isArray(results) ? results : [];
  return list.some(r => r?.status === EXEC_STATUS.FAILED) ? 2 : 0;
}
