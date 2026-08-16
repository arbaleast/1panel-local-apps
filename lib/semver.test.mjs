// lib/semver.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, compare, isStable, pickLatest } from './semver.mjs';

describe('semver', () => {
  // 1. pre-release 排序：1.2.3-rc1, 1.2.3-beta, 1.2.3 → 1.2.3 胜出
  it('pre-release sorted below stable', () => {
    const r = pickLatest(['1.2.3-rc1', '1.2.3', '1.2.3-beta']);
    assert.equal(r, '1.2.3');
  });

  // 2. build metadata：1.2.3+sha.abc vs 1.2.3+sha.def，按字典序取末位
  // 自然 sort 末位 = 字典序最大者 + 原序末位稳定保留
  it('build metadata uses lexical fallback', () => {
    const r = pickLatest(['1.2.3+sha.abc', '1.2.3+sha.def']);
    assert.equal(r, '1.2.3+sha.def');
  });

  // 3. date-based tag：2026.8.4-c63835bd2 > 2026.7.1
  it('date-based tag comparison', () => {
    assert.ok(compare('2026.8.4-c63835bd2', '2026.7.1') > 0);
  });

  // 4. v 前缀：v3.2.5, v3.2.4, 3.2.6 → 3.2.6 胜出
  it('v prefix stripped during sort', () => {
    const r = pickLatest(['v3.2.5', 'v3.2.4', '3.2.6']);
    assert.equal(r, '3.2.6');
  });

  // 5. 混合场景：server-cuda12-v0.4.1 < 0.4.2；pickLatest 选 0.4.2
  it('mixed versioning picks pure semver over complex tags', () => {
    assert.ok(compare('server-cuda12-v0.4.1', '0.4.2') < 0);
    const r = pickLatest(['server-cuda12-v0.4.1', '0.4.2', '0.4.1']);
    assert.equal(r, '0.4.2');
  });

  // 6. 空数组返回 null
  it('empty list returns null', () => {
    assert.equal(pickLatest([]), null);
  });

  // 7. 全非 semver：非 semver 回退到字典序末位 = 字典序最大者
  it('non-semver falls back to lexical = nightly', () => {
    const r = pickLatest(['nightly', 'dev']);
    assert.equal(r, 'nightly');
  });

  // 8. isStable：latest/nightly → false；v1.0.0-alpha → true（第一段是 1）
  it('isStable detects unstable keywords', () => {
    assert.equal(isStable('latest'), false);
    assert.equal(isStable('nightly'), false);
    assert.equal(isStable('v1.0.0-alpha'), true);
  });

  // 9. compare 边界：1.0.0 vs 1.0.0.0 相等
  it('compare handles different segment counts', () => {
    assert.equal(compare('1.0.0', '1.0.0.0'), 0);
  });
});
