// .github/lib/execution-result.test.mjs
// 锁死「端到端执行结果对象」（目标 §七.1）与五类统计 / Summary 渲染。
//
// 关键不变量：
//   · 状态枚举严格为 UPDATED / NO_UPDATE / SKIPPED / WARNING / FAILED
//   · 检测阶段 failed → 端到端 FAILED；update-found → UPDATED；
//     no-update → NO_UPDATE；skipped → SKIPPED
//   · 部分失败（有 FAILED）→ 退出码非零（禁止全绿）
//   · Summary 渲染必须给出五类清单（不是一条笼统的成功/失败日志）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DETECT_STATUS,
  DETECT_STATUSES,
  detectStatusFromResult,
  EXEC_STATUS,
  EXEC_STATUSES,
  EXEC_STAGE,
  EXEC_STAGES,
  STAGE_OUTCOME,
  aggregateExecutionResults,
  createExecutionResult,
  exitCodeForExecutionResults,
  statusFromDetectResult,
  toExecutionResults,
  withStage,
} from './execution-result.mjs';
import { renderExecutionMarkdown, renderExecutionSummary } from './report.mjs';

describe('EXEC_STATUS / EXEC_STAGE 枚举', () => {
  it('状态枚举严格五类', () => {
    assert.deepEqual([...EXEC_STATUSES], ['UPDATED', 'NO_UPDATE', 'SKIPPED', 'WARNING', 'FAILED']);
  });

  it('阶段枚举覆盖六个阶段', () => {
    assert.deepEqual(
      [...EXEC_STAGES],
      ['detect', 'generate', 'lint', 'pr', 'ci', 'merge'],
    );
  });
});

describe('statusFromDetectResult（检测状态 → 端到端状态）', () => {
  it('failed → FAILED', () => {
    assert.equal(statusFromDetectResult({ status: 'failed', code: 'registry-request-failed' }), EXEC_STATUS.FAILED);
  });
  it('success + update-found → UPDATED', () => {
    assert.equal(statusFromDetectResult({ status: 'success', code: 'update-found' }), EXEC_STATUS.UPDATED);
  });
  it('success + no-update → NO_UPDATE', () => {
    assert.equal(statusFromDetectResult({ status: 'success', code: 'no-update' }), EXEC_STATUS.NO_UPDATE);
  });
  it('skipped → SKIPPED', () => {
    assert.equal(statusFromDetectResult({ status: 'skipped', code: 'tag-latest' }), EXEC_STATUS.SKIPPED);
  });
  it('非法输入 → SKIPPED（不猜）', () => {
    assert.equal(statusFromDetectResult(null), EXEC_STATUS.SKIPPED);
    assert.equal(statusFromDetectResult({}), EXEC_STATUS.SKIPPED);
  });
});

describe('createExecutionResult / withStage', () => {
  it('缺省字段被补齐，六个阶段齐备', () => {
    const r = createExecutionResult({ appKey: 'demo' });
    assert.equal(r.appKey, 'demo');
    assert.equal(r.status, EXEC_STATUS.NO_UPDATE);
    for (const s of EXEC_STAGES) assert.ok(s in r.stages, `缺阶段 ${s}`);
  });

  it('withStage 返回新对象并写入阶段结果', () => {
    const r0 = createExecutionResult({ appKey: 'demo' });
    const r1 = withStage(r0, EXEC_STAGE.PR, { outcome: STAGE_OUTCOME.OK, detail: '#12' });
    assert.equal(r1.stages.pr.outcome, STAGE_OUTCOME.OK);
    assert.equal(r1.stages.pr.detail, '#12');
    // 原对象不变（不可变语义）
    assert.equal(r0.stages.pr, null);
  });

  it('非法阶段名被忽略', () => {
    const r0 = createExecutionResult({ appKey: 'demo' });
    const r1 = withStage(r0, 'not-a-stage', { outcome: STAGE_OUTCOME.OK });
    assert.equal(r1.stages.pr, null);
  });
});

describe('toExecutionResults', () => {
  it('检测结果数组 → 端到端结果数组（记录 currentVersion / latestVersion）', () => {
    const versions = new Map([['demo', { currentVersion: 'v1.0.0', latestVersion: 'v2.0.0' }]]);
    const out = toExecutionResults(
      [{ app: 'demo', status: 'success', code: 'update-found', reason: '检测到新版本 v2.0.0' }],
      versions,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].appKey, 'demo');
    assert.equal(out[0].status, EXEC_STATUS.UPDATED);
    assert.equal(out[0].currentVersion, 'v1.0.0');
    assert.equal(out[0].latestVersion, 'v2.0.0');
    assert.equal(out[0].stages.detect.outcome, STAGE_OUTCOME.OK);
  });

  it('failed 应用记录 errorStage', () => {
    const out = toExecutionResults([{ app: 'x', status: 'failed', stage: 'registry', reason: 'r', error: 'boom' }]);
    assert.equal(out[0].status, EXEC_STATUS.FAILED);
    assert.equal(out[0].errorStage, 'registry');
  });
});

describe('aggregateExecutionResults（五类统计）', () => {
  it('按五类分桶统计', () => {
    const agg = aggregateExecutionResults([
      { appKey: 'a', status: EXEC_STATUS.UPDATED },
      { appKey: 'b', status: EXEC_STATUS.UPDATED },
      { appKey: 'c', status: EXEC_STATUS.NO_UPDATE },
      { appKey: 'd', status: EXEC_STATUS.SKIPPED },
      { appKey: 'e', status: EXEC_STATUS.WARNING },
      { appKey: 'f', status: EXEC_STATUS.FAILED },
    ]);
    assert.equal(agg.total, 6);
    assert.equal(agg.updated, 2);
    assert.equal(agg.noUpdate, 1);
    assert.equal(agg.skipped, 1);
    assert.equal(agg.warning, 1);
    assert.equal(agg.failed, 1);
    assert.deepEqual(agg.updatedApps, ['a', 'b']);
    assert.deepEqual(agg.failedApps, ['f']);
  });

  it('非法状态按 FAILED 计数（不静默放过）', () => {
    const agg = aggregateExecutionResults([{ appKey: 'x', status: 'WEIRD' }]);
    assert.equal(agg.failed, 1);
  });
});

describe('exitCodeForExecutionResults（退出码契约）', () => {
  it('全部正常 → 0', () => {
    assert.equal(
      exitCodeForExecutionResults([
        { status: EXEC_STATUS.UPDATED },
        { status: EXEC_STATUS.NO_UPDATE },
        { status: EXEC_STATUS.SKIPPED },
      ]),
      0,
    );
  });

  it('存在 FAILED → 2（部分失败也必须显式暴露）', () => {
    assert.equal(
      exitCodeForExecutionResults([
        { status: EXEC_STATUS.UPDATED },
        { status: EXEC_STATUS.FAILED },
      ]),
      2,
    );
  });
});

describe('Summary 渲染（§七.2）', () => {
  const execution = {
    timestamp: '2026-11-04T00:00:00.000Z',
    branch: 'auto-update/2026-11-04',
    reusedPr: false,
    pr: { number: 42, url: 'https://github.com/o/r/pull/42', reused: false, title: 'chore(deps): auto-update' },
    ci: { status: 'success', sha: 'abc123', requiredChecks: ['lint'], missing: [], checks: [] },
    merge: { status: 'merged', message: '' },
    steps: [
      { name: 'validate-batch', outcome: 'ok', detail: '' },
      { name: 'pr', outcome: 'ok', detail: '#42' },
      { name: 'ci', outcome: 'ok', detail: '1 项' },
      { name: 'merge', outcome: 'ok', detail: '' },
    ],
  };

  const results = [
    { app: 'a', status: 'success', code: 'update-found', stage: 'scan', reason: '检测到新版本 v2' },
    { app: 'b', status: 'success', code: 'no-update', stage: 'scan', reason: '已是最新' },
    { app: 'c', status: 'skipped', code: 'already-exists', stage: 'version', reason: '幂等跳过' },
    { app: 'd', status: 'failed', code: 'registry-request-failed', stage: 'registry', reason: 'Registry 请求失败', error: 'HTTP 429' },
  ];

  it('markdown 含 PR 编号与链接、CI 状态、合并状态', () => {
    const md = renderExecutionMarkdown(execution, { title: '自动更新执行结果', results });
    assert.match(md, /#42\]\(https:\/\/github\.com\/o\/r\/pull\/42\)/);
    assert.match(md, /CI 检查: `success`/);
    assert.match(md, /自动合并: `merged`/);
    assert.match(md, /批次分支: `auto-update\/2026-11-04`/);
  });

  it('markdown 含五类清单（不是一条笼统日志）', () => {
    const md = renderExecutionMarkdown(execution, { results });
    for (const label of ['成功更新', '无更新', '幂等跳过', '警告', '失败']) {
      assert.ok(md.includes(label), `缺分类: ${label}`);
    }
    assert.match(md, /\| 失败 \| 1 \| d \|/);
  });

  it('markdown 含失败明细（原因可诊断）', () => {
    const md = renderExecutionMarkdown(execution, { results });
    assert.match(md, /### 失败明细/);
    assert.match(md, /HTTP 429/);
  });

  it('markdown 含阶段明细表', () => {
    const md = renderExecutionMarkdown(execution, { results });
    assert.match(md, /### 阶段明细/);
    assert.match(md, /\| validate-batch \| ok \|/);
  });

  it('控制台降级输出含五类统计（非 Actions 环境）', () => {
    const s = renderExecutionSummary(execution, { results });
    assert.match(s, /批次分支: auto-update\/2026-11-04/);
    assert.match(s, /PR: #42/);
    assert.match(s, /CI: success/);
    assert.match(s, /合并: merged/);
    assert.match(s, /成功更新 1 \| 无更新 1 \| 幂等跳过 1 \| 警告 0 \| 失败 1/);
  });

  it('缺 execution.json 时也不抛错（优雅降级）', () => {
    assert.doesNotThrow(() => renderExecutionMarkdown(undefined, {}));
    assert.doesNotThrow(() => renderExecutionSummary(null, {}));
  });
});

// ─── 检测阶段四态枚举（目标 §三.1）────────────────────────────────────────

describe('DETECT_STATUS / detectStatusFromResult（四态检测结论）', () => {
  it('四态枚举严格互斥', () => {
    assert.deepEqual(
      [...DETECT_STATUSES],
      ['HAS_UPDATE', 'NO_UPDATE', 'SKIPPED', 'FAILED'],
    );
  });

  it('success + update-found → HAS_UPDATE', () => {
    assert.equal(
      detectStatusFromResult({ status: 'success', code: 'update-found' }),
      DETECT_STATUS.HAS_UPDATE,
    );
  });

  it('success + no-update → NO_UPDATE', () => {
    assert.equal(
      detectStatusFromResult({ status: 'success', code: 'no-update' }),
      DETECT_STATUS.NO_UPDATE,
    );
  });

  it('skipped → SKIPPED（白名单 / 无版本目录 / no-stable-tag / already-exists）', () => {
    for (const code of ['whitelisted', 'no-version-dirs', 'no-stable-tag', 'already-exists']) {
      assert.equal(
        detectStatusFromResult({ status: 'skipped', code }),
        DETECT_STATUS.SKIPPED,
        `${code} 应判为 SKIPPED`,
      );
    }
  });

  it('failed → FAILED（网络异常 / 限流 / 解析失败绝不落到 NO_UPDATE）', () => {
    for (const code of ['registry-request-failed', 'unexpected-error', 'compose-invalid', 'write-failed']) {
      assert.equal(
        detectStatusFromResult({ status: 'failed', code }),
        DETECT_STATUS.FAILED,
        `${code} 应判为 FAILED`,
      );
    }
  });

  it('未知状态 → SKIPPED（不猜）', () => {
    assert.equal(detectStatusFromResult({ status: 'weird' }), DETECT_STATUS.SKIPPED);
    assert.equal(detectStatusFromResult(null), DETECT_STATUS.SKIPPED);
  });
});

describe('toExecutionResults：currentVersion / latestVersion 透传', () => {
  it('优先取检测结果自带字段', () => {
    const out = toExecutionResults([
      {
        app: 'demo',
        status: 'success',
        code: 'update-found',
        detectStatus: DETECT_STATUS.HAS_UPDATE,
        currentVersion: 'v1.0.0',
        latestVersion: 'v2.0.0',
      },
    ]);
    assert.equal(out[0].currentVersion, 'v1.0.0');
    assert.equal(out[0].latestVersion, 'v2.0.0');
    assert.equal(out[0].status, EXEC_STATUS.UPDATED);
  });

  it('缺字段时为 null（不臆造版本号）', () => {
    const out = toExecutionResults([{ app: 'demo', status: 'success', code: 'no-update' }]);
    assert.equal(out[0].currentVersion, null);
    assert.equal(out[0].latestVersion, null);
  });
});

describe('Summary：每应用执行轨迹表（目标 §七.1 字段可见）', () => {
  it('markdown 含 app / 检测状态 / 当前本地版本 / 上游版本 / 最终状态', () => {
    const md = renderExecutionMarkdown(
      {},
      {
        results: [
          {
            app: 'anirss',
            status: 'success',
            code: 'update-found',
            detectStatus: 'HAS_UPDATE',
            reason: '检测到新版本 v3.2.99',
            currentVersion: 'v3.2.55',
            latestVersion: 'v3.2.99',
          },
          {
            app: 'traefik',
            status: 'failed',
            code: 'registry-request-failed',
            detectStatus: 'FAILED',
            stage: 'registry',
            reason: 'Registry 请求失败',
            error: 'HTTP 429',
          },
        ],
      },
    );
    assert.match(md, /### 每应用执行轨迹/);
    assert.match(md, /\| anirss \| HAS_UPDATE \| v3\.2\.55 \| v3\.2\.99 \| UPDATED \|/);
    assert.match(md, /\| traefik \| FAILED \|/);
    assert.match(md, /HTTP 429/);
  });
});
