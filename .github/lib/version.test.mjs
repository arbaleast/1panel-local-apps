// lib/version.test.mjs — 统一版本引擎（分类器 / 轨道 / 比较 / 选型）单元测试
//
// 覆盖目标 §十 的第 7、8、9、10、12 类场景：
//   7. 标准 SemVer 排序与两段式版本比较
//   8. Pre-release 优先级与"禁止从正式版误升预发布版"
//   9. Build Metadata（+build.1 vs +build.2）不触发误更新
//   10. 非标准版本（CalVer / 变体后缀 -alpine 同轨保护 / Commit SHA 过滤）
//   12. 无法识别版本或疑似降级时的安全拦截（Fail-Safe）
//
// 纯离线：不发起任何网络请求。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMES,
  COMPARISON_RESULTS,
  NON_VERSION_TAGS,
  classifyVersion,
  classifySuffix,
  compareVersions,
  sameTrack,
  selectCandidate,
  splitVariantPrefix,
  parseCalverDate,
  isVersionShapedTag,
  isVersionShapedDir,
  isNonVersionTag,
  normalizeVersionToken,
  pickNewestVersionDir,
  compareVersionsLooseNumeric,
} from './version.mjs';

// ---------------------------------------------------------------------------
// §7 标准 SemVer 排序
// ---------------------------------------------------------------------------
describe('version：标准 SemVer 排序', () => {
  it('基础版本序列严格递增（1.10.0 必须大于 1.2.0，不能按字典序）', () => {
    const chain = ['1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 1; i < chain.length; i++) {
      assert.equal(compareVersions(chain[i - 1], chain[i]), -1,
        `${chain[i - 1]} 应小于 ${chain[i]}`);
      assert.equal(compareVersions(chain[i], chain[i - 1]), 1);
    }
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1, '1.10.0 > 1.2.0（数值比较）');
    assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  });

  it('相同版本比较为 0（且与比较顺序无关）', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  });

  it('v / V 前缀归一化后与无前缀等价，但保留原始写法', () => {
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('V1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('v1.2.0', '1.2.1'), -1);
    const c = classifyVersion('v3.2.13');
    assert.equal(c.original, 'v3.2.13', '原始 Tag 格式必须保留（供回写）');
    assert.equal(c.scheme, SCHEMES.SEMVER);
  });

  it('两段式版本：自成一轨，与三段式**不可比**（严禁混排）', () => {
    const c = classifyVersion('2.2');
    assert.equal(c.segmentCount, 2);
    assert.equal(c.track, 'num:2');
    assert.equal(compareVersions('2.2', '2.3'), -1, '两段式之间可比较');
    assert.equal(compareVersions('2.3', '2.2'), 1);
    assert.equal(compareVersions('2.2', '2.2.0'), null, '两段式与三段式必须不可比');
    assert.equal(sameTrack('2.2', '2.3'), true);
    assert.equal(sameTrack('2.2', '2.2.0'), false);
  });

  it('多段数字版本按段数自成一轨（collabora 存量特例）', () => {
    assert.equal(classifyVersion('26.04.5.1.1').segmentCount, 5);
    assert.equal(classifyVersion('26.04.5.1.1').track, 'num:5');
    assert.equal(compareVersions('26.04.5.1.1', '26.04.5.2.1'), -1);
    assert.equal(compareVersions('26.04.5.1.1', '2.1.5'), null, '段数不同 → 不可比');
  });

  it('前导零版本（tdarr 存量特例）归一化后同轨可比较', () => {
    const c = classifyVersion('3.06.00');
    assert.equal(c.comparable, true);
    assert.equal(c.track, 'num:3');
    assert.equal(compareVersions('3.00.00', '3.06.00'), -1);
    assert.equal(compareVersions('3.06.00', '3.06.00'), 0);
  });
});

// ---------------------------------------------------------------------------
// §8 Pre-release 优先级
// ---------------------------------------------------------------------------
describe('version：Pre-release 优先级', () => {
  it('alpha < beta < rc < 正式版', () => {
    const chain = ['1.2.0-alpha.1', '1.2.0-beta.1', '1.2.0-rc.1', '1.2.0'];
    for (let i = 1; i < chain.length; i++) {
      assert.equal(compareVersions(chain[i - 1], chain[i]), -1,
        `${chain[i - 1]} 应小于 ${chain[i]}`);
    }
    assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1, '正式版高于同号预发布版');
  });

  it('预发布标识符按 SemVer 规则比较', () => {
    assert.equal(compareVersions('1.2.0-alpha', '1.2.0-alpha.1'), -1);
    assert.equal(compareVersions('1.2.0-alpha.1', '1.2.0-alpha.beta'), -1);
    assert.equal(compareVersions('1.2.0-rc.2', '1.2.0-rc.10'), -1);
  });

  it('正式版**不得**升级到预发布版（目标 §四.1 变体同轨保护）', () => {
    // 当前版本本身在候选里 → 结论是「已是最新」，预发布候选一个都没被选中
    const r = selectCandidate('1.2.0', ['1.2.0', '2.0.0-rc.1', '1.3.0-beta']);
    assert.equal(r.tag, '1.2.0', '预发布候选必须被拒绝');
    assert.equal(r.comparison, COMPARISON_RESULTS.UP_TO_DATE);
    // 当前版本不在候选里 → 同轨道没有合法候选 → 明确拒绝
    const r2 = selectCandidate('1.2.0', ['2.0.0-rc.1']);
    assert.equal(r2.tag, null);
    assert.equal(r2.comparison, COMPARISON_RESULTS.INCOMPATIBLE);
  });

  it('预发布当前可以升级到对应正式版（rc.40 → 1.0.0）', () => {
    const r = selectCandidate('v1.0.0-rc.40', ['v1.0.0-rc.40', 'v1.0.0', 'v0.13.2']);
    assert.equal(r.tag, 'v1.0.0');
    assert.equal(r.comparison, COMPARISON_RESULTS.UPGRADABLE);
  });

  it('预发布与正式版同轨（rc 不是"变体"）', () => {
    const pre = classifyVersion('v1.0.0-rc.40');
    const rel = classifyVersion('v1.0.0');
    assert.equal(pre.variant, null, 'rc.40 不应被当成变体后缀');
    assert.equal(pre.prerelease.join('.'), 'rc.40');
    assert.equal(pre.track, rel.track);
  });

  it('后缀分类：纯数字 / 预发布关键词 → prerelease，其余 → variant', () => {
    assert.equal(classifySuffix('1').kind, 'prerelease');
    assert.equal(classifySuffix('rc.40').kind, 'prerelease');
    assert.equal(classifySuffix('alpha.1').kind, 'prerelease');
    assert.equal(classifySuffix('alpine').kind, 'variant');
    assert.equal(classifySuffix('alpine3.19').kind, 'variant');
    assert.equal(classifySuffix('ls36').kind, 'variant');
    assert.equal(classifySuffix('arm32v7').kind, 'variant');
    assert.equal(classifySuffix('pg18-trixie').kind, 'variant');
    assert.equal(classifySuffix('1-ls224').kind, 'variant');
  });
});

// ---------------------------------------------------------------------------
// §9 Build Metadata 无关性
// ---------------------------------------------------------------------------
describe('version：Build Metadata 无关性', () => {
  it('compareVersions 把 +build.1 与 +build.2 视为相等', () => {
    assert.equal(compareVersions('1.2.0+build.1', '1.2.0+build.2'), 0);
    assert.equal(compareVersions('1.2.0+build.2', '1.2.0+build.1'), 0);
  });

  it('构建元数据差异**不得**触发升级（回归测试：旧实现会误报）', () => {
    const r = selectCandidate('1.2.0+build.1', ['1.2.0+build.1', '1.2.0+build.2']);
    assert.equal(r.comparison, COMPARISON_RESULTS.UP_TO_DATE);
    assert.equal(r.tag, '1.2.0+build.1', '必须回到当前版本，不能选 build.2');
  });

  it('构建元数据不参与选型排序（多候选时也不应被 build 大小左右）', () => {
    const r = selectCandidate('1.2.0', ['1.2.0+build.1', '1.2.0+build.2']);
    assert.equal(r.comparison, COMPARISON_RESULTS.UP_TO_DATE);
  });
});

// ---------------------------------------------------------------------------
// §10 非标准版本
// ---------------------------------------------------------------------------
describe('version：CalVer 与变体后缀', () => {
  it('多种 CalVer 形态都被识别为 calver 方案', () => {
    for (const tag of ['2026.11.04', '2026-11-04', '20261104', '2026081705', '260919', '20220121']) {
      const c = classifyVersion(tag);
      assert.ok(c, `无法分类: ${tag}`);
      assert.equal(c.scheme, SCHEMES.CALVER, `${tag} 应为 calver`);
      assert.equal(c.track, 'calver');
      assert.equal(c.comparable, true);
    }
  });

  it('CalVer 按日期比较（跨月跨年）', () => {
    assert.equal(compareVersions('2026.10.19', '2026.11.2'), -1);
    assert.equal(compareVersions('2026.11.2', '2026.10.19'), 1);
    assert.equal(compareVersions('2026.9.30', '2026.10.2'), -1);
    assert.equal(compareVersions('260919', '20220121'), 1, 'YYMMDD 应折算到 20xx');
  });

  it('CalVer 的提交号后缀不参与轨道与比较（searxng 存量特例）', () => {
    const a = classifyVersion('2026.10.19-d47cb96bf');
    const b = classifyVersion('2026.11.2-d138f443b');
    assert.equal(a.track, b.track, '不同 SHA 必须同轨，否则永远无法升级');
    assert.equal(compareVersions(a, b), -1);
    const r = selectCandidate('2026.10.19-d47cb96bf', ['2026.10.19-d47cb96bf', '2026.11.2-d138f443b']);
    assert.equal(r.tag, '2026.11.2-d138f443b');
  });

  it('CalVer 与 SemVer **不可比**（严禁把 8 位日期当主版本号混排）', () => {
    assert.equal(compareVersions('2026.10.19', '1.2.0'), null);
    assert.equal(compareVersions('20240501', '1.2.0'), null);
    assert.equal(sameTrack('2026.10.19', '1.2.0'), false);
  });

  it('parseCalverDate 拒绝非法日期与非法长度', () => {
    assert.equal(parseCalverDate('20261301'), null, '13 月非法');
    assert.equal(parseCalverDate('20260132'), null, '32 日非法');
    assert.equal(parseCalverDate('202601'), null, '6 位且月份非法时不是 CalVer');
    assert.equal(parseCalverDate('1.2.3'), null);
    assert.ok(parseCalverDate('20261104'));
  });

  it('变体后缀被识别为 variant 方案，且后缀不同即不同轨', () => {
    const cases = [
      ['1.2.3-alpine', 'alpine'],
      ['1.2.3-alpine3.19', 'alpine3.19'],
      ['1.2.3-bookworm', 'bookworm'],
      ['1.2.3-slim', 'slim'],
      ['1.11.2-ls36', 'ls36'],
      ['0.8.6-pg18-trixie', 'pg18-trixie'],
      ['3.64.0-v1', 'v1'],
      ['v3.2.13-arm32v7', 'arm32v7'],
      ['v1.19.0-unprivileged', 'unprivileged'],
    ];
    for (const [tag, variant] of cases) {
      const c = classifyVersion(tag);
      assert.equal(c.scheme, SCHEMES.VARIANT, `${tag} 应为 variant-semver`);
      assert.equal(c.variant, variant, `${tag} 的变体后缀不符`);
    }
    assert.equal(sameTrack('1.2.3-alpine', '1.2.3-alpine3.19'), false);
    assert.equal(sameTrack('1.2.3-alpine', '1.3.0-alpine'), true);
  });

  it('变体同轨保护：只允许同后缀轨道内升级', () => {
    const r = selectCandidate('1.2.0-alpine', ['1.2.0', '1.3.0', '1.3.0-alpine', '1.3.0-slim']);
    assert.equal(r.tag, '1.3.0-alpine');
    assert.equal(r.comparison, COMPARISON_RESULTS.UPGRADABLE);
  });

  it('主轨不得吸收变体候选（严禁跨轨道升级到 -alpine / -slim / -amd64）', () => {
    for (const candidate of ['1.3.0-alpine', '1.3.0-slim', '1.3.0-amd64', '1.3.0-arm64v8']) {
      // 当前版本在候选里 → 结论是「已是最新」，变体候选一个都没被选中
      const r = selectCandidate('1.2.0', ['1.2.0', candidate]);
      assert.equal(r.tag, '1.2.0', `${candidate} 不得被主轨选中`);
      assert.equal(r.comparison, COMPARISON_RESULTS.UP_TO_DATE);
      // 当前版本不在候选里 → 同轨道没有合法候选 → 明确拒绝
      const r2 = selectCandidate('1.2.0', [candidate]);
      assert.equal(r2.tag, null, `${candidate} 不得被主轨选中`);
      assert.equal(r2.comparison, COMPARISON_RESULTS.INCOMPATIBLE);
    }
  });

  it('变体前缀形态（pg-1.16.0 / server-cuda12-v0.4.1）自成一轨', () => {
    assert.equal(classifyVersion('pg-1.16.0').prefix, 'pg');
    assert.equal(classifyVersion('server-cuda12-v0.4.1').prefix, 'server-cuda12');
    assert.equal(sameTrack('server-cuda12-v0.4.1', 'server-vulkan-v0.4.9'), false);
    const r = selectCandidate('server-cuda12-v0.4.1', ['server-cuda12-v0.4.1', 'server-vulkan-v0.4.9']);
    assert.equal(r.tag, 'server-cuda12-v0.4.1', '不得跳到 vulkan 轨道');
  });

  it('splitVariantPrefix 只在右侧可解析为版本时才切分', () => {
    assert.deepEqual(splitVariantPrefix('pg-1.16.0'), { prefix: 'pg', rest: '1.16.0' });
    assert.equal(splitVariantPrefix('latest'), null);
    assert.equal(splitVariantPrefix('1.2.3'), null);
  });
});

// ---------------------------------------------------------------------------
// §12 Fail-Safe：不可识别 / 不可比较 / 疑似降级
// ---------------------------------------------------------------------------
describe('version：Fail-Safe 安全拦截', () => {
  it('滚动 / 分支 tag 不可比较', () => {
    for (const tag of ['latest', 'stable', 'nightly', 'edge', 'dev', 'main', 'master', 'alpha', 'beta', 'rc']) {
      const c = classifyVersion(tag);
      assert.ok(c, `无法分类: ${tag}`);
      assert.equal(c.comparable, false, `${tag} 不可比较`);
      assert.equal(c.scheme, SCHEMES.ROLLING);
      assert.ok(c.reason && c.reason.length > 0, `${tag} 必须给出原因`);
    }
    const r = selectCandidate('latest', ['1.0.0', '2.0.0']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, COMPARISON_RESULTS.UNCOMPARABLE);
  });

  it('带前缀的滚动 tag（a2b-latest / gpu-amd-latest）同样不可比较', () => {
    for (const tag of ['a2b-latest', 'gpu-amd-latest', 'gpu-nvidia-latest']) {
      const c = classifyVersion(tag);
      assert.equal(c.comparable, false, `${tag} 不可比较`);
      assert.equal(c.scheme, SCHEMES.ROLLING);
    }
  });

  it('Commit SHA 形态不可比较（严禁截数字强转）', () => {
    for (const tag of ['sha-abcdef1', 'a1b2c3d', 'deadbeef', '0123456789abcdef']) {
      const c = classifyVersion(tag);
      assert.equal(c.comparable, false, `${tag} 不可比较`);
      assert.ok(c.reason && c.reason.length > 0);
    }
  });

  it('候选低于当前 → 拒绝（禁止未授权降级）', () => {
    // 当前版本不在候选里 → 唯一候选比当前低 → 必须拒绝
    const r = selectCandidate('2.0.0', ['1.9.9']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, COMPARISON_RESULTS.INCOMPATIBLE);
    assert.ok(r.reason.includes('降级'));
    // 当前版本在候选里 → 正常判为「已是最新」
    const r2 = selectCandidate('2.0.0', ['2.0.0', '1.9.9']);
    assert.equal(r2.tag, '2.0.0');
    assert.equal(r2.comparison, COMPARISON_RESULTS.UP_TO_DATE);
  });

  it('上游没有同轨道候选 → incompatible（而不是随便挑一个）', () => {
    const r = selectCandidate('1.2.3-alpine', ['1.2.3', '2.0.0']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, COMPARISON_RESULTS.INCOMPATIBLE);
  });

  it('无法识别的当前 tag → uncomparable 且给出原因', () => {
    const r = selectCandidate('!!!not-a-version!!!', ['1.0.0']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, COMPARISON_RESULTS.UNCOMPARABLE);
    assert.ok(r.reason.length > 0);
  });

  it('classifyVersion 对非法输入返回 null', () => {
    assert.equal(classifyVersion(null), null);
    assert.equal(classifyVersion(undefined), null);
    assert.equal(classifyVersion(123), null);
    assert.equal(classifyVersion(''), null);
    assert.equal(classifyVersion('   '), null);
  });
});

// ---------------------------------------------------------------------------
// 无上下文选型（向后兼容的旧契约）
// ---------------------------------------------------------------------------
describe('version：无当前版本上下文的选型', () => {
  it('无 currentTag 时只在单一轨道内取最大', () => {
    const r = selectCandidate(null, ['v1.2.3', '1.2.3', 'v1.2.4']);
    assert.equal(r.tag, 'v1.2.4');
  });

  it('无 currentTag 且候选全是滚动 tag → uncomparable', () => {
    const r = selectCandidate(null, ['latest', 'nightly']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, COMPARISON_RESULTS.UNCOMPARABLE);
  });

  it('裸变体前缀当前（pg）→ 在同前缀的版本化 tag 里取最大', () => {
    const r = selectCandidate('pg', ['latest', 'pg', 'pg-1.15.0', 'pg-1.16.0', '1.16.0']);
    assert.equal(r.tag, 'pg-1.16.0');
    assert.equal(r.comparison, COMPARISON_RESULTS.UPGRADABLE);
  });

  it('裸变体前缀没有版本化候选 → 保持不变', () => {
    const r = selectCandidate('pg', ['latest', 'pg', '1.16.0']);
    assert.equal(r.tag, 'pg');
    assert.equal(r.comparison, COMPARISON_RESULTS.UP_TO_DATE);
  });
});

// ---------------------------------------------------------------------------
// lint 侧：形态判定与目录归一化
// ---------------------------------------------------------------------------
describe('version：lint 侧形态判定（保持既有语义）', () => {
  it('isVersionShapedTag 接受合法的非标准形态', () => {
    for (const tag of ['16-alpine', '3-management', '3.00.00', '2.2', 'a2b-stable-25-08-12',
      '1.11.2-ls41', '0.8.6-pg18-trixie', '2026.9.7-3e454637f', '26.04.5.1.1', '260919']) {
      assert.equal(isVersionShapedTag(tag), true, `${tag} 应被认可为版本形态`);
    }
  });

  it('isVersionShapedTag 拒绝浮动词与无数字噪声', () => {
    for (const tag of ['latest', 'nightly', 'dev', 'edge', 'not-a-version', '']) {
      assert.equal(isVersionShapedTag(tag), false, `${tag} 不应被认可为版本形态`);
    }
    assert.equal(isNonVersionTag('LATEST'), true);
    assert.equal(NON_VERSION_TAGS.has('stable'), true);
  });

  it('normalizeVersionToken 剥离 v 前缀与变体尾巴', () => {
    assert.equal(normalizeVersionToken('v1.56.1'), '1.56.1');
    assert.equal(normalizeVersionToken('1.11.2-ls41'), '1.11.2');
    assert.equal(normalizeVersionToken('1.2.3-alpine'), '1.2.3');
    assert.equal(normalizeVersionToken('pg-1.16.0'), '1.16.0');
    assert.equal(normalizeVersionToken('RELEASE.2026-08-01'), '2026-08-01');
  });

  it('isVersionShapedDir 判定版本目录准入', () => {
    assert.equal(isVersionShapedDir('v1.56.1'), true);
    assert.equal(isVersionShapedDir('1.11.2-ls36'), true);
    assert.equal(isVersionShapedDir('beta'), false);
    assert.equal(isVersionShapedDir('a2b-stable-25-08-12'), false);
  });
});

// ---------------------------------------------------------------------------
// 版本目录选型（两种口径）
// ---------------------------------------------------------------------------
describe('version：版本目录选型', () => {
  it('strict 口径：存在严格 SemVer 目录时只在该集合里选', () => {
    assert.equal(pickNewestVersionDir(['2.1.5', '26.04.5.1.1']), '2.1.5');
    assert.equal(pickNewestVersionDir(['10.11.11', '2026081705-arm64', '2026091410-arm64']), '10.11.11');
  });

  it('archive 口径：全候选按数字段比较（README「当前版本」口径，行为不变）', () => {
    assert.equal(pickNewestVersionDir(['2.1.5', '26.04.5.1.1'], 'archive'), '26.04.5.1.1');
    assert.equal(pickNewestVersionDir(['10.11.11', '2026081705-arm64', '2026091410-arm64'], 'archive'),
      '2026091410-arm64');
  });

  it('两种口径在同一集合上确实不同（说明这是两套**显式命名**的口径）', () => {
    const dirs = ['2.1.5', '26.04.5.1.1'];
    assert.notEqual(pickNewestVersionDir(dirs), pickNewestVersionDir(dirs, 'archive'));
  });

  it('空输入返回 null', () => {
    assert.equal(pickNewestVersionDir([]), null);
    assert.equal(pickNewestVersionDir(null), null);
    assert.equal(pickNewestVersionDir(['beta', 'cu124']), null, 'strict 口径下无数字目录 → null');
  });

  it('compareVersionsLooseNumeric 语义与宽松比较一致（缺位补 0）', () => {
    assert.equal(compareVersionsLooseNumeric('1.2.0', '1.2'), 0);
    assert.ok(compareVersionsLooseNumeric('1.3.0', '1.2') > 0);
    assert.equal(compareVersionsLooseNumeric('1.0.0', '1.0.0.0'), 0);
  });
});
