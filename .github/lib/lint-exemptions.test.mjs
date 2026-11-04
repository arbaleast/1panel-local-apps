// .github/lib/lint-exemptions.test.mjs
// 豁免机制回归测试。
//
// 锁死的不变量：
//   1. 缺 reason / 未知字段 / 未知 ruleId 一律编译失败（强制说明、防止拿进来乱写）；
//   2. 最小粒度匹配：version 省略 = 应用全部版本；version/value 填写逐级收窄；
//   3. 死亡条目必须被抓到（app 不存在 / ruleId 无对应 finding / version 不存在）；
//   4. 仓库真实豁免文件当前为空壳（样例注释不生效），全仓 finding 数不受豁免影响。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadExemptions,
  exemptionMatches,
  applyWaivers,
  findDeadExemptions,
  EXEMPTIONS_FILE,
} from './lint-exemptions.mjs';
import { RULE_IDS } from './consistency.mjs';

function mkRoot(entries) {
  const dir = join(tmpdir(), `exm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.github'), { recursive: true });
  if (entries !== null) {
    writeFileSync(join(dir, EXEMPTIONS_FILE), entries);
  }
  return dir;
}

test('豁免文件不存在 → 空清单，无错误', () => {
  const dir = mkRoot(null);
  try {
    const { list, schemaErrors, fileUsed } = loadExemptions(dir);
    assert.equal(list.length, 0);
    assert.equal(schemaErrors.length, 0);
    assert.equal(fileUsed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('完整合法条目 → 正常加载', () => {
  const yml = [
    'exemptions:',
    '  - app: linkwarden',
    '    ruleId: tag.dir',
    '    version: v1.56.1',
    '    reason: 目录名跟随 sidecar 节奏',
    '  - app: scrob',
    '    ruleId: var.undeclared',
    '    value: ${PANEL_APP_PORT_HTTP}',
    '    reason: 临时登记，版本目录补齐端口变量中',
    '',
  ].join('\n');
  const dir = mkRoot(yml);
  try {
    const { list, schemaErrors } = loadExemptions(dir);
    assert.deepEqual(schemaErrors, []);
    assert.equal(list.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('缺 reason / 未知字段 / 未知 ruleId / 完全重复 都报结构错误', () => {
  const yml = [
    'exemptions:',
    '  - app: foo',
    '    ruleId: tag.dir',
    '  - app: foo',
    '    ruleId: tag.dir',
    '    reason: '
    + '重复且缺 reason',
    '  - app: bar',
    '    ruleId: totally.fake',
    '    reason: r1',
    '  - app: baz',
    '    ruleId: tag.dir',
    '    reason: r2',
    '    note: 额外字段',
    '',
  ].join('\n');
  const dir = mkRoot(yml);
  try {
    const { schemaErrors } = loadExemptions(dir);
    const text = schemaErrors.join('\n');
    assert.match(text, /缺少必填项 reason/);
    assert.match(text, /未知 ruleId="totally\.fake"/);
    assert.match(text, /未知字段 note/);
    assert.match(text, /完全重复/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('最小粒度匹配：应用级豁免覆盖全部版本，版本级豁免仅命中该版本', () => {
  const entry = { app: 'scrob', ruleId: 'var.undeclared', reason: 'r' };
  assert.equal(exemptionMatches(entry, { app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', actual: 'x' }), true);
  assert.equal(exemptionMatches(entry, { app: 'scrob', ruleId: 'var.undeclared', version: null, actual: 'x' }), true);
  const versioned = { ...entry, version: '2.37.0' };
  assert.equal(exemptionMatches(versioned, { app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', actual: 'x' }), true);
  assert.equal(exemptionMatches(versioned, { app: 'scrob', ruleId: 'var.undeclared', version: '2.36.0', actual: 'x' }), false);
  assert.equal(exemptionMatches(versioned, { app: 'scrob', ruleId: 'var.undeclared', version: null, actual: 'x' }), false);
  assert.equal(exemptionMatches(versioned, { app: 'other', ruleId: 'var.undeclared', version: '2.37.0', actual: 'x' }), false);
  assert.equal(exemptionMatches(versioned, { app: 'scrob', ruleId: 'port.orphan', version: '2.37.0', actual: 'x' }), false);
  const val = { ...entry, value: '${X}' };
  assert.equal(exemptionMatches(val, { app: 'scrob', ruleId: 'var.undeclared', version: null, actual: '${X}' }), true);
  assert.equal(exemptionMatches(val, { app: 'scrob', ruleId: 'var.undeclared', version: null, actual: '${Y}' }), false);
  // value + version 同时收窄：两者都命中才豁免
  const narrow = { ...entry, version: '2.37.0', value: '${X}' };
  assert.equal(exemptionMatches(narrow, { app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', actual: '${X}' }), true);
  assert.equal(exemptionMatches(narrow, { app: 'scrob', ruleId: 'var.undeclared', version: '2.36.0', actual: '${X}' }), false);
  assert.equal(exemptionMatches(narrow, { app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', actual: '${Y}' }), false);
});

test('applyWaivers 返回 active / waived 两侧, 被豁免条目带 waivedBy', () => {
  const list = [{ app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', reason: 'r' }];
  const findings = [
    { app: 'scrob', ruleId: 'var.undeclared', version: '2.37.0', actual: 'a1' },
    { app: 'scrob', ruleId: 'var.undeclared', version: '2.36.0', actual: 'a2' },
    { app: 'traefik', ruleId: 'volume.path', version: '3.6.6', actual: 'a3' },
  ];
  const { active, waived } = applyWaivers(findings, list);
  assert.equal(active.length, 2);
  assert.equal(waived.length, 1);
  assert.equal(waived[0].waivedBy.reason, 'r');
});

test('findDeadExemptions 抓住三类死亡', () => {
  const list = [
    { app: 'ghost', ruleId: 'tag.dir', reason: 'r1' },
    { app: 'anirss', ruleId: 'port.orphan', version: 'v3.2.99', reason: 'r2' },
    { app: 'traefik', ruleId: 'volume.path', reason: 'r3' },
  ];
  const observed = new Map([
    ['anirss', new Map([['port.orphan', new Set(['v3.2.13'])]])],
    ['traefik', new Map([['volume.path', new Set(['**VALUE**'])]])],
  ]);
  const dead = findDeadExemptions(list, observed);
  assert.deepEqual(dead.map((d) => d.entry.reason), ['r1', 'r2']);
});

test('仓库真实豁免文件：schema 合法、必填键齐全、ruleId 已知，且关键条目在位', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  assert.ok(existsSync(join(root, EXEMPTIONS_FILE)), '豁免文件应已创建');
  const { list, schemaErrors } = loadExemptions(root);
  assert.deepEqual(schemaErrors, []);
  assert.ok(list.length >= 1, '存量豁免条目应已登记');
  for (const e of list) {
    assert.ok(e.app && e.ruleId && e.reason, '每条必须有 app/ruleId/reason: ' + JSON.stringify(e));
    assert.ok(e.reason.length >= 12, 'reason 须为有信息量的说明（≥12 字符）: ' + e.app + '/' + e.ruleId);
  }
  // 抽查三个代表性条目：可选项豁免 / 版本级最小粒度 / 基础设施路径
  assert.ok(list.some((e) => e.app === 'searxng' && e.ruleId === 'form.orphan'), 'searxng REDIS_URL 可选项应豁免');
  assert.ok(list.some((e) => e.app === 'gecoos' && e.ruleId === 'port.orphan' && e.version === 'v2.2'), 'gecoos 端口豁免应为 v2.2 版本级');
  assert.ok(list.some((e) => e.app === 'traefik' && e.ruleId === 'volume.path'), 'traefik 宿主机路径应豁免');
});
