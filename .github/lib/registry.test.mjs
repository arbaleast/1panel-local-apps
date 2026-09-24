// lib/registry.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseImage, DockerHubAdapter, GhcrAdapter, createAdapter } from './registry.mjs';

// 辅助：将回调式 mock 转为 Promise
function makeMockFetch(calls) {
  return function mockFetch(url, opts) {
    return Promise.resolve(calls.shift()(url, opts));
  };
}

describe('registry', () => {
  // 1. GHCR 走匿名 token（注入 fetch mock）
  it('GHCR uses anonymous token when token endpoint available', async () => {
    let tokenRequested = false;
    const fetchMock = makeMockFetch([
      // 第一次：token 端点
      (_url) => {
        tokenRequested = true;
        return {
          ok: true,
          json: async () => ({ token: 'anon-token-abc' }),
        };
      },
      // 第二次：tags 列表
      (_url, opts) => {
        assert.equal(opts?.headers?.['Authorization'], 'Bearer anon-token-abc');
        return {
          ok: true,
          json: async () => ({ tags: ['v1.2.3', '1.2.3', 'v1.2.4'] }),
        };
      },
    ]);

    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:latest');
    assert.equal(tag, 'v1.2.4');
    assert.equal(tokenRequested, true);
  });

  // 2. GHCR token 端点失败降级匿名调用
  it('GHCR falls back to anonymous when token endpoint fails', async () => {
    const fetchMock = makeMockFetch([
      // 第一次：token 端点 500
      () => ({ ok: false, status: 500 }),
      // 第二次：仍可匿名访问 tags
      (_url, opts) => {
        // 无 Authorization header
        assert.equal(opts?.headers?.['Authorization'], undefined);
        return {
          ok: true,
          json: async () => ({ tags: ['v1.0.0'] }),
        };
      },
    ]);

    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:latest');
    assert.equal(tag, 'v1.0.0');
  });

  // 3. DockerHub 429 → null
  it('DockerHub returns null on 429', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () => Promise.resolve({ ok: false, status: 429 }),
    });
    const tag = await adapter.getLatestTag('nginx');
    assert.equal(tag, null);
  });

  // 4. tag 列表为空 → null
  it('DockerHub returns null when no stable tags', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ name: 'latest' }, { name: 'nightly' }] }),
        }),
    });
    const tag = await adapter.getLatestTag('nginx');
    assert.equal(tag, null);
  });

  // 5. parseImage: ghcr.io/org/repo:tag
  it('parseImage handles ghcr.io format', () => {
    const r = parseImage('ghcr.io/org/repo:v1.2.3');
    assert.equal(r.registry, 'ghcr.io');
    assert.equal(r.repo, 'org/repo');
    assert.equal(r.tag, 'v1.2.3');
    assert.equal(r.digest, undefined);
  });

  // 6. parseImage: nginx:1.25
  it('parseImage handles dockerhub format with tag', () => {
    const r = parseImage('nginx:1.25');
    assert.equal(r.registry, 'dockerhub');
    assert.equal(r.repo, 'nginx');
    assert.equal(r.tag, '1.25');
    assert.equal(r.digest, undefined);
  });

  // 7. parseImage: nginx@sha256:abc
  it('parseImage handles digest format', () => {
    const r = parseImage('nginx@sha256:abc');
    assert.equal(r.registry, 'dockerhub');
    assert.equal(r.repo, 'nginx');
    assert.equal(r.tag, undefined);
    assert.equal(r.digest, 'sha256:abc');
  });

  // 8. 工厂分流：instanceof 判定
  it('createAdapter routes to correct adapter type', () => {
    const ghcrAdapter = createAdapter('ghcr.io/org/repo:latest');
    assert.ok(ghcrAdapter instanceof GhcrAdapter);
    assert.ok(!(ghcrAdapter instanceof DockerHubAdapter));

    const dockerAdapter = createAdapter('nginx:latest');
    assert.ok(dockerAdapter instanceof DockerHubAdapter);
    assert.ok(!(dockerAdapter instanceof GhcrAdapter));
  });

  // 9. pickLatest 在 adapter 内行为（GHCR mock 注入 ['v1.2.3','1.2.3','v1.2.4'] → 'v1.2.4'）
  it('GhcrAdapter pickLatest selects correct tag from mixed list', async () => {
    const adapter = new GhcrAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({ tags: ['v1.2.3', '1.2.3', 'v1.2.4'] }),
        }),
    });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:latest');
    assert.equal(tag, 'v1.2.4');
  });

  // 10. DockerHubAdapter 变体标签匹配：当前 tag 为 pg，应匹配 pg-1.16.0
  it('DockerHubAdapter matches variant tags (pg -> pg-1.16.0)', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: 'pg' },
              { name: 'pg-1.15.0' },
              { name: 'pg-1.16.0' },
              { name: '1.16.0' },
              { name: 'railway-1.16.0' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('mintplexlabs/anythingllm:pg', 'pg');
    assert.equal(tag, 'pg-1.16.0');
  });

  // 11. DockerHubAdapter 变体标签匹配：当前 tag 为 railway，应匹配 railway-1.16.0
  it('DockerHubAdapter matches variant tags (railway -> railway-1.16.0)', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: 'railway' },
              { name: 'railway-1.15.0' },
              { name: 'railway-1.16.0' },
              { name: '1.16.0' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('mintplexlabs/anythingllm:railway', 'railway');
    assert.equal(tag, 'railway-1.16.0');
  });

  // 12. DockerHubAdapter 无变体前缀时回退普通选择
  it('DockerHubAdapter falls back to normal pickLatest when no variant prefix', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: '1.15.0' },
              { name: '1.16.0' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('nginx:1.15.0', '1.15.0');
    assert.equal(tag, '1.16.0');
  });

  // 13. GhcrAdapter 变体标签匹配
  it('GhcrAdapter matches variant tags (pg -> pg-1.16.0)', async () => {
    const adapter = new GhcrAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({ tags: ['pg', 'pg-1.15.0', 'pg-1.16.0', 'v1.16.0'] }),
        }),
    });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:pg', 'pg');
    assert.equal(tag, 'pg-1.16.0');
  });

  // 14. DockerHubAdapter semver+后缀变体：v3.2.18-arm32v7 → v3.2.29-arm32v7（anirss 回归用例）
  it('DockerHubAdapter matches semver+suffix variant (v3.2.18-arm32v7 -> v3.2.29-arm32v7)', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: 'v3.2.18' },
              { name: 'v3.2.18-arm32v7' },
              { name: 'v3.2.24' },
              { name: 'v3.2.24-arm32v7' },
              { name: 'v3.2.28' },
              { name: 'v3.2.28-arm32v7' },
              { name: 'v3.2.29' },
              { name: 'v3.2.29-arm32v7' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('wushuo894/ani-rss:v3.2.18-arm32v7', 'v3.2.18-arm32v7');
    assert.equal(tag, 'v3.2.29-arm32v7');
  });

  // 15. DockerHubAdapter semver+后缀：无当前 suffix 的变体（prefix 形式 1）时, 纯 v3.2.9 不走变体分支
  it('DockerHubAdapter: pure v3.2.24 falls back to pickLatest (no arm32v7)', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'v3.2.18-arm32v7' },
              { name: 'v3.2.24' },
              { name: 'v3.2.29' },
              { name: 'v3.2.29-arm32v7' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('wushuo894/ani-rss:v3.2.24', 'v3.2.24');
    // 形态 3 不匹配（无 -suffix）；形态 1/2 prefix='v' 被 ^v\d 排除 → fallback
    assert.equal(tag, 'v3.2.29');
  });

  // 16. DockerHubAdapter semver+后缀：suffix 不存在时 fallback，不误报
  it('DockerHubAdapter: semver+suffix with no same-suffix tags falls back to pickLatest', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'v3.2.24' },
              { name: 'v3.2.29' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('wushuo894/ani-rss:v3.2.18-arm64v8', 'v3.2.18-arm64v8');
    // 形态 3 suffix=arm64v8 找不到同 suffix → 走 fallback
    assert.equal(tag, 'v3.2.29');
  });

  // 16b. PR #19 复盘：arm32v7 在 page 2（被 page_size=20 截断）时仍能识别
  // 修复前：page_size=20 单页只拉 20 个 tag，anirss 30+ tag 导致 arm32v7 后缀全在 page 2
  //   之外，形态 3 同 suffix 匹配走空集 → fallback 返回纯 semver 最新（v3.2.36）→ 漏检 arm32v7
  // 修复后：page_size=100 + 翻页兜底 → page 1 拿不满就翻 page 2 → arm32v7 后缀在结果中
  //   → 形态 3 同 suffix 匹配命中 → 返回 v3.2.36-arm32v7
  it('DockerHubAdapter: semver+suffix matches when same-suffix tag is in page 2 (PR #19 regression)', async () => {
    // 构造 30 个 tag：page 1 = 20 个（最旧到 v3.2.32），page 2 = 10 个（v3.2.33..v3.2.37）
    // 其中 arm32v7 全部放在 page 2 模拟"被截断"
    const page1 = [];
    for (let v = 9; v <= 32; v++) {
      page1.push({ name: `v3.2.${v}` });
    }
    // page 1 共 24 个（v3.2.9..v3.2.32），已经超过 20
    // 重排：page 1 = 前 20 个（v3.2.9..v3.2.28）
    const p1 = page1.slice(0, 20);
    const p2 = page1.slice(20).concat([
      { name: 'v3.2.33' }, { name: 'v3.2.33-arm32v7' },
      { name: 'v3.2.34' }, { name: 'v3.2.34-arm32v7' },
      { name: 'v3.2.35' }, { name: 'v3.2.35-arm32v7' },
      { name: 'v3.2.36' }, { name: 'v3.2.36-arm32v7' },
      { name: 'v3.2.37' }, { name: 'v3.2.37-arm32v7' },
    ]);

    const fetchMock = makeMockFetch([
      () => ({
        ok: true,
        json: async () => ({ results: p1, next: 'https://hub.docker.com/v2/repositories/wushuo894/ani-rss/tags/?page=2&page_size=100&ordering=last_updated' }),
      }),
      () => ({
        ok: true,
        json: async () => ({ results: p2, next: null }),
      }),
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('wushuo894/ani-rss:v3.2.32-arm32v7', 'v3.2.32-arm32v7');
    assert.equal(tag, 'v3.2.37-arm32v7');
  });

  // 16c. 单页足够时（< 100 tag）不翻 page 2，避免多余 HTTP 调用
  it('DockerHubAdapter: stops at last page when next=null', async () => {
    let callCount = 0;
    const fetchMock = () => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            { name: 'v3.2.36' }, { name: 'v3.2.36-arm32v7' },
            { name: 'v3.2.32' }, { name: 'v3.2.32-arm32v7' },
          ],
          next: null,
        }),
      });
    };
    const adapter = new DockerHubAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('wushuo894/ani-rss:v3.2.32-arm32v7', 'v3.2.32-arm32v7');
    assert.equal(tag, 'v3.2.36-arm32v7');
    assert.equal(callCount, 1, '单页足够时只调 1 次 fetch');
  });

  // 16d. 超过 5 页（500 tag）时停止翻页，fallback 用已拉到的 tag 计算最新
  // 防止 scrob 这类 80+ tag 镜像 + 大量历史 tag 触发无限翻页
  it('DockerHubAdapter: caps pagination at MAX_PAGES (5) without infinite loop', async () => {
    let callCount = 0;
    const fetchMock = () => {
      callCount++;
      // 每页 100 个 v3.2.X tag + 永远返回 next（模拟"tag 数极多"）
      const results = [];
      for (let v = 1; v <= 100; v++) results.push({ name: `v1.0.${v}` });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results,
          next: `https://hub.docker.com/v2/repositories/test/repo/tags/?page=${callCount + 1}&page_size=100`,
        }),
      });
    };
    const adapter = new DockerHubAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('test/repo:v1.0.0', 'v1.0.0');
    assert.equal(callCount, 5, '最多 5 页翻页');
    assert.equal(tag, 'v1.0.100');
  });

  // 17. GhcrAdapter semver+后缀变体
  it('GhcrAdapter matches semver+suffix variant (v3.2.18-arm32v7 -> v3.2.29-arm32v7)', async () => {
    const fetchMock = makeMockFetch([
      () => ({ ok: true, json: async () => ({ token: 'anon-token' }) }),
      () => ({
        ok: true,
        json: async () => ({
          tags: ['v3.2.18', 'v3.2.18-arm32v7', 'v3.2.24', 'v3.2.24-arm32v7', 'v3.2.29', 'v3.2.29-arm32v7'],
        }),
      }),
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:v3.2.18-arm32v7', 'v3.2.18-arm32v7');
    assert.equal(tag, 'v3.2.29-arm32v7');
  });
});
