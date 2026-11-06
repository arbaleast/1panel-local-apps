// .github/lib/smoke-plan.mjs — 隔离沙箱冒烟测试的**纯函数核心**
//
// ── 职责（唯一）────────────────────────────────────────────────────────────
// 1. 判定某个 compose 版本是否应「条件跳过」（GPU / 外部 DB / host 网络 …）；
// 2. 把一份**已解析的 compose 文档**重写成一份**隔离安全**的副本：
//    - 容器名 → 冒烟专用 project 名
//    - 网络   → 冒烟专用 bridge 网络（**绝不** external，绝不碰宿主机 1panel-network）
//    - 端口   → 全部改绑 127.0.0.1 + 预先分配的宿主机端口
//    - 卷     → **绝不**挂载任何真实用户路径，一律重写到临时目录 / 冒烟命名卷
//
// ── 分层约束（CONTRIBUTING.md §4）────────────────────────────────────────
// 本模块**必须 100% 纯**：无 fs / 无网络 / 无 process，无第三方依赖（不需要 js-yaml）。
//
// ── ⚠️ 隔离铁律────────────────────────────────────────────────────────────
// 冒烟测试跑在**共享的 CI 机器**上，绝不允许：
//   - 加入宿主机真实的 `1panel-network`（会让容器与线上应用互通）
//   - 挂载宿主机上的真实数据目录（会污染 / 破坏用户数据）
//   - 占用宿主机上已被线上应用使用的端口
// 因此本模块的所有重写都是**保守**的：宁可不重写（并标记跳过），也不能漏出真实路径。

import { isGpuVariantDir } from './arch-map.mjs';

/**
 * 冒烟测试的「条件跳过」原因枚举
 * @type {Readonly<Record<string,string>>}
 */
export const SKIP_CONDITIONS = Object.freeze({
  GPU: 'gpu-hardware',                 // 依赖 GPU 硬件
  EXTERNAL_DB: 'external-database',    // 依赖外部数据库 / Redis / MQ
  HOST_NETWORK: 'host-network',        // network_mode: host（无法隔离）
  PRIVILEGED: 'privileged',            // privileged 容器（沙箱内不安全）
  UNSAFE_HOST_PATH: 'unsafe-host-path', // compose 里写了宿主机绝对路径挂载（绝不挂真实路径）
  MISSING_DEVICE: 'missing-device',    // 映射了宿主机可能不存在的设备
  NO_DOCKER: 'no-docker',              // 环境无 docker CLI
});

/** 判定顺序固定，保证输出稳定可测 */
const CONDITION_ORDER = [
  SKIP_CONDITIONS.GPU,
  SKIP_CONDITIONS.EXTERNAL_DB,
  SKIP_CONDITIONS.HOST_NETWORK,
  SKIP_CONDITIONS.PRIVILEGED,
  SKIP_CONDITIONS.UNSAFE_HOST_PATH,
  SKIP_CONDITIONS.MISSING_DEVICE,
];

/** 外部依赖技术栈 → 识别用的关键字（大小写不敏感） */
const EXTERNAL_STACKS = [
  { key: 'mysql', re: /mysql/i },
  { key: 'mariadb', re: /mariadb/i },
  { key: 'postgres', re: /postgres|postgresql/i },
  { key: 'redis', re: /redis/i },
  { key: 'mongodb', re: /mongo/i },
  { key: 'mssql', re: /mssql|sqlserver/i },
  { key: 'clickhouse', re: /clickhouse/i },
  { key: 'rabbitmq', re: /rabbitmq|amqp/i },
  { key: 'elasticsearch', re: /elastic(search)?/i },
  { key: 'minio', re: /minio/i },
];

/** 连接端点形态：`scheme://…` 或 `host:port` */
const ENDPOINT_SCHEME_RE = /:\/\//;
const ENDPOINT_HOSTPORT_RE = /[A-Za-z0-9_.-]+:\d{2,5}/;

/** GPU 相关设备前缀 */
const GPU_DEVICE_PREFIXES = ['/dev/dri', '/dev/nvidia', '/dev/kfd'];
/** 宿主机上可能不存在的设备 */
const OPTIONAL_DEVICE_PREFIXES = ['/dev/net/tun', '/dev/kfd', '/dev/nvidia'];

/**
 * 按分隔符切分字符串，但**尊重 `${}` 内部的冒号**。
 *
 * 场景：`${VAR:-1}:80`、`redis://:${PASS}@host:6379` 这类串里的冒号
 * 不能被当成 compose 端口/卷的分隔符。
 *
 * @param {string} str 待切分字符串
 * @param {string} [sep] 分隔符（默认 `:`）
 * @returns {string[]} 切分结果
 */
export function splitRespectingBraces(str, sep = ':') {
  if (typeof str !== 'string') return [];
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '$' && str[i + 1] === '{') {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      cur += ch;
      continue;
    }
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 从占位符串里取出变量名（支持 `${VAR}` / `${VAR:-def}` / `${VAR-def}` 等形态）。
 *
 * @param {string} text 含 `${...}` 的字符串
 * @returns {string|null} 变量名；不是占位符时返回 null
 */
export function placeholderVarName(text) {
  if (typeof text !== 'string') return null;
  const m = /\$\{([^}]*)\}/.exec(text);
  if (!m) return null;
  const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(m[1]);
  return name ? name[1] : null;
}

/**
 * 把 service.environment 归一化成 `{name: value}` 对象。
 *
 * compose 允许对象形态与 `KEY=VALUE` 数组形态，这里都支持。
 *
 * @param {unknown} env
 * @returns {Record<string,string>}
 */
function envPairs(env) {
  const out = {};
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const item of env) {
      if (typeof item !== 'string') continue;
      const idx = item.indexOf('=');
      if (idx === -1) out[item] = '';
      else out[item.slice(0, idx)] = item.slice(idx + 1);
    }
    return out;
  }
  if (typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * 判断一个字符串是否为「字面量宿主机绝对路径」。
 *
 * 变量型 source（`${VAR}`）**不算**——它会被重写到临时目录。
 *
 * @param {unknown} source
 * @returns {boolean}
 */
function isLiteralHostPath(source) {
  if (typeof source !== 'string') return false;
  if (source.startsWith('${')) return false;
  return source.startsWith('/');
}

/**
 * 判断一个卷/端口 source 是否为「相对路径」（`./` / `../` / `~` 开头）。
 *
 * @param {unknown} source
 * @returns {boolean}
 */
function isRelativePath(source) {
  if (typeof source !== 'string') return false;
  return source.startsWith('./') || source.startsWith('../') || source === '.' || source === '..' || source.startsWith('~/');
}

/**
 * 深度拷贝一份普通 JS 数据（compose 文档全是纯数据）。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* 含函数等不可克隆内容时退回 JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * 取版本级 formFields。
 * @param {object} ctx
 * @returns {Array<object>}
 */
function formFieldsOf(ctx) {
  const vd = ctx?.versionDoc ?? null;
  const list = vd?.additionalProperties?.formFields ?? vd?.formFields ?? [];
  return Array.isArray(list) ? list : [];
}

/**
 * 解析一个「可能是变量」的字符串在**版本 formFields 默认值**下的实际取值。
 *
 * 动机（实测踩坑，2026-11）：`mineru` 的 `runtime: ${GPU_RUNTIME}` 是**变量形式**，
 * 静态看不是硬 GPU 信号，但该变量的 formField 默认值是 `nvidia` → **实际默认开启 GPU**。
 * 冒烟测试在无 GPU 的 runner 上跑会直接失败，因此必须按**默认值**判定，
 * 与 lint 的 `gpu.gated-default-on` 规则保持同一口径。
 *
 * @param {object} ctx
 * @param {string} text
 * @returns {{value:string, fromDefault:boolean, varName:string|null}}
 */
function resolveByDefault(ctx, text) {
  const raw = String(text ?? '');
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(raw);
  if (!m) return { value: raw, fromDefault: false, varName: null };
  const varName = m[1];
  for (const f of formFieldsOf(ctx)) {
    if (!f || f.envKey !== varName) continue;
    const d = f.default;
    if (d === undefined || d === null || String(d) === '') continue;
    return { value: String(d), fromDefault: true, varName };
  }
  // 变量没有可用默认值 → 保持变量原样（无法判定是否开启）
  return { value: raw, fromDefault: false, varName };
}

/**
 * 判定该版本是否应「条件跳过」。
 *
 * 判定**只基于 compose 结构本身**（以及版本目录名），不猜测、不臆断。
 *
 * @param {{composeDoc:object|null, versionDoc?:object|null, versionDir?:string|null, findings?:Array<object>}} ctx
 * @returns {Array<{condition:string, reason:string}>}
 */
export function detectSkipConditions(ctx) {
  const c = ctx ?? {};
  const composeDoc = c.composeDoc ?? null;
  const services = (composeDoc && typeof composeDoc === 'object' && composeDoc.services) || {};
  const serviceNames = Object.keys(services);

  /** condition → 证据列表 */
  const evidence = new Map();
  /**
   * 追加一条证据。
   * @param {string} condition
   * @param {string} text
   */
  const add = (condition, text) => {
    if (!evidence.has(condition)) evidence.set(condition, []);
    evidence.get(condition).push(text);
  };

  // ── GPU ────────────────────────────────────────────────────────────────
  const versionDir = c.versionDir ?? c.version ?? null;
  if (typeof versionDir === 'string' && isGpuVariantDir(versionDir)) {
    add(SKIP_CONDITIONS.GPU, `版本目录名 ${versionDir} 命中 GPU 变体`);
  }
  for (const name of serviceNames) {
    const svc = services[name] ?? {};
    const runtime = svc.runtime;
    if (typeof runtime === 'string') {
      // 字面量：直接判定
      if (!runtime.includes('${') && /nvidia/i.test(runtime)) {
        add(SKIP_CONDITIONS.GPU, `services.${name}: runtime=${runtime}`);
      } else if (runtime.includes('${')) {
        // 变量形式：按 **formField 默认值** 判定（默认值即 nvidia → 实际默认开启 GPU）
        const r = resolveByDefault(c, runtime);
        if (r.fromDefault && /nvidia/i.test(r.value)) {
          add(SKIP_CONDITIONS.GPU, `services.${name}: runtime=${runtime}，其默认值 ${r.varName}=${r.value} → 实际默认开启 GPU`);
        }
      }
    }
    const devices = Array.isArray(svc.deploy?.resources?.reservations?.devices)
      ? svc.deploy.resources.reservations.devices
      : [];
    for (const dev of devices) {
      const driver = dev?.driver;
      if (typeof driver !== 'string') continue;
      if (!driver.includes('${') && /^nvidia$/i.test(driver.trim())) {
        add(SKIP_CONDITIONS.GPU, `services.${name}: deploy.resources.reservations.devices[].driver=${driver}`);
      } else if (driver.includes('${')) {
        const r = resolveByDefault(c, driver);
        if (r.fromDefault && /^nvidia$/i.test(r.value.trim())) {
          add(SKIP_CONDITIONS.GPU, `services.${name}: deploy.resources.reservations.devices[].driver=${driver}，其默认值 ${r.varName}=${r.value} → 实际默认预约 GPU`);
        }
      }
    }
    for (const dev of Array.isArray(svc.devices) ? svc.devices : []) {
      if (typeof dev !== 'string') continue;
      for (const prefix of GPU_DEVICE_PREFIXES) {
        if (dev.startsWith(prefix) || dev.includes(`:${prefix}`)) {
          add(SKIP_CONDITIONS.GPU, `services.${name}: devices[]=${dev}`);
        }
      }
    }
  }

  // ── 外部数据库 / Redis / MQ ───────────────────────────────────────────
  // compose 内置了同技术栈服务 → 视为自包含，不算外部依赖。
  const internalStacks = new Set();
  for (const name of serviceNames) {
    const svc = services[name] ?? {};
    const image = typeof svc.image === 'string' ? svc.image : '';
    for (const stack of EXTERNAL_STACKS) {
      if (stack.re.test(image)) internalStacks.add(stack.key);
      if (stack.re.test(name)) internalStacks.add(stack.key);
    }
  }
  for (const name of serviceNames) {
    const svc = services[name] ?? {};
    const pairs = envPairs(svc.environment);
    for (const [key, value] of Object.entries(pairs)) {
      if (typeof value !== 'string' || value === '') continue;
      const hasEndpoint = ENDPOINT_SCHEME_RE.test(value) || ENDPOINT_HOSTPORT_RE.test(value);
      if (!hasEndpoint) continue;
      for (const stack of EXTERNAL_STACKS) {
        if (!stack.re.test(value)) continue;
        if (internalStacks.has(stack.key)) continue;
        add(
          SKIP_CONDITIONS.EXTERNAL_DB,
          `services.${name}: environment.${key} 指向外部 ${stack.key} 端点 ${value}`,
        );
      }
    }
  }

  // ── host 网络 / 特权容器 / 宿主机绝对路径 / 可选设备 ───────────────────
  for (const name of serviceNames) {
    const svc = services[name] ?? {};
    if (svc.network_mode === 'host') {
      add(SKIP_CONDITIONS.HOST_NETWORK, `services.${name}: network_mode=host`);
    }
    if (svc.privileged === true) {
      add(SKIP_CONDITIONS.PRIVILEGED, `services.${name}: privileged=true`);
    }
    const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
    volumes.forEach((vol, i) => {
      const source = typeof vol === 'string' ? splitRespectingBraces(vol)[0] : vol?.source;
      if (isLiteralHostPath(source)) {
        add(SKIP_CONDITIONS.UNSAFE_HOST_PATH, `services.${name}: volumes[${i}] source=${source}`);
      }
    });
    (Array.isArray(svc.devices) ? svc.devices : []).forEach((dev, i) => {
      if (typeof dev !== 'string') return;
      for (const prefix of OPTIONAL_DEVICE_PREFIXES) {
        if (dev.startsWith(prefix) || dev.includes(`:${prefix}`)) {
          add(SKIP_CONDITIONS.MISSING_DEVICE, `services.${name}: devices[${i}]=${dev}`);
        }
      }
    });
  }

  // 按固定顺序输出
  const out = [];
  for (const condition of CONDITION_ORDER) {
    const list = evidence.get(condition);
    if (!list || list.length === 0) continue;
    out.push({ condition, reason: list.join('；') });
  }
  return out;
}

/**
 * 构造隔离冒烟计划（纯函数；不碰 fs / 网络 / 进程）。
 *
 * @param {object} params
 * @param {string} params.app
 * @param {string} params.version
 * @param {object} params.composeDoc
 * @param {object} [params.versionDoc]
 * @param {object} [params.rootDoc]
 * @param {Record<string,string>} params.env - 1Panel 上下文 env（调用方已构造）
 * @param {string} params.projectName - 形如 1panel_smoke_<app>_<ts>
 * @param {string} params.testNetwork - 形如 1panel_smoke_net_<ts>
 * @param {string} params.tmpDir - 临时工作目录（绝对路径）
 * @param {Record<string,number>} params.portMap - 变量名 → 分配的宿主机端口；
 *        字面量宿主机端口用合成键 `#literal:<service>:<index>`
 * @returns {{
 *   projectName: string,
 *   testNetwork: string,
 *   env: Record<string,string>,
 *   composeDoc: object,
 *   mounts: Array<{service:string, original:string, source:string, target:string, rewritten:string, kind:string}>,
 *   ports: Array<{service:string, original:string, hostPort:number, containerPort:string, kind:string}>,
 *   skip: boolean,
 *   skipReasons: string[],
 * }}
 */
export function buildSmokePlan(params) {
  const p = params ?? {};
  const projectName = String(p.projectName ?? '');
  const testNetwork = String(p.testNetwork ?? '');
  const tmpDir = String(p.tmpDir ?? '');
  const portMap = p.portMap && typeof p.portMap === 'object' ? p.portMap : {};
  const sourceDoc = p.composeDoc && typeof p.composeDoc === 'object' ? p.composeDoc : {};

  // 输入文档**不得**被原地修改 → 先深拷贝
  const doc = deepClone(sourceDoc) ?? {};
  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};

  /** 具名卷改名表：原名 → 新名 */
  const namedVolumeRenames = new Map();
  /** @type {Array<object>} */
  const mounts = [];
  /** @type {Array<object>} */
  const ports = [];

  /**
   * 重写一个卷的 source。
   * @param {string} service
   * @param {string} original 原始 volume 串
   * @param {string} source 原始 source
   * @param {string} target 容器内 target
   * @returns {{source:string, kind:string}}
   */
  const rewriteSource = (service, original, source, target) => {
    if (typeof source !== 'string' || source === '') {
      return { source, kind: 'unknown' };
    }
    if (isRelativePath(source)) {
      const rel = source.replace(/^(\.\.?\/)+/, '').replace(/^~\/?/, '');
      const rewritten = `${tmpDir}/${service}/${rel}`;
      mounts.push({ service, original, source, target, rewritten, kind: 'relative' });
      return { source: rewritten, kind: 'relative' };
    }
    if (source.startsWith('${')) {
      // ⚠️ 变量型 source 一律重写到临时目录；**故意不使用 env 里的真实值**，
      //    否则会把宿主机真实路径重新写回 compose（等于没隔离）。
      const varName = placeholderVarName(source) ?? 'var';
      const rewritten = `${tmpDir}/${service}/${varName}`;
      mounts.push({ service, original, source, target, rewritten, kind: 'variable' });
      return { source: rewritten, kind: 'variable' };
    }
    if (isLiteralHostPath(source)) {
      // 宿主机绝对路径：**不重写**（原值保留），由 detectSkipConditions 标记为 UNSAFE_HOST_PATH。
      mounts.push({ service, original, source, target, rewritten: source, kind: 'host-path' });
      return { source, kind: 'host-path' };
    }
    // 具名卷 → 冒烟专用名字
    const rewritten = `${projectName}_${source}`;
    namedVolumeRenames.set(source, rewritten);
    mounts.push({ service, original, source, target, rewritten, kind: 'named-volume' });
    return { source: rewritten, kind: 'named-volume' };
  };

  /**
   * 重写一条端口声明。
   * @param {string} service
   * @param {string} indexInService 该条在 service.ports 里的下标
   * @param {string} spec 原始端口串
   * @returns {string} 重写后的端口串
   */
  const rewritePort = (service, indexInService, spec) => {
    const segments = splitRespectingBraces(spec);
    if (segments.length === 0) return spec;
    // 协议后缀（/tcp、/udp）单独摘出来，避免污染端口号解析
    let protocol = '';
    const last = segments[segments.length - 1];
    const protoMatch = /\/(tcp|udp|sctp)$/i.exec(last);
    if (protoMatch) {
      protocol = `/${protoMatch[1].toLowerCase()}`;
      segments[segments.length - 1] = last.slice(0, last.length - protocol.length);
    }

    if (segments.length === 1) {
      // 仅容器端口 → 不改
      ports.push({
        service,
        original: spec,
        hostPort: 0,
        containerPort: segments[0],
        kind: 'container-only',
      });
      return spec;
    }

    const containerPort = segments[segments.length - 1];
    const hostSegment = segments.length >= 3 ? segments[segments.length - 1 - 1] : segments[0];
    const ipSegment = segments.length >= 3 ? segments[0] : null;

    let hostPort;
    if (hostSegment.includes('${')) {
      const varName = placeholderVarName(hostSegment);
      const mapped = varName === null ? undefined : portMap[varName];
      if (mapped === undefined || mapped === null) {
        throw new Error(
          `冒烟端口未分配：services.${service}.ports[${indexInService}]="${spec}" 的宿主机端口变量 ` +
            `${varName ?? hostSegment} 不在 portMap 中（调用方必须先分配端口）`,
        );
      }
      hostPort = Number(mapped);
    } else {
      const key = `#literal:${service}:${indexInService}`;
      const mapped = portMap[key];
      if (mapped === undefined || mapped === null) {
        throw new Error(
          `冒烟端口未分配：services.${service}.ports[${indexInService}]="${spec}" 的字面量宿主机端口 ` +
            `缺少合成键 ${key}（调用方必须先分配端口）`,
        );
      }
      hostPort = Number(mapped);
    }
    if (!Number.isFinite(hostPort)) {
      throw new Error(`冒烟端口非法：services.${service}.ports[${indexInService}]="${spec}" 映射到 ${hostPort}`);
    }

    // IP 段固定为 127.0.0.1（ipSegment 仅用于判断是 2 段还是 3 段形态）
    const out = `127.0.0.1:${hostPort}:${containerPort}${protocol}`;
    ports.push({
      service,
      original: spec,
      hostPort,
      containerPort,
      kind: 'host-published',
    });
    if (ipSegment !== null && ipSegment.includes('${')) {
      // IP 段原本是 ${HOST_IP} 之类 → 直接固定为回环，无需额外处理
    }
    return out;
  };

  for (const [name, rawSvc] of Object.entries(services)) {
    const svc = rawSvc && typeof rawSvc === 'object' ? rawSvc : {};

    // container_name
    if (typeof svc.container_name === 'string') {
      const m = /^\$\{CONTAINER_NAME\}(.*)$/.exec(svc.container_name);
      if (m) svc.container_name = `${projectName}${m[1]}`;
    }

    // 服务级 networks
    if (Array.isArray(svc.networks)) {
      svc.networks = [testNetwork];
    } else if (svc.networks && typeof svc.networks === 'object') {
      const aliases = [];
      for (const cfg of Object.values(svc.networks)) {
        const list = cfg && Array.isArray(cfg.aliases) ? cfg.aliases : [];
        for (const a of list) if (!aliases.includes(a)) aliases.push(a);
      }
      svc.networks = aliases.length > 0 ? { [testNetwork]: { aliases } } : { [testNetwork]: {} };
    }

    // ports
    if (Array.isArray(svc.ports)) {
      svc.ports = svc.ports.map((spec, i) => {
        if (typeof spec === 'string') return rewritePort(name, i, spec);
        return spec;
      });
    }

    // volumes
    if (Array.isArray(svc.volumes)) {
      svc.volumes = svc.volumes.map((vol) => {
        if (typeof vol === 'string') {
          const parts = splitRespectingBraces(vol);
          if (parts.length === 0) return vol;
          const source = parts[0];
          const target = parts[1] ?? '';
          const mode = parts.length > 2 ? `:${parts.slice(2).join(':')}` : '';
          const { source: newSource } = rewriteSource(name, vol, source, target);
          return `${newSource}:${target}${mode}`;
        }
        if (vol && typeof vol === 'object' && typeof vol.source === 'string') {
          const target = typeof vol.target === 'string' ? vol.target : '';
          const { source: newSource } = rewriteSource(name, JSON.stringify(vol), vol.source, target);
          const next = { ...vol, source: newSource };
          if (typeof vol.read_only === 'boolean') next.read_only = vol.read_only;
          return next;
        }
        return vol;
      });
    }
  }

  // 顶层 networks → 冒烟专用 bridge 网络（**绝不** external）
  doc.networks = { [testNetwork]: { name: testNetwork, driver: 'bridge' } };

  // 顶层 volumes → 同步改名（只保留被用到的命名卷）
  if (doc.volumes && typeof doc.volumes === 'object') {
    const nextVolumes = {};
    for (const [volName, cfg] of Object.entries(doc.volumes)) {
      const renamed = namedVolumeRenames.get(volName);
      if (renamed) nextVolumes[renamed] = cfg ?? {};
    }
    doc.volumes = nextVolumes;
  }

  const skipList = detectSkipConditions({
    composeDoc: sourceDoc,
    versionDoc: p.versionDoc ?? null,
    versionDir: p.version ?? null,
    findings: [],
  });
  // skipReasons 用**可读串**（`条件码：证据`），报告与 CI 注解直接可用
  const skipReasons = skipList.map((x) => `${x.condition}: ${x.reason}`);

  return {
    projectName,
    testNetwork,
    env: { ...(p.env ?? {}) },
    composeDoc: doc,
    mounts,
    ports,
    skip: skipReasons.length > 0,
    skipReasons,
  };
}
