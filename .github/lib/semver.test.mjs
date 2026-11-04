// lib/semver.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSemver,
  compareSemver,
  isValidSemver,
  isSemver,
  parse,
  compare,
  compareVersionsLoose,
  isStable,
  pickLatest,
  pickNewestVersionDir,
} from './semver.mjs';

describe('parseSemver — 严格 SemVer 2.0.0', () => {
  it('解析标准三段版本', () => {
    const r = parseSemver('1.2.3');
    assert.deepEqual(r, {
      major: 1, minor: 2, patch: 3, prerelease: [], build: [], raw: '1.2.3',
    });
  });

  it('允许单个前导 v / V', () => {
    assert.equal(parseSemver('v1.2.3').major, 1);
    assert.equal(parseSemver('V1.2.3').minor, 2);
    // 两个前缀非法
    assert.equal(parseSemver('vv1.2.3'), null);
  });

  it('解析 prerelease 与 build', () => {
    const r = parseSemver('1.2.3-rc.1+build.5');
    assert.deepEqual(r.prerelease, ['rc', '1']);
    assert.deepEqual(r.build, ['build', '5']);
  });

  it('parseSemver("1.2.0-rc.1") 返回 prerelease 标识符数组', () => {
    const r = parseSemver('1.2.0-rc.1');
    assert.equal(r.major, 1);
    assert.equal(r.minor, 2);
    assert.equal(r.patch, 0);
    assert.deepEqual(r.prerelease, ['rc', '1']);
    assert.deepEqual(r.build, []);
    assert.equal(r.raw, '1.2.0-rc.1');
  });

  it('parseSemver("v1.2.0+build.5") 解析 build metadata', () => {
    const r = parseSemver('v1.2.0+build.5');
    assert.deepEqual(r.build, ['build', '5']);
    assert.deepEqual(r.prerelease, []);
  });

  it('解析架构后缀形态 prerelease（arm32v7 / pg18-trixie）', () => {
    assert.deepEqual(parseSemver('v3.2.29-arm32v7').prerelease, ['arm32v7']);
    assert.deepEqual(parseSemver('0.8.7-pg18-trixie').prerelease, ['pg18-trixie']);
  });

  it('禁止前导零', () => {
    assert.equal(parseSemver('01.2.3'), null);
    assert.equal(parseSemver('1.02.3'), null);
    assert.equal(parseSemver('1.2.03'), null);
    assert.equal(parseSemver('0.0.0').major, 0);
  });

  it('禁止 prerelease 数字标识符前导零', () => {
    assert.equal(parseSemver('1.2.3-rc.01'), null);
    assert.equal(parseSemver('1.2.3-01'), null);
  });

  it('非法输入一律 null', () => {
    const invalid = [
      '', 'latest', 'nightly', 'dev', 'edge', 'main', 'master',
      '1', '1.2', '1.2.3.4', '26.04.5.1.1',
      '2026091410-arm64', '20220121', '2024.08',
      'full-v1.12.2-arm64', 'a2b-stable-25-08-12',
      '1.2.3-', '1.2.3+', 'v', 'server-cuda12-v0.4.1',
    ];
    for (const v of invalid) {
      assert.equal(parseSemver(v), null, `expected null for ${JSON.stringify(v)}`);
    }
    assert.equal(parseSemver(undefined), null);
    assert.equal(parseSemver(null), null);
    assert.equal(parseSemver(123), null);
  });
});

describe('isValidSemver / isSemver — 严格 SemVer 判定', () => {
  it('合法形态返回 true', () => {
    assert.equal(isValidSemver('1.2.3'), true);
    assert.equal(isValidSemver('v1.2.0'), true);
    assert.equal(isValidSemver('1.2.0-rc.1'), true);
    assert.equal(isValidSemver('1.2.3+build.5'), true);
  });

  it('非法形态返回 false', () => {
    assert.equal(isValidSemver('1.2'), false);
    assert.equal(isValidSemver('1.2.3.4'), false);
    assert.equal(isValidSemver('latest'), false);
    assert.equal(isValidSemver('2024.08'), false);
    assert.equal(isValidSemver('1.2.3-'), false);
    assert.equal(isValidSemver('01.2.3'), false);
  });

  it('isSemver 是 isValidSemver 的别名', () => {
    assert.equal(isSemver('1.2.3'), true);
    assert.equal(isSemver('v1.2.3-rc.1'), true);
    assert.equal(isSemver('2026091410-arm64'), false);
    assert.equal(isSemver('latest'), false);
  });
});

describe('compareSemver — SemVer 优先级', () => {
  it('主次修订号逐级比较', () => {
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
    assert.equal(compareSemver('1.2.0', '1.3.0'), -1);
    assert.equal(compareSemver('1.2.4', '1.2.4'), 0);
    assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  });

  it('prerelease 低于同版本正式版', () => {
    assert.equal(compareSemver('1.2.0-rc.1', '1.2.0'), -1);
    assert.equal(compareSemver('1.2.0', '1.2.0-rc.1'), 1);
    assert.equal(compareSemver('1.2.0-rc.1', '1.2.0-rc.2'), -1);
    assert.equal(compareSemver('1.2.0-beta', '1.2.0-rc.1'), -1);
  });

  it('prerelease 标识符按 SemVer 规则排序', () => {
    // 标识符更多者优先级更高
    assert.equal(compareSemver('1.2.0-alpha', '1.2.0-alpha.1'), -1);
    // 数字标识符优先级低于字母数字标识符
    assert.equal(compareSemver('1.2.0-alpha.1', '1.2.0-alpha.beta'), -1);
    // 数字标识符按数值比较：rc.2 < rc.10
    assert.equal(compareSemver('1.2.0-rc.2', '1.2.0-rc.10'), -1);
  });

  it('build metadata 不参与比较', () => {
    assert.equal(compareSemver('1.2.3+a', '1.2.3+b'), 0);
    assert.equal(compareSemver('1.2.3+sha.abc', '1.2.3+sha.def'), 0);
  });

  it('接受 parseSemver 的结果对象', () => {
    assert.equal(compareSemver(parseSemver('1.2.0-rc.2'), parseSemver('1.2.0-rc.1')), 1);
    assert.equal(compareSemver(parseSemver('1.2.0'), '1.2.0'), 0);
  });

  it('任一参数非法时抛 TypeError', () => {
    assert.throws(() => compareSemver('latest', '1.0.0'), TypeError);
    assert.throws(() => compareSemver('1.0.0', 'nightly'), TypeError);
    assert.throws(() => compareSemver('1.0', '1.0.0'), TypeError);
    assert.throws(() => compareSemver('2026091410-arm64', '1.0.0'), TypeError);
  });
});

describe('parse — 宽松数字段解析', () => {
  it('不含数字的输入返回 null（不再被当成 0.0.0）', () => {
    // 核心修复：latest / nightly / dev 以前会解析成 [0]，等于 0.0.0
    assert.equal(parse('latest'), null);
    assert.equal(parse('nightly'), null);
    assert.equal(parse('dev'), null);
    assert.equal(parse('edge'), null);
    assert.equal(parse('alpha'), null);
    assert.equal(parse('beta'), null);
    assert.equal(parse('rc'), null);
    assert.equal(parse('main'), null);
    assert.equal(parse('master'), null);
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
    assert.equal(parse(undefined), null);
    assert.equal(parse(123), null);
  });

  it('标准版本按点分段', () => {
    assert.deepEqual(parse('v1.2.3'), [1, 2, 3]);
    assert.deepEqual(parse('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parse('v3.2.29-arm32v7'), [3, 2, 29]);
  });

  it('日期型 / 混合型版本目录保持历史数字段语义', () => {
    assert.deepEqual(parse('2026091410-arm64'), [2026091410]);
    assert.deepEqual(parse('2026.9.7-3e454637f'), [2026, 9, 7]);
    assert.deepEqual(parse('a2b-stable-25-08-12'), [0]);
  });

  it('含数字但分段非数字时保持宽松语义（非数字段按 0）', () => {
    assert.deepEqual(parse('server-cuda12-v0.4.1'), [0, 4, 1]);
  });
});

describe('compare — 宽松逐段比较（null 安全）', () => {
  it('非版本排在最低位', () => {
    assert.ok(compare('latest', '1.0.0') < 0);
    assert.ok(compare('1.0.0', 'latest') > 0);
  });

  it('两侧都不是版本时视为相等', () => {
    assert.equal(compare('latest', 'nightly'), 0);
    assert.equal(compare('dev', 'edge'), 0);
  });

  it('缺位补 0', () => {
    assert.equal(compare('1.0.0', '1.0.0.0'), 0);
    assert.ok(compare('1.2.0', '1.2.1') < 0);
    assert.ok(compare('2026.8.4-c63835bd2', '2026.7.1') > 0);
    assert.ok(compare('server-cuda12-v0.4.1', '0.4.2') < 0);
  });
});

describe('compareVersionsLoose — 宽松数字段比较（非 SemVer）', () => {
  it('逐段数值比较，缺位补 0', () => {
    // 缺位补 0 → '1.2.0' 与 '1.2' 相等
    assert.equal(compareVersionsLoose('1.2.0', '1.2'), 0);
    assert.ok(compareVersionsLoose('1.3.0', '1.2') > 0);
    assert.ok(compareVersionsLoose('1.0.0', '1.0.0.0') === 0);
    assert.ok(compareVersionsLoose('2026.8.4-c63835bd2', '2026.7.1') > 0);
  });

  it('无数字段按 0 段处理且不抛错', () => {
    assert.equal(compareVersionsLoose('beta', 'cu124'), 0);
    assert.equal(compareVersionsLoose('latest', 'nightly'), 0);
  });

  it('parse 与旧语义一致（剥 v 前缀与 -/+ 之后部分）', () => {
    assert.deepEqual(parse('v3.2.29-arm32v7'), [3, 2, 29]);
    assert.deepEqual(parse('2026091410-arm64'), [2026091410]);
    assert.deepEqual(parse('a2b-stable-25-08-12'), [0]);
  });
});

describe('isStable — 不稳定关键字黑名单', () => {
  it('latest / nightly / dev / edge / alpha / beta / rc / main / master 判为不稳定', () => {
    for (const v of ['latest', 'NIGHTLY', 'dev', 'edge', 'alpha', 'beta', 'rc', 'main', 'master']) {
      assert.equal(isStable(v), false, `expected unstable: ${v}`);
    }
  });

  it('普通版本号与 prerelease 形态判为稳定', () => {
    assert.equal(isStable('v1.0.0-alpha'), true);
    assert.equal(isStable('1.2.3'), true);
    assert.equal(isStable('v3.2.29-arm32v7'), true);
  });
});

describe('pickLatest — 分层选型', () => {
  it('空列表 / 空数组返回 null', () => {
    assert.equal(pickLatest([]), null);
    assert.equal(pickLatest(null), null);
    assert.equal(pickLatest(undefined), null);
    assert.equal(pickLatest(['']), null);
  });

  it('纯 SemVer 候选按优先级取最大', () => {
    assert.equal(pickLatest(['v3.2.5', 'v3.2.4', '3.2.6']), '3.2.6');
    assert.equal(pickLatest(['v3.7.17', 'v3.6.6', '3.0.3']), 'v3.7.17');
  });

  it('prerelease 低于正式版', () => {
    assert.equal(pickLatest(['1.2.3-rc1', '1.2.3', '1.2.3-beta']), '1.2.3');
    assert.equal(pickLatest(['1.2.0-rc.1', '1.2.0-rc.2', '1.2.0']), '1.2.0');
  });

  it('纯 prerelease 组内按 SemVer 优先级取最大', () => {
    assert.equal(pickLatest(['1.2.0-rc.1', '1.2.0-rc.2']), '1.2.0-rc.2');
    // 数字 prerelease 标识符按数值比较（不是字典序）
    assert.equal(pickLatest(['1.2.0-rc.10', '1.2.0-rc.2']), '1.2.0-rc.10');
  });

  it('build metadata 相同优先级时按字典序取大者（确定性）', () => {
    assert.equal(pickLatest(['1.2.3+sha.abc', '1.2.3+sha.def']), '1.2.3+sha.def');
  });

  it('架构后缀形态按 prerelease 语义比较（同后缀组内按数字基比较）', () => {
    assert.equal(pickLatest(['v3.2.18-arm32v7', 'v3.2.29-arm32v7']), 'v3.2.29-arm32v7');
  });

  it('latest / nightly / dev 不得被当作 0.0.0 选出去', () => {
    // ⚠️ 行为变更（audit task 4）：以前 parse('nightly') 返回 [0]，
    //    pickLatest(['nightly','dev']) 会返回 'nightly'（等于把 0.0.0 当成最新版本）。
    //    现在不含数字的 tag 一律不是版本，直接返回 null。
    assert.equal(pickLatest(['nightly', 'dev']), null);
    assert.equal(pickLatest(['latest']), null);
    assert.equal(pickLatest(['latest', 'nightly', 'dev', 'edge']), null);
    // 混合列表里非版本条目被忽略
    assert.equal(pickLatest(['latest', 'nightly', '1.2.3']), '1.2.3');
  });

  it('混合形态时优先纯 SemVer 候选（server-cuda12-v0.4.1 < 0.4.2）', () => {
    assert.equal(pickLatest(['server-cuda12-v0.4.1', '0.4.2', '0.4.1']), '0.4.2');
  });

  it('collabora 多段数字版本：纯 semver 优先层生效', () => {
    // '26.04.5.1.1' 不是三段纯 semver → 被第一优先层排除，
    // 结果取三段纯 semver 中的最大者（与 registry.mjs 的“同段数收敛”互补）。
    assert.equal(pickLatest(['2.1.5', '26.04.5.1.1']), '2.1.5');
    // 同为多段数字时按宽松数字段比较
    assert.equal(pickLatest(['26.04.5.1.1', '26.04.5.2.1']), '26.04.5.2.1');
  });

  it('数字核心形态：宽松数字段比较', () => {
    assert.equal(pickLatest(['pg-1.16.0', 'pg-1.16.1']), 'pg-1.16.1');
    assert.equal(pickLatest(['260919', '260919-28c46a116']), '260919-28c46a116');
    assert.equal(pickLatest(['v2.2', 'v2.3']), 'v2.3');
  });

  it('日期型 tag 在无纯 SemVer 候选时按数字核心比较', () => {
    assert.equal(pickLatest(['20220121', '260919']), '20220121');
  });
});

describe('pickNewestVersionDir — 版本目录选择', () => {
  it('空输入返回 null', () => {
    assert.equal(pickNewestVersionDir([]), null);
    assert.equal(pickNewestVersionDir(null), null);
  });

  it('严格 SemVer 目录取最大', () => {
    assert.equal(pickNewestVersionDir(['v1.0.0', 'v2.0.0', 'v1.5.0']), 'v2.0.0');
    assert.equal(pickNewestVersionDir(['1.0.0', '1.2.0', '1.10.0']), '1.10.0');
  });

  it('存在 SemVer 目录时绝不把日期型目录当 SemVer（jellyfin 场景）', () => {
    assert.equal(
      pickNewestVersionDir(['10.11.11', '2026081705-arm64', '2026091410-arm64']),
      '10.11.11',
    );
  });

  it('无 SemVer 目录时用 v?数字 开头的目录做宽松比较', () => {
    assert.equal(pickNewestVersionDir(['20220121', '260919']), '20220121');
    assert.equal(pickNewestVersionDir(['26.04.5.1.1', '26.04.5.2.1']), '26.04.5.2.1');
    assert.equal(pickNewestVersionDir(['2.91.01', '3.04.00', '3.00.00']), '3.04.00');
  });

  it('既非 SemVer 又不以数字开头的目录 → null', () => {
    assert.equal(pickNewestVersionDir(['beta', 'cu124']), null);
    assert.equal(pickNewestVersionDir(['RELEASE.2026-08']), null);
    assert.equal(pickNewestVersionDir(['a2b-latest', 'a2b-stable-25-08-12']), null);
  });

  it('latest / 自定义 tag 不会被当作 SemVer', () => {
    assert.equal(pickNewestVersionDir(['latest', 'v1.0.0']), 'v1.0.0');
    assert.equal(pickNewestVersionDir(['latest']), null);
  });

  // tier-1 tie-break：候选集只保留严格 SemVer 目录，但内部改用「旧归档口径」选最大
  it('tier-1 并列时取字典序最大的变体后缀目录（handbrake 形态）', () => {
    assert.equal(
      pickNewestVersionDir(['1.11.2', '1.11.2-ls36', '1.11.2-ls41']),
      '1.11.2-ls41',
    );
  });

  it('tier-1 并列时取字典序最大的变体后缀目录（losslesscut 形态）', () => {
    assert.equal(pickNewestVersionDir(['3.64.0', '3.64.0-v1']), '3.64.0-v1');
  });

  it('tier-1 数值不同时仍取数值最大者', () => {
    assert.equal(
      pickNewestVersionDir(['v3.2.54', 'v3.2.53', 'v3.2.53-arm32v7']),
      'v3.2.54',
    );
    assert.equal(
      pickNewestVersionDir(['v3.2.53', 'v3.2.53-arm32v7']),
      'v3.2.53-arm32v7',
    );
  });

  it('tier-1 放宽的是「目录归档口径」，不是 SemVer 判定本身', () => {
    // 1.11.2-ls41 在 SemVer 里仍是合法的 prerelease 版本
    const p = parseSemver('1.11.2-ls41');
    assert.notEqual(p, null);
    assert.deepEqual(p.prerelease, ['ls41']);
    // 但 SemVer 优先级上 prerelease 低于正式版 —— 两者不矛盾：
    // 目录选择用的是归档口径，SemVer 判定本身未被放宽
    assert.equal(compareSemver('1.11.2-ls41', '1.11.2'), -1);
    assert.equal(pickNewestVersionDir(['1.11.2', '1.11.2-ls41']), '1.11.2-ls41');
  });
});
