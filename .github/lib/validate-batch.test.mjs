// .github/lib/validate-batch.test.mjs
// 覆盖 .github/lib/validate-batch.mjs。
//
// 关注点：自动更新批次在**开 PR 之前**必须被拦住的问题——
//   YAML 语法错、data.yml schema 不符、目录结构缺失、compose 无 services、
//   **本批次更新的**镜像 tag 非法、README 版本没同步。
//
// 关键不变量（2026-11 审计反馈）：
//   · 校验器必须只对**本批次产生的内容**下重判——历史遗留债务
//     （firecrawl 的 `playwright-service:latest`、缺 `additionalProperties.type`）
//     不能把合法批次永久堵死；
//   · AUDIT 模式（无 updates）仍然把 tag 问题全部报成 error（人工审计用）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateUpdateBatch,
  validateDataYamlDocument,
  validateComposeDocument,
  validateImageTags,
  validateAppStructure,
  validateReadmeVersion,
  readReadmeVersionTable,
  isRecognisableVersionTag,
  isNonVersionTag,
  parseImageRef,
  collectVersionDirs,
  collectUpdatedServices,
} from './validate-batch.mjs';

// ─── 测试夹具 ─────────────────────────────────────────────────────────────

let ROOT;

/** 写文件（自动建目录） */
function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

/** 一份"合法"的根 data.yml */
const GOOD_ROOT_DATA = `additionalProperties:
  key: demo
  name: Demo
  type: tool
  website: https://example.com
  github: https://github.com/example/demo
`;

/** 一份"合法"的版本 data.yml */
const GOOD_VERSION_DATA = `additionalProperties:
  key: demo
  name: demo 1.0.0
  type: tool
  formFields:
    - envKey: PANEL_APP_PORT_HTTP
      type: number
      default: 8080
      rule: paramPort
`;

/** 一份"合法"的 compose */
const GOOD_COMPOSE = `services:
  demo:
    image: example/demo:v1.0.0
    container_name: \${CONTAINER_NAME}
    restart: always
    networks:
      - 1panel-network
networks:
  1panel-network:
    external: true
`;

/** 重置夹具仓库 */
function reset() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  write('demo/data.yml', GOOD_ROOT_DATA);
  write('demo/1.0.0/data.yml', GOOD_VERSION_DATA);
  write('demo/1.0.0/docker-compose.yml', GOOD_COMPOSE);
  write(
    'README.md',
    ['# Apps', '', '## 应用列表', '', '| 应用 | 说明 | 当前版本 |', '|------|------|----------|',
      '| demo | 演示应用 | 1.0.0 |', ''].join('\n'),
  );
}

/** 跑一次批次校验（BATCH 模式） */
function run(updates) {
  return validateUpdateBatch({ root: ROOT, updates });
}

/** 跑一次全仓审计（AUDIT 模式） */
function runAudit() {
  return validateUpdateBatch({ root: ROOT, updates: [] });
}

/** 一条最小 updates 记录 */
function updatesFor(app = 'demo', versionDir = '1.0.0', services = ['demo']) {
  return [
    {
      app,
      from: '0.9.0',
      to: '1.0.0',
      services: services.map(n => ({ name: n, repo: 'example/demo', from: '0.9.0', to: '1.0.0' })),
      changes: [{ path: `${app}/${versionDir}/docker-compose.yml`, content: '' }],
      versionDir,
    },
  ];
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-batch-'));
  reset();
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ─── 纯函数级 ─────────────────────────────────────────────────────────────

describe('isRecognisableVersionTag', () => {
  it('接受严格 SemVer', () => {
    assert.equal(isRecognisableVersionTag('1.2.3'), true);
    assert.equal(isRecognisableVersionTag('v1.2.3'), true);
  });

  it('接受 SemVer + 架构后缀', () => {
    assert.equal(isRecognisableVersionTag('v3.2.18-arm32v7'), true);
  });

  it('接受日期型 / 多段数字形态', () => {
    assert.equal(isRecognisableVersionTag('260919'), true);
    assert.equal(isRecognisableVersionTag('2024.08'), true);
    assert.equal(isRecognisableVersionTag('2026.9.7-3e454637f'), true);
    assert.equal(isRecognisableVersionTag('26.04.5.1.1'), true);
  });

  it('拒绝 latest / nightly / dev / edge 等非版本词', () => {
    for (const tag of ['latest', 'nightly', 'dev', 'edge']) {
      assert.equal(isNonVersionTag(tag), true, `${tag} 应判为非版本词`);
      assert.equal(isRecognisableVersionTag(tag), false, `${tag} 不应被认可为版本`);
    }
  });

  it('拒绝不含数字的噪声 tag', () => {
    assert.equal(isRecognisableVersionTag('not-a-version'), false);
  });
});

describe('parseImageRef', () => {
  it('拆出 repo 与 tag', () => {
    assert.deepEqual(parseImageRef('example/demo:v1.0.0'), { repo: 'example/demo', tag: 'v1.0.0' });
  });

  it('变量型镜像与 digest 镜像跳过', () => {
    assert.equal(parseImageRef('${IMAGE}'), null);
    assert.equal(parseImageRef('${APP_IMAGE}:${APP_VERSION}'), null);
    assert.equal(parseImageRef('nginx@sha256:abc'), null);
  });

  it('未写 tag 时 tag 为 null', () => {
    assert.deepEqual(parseImageRef('postgres'), { repo: 'postgres', tag: null });
  });
});

describe('validateDataYamlDocument', () => {
  it('合法的 data.yml 无错误', () => {
    const doc = { additionalProperties: { key: 'demo', name: 'Demo', type: 'tool' } };
    const r = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  it('缺少 key 报错', () => {
    const doc = { additionalProperties: { name: 'Demo', type: 'tool' } };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /key 缺失或为空/.test(e)), errors.join(' | '));
  });

  it('key 与目录名不一致报错', () => {
    const doc = { additionalProperties: { key: 'other', name: 'Demo', type: 'tool' } };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /与目录名/.test(e)), errors.join(' | '));
  });

  it('type 不在白名单报错', () => {
    const doc = { additionalProperties: { key: 'demo', name: 'Demo', type: 'photo' } };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /type="photo"/.test(e)), errors.join(' | '));
  });

  it('type 缺失只告警（与 npm run lint 的 .default("tool") 口径一致）', () => {
    const doc = { additionalProperties: { key: 'demo', name: 'Demo' } };
    const { errors, warnings } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some(w => /type 缺失/.test(w)), warnings.join(' | '));
  });

  it('非法 formField type 报错', () => {
    const doc = {
      additionalProperties: {
        key: 'demo', name: 'Demo', type: 'tool',
        formFields: [{ envKey: 'X', type: 'boolean' }],
      },
    };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /type=boolean/.test(e)), errors.join(' | '));
  });

  it('非法 formField rule 报错', () => {
    const doc = {
      additionalProperties: {
        key: 'demo', name: 'Demo', type: 'tool',
        formFields: [{ envKey: 'X', type: 'text', rule: 'paramHttp' }],
      },
    };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /rule="paramHttp"/.test(e)), errors.join(' | '));
  });

  it('formField 缺 envKey / type 报错', () => {
    const doc = {
      additionalProperties: {
        key: 'demo', name: 'Demo', type: 'tool',
        formFields: [{ label: { en: 'x' } }],
      },
    };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /envKey 缺失或为空/.test(e)), errors.join(' | '));
    assert.ok(errors.some(e => /type 缺失或为空/.test(e)), errors.join(' | '));
  });

  it('非法 URL 报错', () => {
    const doc = {
      additionalProperties: {
        key: 'demo', name: 'Demo', type: 'tool', website: 'example.com',
      },
    };
    const { errors } = validateDataYamlDocument(doc, { label: 'demo/data.yml', appDir: 'demo' });
    assert.ok(errors.some(e => /website/.test(e)), errors.join(' | '));
  });
});

describe('validateComposeDocument', () => {
  it('合法 compose 无错误', () => {
    const doc = {
      services: { demo: { image: 'example/demo:v1.0.0', restart: 'always', networks: ['1panel-network'] } },
      networks: { '1panel-network': { external: true } },
    };
    const { errors } = validateComposeDocument(doc, { label: 'demo/1.0.0/docker-compose.yml' });
    assert.deepEqual(errors, []);
  });

  it('缺少 services 报错', () => {
    const { errors } = validateComposeDocument({ networks: {} }, { label: 'c' });
    assert.ok(errors.some(e => /缺少 services/.test(e)));
  });

  it('services 为空报错', () => {
    const { errors } = validateComposeDocument({ services: {} }, { label: 'c' });
    assert.ok(errors.some(e => /services 为空/.test(e)));
  });

  it('规约偏差只报 warning', () => {
    const { errors, warnings } = validateComposeDocument(
      { services: { demo: { image: 'example/demo:v1.0.0' } } },
      { label: 'c' },
    );
    assert.deepEqual(errors, []);
    assert.ok(warnings.some(w => /restart/.test(w)), warnings.join(' | '));
    assert.ok(warnings.some(w => /1panel-network/.test(w)), warnings.join(' | '));
  });
});

describe('validateImageTags', () => {
  it('latest 是错误（AUDIT 模式）', () => {
    const { errors } = validateImageTags({ services: { a: { image: 'x/y:latest' } } }, { label: 'c' });
    assert.ok(errors.some(e => /latest/.test(e)), errors.join(' | '));
  });

  it('nightly / dev 是错误', () => {
    for (const tag of ['nightly', 'dev']) {
      const { errors } = validateImageTags({ services: { a: { image: `x/y:${tag}` } } }, { label: 'c' });
      assert.ok(errors.some(e => /非版本词/.test(e)), `${tag}: ${errors.join(' | ')}`);
    }
  });

  it('不可识别的形态是错误', () => {
    const { errors } = validateImageTags({ services: { a: { image: 'x/y:not-a-version' } } }, { label: 'c' });
    assert.ok(errors.some(e => /可识别的版本形态/.test(e)), errors.join(' | '));
  });

  it('合法 semver / 日期形态不报错', () => {
    for (const tag of ['v1.0.0', '1.0.0', '260919', '2026.9.7-3e454637f', '26.04.5.1.1']) {
      const { errors } = validateImageTags({ services: { a: { image: `x/y:${tag}` } } }, { label: 'c' });
      assert.deepEqual(errors, [], `${tag} 不应报错`);
    }
  });

  it('BATCH 模式：未被本批次更新的 service 只告警', () => {
    const r = validateImageTags(
      { services: { a: { image: 'x/y:latest' }, b: { image: 'x/z:v1.0.0' } } },
      { label: 'c', updatedServices: new Set(['b']), inheritedFrom: 'demo/1.0.0' },
    );
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some(w => /非本批次引入/.test(w)), r.warnings.join(' | '));
  });

  it('BATCH 模式：被本批次更新的 service 仍是错误', () => {
    const r = validateImageTags(
      { services: { a: { image: 'x/y:latest' } } },
      { label: 'c', updatedServices: new Set(['a']) },
    );
    assert.ok(r.errors.some(e => /latest/.test(e)), r.errors.join(' | '));
  });
});

describe('collectVersionDirs / collectUpdatedServices', () => {
  it('从 changes 路径与 versionCopy 里收集版本目录', () => {
    const dirs = collectVersionDirs(
      [
        {
          app: 'demo',
          versionDir: '1.0.0',
          versionCopy: { appName: 'demo', fromDir: '1.0.0', toDir: '2.0.0' },
          changes: [{ path: 'demo/1.0.0/docker-compose.yml' }],
        },
      ],
      'demo',
    );
    assert.ok(dirs.includes('1.0.0'));
    assert.ok(dirs.includes('2.0.0'));
  });

  it('按版本目录收集本批次更新过的 service', () => {
    const map = collectUpdatedServices(
      [
        {
          app: 'demo',
          versionDir: '1.0.0',
          versionCopy: { appName: 'demo', fromDir: '0.9.0', toDir: '1.0.0' },
          services: [{ name: 'demo' }],
          changes: [{ path: 'demo/1.0.0/docker-compose.yml' }],
        },
      ],
      'demo',
    );
    assert.ok(map.get('1.0.0').services.has('demo'));
    assert.equal(map.get('1.0.0').source, '0.9.0');
  });
});

// ─── 批次级（BATCH 模式）───────────────────────────────────────────────────

describe('validateUpdateBatch（BATCH 模式）', () => {
  it('合法批次：无错误', () => {
    reset();
    const { errors } = run(updatesFor());
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('data.yml YAML 语法错误被拦下', () => {
    reset();
    write('demo/1.0.0/data.yml', 'additionalProperties:\n  key: demo\n   name: bad indent\n');
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /YAML 语法错误/.test(e)), errors.join('\n'));
  });

  it('data.yml 缺 key 被拦下', () => {
    reset();
    write('demo/1.0.0/data.yml', 'additionalProperties:\n  name: demo 1.0.0\n  type: tool\n');
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /key 缺失或为空/.test(e)), errors.join('\n'));
  });

  it('data.yml 的 key 与目录名不一致被拦下', () => {
    reset();
    write('demo/1.0.0/data.yml', 'additionalProperties:\n  key: other\n  name: demo 1.0.0\n  type: tool\n');
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /与目录名/.test(e)), errors.join('\n'));
  });

  it('data.yml 缺 type 不阻断（只告警，与 npm run lint 一致）', () => {
    reset();
    write('demo/1.0.0/data.yml', 'additionalProperties:\n  key: demo\n  name: demo 1.0.0\n');
    const { errors, warnings } = run(updatesFor());
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.ok(warnings.some(w => /type 缺失/.test(w)), warnings.join('\n'));
  });

  it('data.yml 的 formField type 非法被拦下', () => {
    reset();
    write(
      'demo/1.0.0/data.yml',
      'additionalProperties:\n  key: demo\n  name: demo 1.0.0\n  type: tool\n' +
        '  formFields:\n    - envKey: X\n      type: boolean\n',
    );
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /type=boolean/.test(e)), errors.join('\n'));
  });

  it('data.yml 的 formField 缺 envKey 被拦下', () => {
    reset();
    write(
      'demo/1.0.0/data.yml',
      'additionalProperties:\n  key: demo\n  name: demo 1.0.0\n  type: tool\n' +
        '  formFields:\n    - type: text\n      label:\n        en: x\n',
    );
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /envKey 缺失或为空/.test(e)), errors.join('\n'));
  });

  it('缺少 docker-compose.yml 被拦下', () => {
    reset();
    fs.rmSync(path.join(ROOT, 'demo/1.0.0/docker-compose.yml'));
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /docker-compose\.yml 不存在/.test(e)), errors.join('\n'));
  });

  it('compose YAML 语法错误被拦下', () => {
    reset();
    write('demo/1.0.0/docker-compose.yml', 'services:\n  demo:\n   image: x\n  bad: [\n');
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /YAML 语法错误/.test(e)), errors.join('\n'));
  });

  it('compose 没有 services 被拦下', () => {
    reset();
    write('demo/1.0.0/docker-compose.yml', 'networks:\n  1panel-network:\n    external: true\n');
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /缺少 services/.test(e)), errors.join('\n'));
  });

  it('本批次更新的 service 用 latest → 报错', () => {
    reset();
    write(
      'demo/1.0.0/docker-compose.yml',
      GOOD_COMPOSE.replace('example/demo:v1.0.0', 'example/demo:latest'),
    );
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /latest/.test(e)), errors.join('\n'));
  });

  it('本批次更新的 service 用不可识别 tag → 报错', () => {
    reset();
    write(
      'demo/1.0.0/docker-compose.yml',
      GOOD_COMPOSE.replace('example/demo:v1.0.0', 'example/demo:not-a-version'),
    );
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /可识别的版本形态/.test(e)), errors.join('\n'));
  });

  it('未更新的 sidecar 沿用 :latest → 不阻断（历史遗留债务）', () => {
    reset();
    write(
      'demo/1.0.0/docker-compose.yml',
      [
        'services:',
        '  demo:',
        '    image: example/demo:v1.0.0',
        '    restart: always',
        '    networks:',
        '      - 1panel-network',
        '  playwright-service:',
        '    image: ghcr.io/firecrawl/playwright-service:latest',
        '    restart: always',
        '    networks:',
        '      - 1panel-network',
        'networks:',
        '  1panel-network:',
        '    external: true',
        '',
      ].join('\n'),
    );
    const { errors, warnings } = run(updatesFor()); // 本批次只更新了 demo 这个 service
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.ok(
      warnings.some(w => /playwright-service/.test(w) && /非本批次引入/.test(w)),
      warnings.join('\n'),
    );
  });

  it('README 版本与实际不一致被拦下', () => {
    reset();
    write(
      'README.md',
      ['## 应用列表', '', '| 应用 | 说明 | 当前版本 |', '|------|------|----------|',
        '| demo | 演示应用 | 0.9.0 |', ''].join('\n'),
    );
    const { errors } = run(updatesFor());
    assert.ok(errors.some(e => /README 未重新同步/.test(e)), errors.join('\n'));
  });

  it('README 版本一致时通过', () => {
    reset();
    const { errors } = run(updatesFor());
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('别名表 preferred_version 覆盖期望版本', () => {
    reset();
    write('demo/2.0.0/data.yml', GOOD_VERSION_DATA);
    write('demo/2.0.0/docker-compose.yml', GOOD_COMPOSE);
    write(
      '.github/app-aliases.yml',
      'aliases:\n  demo:\n    dir: demo\n    preferred_version: 2.0.0\n',
    );
    write(
      'README.md',
      ['## 应用列表', '', '| 应用 | 说明 | 当前版本 |', '|------|------|----------|',
        '| demo | 演示应用 | 2.0.0 |', ''].join('\n'),
    );
    const { errors } = run(updatesFor());
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('版本目录不存在被拦下', () => {
    reset();
    const { errors } = run(updatesFor('demo', '9.9.9'));
    assert.ok(errors.some(e => /版本目录不存在/.test(e)), errors.join('\n'));
  });
});

// ─── 批次级（AUDIT 模式）───────────────────────────────────────────────────

describe('validateUpdateBatch（AUDIT 模式）', () => {
  it('没有 update 记录时校验全仓应用', () => {
    reset();
    const { errors } = runAudit();
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('全仓模式下 latest tag 是 error（供人工审计）', () => {
    reset();
    write(
      'demo/1.0.0/docker-compose.yml',
      GOOD_COMPOSE.replace('example/demo:v1.0.0', 'example/demo:latest'),
    );
    const { errors } = runAudit();
    assert.ok(errors.some(e => /latest/.test(e)), errors.join('\n'));
  });

  it('全仓模式下缺 type 不阻断（只告警）', () => {
    reset();
    write('demo/1.0.0/data.yml', 'additionalProperties:\n  key: demo\n  name: demo 1.0.0\n');
    const { errors, warnings } = runAudit();
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.ok(warnings.some(w => /type 缺失/.test(w)), warnings.join('\n'));
  });
});

describe('validateAppStructure / validateReadmeVersion / readReadmeVersionTable', () => {
  it('应用根缺 data.yml 报错', () => {
    reset();
    fs.rmSync(path.join(ROOT, 'demo/data.yml'));
    const errs = validateAppStructure(ROOT, 'demo');
    assert.ok(errs.some(e => /data\.yml 不存在/.test(e)), errs.join(' | '));
  });

  it('README 表格解析出 应用 → 版本', () => {
    reset();
    const table = readReadmeVersionTable(ROOT);
    assert.equal(table.get('demo'), '1.0.0');
  });

  it('README 缺该应用时报错', () => {
    reset();
    const errs = validateReadmeVersion(ROOT, 'demo', null, new Map());
    assert.ok(errs.some(e => /缺少应用/.test(e)), errs.join(' | '));
  });

  it('README 版本与实际不一致时报错', () => {
    reset();
    const table = new Map([['demo', '0.9.0']]);
    const errs = validateReadmeVersion(ROOT, 'demo', null, table);
    assert.ok(errs.some(e => /README 未重新同步/.test(e)), errs.join(' | '));
  });
});
