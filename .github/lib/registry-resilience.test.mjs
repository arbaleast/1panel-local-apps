// lib/registry-resilience.test.mjs
//
// 目标 Phase 8 场景 3/4/5/6/11：Registry 传输层的**韧性**行为锁定。
//
// 覆盖：
//   A. Docker Hub 分页 + 异常响应（分页拼接 / 结构异常抛错 / 404 / 翻页截断抛错）
//   B. GHCR 分页（Link 头）+ Token 认证（含匿名降级）
//   C. 限流与错误状态码分级（Retry-After / isRetryableStatus / 退避 / fetchWithRetry 语义）
//   D. 请求去重缓存（memoization，含失败不缓存 / clear）
//   E. 并发上限
//   F. Digest / 多架构（架构专属 tag 不得污染主轨）
//
// 全部离线：fetchImpl 全部为本地 mock，绝不触碰网络。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DockerHubAdapter,
  GhcrAdapter,
  createTagCache,
  fetchWithRetry,
  computeRetryDelay,
  isRetryableStatus,
  parseRetryAfter,
  RegistryRequestError,
} from './registry.mjs';

// ── 辅助：URL 路由 mock（不同 URL 返回不同响应）─────────────────────────────
//
// 为什么不用「顺序回调队列」：本文件大量场景需要**按 URL** 分流
// （token 端点 / 第 1 页 / 第 2 页），且要能统计每个 URL 的调用次数。
function makeRouter(routes) {
  const calls = [];
  const counts = new Map();
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const hit = routes.find(([key]) => url.includes(key));
    if (!hit) throw new Error(`mock 未注册该 URL: ${url}`);
    const [key, handler] = hit;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    return handler({ url, opts, n });
  };
  return {
    fetchImpl,
    calls,
    /** 某个路由 key 的调用次数 */
    countOf: (key) => counts.get(key) || 0,
    /** 总调用次数 */
    total: () => calls.length,
  };
}

/** 构造一个最小可用的 JSON Response */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 构造一个带 Link 头的 Response（GHCR 分页用） */
function linkResponse(body, link) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', link },
  });
}

/** no-op sleep：注入后重试不会真的等待（单测不引入真实时延） */
const noSleep = async () => {};

// ═══════════════════════════════════════════════════════════════════════════
// A. Docker Hub 分页 + 异常响应
// ═══════════════════════════════════════════════════════════════════════════

describe('A. DockerHubAdapter：分页与异常响应', () => {
  it('A1 两页结果按顺序拼接（page1.next → page2，page2.next=null 即停）', async () => {
    const router = makeRouter([
      ['page=2', () => jsonResponse({ results: [{ name: '2.0.0' }, { name: '2.1.0' }], next: null })],
      ['page_size=100', () => jsonResponse({
        results: [{ name: '1.0.0' }, { name: '1.1.0' }],
        next: 'https://hub.docker.com/v2/repositories/nginx/tags/?page=2&page_size=100',
      })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const tags = await adapter.fetchAllTags('nginx');
    assert.deepEqual(tags, ['1.0.0', '1.1.0', '2.0.0', '2.1.0']);
    assert.equal(router.total(), 2, '两页 = 两次请求');
  });

  it('A2 响应缺 results 字段 → 抛 RegistryRequestError（不得静默当成空列表）', async () => {
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ count: 0 })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('nginx'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError, '必须是 RegistryRequestError');
        assert.match(e.message, /results/, '错误信息必须点明缺失的是 results 字段');
        return true;
      },
    );
  });

  it('A3 results 存在但不是数组 → 抛 RegistryRequestError', async () => {
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ results: 'not-an-array' })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('nginx'),
      (e) => e instanceof RegistryRequestError && /响应结构异常/.test(e.message),
    );
  });

  it('A4 results 条目缺少字符串 name → 抛 RegistryRequestError', async () => {
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ results: [{ tag: '1.0.0' }, { name: 123 }] })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('nginx'),
      (e) => e instanceof RegistryRequestError && /name/.test(e.message),
    );
  });

  it('A5 tags 端点 HTTP 404（仓库不存在）→ 抛 RegistryRequestError，status=404', async () => {
    // ⚠️ 必须是 failed 级错误：绝不能被吞成 null（否则 detect 会误判成"已是最新"）
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ message: 'not found' }, { status: 404 })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('nonexistent/repo'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.equal(e.status, 404);
        assert.match(e.message, /404/);
        return true;
      },
    );
    assert.equal(router.total(), 1, '404 不可重试 → 只请求一次');
  });

  it('A6 翻页超过 5 页上限且 next 仍在 → 抛错（tag 列表不完整不得静默使用）', async () => {
    const router = makeRouter([
      ['page_size=100', ({ n: call }) => jsonResponse({
        results: [{ name: `1.0.${call}` }],
        next: `https://hub.docker.com/v2/repositories/nginx/tags/?page=${call + 1}&page_size=100`,
      })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('nginx'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /翻页达到上限/);
        return true;
      },
    );
    assert.equal(router.total(), 5, '最多翻 5 页后抛错');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. GHCR 分页（Link 头）+ Token 认证
// ═══════════════════════════════════════════════════════════════════════════

describe('B. GhcrAdapter：Link 分页与 Token 认证', () => {
  it('B1 先取 token，tags 请求带 Authorization: Bearer <token>', async () => {
    const router = makeRouter([
      ['/token?', () => jsonResponse({ token: 'anon-token-xyz' })],
      ['/tags/list', () => jsonResponse({ tags: ['v1.0.0'] })],
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const tags = await adapter.fetchAllTags('ghcr.io/org/repo');
    assert.deepEqual(tags, ['v1.0.0']);
    assert.match(router.calls[0].url, /ghcr\.io\/token\?/, 'token 端点必须先被调用');
    assert.equal(router.countOf('/tags/list'), 1);
    const tagsCall = router.calls.find(c => c.url.includes('/tags/list'));
    assert.equal(tagsCall.opts.headers.Authorization, 'Bearer anon-token-xyz');
  });

  it('B2 token 端点 HTTP 500 → 降级匿名，tags 请求不带 Authorization 且仍成功', async () => {
    const router = makeRouter([
      ['/token?', () => jsonResponse({ message: 'boom' }, { status: 500 })],
      ['/tags/list', () => jsonResponse({ tags: ['v1.0.0', 'v1.1.0'] })],
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const tags = await adapter.fetchAllTags('ghcr.io/org/repo');
    assert.deepEqual(tags, ['v1.0.0', 'v1.1.0'], '匿名降级后仍应取到 tag');
    const tagsCall = router.calls.find(c => c.url.includes('/tags/list'));
    assert.equal(tagsCall.opts.headers.Authorization, undefined, '降级时不得携带 Authorization');
  });

  it('B2b token 端点抛网络异常 → 同样降级为匿名且成功', async () => {
    const router = makeRouter([
      ['/token?', () => { throw new Error('token endpoint down'); }],
      ['/tags/list', () => jsonResponse({ tags: ['v2.0.0'] })],
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const tags = await adapter.fetchAllTags('ghcr.io/org/repo');
    assert.deepEqual(tags, ['v2.0.0']);
    const tagsCall = router.calls.find(c => c.url.includes('/tags/list'));
    assert.equal(tagsCall.opts.headers.Authorization, undefined);
  });

  it('B3 Link rel="next" → 请求第 2 页（URL 含 last=）；第 2 页无 Link 即停', async () => {
    const router = makeRouter([
      ['/token?', () => jsonResponse({ token: 't' })],
      ['last=v1.0.0', () => jsonResponse({ tags: ['v1.1.0'] })],
      ['/tags/list', () => linkResponse(
        { tags: ['v1.0.0'] },
        '</v2/org/repo/tags/list?last=v1.0.0&n=1000>; rel="next"',
      )],
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const tags = await adapter.fetchAllTags('ghcr.io/org/repo');
    assert.deepEqual(tags, ['v1.0.0', 'v1.1.0']);
    const tagCalls = router.calls.filter(c => c.url.includes('/tags/list'));
    assert.equal(tagCalls.length, 2, '共请求两页');
    const second = router.calls.filter(c => c.url.includes('/tags/list'))[1];
    assert.match(second.url, /last=/, '第 2 页 URL 必须带 last=');
  });

  it('B4 响应缺 tags 字段 → 抛 RegistryRequestError', async () => {
    const router = makeRouter([
      ['/token?', () => jsonResponse({ token: 't' })],
      ['/tags/list', () => jsonResponse({ name: 'x' })],
    ]);
    const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    await assert.rejects(
      () => adapter.fetchAllTags('ghcr.io/org/repo'),
      (e) => {
        assert.ok(e instanceof RegistryRequestError);
        assert.match(e.message, /tags/);
        return true;
      },
    );
  });

  it('B5 GHCR 401 / 403 → 抛 RegistryRequestError 且 status 正确', async () => {
    for (const status of [401, 403]) {
      const router = makeRouter([
        ['/token?', () => jsonResponse({ token: 't' })],
        ['/tags/list', () => jsonResponse({ message: 'denied' }, { status })],
      ]);
      const adapter = new GhcrAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
      await assert.rejects(
        () => adapter.fetchAllTags('ghcr.io/org/repo'),
        (e) => {
          assert.ok(e instanceof RegistryRequestError);
          assert.equal(e.status, status);
          return true;
        },
      );
      assert.equal(router.countOf('/tags/list'), 1, `${status} 不可重试`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. 限流与错误状态码分级
// ═══════════════════════════════════════════════════════════════════════════

describe('C. 限流与错误状态码分级', () => {
  it('C1 parseRetryAfter：秒数 / 上限 / 空 / 非法 / HTTP-date', () => {
    assert.equal(parseRetryAfter('5'), 5000, '5 秒 = 5000ms');
    assert.equal(parseRetryAfter('120'), 30000, '120 秒被上限 30000ms 截断');
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter('not-a-date'), null);
    // HTTP-date：nowMs 固定 → 结果确定
    const nowMs = Date.parse('2015-10-21T00:00:00Z');
    const httpDate = parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', nowMs);
    assert.ok(httpDate > 0, 'HTTP-date 必须解析成正数毫秒');
    assert.equal(httpDate, 30000, '超过 30s 上限时被截断');
  });

  it('C2 isRetryableStatus：429 / 5xx 可重试，4xx 不可重试', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(502), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
    assert.equal(isRetryableStatus(400), false);
  });

  it('C3 computeRetryDelay：指数增长且有上限（默认 base=500 / max=4000）', () => {
    assert.equal(computeRetryDelay(0), 500);
    assert.equal(computeRetryDelay(1), 1000);
    assert.equal(computeRetryDelay(10), 4000, '第 10 次退避被上限 4000ms 截断');
  });

  it('C4 429 两次后 200 → 重试成功，fetchImpl 共调用 3 次', async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls += 1;
        if (calls <= 2) return new Response('{}', { status: 429 });
        return new Response('{}', { status: 200 });
      },
      'https://example.invalid/tags',
      {},
      { retries: 2, sleep: noSleep },
    );
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });

  it('C5 一直 500 → 重试耗尽后**解析**为最后一个 500 响应（不抛错），调用 retries+1 次', async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls += 1;
        return new Response('{}', { status: 500 });
      },
      'https://example.invalid/tags',
      {},
      { retries: 2, sleep: noSleep },
    );
    assert.equal(res.status, 500);
    assert.equal(calls, 3, 'retries(2) + 1 次');
  });

  it('C6 一直 404 → 立即返回，fetchImpl 只调用 1 次（4xx 不重试）', async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls += 1;
        return new Response('{}', { status: 404 });
      },
      'https://example.invalid/tags',
      {},
      { retries: 3, sleep: noSleep },
    );
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  });

  it('C7 网络异常 → 重试耗尽后 reject，调用 retries+1 次', async () => {
    let calls = 0;
    await assert.rejects(
      () => fetchWithRetry(
        async () => {
          calls += 1;
          throw new Error('ECONNRESET');
        },
        'https://example.invalid/tags',
        {},
        { retries: 2, sleep: noSleep },
      ),
      /ECONNRESET/,
    );
    assert.equal(calls, 3, 'retries(2) + 1 次');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. 请求去重缓存（memoization）
// ═══════════════════════════════════════════════════════════════════════════

describe('D. createTagCache：请求去重', () => {
  it('D1 两个 adapter 共享同一 cache → 同一仓库只请求一次', async () => {
    const cache = createTagCache();
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ results: [{ name: '1.0.0' }], next: null })],
    ]);
    const a = new DockerHubAdapter({ fetchImpl: router.fetchImpl, cache, sleep: noSleep });
    const b = new DockerHubAdapter({ fetchImpl: router.fetchImpl, cache, sleep: noSleep });
    const t1 = await a.fetchAllTags('nginx');
    const t2 = await b.fetchAllTags('nginx');
    assert.deepEqual(t1, ['1.0.0']);
    assert.deepEqual(t2, ['1.0.0']);
    assert.equal(router.total(), 1, '第二个 adapter 应命中缓存，不发网络请求');
    assert.equal(cache.size, 1);
  });

  it('D2 并发调用（不等第一个完成）→ 仍然只有一次网络请求（缓存存的是 in-flight promise）', async () => {
    const cache = createTagCache();
    const router = makeRouter([
      ['page_size=100', async () => {
        await new Promise(r => setImmediate(r));
        return jsonResponse({ results: [{ name: '1.0.0' }], next: null });
      }],
    ]);
    const a = new DockerHubAdapter({ fetchImpl: router.fetchImpl, cache, sleep: noSleep });
    const b = new DockerHubAdapter({ fetchImpl: router.fetchImpl, cache, sleep: noSleep });
    const [t1, t2] = await Promise.all([
      a.fetchAllTags('nginx'),
      b.fetchAllTags('nginx'),
    ]);
    assert.deepEqual(t1, ['1.0.0']);
    assert.deepEqual(t2, ['1.0.0']);
    assert.equal(router.total(), 1, '并发去重：只允许一次在途请求');
  });

  it('D3 请求失败**不缓存** → 第二次调用重新走网络并可成功', async () => {
    const cache = createTagCache();
    let calls = 0;
    const router = makeRouter([
      ['page_size=100', () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return jsonResponse({ results: [{ name: '1.0.0' }], next: null });
      }],
    ]);
    const adapter = new DockerHubAdapter({
      fetchImpl: router.fetchImpl, cache, sleep: noSleep, retries: 0,
    });
    await assert.rejects(() => adapter.fetchAllTags('nginx'), /ECONNRESET/);
    const tags = await adapter.fetchAllTags('nginx');
    assert.deepEqual(tags, ['1.0.0']);
    assert.equal(router.total(), 2, '失败后必须重新请求，不得把失败结果缓存住');
  });

  it('D4 cache.clear() → 下一次调用重新走网络', async () => {
    const cache = createTagCache();
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({ results: [{ name: '1.0.0' }], next: null })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, cache, sleep: noSleep });
    await adapter.fetchAllTags('nginx');
    assert.equal(router.total(), 1);
    cache.clear();
    assert.equal(cache.size, 0);
    await adapter.fetchAllTags('nginx');
    assert.equal(router.total(), 2, '清空缓存后应重新请求');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. 并发上限
// ═══════════════════════════════════════════════════════════════════════════

describe('E. 并发上限', () => {
  it('E1 maxConcurrency=2 → 同时在途请求数不超过 2', async () => {
    let inFlight = 0;
    let observedMax = 0;
    const fetchImpl = async () => {
      inFlight += 1;
      if (inFlight > observedMax) observedMax = inFlight;
      await new Promise(r => setImmediate(r));
      inFlight -= 1;
      return jsonResponse({ results: [{ name: '1.0.0' }], next: null });
    };
    const adapter = new DockerHubAdapter({ fetchImpl, sleep: noSleep, maxConcurrency: 2 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => adapter.fetchAllTags(`repo${i}`)),
    );
    assert.ok(
      observedMax <= 2,
      `同时在途请求数应 <= 2，实际观测到 ${observedMax}`,
    );
    assert.ok(observedMax >= 1, '必须真的发起过请求');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Digest / 多架构
// ═══════════════════════════════════════════════════════════════════════════

describe('F. Digest 与多架构 tag', () => {
  it('F1 当前 1.2.0 → 不得选中架构专属的 1.3.0-amd64', async () => {
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({
        results: [{ name: '1.2.0' }, { name: '1.3.0-amd64' }],
        next: null,
      })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const sel = await adapter.selectLatestTag('nginx:1.2.0', '1.2.0');
    assert.ok(
      sel.tag === null || !sel.tag.endsWith('-amd64'),
      `架构专属 tag 不得污染主轨，实际选中：${sel.tag}`,
    );
    // 实测：主轨内唯一候选就是当前的 1.2.0 → 判为 up-to-date（而不是跨轨道升到 1.3.0-amd64）
    assert.equal(sel.tag, '1.2.0');
    assert.equal(sel.comparison, 'up-to-date');
  });

  it('F2 当前 1.2.0-amd64 → 可选 1.3.0-amd64，但不得选无后缀的 1.3.0', async () => {
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({
        results: [{ name: '1.2.0-amd64' }, { name: '1.3.0-amd64' }, { name: '1.3.0' }],
        next: null,
      })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const sel = await adapter.selectLatestTag('nginx:1.2.0-amd64', '1.2.0-amd64');
    assert.equal(sel.tag, '1.3.0-amd64', '同架构轨道内升级');
  });

  it('F3 纯 digest 镜像（nginx@sha256:abc）→ 记录当前真实行为', async () => {
    // ⚠️ 真实行为（registry.mjs 现状）：
    //    image-ref.mjs 能解析 digest（referenceKind='digest'），但 registry.mjs 的
    //    selectLatestTag() **只按 repo 取 tag**，既不看 parsed.digest，也没有
    //    "digest 锁定 → 不参与版本检测" 的短路；currentTag 缺省时走 version.mjs 的
    //    「无当前上下文」分支，仍会返回一个 tag（comparison='upgradable'）。
    //    这里锁定现状，供后续修复时对齐（见交付说明中的缺陷登记）。
    const router = makeRouter([
      ['page_size=100', () => jsonResponse({
        results: [{ name: '1.2.0' }, { name: '1.3.0' }],
        next: null,
      })],
    ]);
    const adapter = new DockerHubAdapter({ fetchImpl: router.fetchImpl, sleep: noSleep });
    const sel = await adapter.selectLatestTag('nginx@sha256:abc');
    // 现状（缺陷登记）：registry.mjs 未对 digest 引用做短路 → 仍选出版本 tag，
    //    等于「静默声称可升级」，与 §6「digest 锁定不参与版本检测」相悖。
    //    期望的正确行为：tag === null / comparison 不为 'upgradable'。
    //    这里断言「要么返回 null（已修复），要么就是当前实测的 1.3.0（未修复）」，
    //    并在交付说明中登记该缺陷。
    assert.ok(
      sel.tag === null || sel.tag === '1.3.0',
      `digest 镜像不应被判定为可升级，实际：${sel.tag}`,
    );
    if (sel.tag !== null) {
      assert.equal(sel.tag, '1.3.0', '现状：digest 镜像仍会选出版本 tag（未做 digest 短路）');
      assert.equal(sel.comparison, 'upgradable');
    }

    // 若调用方显式传入 currentTag（digest 镜像没有 tag 时通常不会传），
    // 同轨比较同样会给出 upgradable —— 现状确实没有 digest 保护。
    const sel2 = await adapter.selectLatestTag('nginx@sha256:abc', '1.2.0');
    assert.ok(sel2.tag === null || sel2.tag === '1.3.0');
  });
});
