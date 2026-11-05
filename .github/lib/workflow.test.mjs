// .github/lib/workflow.test.mjs
// 工作流安全不变量回归测试（对应 audit 任务 1：GitHub Actions 权限与事件隔离）。
//
// 为什么用测试锁死：
//   `.github/workflows/auto-update.yml` 是纯 YAML 配置，改错一个 `if:` / `permissions:`
//   就会重新引入「PR 事件执行写操作 / 外部 PR 代码拿到 PAT」的提权漏洞，
//   而这类问题在 CI 里极难被功能测试发现（最坏情况是绿灯合并）。
//   这里把关键不变量写成断言，任何 PR 改坏工作流都会在 `npm test` 阶段失败。
//
// 断言方式尽量与 job 名称解耦：按「步骤里跑什么命令」识别 job，改名不影响测试。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'auto-update.yml');

/** 读取并解析工作流（缓存，避免每个 case 重复 IO） */
const workflow = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const jobs = workflow.jobs || {};

/** 所有「具有写权限的 scope」名称 */
const WRITE_SCOPES = [
  'contents', 'pull-requests', 'packages', 'actions', 'checks', 'statuses',
  'security-events', 'id-token', 'deployments', 'issues', 'discussions',
  'pages', 'repository-projects', 'attestations', 'models',
];

/** 返回 job 的权限对象（undefined 表示继承顶层） */
function jobPermissions(job) {
  return job?.permissions || {};
}

/** job 是否授予了任意写权限 */
function hasWritePermission(job) {
  const perms = jobPermissions(job);
  return WRITE_SCOPES.some((scope) => perms[scope] === 'write');
}

/** job 的所有 step 中 run 命令拼接（用于按命令识别 job 角色） */
function jobRunText(job) {
  return (job?.steps || []).map((s) => s?.run || '').join('\n');
}

/** job 是否执行指定文件/命令 */
function jobRuns(job, fragment) {
  return jobRunText(job).includes(fragment);
}

/** job 的 YAML 序列化文本（用于检查是否引用了 secrets） */
function jobText(job) {
  return JSON.stringify(job);
}

/** 找出执行「只读校验」的 job：跑 npm test 的 job */
const validationJobs = Object.entries(jobs).filter(([, job]) => jobRuns(job, 'npm test'));
/** 找出执行「自动更新写操作」的 job：调用 detect-updates.mjs 的 job */
const autoUpdateJobs = Object.entries(jobs).filter(([, job]) =>
  jobRuns(job, '.github/scripts/detect-updates.mjs')
);

/** PR 相关事件（会执行 PR 作者代码的事件） */
const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target'];

/**
 * 判断一个 job 的 `if:` 是否**已排除**所有 PR 事件
 *
 * 兼容两种写法：
 *   1. 显式否定：`github.event_name != 'pull_request'`
 *   2. 事件白名单：只出现 `github.event_name == '<event>'`，且没有 PR 事件
 *
 * @param {object} job
 * @returns {boolean} true = PR 事件下不会运行
 */
function writeJobBlockedOnPullRequest(job) {
  const cond = String(job.if || '').trim();
  if (!cond) return false;
  if (/github\.event_name\s*!=\s*['"]pull_request(_target)?['"]/.test(cond)) return true;
  const allowed = [...cond.matchAll(/github\.event_name\s*==\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  if (allowed.length === 0) return false;
  return allowed.every((e) => !PULL_REQUEST_EVENTS.includes(e));
}

describe('auto-update workflow：事件隔离', () => {
  it('触发器包含 schedule / workflow_dispatch / push(main) / pull_request', () => {
    // YAML 会把 `on` 解析成布尔 true（YAML 1.1），两种键都兼容
    const triggers = workflow.on ?? workflow[true] ?? workflow[String('on')];
    assert.ok(triggers && typeof triggers === 'object', 'workflow 必须声明 on: 触发器');
    assert.ok(triggers.schedule, '必须保留 schedule 定时检测');
    assert.ok(triggers.workflow_dispatch, '必须保留 workflow_dispatch 手动检测');
    assert.ok(triggers.push, '必须保留符合条件 push 触发');
    assert.ok(triggers.pull_request, '必须保留 pull_request 只读校验触发');
    assert.ok(!triggers.pull_request_target, '禁止使用 pull_request_target（会向 PR 代码暴露写权限）');

    const branches = triggers.push.branches || [];
    assert.ok(branches.includes('main'), 'push 触发必须限定到 main 分支');
  });

  it('顶层 permissions 不授予任何写权限（最小权限默认值）', () => {
    const top = workflow.permissions;
    if (top === undefined) return; // 未声明时 GitHub 默认是只读/宽松取决于仓库设置；本仓要求显式声明
    for (const [scope, level] of Object.entries(top)) {
      assert.notEqual(level, 'write', `顶层 permissions.${scope} 不得为 write（写权限只允许 job 级按需授予）`);
    }
  });

  it('存在只读校验 job（npm test + lint），且该 job 不引 secrets、无写权限', () => {
    assert.ok(validationJobs.length > 0, '必须存在执行 npm test 的只读校验 job');
    for (const [id, job] of validationJobs) {
      const perms = jobPermissions(job);
      assert.equal(perms.contents ?? 'read', 'read', `${id} job 的 contents 必须是 read`);
      assert.ok(!hasWritePermission(job), `${id} job 不得授予任何写权限`);
      assert.ok(
        !/secrets\./.test(jobText(job)),
        `${id} job 会在 PR 代码上执行 npm test，绝不能引用 secrets（否则 PR 代码可读取 PAT）`
      );
    }
  });

  it('只读校验 job 必须执行 npm run docs:check（文档质量由 CI 守护）', () => {
    // 回归：docs/git-workflow.md 曾承诺 validate job 会跑 docs:check，但工作流里没有，
    // 导致文档质量实际只靠 npm test 间接覆盖、且文档与实现脱节。
    for (const [id, job] of validationJobs) {
      assert.ok(
        /npm\s+run\s+docs:check/.test(jobRunText(job)),
        `${id} job 必须执行 npm run docs:check`,
      );
    }
  });

  it('每个授予写权限的 job 都必须显式排除 pull_request 事件', () => {
    const writeJobs = Object.entries(jobs).filter(([, job]) => hasWritePermission(job));
    assert.ok(writeJobs.length > 0, '自动更新 job 必须存在（否则无法推送分支 / 开 PR）');
    for (const [id, job] of writeJobs) {
      assert.ok(
        writeJobBlockedOnPullRequest(job),
        `${id} job 授予了写权限，必须用事件白名单或 if: github.event_name != 'pull_request' 排除 PR 事件`
      );
    }
  });

  it('写 job 的 workflow_dispatch / push 事件必须限定 main 分支', () => {
    // 防止有人用 workflow_dispatch 选择任意分支（分支代码 = 不可信代码）后以 PAT 写权限运行
    const writeJobs = Object.entries(jobs).filter(([, job]) => hasWritePermission(job));
    for (const [id, job] of writeJobs) {
      const cond = String(job.if || '');
      assert.ok(
        /refs\/heads\/main/.test(cond),
        `${id} job 的 if: 必须把 workflow_dispatch / push 限定到 refs/heads/main`
      );
    }
  });

  it('自动更新 job：依赖校验 job，权限仅 contents: write + pull-requests: write', () => {
    assert.equal(autoUpdateJobs.length, 1, '必须恰好有一个执行 detect-updates.mjs 的自动更新 job');
    const [id, job] = autoUpdateJobs[0];
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs].filter(Boolean);
    const validationIds = validationJobs.map(([jid]) => jid);
    assert.ok(
      validationIds.some((jid) => needs.includes(jid)),
      `${id} job 必须 needs 只读校验 job（校验不通过不得开 PR）`
    );

    const perms = jobPermissions(job);
    assert.equal(perms.contents, 'write', '自动更新 job 需要 contents: write 推送分支');
    assert.equal(perms['pull-requests'], 'write', '自动更新 job 需要 pull-requests: write 开/合并 PR');
    const grantedWrites = WRITE_SCOPES.filter((scope) => perms[scope] === 'write');
    assert.deepEqual(
      grantedWrites.sort(),
      ['contents', 'pull-requests'],
      '自动更新 job 的写权限必须最小化（只允许 contents / pull-requests）'
    );
  });

  it('PR 事件可触达的 job 不执行任何写操作命令', () => {
    // 这些命令会产生仓库写副作用：版本检测（写文件）/ README 同步 / 开 PR / 推送
    const writeCommands = [
      '.github/scripts/detect-updates.mjs',
      '.github/scripts/sync-readme.mjs',
      '.github/bin/open-update-pr.mjs',
      'git push',
    ];
    for (const [id, job] of Object.entries(jobs)) {
      if (writeJobBlockedOnPullRequest(job)) continue;
      for (const cmd of writeCommands) {
        assert.ok(
          !jobRuns(job, cmd),
          `${id} job 可能在 PR 事件运行，禁止执行写操作命令：${cmd}`
        );
      }
    }
  });

  it('Token fallback 统一为 PAT_TOKEN || github.token', () => {
    const [id, job] = autoUpdateJobs[0];
    const text = jobText(job) + JSON.stringify(workflow);
    assert.ok(
      /secrets\.PAT_TOKEN\s*\|\|\s*github\.token/.test(text),
      `${id} job 的 checkout/写步骤必须使用 secrets.PAT_TOKEN || github.token 的统一 fallback`
    );
  });

  it('concurrency 配置存在且按事件区分（避免 PR 校验与自动更新互相阻塞/越权）', () => {
    assert.ok(workflow.concurrency, '必须声明 concurrency');
    const group = String(workflow.concurrency.group || '');
    assert.ok(group.length > 0, 'concurrency.group 不能为空');
    assert.ok(
      group.includes('github.event_name') || group.includes('pull_request'),
      'concurrency.group 应区分 PR 事件与自动更新事件'
    );
  });

  it('自动更新分支只在 GitHub Checks 通过后才合并（脚本层不出现无条件合并）', () => {
    // 脚本实现细节由 .github/bin/open-update-pr.mjs 的单元测试锁定；
    // 这里只做静态护栏：workflow 不得直接调用 gh pr merge / curl merge，
    // 合并必须经由 open-update-pr.mjs 的检查门禁。
    const text = JSON.stringify(workflow);
    assert.ok(!/gh\s+pr\s+merge/.test(text), 'workflow 不得直接 gh pr merge（应通过等待 checks 的脚本）');
    assert.ok(!/pulls\/.*\/merge/.test(text), 'workflow 不得直接调 merge API');
  });
});

// ─── 2026-11 可靠性治理：必需检查绑定 / 权限补齐 / 去掉 paths 过滤 ──────────

describe('auto-update workflow：合并门禁与必需检查（2026-11 治理）', () => {
  /** 找出跑 open-update-pr.mjs 的 step */
  function prSteps(job) {
    return (job?.steps || []).filter((s) => String(s?.run || '').includes('open-update-pr.mjs'));
  }

  it('REQUIRED_CHECKS 环境变量必须与 validate job 的 name 完全一致', () => {
    // 审计 P0-1：合并门禁按「必需检查名」判定。若 env 与 job name 脱节，
    // 必需检查永远匹配不上 → 门禁恒超时（或误判为通过）。
    const [validateId, validateJob] = validationJobs[0];
    const jobName = validateJob.name;
    assert.ok(jobName, `${validateId} job 必须有 name（它就是 check run 的名字）`);

    const [autoId, autoJob] = autoUpdateJobs[0];
    const steps = prSteps(autoJob);
    assert.ok(steps.length > 0, `${autoId} job 必须有开 PR 的 step`);
    const env = steps[0].env || {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(env, 'REQUIRED_CHECKS'),
      `${autoId} job 的开 PR step 必须显式声明 REQUIRED_CHECKS`,
    );
    const required = String(env.REQUIRED_CHECKS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.deepEqual(
      required,
      [jobName],
      `REQUIRED_CHECKS 必须与 ${validateId} job 的 name 一致（改名时必须同步）`,
    );
  });

  it('自动更新 job 必须授予 checks: read 与 statuses: read（合并门禁要读检查状态）', () => {
    // 审计 P1-9：waitForChecks 调 /commits/{sha}/check-runs 与 /commits/{sha}/status，
    // 两者分别要求 checks: read / statuses: read。缺了 → GITHUB_TOKEN 路径恒 403
    // → 门禁恒 unknown → 永不合并。
    const [id, job] = autoUpdateJobs[0];
    const perms = jobPermissions(job);
    assert.equal(perms.checks, 'read', `${id} job 需要 checks: read 读取目标 PR 的 Check Runs`);
    assert.equal(perms.statuses, 'read', `${id} job 需要 statuses: read 读取目标 PR 的 commit status`);
  });

  it('pull_request 触发器**不得**使用 paths 过滤（避免必需检查从未触发导致 PR 卡死）', () => {
    // 审计 P0-1 触发路径 + required check 死锁：路径过滤会让 validate job 在
    // 「只改 README / 非白名单文件」的 PR 上根本不跑 → 必需检查从未出现
    // → GitHub 视为未通过 → PR 永久卡死。
    const triggers = workflow.on ?? workflow[true] ?? workflow[String('on')];
    const pr = triggers.pull_request;
    assert.ok(pr, '必须保留 pull_request 触发');
    assert.equal(
      pr.paths,
      undefined,
      'pull_request 不得使用 paths 过滤（必需检查必须对每个 PR 都出现）',
    );
  });

  it('合并门禁步骤不得使用管理员 / 绕过分支保护的参数', () => {
    const text = JSON.stringify(workflow);
    assert.ok(!/--admin/.test(text), 'workflow 不得使用 gh pr merge --admin');
    assert.ok(!/bypass/i.test(text), 'workflow 不得出现绕过分支保护的配置');
  });
});

// ─── 2026-11-05 热修：Token 传递不得静默退化 ───────────────────────────────

describe('auto-update workflow：Token 传递（audit P2-12 实况确认）', () => {
  it('开 PR 步骤只传 secrets.PAT_TOKEN，**不得**回退 github.token', () => {
    // GITHUB_TOKEN 创建的 PR 不触发 pull_request 工作流 → 必需检查永不到达
    // → 合并门禁卡满超时，批次静默丢失（PR #50 实况）。
    // 因此工作流必须只传真 PAT；PAT 缺失时由脚本立即失败并给出可执行指引。
    const [autoId, autoJob] = autoUpdateJobs[0];
    const prStep = (autoJob.steps || []).find((s) =>
      String(s?.run || '').includes('open-update-pr.mjs'),
    );
    assert.ok(prStep, `${autoId} job 必须有开 PR 的 step`);
    const env = prStep.env || {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(env, 'PAT_TOKEN'),
      '必须显式声明 PAT_TOKEN 环境变量',
    );
    assert.match(
      String(env.PAT_TOKEN),
      /secrets\.PAT_TOKEN/,
      'PAT_TOKEN 必须取自 secrets.PAT_TOKEN',
    );
    assert.ok(
      !/github\.token/.test(String(env.PAT_TOKEN)),
      `PAT_TOKEN 不得回退 github.token（实测：${env.PAT_TOKEN}）`,
    );
  });
});

// ─── 2026-11-05 输出收敛：Summary 不得重复渲染同一张表 ─────────────────────

describe('auto-update workflow：Summary 输出收敛', () => {
  it('执行结果汇总步骤必须 appTable:false（每应用表已由 detect 脚本写过）', () => {
    // detect-updates.mjs 自己写「每应用结果」段（它才有 updates.json 的 results）；
    // workflow 再渲染一遍 → 同一张表出现在 Summary 里两次（实测 178 行 / 8.4 KiB）。
    const [autoId, autoJob] = autoUpdateJobs[0];
    const step = (autoJob.steps || []).find((s) =>
      String(s?.run || '').includes('renderExecutionMarkdown'),
    );
    assert.ok(step, `${autoId} job 必须有渲染执行结果的 step`);
    assert.match(
      String(step.run),
      /appTable:\s*false/,
      '执行结果步骤必须关闭每应用表（避免与 detect 脚本的 Summary 重复）',
    );
  });

  it('检测结果步骤不得再渲染每应用表（统一由 detect 脚本负责）', () => {
    const [autoId, autoJob] = autoUpdateJobs[0];
    const step = (autoJob.steps || []).find((s) =>
      String(s?.run || '').includes('updates.json') &&
      String(s?.run || '').includes('GITHUB_STEP_SUMMARY'),
    );
    assert.ok(step, `${autoId} job 必须有检测结果汇总步骤`);
    assert.ok(
      !String(step.run).includes('renderMarkdown('),
      '检测结果步骤不得再渲染每应用表（与 detect 脚本的 Summary 重复）',
    );
  });
});
