// lib/regression-images.test.mjs — 存量应用的镜像/版本配置回归护栏
//
// ── 目的（目标 §十一.5）──────────────────────────────────────────────────
// 「使用新引擎对当前仓库所有存量应用的镜像配置进行一次本地解析与分类验证，
//   确认无任何现有合法应用被误判或破坏。」
//
// 本文件把这条验收标准固化成**自动化护栏**：每次 `npm test` 都会重新校验
// 全仓每个 compose 里的每个 image 引用，确保新的镜像解析器与版本引擎
// 不会把任何存量合法配置判成非法。
//
// 纯离线：只读仓库里的 compose 文件，**不发起任何网络请求**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { parseImageReference } from './image-ref.mjs';
import { classifyVersion, selectCandidate, SCHEMES } from './version.mjs';
import { VARIABLE_IMAGE_EXCEPTIONS } from './image-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 仓库根级目录中跳过��（不是应用目录） */
const SKIP_ROOT_DIRS = new Set(['.github', 'docs', 'node_modules', 'scripts']);

/**
 * 扫描全仓所有 `<app>/<version>/docker-compose.yml` 的 image 引用。
 * @returns {{app:string, versionDir:string, service:string, image:string}[]}
 */
function collectImageRefs() {
  const out = [];
  let apps;
  try {
    apps = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const app of apps) {
    if (!app.isDirectory() || app.name.startsWith('.') || SKIP_ROOT_DIRS.has(app.name)) continue;
    const appPath = path.join(REPO_ROOT, app.name);
    let versions;
    try {
      versions = fs.readdirSync(appPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const composePath = path.join(appPath, version.name, 'docker-compose.yml');
      if (!fs.existsSync(composePath)) continue;
      let doc;
      try {
        doc = yaml.load(fs.readFileSync(composePath, 'utf8'));
      } catch {
        continue;
      }
      for (const [name, svc] of Object.entries(doc?.services || {})) {
        const image = svc?.image;
        if (typeof image !== 'string') continue;
        out.push({ app: app.name, versionDir: version.name, service: name, image });
      }
    }
  }
  return out;
}

const refs = collectImageRefs();
const variableRefs = refs.filter(r => r.image.includes('${'));
const hardcodedRefs = refs.filter(r => !r.image.includes('${'));

describe('存量应用回归：镜像解析', () => {
  it('全仓 compose 确实扫到了镜像引用（护栏本身有效）', () => {
    assert.ok(refs.length > 100, `只扫到 ${refs.length} 处引用，夹具可能不对`);
    assert.ok(hardcodedRefs.length > 100);
  });

  it('每一个硬编码镜像都能被统一解析器解析（无一是"无法解析"）', () => {
    const failed = hardcodedRefs.filter(r => !parseImageReference(r.image));
    assert.deepEqual(
      failed.map(f => `${f.app}/${f.versionDir} ${f.service}: ${f.image}`),
      [],
      '以下存量镜像无法被统一解析器解析（属于误判）',
    );
  });

  it('变量型镜像仍然只有 image-policy 例外清单里的那几条', () => {
    const actual = variableRefs.map(r => `${r.app}/${r.versionDir}`).sort();
    const expected = [...VARIABLE_IMAGE_EXCEPTIONS].sort();
    assert.deepEqual(actual, expected, '变量型镜像清单与 image-policy 例外清单不一致');
  });

  it('解析结果与 compose 原文一致（registry / 路径 / tag 三者都对得上）', () => {
    for (const r of hardcodedRefs) {
      const ref = parseImageReference(r.image);
      assert.equal(ref.original, r.image);
      // 仓库路径（不含 registry 前缀）必须完整出现在原文里
      assert.ok(
        r.image.includes(ref.repo),
        `${r.app}/${r.versionDir} ${r.image}：解析出的仓库路径 ${ref.repo} 与原文不匹配`,
      );
      // 命名空间要么显式写出，要么是官方镜像自动补齐的 'library'
      if (ref.namespace && ref.namespace !== 'library') {
        assert.ok(
          r.image.includes(`${ref.namespace}/`),
          `${r.app}/${r.versionDir} ${r.image}：命名空间 ${ref.namespace} 与原文不匹配`,
        );
      }
      if (ref.tag) {
        assert.ok(r.image.endsWith(`:${ref.tag}`) || r.image.includes(`:${ref.tag}@`),
          `${r.app}/${r.versionDir} ${r.image}：解析出的 tag 与原文不匹配`);
      }
    }
  });
});

describe('存量应用回归：版本分类', () => {
  it('所有硬编码 tag 都能被分类器给出明确结论（不出现"未知且无原因"）', () => {
    const unknown = hardcodedRefs
      .map(r => ({ r, c: classifyVersion(parseImageReference(r.image).tag) }))
      .filter(x => !x.c)
      .map(x => `${x.r.app}/${x.r.versionDir} ${x.r.image}`);
    assert.deepEqual(unknown, [], '以下存量 tag 无法分类');
  });

  it('不可比较的 tag 必须给出明确原因（滚动 tag / 提交号），而不是静默', () => {
    const nonComparable = hardcodedRefs
      .map(r => ({ r, c: classifyVersion(parseImageReference(r.image).tag) }))
      .filter(x => x.c && !x.c.comparable);
    for (const { r, c } of nonComparable) {
      assert.ok(c.reason && c.reason.length > 0,
        `${r.app}/${r.versionDir} ${r.image}：不可比较但没有给出原因`);
    }
  });

  it('已知的存量特例走的是预期的 scheme / 轨道', () => {
    const expectations = [
      // [tag, scheme, track]
      ['1.2.0', SCHEMES.SEMVER, 'num:3'],
      ['v3.2.13', SCHEMES.SEMVER, 'num:3'],
      ['3.06.00', SCHEMES.SEMVER, 'num:3'],          // tdarr 前导零
      ['2.2', SCHEMES.SEMVER, 'num:2'],               // photopea 两段式
      ['v2.2', SCHEMES.SEMVER, 'num:2'],              // gecoos 两段式 + v
      ['26.04.5.1.1', SCHEMES.SEMVER, 'num:5'],       // collabora 多段式
      ['1.11.2-ls36', SCHEMES.VARIANT, 'num:3@ls36'], // handbrake 变体
      ['0.8.6-pg18-trixie', SCHEMES.VARIANT, 'num:3@pg18-trixie'], // pgvector 变体
      ['3.64.0-v1', SCHEMES.VARIANT, 'num:3@v1'],     // losslesscut 变体
      ['v3.2.13-arm32v7', SCHEMES.VARIANT, 'num:3@arm32v7'], // anirss 架构变体
      ['16-alpine', SCHEMES.VARIANT, 'num:1@alpine'],// postgres 运行时变体
      ['3-management', SCHEMES.VARIANT, 'num:1@management'], // rabbitmq 运行时变体
      ['2026.10.19-d47cb96bf', SCHEMES.CALVER, 'calver'], // searxng CalVer+SHA
      ['2026081705-arm64', SCHEMES.CALVER, 'calver'],     // jellyfin CalVer
      ['260919', SCHEMES.CALVER, 'calver'],               // photoprism CalVer
      ['v1.0.0-rc.40', SCHEMES.SEMVER, 'num:3'],         // newapi 预发布
      ['latest', SCHEMES.ROLLING, 'rolling:latest'],      // 滚动 tag
      ['a2b-latest', SCHEMES.ROLLING, 'rolling:a2b-latest'],
    ];
    for (const [tag, scheme, track] of expectations) {
      const c = classifyVersion(tag);
      assert.ok(c, `无法分类: ${tag}`);
      assert.equal(c.scheme, scheme, `${tag} 的 scheme 不符`);
      assert.equal(c.track, track, `${tag} 的轨道不符`);
    }
  });

  it('预发布版本不算"变体"，正式版与预发布版同轨（rc → 正式版可升级）', () => {
    const pre = classifyVersion('v1.0.0-rc.40');
    const rel = classifyVersion('v1.0.0');
    assert.equal(pre.variant, null, 'rc.40 不应被当成变体后缀');
    assert.equal(pre.track, rel.track, '预发布与正式版应同轨');
  });
});

describe('存量应用回归：同轨保护（严禁跨轨道升级 / 降级）', () => {
  const cases = [
    // [当前 tag, 上游候选, 期望产出, 说明]
    ['16-alpine', ['17-alpine', '16-alpine', '9.6.24', '16.3-alpine', 'alpine'], '17-alpine',
      'postgres：主版本轨道内升级，绝不能选 9.6.24'],
    ['3-management', ['4-management', '3-management', '3.13.7', '3.13.7-management'], '4-management',
      'rabbitmq：management 变体轨道内升级，绝不能选 3.13.7'],
    ['0.8.6-pg18-trixie', ['0.8.6-pg18-trixie', '0.8.7-pg18-trixie', '0.9.0', '0.9.1'], '0.8.7-pg18-trixie',
      'pgvector：保留 -pg18-trixie 变体'],
    ['1.11.2-ls36', ['1.11.2-ls36', '1.11.2-ls41', '1.11.3-ls36', '1.11.3-ls41'], '1.11.3-ls36',
      'handbrake：保留 -ls36 变体'],
    ['3.64.0-v1', ['3.64.0-v1', '3.65.0-v1', '3.64.1', '3.65.0'], '3.65.0-v1',
      'losslesscut：保留 -v1 变体'],
    ['server-cuda12-v0.4.1', ['server-cuda12-v0.4.1', 'server-vulkan-v0.4.9', 'server-vulkan-v0.4.7'], 'server-cuda12-v0.4.1',
      'llamacpp：不得跳到 vulkan 轨道'],
    ['2.2', ['2.1.0', '2.2', '2.3', '2.2.0'], '2.3',
      'photopea：两段式轨道内升级，绝不能降级到 2.1.0'],
    ['1.2.0', ['2.0.0-rc.1'], null, '正式版不得升级到预发布版'],
    ['1.2.0', ['20240501'], null, 'SemVer 不得与 CalVer 混排'],
    ['1.2.0', ['1.3.0-amd64', '1.3.0-arm64v8'], null, '主轨不得吸收架构专属 tag'],
    ['1.2.0+build.1', ['1.2.0+build.1', '1.2.0+build.2'], '1.2.0+build.1',
      '构建元数据差异不得触发升级'],
    ['26.04.5.1.1', ['2.1.2', '2.1.5', '26.04.5.1.1', '26.04.5.2.1'], '26.04.5.2.1',
      'collabora：多段轨道内升级，不得回退到 2.1.5'],
    ['v3.2.13-arm32v7', ['v3.2.13', 'v3.2.13-arm32v7', 'v3.2.55', 'v3.2.55-arm32v7'], 'v3.2.55-arm32v7',
      'anirss：架构变体轨道内升级'],
    ['v3.2.13', ['v3.2.13', 'v3.2.13-arm32v7', 'v3.2.55', 'v3.2.55-arm32v7'], 'v3.2.55',
      'anirss：主轨不得吸收 arm32v7 变体'],
    ['3.06.00', ['3.00.00', '3.01.00', '3.04.00', '3.06.00', '2.91.01'], '3.06.00',
      'tdarr：前导零版本同轨'],
    ['2026.10.19-d47cb96bf', ['2026.10.19-d47cb96bf', '2026.11.2-d138f443b'], '2026.11.2-d138f443b',
      'searxng：CalVer 轨道内升级（SHA 视为构建标识）'],
  ];

  for (const [current, candidates, expected, why] of cases) {
    it(`${why}（当前 ${current}）`, () => {
      const r = selectCandidate(current, candidates);
      assert.equal(r.tag, expected, `期望 ${expected}，实际 ${r.tag}（${r.reason}）`);
      if (expected && expected !== current) {
        assert.equal(r.comparison, 'upgradable');
      }
    });
  }

  it('候选低于当前时必须拒绝（禁止未授权降级）', () => {
    const r = selectCandidate('2.0.0', ['1.9.9']);
    assert.equal(r.tag, null);
    assert.equal(r.comparison, 'incompatible');
    assert.ok(r.reason.includes('降级'));
  });
});
