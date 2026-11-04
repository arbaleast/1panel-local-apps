// lib/report.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResults, renderSummary, renderMarkdown, exitCodeForResults, escapeCell } from './report.mjs';

const results = [
  { app: 'anirss', status: 'success', stage: 'done', reason: 'update-found', updates: 2 },
  { app: 'traefik', status: 'success', stage: 'done', reason: 'no-update', updates: 0 },
  { app: 'jellyfin', status: 'skipped', stage: 'whitelist', reason: 'whitelisted', updates: 0 },
  {
    app: 'collabora',
    status: 'failed',
    stage: 'registry',
    reason: 'registry-request-failed',
    error: 'DockerHub 返回 HTTP 429',
    updates: 0,
  },
];

describe('aggregateResults', () => {
  it('统计 status 计数', () => {
    const agg = aggregateResults(results);
    assert.equal(agg.total, 4);
    assert.equal(agg.success, 2);
    assert.equal(agg.skipped, 1);
    assert.equal(agg.failed, 1);
  });

  it('统计 reason 分布', () => {
    const agg = aggregateResults(results);
    assert.equal(agg.byReason['update-found'], 1);
    assert.equal(agg.byReason['no-update'], 1);
    assert.equal(agg.byReason['whitelisted'], 1);
    assert.equal(agg.byReason['registry-request-failed'], 1);
  });

  it('累加更新数量', () => {
    const agg = aggregateResults(results);
    assert.equal(agg.updates, 2);
  });

  it('收集 failed 明细', () => {
    const agg = aggregateResults(results);
    assert.equal(agg.failures.length, 1);
    assert.equal(agg.failures[0].app, 'collabora');
  });

  it('空结果集', () => {
    const agg = aggregateResults([]);
    assert.equal(agg.total, 0);
    assert.equal(agg.success, 0);
    assert.equal(agg.skipped, 0);
    assert.equal(agg.failed, 0);
    assert.equal(agg.updates, 0);
    assert.deepEqual(agg.failures, []);
  });

  it('非数组输入按空处理', () => {
    const agg = aggregateResults(undefined);
    assert.equal(agg.total, 0);
  });

  it('success / skipped 混合（无 failed）', () => {
    const agg = aggregateResults([
      { app: 'a', status: 'success', stage: 'done', reason: 'no-update' },
      { app: 'b', status: 'skipped', stage: 'image-parse', reason: 'tag-latest' },
    ]);
    assert.equal(agg.failed, 0);
    assert.equal(agg.failures.length, 0);
    assert.equal(agg.byStatus.success, 1);
    assert.equal(agg.byStatus.skipped, 1);
  });
});

describe('renderSummary', () => {
  it('包含 status 统计', () => {
    const text = renderSummary(results);
    assert.match(text, /扫描应用: 4/);
    assert.match(text, /success: 2\s+skipped: 1\s+failed: 1/);
  });

  it('包含 reason 分布', () => {
    const text = renderSummary(results);
    assert.match(text, /registry-request-failed: 1/);
    assert.match(text, /update-found: 1/);
  });

  it('逐条列出 failed 的 app/stage/error', () => {
    const text = renderSummary(results);
    assert.match(text, /collabora \[stage=registry\] reason=registry-request-failed: DockerHub 返回 HTTP 429/);
  });

  it('空结果不抛错', () => {
    const text = renderSummary([]);
    assert.match(text, /扫描应用: 0/);
  });
});

describe('renderMarkdown', () => {
  it('包含每个 failed 的 app/stage/error', () => {
    const md = renderMarkdown(results);
    assert.match(md, /## detect-updates 检测汇总/);
    assert.match(md, /\| collabora \| registry \| registry-request-failed \| DockerHub 返回 HTTP 429 \|/);
  });

  it('包含 status 统计与 reason 分布表', () => {
    const md = renderMarkdown(results);
    assert.match(md, /scanned|扫描应用: \*\*4\*\*/);
    assert.match(md, /\| registry-request-failed \| 1 \|/);
    assert.match(md, /\| update-found \| 1 \|/);
  });

  it('无 failed 时给出"无失败"提示', () => {
    const md = renderMarkdown([
      { app: 'a', status: 'success', stage: 'done', reason: 'no-update' },
    ]);
    assert.match(md, /_（无失败）_/);
  });

  it('空结果集渲染正常', () => {
    const md = renderMarkdown([]);
    assert.match(md, /扫描应用: \*\*0\*\*/);
    assert.match(md, /_（无结果）_/);
    assert.match(md, /_（无失败）_/);
  });

  it('error 中的竖线与换行被转义', () => {
    const md = renderMarkdown([
      {
        app: 'x',
        status: 'failed',
        stage: 'registry',
        reason: 'registry-request-failed',
        error: 'a|b\nc',
      },
    ]);
    assert.match(md, /a\\\|b c/);
  });

  it('支持自定义标题与时间戳', () => {
    const md = renderMarkdown([], { title: '自定义标题', timestamp: '2026-11-01T00:00:00Z' });
    assert.match(md, /## 自定义标题/);
    assert.match(md, /2026-11-01T00:00:00Z/);
  });

  it('包含每应用结果表（app | status | stage | reason | error）', () => {
    const md = renderMarkdown(results);
    assert.match(md, /\| app \| status \| stage \| reason \| error \|/);
    assert.match(md, /\| anirss \| success \| done \| update-found \|  \|/);
    assert.match(md, /\| jellyfin \| skipped \| whitelist \| whitelisted \|  \|/);
  });

  it('每应用表里带 failed 应用的 error', () => {
    const md = renderMarkdown(results);
    assert.match(md, /\| collabora \| failed \| registry \| registry-request-failed \| DockerHub 返回 HTTP 429 \|/);
  });

  it('JSON 往返后的普通对象数组可直接渲染（CI 从 updates.json 读 results）', () => {
    const roundTripped = JSON.parse(JSON.stringify({ results }));
    const md = renderMarkdown(roundTripped.results, { title: 'x', timestamp: 'ts' });
    assert.match(md, /\| anirss \| success \|/);
    assert.match(md, /扫描应用: \*\*4\*\*/);
  });

  it('results 缺失（undefined）时按空渲染，不抛错', () => {
    const md = renderMarkdown(undefined);
    assert.match(md, /扫描应用: \*\*0\*\*/);
  });
});

describe('exitCodeForResults', () => {
  it('存在 failed → 2', () => {
    assert.equal(exitCodeForResults([
      { status: 'success' },
      { status: 'failed' },
    ]), 2);
  });

  it('无 failed → 0', () => {
    assert.equal(exitCodeForResults([{ status: 'success' }, { status: 'skipped' }]), 0);
    assert.equal(exitCodeForResults([]), 0);
    assert.equal(exitCodeForResults(undefined), 0);
  });
});

describe('escapeCell', () => {
  it('转义竖线与换行', () => {
    assert.equal(escapeCell('a|b\nc'), 'a\\|b c');
    assert.equal(escapeCell(null), '');
    assert.equal(escapeCell(undefined), '');
  });
});
