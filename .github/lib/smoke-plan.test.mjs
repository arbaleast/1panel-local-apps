// .github/lib/smoke-plan.test.mjs
// 隔离沙箱冒烟测试的**纯函数核心**回归测试。
//
// 锁死的不变量：
//   1. 零误杀基线：普通单容器 fixture → detectSkipConditions 返回 []，plan.skip === false；
//   2. 隔离铁律：重写后的 compose 里**不得**出现 `external: true` / `1panel-network`
//      / 任何原始宿主机绝对挂载路径；
//   3. 端口必须由调用方预先分配（缺映射必须抛错，绝不静默沿用原端口）；
//   4. 输入 composeDoc **不得**被原地修改；
//   5. 变量型 source 不算 unsafe-host-path（会被重写到临时目录）；
//      同 compose 内置同技术栈服务不算 external-database。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP_CONDITIONS,
  splitRespectingBraces,
  placeholderVarName,
  detectSkipConditions,
  buildSmokePlan,
} from './smoke-plan.mjs';

const PROJECT = '1panel_smoke_demo_1700000000';
const TEST_NET = '1panel_smoke_net_1700000000';
const TMP_DIR = '/tmp/1panel_smoke/demo_1700000000';

/**
 * 普通单容器 fixture（nginx 风格）——零误杀基线。
 * @returns {object}
 */
function plainCompose() {
  return {
    services: {
      app: {
        image: 'nginx:1.25',
        container_name: '${CONTAINER_NAME}',
        restart: 'always',
        networks: ['1panel-network'],
        labels: { createdBy: 'Apps' },
        ports: ['${HOST_IP}:${PANEL_APP_PORT_HTTP}:80'],
        volumes: ['./data:/data'],
      },
    },
    networks: { '1panel-network': { external: true } },
  };
}

/**
 * 构造 buildSmokePlan 的默认参数。
 * @param {object} parts
 * @returns {object}
 */
function planParams(parts = {}) {
  return {
    app: 'demo',
    version: '1.0.0',
    composeDoc: plainCompose(),
    env: { CONTAINER_NAME: 'demo', HOST_IP: '127.0.0.1', PANEL_APP_PORT_HTTP: '8096' },
    projectName: PROJECT,
    testNetwork: TEST_NET,
    tmpDir: TMP_DIR,
    portMap: { PANEL_APP_PORT_HTTP: 38096 },
    ...parts,
  };
}

// ─── A. splitRespectingBraces ──────────────────────────────────────────────

test('splitRespectingBraces：普通串按冒号切分', () => {
  assert.deepEqual(splitRespectingBraces('a:b:c'), ['a', 'b', 'c']);
});

test('splitRespectingBraces：占位符内部的冒号不算分隔符', () => {
  assert.deepEqual(splitRespectingBraces('${VAR:-1}:80'), ['${VAR:-1}', '80']);
});

test('splitRespectingBraces：连接串里的冒号按非占位符位置切分', () => {
  const parts = splitRespectingBraces('redis://:${PASS}@host:6379');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'redis');
  assert.equal(parts[2], '${PASS}@host');
  assert.equal(parts[3], '6379');
});

// ─── B. placeholderVarName ─────────────────────────────────────────────────

test('placeholderVarName：提取变量名（支持默认值形态）', () => {
  assert.equal(placeholderVarName('${VAR}'), 'VAR');
  assert.equal(placeholderVarName('${VAR:-def}'), 'VAR');
  assert.equal(placeholderVarName('${VAR-def}'), 'VAR');
});

test('placeholderVarName：无占位符返回 null', () => {
  assert.equal(placeholderVarName('/opt/1panel/data'), null);
  assert.equal(placeholderVarName(''), null);
});

// ─── C. detectSkipConditions 正例 ──────────────────────────────────────────

test('detectSkipConditions：字面 runtime=nvidia → gpu-hardware', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { jellyfin: { image: 'x:1', runtime: 'nvidia' } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.GPU);
  assert.ok(out[0].reason.includes('services.jellyfin: runtime=nvidia'));
});

test('detectSkipConditions：deploy.resources.reservations.devices driver=nvidia → gpu-hardware', () => {
  const out = detectSkipConditions({
    composeDoc: {
      services: {
        app: {
          image: 'x:1',
          deploy: { resources: { reservations: { devices: [{ driver: 'nvidia', count: 1 }] } } },
        },
      },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.GPU);
  assert.ok(out[0].reason.includes('driver=nvidia'));
});

test('detectSkipConditions：devices 含 /dev/dri → gpu-hardware', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', devices: ['/dev/dri:/dev/dri'] } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.GPU);
});

test('detectSkipConditions：版本目录名命中 GPU 变体 → gpu-hardware', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1' } } },
    versionDir: 'server-cuda12-v0.4.9',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.GPU);
  assert.ok(out[0].reason.includes('server-cuda12-v0.4.9'));
});

test('detectSkipConditions：环境变量指向外部 postgres 端点 → external-database', () => {
  const out = detectSkipConditions({
    composeDoc: {
      services: {
        app: { image: 'nginx:1.25', environment: { POSTGRES_URL: 'postgresql://u:p@h:5432/db' } },
      },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.EXTERNAL_DB);
  assert.ok(out[0].reason.includes('POSTGRES_URL'));
});

test('detectSkipConditions：network_mode=host → host-network', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', network_mode: 'host' } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.HOST_NETWORK);
});

test('detectSkipConditions：privileged=true → privileged', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', privileged: true } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.PRIVILEGED);
});

test('detectSkipConditions：字面量宿主机绝对路径挂载 → unsafe-host-path', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', volumes: ['/home/al/x:/etc/x'] } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.UNSAFE_HOST_PATH);
  assert.ok(out[0].reason.includes('/home/al/x'));
});

test('detectSkipConditions：devices 含 /dev/net/tun → missing-device', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', devices: ['/dev/net/tun:/dev/net/tun'] } } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, SKIP_CONDITIONS.MISSING_DEVICE);
});

// ─── D. detectSkipConditions 反例 ──────────────────────────────────────────

test('detectSkipConditions 反例：变量型 source 不算 unsafe-host-path', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', volumes: ['${DATA_PATH}:/data'] } } },
  });
  assert.deepEqual(out, []);
});

test('detectSkipConditions 反例：同 compose 内置 postgres 服务不算 external-database', () => {
  const out = detectSkipConditions({
    composeDoc: {
      services: {
        app: { image: 'nginx:1.25', environment: { DATABASE_URL: 'postgresql://u:p@db:5432/db' } },
        db: { image: 'postgres:16', environment: { POSTGRES_PASSWORD: 'x' } },
      },
    },
  });
  assert.deepEqual(out, []);
});

test('detectSkipConditions 反例：runtime 为变量不算 gpu-hardware', () => {
  const out = detectSkipConditions({
    composeDoc: { services: { app: { image: 'x:1', runtime: '${GPU_RUNTIME}' } } },
  });
  assert.deepEqual(out, []);
});

test('detectSkipConditions 零误杀基线：普通单容器 fixture 返回 []', () => {
  const out = detectSkipConditions({ composeDoc: plainCompose() });
  assert.deepEqual(out, [], `期望 0 条跳过条件，实际：${JSON.stringify(out, null, 2)}`);
});

// ─── E. buildSmokePlan 重写 ────────────────────────────────────────────────

test('buildSmokePlan：container_name 重写为冒烟 project 名', () => {
  const plan = buildSmokePlan(planParams());
  assert.equal(plan.composeDoc.services.app.container_name, PROJECT);

  const suffix = buildSmokePlan(
    planParams({
      composeDoc: {
        services: { app: { image: 'x:1', container_name: '${CONTAINER_NAME}-worker' } },
      },
    }),
  );
  assert.equal(suffix.composeDoc.services.app.container_name, `${PROJECT}-worker`);
});

test('buildSmokePlan：顶层 networks 被替换为非 external 的 bridge 网络', () => {
  const plan = buildSmokePlan(planParams());
  assert.deepEqual(plan.composeDoc.networks, { [TEST_NET]: { name: TEST_NET, driver: 'bridge' } });
  const dump = JSON.stringify(plan.composeDoc);
  assert.ok(!dump.includes('external'), '重写结果里不得出现 external');
  assert.ok(!dump.includes('1panel-network'), '重写结果里不得出现 1panel-network');
  assert.deepEqual(plan.composeDoc.services.app.networks, [TEST_NET]);
});

test('buildSmokePlan：服务级 networks 对象形态保留 aliases', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: {
        services: {
          app: { image: 'x:1', networks: { '1panel-network': { aliases: ['app'] } } },
        },
      },
    }),
  );
  assert.deepEqual(plan.composeDoc.services.app.networks, { [TEST_NET]: { aliases: ['app'] } });
  assert.ok(!JSON.stringify(plan.composeDoc).includes('1panel-network'));
});

test('buildSmokePlan：变量型三段端口 → 127.0.0.1:<映射端口>，容器端口保留', () => {
  const plan = buildSmokePlan(planParams());
  assert.equal(plan.composeDoc.services.app.ports[0], '127.0.0.1:38096:80');
  const rec = plan.ports[0];
  assert.equal(rec.service, 'app');
  assert.equal(rec.hostPort, 38096);
  assert.equal(rec.containerPort, '80');
  assert.equal(rec.kind, 'host-published');
});

test('buildSmokePlan：字面量宿主机端口走 #literal:<service>:<index> 合成键', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', ports: ['8080:80'] } } },
      portMap: { '#literal:app:0': 39080 },
    }),
  );
  assert.equal(plan.composeDoc.services.app.ports[0], '127.0.0.1:39080:80');
  assert.equal(plan.ports[0].hostPort, 39080);
});

test('buildSmokePlan：容器端口段是变量时保持原样', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', ports: ['${HOST_IP}:${P}:${INTERNAL}'] } } },
      portMap: { P: 38111 },
    }),
  );
  assert.equal(plan.composeDoc.services.app.ports[0], '127.0.0.1:38111:${INTERNAL}');
  assert.equal(plan.ports[0].containerPort, '${INTERNAL}');
});

test('buildSmokePlan：仅容器端口的声明保持不变', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', ports: ['9000'] } } },
    }),
  );
  assert.equal(plan.composeDoc.services.app.ports[0], '9000');
  assert.equal(plan.ports[0].kind, 'container-only');
  assert.equal(plan.ports[0].hostPort, 0);
});

test('buildSmokePlan：端口未分配时必须抛错（绝不沿用原端口）', () => {
  assert.throws(
    () => buildSmokePlan(planParams({ portMap: {} })),
    /冒烟端口未分配/,
  );
  assert.throws(
    () =>
      buildSmokePlan(
        planParams({
          composeDoc: { services: { app: { image: 'x:1', ports: ['8080:80'] } } },
          portMap: {},
        }),
      ),
    /冒烟端口未分配/,
  );
});

test('buildSmokePlan：相对路径卷重写到临时目录', () => {
  const plan = buildSmokePlan(planParams());
  assert.equal(plan.composeDoc.services.app.volumes[0], `${TMP_DIR}/app/data:/data`);
  assert.equal(plan.mounts[0].kind, 'relative');
  assert.equal(plan.mounts[0].rewritten, `${TMP_DIR}/app/data`);
});

test('buildSmokePlan：变量型卷 source 重写到临时目录（用变量名，不用 env 真实值）', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', volumes: ['${DATA_PATH}:/data'] } } },
      env: { DATA_PATH: '/opt/1panel/apps/demo/data' },
    }),
  );
  assert.equal(plan.composeDoc.services.app.volumes[0], `${TMP_DIR}/app/DATA_PATH:/data`);
  assert.equal(plan.mounts[0].kind, 'variable');
});

test('buildSmokePlan：具名卷改名为 <projectName>_<name>，顶层 volumes 键同步改名', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: {
        services: { app: { image: 'x:1', volumes: ['myvol:/data'] } },
        volumes: { myvol: {} },
      },
    }),
  );
  assert.equal(plan.composeDoc.services.app.volumes[0], `${PROJECT}_myvol:/data`);
  assert.deepEqual(Object.keys(plan.composeDoc.volumes), [`${PROJECT}_myvol`]);
  assert.equal(plan.mounts[0].kind, 'named-volume');
});

test('buildSmokePlan：重写结果不含任何原始宿主机绝对挂载源', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: {
        services: {
          app: {
            image: 'x:1',
            volumes: ['./data:/data', '${DATA_PATH}:/cfg', 'myvol:/var/lib'],
          },
        },
        volumes: { myvol: {} },
      },
      env: { DATA_PATH: '/opt/1panel/apps/demo/real-data' },
    }),
  );
  // 挂载源（composeDoc + mounts）里不得出现 env 的真实绝对路径
  const mountDump = JSON.stringify({ composeDoc: plan.composeDoc, mounts: plan.mounts });
  assert.ok(
    !mountDump.includes('/opt/1panel/apps/demo/real-data'),
    `挂载源里泄漏了真实路径：${mountDump}`,
  );
  assert.ok(mountDump.includes(`${TMP_DIR}/app/DATA_PATH`));
  // ⚠️ plan.env 是**调用方 env 的原样副本**（模块契约如此），它里面的真实值不算挂载源泄漏。
  assert.equal(plan.env.DATA_PATH, '/opt/1panel/apps/demo/real-data');
});

test('buildSmokePlan：字面量宿主机绝对路径保留原值并标记 host-path（同时触发跳过）', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', volumes: ['/home/al/x:/etc/x'] } } },
    }),
  );
  assert.equal(plan.composeDoc.services.app.volumes[0], '/home/al/x:/etc/x');
  assert.equal(plan.mounts[0].kind, 'host-path');
  assert.equal(plan.mounts[0].rewritten, '/home/al/x');
  assert.equal(plan.skip, true);
  assert.ok(plan.skipReasons[0].startsWith('unsafe-host-path:'), plan.skipReasons[0]);
});

test('buildSmokePlan：输入 composeDoc 未被原地修改', () => {
  const input = plainCompose();
  const before = structuredClone(input);
  buildSmokePlan(planParams({ composeDoc: input }));
  assert.deepEqual(input, before);
});

test('buildSmokePlan：命中跳过条件时 skip=true 且 skipReasons 为可读串', () => {
  const plan = buildSmokePlan(
    planParams({
      composeDoc: { services: { app: { image: 'x:1', runtime: 'nvidia' } } },
    }),
  );
  assert.equal(plan.skip, true);
  assert.equal(plan.skipReasons.length, 1);
  assert.ok(plan.skipReasons[0].startsWith('gpu-hardware:'), plan.skipReasons[0]);
});

test('buildSmokePlan：env 是副本（内容相等但非同一对象）', () => {
  const env = { CONTAINER_NAME: 'demo', HOST_IP: '127.0.0.1', PANEL_APP_PORT_HTTP: '8096' };
  const plan = buildSmokePlan(planParams({ env }));
  assert.deepEqual(plan.env, env);
  assert.notStrictEqual(plan.env, env);
});

// ─── F. 端到端一致性 ───────────────────────────────────────────────────────

test('端到端：普通应用 fixture 不跳过且计划里有挂载与端口', () => {
  const composeDoc = plainCompose();
  assert.deepEqual(detectSkipConditions({ composeDoc }), []);
  const plan = buildSmokePlan(planParams({ composeDoc }));
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.skipReasons, []);
  assert.ok(plan.mounts.length >= 1);
  assert.ok(plan.ports.length >= 1);
  assert.equal(plan.projectName, PROJECT);
  assert.equal(plan.testNetwork, TEST_NET);
});
