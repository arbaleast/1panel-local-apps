// .github/lib/detect-updates.test.mjs
// 覆盖 .github/scripts/detect-updates.mjs 中导出的纯函数：
// - shouldSkipAutoUpdate: 白名单早返回依赖此函数
// - parseCliArgs: CLI 参数解析（--dry-run / --help / --verbose / 位置参数）
// 强耦合 APPS_DIR/REPO_ROOT 的 processApp/main 不便直测。
//
// 注意：parseCliArgs 会修改模块顶层 processOptions（设 DRY_RUN/HELP/VERBOSE 标志）。
// 这是设计选择（避免每次调用传 opts），但意味着测试只能验证"不抛错"与"返回值"，
// 跨 case 的状态泄漏由模块本身保证（CLI 入口只调用一次）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipAutoUpdate, parseCliArgs } from '../scripts/detect-updates.mjs';

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

describe('parseCliArgs', () => {
  // 6. --dry-run / -n 不抛错
  it('--dry-run: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--dry-run']));
  });

  it('-n 短名等价于 --dry-run', () => {
    assert.doesNotThrow(() => parseCliArgs(['-n']));
  });

  // 7. --help / -h
  it('--help: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--help']));
  });

  it('-h 短名不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['-h']));
  });

  // 8. --verbose / -v
  it('--verbose: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--verbose']));
  });

  it('-v 短名不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['-v']));
  });

  // 9. 未知 flag 抛错（不静默吞错）
  it('未知 flag 抛错', () => {
    assert.throws(
      () => parseCliArgs(['--no-such-flag']),
      /未知参数/,
    );
  });

  // 10. 位置参数收集
  it('位置参数: 收集到 positional 数组', () => {
    const { positional } = parseCliArgs(['bookorbit', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });

  // 11. 位置参数与 flag 混合
  it('位置参数 + flag 混合: 分离正确', () => {
    const { positional } = parseCliArgs(['bookorbit', '--dry-run', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });

  // 12. 空参数
  it('空参数: 返回空 positional', () => {
    const { positional } = parseCliArgs([]);
    assert.deepEqual(positional, []);
  });

  // 13. 短名组合（真实使用: `node detect-updates.mjs -n bookorbit`）
  it('短名 + 位置参数: 完整命令模拟', () => {
    const { positional } = parseCliArgs(['-n', 'bookorbit', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });
});
