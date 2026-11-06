// lib/deploy-compat.mjs — 部署兼容性规则引擎（阶段 2 / 4 / 5 / 6）
//
// 定位：纯规则引擎层。输入是「已解析的文档 + 原始文本 + 可选的镜像 manifest 摘要」，
// 输出结构化 findings；不做 fs / 网络 / 进程副作用，第三方依赖仅 js-yaml（间接）。
// 与 lib/consistency.mjs 同形：finding = { severity, ruleId, app, version, file, line, message, actual, expected }。
//
// 严重等级语义（与 consistency.mjs 一致）：
//   P0 / P1 → error（阻断）
//   P2      → warning（不阻断）
//   P3      → UNVERIFIED（既不是 error 也不是 warning，单独一列展示）
//
// 零误杀原则：
//   - 任何依赖镜像 manifest 的规则（identity.* / arch.*），在 ctx.manifests === null（离线模式）
//     或 manifest 未取到时，一律**不产出** finding，绝不按家族名猜测；
//   - 「GPU 专属应用白名单」是本模块唯一允许的应用级白名单，依据见 GPU_EXCLUSIVE_APPS 注释。

import { buildPanelEnv, renderCompose } from './compose-render.mjs';
import { resolveImageTemplate } from './compose.mjs';

// ─── 规则元数据（单一事实来源）─────────────────────────────────────────────
// severity: P0/P1 = error（阻断）；P2 = warning；P3 = UNVERIFIED。
// runtime.high-privilege 额外带 escalationSeverity：P0（特权容器 + host 网络叠加的升级态）。
export const DEPLOY_COMPAT_RULES = Object.freeze({
  'compose.render':             { severity: 'P0', ssot: '版本级 data.yml.formFields + docker-compose.yml', desc: '在 1Panel 变量上下文下渲染 compose 必须成功（${VAR:?msg} 等强制变量缺失即失败）' },
  'port.format':                { severity: 'P1', ssot: 'docker-compose.yml services.ports', desc: '端口映射必须是 C / H:C / IP:H:C 形态，端口号 1-65535，协议后缀仅 tcp/udp/sctp' },
  'volume.format':              { severity: 'P1', ssot: 'docker-compose.yml services.volumes', desc: '卷映射语法合法：target 必须绝对路径，mode 取值合法，命名卷须在顶层 volumes 声明' },
  'compose.dep-missing':       { severity: 'P1', ssot: 'docker-compose.yml services.*', desc: 'depends_on / links / volumes_from 指向的服务必须真实存在' },
  'compose.deprecated-key':     { severity: 'P2', ssot: 'docker-compose.yml', desc: 'Compose Spec 已废弃的键（顶层 version、服务级 links）应移除' },
  'compose.network-conflict':   { severity: 'P1', ssot: 'docker-compose.yml services.*', desc: '同一服务不得同时设置 network_mode 与 networks' },
  'compose.host-network-ports': { severity: 'P2', ssot: 'docker-compose.yml services.*', desc: 'network_mode: host 时 ports 映射会被忽略，应删除或改用 bridge' },
  'runtime.high-privilege':    { severity: 'P2', escalationSeverity: 'P0', ssot: 'docker-compose.yml', desc: '高权限配置（pid/ipc host、security_opt、敏感 bind 挂载）须降权；privileged 与 host 网络叠加为 P0' },
  'gpu.unconditional':          { severity: 'P1', ssot: 'docker-compose.yml + 版本目录名', desc: '非 GPU 专属应用不应硬编码 GPU 运行时/设备（CPU 默认部署会直接起不来）' },
  'gpu.gated-default-on':       { severity: 'P2', ssot: 'docker-compose.yml + 版本级 data.yml.formFields', desc: 'GPU 信号已变量化，但 formField 默认值使 GPU 实际默认开启' },
  'gpu.documented':             { severity: 'P1', ssot: 'docker-compose.yml + README.md', desc: '含 GPU 信号的应用必须在 README 说明 nvidia / container toolkit 前置条件' },
  'gpu.device-group-doc':       { severity: 'P2', ssot: 'docker-compose.yml + README.md', desc: '挂载 /dev/dri 的应用需在 README 说明 render / video 用户组' },
  'gpu.variant-dir':            { severity: 'P3', ssot: '版本目录名', desc: 'GPU 专属变体目录需 GPU 硬件环境实机验证（UNVERIFIED）' },
  'hw.devices-missing':         { severity: 'P2', ssot: 'docker-compose.yml services.devices', desc: 'devices 映射了宿主机不一定存在的设备（/dev/net/tun、/dev/kfd、/dev/nvidia*）' },
  'identity.puid-unsupported':  { severity: 'P2', ssot: 'docker-compose.yml + 镜像 imageConfig.env', desc: '声明了 PUID/PGID 但镜像并不支持（依据镜像 imageConfig，非猜测）' },
  'identity.user-unsupported':  { severity: 'P1', ssot: 'docker-compose.yml + 镜像 imageConfig.user', desc: 'compose 指定非 root 用户但镜像默认以 root 运行，宿主机目录需 chown' },
  'identity.readme-drift':      { severity: 'P2', ssot: 'README.md + docker-compose.yml', desc: 'README 提到 PUID/PGID 但 compose 未设置对应环境变量（文档漂移）' },
  'volume.mount-target':        { severity: 'P2', ssot: 'docker-compose.yml services.volumes + 版本级 data.yml.formFields', desc: '疑似宿主路径与容器目标路径写反（启发式提示）' },
  'volume.mounted-sensitive':   { severity: 'P2', ssot: 'docker-compose.yml services.volumes', desc: 'rw 挂载覆盖 /etc /proc /sys /usr /bin /sbin /lib 会破坏容器' },
  'default.path-leak':          { severity: 'P1', ssot: '版本级 data.yml.formFields', desc: 'formField 默认值泄露开发者本机绝对路径' },
  'parse.bom':                  { severity: 'P2', ssot: 'docker-compose.yml / data.yml 原始文本', desc: '文件带 BOM 会导致行号定位偏移' },
  'dep.external-undeclared':    { severity: 'P1', ssot: 'docker-compose.yml environment + 版本级 data.yml.formFields', desc: 'compose 里的外部数据库/缓存连接变量未在 formFields 声明（1Panel 不会注入）' },
  'dep.external-missing':       { severity: 'P2', ssot: '版本级 data.yml.formFields label', desc: '外部依赖连接变量虽已声明，但表单文案未说明所依赖的技术栈' },
  'dep.ready-condition':        { severity: 'P2', ssot: 'docker-compose.yml depends_on / healthcheck', desc: '依赖的服务没有 healthcheck，依赖未就绪可能导致启动失败' },
  'arch.overdeclared':          { severity: 'P1', ssot: '根 data.yml architectures + 镜像 manifest platforms', desc: '应用声明了镜像实际未发布的架构' },
  'arch.underdeclared':         { severity: 'P2', ssot: '根 data.yml architectures + 镜像 manifest platforms', desc: '镜像实际发布的架构未被应用声明' },
  'arch.bucket-conflict':       { severity: 'P1', ssot: '镜像 manifest platforms', desc: '多服务镜像的架构交集为空（木桶效应，该应用在交集外架构不可用）' },
  'arch.versiondir-mismatch':   { severity: 'P1', ssot: '版本目录名 + 镜像 manifest platforms', desc: '版本目录名蕴含的架构未被该版本镜像实际发布' },
  'arch.unverified':            { severity: 'P3', ssot: '镜像 manifest', desc: '镜像 manifest 未取到，架构结论无法验证（UNVERIFIED）' },
});

/** 全部 ruleId（便于断言与豁免校验） */
export const DEPLOY_COMPAT_RULE_IDS = Object.freeze(Object.keys(DEPLOY_COMPAT_RULES));

// ─── 结构化 finding ────────────────────────────────────────────────────────
/**
 * 构造一条 finding，形状与 lib/consistency.mjs 完全一致。
 * @param {string} severity
 * @param {string} ruleId
 * @param {object} ctx
 * @param {{file?:string,line?:number|null,message?:string,actual?:*,expected?:*}} [extra]
 * @returns {object}
 */
function finding(severity, ruleId, ctx, extra = {}) {
  const file = extra.file ?? ctx.composePath ?? ctx.dataPath ?? ctx.readmePath ?? `${ctx.app}`;
  return {
    severity: severity ?? DEPLOY_COMPAT_RULES[ruleId].severity,
    ruleId,
    app: ctx.app,
    version: ctx.version ?? null,
    file,
    line: extra.line ?? null,
    message: extra.message ?? DEPLOY_COMPAT_RULES[ruleId].desc,
    actual: extra.actual ?? null,
    expected: extra.expected ?? null,
  };
}

// ─── 通用小工具 ────────────────────────────────────────────────────────────

/**
 * 按分隔符切分字符串，但忽略 `${...}` 内部的分隔符。
 * @param {string} str
 * @param {string} [sep]
 * @returns {string[]}
 */
function splitRespectingBraces(str, sep = ':') {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(str)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 合法的 `${VAR}` / `${VAR:-default}` / `${VAR-default}` 占位符 */
const VAR_SEGMENT_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*[^{}]*\}$/;

/** IPv4 地址（IP:H:C 形态允许 IP 段） */
const IPV4_SEGMENT_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * 判断一个端口「段」是否合法：变量占位符、纯数字或 IPv4 地址。
 * @param {string} seg
 * @returns {boolean}
 */
function isValidPortSegment(seg) {
  if (typeof seg !== 'string' || seg.length === 0) return false;
  return VAR_SEGMENT_RE.test(seg) || /^\d+$/.test(seg) || IPV4_SEGMENT_RE.test(seg);
}

/**
 * 取得版本级 formFields 数组。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function versionFormFields(ctx) {
  return ctx.versionDoc?.additionalProperties?.formFields ?? ctx.versionDoc?.formFields ?? [];
}

/**
 * 取得版本级 formFields 声明的 envKey 集合。
 * @param {object} ctx
 * @returns {Set<string>}
 */
function declaredEnvKeys(ctx) {
  const s = new Set();
  for (const f of versionFormFields(ctx)) if (f?.envKey) s.add(f.envKey);
  return s;
}

/**
 * 把 service.environment（数组或对象）归一为 {key, value} 列表。
 * @param {unknown} environment
 * @returns {Array<{key:string, value:string}>}
 */
export function serviceEnvEntries(environment) {
  const out = [];
  if (Array.isArray(environment)) {
    for (const e of environment) {
      const s = String(e);
      const i = s.indexOf('=');
      if (i === -1) out.push({ key: s.trim(), value: '' });
      else out.push({ key: s.slice(0, i).trim(), value: s.slice(i + 1) });
    }
  } else if (environment && typeof environment === 'object') {
    for (const [k, v] of Object.entries(environment)) out.push({ key: String(k), value: v === null || v === undefined ? '' : String(v) });
  }
  return out;
}

/**
 * 取得 compose 中的服务表。
 * @param {object} ctx
 * @returns {Record<string, object>}
 */
function servicesOf(ctx) {
  return ctx.composeDoc?.services ?? {};
}

/**
 * 取得服务使用的镜像引用字符串。
 * @param {object} svc
 * @returns {string|null}
 */
function imageOf(svc) {
  return typeof svc?.image === 'string' && svc.image.length ? svc.image : null;
}

/**
 * 判断短语法卷的 source 是否为「命名卷」（既非绝对路径，也非 ./ ~/ 相对路径）。
 * @param {string} source
 * @returns {boolean}
 */
function isNamedVolumeSource(source) {
  if (!source) return false;
  if (source.startsWith('/')) return false;
  if (source.startsWith('.') || source.startsWith('~')) return false;
  if (source.startsWith('$')) return false; // 变量型 source 无法静态判定
  return true;
}

// ─── 阶段 2：Compose 静态验证 ─────────────────────────────────────────────

/**
 * compose.render（P0）：在 1Panel 变量上下文里渲染 compose，渲染失败即阻断。
 * @param {object} ctx
 * @returns {Array<object>}
 */
/**
 * 构造该版本的 1Panel 变量上下文（env）。
 *
 * 供规则层与 bin 层的 `docker compose config` 真实渲染校验**共用同一份 env**，
 * 保证两条腿（静态 AST 校验 / compose CLI 校验）看到的是同一个变量世界。
 *
 * @param {object} ctx
 * @returns {Record<string,string>}
 */
export function panelEnvOf(ctx) {
  if (ctx && ctx.__panelEnv) return ctx.__panelEnv;
  const env = buildPanelEnv(versionFormFields(ctx)).env;
  if (ctx) ctx.__panelEnv = env;
  return env;
}

/**
 * compose.render（P0）：compose 在 1Panel 变量上下文下必须能零错误渲染。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkComposeRender(ctx) {
  if (!ctx.composeDoc) return [];
  const env = panelEnvOf(ctx);
  const res = renderCompose(ctx.composeDoc, env);
  if (res.ok !== false) return [];
  return [finding('P0', 'compose.render', ctx, {
    message: `compose 在 1Panel 变量上下文下渲染失败：${res.error ?? '未知错误'}`,
    actual: String(res.error ?? '未知错误'),
    expected: '所有 ${VAR} 在版本级 data.yml.formFields 中声明且有可用默认值（不得使用 ${VAR:?msg} 强制缺失）',
  })];
}

/**
 * port.format（P1）：端口映射语法校验（不判定端口冲突——既有 port.conflict 负责）。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkPortFormat(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const ports = Array.isArray(svc?.ports) ? svc.ports : [];
    for (const p of ports) {
      const raw = String(p);
      let body = raw;
      let proto = '';
      const slash = raw.lastIndexOf('/');
      if (slash !== -1) {
        body = raw.slice(0, slash);
        proto = raw.slice(slash + 1);
      }
      const segs = splitRespectingBraces(body, ':');
      let reason = null;
      if (proto !== '' && !['tcp', 'udp', 'sctp'].includes(proto)) {
        reason = `协议后缀 "${proto}" 非法（仅 tcp/udp/sctp）`;
      } else if (segs.length === 0 || segs.length > 3) {
        reason = `端口段数为 ${segs.length}（合法形态：C / H:C / IP:H:C）`;
      } else if (segs.some((s) => s.length === 0)) {
        reason = '端口段为空';
      } else if (!segs.every((s) => isValidPortSegment(s))) {
        reason = '端口段含非数字字符（仅允许数字或 ${VAR} 变量）';
      } else {
        // 纯数字段必须落在 1-65535
        for (const s of segs) {
          if (/^\d+$/.test(s)) {
            const n = Number(s);
            if (n < 1 || n > 65535) {
              reason = `端口号 ${n} 越界（合法范围 1-65535）`;
              break;
            }
          }
        }
        // "C" 形态（仅容器端口，expose 风格）本身合法，无需额外校验
      }
      if (!reason) continue;
      out.push(finding('P1', 'port.format', ctx, {
        message: `services.${name} 的端口映射 "${raw}" 语法非法：${reason}`,
        actual: raw,
        expected: 'C / H:C / IP:H:C 形态，端口号 1-65535，协议后缀仅 tcp/udp/sctp',
      }));
    }
  }
  return out;
}

/** 卷 mode 合法取值 */
const VOLUME_MODES = new Set(['ro', 'rw', 'z', 'Z', 'nocopy', 'consistent', 'cached', 'delegated']);

/**
 * volume.format（P1）：卷映射语法校验（不重复既有 volume.path 的危险路径判定）。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkVolumeFormat(ctx) {
  const out = [];
  const declaredTop = new Set(Object.keys(ctx.composeDoc?.volumes ?? {}));
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const vols = Array.isArray(svc?.volumes) ? svc.volumes : [];
    for (const v of vols) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 长语法
        const target = v.target;
        if (!target || typeof target !== 'string' || !target.startsWith('/')) {
          out.push(finding('P1', 'volume.format', ctx, {
            message: `services.${name} 的长语法卷缺少合法的绝对路径 target`,
            actual: JSON.stringify(v),
            expected: 'target 必填且为绝对路径（如 /data）',
          }));
          continue;
        }
        const src = v.source;
        if (v.type === 'volume' && isNamedVolumeSource(src) && !declaredTop.has(src)) {
          out.push(finding('P1', 'volume.format', ctx, {
            message: `services.${name} 引用了未在顶层 volumes 声明的命名卷 "${src}"`,
            actual: `source=${src}`,
            expected: `顶层 volumes 声明 ${src}`,
          }));
        }
        continue;
      }
      const raw = String(v);
      const segs = splitRespectingBraces(raw, ':');
      if (segs.length < 2) {
        out.push(finding('P1', 'volume.format', ctx, {
          message: `services.${name} 的卷映射 "${raw}" 缺少 target`,
          actual: raw,
          expected: 'source:target[:mode] 形态，target 为绝对路径',
        }));
        continue;
      }
      const [source, target, ...modes] = segs;
      if (target.includes('${')) continue; // 变量型 target 无法静态判定是否为绝对路径
      if (!target.startsWith('/')) {
        out.push(finding('P1', 'volume.format', ctx, {
          message: `services.${name} 的卷映射 target "${target}" 不是绝对路径`,
          actual: raw,
          expected: 'target 必须以 / 开头的绝对路径',
        }));
        continue;
      }
      for (const m of modes) {
        for (const one of m.split(',')) {
          if (!one) continue;
          if (!VOLUME_MODES.has(one)) {
            out.push(finding('P1', 'volume.format', ctx, {
              message: `services.${name} 的卷映射 mode "${one}" 非法`,
              actual: raw,
              expected: `mode 取值 ∈ {${[...VOLUME_MODES].join(', ')}}`,
            }));
          }
        }
      }
      if (isNamedVolumeSource(source) && !declaredTop.has(source)) {
        out.push(finding('P1', 'volume.format', ctx, {
          message: `services.${name} 引用了未在顶层 volumes 声明的命名卷 "${source}"`,
          actual: `source=${source}`,
          expected: `顶层 volumes 声明 ${source}`,
        }));
      }
    }
  }
  return out;
}

/**
 * compose.dep-missing（P1）：服务间依赖指向不存在的服务。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkDepMissing(ctx) {
  const out = [];
  const services = servicesOf(ctx);
  const names = new Set(Object.keys(services));
  for (const [name, svc] of Object.entries(services)) {
    const deps = [];
    const depends = svc?.depends_on;
    if (Array.isArray(depends)) deps.push(...depends.map((d) => String(d)));
    else if (depends && typeof depends === 'object') deps.push(...Object.keys(depends));
    for (const d of deps) {
      if (!names.has(d)) {
        out.push(finding('P1', 'compose.dep-missing', ctx, {
          message: `services.${name}.depends_on 指向不存在的服务 "${d}"`,
          actual: `depends_on: ${d}`,
          expected: `services 中存在 ${d}`,
        }));
      }
    }
    for (const l of (Array.isArray(svc?.links) ? svc.links : [])) {
      const target = String(l).split(':')[0].trim();
      if (!names.has(target)) {
        out.push(finding('P1', 'compose.dep-missing', ctx, {
          message: `services.${name}.links 指向不存在的服务 "${target}"`,
          actual: `links: ${l}`,
          expected: `services 中存在 ${target}`,
        }));
      }
    }
    for (const vf of (Array.isArray(svc?.volumes_from) ? svc.volumes_from : [])) {
      const raw = String(vf).trim();
      if (raw.startsWith('container:')) continue; // 容器外引用，静态无法校验
      const target = raw.split(':')[0].trim();
      if (!names.has(target)) {
        out.push(finding('P1', 'compose.dep-missing', ctx, {
          message: `services.${name}.volumes_from 指向不存在的服务 "${target}"`,
          actual: `volumes_from: ${raw}`,
          expected: `services 中存在 ${target}`,
        }));
      }
    }
  }
  return out;
}

/**
 * compose.deprecated-key（P2）：Compose Spec 已废弃的键。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkDeprecatedKey(ctx) {
  const out = [];
  const doc = ctx.composeDoc;
  if (!doc) return out;
  if (Object.prototype.hasOwnProperty.call(doc, 'version')) {
    out.push(finding('P2', 'compose.deprecated-key', ctx, {
      message: 'compose 顶层存在已废弃的 version 键（Compose Spec 已移除）',
      actual: `version: ${JSON.stringify(doc.version)}`,
      expected: '删除顶层 version 键',
    }));
  }
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    if (Object.prototype.hasOwnProperty.call(svc ?? {}, 'links')) {
      out.push(finding('P2', 'compose.deprecated-key', ctx, {
        message: `services.${name} 使用了已废弃的 links 键（建议改用 depends_on）`,
        actual: `links: ${JSON.stringify(svc.links)}`,
        expected: '删除 links，改用 depends_on / networks',
      }));
    }
  }
  return out;
}

/**
 * compose.network-conflict（P1）：同服务同时设置 network_mode 与 networks。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkNetworkConflict(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const hasNetworkMode = svc?.network_mode !== undefined && svc?.network_mode !== null && svc?.network_mode !== '';
    const hasNetworks = svc?.networks !== undefined && svc?.networks !== null;
    if (!hasNetworkMode || !hasNetworks) continue;
    out.push(finding('P1', 'compose.network-conflict', ctx, {
      message: `services.${name} 同时设置了 network_mode 与 networks（二者互斥）`,
      actual: `network_mode=${svc.network_mode}, networks=${JSON.stringify(svc.networks)}`,
      expected: '二选一：使用 networks（推荐 1panel-network）或 network_mode',
    }));
  }
  return out;
}

/**
 * compose.host-network-ports（P2）：host 网络模式下的 ports 会被忽略。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkHostNetworkPorts(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    if (svc?.network_mode !== 'host') continue;
    const ports = Array.isArray(svc?.ports) ? svc.ports : [];
    if (!ports.length) continue;
    out.push(finding('P2', 'compose.host-network-ports', ctx, {
      message: `services.${name} 使用 network_mode: host，ports 映射会被忽略`,
      actual: `ports: ${JSON.stringify(ports)}`,
      expected: 'host 网络模式下删除 ports，或改用 bridge + networks',
    }));
  }
  return out;
}

/** 会被容器敏感路径覆盖的顶层目录（rw 挂载即破坏容器） */
const SENSITIVE_CONTAINER_PATHS = new Set(['/etc', '/proc', '/sys', '/usr', '/bin', '/sbin', '/lib']);
/** 需要 rw 挂载即告警的宿主敏感路径 */
const SENSITIVE_HOST_PATHS = new Set(['/etc', '/proc', '/sys']);

/**
 * 解析 service 的卷列表为归一结构。
 * @param {object} svc
 * @returns {Array<{source:string, target:string, mode:string, readOnly:boolean, raw:string}>}
 */
function normalizeVolumes(svc) {
  const out = [];
  for (const v of (Array.isArray(svc?.volumes) ? svc.volumes : [])) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push({
        source: typeof v.source === 'string' ? v.source : '',
        target: typeof v.target === 'string' ? v.target : '',
        mode: String(v.read_only === true ? 'ro' : (v.mode ?? '')),
        readOnly: v.read_only === true,
        raw: JSON.stringify(v),
      });
      continue;
    }
    const raw = String(v);
    const segs = splitRespectingBraces(raw, ':');
    const [source = '', target = '', mode = ''] = segs;
    out.push({ source, target, mode, readOnly: mode.split(',').includes('ro'), raw });
  }
  return out;
}

/**
 * runtime.high-privilege（P2，特权叠加为 P0）：只补既有 checkHighPrivilege 未覆盖的项。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkHighPrivilegeExtra(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const flags = [];
    if (svc?.pid === 'host') flags.push('pid: host');
    if (svc?.ipc === 'host') flags.push('ipc: host');
    if (Array.isArray(svc?.security_opt) && svc.security_opt.some((o) => WEAKENING_SECURITY_OPT_RE.test(String(o)))) {
      // ⚠️ 只有「削弱沙箱」的 security_opt 才算高权限：`no-new-privileges:true` 是**加固**，
      //    flag 它会把 bookorbit / open-design 这类写对了的应用误报成高权限。
      flags.push('security_opt(weakening)');
    }
    for (const vol of normalizeVolumes(svc)) {
      const src = vol.source;
      if (!src.startsWith('/')) continue;
      if (src === '/') {
        flags.push('bind: / (根目录)');
        continue;
      }
      if (src.includes('/var/run/docker.sock')) {
        flags.push('bind: /var/run/docker.sock');
        continue;
      }
      if (SENSITIVE_HOST_PATHS.has(src) && !vol.readOnly) {
        flags.push(`bind: ${src} (rw)`);
      }
    }
    // 叠加升级：特权容器 + host 网络
    if (svc?.privileged === true && svc?.network_mode === 'host') {
      out.push(finding('P0', 'runtime.high-privilege', ctx, {
        message: `services.${name} 为特权容器 + host 网络叠加（privileged: true 且 network_mode: host），等于宿主机完全失守`,
        actual: 'privileged: true, network_mode: host',
        expected: '去掉 privileged，改用最小 capability 集 + bridge 网络',
      }));
    }
    if (!flags.length) continue;
    out.push(finding('P2', 'runtime.high-privilege', ctx, {
      message: `services.${name} 含高权限配置（${flags.join(', ')}），需在 .github/lint-exemptions.yml 登记 reason 或补数据卷降权方案`,
      actual: flags.join(', '),
      expected: '最小的 capability/设备集，或显式豁免登记',
    }));
  }
  return out;
}

// ─── 阶段 4：GPU / 硬件加速 ───────────────────────────────────────────────

/**
 * GPU 专属应用白名单。
 *
 * 依据：这些应用**本身就是** GPU 推理/检索类应用，硬编码 GPU 运行时是它们的固有形态，
 * 不存在「CPU 默认部署」这一说。名单精确列举，不做前缀/正则外推。
 * 这是本模块唯一允许的应用级白名单。
 */
export const GPU_EXCLUSIVE_APPS = Object.freeze(['llamacpp', 'infinity', 'qdrant', 'photoprism']);

/** GPU 设备前缀（容器内设备路径） */
const GPU_DEVICE_PREFIXES = ['/dev/dri', '/dev/nvidia', '/dev/kfd'];

/**
 * 判断版本目录名是否为 GPU 变体目录。
 * @param {string} name
 * @returns {boolean}
 */
export function isGpuVariantDirName(name) {
  if (typeof name !== 'string' || !name) return false;
  return /cuda|rocm|vulkan|gpu|nvidia|amd|cu\d{3,}/i.test(name);
}

/**
 * 采集服务的 GPU 信号。
 * @param {object} svc
 * @returns {{hard:Array<string>, soft:Array<string>, vars:Array<string>}}
 *   hard — 字面量硬信号（不可门控）
 *   soft — 变量化信号（可门控）
 *   vars — 软信号里引用的变量名
 */
function collectGpuSignals(svc) {
  const hard = [];
  const soft = [];
  const vars = [];
  const runtime = svc?.runtime;
  if (typeof runtime === 'string' && runtime.length) {
    if (runtime.includes('${')) {
      soft.push(`runtime=${runtime}`);
      const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(runtime);
      if (m) vars.push(m[1]);
    } else {
      hard.push(`runtime=${runtime}`);
    }
  }
  const devices = svc?.deploy?.resources?.reservations?.devices;
  if (Array.isArray(devices)) {
    for (const d of devices) {
      const driver = d?.driver;
      if (typeof driver === 'string' && driver.length) {
        if (driver.includes('${')) {
          soft.push(`deploy.devices.driver=${driver}`);
          const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(driver);
          if (m) vars.push(m[1]);
        } else {
          hard.push(`deploy.devices.driver=${driver}`);
        }
      }
    }
  }
  for (const d of (Array.isArray(svc?.devices) ? svc.devices : [])) {
    const s = String(d);
    if (s.includes('${')) continue;
    const hit = GPU_DEVICE_PREFIXES.find((p) => s.startsWith(p));
    if (hit) hard.push(`devices=${s}`);
  }
  return { hard, soft, vars };
}

/**
 * 该版本 compose 是否含**任何** GPU 信号（硬或软，含 NVIDIA_* 环境变量）。
 * @param {object} ctx
 * @returns {Array<{service:string, signal:string}>}
 */
function anyGpuSignals(ctx) {
  const hits = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const g = collectGpuSignals(svc);
    for (const s of g.hard) hits.push({ service: name, signal: s });
    for (const s of g.soft) hits.push({ service: name, signal: s });
    for (const e of serviceEnvEntries(svc?.environment)) {
      if (/^NVIDIA_/i.test(e.key)) hits.push({ service: name, signal: `env=${e.key}` });
    }
  }
  return hits;
}

/**
 * gpu.unconditional（P1）：非 GPU 专属应用硬编码 GPU 信号。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkGpuUnconditional(ctx) {
  if (GPU_EXCLUSIVE_APPS.includes(ctx.app)) return [];
  if (isGpuVariantDirName(ctx.version)) return []; // 变体目录由 gpu.variant-dir 承担
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const g = collectGpuSignals(svc);
    if (!g.hard.length) continue;
    out.push(finding('P1', 'gpu.unconditional', ctx, {
      message: `services.${name} 硬编码 GPU 信号（${g.hard.join(', ')}），CPU 默认部署会直接起不来`,
      actual: `${name}: ${g.hard.join(', ')}`,
      expected: 'CPU 默认部署不应硬编码 GPU（改用变量门控，或拆 GPU 变体目录）',
    }));
  }
  return out;
}

/**
 * gpu.gated-default-on（P2）：GPU 信号变量化但默认值使 GPU 默认开启。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkGpuGatedDefaultOn(ctx) {
  const out = [];
  const defaults = new Map();
  for (const f of versionFormFields(ctx)) {
    if (f?.envKey) defaults.set(f.envKey, f.default);
  }
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const g = collectGpuSignals(svc);
    if (!g.soft.length) continue;
    for (const v of g.vars) {
      const d = defaults.get(v);
      if (d === undefined || d === null) continue;
      const ds = String(d).trim();
      if (ds === '') continue; // 空默认值 = 真正的门控
      if (!/nvidia|cuda|rocm|gpu|vulkan/i.test(ds)) continue;
      out.push(finding('P2', 'gpu.gated-default-on', ctx, {
        message: `services.${name} 的 GPU 开关变量 ${v} 默认值 ${ds} → 默认开启（变量化但没真正门控）`,
        actual: `${v} default=${ds}`,
        expected: '默认值留空（真正门控）或改为 CPU 默认值',
      }));
    }
  }
  return out;
}

/**
 * gpu.documented（P1）：含 GPU 信号但 README 未说明前置条件。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkGpuDocumented(ctx) {
  const hits = anyGpuSignals(ctx);
  if (!hits.length) return [];
  const readme = ctx.readmeRaw ?? '';
  if (/nvidia|container[ -]?toolkit/i.test(readme)) return [];
  return [finding('P1', 'gpu.documented', ctx, {
    file: ctx.composePath ?? ctx.readmePath,
    message: `该版本含 GPU 信号（${hits.map((h) => `${h.service}: ${h.signal}`).join(', ')}），但 README 未提到 nvidia / container toolkit 前置条件`,
    actual: hits.map((h) => `${h.service}: ${h.signal}`).join(', '),
    expected: 'README 写明需要 nvidia 驱动与 nvidia-container-toolkit',
  })];
}

/**
 * gpu.device-group-doc（P2）：挂载 /dev/dri 但 README 未说明 render / video 组。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkGpuDeviceGroupDoc(ctx) {
  let hit = null;
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    for (const d of (Array.isArray(svc?.devices) ? svc.devices : [])) {
      const s = String(d);
      if (s.startsWith('/dev/dri')) { hit = { service: name, device: s }; break; }
    }
    if (hit) break;
  }
  if (!hit) return [];
  const readme = ctx.readmeRaw ?? '';
  if (/render/i.test(readme) || /video/i.test(readme)) return [];
  return [finding('P2', 'gpu.device-group-doc', ctx, {
    message: `services.${hit.service} 挂载了 ${hit.device}，但 README 未说明 render / video 用户组`,
    actual: `devices: ${hit.device}`,
    expected: 'README 说明把运行用户加入 render 或 video 组',
  })];
}

/**
 * gpu.variant-dir（P3 / UNVERIFIED）：GPU 专属变体目录需实机验证。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkGpuVariantDir(ctx) {
  if (!isGpuVariantDirName(ctx.version)) return [];
  return [finding('P3', 'gpu.variant-dir', ctx, {
    message: `该版本为 GPU 专属变体，需 GPU 硬件环境验证，当前标 UNVERIFIED（目录 ${ctx.version}）`,
    actual: `版本目录 ${ctx.version}`,
    expected: '在具备 nvidia/vulkan 的宿主机上实机部署验证后再解除 UNVERIFIED',
  })];
}

/**
 * hw.devices-missing（P2）：宿主机不一定存在的设备映射。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkHwDevicesMissing(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    for (const d of (Array.isArray(svc?.devices) ? svc.devices : [])) {
      const s = String(d);
      const m = /^(\/dev\/net\/tun|\/dev\/kfd|\/dev\/nvidia\S*)/.exec(s);
      if (!m) continue;
      out.push(finding('P2', 'hw.devices-missing', ctx, {
        message: `services.${name} 映射了宿主机不一定存在的设备 ${m[1]}（需对应内核模块/驱动）`,
        actual: `devices: ${s}`,
        expected: 'README 说明宿主机需加载对应内核模块，或提供不依赖该设备的部署方式',
      }));
    }
  }
  return out;
}

// ─── 阶段 5：运行身份与持久化 ─────────────────────────────────────────────

/**
 * identity.puid-unsupported（P2）：镜像不支持 PUID/PGID（依据 imageConfig.env，不猜测）。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkPuidUnsupported(ctx) {
  if (!ctx.manifests) return []; // 离线模式：不产出
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const envKeys = serviceEnvEntries(svc?.environment).map((e) => e.key);
    const declared = envKeys.filter((k) => /^(PUID|PGID)$/i.test(k));
    if (!declared.length) continue;
    const image = imageOf(svc);
    if (!image) continue;
    const m = ctx.manifests.get(image);
    const imageConfig = m?.imageConfig;
    if (!imageConfig) continue; // 无 imageConfig → 不判定
    const imageEnv = Array.isArray(imageConfig.env) ? imageConfig.env : [];
    if (!imageEnv.length) continue; // 空 env 无法判定
    const imageEnvKeys = imageEnv.map((e) => String(e).split('=')[0]);
    const missing = declared.filter((k) => !imageEnvKeys.includes(k));
    if (!missing.length) continue;
    out.push(finding('P2', 'identity.puid-unsupported', ctx, {
      message: `services.${name} 声明了 ${missing.join(', ')}，但镜像 ${image} 的 imageConfig 中没有这些变量`,
      actual: `env: ${declared.join(', ')}；imageConfig.env 缺 ${missing.join(', ')}`,
      expected: '镜像确实支持该变量，或改用 compose user: 指定运行身份',
    }));
  }
  return out;
}

/**
 * identity.user-unsupported（P1）：compose 指定非 root 用户但镜像默认 root。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkUserUnsupported(ctx) {
  if (!ctx.manifests) return [];
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const user = svc?.user;
    if (typeof user !== 'string' || !user.length) continue;
    if (user.includes('${')) continue; // 变量写法合法
    const isRoot = /^(0|root)(:0)?$/i.test(user.trim());
    if (isRoot) continue;
    const image = imageOf(svc);
    if (!image) continue;
    const m = ctx.manifests.get(image);
    const imageConfig = m?.imageConfig;
    if (!imageConfig) continue;
    const imageUser = typeof imageConfig.user === 'string' ? imageConfig.user.trim() : '';
    if (imageUser) continue; // 镜像已设用户
    out.push(finding('P1', 'identity.user-unsupported', ctx, {
      message: `services.${name} 指定 user: ${user}，但镜像 ${image} 默认以 root 运行，宿主机挂载目录属主会不匹配`,
      actual: `compose user=${user}；imageConfig.user 为空`,
      expected: '宿主机侧对挂载目录 chown，或在镜像内建对应用户',
    }));
  }
  return out;
}

/**
 * 「否定语境」标记：README 在这些词附近提到 PUID/PGID，是在说明**镜像不支持**
 * （例：「官方镜像没有 PUID/PGID 支持」「不要在 compose 里改写成 PUID/PGID」），
 * 这类表述与 compose 不设 PUID/PGID **完全一致**，不是漂移。
 * @type {RegExp}
 */
const NEGATION_CONTEXT_RE = /不支持|没有|不要|无需|不识别|不适用|不能|忽略|不予|无需设置|not\s+support|don'?t|do\s+not|without|no\s+puid/i;
/** README 中 PUID/PGID 提及处的语境窗口（字符） */
const NEGATION_WINDOW = 160;

/**
 * identity.readme-drift（P2）：README 提到 PUID/PGID 但 compose 未设置。
 *
 * ⚠️ 口径（实测踩坑后收紧，2026-11）：本仓多个应用的 README **故意**解释
 * 「官方镜像没有 PUID/PGID 支持」（collabora / opencloud / vaultwarden），
 * 这与 compose 不设 PUID/PGID 是一致的。故只有在**找不到任何否定语境**时才算漂移。
 *
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkReadmeDrift(ctx) {
  const readme = ctx.readmeRaw ?? '';
  const mentions = [...readme.matchAll(/PUID|PGID/gi)];
  if (!mentions.length) return [];
  // 全部提及都在否定语境里 → 是「说明不支持」，不是漂移
  const allNegated = mentions.every((m) => {
    const lo = Math.max(0, m.index - NEGATION_WINDOW);
    const hi = Math.min(readme.length, m.index + m[0].length + NEGATION_WINDOW);
    return NEGATION_CONTEXT_RE.test(readme.slice(lo, hi));
  });
  if (allNegated) return [];
  let has = false;
  for (const svc of Object.values(servicesOf(ctx))) {
    for (const e of serviceEnvEntries(svc?.environment)) {
      if (/^(PUID|PGID)$/i.test(e.key)) { has = true; break; }
    }
    if (has) break;
  }
  if (has) return [];
  return [finding('P2', 'identity.readme-drift', ctx, {
    message: 'README 提到 PUID/PGID，但该版本 compose 没有任何 PUID/PGID 环境变量（文档漂移）',
    actual: 'README 含 PUID/PGID；compose 无对应 env',
    expected: 'compose 补上 PUID/PGID，或修正 README 描述',
  })];
}

/** 疑似「宿主目录」首段集合（启发式，仅提示） */
const HOSTLIKE_FIRST_SEGMENTS = new Set(['app', 'data', 'config', 'usr', 'bin', 'sbin', 'lib', 'tmp', 'home', 'root', 'var', 'opt', 'etc']);

/**
 * 取路径 basename。
 * @param {string} p
 * @returns {string}
 */
function baseName(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * volume.mount-target（P2）：宿主路径与容器目标路径疑似写反。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkMountTarget(ctx) {
  const out = [];
  const defaults = new Map();
  for (const f of versionFormFields(ctx)) if (f?.envKey) defaults.set(f.envKey, f.default);
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    for (const vol of normalizeVolumes(svc)) {
      const { source, target } = vol;
      if (!target || !source) continue;
      if (!target.startsWith('/')) continue;
      let hostPath = null;
      const vm = /^\$\{([A-Za-z_][A-Za-z0-9_]*)/.exec(source);
      if (vm) {
        const d = defaults.get(vm[1]);
        if (typeof d !== 'string' || !d.startsWith('/')) continue;
        hostPath = d;
      } else if (source.startsWith('/')) {
        hostPath = source;
      } else {
        continue;
      }
      const first = hostPath.split('/').filter(Boolean)[0];
      if (!first || !HOSTLIKE_FIRST_SEGMENTS.has(first)) continue;
      if (baseName(hostPath) === baseName(target)) continue;
      out.push(finding('P2', 'volume.mount-target', ctx, {
        message: `services.${name} 的挂载疑似宿主路径与容器目标写反（宿主 "${hostPath}" vs 容器 "${target}"）`,
        actual: `${vol.raw}（宿主解析为 ${hostPath}）`,
        expected: `宿主与容器目录名一致，或显式声明为应用自有目录`,
      }));
    }
  }
  return out;
}

/**
 * volume.mounted-sensitive（P2）：rw 挂载覆盖容器敏感目录。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkMountedSensitive(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    for (const vol of normalizeVolumes(svc)) {
      const target = vol.target;
      if (!target || !SENSITIVE_CONTAINER_PATHS.has(target)) continue; // 子路径合法
      if (vol.readOnly) continue;
      out.push(finding('P2', 'volume.mounted-sensitive', ctx, {
        message: `services.${name} 以 rw 挂载覆盖容器敏感目录 ${target}`,
        actual: vol.raw,
        expected: '改为 ro，或挂载到应用自有子目录（如 /etc/app）',
      }));
    }
  }
  return out;
}

/** 开发者本机路径特征（命中任一即视为泄露） */
const PATH_LEAK_PATTERNS = [
  /\/home\/[^/]+\//,
  /\/Users\//,
  /\/root\//,
  /\/workspace\//,
  /\/projects\//,
  /\/repos\//,
  /\.agent_cache\//,
  /1panel-local-apps/,
];
/** 正常前缀（出现即整体排除） */
const PATH_LEAK_ALLOWED_PREFIXES = ['/opt/1panel', '/mnt', '/srv', '/data/1panel'];

/**
 * default.path-leak（P1）：formField 默认值泄露开发者本机路径。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkPathLeak(ctx) {
  const out = [];
  for (const f of versionFormFields(ctx)) {
    const d = f?.default;
    if (typeof d !== 'string') continue;
    const p = d.trim();
    if (!p.startsWith('/')) continue;
    if (PATH_LEAK_ALLOWED_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'))) continue;
    const hit = PATH_LEAK_PATTERNS.some((re) => re.test(p));
    if (!hit) continue;
    out.push(finding('P1', 'default.path-leak', ctx, {
      file: ctx.dataPath,
      message: `formField ${f.envKey ?? '?'} 的默认值泄露了开发者本机路径`,
      actual: `${f.envKey ?? '?'}=${p}`,
      expected: '使用 1Panel 宿主机通用路径（如 /opt/1panel/...）或相对路径',
    }));
  }
  return out;
}

/**
 * parse.bom（P2）：原始文本带 BOM。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkBom(ctx) {
  const out = [];
  if (typeof ctx.versionRaw === 'string' && ctx.versionRaw.startsWith('\uFEFF')) {
    out.push(finding('P2', 'parse.bom', ctx, {
      file: ctx.dataPath,
      message: '版本级 data.yml 以 BOM 开头，会导致行号定位偏移',
      actual: 'U+FEFF',
      expected: '以 UTF-8 无 BOM 保存',
    }));
  }
  if (typeof ctx.composeRaw === 'string' && ctx.composeRaw.startsWith('\uFEFF')) {
    out.push(finding('P2', 'parse.bom', ctx, {
      message: 'docker-compose.yml 以 BOM 开头，会导致行号定位偏移',
      actual: 'U+FEFF',
      expected: '以 UTF-8 无 BOM 保存',
    }));
  }
  return out;
}

// ─── 阶段 6：网络与依赖就绪 ───────────────────────────────────────────────

/** 外部技术栈关键词 */
const STACK_KEYWORDS = ['mysql', 'mariadb', 'postgres', 'postgresql', 'redis', 'mongodb', 'mssql', 'clickhouse', 'rabbitmq', 'elasticsearch', 'minio'];
/** 连接变量名后缀 */
const CONNECTION_VAR_RE = /(^|_)(HOST|PORT|USER|USERNAME|PASSWORD|PASS|URL|DSN|ADDR|ADDRESS|ENDPOINT|SERVER|URI|CONNECTION_STRING|CONN_STRING)$/i;
/** 明确不是「外部连接变量」的 key 片段 */
const NON_CONNECTION_KEY_RE = /BACKEND|TYPE|DRIVER/i;
/**
 * 「削弱沙箱」的 security_opt 取值（`no-new-privileges:true` 这类**加固**不算）。
 * @type {RegExp}
 */
const WEAKENING_SECURITY_OPT_RE = /(seccomp\s*[:=]\s*unconfined|apparmor\s*[:=]\s*unconfined|label\s*[:=]\s*disable|systempaths\s*=\s*unconfined)/i;
/**
 * 变量引用（派生变量的值由其它变量拼装而成）。
 * @type {RegExp}
 */
const VAR_REF_RE = /\$\{[^}]+\}/;
/**
 * 连接端点形态：scheme:// 或 host:port。
 * @type {RegExp}
 */
const ENDPOINT_RE = /[a-z][a-z0-9+.-]*:\/\/|\b[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\b|:\d{2,5}\b/i;

/**
 * 判断某个 env 是否属于「外部数据库/缓存连接变量」。
 * @param {{key:string, value:string}} entry
 * @returns {{stack:string|null, isConnection:boolean}}
 */
function classifyConnectionVar(entry) {
  const key = entry.key;
  const value = entry.value ?? '';
  if (NON_CONNECTION_KEY_RE.test(key)) return { stack: null, isConnection: false };
  if (!CONNECTION_VAR_RE.test(key)) return { stack: null, isConnection: false };
  const stack = STACK_KEYWORDS.find((k) => key.toLowerCase().includes(k) || String(value).toLowerCase().includes(k));
  return { stack: stack ?? null, isConnection: true };
}

/**
 * compose 内置了同技术栈服务 → 该栈视为内置，不报。
 * @param {object} ctx
 * @returns {Set<string>}
 */
function builtinStacks(ctx) {
  const set = new Set();
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const hay = `${name} ${imageOf(svc) ?? ''}`.toLowerCase();
    for (const k of STACK_KEYWORDS) if (hay.includes(k)) set.add(k);
  }
  return set;
}

/**
 * dep.external-undeclared（P1）：外部连接端点**写死**且没有对应的可注入变量。
 *
 * ⚠️ 口径（实测踩坑后收紧，2026-11）：
 *   本仓绝大多数外部连接变量都是**派生变量**——值由其它 `${VAR}` 拼装而成
 *   （如 `REDIS_URL=redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`、
 *   `POSTGRES_DSN=postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`）。
 *   这类变量**本身不需要** formField：它的组件变量才是 1Panel 真正要注入的东西，
 *   组件漏声明由既有 `var.undeclared`（P0）负责。
 *   所以本规则只针对**字面量端点**（值里没有任何 `${}`）——那才是 1Panel 无法配置、
 *   用户改不了的真问题。
 *
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkDepExternalUndeclared(ctx) {
  const declared = declaredEnvKeys(ctx);
  const builtin = builtinStacks(ctx);
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    for (const e of serviceEnvEntries(svc?.environment)) {
      if (!e.key) continue;
      const { stack, isConnection } = classifyConnectionVar(e);
      if (!isConnection || !stack) continue;
      const v = String(e.value ?? '').trim();
      // 派生变量：组件变量才是注入契约，不在本规则范围内
      if (VAR_REF_RE.test(v)) continue;
      if (declared.has(e.key)) continue;
      // 刻意硬编码的常量：纯数字值 / 值恰为技术栈单词
      if (/^\d+$/.test(v)) continue;
      if (STACK_KEYWORDS.includes(v.toLowerCase())) continue;
      if (!ENDPOINT_RE.test(v)) continue; // 只是凭据名/开关，不是连接端点
      if (builtin.has(stack)) continue; // 同 compose 内置该技术栈
      out.push(finding('P1', 'dep.external-undeclared', ctx, {
        message: `services.${name} 的 ${e.key} 把外部 ${stack} 端点写死在 compose 里，formFields 未声明任何可配置项（用户无法改成自己的实例）`,
        actual: `${e.key}=${v}`,
        expected: `在版本级 data.yml.formFields 声明 envKey=${e.key}（或改为变量引用）`,
      }));
    }
  }
  return out;
}

/**
 * 收集版本级 formFields 的所有 label 文本。
 * @param {object} ctx
 * @returns {string}
 */
function labelTextOf(ctx) {
  const parts = [];
  for (const f of versionFormFields(ctx)) {
    if (!f) continue;
    if (typeof f.label === 'string') parts.push(f.label);
    else if (f.label && typeof f.label === 'object') parts.push(Object.values(f.label).map(String).join(' '));
    if (f.labelEn) parts.push(String(f.labelEn));
    if (f.labelZh) parts.push(String(f.labelZh));
    if (f.name) parts.push(String(f.name));
  }
  return parts.join(' ');
}

/**
 * 取某个 envKey 对应 formField 的 label 文本。
 * @param {object} ctx
 * @param {string} envKey
 * @returns {string}
 */
function labelOfEnvKey(ctx, envKey) {
  const parts = [];
  for (const f of versionFormFields(ctx)) {
    if (!f || f.envKey !== envKey) continue;
    if (typeof f.label === 'string') parts.push(f.label);
    else if (f.label && typeof f.label === 'object') parts.push(Object.values(f.label).map(String).join(' '));
    if (f.labelEn) parts.push(String(f.labelEn));
    if (f.labelZh) parts.push(String(f.labelZh));
    if (f.name) parts.push(String(f.name));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * dep.external-missing（P2）：外部依赖未在表单文案里说明。
 *
 * ⚠️ 口径（实测踩坑后收紧，2026-11）：
 *   只有**真正带连接端点**的变量才算外部依赖：
 *   - 派生连接串（`REDIS_URL=redis://:${REDIS_HOST}:${REDIS_PORT}`）→ 组件变量的 label 就是说明，
 *     逐个组件查 label 是否提到该技术栈；
 *   - 字面量端点 → 直接查该变量自身的 label。
 *   仅是凭据名/开关（`MINIO_ROOT_USER=${MINIO_ROOT_USER}` 这类**镜像内置**服务的凭据）
 *   **不算**外部依赖 —— 否则 silo（镜像内置 MinIO）会被误报。
 *   同理，**派生连接串**（值由其它 `${VAR}` 拼装）的说明责任落在**组件变量**的 label 上，
 *   而组件 label 由 `var.undeclared` / 表单文案负责；本规则只盯**字面量端点**
 *   （值里没有 `${}`），那是 compose 把外部地址写死、用户改不了的场景。
 *
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkDepExternalMissing(ctx) {
  const declared = declaredEnvKeys(ctx);
  const out = [];
  const seen = new Set();
  for (const svc of Object.values(servicesOf(ctx))) {
    for (const e of serviceEnvEntries(svc?.environment)) {
      if (!e.key) continue;
      const { stack, isConnection } = classifyConnectionVar(e);
      if (!isConnection || !stack) continue;
      const v = String(e.value ?? '').trim();
      if (!ENDPOINT_RE.test(v)) continue; // 没有端点 → 不是连接（可能是内置服务的凭据）
      if (VAR_REF_RE.test(v)) continue;   // 派生连接串 → 说明责任在组件变量上
      const probes = declared.has(e.key) ? [e.key] : [];
      if (!probes.length) continue;
      if (probes.some((p) => labelOfEnvKey(ctx, p).includes(stack))) continue;
      if (seen.has(stack)) continue;
      seen.add(stack);
      out.push(finding('P2', 'dep.external-missing', ctx, {
        message: `compose 依赖外部 ${stack}（${e.key}），但版本级 formFields 的文案里没有任何关于 ${stack} 的说明`,
        actual: `${e.key}（${stack}）`,
        expected: `在表单 label / 描述中说明外部 ${stack} 的配置要求`,
      }));
    }
  }
  return out;
}

/**
 * dep.ready-condition（P2）：依赖的服务没有 healthcheck。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkDepReadyCondition(ctx) {
  const out = [];
  const services = servicesOf(ctx);
  for (const [name, svc] of Object.entries(services)) {
    const depends = svc?.depends_on;
    const entries = [];
    if (Array.isArray(depends)) {
      for (const d of depends) entries.push({ target: String(d), condition: null });
    } else if (depends && typeof depends === 'object') {
      for (const [k, v] of Object.entries(depends)) {
        entries.push({ target: String(k), condition: v?.condition ?? null });
      }
    }
    for (const e of entries) {
      const dep = services[e.target];
      if (!dep) continue; // 由 compose.dep-missing 负责
      if (e.condition === 'service_healthy') continue;
      if (dep.healthcheck) continue;
      out.push(finding('P2', 'dep.ready-condition', ctx, {
        message: `services.${name} 依赖 services.${e.target}，但对方没有 healthcheck，依赖未就绪可能导致启动失败`,
        actual: `depends_on: ${e.target}（无 healthcheck）`,
        expected: '为被依赖服务补 healthcheck，或使用 depends_on condition: service_healthy',
      }));
    }
  }
  return out;
}

// ─── 阶段 3：架构 ──────────────────────────────────────────────────────────

/**
 * 把 manifest platform 字符串（如 linux/arm64/v7）归一到 ARCH_ENUM 口径。
 * @param {string} platform
 * @returns {string|null}
 */
export function archOfPlatform(platform) {
  if (typeof platform !== 'string') return null;
  const parts = platform.toLowerCase().split('/');
  if (parts.length < 2) return null;
  const arch = parts[1];
  const variant = parts[2];
  if (arch === 'arm') {
    if (variant === 'v7') return 'arm/v7';
    if (variant === 'v6') return 'arm/v6';
    return null;
  }
  if (arch === 'arm64') return 'arm64';
  if (arch === 'amd64' || arch === 'x86_64') return 'amd64';
  if (arch === '386' || arch === 'i386') return '386';
  return null;
}

/**
 * 从版本目录名推断架构（末段 - 后缀）。
 * @param {string} name
 * @returns {string|null}
 */
export function archFromDirName(name) {
  if (typeof name !== 'string' || !name) return null;
  const seg = name.split('-').pop() ?? '';
  if (/^arm64(v\d+)?$/.test(seg)) return 'arm64';
  if (/^arm32v7$/.test(seg)) return 'arm/v7';
  if (/^arm32v\d+$/.test(seg)) return null;
  return null;
}

/**
 * 收集该版本所有服务镜像及其 manifest 结果。
 * @param {object} ctx
 * @returns {Array<{service:string, image:string, manifest:object|null}>}
 */
/**
 * 解析服务实际使用的镜像字符串。
 *
 * ⚠️ 变量型镜像（`${IMAGE}:${APP_VERSION}`）必须按版本级 formFields 的 default 解析成
 *    具体镜像，否则 manifest 查不到 → 会被误标成「架构未验证」。
 *    解析口径与 bin/manifest-collector.mjs 一致（共用 lib/compose.mjs#resolveImageTemplate）。
 *
 * @param {object} ctx
 * @param {object} svc
 * @returns {string|null}
 */
function resolveServiceImage(ctx, svc) {
  const raw = imageOf(svc);
  if (!raw) return null;
  if (!raw.includes('${')) return raw;
  const tpl = resolveImageTemplate(raw, versionFormFields(ctx));
  if (!tpl) return null;
  return tpl.defaultVal.startsWith(`${tpl.imageRepo}:`)
    ? tpl.defaultVal
    : `${tpl.imageRepo}:${tpl.defaultVal}`;
}

/**
 * 收集每个服务的镜像与对应 manifest 结果。
 *
 * ⚠️ 变量型镜像**解析不出来**时不能静默跳过 —— 跳过等于把「未验证」当成「验证通过」
 *    （目标 §五.3 明令禁止）。保留原始模板并标记 unresolved，由 arch.unverified（P3）如实报出。
 *
 * @param {object} ctx
 * @returns {Array<{service:string, image:string, manifest:object|null, unresolved:boolean}>}
 */
function serviceManifests(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(servicesOf(ctx))) {
    const raw = imageOf(svc);
    if (!raw) continue;
    const resolved = resolveServiceImage(ctx, svc);
    const image = resolved ?? raw;
    const m = ctx.manifests ? (ctx.manifests.get(image) ?? null) : null;
    out.push({ service: name, image, manifest: m, unresolved: resolved === null });
  }
  return out;
}

/**
 * 计算所有服务镜像架构的交集（木桶效应）。
 * @param {Array<{manifest:object|null}>} items
 * @returns {{ok:boolean, intersection:Set<string>|null}}
 */
function platformIntersection(items) {
  if (!items.length) return { ok: false, intersection: null };
  let acc = null;
  for (const it of items) {
    const m = it.manifest;
    if (!m || m.status !== 'ok' || !Array.isArray(m.platforms) || !m.platforms.length) return { ok: false, intersection: null };
    const set = new Set(m.platforms.map(archOfPlatform).filter(Boolean));
    if (!set.size) return { ok: false, intersection: null };
    acc = acc === null ? set : new Set([...acc].filter((a) => set.has(a)));
  }
  return { ok: acc !== null, intersection: acc };
}

/**
 * arch.overdeclared（P1）：声明了镜像未发布的架构。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkArchOverdeclared(ctx) {
  if (!ctx.manifests) return [];
  const declared = ctx.rootDoc?.additionalProperties?.architectures;
  if (!Array.isArray(declared) || !declared.length) return [];
  const { ok, intersection } = platformIntersection(serviceManifests(ctx));
  if (!ok) return [];
  const bad = declared.filter((d) => !intersection.has(String(d)));
  if (!bad.length) return [];
  return [finding('P1', 'arch.overdeclared', ctx, {
    file: ctx.readmePath ?? ctx.composePath,
    message: `应用声明了镜像实际未发布的架构：${bad.join(', ')}`,
    actual: `declared: ${declared.join(', ')}；实际交集: ${[...intersection].join(', ') || '(空)'}`,
    expected: `declared 只保留镜像实际发布的架构（${[...intersection].join(', ')}）`,
  })];
}

/**
 * arch.underdeclared（P2）：镜像发布但未声明的架构。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkArchUnderdeclared(ctx) {
  if (!ctx.manifests) return [];
  const declared = ctx.rootDoc?.additionalProperties?.architectures;
  if (!Array.isArray(declared)) return []; // 未声明 = 不算问题
  const { ok, intersection } = platformIntersection(serviceManifests(ctx));
  if (!ok) return [];
  const missing = [...intersection].filter((a) => !declared.includes(a));
  if (!missing.length) return [];
  return [finding('P2', 'arch.underdeclared', ctx, {
    file: ctx.readmePath ?? ctx.composePath,
    message: `镜像实际发布了但应用未声明的架构：${missing.join(', ')}`,
    actual: `declared: ${declared.join(', ')}；实际交集: ${[...intersection].join(', ')}`,
    expected: `declared 补齐 ${missing.join(', ')}`,
  })];
}

/**
 * arch.bucket-conflict（P1）：多服务镜像架构交集为空。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkArchBucketConflict(ctx) {
  if (!ctx.manifests) return [];
  const items = serviceManifests(ctx);
  if (items.length < 2) return [];
  for (const it of items) {
    const m = it.manifest;
    if (!m || m.status !== 'ok' || !Array.isArray(m.platforms) || !m.platforms.length) return []; // 未全部验证 → 不判定
  }
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = new Set(items[i].manifest.platforms);
      const b = new Set(items[j].manifest.platforms);
      const shared = [...a].filter((p) => b.has(p));
      if (shared.length) continue;
      out.push(finding('P1', 'arch.bucket-conflict', ctx, {
        message: `镜像 ${items[i].image} 与 ${items[j].image} 的架构交集为空（木桶效应），该应用在这些架构上不可用`,
        actual: `${items[i].image}: ${[...a].join(', ')}；${items[j].image}: ${[...b].join(', ')}`,
        expected: '两个服务镜像支持同一组架构，或拆分版本目录',
      }));
    }
  }
  return out;
}

/**
 * arch.versiondir-mismatch（P1）：版本目录名蕴含的架构未被镜像发布。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkArchVersionDirMismatch(ctx) {
  if (!ctx.manifests) return [];
  const arch = archFromDirName(ctx.version);
  if (!arch) return [];
  const { ok, intersection } = platformIntersection(serviceManifests(ctx));
  if (!ok) return [];
  if (intersection.has(arch)) return [];
  return [finding('P1', 'arch.versiondir-mismatch', ctx, {
    message: `版本目录名蕴含的架构 ${arch} 未被该版本镜像实际发布（实际交集：${[...intersection].join(', ') || '(空)'}）`,
    actual: `版本目录 ${ctx.version} → ${arch}`,
    expected: `镜像同时发布 ${arch}`,
  })];
}

/**
 * arch.unverified（P3 / UNVERIFIED）：manifest 未取到（一个版本目录一条）。
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function checkArchUnverified(ctx) {
  if (!ctx.manifests) return [];
  const misses = [];
  for (const it of serviceManifests(ctx)) {
    const m = it.manifest;
    if (m && m.status === 'ok') continue;
    const reason = it.unresolved
      ? '变量型镜像无法解析为具体镜像（formFields 缺少 IMAGE/TAG 类声明）'
      : (m?.reason ?? '未取到 manifest');
    misses.push(`${it.image}（${reason}）`);
  }
  if (!misses.length) return [];
  return [finding('P3', 'arch.unverified', ctx, {
    message: `该版本有镜像 manifest 未取到，架构结论无法验证（UNVERIFIED）：${misses.join('; ')}`,
    actual: misses.join('; '),
    expected: '在可访问 registry 的环境下补取 manifest 后再判定架构',
  })];
}

// ─── 聚合 ──────────────────────────────────────────────────────────────────

/**
 * 运行全部部署兼容性规则。
 * @param {object} ctx - 见模块头部的 ctx 形状说明
 * @returns {Array<object>} findings
 */
export function runDeployCompatChecks(ctx) {
  return [
    // 阶段 2
    ...checkComposeRender(ctx),
    ...checkPortFormat(ctx),
    ...checkVolumeFormat(ctx),
    ...checkDepMissing(ctx),
    ...checkDeprecatedKey(ctx),
    ...checkNetworkConflict(ctx),
    ...checkHostNetworkPorts(ctx),
    ...checkHighPrivilegeExtra(ctx),
    // 阶段 4
    ...checkGpuUnconditional(ctx),
    ...checkGpuGatedDefaultOn(ctx),
    ...checkGpuDocumented(ctx),
    ...checkGpuDeviceGroupDoc(ctx),
    ...checkGpuVariantDir(ctx),
    ...checkHwDevicesMissing(ctx),
    // 阶段 5
    ...checkPuidUnsupported(ctx),
    ...checkUserUnsupported(ctx),
    ...checkReadmeDrift(ctx),
    ...checkMountTarget(ctx),
    ...checkMountedSensitive(ctx),
    ...checkPathLeak(ctx),
    ...checkBom(ctx),
    // 阶段 6
    ...checkDepExternalUndeclared(ctx),
    ...checkDepExternalMissing(ctx),
    ...checkDepReadyCondition(ctx),
    // 阶段 3
    ...checkArchOverdeclared(ctx),
    ...checkArchUnderdeclared(ctx),
    ...checkArchBucketConflict(ctx),
    ...checkArchVersionDirMismatch(ctx),
    ...checkArchUnverified(ctx),
  ];
}
