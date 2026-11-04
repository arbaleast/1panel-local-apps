// lib/consistency.mjs — SSOT 跨文件一致性规则引擎（阶段 3）
//
// 定位：纯规则引擎层。输入是「已解析的文档 + 原始文本」，输出结构化 findings；
// 不做 fs 访问、不解析 YAML —— 调用方（bin/lint-apps.mjs）负责扫描与解析。
// 这样规则层可以被单测直接喂入合成 fixture，也便于豁免机制在 bin 层统一套用。
//
// 严重等级约定（Gate 1 获批矩阵）：
//   P0/P1 → error（exit 1）；P2 → warning（exit 0，GA annotation 提示）。
//
// 零误杀（Zero False Positives）基线来自阶段 1/2 全仓只读审计 + 逐规则边界实证：
//   - var.undeclared      → 21 实例（scrob×18 / jellystat×2 / llmwiki×1）；
//   - form.orphan         → 142（P2，阶段 4 收敛）；
//   - port.orphan         → 26（anirss 全部 25 个版本 + gecoos/v2.2）；
//   - tag.dir             → 严格主服务口径 3 实例（linkwarden 3 目录，目录名跟错了 sidecar）；
//   - port.conflict       → 0（aria2 的 tcp/udp 双映射必须按协议区分，否则误报，见测试）；
//   - volume.path         → 8（traefik 2 个版本的个人绝对路径，属豁免候选）；
//   - form.type-default   → 0（现状干净，规则仍保留守住回归）；
//   - runtime.high-privilege → 35（P2，提示补豁免登记）；
//   - runtime.identity-mixed → 3（losslesscut×2 + grimmory，文档明确「有意双通道」，只提示不拦截）；
//   - readme.vars         → 9（PANEL_ 前缀是 1Panel 注入位，不算漂移）；
//   - meta.name-drift     → 135（版本级 additionalProperties.name 与根目录不一致）；
//   - meta.i18n-coverage  → 根级 description/en 缺失按 P2 提示（阶段 4 决定豁免或补齐）。

import { parseImage } from './registry.mjs';

// ─── 1Panel 内置/系统注入变量（T1 白名单，compose 引用免声明）──────────────
// 与 AGENTS.md §6 的 6 变量清单一致；lint-exemptions.yml 之外只允许这一处硬白名单。
export const BUILTIN_VARS = Object.freeze([
  'CONTAINER_NAME',
  'HOST_IP',
  'HOST_ADDRESS',
  'PANEL_DB_PORT',
  'CPUS',
  'MEMORY_LIMIT',
]);
const BUILTIN_VAR_SET = new Set(BUILTIN_VARS);

// 已知规则全表（ruleId → 元数据；豁免文件的 ruleId 合法性以此为准）
export const RULES = Object.freeze({
  'var.undeclared':         { severity: 'P0', ssot: '版本级 data.yml.formFields', desc: 'compose 引用的 ${VAR} 必须在 formFields 声明（6 内置变量除外）' },
  'dir.latest':             { severity: 'P1', ssot: '版本目录名', desc: '版本目录禁止 latest（除非豁免登记根因）' },
  'port.orphan':            { severity: 'P1', ssot: 'compose.ports', desc: 'PANEL_APP_PORT_* 已声明但 compose 无任何 ports 映射' },
  'tag.dir':                { severity: 'P1', ssot: 'docker-compose.yml image', desc: '主服务镜像 tag（归一化后）必须与版本目录名一致' },
  'port.conflict':          { severity: 'P1', ssot: 'compose.ports', desc: '同文件内 host 端口重复绑定（同协议）' },
  'volume.path':            { severity: 'P1', ssot: 'compose.volumes', desc: '禁止危险宿主机路径挂载' },
  'form.type-default':      { severity: 'P1', ssot: '版本级 data.yml.formFields', desc: 'default 值类型/格式须与字段 type 匹配' },
  'form.orphan':            { severity: 'P2', ssot: '版本级 data.yml.formFields', desc: '声明了的 formField 未被 compose 引用（冗余或漏绑定）' },
  'runtime.high-privilege': { severity: 'P2', ssot: 'docker-compose.yml', desc: 'privileged/cap_add/devices/GPU 等高权限配置须豁免登记原因' },
  'runtime.identity-mixed': { severity: 'P2', ssot: 'docker-compose.yml', desc: '同服务混用 user: 与身份环境变量（确认是否有意双通道）' },
  'readme.vars':            { severity: 'P2', ssot: 'README.md', desc: 'README 中 ${VAR} 应指向真实存在的变量（PANEL_ 注入位除外）' },
  'meta.name-drift':        { severity: 'P2', ssot: '根目录 data.yml', desc: '版本级 additionalProperties.name 应与根目录一致' },
  'meta.i18n-coverage':     { severity: 'P2', ssot: '根目录 data.yml', desc: '根级 description 若存在须含 en 与 zh' },
});
export const RULE_IDS = Object.freeze(new Set(Object.keys(RULES)));

// ─── 结构化 finding ────────────────────────────────────────────────────────
// { severity, ruleId, app, version, file, line?, message, actual?, expected? }
function finding(severity, ruleId, ctx, extra = {}) {
  const file = extra.file ?? ctx.composePath ?? ctx.dataPath ?? ctx.readmePath ?? `${ctx.app}`;
  return {
    severity: severity ?? RULES[ruleId].severity,
    ruleId,
    app: ctx.app,
    version: ctx.version ?? null,
    file,
    line: extra.line ?? null,
    message: extra.message ?? RULES[ruleId].desc,
    actual: extra.actual ?? null,
    expected: extra.expected ?? null,
  };
}

// ─── 注释感知工具 ──────────────────────────────────────────────────────────
// 逐行剥离 `#` 及其后的全部内容（含词首出现的注释），但保留原行号。
// 同时按 compose 拦截规则保留整体行文本（供 ${VAR}、ports 等正则扫描）。
// 审计证明：不剥注释会把文档说明里的 ${VAR} 样例当成真实引用（612→601 起的量级差）。
export function stripCommentedLines(text) {
  return text.split('\n').map((rawLine, i) => {
    const idx = rawLine.search(/(^|\s)#/);
    const clean = idx === -1 ? rawLine : rawLine.slice(0, idx);
    return { n: i + 1, text: clean };
  });
}

// 民间合规的 ${VAR} / ${VAR:-default} / ${VAR?msg} 提取（剥注释后的行）
// 与 validate-update-batch.mjs 的 RuntimeObjectRef 同形，但不做一次性内联，便于复用。
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}/g;

export function collectVarRefs(text) {
  const out = [];
  for (const { n, text: line } of stripCommentedLines(text)) {
    for (const m of line.matchAll(VAR_REF_RE)) {
      out.push({ name: m[1], line: n });
    }
  }
  return out;
}

// ─── 主服务识别与镜像归一化 ────────────────────────────────────────────────
// 归一化目标：让 `${repo}:{tag}` 与「版本目录名」在同样归一化下可直接判定。
// 两侧归一化函数**必须一致**（同一函数对 dir 与 tag 各跑一次）。
const TAG_STRIP_TAIL_RE = /-(ls\d+|arm32v\d|arm64v\d|amd64|aarch64|alpine|slim|fon|nvidia|cuda[\d.a-z]*|cu\d+|vulkan|apache|py\d\.\d+)$/i;

function normalizeVersionToken(str) {
  let s = String(str);
  // 功能前缀（anythingllm 的 pg-1.16.0 是 postgres 打包变体，主线版本就是 1.16.0）
  s = s.replace(/^(pg-|server-)/i, '');
  // 版本前缀 v（后随数字才剥离，避免把 v-name 撞成空）
  s = s.replace(/^v(?=[0-9])/, '');
  // 变体尾巴：-ls36 / -arm32v7 / -alpine / -cu124 / -vulkan / -fon …
  s = s.replace(TAG_STRIP_TAIL_RE, '');
  // 变体尾巴可能连缀（如 26.08.2-1-fon → 剥 -fon 后仍是 26.08.2-1，不再继续剥）
  s = s.replace(/-arm\d*v\d+|-(arm64|amd64|aarch64)$/i, '');
  // 日期型（silo/co WJ 格式）：RELEASE.2026-08-01 → 2026-08-01；把分隔符统一为 '.' 会破坏 match，不再做
  s = s.replace(/^RELEASE\./, '');
  return s.toLowerCase();
}

// 版本目录是否可参与 tag.dir 校验的准入门槛：
//   semver / 纯数字日期段 / RELEASE. /  前缀或后缀变体（剥离后有映射）才 eligible；
//   'beta' / 'stable-*' / 'a2b-*' / 'gpu-nvidia-latest' 等非版本目录跳过（误报防线）。
function isSemverLikeDir(dirName) {
  const n = normalizeVersionToken(dirName);
  return /^(?:\d+(?:[.-]\d+){0,3}|\d{4,13})$/.test(n) || /^\d{4}[.-]\d{1,2}(-\d{1,2})?/.test(n);
}

// ─── 每版本规则 ────────────────────────────────────────────────────────────

// R2 var.undeclared（P0）
export function checkVarDeclarations(ctx) {
  const out = [];
  if (!ctx.composeRaw) return out;
  const declared = new Set(
    (ctx.versionDoc?.additionalProperties?.formFields ?? ctx.versionDoc?.formFields ?? [])
      .filter((f) => f?.envKey).map((f) => f.envKey)
  );
  const seen = new Map();
  for (const { name, line } of collectVarRefs(ctx.composeRaw)) {
    if (BUILTIN_VAR_SET.has(name) || declared.has(name)) continue;
    const key = `${ctx.app}/${ctx.version}:${name}`;
    if (seen.has(key)) { seen.get(key).lines.push(line); continue; }
    seen.set(key, { name, line, lines: [line] });
  }
  for (const { name, line, lines } of seen.values()) {
    out.push(finding('P0', 'var.undeclared', ctx, {
      line,
      message: `compose 引用了未声明变量 ${name}${lines.length > 1 ? `（共 ${lines.length} 处：${lines.join(',')}）` : ''}`,
      actual: `\${${name}}`,
      expected: `版本级 data.yml.formFields 声明 envKey=${name}`,
    }));
  }
  return out;
}

// R5 tag.dir（P1）——主服务 = compose.services 里第一个有 image 的服务
export function checkTagDir(ctx) {
  const out = [];
  const doc = ctx.composeDoc;
  const services = doc?.services ?? {};
  const first = Object.values(services).find((s) => typeof s?.image === 'string');
  if (!first) return out;
  const image = first.image;
  if (image.includes('${')) return out; // 变量型镜像由 lib/image-policy.mjs 负责
  if (ctx.version === 'latest') return out; // dir.latest 单独行
  if (!/^[A-Za-z]/.test(ctx.version)) return out;
  if (!isSemverLikeDir(ctx.version)) return out;
  const parsed = parseImage(image);
  if (!parsed || typeof parsed.tag !== 'string' || !parsed.tag) return out;
  const dirNorm = normalizeVersionToken(ctx.version);
  const tagNorm = normalizeVersionToken(parsed.tag);
  if (dirNorm && tagNorm && dirNorm !== tagNorm) {
    out.push(finding('P1', 'tag.dir', ctx, {
      line: null,
      message: `主服务镜像 tag 与版本目录名不一致（归一化后）`,
      actual: `${image}`,
      expected: `目录 "${ctx.version}" ↔ tag "${ctx.version}"（归一化 "${dirNorm}"）`,
    }));
  }
  return out;
}

// R11 dir.latest（P1）——在 bin 层散列免（AGENTS §5 禁 latest）
export function checkDirLatest(ctx) {
  if (ctx.version !== 'latest') return [];
  return [finding('P1', 'dir.latest', ctx, {
    message: '版本目录名 latest 违反版本目录命名规则（目录名 = 版本参数）',
    actual: '目录名 "latest"',
    expected: '具体版本号目录（如上游无版本化 tag 须在豁免文件登记根因）',
  })];
}

// R3/R6 form.orphan（P2）与 port.orphan（P1）
export function checkFormOrphans(ctx) {
  const out = [];
  const doc = ctx.composeDoc;
  if (!doc) return out;
  const raw = ctx.composeRaw ?? '';
  const anyServiceHasPorts = Object.values(doc.services ?? {}).some((s) => Array.isArray(s?.ports) && s.ports.length > 0);
  const fields = ctx.versionDoc?.additionalProperties?.formFields ?? ctx.versionDoc?.formFields ?? [];
  for (const f of fields) {
    if (!f?.envKey) continue;
    // 端口变量（PANEL_APP_PORT_*）必须在 ports 映射里出现：即便它被当作普通 env
    // 值引用（如 gecoos 的 `- mp=${PANEL_APP_PORT_WEB}`），1Panel 也不会因此注入端口，
    // 属于最高优先级矛盾（P1），先于其余 skip 条件判断，避免被「有引用」当借口。
    if (/^PANEL_APP_PORT_/.test(f.envKey) && !anyServiceHasPorts) {
      out.push(finding('P1', 'port.orphan', ctx, {
        line: null,
        message: `声明了端口变量 ${f.envKey}，但 compose 内没有任何 ports 映射`,
        actual: `formFields 有 ${f.envKey}；compose 无 ports`,
        expected: 'compose.ports 映射使用该变量，或从 formFields 移除',
      }));
      continue;
    }
    if (collectVarRefs(raw).some((r) => r.name === f.envKey)) continue;
    // 完全裸词（非常量变量名出现在 YAML 键里，例如 environment 名单）; 只看剥注释后的原始文本包含
    if (stripCommentedLines(raw).some(({ text }) => text.includes(f.envKey))) continue;
    // 版本脚本（init.sh 等钩子）按词边界消费该变量 → 视为已使用（goal §5.3：compose/.env/脚本三通道）
    if (ctx.scriptsText && new RegExp(`\\b${String(f.envKey).replace(/[^A-Za-z0-9_]/g, '\\$&')}\\b`).test(ctx.scriptsText)) continue;
    out.push(finding('P2', 'form.orphan', ctx, {
      line: null,
      message: `formField ${f.envKey} 声明后未被 compose 使用`,
      actual: `envKey=${f.envKey} (type=${f.type ?? '?'})`,
      expected: 'compose/脚本/.env 实际引用，或删除该声明',
    }));
  }
  return out;
}

// R6 port.conflict（P1）——host 表达式（变量或数字）+容器端口+协议 三元组去重
export function checkPortConflicts(ctx) {
  const out = [];
  const doc = ctx.composeDoc;
  const services = doc?.services ?? {};
  const seen = new Map();
  for (const [name, svc] of Object.entries(services)) {
    for (const p of (svc?.ports ?? []).map(String)) {
      const m = p.match(/^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-?[^}]*)?\}|(\d+)):(\d+)(\/(tcp|udp))?$/);
      if (!m) continue;
      const host = m[1] ?? m[2];
      const cont = m[3];
      const proto = m[4] ?? '/tcp';
      const key = `${host}->${cont}${proto}`;
      if (seen.has(key)) {
        out.push(finding('P1', 'port.conflict', ctx, {
          line: null,
          message: `同一 host 端口绑定重复（同协议）`,
          actual: `services.${name}: ${p}（"${key}" 已在 services.${seen.get(key)} 占用）`,
          expected: '不同 host 端口（变量）或不同协议',
        }));
      } else seen.set(key, name);
    }
  }
  return out;
}

// R7 volume.path（P1）
const SAFE_HOST_RE = /^(\/(dev|proc|sys|var\/run|var\/lib\/docker|lib\/modules|opt\/1panel|usr\/share|run)|\/etc\/(?:localtime|timezone|resolv\.conf|hosts))/;
export function checkVolumes(ctx) {
  const out = [];
  const doc = ctx.composeDoc;
  for (const [name, svc] of Object.entries(doc?.services ?? {})) {
    for (const vol of (svc?.volumes ?? []).map(String)) {
      // 行内注释剥离（同一行规则再保险一遍，防止调用方漏剥）
      const [host] = stripCommentedLines(vol)[0].text.split(':');
      if (host.startsWith('.') || host.startsWith('~')) continue;
      if (!/^\/[a-zA-Z]/.test(host)) continue;
      if (SAFE_HOST_RE.test(host)) continue;
      out.push(finding('P1', 'volume.path', ctx, {
        line: null,
        message: `services.${name} 挂载了仓库控制之外的宿主机绝对路径`,
        actual: vol,
        expected: '相对路径 ./ 或具名容器卷，或加入豁免文件并注明原因',
      }));
    }
  }
  return out;
}

// R9 runtime.high-privilege（P2）
export function checkHighPrivilege(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(ctx.composeDoc?.services ?? {})) {
    const flags = [];
    if (svc?.privileged) flags.push('privileged: true');
    if (Array.isArray(svc?.cap_add) && svc.cap_add.length) flags.push(`cap_add(${svc.cap_add.length})`);
    if (Array.isArray(svc?.devices) && svc.devices.length) flags.push(`devices(${svc.devices.length})`);
    if (svc?.runtime) flags.push(`runtime: ${svc.runtime}`);
    const gpuCount = svc?.deploy?.resources?.reservations?.devices?.length;
    if (gpuCount) flags.push(`deploy.devices(${gpuCount})`);
    if (svc?.gpus) flags.push('gpus');
    if (svc?.network_mode && svc.network_mode !== 'bridge') flags.push(`network_mode: ${svc.network_mode}`);
    if (!flags.length) continue;
    out.push(finding('P2', 'runtime.high-privilege', ctx, {
      line: null,
      message: `services.${name} 含高权限配置（${flags.join(', ')}），需在 .github/lint-exemptions.yml 登记 reason 或补数据卷降权方案`,
      actual: flags.join(', '),
      expected: '最小的 capability/设备集，或显式豁免登记',
    }));
  }
  return out;
}

// R8 runtime.identity-mixed（P2）
const IDENTITY_ENV_RE = /^(PUID|PGID|UID|GID|USER_ID|GROUP_ID|APP_USER_ID|APP_GROUP_ID)$/i;
export function checkIdentity(ctx) {
  const out = [];
  for (const [name, svc] of Object.entries(ctx.composeDoc?.services ?? {})) {
    const envKeys = Array.isArray(svc?.environment)
      ? svc.environment.map((e) => String(e).split('=')[0])
      : Object.keys(svc?.environment ?? {});
    const hasUserDeclared = typeof svc?.user === 'string' && svc.user.length > 0;
    // 只数明写的身份 env；`user: ${UID}:${GID}` 单通道是合法写法，不构成「混用」
    const hasIdentityEnv = envKeys.some((k) => IDENTITY_ENV_RE.test(k));
    if (!hasUserDeclared || !hasIdentityEnv) continue;
    const envNames = envKeys.filter((k) => IDENTITY_ENV_RE.test(k));
    out.push(finding('P2', 'runtime.identity-mixed', ctx, {
      line: null,
      message: `services.${name} 同时使用 user: 与身份环境变量（${envNames.join(',') || 'user 内变量'}）`,
      actual: `user: ${svc.user}` + (envNames.length ? ` + env ${envNames.join(',')}` : ''),
      expected: '确认是否有意双通道（如 jlesage 基座应用），为 compose-conventions.md 提供证据或将 user: 收敛掉',
    }));
  }
  return out;
}

// R10 readme.vars（P2）——应用级，README 中 ${VAR} 需可溯源
export function checkReadmeVars(ctx) {
  if (!ctx.readmeRaw) return [];
  const out = [];
  const declared = new Set();
  for (const vd of ctx.versionDocs ?? []) {
    const ap = vd?.additionalProperties ?? vd ?? {};
    for (const f of (ap.formFields ?? [])) if (f?.envKey) declared.add(f.envKey);
  }
  const seen = new Map();
  for (const { n, text } of stripCommentedLines(ctx.readmeRaw)) {
    for (const m of text.matchAll(VAR_REF_RE)) {
      const name = m[1];
      if (BUILTIN_VAR_SET.has(name) || name.startsWith('PANEL_')) continue; // PANEL_* 是 1Panel 注入位
      if (declared.has(name)) continue;
      if (!seen.has(name)) seen.set(name, n);
    }
  }
  for (const [name, line] of seen) {
    out.push(finding('P2', 'readme.vars', { ...ctx, readmePath: ctx.readmePath }, {
      line,
      message: `README 引用了仓库内不存在的变量 ${name}`,
      actual: `\${${name}}`,
      expected: '删除该说明或改为实际变量名',
    }));
  }
  return out;
}

// R1b meta.name-drift（P2）
export function checkVersionName(ctx) {
  const rootName = ctx.rootDoc?.additionalProperties?.name;
  const vName = ctx.versionDoc?.additionalProperties?.name;
  if (typeof rootName !== 'string' || typeof vName !== 'string') return [];
  if (vName === rootName) return [];
  return [finding('P2', 'meta.name-drift', ctx, {
    line: null,
    message: `版本级 additionalProperties.name 与根目录不一致`,
    actual: vName,
    expected: rootName,
  })];
}

// R4 form.type-default（P1）
export function checkFormTypeDefaults(ctx) {
  const out = [];
  const fields = ctx.versionDoc?.additionalProperties?.formFields ?? ctx.versionDoc?.formFields ?? [];
  for (const f of fields) {
    if (!f?.envKey) continue;
    if (f.type === 'number') {
      const d = f.default;
      if (d !== undefined && String(d).trim() !== '' && !/^-?\d+(\.\d+)?$/.test(String(d).trim())) {
        out.push(finding('P1', 'form.type-default', ctx, {
          line: null,
          message: `formField ${f.envKey} type=number 但 default 不为数字`,
          actual: JSON.stringify(d),
          expected: '数字（或空串/未填）',
        }));
      }
    }
    if (f.type === 'select' && Array.isArray(f.values) && f.values.length) {
      const vals = f.values.map((x) => String(x.value));
      if (f.default !== undefined && !vals.includes(String(f.default))) {
        out.push(finding('P1', 'form.type-default', ctx, {
          line: null,
          message: `formField ${f.envKey} type=select 的 default 不在 values 中`,
          actual: JSON.stringify(f.default),
          expected: `values 之一：${vals.join('|')}`,
        }));
      }
    }
  }
  return out;
}

// ─── 每版本聚合 ────────────────────────────────────────────────────────────
export function runVersionChecks(ctx) {
  return [
    ...checkVarDeclarations(ctx),
    ...checkDirLatest(ctx),
    ...checkTagDir(ctx),
    ...checkFormOrphans(ctx),
    ...checkPortConflicts(ctx),
    ...checkVolumes(ctx),
    ...checkHighPrivilege(ctx),
    ...checkIdentity(ctx),
    ...checkFormTypeDefaults(ctx),
    ...checkVersionName(ctx),
  ];
}

// ─── 应用级聚合 ────────────────────────────────────────────────────────────
export function runAppChecks(ctx) {
  return [...runVersionChecks(ctx), ...checkReadmeVars(ctx)];
}
