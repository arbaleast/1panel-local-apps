// .github/lib/github.test.mjs
// 覆盖 .github/lib/github.mjs。
//
// 核心回归点：2026-10-20 auto-update 事故——PR body 里的 markdown 反引号被
// shell 当成命令替换执行，导致 body 被掏空、GitHub 返回错误对象、
// 脚本打印 "PR 已开: undefined" 并删掉远程分支，整批更新丢失。
// 这里锁死「反引号原样送达 GitHub」这条不变量。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubClient,
  buildPullRequestBody,
  buildCommitMessage,
  buildPullRequestTitle,
  isAuthorizedWriteEvent,
  AUTHORIZED_WRITE_EVENTS,
  GitHubApiError,
} from './github.mjs';

/** 造一个假 fetch：记录调用，返回指定响应 */
function fakeFetch(response, sink = []) {
  return async (url, init) => {
    sink.push({ url, init });
    if (typeof response === 'function') return response(url, init);
    const status = response?.__status || 200;
    // 204 No Content 不能带 body
    const payload = status === 204 ? null : JSON.stringify(response);
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const UPDATES = [
  {
    app: 'anirss',
    from: 'v3.2.49',
    to: 'v3.2.51',
    services: [{ name: 'anirss', repo: 'wushuo894/ani-rss', from: 'v3.2.49', to: 'v3.2.51' }],
  },
  {
    app: 'anirss',
    from: 'v3.2.49-arm32v7',
    to: 'v3.2.51-arm32v7',
    services: [
      { name: 'anirss', repo: 'wushuo894/ani-rss', from: 'v3.2.49-arm32v7', to: 'v3.2.51-arm32v7' },
    ],
  },
  {
    app: 'cfui',
    from: 'v0.10.5',
    to: 'v0.10.6',
    services: [{ name: 'cfui', repo: 'ghcr.io/dockers-x/cfui', from: 'v0.10.5', to: 'v0.10.6' }],
  },
];

describe('buildPullRequestBody', () => {
  it('保留 markdown 反引号（shell 注入回归点）', () => {
    const body = buildPullRequestBody({
      updates: UPDATES,
      changedFiles: ['anirss/v3.2.51/data.yml'],
      generatedAt: '2026-10-20T03:03:25.637Z',
      today: '2026-10-20',
    });
    assert.ok(body.includes('`2026-10-20T03:03:25.637Z`'), '检测时间应保留反引号');
    assert.ok(body.includes('`v3.2.49`'), 'before 列应保留反引号');
    assert.ok(body.includes('`v3.2.51`'), 'after 列应保留反引号');
    assert.ok(body.includes('`anirss/v3.2.51/data.yml`'), '文件列表应保留反引号');
    assert.ok(body.includes('`.github/workflows/auto-update.yml`'), '页脚路径应保留反引号');
  });

  it('同 app 的多个版本目录合并为一个标题', () => {
    const body = buildPullRequestBody({ updates: UPDATES, today: '2026-10-20' });
    assert.equal(body.match(/^### /gm).length, 2, 'anirss 两条应合并成一个 ### 标题');
    assert.equal(body.match(/^### anirss$/gm).length, 1);
    assert.equal(body.match(/^### cfui$/gm).length, 1);
  });

  it('同一 service 重复出现时只列一行', () => {
    const dup = [
      { app: 'a', services: [{ name: 's', repo: 'r', from: '1', to: '2' }] },
      { app: 'a', services: [{ name: 's', repo: 'r', from: '1', to: '2' }] },
    ];
    const body = buildPullRequestBody({ updates: dup, today: '2026-10-20' });
    assert.equal(body.match(/^\| s \| r \|/gm).length, 1);
  });

  it('changes 为空时走兜底文案', () => {
    const body = buildPullRequestBody({ updates: [], today: '2026-10-20' });
    assert.ok(body.includes('自动更新 2026-10-20'));
    assert.ok(!body.includes('## 自动检测到的新版本'));
  });

  it('updates 非数组时按空处理，不抛异常', () => {
    const body = buildPullRequestBody({ updates: undefined, today: '2026-10-20' });
    assert.ok(body.includes('自动更新 2026-10-20'));
  });
});

describe('buildCommitMessage', () => {
  // 核心回归点：skip 指令（[skip ci] 等）不能出现在自动更新 commit 的 HEAD message 里。
  // GitHub 对 pull_request 事件判定的是 PR 的 HEAD commit message —— 一旦命中 skip，
  // 自动更新 PR 的 validate workflow 会被整体跳过 → 必需检查永远不出现 →
  // waitForChecks 只能超时 → PR 永远无法自动合并（合并门禁变死锁）。
  const SKIP_INSTRUCTION_RE = /\[(?:skip[ _-]?ci|ci[ _-]?skip|no[ _-]?ci|skip[ _-]?actions|actions[ _-]?skip)\]/i;

  it('subject 与 body 分开，且不含任何 skip 指令', () => {
    const { subject, body } = buildCommitMessage({ today: '2026-10-20' });
    assert.equal(subject, 'chore(deps): auto-update 2026-10-20');
    assert.ok(body.includes('.github/workflows/auto-update.yml'));
    assert.doesNotMatch(subject, SKIP_INSTRUCTION_RE, 'commit subject 不得含 skip 指令');
    assert.doesNotMatch(body, SKIP_INSTRUCTION_RE, 'commit body 不得含 skip 指令（会跳过 PR 的必需检查）');
  });

  it('不含字面量 \\n 序列（旧实现把换行写成了字面量）', () => {
    const { subject, body } = buildCommitMessage({ today: '2026-10-20' });
    assert.ok(!subject.includes('\\n'));
    assert.ok(!body.includes('\\n'));
  });
});

describe('buildPullRequestTitle', () => {
  const SKIP_INSTRUCTION_RE = /\[(?:skip[ _-]?ci|ci[ _-]?skip|no[ _-]?ci|skip[ _-]?actions|actions[ _-]?skip)\]/i;

  it('title 含日期且不含任何 skip 指令', () => {
    const title = buildPullRequestTitle({ today: '2026-10-20' });
    assert.equal(title, 'chore(deps): auto-update 2026-10-20');
    assert.doesNotMatch(title, SKIP_INSTRUCTION_RE, 'PR title 的 skip 指令会跳过 pull_request 检查（门禁死锁）');
  });
});

describe('createGitHubClient', () => {
  it('createPullRequest 把 body 原样放进 JSON 请求体（反引号不被吞）', async () => {
    const sink = [];
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch({ number: 36, html_url: 'https://example/36' }, sink),
    });
    const body = buildPullRequestBody({
      updates: UPDATES,
      changedFiles: ['anirss/v3.2.51/data.yml'],
      generatedAt: '2026-10-20T03:03:25.637Z',
      today: '2026-10-20',
    });
    const pr = await client.createPullRequest({
      owner: 'arbaleast',
      repo: '1panel-local-apps',
      head: 'auto-update/2026-10-20',
      base: 'main',
      title: 'chore(deps): auto-update 2026-10-20 [skip ci]',
      body,
    });

    assert.equal(pr.number, 36);
    const sent = JSON.parse(sink[0].init.body);
    assert.equal(sent.body, body, '请求体里的 body 必须与传入的完全一致');
    assert.ok(sent.body.includes('`v3.2.51`'));
    assert.ok(sent.body.includes('`anirss/v3.2.51/data.yml`'));
    assert.equal(sent.head, 'auto-update/2026-10-20');
    assert.equal(sink[0].url, 'https://api.github.com/repos/arbaleast/1panel-local-apps/pulls');
  });

  it('响应没有 number 时抛错（事故根因：PR 已开: undefined）', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch({ message: 'Validation Failed', errors: [{ code: 'invalid' }] }),
    });
    await assert.rejects(
      () =>
        client.createPullRequest({
          owner: 'o',
          repo: 'r',
          head: 'b',
          base: 'main',
          title: 't',
          body: 'b',
        }),
      (err) => err instanceof GitHubApiError && /未返回编号/.test(err.message),
    );
  });

  it('4xx 时抛 GitHubApiError 并带上 GitHub 的 message', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await assert.rejects(
      () => client.listOpenPullRequests({ owner: 'o', repo: 'r' }),
      (err) =>
        err instanceof GitHubApiError &&
        err.status === 401 &&
        /Bad credentials/.test(err.message),
    );
  });

  it('listOpenPullRequests 按 head 过滤并返回数组', async () => {
    const sink = [];
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch([{ number: 7 }], sink),
    });
    const prs = await client.listOpenPullRequests({
      owner: 'arbaleast',
      repo: '1panel-local-apps',
      head: 'arbaleast:auto-update/2026-10-20',
    });
    assert.equal(prs.length, 1);
    assert.ok(sink[0].url.includes('state=open'));
    assert.ok(sink[0].url.includes('head=arbaleast%3Aauto-update%2F2026-10-20'));
  });

  it('merge 返回 merged 标记与 message', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch({ merged: true, message: 'Pull Request successfully merged' }),
    });
    const r = await client.mergePullRequest({ owner: 'o', repo: 'r', number: 36 });
    assert.equal(r.merged, true);
    assert.match(r.message, /merged/i);
  });

  it('merge 失败（未合并）时 merged=false 且带 message', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch({ merged: false, message: 'Base branch was modified' }),
    });
    const r = await client.mergePullRequest({ owner: 'o', repo: 'r', number: 36 });
    assert.equal(r.merged, false);
    assert.match(r.message, /Base branch/);
  });

  it('deleteBranch 走 DELETE /git/refs/heads/<branch>', async () => {
    const sink = [];
    const client = createGitHubClient({
      token: 't',
      fetchImpl: fakeFetch({ __status: 204 }, sink),
    });
    await client.deleteBranch({ owner: 'o', repo: 'r', branch: 'auto-update/2026-10-20' });
    assert.equal(sink[0].init.method, 'DELETE');
    assert.equal(sink[0].url, 'https://api.github.com/repos/o/r/git/refs/heads/auto-update/2026-10-20');
  });

  it('网络异常包装成 GitHubApiError', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await assert.rejects(
      () => client.listOpenPullRequests({ owner: 'o', repo: 'r' }),
      (err) => err instanceof GitHubApiError && /ECONNREFUSED/.test(err.message),
    );
  });

  it('缺少 token 时直接抛错', () => {
    assert.throws(() => createGitHubClient({}), /缺少 token/);
  });
});

// ─── 检查状态（合并门禁）─────────────────────────────────────────────────

/**
 * 造一个按路径分派的假 fetch：
 * @param {{checkRuns?: any, status?: any, fail?: boolean, throwOn?: RegExp}} spec
 */
function routingFetch(spec, sink = []) {
  return async (url, init) => {
    sink.push({ url, init });
    if (spec.throwOn && spec.throwOn.test(url)) {
      throw new Error('ECONNRESET');
    }
    if (url.includes('/check-runs')) {
      const status = spec.checkRunsStatus || 200;
      return new Response(JSON.stringify(spec.checkRuns ?? { check_runs: [] }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/status')) {
      const status = spec.statusStatus || 200;
      return new Response(JSON.stringify(spec.status ?? { state: 'success', statuses: [] }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

/** 造一个可控时钟（now / sleep 注入） */
function fakeClock(start = 0, step = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(ms, step);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('listCheckRuns', () => {
  it('解析 check_runs 为 {name,status,conclusion}', async () => {
    const sink = [];
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch(
        {
          checkRuns: {
            check_runs: [
              { name: 'lint', status: 'completed', conclusion: 'success' },
              { name: 'test', status: 'queued', conclusion: null },
            ],
          },
        },
        sink,
      ),
    });
    const runs = await client.listCheckRuns({ owner: 'o', repo: 'r', ref: 'abc123' });
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0], { name: 'lint', status: 'completed', conclusion: 'success' });
    assert.equal(runs[1].conclusion, null);
    assert.ok(sink[0].url.includes('/commits/abc123/check-runs'));
    assert.ok(sink[0].url.includes('per_page=100'));
  });

  it('缺少 check_runs 字段时返回空数组', async () => {
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({ checkRuns: {} }),
    });
    assert.deepEqual(await client.listCheckRuns({ owner: 'o', repo: 'r', ref: 'x' }), []);
  });
});

describe('getCombinedStatus', () => {
  it('返回 state 与 statuses', async () => {
    const sink = [];
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch(
        { status: { state: 'success', statuses: [{ context: 'ci', state: 'success' }] } },
        sink,
      ),
    });
    const s = await client.getCombinedStatus({ owner: 'o', repo: 'r', ref: 'abc' });
    assert.equal(s.state, 'success');
    assert.equal(s.statuses.length, 1);
    assert.ok(sink[0].url.includes('/commits/abc/status'));
  });
});

describe('waitForChecks', () => {
  it('全部检查成功 → success', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({
        checkRuns: {
          check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
        },
        status: { state: 'success', statuses: [] },
      }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 60000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'success');
    assert.equal(r.checks.length, 1);
  });

  it('有一个检查失败 → failure', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({
        checkRuns: {
          check_runs: [
            { name: 'lint', status: 'completed', conclusion: 'success' },
            { name: 'test', status: 'completed', conclusion: 'failure' },
          ],
        },
        status: { state: 'success', statuses: [] },
      }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 60000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'failure');
  });

  it('有一个检查仍在 queued → timeout', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({
        checkRuns: {
          check_runs: [{ name: 'lint', status: 'queued', conclusion: null }],
        },
        status: { state: 'pending', statuses: [] },
      }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 5000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'timeout');
  });

  it('没有任何 check run → timeout（信息缺失不合并）', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({
        checkRuns: { check_runs: [] },
        status: { state: 'pending', statuses: [] },
      }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 3000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'timeout');
    assert.deepEqual(r.checks, []);
  });

  it('API 调用失败 → unknown（绝不合并）', async () => {
    const clock = fakeClock();
    // 让 check-runs 请求抛网络错误
    const client2 = createGitHubClient({
      token: 't',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const r = await client2.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 1000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'unknown');
    assert.match(r.error, /ECONNRESET/);
  });

  it('API 返回非 2xx → unknown', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({ checkRunsStatus: 500 }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 1000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'unknown');
  });

  it('合并状态为 failure → failure', async () => {
    const clock = fakeClock();
    const client = createGitHubClient({
      token: 't',
      fetchImpl: routingFetch({
        checkRuns: {
          check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
        },
        status: { state: 'failure', statuses: [] },
      }),
    });
    const r = await client.waitForChecks({
      owner: 'o', repo: 'r', ref: 'sha', timeoutMs: 60000, intervalMs: 1000,
      now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'failure');
  });
});

describe('isAuthorizedWriteEvent（脚本层事件护栏）', () => {
  it('schedule / workflow_dispatch / push 允许执行写操作', () => {
    for (const ev of ['schedule', 'workflow_dispatch', 'push']) {
      assert.equal(isAuthorizedWriteEvent(ev), true, `${ev} 应允许`);
    }
  });

  it('pull_request / pull_request_target 一律拒绝（PR 代码不得拿 PAT 写权限）', () => {
    for (const ev of ['pull_request', 'pull_request_target']) {
      assert.equal(isAuthorizedWriteEvent(ev), false, `${ev} 必须拒绝`);
    }
  });

  it('未知事件默认拒绝（白名单语义，不因新事件名而放行）', () => {
    assert.equal(isAuthorizedWriteEvent('issues'), false);
    assert.equal(isAuthorizedWriteEvent('release'), false);
    assert.equal(isAuthorizedWriteEvent(''), true, '空事件名 = 本地手动运行，允许');
    assert.equal(isAuthorizedWriteEvent(undefined), true);
  });

  it('AUTHORIZED_WRITE_EVENTS 白名单不含任何 PR 事件', () => {
    assert.ok(AUTHORIZED_WRITE_EVENTS instanceof Set);
    assert.ok(!AUTHORIZED_WRITE_EVENTS.has('pull_request'));
    assert.ok(!AUTHORIZED_WRITE_EVENTS.has('pull_request_target'));
    assert.deepEqual([...AUTHORIZED_WRITE_EVENTS].sort(), ['push', 'schedule', 'workflow_dispatch']);
  });
});
