// lib/decision.test.mjs — 更新决策引擎（decision.mjs）契约测试
//
// 覆盖目标：
//   §1 字段契约（恒为 9 个字段）
//   §2 铁律 L1：shouldUpdate 只由 comparisonResult === 'upgradable' 推导
//   §3~§9 各判定分支（可升级 / 已是最新 / 构建元数据 / 不兼容 / 浮动 tag /
//        不可识别 / digest 锁定 / Registry 故障 / 无 tag）
//   §10 isSameUpdateTrack 更新轨道判定
//   §11 真实仓库 P0/P1 回归（postgres / rabbitmq / pgvector / photopea）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideUpdate,
  createDecisionResult,
  isSameUpdateTrack,
  COMPARISON_RESULTS,
  SCHEMES,
} from './decision.mjs';

/** §七 JSON 契约的 9 个字段 */
const CONTRACT_KEYS = [
  'appKey',
  'currentImage',
  'currentVersion',
  'candidateVersion',
  'versionScheme',
  'comparisonResult',
  'shouldUpdate',
  'reason',
  'source',
];

describe('§1 字段契约 — Decision Result 恒为 9 个字段', () => {
  it('decideUpdate 返回且仅返回契约规定的 9 个字段', () => {
    const d = decideUpdate({
      appKey: 'traefik',
      currentImage: 'ghcr.io/traefik/traefik:v3.6.6',
      candidates: ['v3.6.6', 'v3.7.17'],
      source: 'ghcr',
    });
    assert.deepEqual(Object.keys(d).sort(), [...CONTRACT_KEYS].sort());
  });

  it('createDecisionResult 返回且仅返回契约规定的 9 个字段', () => {
    const d = createDecisionResult({ appKey: 'x', comparisonResult: COMPARISON_RESULTS.UP_TO_DATE });
    assert.deepEqual(Object.keys(d).sort(), [...CONTRACT_KEYS].sort());
  });

  it('字段契约在各分支下均成立（错误 / 浮动 / digest）', () => {
    const inputs = [
      { currentImage: 'nginx:latest', candidates: ['1.0.0'] },
      { currentImage: 'nginx:1.0.0', candidates: [], error: new Error('boom') },
      { currentImage: 'nginx:1.0.0@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1', candidates: ['2.0.0'] },
      { currentImage: 'nginx', candidates: ['1.0.0'] },
    ];
    for (const input of inputs) {
      assert.deepEqual(Object.keys(decideUpdate(input)).sort(), [...CONTRACT_KEYS].sort());
    }
  });
});

describe('§2 铁律 L1 — shouldUpdate 只由 comparisonResult 推导', () => {
  it('五种 comparisonResult 的 shouldUpdate 布尔值完全匹配', () => {
    const table = [
      ['upgradable', true],
      ['up-to-date', false],
      ['incompatible', false],
      ['uncomparable', false],
      ['error', false],
    ];
    for (const [comparisonResult, expected] of table) {
      const d = createDecisionResult({ comparisonResult });
      assert.equal(d.comparisonResult, comparisonResult);
      assert.equal(d.shouldUpdate, expected, `${comparisonResult} → shouldUpdate 应为 ${expected}`);
    }
  });

  it('createDecisionResult({ comparisonResult: "upgradable" }).shouldUpdate === true', () => {
    assert.equal(createDecisionResult({ comparisonResult: 'upgradable' }).shouldUpdate, true);
  });

  it('构造器忽略外部强行指定的 shouldUpdate（自行推导）', () => {
    // 危险诱惑：incompatible 却声称可升级 —— 构造器必须无视
    const forced = createDecisionResult({ comparisonResult: 'incompatible', shouldUpdate: true });
    assert.equal(forced.shouldUpdate, false);
    // 反向同样成立
    const suppressed = createDecisionResult({ comparisonResult: 'upgradable', shouldUpdate: false });
    assert.equal(suppressed.shouldUpdate, true);
  });

  it('decideUpdate 产出的 shouldUpdate 与 comparisonResult 一致', () => {
    const inputs = [
      { currentImage: 'nginx:1.0.0', candidates: ['2.0.0'] },
      { currentImage: 'nginx:1.0.0', candidates: ['1.0.0'] },
      { currentImage: 'nginx:1.0.0', candidates: ['2.0.0-alpine'] },
      { currentImage: 'nginx:latest', candidates: ['1.0.0'] },
      { currentImage: 'nginx:1.0.0', candidates: [], error: new Error('x') },
    ];
    for (const input of inputs) {
      const d = decideUpdate(input);
      assert.equal(d.shouldUpdate, d.comparisonResult === 'upgradable');
    }
  });

  it('导出枚举值与文档一致', () => {
    assert.deepEqual(Object.values(COMPARISON_RESULTS).sort(), [
      'error', 'incompatible', 'un-comparable-placeholder', 'uncomparable', 'up-to-date', 'upgradable',
    ].filter((v) => v !== 'un-comparable-placeholder').sort());
    assert.equal(SCHEMES.SEMVER, 'semver');
    assert.equal(SCHEMES.CALVER, 'calver');
    assert.equal(SCHEMES.VARIANT, 'variant-semver');
    assert.equal(SCHEMES.PINNED_DIGEST, 'pinned-digest');
    assert.equal(SCHEMES.ROLLING, 'rolling-tag');
    assert.equal(SCHEMES.UNKNOWN, 'unknown');
  });
});

describe('§3 可升级路径（happy path）', () => {
  it('traefik v3.6.6 → v3.7.17 判定为 upgradable', () => {
    const d = decideUpdate({
      appKey: 'traefik',
      currentImage: 'ghcr.io/traefik/traefik:v3.6.6',
      candidates: ['v3.6.6', 'v3.7.17'],
      source: 'ghcr',
    });
    assert.equal(d.comparisonResult, 'upgradable');
    assert.equal(d.shouldUpdate, true);
    assert.equal(d.candidateVersion, 'v3.7.17');
    assert.equal(d.currentVersion, 'v3.6.6');
    assert.equal(d.versionScheme, 'semver');
    assert.equal(d.source, 'ghcr');
    assert.equal(d.appKey, 'traefik');
    assert.equal(typeof d.reason, 'string');
    assert.ok(d.reason.length > 0, 'reason 必须是非空的可读字符串');
  });
});

describe('§4 已是最新（up-to-date）', () => {
  it('版本相同 → up-to-date 且不更新', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.2.0', candidates: ['1.2.0'] });
    assert.equal(d.comparisonResult, 'up-to-date');
    assert.equal(d.shouldUpdate, false);
  });

  it('候选集合中含更高版本时仍会选中更高版本', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.2.0', candidates: ['1.2.0', '1.3.0'] });
    assert.equal(d.comparisonResult, 'upgradable');
    assert.equal(d.candidateVersion, '1.3.0');
  });
});

describe('§5 构建元数据不触发升级', () => {
  it('1.2.0+build.1 与 1.2.0+build.2 视为同一版本', () => {
    const d = decideUpdate({
      currentImage: 'nginx:1.2.0+build.1',
      candidates: ['1.2.0+build.1', '1.2.0+build.2'],
    });
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.comparisonResult, 'up-to-date');
  });
});

describe('§6 不兼容（跨变体 / 跨方案）', () => {
  it('1.2.0 对 1.3.0-alpine：跨变体 → incompatible', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.2.0', candidates: ['1.3.0-alpine'] });
    assert.equal(d.comparisonResult, 'incompatible');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.candidateVersion, null);
    assert.ok(d.reason.length > 0);
  });

  it('1.2.0 对纯 CalVer 候选：跨方案 → incompatible', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.2.0', candidates: ['2026.10.19'] });
    assert.equal(d.comparisonResult, 'incompatible');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.candidateVersion, null);
    assert.ok(d.reason.length > 0);
  });

  it('1.2.0 对纯架构候选：跨变体 → incompatible', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.2.0', candidates: ['1.3.0-amd64'] });
    assert.equal(d.comparisonResult, 'incompatible');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.candidateVersion, null);
    assert.ok(d.reason.length > 0);
  });
});

describe('§7 浮动 tag（uncomparable）', () => {
  it('latest → rolling-tag / uncomparable', () => {
    const d = decideUpdate({ currentImage: 'nginx:latest', candidates: ['1.0.0', '2.0.0'] });
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.versionScheme, 'rolling-tag');
  });

  it('stable → rolling-tag / uncomparable', () => {
    const d = decideUpdate({ currentImage: 'nginx:stable', candidates: ['1.0.0', '2.0.0'] });
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.versionScheme, 'rolling-tag');
  });
});

describe('§8 不可识别的 tag', () => {
  it('提交号形态 tag → uncomparable', () => {
    const d = decideUpdate({ currentImage: 'nginx:sha-abcdef1', candidates: ['1.0.0', '2.0.0'] });
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
    assert.ok(d.reason.length > 0);
  });
});

describe('§9 digest 锁定', () => {
  it('带 tag 的 digest 镜像 → pinned-digest / uncomparable', () => {
    const d = decideUpdate({
      currentImage: 'nginx:1.0.0@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1',
      candidates: ['1.0.0', '2.0.0'],
    });
    assert.equal(d.versionScheme, 'pinned-digest');
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
  });

  it('纯 digest 镜像（无 tag）→ 不可比较且不更新', () => {
    const d = decideUpdate({
      currentImage: 'nginx@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1',
      candidates: ['1.0.0', '2.0.0'],
    });
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.candidateVersion, null);
    assert.ok(d.reason.length > 0);
  });
});

describe('§10 错误分级（绝不冒充"无更新"）', () => {
  it('Registry 故障 → error，且 reason 携带原始信息', () => {
    const d = decideUpdate({
      currentImage: 'nginx:1.0.0',
      candidates: [],
      error: new Error('DockerHub 返回 HTTP 500'),
    });
    assert.equal(d.comparisonResult, 'error');
    assert.equal(d.shouldUpdate, false);
    assert.ok(d.reason.includes('DockerHub 返回 HTTP 500'), `reason 应包含原始报错：${d.reason}`);
  });

  it('Registry 故障绝不能被报告为 up-to-date', () => {
    const d = decideUpdate({
      currentImage: 'nginx:1.0.0',
      candidates: ['1.0.0'],
      error: new Error('HTTP 500'),
    });
    assert.notEqual(d.comparisonResult, 'up-to-date');
  });

  it('字符串形式的错误同样被分级为 error', () => {
    const d = decideUpdate({ currentImage: 'nginx:1.0.0', candidates: [], error: 'timeout' });
    assert.equal(d.comparisonResult, 'error');
    assert.ok(d.reason.includes('timeout'));
  });
});

describe('§11 无 tag 的镜像', () => {
  it('nginx（无 tag）→ uncomparable / candidateVersion 为 null', () => {
    const d = decideUpdate({ currentImage: 'nginx', candidates: ['1.0.0'] });
    assert.equal(d.comparisonResult, 'uncomparable');
    assert.equal(d.shouldUpdate, false);
    assert.equal(d.candidateVersion, null);
    assert.ok(d.reason.length > 0);
  });
});

describe('§12 isSameUpdateTrack — 更新轨道判定', () => {
  it('同形态跨大版本属于同一轨道', () => {
    assert.equal(isSameUpdateTrack('1.2.0', '2.0.0'), true);
  });

  it('变体不同 → 不同轨道', () => {
    assert.equal(isSameUpdateTrack('1.2.0', '1.2.0-alpine'), false);
  });

  it('SemVer 与 CalVer → 不同轨道', () => {
    assert.equal(isSameUpdateTrack('1.2.0', '2026.10.19'), false);
  });

  it('浮动 tag 与版本号 → 不同轨道', () => {
    assert.equal(isSameUpdateTrack('latest', '1.0.0'), false);
  });
});

describe('§13 真实仓库回归（P0/P1 已修 Bug）', () => {
  it('postgres:16-alpine 不得选到 9.6.24', () => {
    const d = decideUpdate({
      currentImage: 'postgres:16-alpine',
      currentTag: '16-alpine',
      candidates: ['17-alpine', '16-alpine', '9.6.24', '16.3-alpine'],
    });
    assert.notEqual(d.candidateVersion, '9.6.24');
    assert.ok(
      ['upgradable', 'uncomparable', 'incompatible'].includes(d.comparisonResult),
      `不应出现其它结论，实际为 ${d.comparisonResult}`,
    );
    if (d.comparisonResult === 'upgradable') {
      assert.equal(d.candidateVersion, '17-alpine');
      assert.equal(d.shouldUpdate, true);
    }
  });

  it('rabbitmq:3-management 不得选到 3.13.7', () => {
    const d = decideUpdate({
      currentImage: 'rabbitmq:3-management',
      currentTag: '3-management',
      candidates: ['4-management', '3-management', '3.13.7'],
    });
    assert.notEqual(d.candidateVersion, '3.13.7');
    assert.ok(
      ['upgradable', 'uncomparable', 'incompatible'].includes(d.comparisonResult),
      `不应出现其它结论，实际为 ${d.comparisonResult}`,
    );
    if (d.comparisonResult === 'upgradable') {
      assert.equal(d.candidateVersion, '4-management');
      assert.equal(d.shouldUpdate, true);
    }
  });

  it('pgvector 变体被保留：0.8.7-pg18-trixie', () => {
    const d = decideUpdate({
      currentImage: 'pgvector/pgvector:0.8.6-pg18-trixie',
      candidates: ['0.8.6-pg18-trixie', '0.8.7-pg18-trixie', '0.9.0'],
    });
    assert.equal(d.candidateVersion, '0.8.7-pg18-trixie');
    assert.equal(d.comparisonResult, 'upgradable');
    assert.equal(d.shouldUpdate, true);
  });

  it('photopea:2.2 不得降级到 2.1.0', () => {
    const d = decideUpdate({
      currentImage: 'photopea:2.2',
      currentTag: '2.2',
      candidates: ['2.1.0', '2.2', '2.3'],
    });
    assert.notEqual(d.candidateVersion, '2.1.0');
    if (d.comparisonResult === 'upgradable') {
      assert.equal(d.candidateVersion, '2.3');
      assert.equal(d.shouldUpdate, true);
    }
  });
});
