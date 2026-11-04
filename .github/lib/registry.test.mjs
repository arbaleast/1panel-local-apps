// lib/registry.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseImage, DockerHubAdapter, GhcrAdapter, createAdapter, RegistryRequestError } from './registry.mjs';

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

  // 3. DockerHub 429 → 抛 RegistryRequestError
  // 语义变更（task-2）：HTTP 非 2xx 属于"请求失败"，绝不能被吞成 null
  // （吞成 null 会让 detect 把"Registry 故障"误判成"无更新"，静默漏检）。
  it('DockerHub throws RegistryRequestError on 429', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () => Promise.resolve({ ok: false, status: 429 }),
    });
    await assert.rejects(
      () => adapter.getLatestTag('nginx'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 429);
        assert.match(e.message, /429/);
        return true;
      },
    );
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

  // 18. DockerHubAdapter 形态 4：多段数字版本不被历史遗留的 3 段纯 semver 抢占（collabora 回归用例）
  // collabora/code 同时存在 2017 年的 2.1.2~2.1.5 与当前的 26.04.5.1.1，
  // pickLatest 的"纯 semver 优先"会选到 2.1.5 → auto-update 会写出错误的版本目录。
  it('DockerHubAdapter: multi-segment numeric tag ignores legacy 3-segment pure semver', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: '2.1.2' },
              { name: '2.1.3' },
              { name: '2.1.4' },
              { name: '2.1.5' },
              { name: '25.04.9.2.1' },
              { name: '26.04.4.2.1' },
              { name: '26.04.5.1.1' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('collabora/code:26.04.5.1.1', '26.04.5.1.1');
    assert.equal(tag, '26.04.5.1.1');
  });

  // 19. DockerHubAdapter 形态 4：同段数出现更新的 tag 时能正确检出
  it('DockerHubAdapter: multi-segment numeric tag detects newer same-shape tag', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              { name: 'latest' },
              { name: '2.1.5' },
              { name: '26.04.5.1.1' },
              { name: '26.04.6.1.1' },
            ],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('collabora/code:26.04.5.1.1', '26.04.5.1.1');
    assert.equal(tag, '26.04.6.1.1');
  });

  // 20. DockerHubAdapter 形态 4：同段数 tag 不存在时走 fallback，不误报、不崩溃
  it('DockerHubAdapter: multi-segment numeric tag falls back when no same-shape tag exists', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            results: [{ name: 'latest' }, { name: '1.2.3' }, { name: '1.2.4' }],
          }),
        }),
    });
    const tag = await adapter.getLatestTag('org/repo:1.2.3.4.5', '1.2.3.4.5');
    assert.equal(tag, '1.2.4');
  });

  // 21. GhcrAdapter 形态 4：与 DockerHubAdapter 行为一致
  it('GhcrAdapter: multi-segment numeric tag ignores legacy 3-segment pure semver', async () => {
    const fetchMock = makeMockFetch([
      () => ({ ok: true, json: async () => ({ token: 'anon-token' }) }),
      () => ({
        ok: true,
        json: async () => ({ tags: ['2.1.5', '26.04.5.1.1', '26.04.6.1.1'] }),
      }),
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:26.04.5.1.1', '26.04.5.1.1');
    assert.equal(tag, '26.04.6.1.1');
  });

  // 22. GhcrAdapter 翻页：tag 总数超过单页上限（n=1000）时必须跟随 Link rel="next"，
  //     否则只能在字典序第一页的旧 tag 里选，误判出远古版本（traefik 3.0.3 事故）
  it('GhcrAdapter paginates tags via Link rel=next (traefik 2700+ tags)', async () => {
    const requested = [];
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'anon-token' }) });
      }
      requested.push(url);
      if (url.includes('last=3.0.3')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: async () => ({ tags: ['v3.6.6', 'v3.7.17'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: {
          get: (name) =>
            name.toLowerCase() === 'link'
              ? '</v2/org/repo/tags/list?last=3.0.3&n=1000>; rel="next"'
              : null,
        },
        json: async () => ({ tags: ['1.0.0', '2.0.0', '3.0.3'] }),
      });
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:v3.6.6', 'v3.6.6');
    assert.equal(tag, 'v3.7.17');
    assert.equal(requested.length, 2);
  });

  // 23. GhcrAdapter 翻页：后续页失败 → 抛 RegistryRequestError
  // 语义变更（task-2）：翻页中途失败意味着"无法确认 tag 列表完整性"，
  // 此时继续用半截数据算"最新版本"必然漏检更新 → 必须报错，不得静默返回旧数据。
  //
  // 为什么"第一页成功就返回"是危险的：GHCR 的 tags/list 返回顺序是 **字典序**（不是"最新在前"），
  // 第一页装的是**最旧**的 tag（traefik 2700+ tag 时第一页只到 v2.0.0-alpha6-*）。
  // 静默沿用第一页 → pickLatest 只能在 1.x/2.x 里选 → 把"最新版本"误判成 3.0.3 这类远古版本，
  // auto-update 就会写出旧镜像的版本目录。这正是 AGENTS.md 记录的 traefik 3.0.3 事故。
  // 因此第 2 页失败必须抛 RegistryRequestError，且 partial 诊断信息（已拿到多少 tag）要保留，
  // 供 detect-updates.mjs 写进失败日志。
  it('GhcrAdapter throws RegistryRequestError when a later page fails', async () => {
    let tagPages = 0;
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      }
      tagPages += 1;
      if (tagPages === 1) {
        return Promise.resolve({
          ok: true,
          headers: {
            get: (name) =>
              name.toLowerCase() === 'link'
                ? '</v2/org/repo/tags/list?last=v1.0.0&n=1000>; rel="next"'
                : null,
          },
          json: async () => ({ tags: ['v1.0.0', 'v1.0.1'] }),
        });
      }
      return Promise.resolve({ ok: false, status: 503 });
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    await assert.rejects(
      () => adapter.getLatestTag('ghcr.io/org/repo:v1.0.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 503);
        // 失败发生在第 2 页；第 1 页已经拿到 2 个 tag —— 该计数必须保留下来
        assert.deepEqual(e.partial, { page: 2, tags: 2 });
        return true;
      },
    );
  });

  // 24. GhcrAdapter 翻页：Link 给出绝对 URL 时直接使用，不重复拼 registry 前缀
  it('GhcrAdapter follows absolute Link rel=next URL', async () => {
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      }
      if (url === 'https://ghcr.io/v2/org/repo/tags/list?last=v2.0.0&n=1000') {
        return Promise.resolve({
          ok: true,
          headers: { get: () => null },
          json: async () => ({ tags: ['v3.0.0'] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: {
          get: (name) =>
            name.toLowerCase() === 'link'
              ? '<https://ghcr.io/v2/org/repo/tags/list?last=v2.0.0&n=1000>; rel="next"'
              : null,
        },
        json: async () => ({ tags: ['v1.0.0', 'v2.0.0'] }),
      });
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    const tag = await adapter.getLatestTag('ghcr.io/org/repo:v1.0.0');
    assert.equal(tag, 'v3.0.0');
  });

  // ===== task-2 新增：parseImage 扩展形态 =====

  // 25. registry 带端口：端口不得被当成 tag
  it('parseImage handles registry with port', () => {
    const r = parseImage('localhost:5000/app:1.0');
    assert.equal(r.registry, 'localhost:5000');
    assert.equal(r.repo, 'app');
    assert.equal(r.tag, '1.0');
    assert.equal(r.kind, 'custom');
  });

  // 26. 自定义 registry 域名
  it('parseImage handles custom registry host', () => {
    const r = parseImage('registry.example.com/org/app:1.2.3');
    assert.equal(r.registry, 'registry.example.com');
    assert.equal(r.repo, 'org/app');
    assert.equal(r.tag, '1.2.3');
    assert.equal(r.kind, 'custom');
  });

  // 27. tag + digest 同时存在
  it('parseImage handles tag plus digest', () => {
    const r = parseImage('nginx:1.25@sha256:abcdef');
    assert.equal(r.registry, 'dockerhub');
    assert.equal(r.repo, 'nginx');
    assert.equal(r.tag, '1.25');
    assert.equal(r.digest, 'sha256:abcdef');
  });

  // 28. docker.io/library 前缀归一为 dockerhub
  it('parseImage normalizes docker.io/library prefix', () => {
    const r = parseImage('docker.io/library/nginx:1.25');
    assert.equal(r.registry, 'dockerhub');
    assert.equal(r.repo, 'library/nginx');
    assert.equal(r.tag, '1.25');
  });

  // 29. 非法输入一律 null
  it('parseImage returns null for invalid inputs', () => {
    assert.equal(parseImage(''), null);
    assert.equal(parseImage('   '), null);
    assert.equal(parseImage(' nginx'), null);
    assert.equal(parseImage('ng inx:1.0'), null);
    assert.equal(parseImage('${IMAGE}:${TAG}'), null);
    assert.equal(parseImage('nginx:'), null);
    assert.equal(parseImage(':1.0'), null);
    assert.equal(parseImage(null), null);
    assert.equal(parseImage(undefined), null);
    assert.equal(parseImage(123), null);
  });

  // 30. createAdapter 对不支持的 registry / 非法镜像返回 null
  it('createAdapter returns null for unsupported registry and invalid image', () => {
    assert.equal(createAdapter('registry.example.com/org/app:1.0'), null);
    assert.equal(createAdapter('${IMAGE}:${TAG}'), null);
    assert.equal(createAdapter(''), null);
  });

  // 31. canHandle 依据 parseImage 结果，而非 startsWith 硬编码
  it('canHandle is based on parseImage result', () => {
    const docker = new DockerHubAdapter();
    const ghcr = new GhcrAdapter();
    assert.equal(docker.canHandle('nginx:1.0'), true);
    assert.equal(docker.canHandle('ghcr.io/org/repo:v1'), false);
    assert.equal(docker.canHandle('registry.example.com/a/b:1'), false);
    assert.equal(ghcr.canHandle('ghcr.io/org/repo:v1'), true);
    assert.equal(ghcr.canHandle('nginx:1.0'), false);
    assert.equal(ghcr.canHandle('${IMAGE}'), false);
  });

  // 32. 网络异常 → RegistryRequestError（DockerHub）
  it('DockerHub converts network throw into RegistryRequestError', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    await assert.rejects(
      () => adapter.getLatestTag('nginx:1.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /ECONNRESET/);
        return true;
      },
    );
  });

  // 33. 网络异常 → RegistryRequestError（GHCR tags 请求）
  it('GhcrAdapter converts network throw into RegistryRequestError', async () => {
    let calls = 0;
    const fetchMock = () => {
      calls += 1;
      if (calls === 1) {
        // token 端点失败 → 匿名降级（不算错误）
        return Promise.reject(new Error('token endpoint down'));
      }
      return Promise.reject(new Error('socket hang up'));
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    await assert.rejects(
      () => adapter.getLatestTag('ghcr.io/org/repo:v1'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /socket hang up/);
        return true;
      },
    );
  });

  // 34. JSON 解析失败 → RegistryRequestError
  it('DockerHub throws RegistryRequestError on malformed JSON', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => {
            throw new Error('Unexpected token < in JSON');
          },
        }),
    });
    await assert.rejects(
      () => adapter.getLatestTag('nginx:1.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /JSON/);
        return true;
      },
    );
  });

  // 35. 空 tag 列表 → null（请求成功但没有可用稳定 tag）
  it('DockerHub returns null for empty tag list', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () => Promise.resolve({ ok: true, json: async () => ({ results: [] }) }),
    });
    assert.equal(await adapter.getLatestTag('nginx:1.0'), null);
  });

  // 36. GHCR 空 tag 列表 → null
  it('GhcrAdapter returns null for empty tag list', async () => {
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ tags: [] }) });
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    assert.equal(await adapter.getLatestTag('ghcr.io/org/repo:v1'), null);
  });

  // 37. GHCR 第一页 HTTP 失败 → RegistryRequestError
  it('GhcrAdapter throws RegistryRequestError when first page fails', async () => {
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      }
      return Promise.resolve({ ok: false, status: 401 });
    };
    const adapter = new GhcrAdapter({ fetchMock, fetchImpl: fetchMock });
    await assert.rejects(
      () => adapter.getLatestTag('ghcr.io/org/repo:v1'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 401);
        return true;
      },
    );
  });

  // ===== task-5：契约补全（表驱动 parseImage + 错误路径 + createAdapter 分流）=====

  // 38. parseImage 表驱动：所有合法形态
  // parseImage 是**唯一**的镜像解析入口（task-2 要求模块内不得再有第二份 split(':') 逻辑），
  // 因此这里把每种形态都锁死，防止后续有人"顺手加一条正则"改坏别的形态。
  it('parseImage: table-driven valid forms', () => {
    const cases = [
      // 裸镜像
      { image: 'nginx', registry: 'dockerhub', repo: 'nginx', tag: undefined, digest: undefined, kind: 'dockerhub' },
      // 命名空间
      { image: 'kragleer/anirss:v1.2.3', registry: 'dockerhub', repo: 'kragleer/anirss', tag: 'v1.2.3', digest: undefined, kind: 'dockerhub' },
      // registry 域名
      { image: 'ghcr.io/org/repo:v1.2.3', registry: 'ghcr.io', repo: 'org/repo', tag: 'v1.2.3', digest: undefined, kind: 'ghcr' },
      // registry 带端口（端口不得被当成 tag）
      { image: 'localhost:5000/app:1.0', registry: 'localhost:5000', repo: 'app', tag: '1.0', digest: undefined, kind: 'custom' },
      // docker.io 别名归一
      { image: 'docker.io/library/nginx:1.25', registry: 'dockerhub', repo: 'library/nginx', tag: '1.25', digest: undefined, kind: 'dockerhub' },
      { image: 'index.docker.io/nginx:1.25', registry: 'dockerhub', repo: 'nginx', tag: '1.25', digest: undefined, kind: 'dockerhub' },
      { image: 'registry-1.docker.io/nginx:1.25', registry: 'dockerhub', repo: 'nginx', tag: '1.25', digest: undefined, kind: 'dockerhub' },
      // 仅 tag
      { image: 'nginx:1.25', registry: 'dockerhub', repo: 'nginx', tag: '1.25', digest: undefined, kind: 'dockerhub' },
      // 仅 digest（无 tag）
      { image: 'nginx@sha256:abc', registry: 'dockerhub', repo: 'nginx', tag: undefined, digest: 'sha256:abc', kind: 'dockerhub' },
      // tag + digest
      { image: 'nginx:1.25@sha256:abc', registry: 'dockerhub', repo: 'nginx', tag: '1.25', digest: 'sha256:abc', kind: 'dockerhub' },
    ];
    for (const c of cases) {
      const r = parseImage(c.image);
      assert.ok(r, `应能解析: ${c.image}`);
      assert.equal(r.registry, c.registry, `registry: ${c.image}`);
      assert.equal(r.repo, c.repo, `repo: ${c.image}`);
      assert.equal(r.tag, c.tag, `tag: ${c.image}`);
      assert.equal(r.digest, c.digest, `digest: ${c.image}`);
      assert.equal(r.kind, c.kind, `kind: ${c.image}`);
    }
  });

  // 39. parseImage 表驱动：所有非法形态一律 null
  it('parseImage: table-driven invalid forms', () => {
    const invalid = [
      '',                       // 空串
      '   ',                    // 全空白
      ' nginx',                 // 前导空白
      'nginx ',                 // 尾部空白
      'ng inx:1.0',             // 内部空白
      'nginx:1.0 1.1',          // 内部空白
      'nginx:${TAG}',           // 未展开的 compose 变量
      'nginx$',                 // 含 $
      'nginx?x=1',              // 含 ?
      'nginx#frag',             // 含 #
      ':1.0',                   // 空 repo
      'nginx:',                 // 空 tag
      'nginx@sha256',           // digest 缺少算法:内容 形式
      'nginx@:abc',             // digest 为空算法
      'ghcr.io//org/repo',      // 路径中出现 //
      'ghcr.io/org//repo',      // 路径中出现 //
      'foo//bar',               // 路径中出现 //
      '/nginx',                 // 前导斜杠
      'nginx/',                 // 尾部斜杠
    ];
    for (const image of invalid) {
      assert.equal(parseImage(image), null, `应解析失败: ${JSON.stringify(image)}`);
    }
    // 非字符串同样返回 null
    assert.equal(parseImage(null), null);
    assert.equal(parseImage(undefined), null);
    assert.equal(parseImage(123), null);
    assert.equal(parseImage({}), null);
  });

  // 40. createAdapter 分流表：支持的 registry 走对应适配器，不支持的一律 null
  it('createAdapter: table-driven routing', () => {
    assert.ok(createAdapter('nginx:1.25') instanceof DockerHubAdapter);
    assert.ok(createAdapter('kragleer/anirss:v1.2.3') instanceof DockerHubAdapter);
    assert.ok(createAdapter('ghcr.io/org/repo:v1.2.3') instanceof GhcrAdapter);
    // 自建 Harbor / 带端口的私有 registry：必须返回 null，
    // **绝不能**回退到 DockerHub API —— 那会查错仓库并报出假的"最新 tag"
    assert.equal(createAdapter('localhost:5000/app:1.0'), null);
    assert.equal(createAdapter('registry.example.com/org/app:1.0'), null);
    // 不可解析的镜像字符串
    assert.equal(createAdapter('${IMAGE}:${TAG}'), null);
    assert.equal(createAdapter(''), null);
    assert.equal(createAdapter(null), null);
  });

  // 41. getLatestTag 对不可解析的镜像字符串抛错（而不是静默返回 null）
  it('getLatestTag throws RegistryRequestError on unparsable image string', async () => {
    const docker = new DockerHubAdapter({
      fetchImpl: () => Promise.reject(new Error('不应该发起请求')),
    });
    await assert.rejects(
      () => docker.getLatestTag('${IMAGE}:${TAG}'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /无法解析/);
        return true;
      },
    );

    const ghcr = new GhcrAdapter({
      fetchImpl: () => Promise.reject(new Error('不应该发起请求')),
    });
    await assert.rejects(
      () => ghcr.getLatestTag('ng inx:1.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /无法解析/);
        return true;
      },
    );
  });

  // 42. DockerHub HTTP 500 → RegistryRequestError（带 status / url）
  it('DockerHub throws RegistryRequestError on HTTP 500', async () => {
    const adapter = new DockerHubAdapter({
      fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
    });
    await assert.rejects(
      () => adapter.getLatestTag('nginx:1.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 500);
        assert.match(e.url, /hub\.docker\.com/);
        assert.match(e.message, /500/);
        return true;
      },
    );
  });

  // 43. GHCR HTTP 500 → RegistryRequestError（带 status / url）
  it('GhcrAdapter throws RegistryRequestError on HTTP 500', async () => {
    const fetchMock = (url) => {
      if (url.includes('/token?')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
      }
      return Promise.resolve({ ok: false, status: 500 });
    };
    const adapter = new GhcrAdapter({ fetchImpl: fetchMock });
    await assert.rejects(
      () => adapter.getLatestTag('ghcr.io/org/repo:v1'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 500);
        assert.match(e.url, /ghcr\.io/);
        return true;
      },
    );
  });

  // 44. 请求成功但只有 latest 等不稳定 tag → null（不是错误）
  it('getLatestTag returns null when only unstable tags exist', async () => {
    const docker = new DockerHubAdapter({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ name: 'latest' }, { name: 'nightly' }] }),
        }),
    });
    assert.equal(await docker.getLatestTag('nginx:latest'), null);

    const ghcr = new GhcrAdapter({
      fetchImpl: (url) => {
        if (url.includes('/token?')) {
          return Promise.resolve({ ok: true, json: async () => ({ token: 't' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ tags: ['latest', 'main'] }) });
      },
    });
    assert.equal(await ghcr.getLatestTag('ghcr.io/org/repo:latest'), null);
  });

  // 45. DockerHub 翻页中途失败 → 抛错并保留 partial 诊断信息
  it('DockerHub throws RegistryRequestError with partial info when a later page fails', async () => {
    let calls = 0;
    const fetchMock = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [{ name: 'v1.0.0' }, { name: 'v1.0.1' }],
            next: 'https://hub.docker.com/v2/repositories/org/repo/tags/?page=2',
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 502 });
    };
    const adapter = new DockerHubAdapter({ fetchImpl: fetchMock });
    await assert.rejects(
      () => adapter.getLatestTag('org/repo:v1.0.0'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 502);
        assert.deepEqual(e.partial, { page: 2, tags: 2 });
        return true;
      },
    );
  });
});
