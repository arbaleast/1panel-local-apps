// .github/lib/deploy-compat.test.mjs
// 部署兼容性规则引擎（阶段 2 / 4 / 5 / 6）回归测试。
//
// 锁死的不变量：
//   1. 零误杀基线：正常应用 fixture（含变量型端口 / 相对路径卷）必须 0 findings；
//   2. 严禁误判端口冲突（两个服务都用容器内 8080 但映射不同 hostPort → 0 findings）；
//   3. 离线模式（manifests === null）下所有依赖 manifest 的规则 0 产出；
//   4. 每条 finding 的 ruleId 必须在 DEPLOY_COMPAT_RULES 中；
//   5. 每条 finding 的 severity 必须与规则表一致（runtime.high-privilege 允许升级态 P0）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOY_COMPAT_RULES,
  DEPLOY_COMPAT_RULE_IDS,
  runDeployCompatChecks,
  checkComposeRender,
  checkPortFormat,
  checkVolumeFormat,
  checkDepMissing,
  checkDeprecatedKey,
  checkNetworkConflict,
  checkHostNetworkPorts,
  checkHighPrivilegeExtra,
  checkGpuUnconditional,
  checkGpuGatedDefaultOn,
  checkGpuDocumented,
  checkGpuDeviceGroupDoc,
  checkGpuVariantDir,
  checkHwDevicesMissing,
  checkPuidUnsupported,
  checkUserUnsupported,
  checkReadmeDrift,
  checkMountTarget,
  checkMountedSensitive,
  checkPathLeak,
  checkBom,
  checkDepExternalUndeclared,
  checkDepExternalMissing,
  checkDepReadyCondition,
  checkArchOverdeclared,
  checkArchUnderdeclared,
  checkArchBucketConflict,
  checkArchVersionDirMismatch,
  checkArchUnverified,
  archFromDirName,
  archOfPlatform,
  isGpuVariantDirName,
} from './deploy-compat.mjs';

const BASE = {
  app: 'demo',
  version: '1.0.0',
  composePath: 'demo/1.0.0/docker-compose.yml',
  dataPath: 'demo/1.0.0/data.yml',
  readmePath: 'demo/README.md',
};

/**
 * 构造 ctx。
 * @param {object} parts
 * @returns {object}
 */
function ctxOf(parts = {}) {
  return { ...BASE, ...parts };
}

/**
 * 按 ruleId 过滤 findings。
 * @param {Array<object>} findings
 * @param {string} ruleId
 * @returns {Array<object>}
 */
function byRule(findings, ruleId) {
  return findings.filter((f) => f.ruleId === ruleId);
}

// ─── 零误杀基线 ────────────────────────────────────────────────────────────

test('零误杀基线 1：正常应用 fixture 必须 0 findings', () => {
  const composeDoc = {
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
  const versionDoc = {
    additionalProperties: {
      formFields: [
        { envKey: 'PANEL_APP_PORT_HTTP', type: 'number', default: '8096', label: { en: 'HTTP port', zh: '端口' } },
      ],
    },
  };
  const ctx = ctxOf({
    composeDoc,
    versionDoc,
    composeRaw: 'services: app:',
    versionRaw: 'additionalProperties:',
    readmeRaw: '# demo\n',
    manifests: null,
  });
  const findings = runDeployCompatChecks(ctx);
  assert.deepEqual(findings, [], `期望 0 findings，实际：${JSON.stringify(findings, null, 2)}`);
});

test('零误杀基线 2：三段变量端口 + 两服务同容器端口不同 hostPort → 0 findings（严禁误判端口冲突）', () => {
  const composeDoc = {
    services: {
      app: {
        image: 'repo/app:1.0.0',
        container_name: '${CONTAINER_NAME}',
        restart: 'always',
        networks: ['1panel-network'],
        labels: { createdBy: 'Apps' },
        ports: ['${HOST_IP}:${PANEL_APP_PORT_HTTP}:${INTERNAL_PORT}'],
        volumes: ['./data:/data'],
      },
      sidecar: {
        image: 'repo/sidecar:1.0.0',
        restart: 'always',
        networks: ['1panel-network'],
        labels: { createdBy: 'Apps' },
        ports: ['${HOST_IP}:${PANEL_APP_PORT_HTTP_B}:8080'],
      },
    },
    networks: { '1panel-network': { external: true } },
  };
  const versionDoc = {
    additionalProperties: {
      formFields: [
        { envKey: 'PANEL_APP_PORT_HTTP', type: 'number', default: '8096', label: { en: 'A', zh: 'A' } },
        { envKey: 'PANEL_APP_PORT_HTTP_B', type: 'number', default: '8097', label: { en: 'B', zh: 'B' } },
        { envKey: 'INTERNAL_PORT', type: 'number', default: '8080', label: { en: 'C', zh: 'C' } },
      ],
    },
  };
  const ctx = ctxOf({ composeDoc, versionDoc, composeRaw: 'services:', versionRaw: 'x', readmeRaw: '# demo', manifests: null });
  const findings = runDeployCompatChecks(ctx);
  assert.deepEqual(findings, [], `期望 0 findings，实际：${JSON.stringify(findings, null, 2)}`);
});

// ─── 阶段 2 ────────────────────────────────────────────────────────────────

test('compose.render：${VAR:?msg} 未声明 → P0', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1', environment: { MODE: '${GPU_MODE:?必须设置模式}' } } } },
    versionDoc: { additionalProperties: { formFields: [] } },
  });
  const f = checkComposeRender(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, 'compose.render');
  assert.equal(f[0].severity, 'P0');
  assert.ok(f[0].message.includes('必须设置模式'));
});

test('port.format：非法端口串 → P1；变量形态 → 0', () => {
  const bad = ctxOf({ composeDoc: { services: { app: { ports: [':80', '70000:80', '80/sctpx', '80:'] } } } });
  const f = checkPortFormat(bad);
  assert.ok(f.length >= 4);
  for (const x of f) assert.equal(x.severity, 'P1');

  const good = ctxOf({
    composeDoc: { services: { app: { ports: ['${HOST_IP}:${PANEL_APP_PORT_HTTP}:8096', '9000', '127.0.0.1:8080:80/udp'] } } },
  });
  assert.deepEqual(checkPortFormat(good), []);
});

test('volume.format：缺 target / target 非绝对路径 / 命名卷未声明 → P1', () => {
  const ctx = ctxOf({
    composeDoc: {
      services: {
        app: {
          volumes: ['mydata', './data:relative', 'myvol:/data', './data:/data:badmode'],
        },
      },
    },
  });
  const f = checkVolumeFormat(ctx);
  assert.ok(f.length >= 4);
  for (const x of f) assert.equal(x.severity, 'P1');
  const named = f.find((x) => x.message.includes('myvol'));
  assert.ok(named, '命名卷未声明应报错');
  // 顶层声明后消音
  const ok = ctxOf({
    composeDoc: { services: { app: { volumes: ['myvol:/data'] } }, volumes: { myvol: {} } },
  });
  assert.deepEqual(checkVolumeFormat(ok), []);
});

test('compose.dep-missing：depends_on 指向不存在服务 → P1', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1', depends_on: ['db'] } } },
  });
  const f = checkDepMissing(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');
  assert.equal(f[0].ruleId, 'compose.dep-missing');
});

test('compose.deprecated-key / network-conflict / host-network-ports', () => {
  const dep = ctxOf({ composeDoc: { version: '3.8', services: { app: { links: ['other'] } } } });
  const f = checkDeprecatedKey(dep);
  assert.equal(f.length, 2);
  for (const x of f) assert.equal(x.severity, 'P2');

  const conflict = ctxOf({ composeDoc: { services: { app: { network_mode: 'host', networks: ['1panel-network'] } } } });
  const cf = checkNetworkConflict(conflict);
  assert.equal(cf.length, 1);
  assert.equal(cf[0].severity, 'P1');

  const hostPorts = ctxOf({ composeDoc: { services: { app: { network_mode: 'host', ports: ['8080:80'] } } } });
  const hf = checkHostNetworkPorts(hostPorts);
  assert.equal(hf.length, 1);
  assert.equal(hf[0].severity, 'P2');
});

test('runtime.high-privilege：privileged + host 网络 → P0；单独 ipc: host → P2', () => {
  const esc = ctxOf({ composeDoc: { services: { app: { privileged: true, network_mode: 'host' } } } });
  const ef = checkHighPrivilegeExtra(esc);
  assert.equal(ef.length, 1);
  assert.equal(ef[0].severity, 'P0');
  assert.ok(ef[0].message.includes('特权容器 + host 网络叠加'));

  const ipc = ctxOf({ composeDoc: { services: { app: { ipc: 'host' } } } });
  const inf = checkHighPrivilegeExtra(ipc);
  assert.equal(inf.length, 1);
  assert.equal(inf[0].severity, 'P2');
  assert.equal(inf[0].actual, 'ipc: host');
});

// ─── 阶段 4 ────────────────────────────────────────────────────────────────

test('gpu.unconditional：非白名单 + 字面 runtime → P1；白名单 / 变量化 → 不报', () => {
  const hard = ctxOf({ app: 'jellyfin', composeDoc: { services: { app: { runtime: 'nvidia' } } } });
  const f = checkGpuUnconditional(hard);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');

  const wl = ctxOf({ app: 'llamacpp', composeDoc: { services: { app: { runtime: 'nvidia' } } } });
  assert.deepEqual(checkGpuUnconditional(wl), []);

  const soft = ctxOf({ app: 'jellyfin', composeDoc: { services: { app: { runtime: '${GPU_RUNTIME}' } } } });
  assert.deepEqual(checkGpuUnconditional(soft), []);
});

test('gpu.gated-default-on：变量化 + default=nvidia → P2；default 为空 → 不报', () => {
  const on = ctxOf({
    app: 'jellyfin',
    composeDoc: { services: { app: { runtime: '${GPU_RUNTIME}' } } },
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'GPU_RUNTIME', type: 'select', default: 'nvidia' }] } },
  });
  const f = checkGpuGatedDefaultOn(on);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
  assert.ok(f[0].message.includes('默认值 nvidia'));
  assert.ok(f[0].message.includes('默认开启'));

  const off = ctxOf({
    app: 'jellyfin',
    composeDoc: { services: { app: { runtime: '${GPU_RUNTIME}' } } },
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'GPU_RUNTIME', type: 'select', default: '' }] } },
  });
  assert.deepEqual(checkGpuGatedDefaultOn(off), []);
});

test('gpu.documented：有 GPU 信号 + README 无 nvidia → P1；README 有 → 不报', () => {
  const noDoc = ctxOf({
    app: 'jellyfin',
    composeDoc: { services: { app: { runtime: 'nvidia' } } },
    readmeRaw: '# jellyfin\n普通应用\n',
  });
  const f = checkGpuDocumented(noDoc);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');

  const doc = ctxOf({
    app: 'jellyfin',
    composeDoc: { services: { app: { runtime: 'nvidia' } } },
    readmeRaw: '# jellyfin\n需要安装 nvidia-container-toolkit\n',
  });
  assert.deepEqual(checkGpuDocumented(doc), []);
});

test('gpu.device-group-doc：/dev/dri 无 render/video 说明 → P2', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { devices: ['/dev/dri:/dev/dri'] } } },
    readmeRaw: '# app\n',
  });
  const f = checkGpuDeviceGroupDoc(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

test('gpu.variant-dir：server-cuda12-v0.4.9 → P3（UNVERIFIED）', () => {
  const ctx = ctxOf({ version: 'server-cuda12-v0.4.9', composeDoc: { services: { app: { image: 'x:1' } } } });
  const f = checkGpuVariantDir(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P3');
  assert.ok(f[0].message.includes('UNVERIFIED'));
  assert.ok(isGpuVariantDirName('gpu-nvidia-latest'));
  assert.ok(isGpuVariantDirName('cu124'));
  assert.ok(!isGpuVariantDirName('1.0.0'));
});

test('hw.devices-missing：/dev/net/tun → P2', () => {
  const ctx = ctxOf({ composeDoc: { services: { app: { devices: ['/dev/net/tun:/dev/net/tun'] } } } });
  const f = checkHwDevicesMissing(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

// ─── 阶段 5 ────────────────────────────────────────────────────────────────

test('identity.puid-unsupported：有 imageConfig 且无 PUID → P2；有 PUID → 不报；manifests=null → 不产出', () => {
  const composeDoc = { services: { app: { image: 'repo/app:1.0.0', environment: { PUID: '1000' } } } };
  const noPuid = ctxOf({
    composeDoc,
    manifests: new Map([['repo/app:1.0.0', { status: 'ok', imageConfig: { env: ['PATH=/usr/bin'] } }]]),
  });
  const f = checkPuidUnsupported(noPuid);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');

  const withPuid = ctxOf({
    composeDoc,
    manifests: new Map([['repo/app:1.0.0', { status: 'ok', imageConfig: { env: ['PUID=1000', 'PGID=1000'] } }]]),
  });
  assert.deepEqual(checkPuidUnsupported(withPuid), []);

  const offline = ctxOf({ composeDoc, manifests: null });
  assert.deepEqual(checkPuidUnsupported(offline), []);
});

test('identity.user-unsupported：字面非 root + 镜像默认 root → P1；变量 user → 不报', () => {
  const manifests = new Map([['repo/app:1.0.0', { status: 'ok', imageConfig: { user: '', env: [] } }]]);
  const ctx = ctxOf({ composeDoc: { services: { app: { image: 'repo/app:1.0.0', user: '1001:1001' } } }, manifests });
  const f = checkUserUnsupported(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');

  const varCtx = ctxOf({ composeDoc: { services: { app: { image: 'repo/app:1.0.0', user: '${UID}:${GID}' } } }, manifests });
  assert.deepEqual(checkUserUnsupported(varCtx), []);
});

test('identity.readme-drift：README 提 PUID 但 compose 无 → P2', () => {
  const ctx = ctxOf({ composeDoc: { services: { app: { image: 'x:1' } } }, readmeRaw: '设置 PUID=1000 即可\n' });
  const f = checkReadmeDrift(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

test('volume.mount-target：宿主/容器目录名不一致 → P2；一致 → 不报', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { volumes: ['/opt/1panel/apps/demo:/data'] } } },
  });
  const f = checkMountTarget(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');

  const same = ctxOf({ composeDoc: { services: { app: { volumes: ['/opt/1panel/apps/demo:/demo'] } } } });
  assert.deepEqual(checkMountTarget(same), []);
});

test('volume.mounted-sensitive：target=/etc rw → P2；/etc/searxng → 不报', () => {
  const ctx = ctxOf({ composeDoc: { services: { app: { volumes: ['/host/etc:/etc'] } } } });
  const f = checkMountedSensitive(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');

  const sub = ctxOf({ composeDoc: { services: { app: { volumes: ['/host/etc:/etc/searxng'] } } } });
  assert.deepEqual(checkMountedSensitive(sub), []);

  const ro = ctxOf({ composeDoc: { services: { app: { volumes: ['/host/etc:/etc:ro'] } } } });
  assert.deepEqual(checkMountedSensitive(ro), []);
});

test('default.path-leak：开发者本机路径 → P1；/mnt/nfs/media、/dev/shm → 不报', () => {
  const leak = ctxOf({
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'CACHE_DIR', default: '/data/dsh/home/日常/1panel-local-apps/jellyfin-cache' }] } },
  });
  const f = checkPathLeak(leak);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');

  for (const okPath of ['/mnt/nfs/media', '/dev/shm', '/usr/share/fonts', '/opt/1panel/apps/demo/data', '/srv/data']) {
    const c = ctxOf({ versionDoc: { additionalProperties: { formFields: [{ envKey: 'DIR', default: okPath }] } } });
    assert.deepEqual(checkPathLeak(c), [], `${okPath} 不应被判为本机路径泄露`);
  }
});

test('parse.bom：compose/data.yml 带 BOM → P2', () => {
  const ctx = ctxOf({ composeRaw: '\uFEFFservices:\n', versionRaw: '\uFEFFadditionalProperties:\n' });
  const f = checkBom(ctx);
  assert.equal(f.length, 2);
  for (const x of f) assert.equal(x.severity, 'P2');
});

// ─── 阶段 6 ────────────────────────────────────────────────────────────────

test('dep.external-undeclared：POSTGRES_HOST 未声明 → P1；REDIS_PORT=6379 / DB_BACKEND=postgres → 不报', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1', environment: { POSTGRES_HOST: 'db.example.com', REDIS_PORT: '6379', DB_BACKEND: 'postgres' } } } },
    versionDoc: { additionalProperties: { formFields: [] } },
  });
  const f = checkDepExternalUndeclared(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P1');
  assert.ok(f[0].message.includes('POSTGRES_HOST'));
});

test('dep.external-missing：已声明的外部依赖但表单文案未说明 → P2', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1', environment: { POSTGRES_HOST: 'db.internal:5432' } } } },
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'POSTGRES_HOST', label: { en: 'Host', zh: '主机' } }] } },
  });
  const f = checkDepExternalMissing(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

// ─── 零误杀回归（2026-11 实测踩坑后锁定，禁止回退）────────────────────────
test('回归：派生连接串（值由其它 ${VAR} 拼装）不算「未声明的外部依赖」', () => {
  // 真实存量形态：REDIS_URL / POSTGRES_DSN / SQL_DSN 全是派生变量，
  // 组件变量才由 1Panel 注入 —— 派生变量本身不需要 formField。
  const ctx = ctxOf({
    composeDoc: {
      services: {
        app: {
          image: 'x:1',
          environment: {
            REDIS_URL: 'redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}',
            DATABASE_URL: 'postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}',
          },
        },
      },
    },
    versionDoc: {
      additionalProperties: {
        formFields: [
          { envKey: 'REDIS_PASSWORD' }, { envKey: 'REDIS_HOST' }, { envKey: 'REDIS_PORT' },
          { envKey: 'POSTGRES_USER' }, { envKey: 'POSTGRES_PASSWORD' },
          { envKey: 'POSTGRES_HOST' }, { envKey: 'POSTGRES_PORT' }, { envKey: 'POSTGRES_DB' },
        ],
      },
    },
  });
  assert.deepEqual(checkDepExternalUndeclared(ctx), []);
  assert.deepEqual(checkDepExternalMissing(ctx), []);
});

test('回归：镜像内置服务的凭据变量（MINIO_ROOT_USER=${MINIO_ROOT_USER}）不算外部依赖', () => {
  // silo：镜像 pgsty/silo 内置 MinIO，MINIO_ROOT_USER 是内部凭据，不是外部端点。
  const ctx = ctxOf({
    composeDoc: { services: { silo: { image: 'pgsty/silo:1', environment: { MINIO_ROOT_USER: '${MINIO_ROOT_USER}' } } } },
    versionDoc: { additionalProperties: { formFields: [{ envKey: 'MINIO_ROOT_USER', label: { en: 'Root user (S3 access key)' } }] } },
  });
  assert.deepEqual(checkDepExternalUndeclared(ctx), []);
  assert.deepEqual(checkDepExternalMissing(ctx), []);
});

test('回归：security_opt: no-new-privileges 是加固，不算高权限配置', () => {
  const ctx = ctxOf({
    composeDoc: {
      services: {
        app: { image: 'x:1', security_opt: ['no-new-privileges:true'] },
      },
    },
  });
  assert.deepEqual(checkHighPrivilegeExtra(ctx), []);
});

test('回归：security_opt: seccomp:unconfined 是削弱沙箱，必须报', () => {
  const ctx = ctxOf({
    composeDoc: {
      services: {
        app: { image: 'x:1', security_opt: ['seccomp:unconfined'] },
      },
    },
  });
  const f = checkHighPrivilegeExtra(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

test('回归：README 在否定语境里提 PUID/PGID（说明镜像不支持）不算文档漂移', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1' } } },
    readmeRaw: '官方镜像**没有** PUID/PGID 支持（Dockerfile 无 `USER` 指令），所以**不要**在 compose 里改写成 PUID/PGID。',
  });
  assert.deepEqual(checkReadmeDrift(ctx), []);
});

test('回归：README 正向提到 PUID/PGID 但 compose 没有 → 仍是漂移', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'x:1' } } },
    readmeRaw: '安装参数里设置 PUID 与 PGID 即可切换容器内身份。',
  });
  const f = checkReadmeDrift(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');
});

test('dep.ready-condition：依赖目标无 healthcheck → P2；有 healthcheck → 不报', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { depends_on: ['db'] }, db: { image: 'postgres:16' } } },
  });
  const f = checkDepReadyCondition(ctx);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P2');

  const healthy = ctxOf({
    composeDoc: { services: { app: { depends_on: ['db'] }, db: { image: 'postgres:16', healthcheck: { test: ['CMD', 'true'] } } } },
  });
  assert.deepEqual(checkDepReadyCondition(healthy), []);
});

// ─── 阶段 3：架构 ──────────────────────────────────────────────────────────

test('arch：overdeclared / underdeclared / bucket-conflict / versiondir-mismatch / unverified', () => {
  const one = ctxOf({
    composeDoc: { services: { app: { image: 'repo/app:1.0.0' } } },
    rootDoc: { additionalProperties: { architectures: ['amd64', 'arm64'] } },
    manifests: new Map([['repo/app:1.0.0', { status: 'ok', platforms: ['linux/amd64'] }]]),
  });
  const over = checkArchOverdeclared(one);
  assert.equal(over.length, 1);
  assert.equal(over[0].severity, 'P1');
  assert.ok(over[0].message.includes('arm64'));
  assert.deepEqual(checkArchUnderdeclared(one), []);

  const two = ctxOf({
    composeDoc: { services: { app: { image: 'repo/app:1.0.0' } } },
    rootDoc: { additionalProperties: { architectures: ['amd64'] } },
    manifests: new Map([['repo/app:1.0.0', { status: 'ok', platforms: ['linux/amd64', 'linux/arm64'] }]]),
  });
  const under = checkArchUnderdeclared(two);
  assert.equal(under.length, 1);
  assert.equal(under[0].severity, 'P2');

  const bucket = ctxOf({
    composeDoc: { services: { app: { image: 'a:1' }, side: { image: 'b:1' } } },
    manifests: new Map([
      ['a:1', { status: 'ok', platforms: ['linux/amd64'] }],
      ['b:1', { status: 'ok', platforms: ['linux/arm64'] }],
    ]),
  });
  const bf = checkArchBucketConflict(bucket);
  assert.equal(bf.length, 1);
  assert.equal(bf[0].severity, 'P1');

  const mismatch = ctxOf({
    version: '1.0.0-arm64',
    composeDoc: { services: { app: { image: 'a:1' } } },
    manifests: new Map([['a:1', { status: 'ok', platforms: ['linux/amd64'] }]]),
  });
  const mf = checkArchVersionDirMismatch(mismatch);
  assert.equal(mf.length, 1);
  assert.equal(mf[0].severity, 'P1');

  const unver = ctxOf({
    composeDoc: { services: { app: { image: 'a:1' } } },
    manifests: new Map([['a:1', { status: 'unverified', reason: 'registry 网络不可达' }]]),
  });
  const uf = checkArchUnverified(unver);
  assert.equal(uf.length, 1);
  assert.equal(uf[0].severity, 'P3');
  assert.ok(uf[0].message.includes('registry 网络不可达'));
  assert.ok(uf[0].message.includes('a:1'));
});

test('arch 辅助函数', () => {
  assert.equal(archFromDirName('1.0.0-arm64'), 'arm64');
  assert.equal(archFromDirName('1.0.0-arm64v8'), 'arm64');
  assert.equal(archFromDirName('1.0.0-arm32v7'), 'arm/v7');
  assert.equal(archFromDirName('1.0.0-arm32v6'), null);
  assert.equal(archFromDirName('1.0.0'), null);
  assert.equal(archOfPlatform('linux/arm/v7'), 'arm/v7');
  assert.equal(archOfPlatform('linux/amd64'), 'amd64');
});

// ─── 通用不变量 ────────────────────────────────────────────────────────────

test('离线模式（manifests === null）：依赖 manifest 的规则 0 产出', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: 'repo/app:1.0.0', user: '1001:1001', environment: { PUID: '1000' } } } },
    rootDoc: { additionalProperties: { architectures: ['amd64'] } },
    manifests: null,
  });
  const findings = runDeployCompatChecks(ctx);
  const manifestRules = ['identity.puid-unsupported', 'identity.user-unsupported', 'arch.overdeclared', 'arch.underdeclared', 'arch.bucket-conflict', 'arch.versiondir-mismatch', 'arch.unverified'];
  for (const r of manifestRules) {
    assert.deepEqual(byRule(findings, r), [], `${r} 在离线模式不应产出`);
  }
});

test('所有产出的 finding：ruleId 必须登记且 severity 与规则表一致', () => {
  const fixtures = [
    ctxOf({ composeDoc: { services: { app: { image: 'x:1', ports: [':80'], volumes: ['mydata'], runtime: 'nvidia', devices: ['/dev/net/tun'], network_mode: 'host', privileged: true, ipc: 'host' } } } }),
    ctxOf({
      app: 'jellyfin',
      version: 'server-cuda12-v0.4.9',
      composeDoc: { services: { app: { image: 'x:1', runtime: '${GPU_RUNTIME}', devices: ['/dev/dri:/dev/dri'], depends_on: ['db'] }, db: { image: 'y:1' } } },
      versionDoc: { additionalProperties: { formFields: [{ envKey: 'GPU_RUNTIME', default: 'nvidia' }, { envKey: 'DIR', default: '/root/secret' }] } },
      readmeRaw: 'PUID 说明',
    }),
    ctxOf({
      composeDoc: { services: { app: { image: 'x:1', environment: { POSTGRES_HOST: 'db' }, user: '1001:1001' } } },
      rootDoc: { additionalProperties: { architectures: ['amd64', 'arm64'] } },
      manifests: new Map([['x:1', { status: 'unverified', reason: 'timeout' }]]),
      composeRaw: '\uFEFFservices:',
    }),
  ];
  const all = fixtures.flatMap((c) => runDeployCompatChecks(c));
  assert.ok(all.length > 0, 'fixture 至少应产出若干 findings');
  for (const f of all) {
    assert.ok(DEPLOY_COMPAT_RULE_IDS.includes(f.ruleId), `未登记的 ruleId: ${f.ruleId}`);
    const meta = DEPLOY_COMPAT_RULES[f.ruleId];
    const allowed = new Set([meta.severity]);
    if (meta.escalationSeverity) allowed.add(meta.escalationSeverity);
    assert.ok(allowed.has(f.severity), `${f.ruleId} severity=${f.severity} 与规则表 ${[...allowed].join('/')} 不一致`);
    for (const k of ['severity', 'ruleId', 'app', 'version', 'file', 'line', 'message', 'actual', 'expected']) {
      assert.ok(k in f, `finding 缺少字段 ${k}`);
    }
  }
});

// ─── 回归：变量型镜像必须先解析再查 manifest（2026-11 实测踩坑）───────────
test('回归：变量型镜像按 formFields default 解析后再查 manifest（否则误标架构未验证）', () => {
  // 真实存量形态：xunlei/beta 的 `image: ${IMAGE}:${APP_VERSION}`
  const manifests = new Map([
    ['ghcr.io/cnk3x/xunlei:beta', { status: 'ok', kind: 'index', platforms: ['amd64', 'arm64'] }],
  ]);
  const ctx = ctxOf({
    composeDoc: { services: { xunlei: { image: '${IMAGE}:${APP_VERSION}' } } },
    versionDoc: {
      additionalProperties: {
        formFields: [
          { envKey: 'IMAGE', default: 'ghcr.io/cnk3x/xunlei' },
          { envKey: 'APP_VERSION', default: 'beta' },
        ],
      },
    },
    manifests,
  });
  // 解析成功 → 不应产生 arch.unverified
  assert.deepEqual(byRule(runDeployCompatChecks(ctx), 'arch.unverified'), []);
});

test('回归：变量型镜像无法解析时不得静默当成「已验证」', () => {
  const ctx = ctxOf({
    composeDoc: { services: { app: { image: '${IMAGE}:${APP_VERSION}' } } },
    versionDoc: { additionalProperties: { formFields: [] } },
    manifests: new Map(),
  });
  const f = byRule(runDeployCompatChecks(ctx), 'arch.unverified');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'P3');
});
