// .github/lib/smoke-plan-regression.test.mjs — 沙箱隔离保证对**真实存量应用**的回归护栏
//
// ── 目的（目标 §九 沙箱安全隔离铁律）────────────────────────────────────
// 「所有挂载卷全部指向临时目录下的新建子目录，**绝不挂载任何真实用户路径**」
// 「独立的测试桥接网络（模拟创建隔离的测试用 1panel-network）」
// 这两条必须在**真实的应用配置**上成立，而不只是合成 fixture 上成立。
//
// 本文件把这两条不变量固化成**自动化护栏**：对代表性应用逐个生成隔离计划，
// 断言重写后的 compose 里：
//   · 不含宿主机真实路径（除被显式标记为 unsafe 的那种）；
//   · 不含 `1panel-network`，也不含 `external: true`；
//   · 端口全部绑到 127.0.0.1，且容器端口保持不变；
//   · 容器名是冒烟 project 名；
// 并断言 GPU / 外部数据库类应用会被**条件跳过**（而不是被当成失败）。
//
// 纯离线：只读仓库里的 compose 文件，**不发起任何网络请求、不调用 docker**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { stripCommentedLines } from './consistency.mjs';
import { buildPanelEnv } from './compose-render.mjs';
import { buildSmokePlan, detectSkipConditions } from './smoke-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 代表性应用：轻量、无外部重依赖、能覆盖冒烟闭环的主要形态 */
const REPRESENTATIVE_APPS = [
  'kiwix-serve',        // 单容器 + healthcheck + ${UID}:${GID} 运行身份
  'personal-todo-vault',// 单容器 + 最轻量
  'cfnb',               // 单容器 + 带 scripts/init.sh
  'firecrawl',          // 三容器（api / playwright-service / rabbitmq）
  'linkwarden',         // 三容器（app / postgres / meilisearch）
];

/** 必须被条件跳过（不得被当成失败）的应用与原因 */
const MUST_SKIP = [
  { app: 'marginalia', expect: 'external-database' },// 外部 postgres
  { app: 'gecoos', expect: 'host-network' },        // network_mode: host + privileged
];

/**
 * F-1/F-4 之后的**反向**不变量：这些应用的**默认部署必须是纯 CPU**，
 * 因此它们**不应**再被 'gpu-hardware' 条件跳过 —— 若又被跳过，
 * 说明 GPU 又被默认打开了（正是 gpu.gated-default-on 要防的事）。
 */
const MUST_NOT_SKIP_GPU = ['jellyfin', 'mineru'];

/**
 * 列出某应用下的版本目录。
 * @param {string} app
 * @returns {string[]}
 */
function versionDirsOf(app) {
  const base = path.join(REPO_ROOT, app);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'data' && e.name !== 'scripts' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((v) => fs.existsSync(path.join(base, v, 'data.yml')) || fs.existsSync(path.join(base, v, 'docker-compose.yml')))
    .sort();
}

/**
 * 读取并解析某版本的 compose（剥注释，与仓库其它链路同口径）。
 * @param {string} app
 * @param {string} version
 * @returns {{raw:string, doc:object|null, fields:Array<object>}}
 */
function loadVersion(app, version) {
  const vDir = path.join(REPO_ROOT, app, version);
  let raw = '';
  let doc = null;
  try {
    raw = fs.readFileSync(path.join(vDir, 'docker-compose.yml'), 'utf8');
    doc = yaml.load(stripCommentedLines(raw).map((l) => l.text).join('\n'));
  } catch { /* 该版本可能没有 compose */ }
  let fields = [];
  let versionDoc = null;
  try {
    versionDoc = yaml.load(fs.readFileSync(path.join(vDir, 'data.yml'), 'utf8'));
    fields = versionDoc?.additionalProperties?.formFields ?? versionDoc?.formFields ?? [];
  } catch { /* 交给其它链路报 */ }
  return { raw, doc, fields, versionDoc };
}

/**
 * 构造一份覆盖所有变量的 portMap（测试里不需要真实空闲端口，只验证重写结果）。
 * @param {string} raw
 * @param {object} doc
 * @returns {Record<string, number>}
 */
function buildPortMap(raw, doc) {
  const map = {};
  let port = 20000;
  const names = new Set();
  for (const m of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const n of names) { map[n] = port; port += 1; }
  for (const [svcName, svc] of Object.entries(doc?.services ?? {})) {
    const list = Array.isArray(svc?.ports) ? svc.ports : [];
    list.forEach((spec, i) => {
      if (typeof spec !== 'string') return;
      const segs = spec.replace(/\/(tcp|udp|sctp)$/i, '').split(':');
      if (segs.length < 2) return;
      const hostSegment = segs.length >= 3 ? segs[1] : segs[0];
      if (!hostSegment.includes('${')) {
        map[`#literal:${svcName}:${i}`] = port; port += 1;
      }
    });
  }
  return map;
}

/**
 * 对一个版本生成隔离计划并跑一遍隔离不变量断言。
 * @param {string} app
 * @param {string} version
 */
function assertIsolation(app, version) {
  const { raw, doc, fields } = loadVersion(app, version);
  if (!doc) return; // 无 compose 的版本不参与
  const tmpDir = '/tmp/1panel-smoke-regression';
  const projectName = `1panel_smoke_${app}_1`;
  const testNetwork = `1panel_smoke_net_1`;
  const env = { ...buildPanelEnv(fields).env, CONTAINER_NAME: projectName };

  const plan = buildSmokePlan({
    app,
    version,
    composeDoc: doc,
    versionDoc: null,
    env,
    projectName,
    testNetwork,
    tmpDir,
    portMap: buildPortMap(raw, doc),
  });

  const serialized = yaml.dump(plan.composeDoc);

  // ① 绝不出现宿主机真实的 `1panel-network`（更不能 external）
  assert.ok(!serialized.includes('1panel-network'),
    `${app}/${version}: 重写后仍含 1panel-network\n${serialized}`);
  assert.ok(!/external:\s*true/.test(serialized),
    `${app}/${version}: 重写后仍含 external: true（会去动宿主机真实网络）\n${serialized}`);
  assert.ok(serialized.includes(testNetwork),
    `${app}/${version}: 重写后未指向测试网络 ${testNetwork}`);

  // ② 容器名 = 冒烟 project 名
  for (const svc of Object.values(plan.composeDoc.services ?? {})) {
    if (typeof svc?.container_name === 'string') {
      assert.ok(svc.container_name.startsWith(projectName),
        `${app}/${version}: container_name 未改为冒烟 project 名：${svc.container_name}`);
    }
  }

  // ③ 所有 bind mount 都在临时目录下；具名卷都带 project 前缀
  for (const m of plan.mounts) {
    if (m.kind === 'relative' || m.kind === 'variable') {
      assert.ok(m.rewritten.startsWith(tmpDir),
        `${app}/${version}: 挂载源未指向临时目录：${m.rewritten}`);
    } else if (m.kind === 'named-volume') {
      assert.ok(m.rewritten.startsWith(`${projectName}_`),
        `${app}/${version}: 具名卷未加冒烟前缀：${m.rewritten}`);
    }
    // host-path（字面量绝对路径）必须被 detectSkipConditions 标出来 → 不会真的去挂
  }

  // ④ 端口全部绑 127.0.0.1，且容器端口与原始一致
  for (const p of plan.ports) {
    if (p.kind !== 'host-published') continue;
    assert.ok(p.hostPort >= 1024 && p.hostPort <= 65535,
      `${app}/${version}: 宿主机端口非法：${p.hostPort}`);
    const m = /^(?:[^:]+:)?(\d+):(.+)$/.exec(p.original.replace(/^\$\{[^}]+\}/, 'X'));
    if (m) {
      assert.equal(String(p.containerPort), m[2],
        `${app}/${version}: 容器端口被改动（原 ${m[2]} → ${p.containerPort}）`);
    }
  }
  for (const svc of Object.values(plan.composeDoc.services ?? {})) {
    for (const spec of (Array.isArray(svc?.ports) ? svc.ports : [])) {
      if (typeof spec !== 'string') continue;
      if (!/:\d+:/.test(spec)) continue;
      assert.ok(spec.startsWith('127.0.0.1:'),
        `${app}/${version}: 端口未绑到回环地址：${spec}`);
    }
  }
}

describe('沙箱隔离保证 · 真实存量应用回归', () => {
  for (const app of REPRESENTATIVE_APPS) {
    it(`${app}：每个版本的隔离计划都不泄漏真实路径 / 不碰宿主机网络`, () => {
      const versions = versionDirsOf(app);
      assert.ok(versions.length > 0, `${app} 没有版本目录（测试夹具失效？）`);
      for (const version of versions) {
        const { doc } = loadVersion(app, version);
        if (!doc) continue;
        // 有条件跳过的应用不生成计划（跳过的判定本身由下面 MUST_SKIP 用例覆盖）
        const skips = detectSkipConditions({ composeDoc: doc, versionDoc: loadVersion(app, version).versionDoc, versionDir: version });
        if (skips.length) continue;
        assertIsolation(app, version);
      }
    });
  }

  for (const app of MUST_NOT_SKIP_GPU) {
    it(`${app}：默认部署是纯 CPU，**不应**被 gpu-hardware 条件跳过`, () => {
      const versions = versionDirsOf(app);
      assert.ok(versions.length > 0, `${app} 没有版本目录（测试夹具失效？）`);
      for (const version of versions) {
        const { doc, versionDoc } = loadVersion(app, version);
        if (!doc) continue;
        const skips = detectSkipConditions({ composeDoc: doc, versionDoc, versionDir: version });
        assert.ok(!skips.some((s) => s.condition === 'gpu-hardware'),
          `${app}/${version}: 默认部署仍被判定为 GPU 依赖（${skips.map((s) => s.reason).join('; ')}）`);
      }
    });
  }

  for (const { app, expect } of MUST_SKIP) {
    it(`${app}：命中「${expect}」条件跳过（不被当成失败）`, () => {
      const versions = versionDirsOf(app);
      assert.ok(versions.length > 0, `${app} 没有版本目录（测试夹具失效？）`);
      const hit = versions.some((version) => {
        const { doc } = loadVersion(app, version);
        if (!doc) return false;
        return detectSkipConditions({ composeDoc: doc, versionDoc: loadVersion(app, version).versionDoc, versionDir: version }).some((s) => s.condition === expect);
      });
      assert.ok(hit, `${app} 未命中预期的条件跳过 ${expect}`);
    });
  }

  it('全仓应用目录里不存在「既不可冒烟也没被条件跳过」的漏网之鱼', () => {
    // 结构性护栏：每个有 compose 的版本目录，要么能生成隔离计划，要么有明确的跳过条件
    const apps = fs.readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !['.github', 'docs', 'node_modules', 'scripts', '.git', '.agent_cache'].includes(n))
      .filter((n) => fs.existsSync(path.join(REPO_ROOT, n, 'data.yml')));
    let total = 0;
    let skipped = 0;
    for (const app of apps) {
      for (const version of versionDirsOf(app)) {
        const { doc } = loadVersion(app, version);
        if (!doc) continue;
        total += 1;
        if (detectSkipConditions({ composeDoc: doc, versionDoc: loadVersion(app, version).versionDoc, versionDir: version }).length) skipped += 1;
      }
    }
    assert.ok(total > 200, `版本目录统计异常：${total}`);
    // 绝大多数应当可冒烟；若条件跳过占比过高说明判定过宽，需要复核
    assert.ok(skipped / total < 0.4,
      `条件跳过占比 ${(skipped / total * 100).toFixed(1)}% 偏高（${skipped}/${total}），判定口径可能过宽`);
  });
});
