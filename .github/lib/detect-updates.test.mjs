// .github/lib/detect-updates.test.mjs
// 覆盖 .github/scripts/detect-updates.mjs 中导出的纯函数 shouldSkipAutoUpdate
// （白名单早返回依赖此函数，processApp 本身强耦合 APPS_DIR/REPO_ROOT，不便直测）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipAutoUpdate } from '../scripts/detect-updates.mjs';

describe('detect-updates 白名单', () => {
  // 1. 白名单内应用 → true（被跳过）
  it('shouldSkipAutoUpdate: anythingllm 在白名单中 → true', () => {
    assert.equal(shouldSkipAutoUpdate('anythingllm'), true);
  });

  // 2. 已知非白名单应用 → false（正常走 detect）
  it('shouldSkipAutoUpdate: anirss 不在白名单 → false', () => {
    assert.equal(shouldSkipAutoUpdate('anirss'), false);
  });

  // 3. 完全不存在的应用名 → false
  it('shouldSkipAutoUpdate: 不存在的应用名 → false', () => {
    assert.equal(shouldSkipAutoUpdate('nonexistent-app-xyz'), false);
  });

  // 4. 大小写敏感：白名单是小写 'anythingllm'，大写不命中
  it('shouldSkipAutoUpdate: 大小写敏感，AnythingLLM 不命中', () => {
    assert.equal(shouldSkipAutoUpdate('AnythingLLM'), false);
    assert.equal(shouldSkipAutoUpdate('ANYTHINGLLM'), false);
  });

  // 5. 空字符串 / 特殊字符 → false（不应抛错或误命中）
  it('shouldSkipAutoUpdate: 空字符串/特殊字符不命中', () => {
    assert.equal(shouldSkipAutoUpdate(''), false);
    assert.equal(shouldSkipAutoUpdate(' '), false);
    assert.equal(shouldSkipAutoUpdate('anythingllm-extra'), false);
    assert.equal(shouldSkipAutoUpdate('preanythingllm'), false);
  });
});
