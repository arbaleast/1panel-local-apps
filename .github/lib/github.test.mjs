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
  it('subject 与 body 分开，body 首行是 [skip ci]', () => {
    const { subject, body } = buildCommitMessage({ today: '2026-10-20' });
    assert.equal(subject, 'chore(deps): auto-update 2026-10-20');
    assert.equal(body.split('\n')[0], '[skip ci]');
    assert.ok(body.includes('.github/workflows/auto-update.yml'));
  });

  it('不含字面量 \\n 序列（旧实现把换行写成了字面量）', () => {
    const { subject, body } = buildCommitMessage({ today: '2026-10-20' });
    assert.ok(!subject.includes('\\n'));
    assert.ok(!body.includes('\\n'));
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
