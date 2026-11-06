// .github/lib/smoke-test.test.mjs
// 隔离沙箱实际部署冒烟测试（阶段 7）——**进程级**端到端回归测试。
//
// 本机**没有 docker daemon**，因此测试在 **PATH 之外**放一个**假 docker 可执行脚本**
// （`#!/bin/sh` + chmod 0o755），用它驱动 .github/bin/smoke-test.mjs 的完整 9 步流程。
//
// 锁死的不变量：
//   1. 9 步闭环：plan/config/pull/up/status/health/persist/logs/cleanup 全部 ok:true → PASSED；
//   2. **隔离铁律**：compose 用的是冒烟专用网络（非 1panel-network）、挂载源全在临时目录下、
//      临时目录跑完即删、清理必定执行 `down -v --remove-orphans`；
//   3. **条件跳过**（GPU / 外部 DB / host 网络 / 特权 / 真实路径）→ UNVERIFIED，
//      且**一次 docker 都不调用**（绝不因环境不具备而报 FAILED）；
//   4. **失败也必须清理**：`up` 失败 → FAILED，但清理照样跑（不留残留容器）；
//   5. **无 docker** → UNVERIFIED（skip.reason = 'no-docker'），不是 FAILED；
//   6. 单元：parsePsJson / collectPortKeys / sanitizeName 的解析口径。
//
// ⚠️ 关于「假 docker 放在哪」：
//   某些 CI 沙箱把 /tmp 挂成 `noexec`（本机就是如此）——放在 /tmp 的脚本无法被 spawn
//   （EACCES）。因此本文件**探测**一个可执行目录来放假 docker：优先 os.tmpdir()，
//   不可执行时回退到仓库内已 gitignore 的 `.agent_cache/`（CI 上 /tmp 通常可执行，
//   于是永远走第一分支 → 仓库内**不会**残留任何文件）。
//
// ⚠️ 关于「端口探活」：
//   被测实现里 health 步会**同时**做 healthcheck(inspect) 与宿主机端口 TCP 探活。
//   假 docker 起不了真容器，因此测试用一个**真实 TCP 监听器**占住分配到的端口，
//   让探活有东西可连 —— 这样 9 步才能真正全过（而不是靠少声明端口绕开）。

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import {
  SMOKE_STEPS,
  runSmokeTest,
  main,
  parsePsJson,
  collectPortKeys,
  sanitizeName,
} from '../bin/smoke-test.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 本文件产生的所有临时目录（测试结束后统一清理） */
const TEMP_DIRS = [];

/**
 * 登记一个临时目录，测试结束后由 after 钩子统一删除。
 * @param {string} dir
 * @returns {string}
 */
function trackTemp(dir) {
  TEMP_DIRS.push(dir);
  return dir;
}

// ─── 假 docker ─────────────────────────────────────────────────────────────

/** 假 docker 脚本正文（POSIX sh） */
const FAKE_DOCKER_SCRIPT = `#!/bin/sh
# 假 docker —— 把每次调用追加到 $FAKE_DOCKER_LOG，并按参数分支返回不同结果。
echo "$@" >> "$FAKE_DOCKER_LOG"

# 把被测实现写出来的 compose 文件复制一份留档（临时目录跑完就被删了）
for a in "$@"; do
  case "$a" in
    *.yml) if [ -f "$a" ]; then cp "$a" "$FAKE_COMPOSE_COPY" 2>/dev/null || true; fi;;
  esac
done

case "$*" in
  *"compose version"*) echo "Docker Compose version v2.29.0"; exit 0;;
  *"config -q"*) exit 0;;
  *pull*) exit 0;;
  *"up -d"*) if [ "$FAKE_FAIL_ON" = "up" ]; then echo "Error response from daemon: failed to start" >&2; exit 1; fi; exit 0;;
  *"ps --format json"*) echo '[{"Name":"app","Service":"app","State":"running","Status":"Up 3 seconds"}]'; exit 0;;
  *"logs"*)
    if [ "$FAKE_LOGS" = "denied" ]; then
      echo "app | mkdir: cannot create directory '/data': Permission denied"
    else
      echo "app | started fine"
    fi
    exit 0;;
  *"down"*) exit 0;;
  *inspect*) echo "healthy"; exit 0;;
esac
exit 0
`;

/**
 * 找一个**可执行**的目录来放假 docker。
 *
 * 某些沙箱把 /tmp 挂成 noexec（此时 /tmp 下的脚本 spawn 会 EACCES）；
 * 于是回退到仓库内已 gitignore 的 `.agent_cache/`。
 *
 * @returns {string} 可写的临时目录
 */
function pickExecutableTempDir() {
  const candidates = [];
  try {
    candidates.push(mkdtempSync(join(tmpdir(), 'smoke-fake-docker-')));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(mkdtempSync(join(REPO_ROOT, '.agent_cache', 'smoke-fake-docker-')));
  } catch {
    /* ignore */
  }
  if (!candidates.length) throw new Error('找不到可写临时目录');

  for (const dir of candidates) {
    const probe = join(dir, '.exec-probe');
    try {
      writeFileSync(probe, '#!/bin/sh\nexit 0\n');
      chmodSync(probe, 0o755);
      const r = spawnSync(probe, [], { encoding: 'utf8' });
      rmSync(probe, { force: true });
      if (r.status === 0) return trackTemp(dir);
    } catch {
      /* 该目录不可执行 → 试下一个 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  throw new Error('所有候选临时目录都不可执行（noexec 沙箱？）');
}

/**
 * 建一套「假 docker + 日志文件 + compose 留档」环境。
 * @returns {{dockerBin:string, logFile:string, composeCopy:string, dir:string}}
 */
function makeFakeDocker() {
  const dir = pickExecutableTempDir();
  const dockerBin = join(dir, 'docker');
  const logFile = join(dir, 'docker-calls.log');
  const composeCopy = join(dir, 'compose-written.yml');
  writeFileSync(dockerBin, FAKE_DOCKER_SCRIPT, 'utf8');
  chmodSync(dockerBin, 0o755);
  return { dockerBin, logFile, composeCopy, dir };
}

/**
 * 读取假 docker 的调用日志（文件不存在 = 一次都没被调用）。
 * @param {string} logFile
 * @returns {string}
 */
function readCalls(logFile) {
  if (!existsSync(logFile)) return '';
  return readFileSync(logFile, 'utf8');
}

/**
 * 读取被测实现写出来的那份 compose（重写后的隔离版）。
 * @param {string} composeCopy
 * @returns {string}
 */
function readWrittenCompose(composeCopy) {
  if (!existsSync(composeCopy)) return '';
  return readFileSync(composeCopy, 'utf8');
}

// ─── 应用 fixture ──────────────────────────────────────────────────────────

/** 版本级 data.yml（只声明一个端口表单字段） */
const FIXTURE_DATA_YML = `additionalProperties:
  key: myapp
  name: My App
  type: tool
  formFields:
    - envKey: PANEL_APP_PORT_HTTP
      type: number
      default: 8080
      label:
        en: HTTP port
        zh: HTTP 端口
`;

/**
 * 生成 fixture 的 compose（可追加行 / 开关 healthcheck）。
 * @param {{extra?:string, health?:boolean, ports?:string[]}} [opts]
 * @returns {string}
 */
function fixtureCompose(opts = {}) {
  const {
    extra = '',
    health = true,
    ports = ['${HOST_IP}:${PANEL_APP_PORT_HTTP}:80'],
  } = opts;
  const portLines = ports.map((p) => `    ports: ["${p}"]`).join('\n');
  const healthBlock = health
    ? `    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://127.0.0.1/ || exit 1"]
      interval: 30s
`
    : '';
  return `services:
  myapp:
    container_name: \${CONTAINER_NAME}
    image: nginx:1.25
    restart: always
    networks: [1panel-network]
    labels: { createdBy: Apps }
${portLines}
    volumes: ["./data:/data"]
${extra}${healthBlock}networks:
  1panel-network:
    external: true
`;
}

/**
 * 在临时目录里造一个最小应用（根目录 = 仓库根的角色）。
 * @param {{compose?:string, app?:string}} [opts]
 * @returns {string} 仓库根（临时）
 */
function makeAppRoot(opts = {}) {
  const app = opts.app ?? 'myapp';
  const root = trackTemp(mkdtempSync(join(tmpdir(), `smoke-root-${app}-`)));
  const vDir = join(root, app, '1.0.0');
  mkdirSync(vDir, { recursive: true });
  writeFileSync(join(vDir, 'data.yml'), FIXTURE_DATA_YML, 'utf8');
  writeFileSync(join(vDir, 'docker-compose.yml'), opts.compose ?? fixtureCompose(), 'utf8');
  return root;
}

/**
 * 起一个真实的 TCP 监听器，让 health 步的端口探活有东西可连。
 * @returns {Promise<{port:number, close:() => void}>}
 */
function startListener() {
  return new Promise((resolveListener) => {
    const srv = net.createServer();
    srv.on('error', () => resolveListener({ port: 0, close: () => {} }));
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolveListener({
        port,
        close: () => srv.close(),
      });
    });
  });
}

/**
 * 设置假 docker 依赖的环境变量（测完必须还原）。
 * @param {{logFile:string, composeCopy:string, failOn?:string, logs?:string}} spec
 * @returns {() => void} 还原函数
 */
function setFakeEnv(spec) {
  const saved = {
    FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG,
    FAKE_COMPOSE_COPY: process.env.FAKE_COMPOSE_COPY,
    FAKE_FAIL_ON: process.env.FAKE_FAIL_ON,
    FAKE_LOGS: process.env.FAKE_LOGS,
  };
  process.env.FAKE_DOCKER_LOG = spec.logFile;
  process.env.FAKE_COMPOSE_COPY = spec.composeCopy;
  process.env.FAKE_FAIL_ON = spec.failOn ?? '';
  process.env.FAKE_LOGS = spec.logs ?? '';
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ─── 单元测试（纯函数）──────────────────────────────────────────────────────

describe('parsePsJson：docker compose ps --format json 的多种形态', () => {
  it('数组形态 → 原样返回数组', () => {
    const out = parsePsJson('[{"Name":"app","Service":"app","State":"running","Status":"Up 3 seconds"}]');
    assert.equal(out.length, 1);
    assert.equal(out[0].Service, 'app');
    assert.equal(out[0].State, 'running');
  });

  it('单对象形态 → 包成单元素数组', () => {
    const out = parsePsJson('{"Name":"app","Service":"app","State":"running"}');
    assert.equal(out.length, 1);
    assert.equal(out[0].Name, 'app');
  });

  it('空串 / 空白 → 空数组', () => {
    assert.deepEqual(parsePsJson(''), []);
    assert.deepEqual(parsePsJson('   \n  '), []);
  });

  it('逐行 JSON → 每行一个对象；坏行被跳过', () => {
    const out = parsePsJson('{"a":1}\n{"b":2}\nnot-json\n{"c":3}');
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((x) => x.a ?? x.b ?? x.c), [1, 2, 3]);
  });
});

describe('collectPortKeys：需要分配宿主机端口的键', () => {
  it('变量宿主机端口 → 变量名；字面量 → 合成键；仅容器端口 → 不出现', () => {
    const keys = collectPortKeys({
      services: {
        a: { ports: ['${HOST_IP}:${P}:80', '9000', '8080:80'] },
      },
    });
    assert.ok(keys.includes('P'), `应包含变量名 P，实际 ${JSON.stringify(keys)}`);
    assert.ok(
      keys.includes('#literal:a:2'),
      `应包含合成键 #literal:a:2，实际 ${JSON.stringify(keys)}`,
    );
    assert.equal(
      keys.filter((k) => k === '#literal:a:1').length,
      0,
      '仅容器端口（9000）不应占宿主机端口',
    );
    assert.equal(
      keys.filter((k) => k === '#literal:a:0').length,
      0,
      '变量型宿主机端口不应产生合成键',
    );
  });

  it('无 ports 字段 → 空数组', () => {
    assert.deepEqual(collectPortKeys({ services: { a: {} } }), []);
    assert.deepEqual(collectPortKeys({}), []);
  });
});

describe('sanitizeName：compose 项目名字符集清洗', () => {
  it('非法字符 → 替换成 -；结果只含 [a-z0-9_-]', () => {
    assert.equal(sanitizeName('My App!'), 'my-app');
    assert.equal(sanitizeName('a.b.c'), 'a-b-c');
    for (const ch of sanitizeName('App 名字/1.0')) {
      assert.match(ch, /[a-z0-9_-]/, `非法字符残留: ${ch}`);
    }
  });

  it('空输入 → 兜底 app', () => {
    assert.equal(sanitizeName(''), 'app');
    assert.equal(sanitizeName(null), 'app');
  });
});

// ─── 9 步闭环（假 docker 驱动）──────────────────────────────────────────────

describe('runSmokeTest：假 docker 驱动的 9 步闭环', () => {
  it('9 步全过 → PASSED（且 9 个 step 全在、全 ok:true）', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv(fake);
    const root = makeAppRoot();
    const listener = await startListener();
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => listener.port,
        timeoutMs: 30000,
      });

      assert.equal(res.status, 'PASSED', `期望 PASSED，实际 ${res.status}\n${JSON.stringify(res.steps, null, 2)}`);
      assert.equal(res.app, 'myapp');
      assert.equal(res.version, '1.0.0');
      assert.match(res.projectName, /^1panel_smoke_myapp_\d+$/);

      // 九个步骤**按序**全在
      assert.deepEqual(
        res.steps.map((s) => s.step),
        [...SMOKE_STEPS],
        `steps 顺序应与 SMOKE_STEPS 一致，实际 ${JSON.stringify(res.steps.map((s) => s.step))}`,
      );
      for (const s of res.steps) {
        assert.equal(s.ok, true, `步骤 ${s.step} 应 ok:true，实际 detail=${s.detail}`);
        assert.equal(typeof s.detail, 'string');
        assert.ok(s.detail.length > 0, `步骤 ${s.step} 的 detail 不应为空`);
      }

      assert.equal(res.cleanup.ok, true);
      assert.equal(res.cleanup.tmpRemoved, true);
      assert.equal(res.cleanup.composeDownRan, true);
      assert.equal(res.skip, null);
    } finally {
      listener.close();
      restore();
    }
  });

  it('隔离铁律：冒烟网络 / 挂载源 / 临时目录 / 强制清理', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv(fake);
    const root = makeAppRoot();
    const listener = await startListener();
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => listener.port,
        timeoutMs: 30000,
      });
      assert.equal(res.status, 'PASSED');

      const calls = readCalls(fake.logFile);
      assert.ok(calls.length > 0, '假 docker 应被调用过');

      // ① 清理：必须执行 down -v --remove-orphans
      assert.match(calls, /down -v --remove-orphans/, '必须执行 compose down -v --remove-orphans');

      // ② compose 文件路径在临时目录下（1panel-smoke- 前缀）
      const composePath = /-f (\S+)/.exec(calls)?.[1];
      assert.ok(composePath, '应能从调用日志里解析出 -f 的 compose 路径');
      assert.match(composePath, /1panel-smoke-/, `compose 文件应在临时目录下，实际 ${composePath}`);
      const tmpRoot = composePath.replace(/\/docker-compose\.yml$/, '');
      assert.ok(
        tmpRoot.startsWith(tmpdir()) || tmpRoot.includes('1panel-smoke-'),
        `临时目录应在系统临时目录下，实际 ${tmpRoot}`,
      );

      // ③ 跑完临时目录必须已删除
      assert.equal(existsSync(tmpRoot), false, `临时目录应被删除，实际仍存在: ${tmpRoot}`);
      assert.equal(res.cleanup.tmpRemoved, true);

      // ④ compose 里**不得**出现宿主机真实网络 1panel-network
      const composeText = readWrittenCompose(fake.composeCopy);
      assert.ok(composeText.length > 0, '应能读到被测实现写出的 compose');
      assert.ok(
        !composeText.includes('1panel-network'),
        `compose 绝不能引用宿主机真实网络 1panel-network，实际:\n${composeText}`,
      );
      assert.match(composeText, /1panel_smoke_net_\d+/, 'compose 应使用冒烟专用网络名');

      // ⑤ 挂载源全在临时目录下（不含仓库真实路径 / 应用真实数据目录）
      const mountSources = [...composeText.matchAll(/^\s*-\s*(\S+):(\S+)$/gm)]
        .map((m) => m[1])
        .filter((s) => s.startsWith('/'));
      assert.ok(mountSources.length > 0, 'compose 应至少有一个绝对路径挂载源');
      for (const src of mountSources) {
        assert.ok(
          src.startsWith(tmpRoot),
          `挂载源必须在临时目录下，实际 ${src}（临时根 ${tmpRoot}）`,
        );
        assert.ok(
          !src.includes('1panel-local-apps'),
          `挂载源不得指向仓库真实路径，实际 ${src}`,
        );
      }

      // ⑥ 端口必须改绑回环，不得占用宿主机的真实绑定地址
      assert.match(composeText, /127\.0\.0\.1:\d+:/, '端口应改绑 127.0.0.1');
    } finally {
      listener.close();
      restore();
    }
  });

  it('条件跳过（GPU）→ UNVERIFIED，且一次 docker 都不调用', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv(fake);
    const root = makeAppRoot({ compose: fixtureCompose({ extra: '    runtime: nvidia\n' }) });
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => 45678,
        timeoutMs: 30000,
      });

      assert.equal(res.status, 'UNVERIFIED', `GPU 应条件跳过而非 FAILED，实际 ${res.status}`);
      assert.ok(res.skip, '应返回 skip 说明');
      assert.match(res.skip.reason, /gpu-hardware/, `skip.reason 应含 gpu-hardware，实际 ${res.skip.reason}`);

      // 关键：**一个字节的 docker 调用都不许有**
      assert.equal(
        readCalls(fake.logFile),
        '',
        '条件跳过时不得调用任何 docker 命令',
      );

      const plan = res.steps.find((s) => s.step === 'plan');
      assert.ok(plan, '应至少记录 plan 步');
      assert.equal(plan.ok, true);
      assert.equal(plan.skipped, true);
    } finally {
      restore();
    }
  });

  it('失败路径：up 失败 → FAILED，但**仍然执行清理**', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv({ ...fake, failOn: 'up' });
    const root = makeAppRoot();
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => 45678,
        timeoutMs: 30000,
      });
      assert.equal(res.status, 'FAILED', `up 失败应 FAILED，实际 ${res.status}`);

      const up = res.steps.find((s) => s.step === 'up');
      assert.ok(up, '应记录 up 步');
      assert.equal(up.ok, false, 'up 步应 ok:false');

      // 关键：失败也必须清理
      const calls = readCalls(fake.logFile);
      assert.match(calls, /down -v --remove-orphans/, '失败时也必须执行 compose down');
      assert.equal(res.cleanup.composeDownRan, true);
      assert.equal(res.cleanup.tmpRemoved, true);

      // 临时目录同样要消失
      const composePath = /-f (\S+)/.exec(calls)?.[1];
      assert.ok(composePath, '应能解析出 compose 路径');
      const tmpRoot = composePath.replace(/\/docker-compose\.yml$/, '');
      assert.equal(existsSync(tmpRoot), false, '失败时临时目录也必须删除');
    } finally {
      restore();
    }
  });

  it('Permission denied → FAILED（persist 步命中）', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv({ ...fake, logs: 'denied' });
    // 无 healthcheck 且无宿主机端口 → health 步 skipped，避免端口探活抢跑
    const root = makeAppRoot({ compose: fixtureCompose({ health: false, ports: [] }) });
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => 45678,
        timeoutMs: 30000,
      });

      assert.equal(res.status, 'FAILED', `日志含 Permission denied 应 FAILED，实际 ${res.status}`);
      const persist = res.steps.find((s) => s.step === 'persist');
      assert.ok(persist, '应记录 persist 步');
      assert.equal(persist.ok, false, 'persist 步应 ok:false');
      assert.match(persist.detail, /Permission denied/);
    } finally {
      restore();
    }
  });

  it('无 docker → UNVERIFIED（skip.reason = no-docker），不是 FAILED', async () => {
    const root = makeAppRoot();
    const res = await runSmokeTest({
      app: 'myapp',
      root,
      dockerBin: join(root, 'no-such-docker-binary'),
      portAllocator: async () => 45678,
      timeoutMs: 10000,
    });
    assert.equal(res.status, 'UNVERIFIED', `无 docker 应 UNVERIFIED，实际 ${res.status}`);
    assert.ok(res.skip, '应返回 skip 说明');
    assert.equal(res.skip.reason, 'no-docker');
  });

  it('应用不存在 → FAILED（plan 步 ok:false）', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv(fake);
    const root = makeAppRoot();
    try {
      const res = await runSmokeTest({
        app: 'nope',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => 45678,
        timeoutMs: 10000,
      });
      assert.equal(res.status, 'FAILED');
      const plan = res.steps.find((s) => s.step === 'plan');
      assert.ok(plan);
      assert.equal(plan.ok, false);
      assert.equal(res.version, null);
    } finally {
      restore();
    }
  });

  it('pull=false → pull 步标记 skipped，其余照常跑完', async () => {
    const fake = makeFakeDocker();
    const restore = setFakeEnv(fake);
    const root = makeAppRoot();
    const listener = await startListener();
    try {
      const res = await runSmokeTest({
        app: 'myapp',
        root,
        dockerBin: fake.dockerBin,
        portAllocator: async () => listener.port,
        timeoutMs: 30000,
        pull: false,
      });
      assert.equal(res.status, 'PASSED');
      const pull = res.steps.find((s) => s.step === 'pull');
      assert.ok(pull);
      assert.equal(pull.ok, true);
      assert.equal(pull.skipped, true);
      assert.doesNotMatch(readCalls(fake.logFile), /\spull\b/, 'pull=false 时不应调用 pull');
    } finally {
      listener.close();
      restore();
    }
  });
});

// ─── CLI 入口 ──────────────────────────────────────────────────────────────

describe('main：CLI 入口退出码', () => {
  it('不存在的应用 → 返回 1', async () => {
    const code = await main(['--app', '不存在的应用']);
    assert.equal(code, 1, '不存在的应用必须返回 1');
  });

  it('缺少 --app → 返回 1', async () => {
    const code = await main([]);
    assert.equal(code, 1, '缺少 --app 必须返回 1');
  });

  it('条件跳过的应用 → 返回 0（UNVERIFIED 不算失败）', async () => {
    // 用 GPU fixture：必然走条件跳过分支，不依赖本机有没有 docker，
    // 结果稳定为 UNVERIFIED → 退出码 0。
    const root = makeAppRoot({ compose: fixtureCompose({ extra: '    runtime: nvidia\n' }) });
    const code = await main(['--app', 'myapp', '--root', root]);
    assert.equal(code, 0, `UNVERIFIED 应返回 0，实际 ${code}`);
  });

  it('应用不存在（指定 --root）→ 返回 1', async () => {
    const root = makeAppRoot();
    const code = await main(['--app', '不存在的应用', '--root', root]);
    assert.equal(code, 1, '不存在的应用必须返回 1');
  });
});

// ─── 收尾 ──────────────────────────────────────────────────────────────────

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
