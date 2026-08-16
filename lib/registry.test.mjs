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
});
