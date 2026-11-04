// .github/lib/consistency.test.mjs
// SSOT 跨文件一致性规则引擎回归测试。
//
// 锁死的不变量：
//   1. T1 六个内置变量（CONTAINER_NAME/HOST_IP/HOST_ADDRESS/PANEL_DB_PORT/CPUS/MEMORY_LIMIT）
//      引用免声明，且除此之外任何 ${VAR} 未声明都报 P0；
//   2. 直译/tcp-udp 同 host 端口不算冲突（aria2 双映射回归）；
//   3. 注释里的 ${VAR} 样例不算真实引用（剥注释后才扫）；
//   4. 主服务镜像 tag 与版本目录在**同一归一化函数**下必须一致；
//      `pg-`/`server-` 前缀、`-ls36`/`-arm32v7`/`-cu124` 等尾缀剥离后须对齐；
//   5. 版本级 finding（name-drift/tag.dir）必带 version，应用级 finding（readme.vars）带 version=null。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_VARS,
  RULES,
  RULE_IDS,
  stripCommentedLines,
  collectVarRefs,
  checkVarDeclarations,
  checkFormOrphans,
  checkPortConflicts,
  checkTagDir,
  checkVolumes,
  checkHighPrivilege,
  checkIdentity,
  checkFormTypeDefaults,
  checkVersionName,
  checkReadmeVars,
  runVersionChecks,
} from './consistency.mjs';

const BASE_CTX = { app: 'demo', version: '1.0.0', composePath: 'demo/1.0.0/docker-compose.yml' };

function composeCtx(raw, doc, extra = {}) {
  return { ...BASE_CTX, composeRaw: raw, composeDoc: doc, ...extra };
}

test('T1 白名单 6 变量 + 声明变量不误报；未声明变量报 P0', () => {
  const raw = [
    'services:',
    '  app:',
    '    image: repo/app:1.0.0',
    '    container_name: ${CONTAINER_NAME}',
    '    environment:',
    '      - DB_URI=${HOST_IP}',
    '      - SECRET=${APP_SECRET}',
  ].join('\n');
  const ctx = composeCtx(raw, { services: {} });
  // 未声明版本
  const bad = checkVarDeclarations(ctx);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].ruleId, 'var.undeclared');
  assert.equal(bad[0].severity, 'P0');
  assert.equal(bad[0].actual, '${APP_SECRET}');
  // 声明后消音
  const good = checkVarDeclarations(composeCtx(raw, null, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'APP_SECRET' }] } },
  }));
  assert.deepEqual(good, []);
  assert.deepEqual(BUILTIN_VARS, ['CONTAINER_NAME','HOST_IP','HOST_ADDRESS','PANEL_DB_PORT','CPUS','MEMORY_LIMIT']);
});

test('注释里的 ${VAR} 样例不算引用', () => {
  const raw = [
    'services:',
    '  app:',
    '    image: repo/app:1.0.0',
    '    # 例如 ${MY_VAR} 或 ${ALSO_QUERY}，只是文本',
  ].join('\n');
  const ctx = composeCtx(raw, null);
  assert.deepEqual(checkVarDeclarations(ctx), []);
  assert.deepEqual(collectVarRefs(raw), []);
});

test('stripCommentedLines 保留行号，stripComment 拿掉内容', () => {
  const lines = stripCommentedLines('a: 1  # 注释\n# 整行注释\nb: ${X}');
  assert.equal(lines[0].n, 1); assert.equal(lines[0].text, 'a: 1 ');
  assert.equal(lines[1].n, 2); assert.equal(lines[1].text, '');
  assert.equal(lines[2].n, 3); assert.equal(lines[2].text, 'b: ${X}');
});

test('tcp/udp 同 host 端口不是冲突；同协议重复才是', () => {
  const ok = composeCtx('x', { services: {
    app: { ports: ['${PANEL_APP_PORT_BT}:32516', '${PANEL_APP_PORT_BT}:32516/udp'] },
  } });
  assert.deepEqual(checkPortConflicts(ok), []);
  const f = checkPortConflicts(composeCtx('x', { services: {
    app: { ports: ['${PANEL_APP_PORT_BT}:32516/tcp', '${PANEL_APP_PORT_BT}:32516'] },
  } }));
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, 'port.conflict');
  assert.equal(f[0].severity, 'P1');
});

test('tag.dir：目录与主服务 tag 归一化一致不报；pg- 前缀对齐；ls 尾缀剥离', () => {
  const cases = [
    { dir: '1.16.0', tag: 'pg-1.16.0', expect: 0 },
    { dir: '1.16.0', tag: '1.16.0', expect: 0 },
    { dir: 'v1.56.1', tag: 'v2.16.3', expect: 1 }, // linkwarden 回归
    { dir: '1.11.2-ls36', tag: '1.11.2-ls96', expect: 0 },
    { dir: '0.4.7', tag: 'server-vulkan-v0.4.7', expect: 0 },
    { dir: 'cu124', tag: 'x', expect: 0 }, // 非语义版本目录跳过
  ];
  for (const c of cases) {
    const ctx = composeCtx('x', { services: { app: { image: `repo/app:${c.tag}` } } }, { version: c.dir });
    const f = checkTagDir(ctx);
    assert.equal(f.length, c.expect, `dir=${c.dir} tag=${c.tag}`);
    if (c.expect === 1) {
      assert.equal(f[0].ruleId, 'tag.dir');
      assert.equal(f[0].version, c.dir);
      assert.ok(c.dir.includes('56'));
    }
  }
});

test('tag.dir：变量型镜像和 latest 目录静默，由 image-policy / dir.latest 负责', () => {
  const vCtx = composeCtx('x', { services: { app: { image: '${IMAGE}:${VERSION}' } } }, { version: '1.0.0' });
  assert.deepEqual(checkTagDir(vCtx), []);
  const lCtx = composeCtx('x', { services: { app: { image: 'repo/app:beta' } } }, { version: 'latest' });
  assert.deepEqual(checkTagDir(lCtx), []);
});

test('dir.latest：latest 目录直接 P1 报错', () => {
  const ctx = composeCtx('x', null, { version: 'latest', dataPath: 'demo/latest/data.yml' });
  const out = runVersionChecks(ctx).filter((x) => x.ruleId === 'dir.latest');
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'P1');
});

test('form.orphan / port.orphan：端口变量但无 ports=P1；其他孤立声明=P2', () => {
  const ctx = composeCtx('x', { services: { app: { image: 'r/a:1' } } }, {
    versionDoc: { additionalProperties: { formFields: [
      { envKey: 'PANEL_APP_PORT_HTTP', type: 'number' },
      { envKey: 'TZ', type: 'text' },
    ] } },
  });
  const out = checkFormOrphans(ctx);
  const portFindings = out.filter((f) => f.ruleId === 'port.orphan');
  assert.equal(portFindings[0].severity, 'P1');
  const orphanFindings = out.filter((f) => f.ruleId === 'form.orphan');
  assert.equal(orphanFindings[0].severity, 'P2');
  // compose 有 ports 且实际使用该变量后完全静默
  const ctx2 = composeCtx('    - "${PANEL_APP_PORT_HTTP}:80"', {
    services: { app: { image: 'r/a:1', ports: ['${PANEL_APP_PORT_HTTP}:80'] } },
  }, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'PANEL_APP_PORT_HTTP', type: 'number' }] } },
  });
  assert.equal(checkFormOrphans(ctx2).length, 0);
});

test('form.orphan：init.sh 按词边界消费的变量不算孤儿；脚本引用不能开脱端口孤儿', () => {
  // cfnb 型：compose 无引用、init.sh 用 ${KEY} / $KEY 生成配置 → 非孤儿
  const scriptUsed = composeCtx('x', { services: { app: { image: 'r/a:1' } } }, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'SCHEDULE_ENABLED', type: 'text' }] } },
    scriptsText: '\n#!/bin/sh\ncat > config.yaml <<EOF\nschedule: ${SCHEDULE_ENABLED}\nEOF',
  });
  assert.deepEqual(checkFormOrphans(scriptUsed), []);
  // 词边界：PORTS 不因 SCHEDULE_PORTS 之类子串被误认为已使用
  const substring = composeCtx('x', { services: { app: { image: 'r/a:1' } } }, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'PORTS', type: 'text' }] } },
    scriptsText: '\necho "$SCHEDULE_PORTS"',
  });
  assert.equal(checkFormOrphans(substring).length, 1);
  // 反例：脚本引用端口变量不能消除 port.orphan（P1）——脚本无法创建 ports 映射
  const portInScript = composeCtx('x', { services: { app: { image: 'r/a:1' } } }, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'PANEL_APP_PORT_HTTP', type: 'number' }] } },
    scriptsText: '\necho "$PANEL_APP_PORT_HTTP"',
  });
  const pf = checkFormOrphans(portInScript);
  assert.equal(pf.length, 1);
  assert.equal(pf[0].ruleId, 'port.orphan');
  // 引擎纯度：scriptsText 缺省时行为与旧版一致（报 P2孤儿）
  const noScripts = composeCtx('x', { services: { app: { image: 'r/a:1' } } }, {
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'TZ', type: 'text' }] } },
  });
  assert.equal(checkFormOrphans(noScripts).length, 1);
});

test('volume.path：安全豁免不误报；危险个人路径报 P1', () => {
  const safe = composeCtx('x', { services: { app: { volumes: ['/dev/dri:/dev/dri', '/etc/localtime:/etc/localtime:ro', './data:/data'] } } });
  assert.deepEqual(checkVolumes(safe), []);
  const bad = composeCtx('x', { services: { app: { volumes: ['/home/al/workspace/traefik/traefik.yml:/etc/traefik/traefik.yml:ro'] } } });
  const f = checkVolumes(bad);
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, 'volume.path');
  assert.equal(f[0].severity, 'P1');
});

test('runtime.high-privilege：cap_add/devices/GPU 提示 P2；干净服务静默', () => {
  const bad = composeCtx('x', { services: { app: { 'cap_add': ['SYS_ADMIN'], 'privileged': true } } });
  const out = checkHighPrivilege(bad);
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'runtime.high-privilege');
  assert.equal(out[0].severity, 'P2');
  const clean = composeCtx('x', { services: { app: { restart: 'always', networks: ['1panel-network'] } } });
  assert.deepEqual(checkHighPrivilege(clean), []);
});

test('runtime.identity-mixed：user + 身份环境变量双通道提示；单用任一不报', () => {
  const both = composeCtx('x', { services: { app: {
    user: '${UID}:${GID}',
    environment: ['USER_ID=${APP_USER_ID}'],
  } } });
  const out = checkIdentity(both);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'P2');
  const onlyUser = composeCtx('x', { services: { app: { user: '${UID}:${GID}',
    environment: ['OTHER=x'] } } });
  assert.deepEqual(checkIdentity(onlyUser), []);
});

test('form.type-default：number 非数字报 P1；select default 越界报 P1', () => {
  const bad = composeCtx('x', null, {
    versionDoc: { additionalProperties: { formFields: [
      { envKey: 'A_TYPE', type: 'number', default: 'abc' },
      { envKey: 'B_TYPE', type: 'select', default: 'y', values: [{ label: 'x', value: 'x' }] },
    ] } },
  });
  const out = checkFormTypeDefaults(bad);
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.ruleId === 'form.type-default' && f.severity === 'P1'));
  const good = composeCtx('x', null, {
    versionDoc: { additionalProperties: { formFields: [
      { envKey: 'PORT_TYPE', type: 'number', default: 8080 },
      { envKey: 'MODE', type: 'select', default: 'a', values: [{ label: 'A', value: 'a' }] },
    ] } },
  });
  assert.deepEqual(checkFormTypeDefaults(good), []);
});

test('meta.name-drift：版本级 name 与根级 name 不一致报 P2', () => {
  const ctx = composeCtx('x', null, {
    dataPath: 'demo/1.0.0/data.yml',
    rootDoc: { additionalProperties: { name: 'Demo' } },
    versionDoc: { additionalProperties: { name: 'demo' } },
  });
  const out = checkVersionName(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'meta.name-drift');
  assert.equal(out[0].actual, 'demo');
  assert.equal(out[0].expected, 'Demo');
});

test('readme.vars：T1 与 PANEL_ 注入位与已声明变量不算漂移；孤儿变量报 P2', () => {
  const raw100 = [
    '运行 `${CONTAINER_NAME}`（内置）与 `${PANEL_APP_PORT_HTTP}`（已声明）；',
    '但 `${MAGIC_WORD}` 在任何版本都没声明。',
  ].join('\n');
  const ctx = { ...BASE_CTX, version: null, readmePath: 'demo/README.md',
    readmeRaw: raw100,
    versionDocs: [{ additionalProperties: { formFields: [{ envKey: 'PANEL_APP_PORT_HTTP' }] } }] };
  const out = checkReadmeVars(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].ruleId, 'readme.vars');
  assert.equal(out[0].actual, '${MAGIC_WORD}');
  assert.equal(out[0].version, null);
});

test('规则全表与 RULE_IDS 一致性', () => {
  assert.ok(Object.keys(RULES).length === RULE_IDS.size);
  for (const [id, meta] of Object.entries(RULES)) assert.ok(RULE_IDS.has(id));
  assert.equal(RULES['var.undeclared'].severity, 'P0');
  assert.equal(RULES['form.type-default'].severity, 'P1');
});

// version=null（应用级上下文）也要能安全执行规则并输出合法 finding
test('version=null 时 runVersionChecks 正常输出带 version=null 的 var.undeclared', () => {
  const ctx = composeCtx('${APP_SECRET}', null, { version: null, versionDoc: null });
  const out = runVersionChecks(ctx);
  const v = out.find((f) => f.ruleId === 'var.undeclared');
  assert.ok(v, '应报出未声明变量');
  assert.equal(v.version, null);
});
