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
