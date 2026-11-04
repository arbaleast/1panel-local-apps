#!/usr/bin/env node
// detect-updates.mjs — 检测 hardcode 类应用的镜像更新，修改文件并输出 updates.json
// 仅处理 compose 中 image 含硬编码 tag 的应用，变量型（${IMAGE} 等）用 lib/compose.mjs 解析
// 适配 AGENTS.md "禁止 latest 作目录名" 规则：每应用可有多个具体版本目录；检测到新 tag 后
// 保留旧版本目录并 cpSync 新版本目录，1Panel UI 版本下拉展示所有历史版本，支持回滚。
//
// ── 每应用结果模型（audit task 2）────────────────────────────────────────
// 每个被扫描的应用产出且仅产出一条 result 记录：
//   { app, status, stage, reason, code, error, updates }
//   - status ∈ 'success' | 'skipped' | 'failed'
//       success = 检测流程完整跑完（**包含"已是最新"**，那是一次成功的检测）
//       skipped = 有意不处理（白名单 / 无版本目录 / 全部变量型 / 全部 latest /
//                 digest 镜像 / 不支持的 registry …）——跳过**不是**失败
//       failed  = 检测无法完成（YAML/compose 解析失败、镜像串无法解析、
//                 Registry 请求失败、版本无法识别、写盘失败 …）
//   - stage  ∈ 'whitelist' | 'scan' | 'compose' | 'data-yml' | 'image-parse' |
//             'registry' | 'version' | 'write'
//   - reason = 简短人读说明（中文），code = 机器可读原因码
//   - error  = success/skipped 时为 null；failed 时为描述性字符串（含底层错误信息）
//   - updates= 该应用产出的更新条目数（skipped/failed 恒为 0）
//
// 关键不变量：**Registry 网络错误 / 解析异常绝不能被当成"无更新"**，必须记为 failed。
//
// ── 退出码契约 ───────────────────────────────────────────────────────────
//   0 = 扫描完成且没有任何应用失败（含"完全没有更新"的情况）
//   2 = 至少有一个应用 failed
//   无论成败，脚本都会跑完整个扫描并写出 updates.json + 汇总报告。
//
// ── 镜像解析集中化（audit task 5）────────────────────────────────────────
// 硬编码镜像一律走 lib/registry.mjs 的 parseImage()，不再用 image.split(':')：
// 带端口的 registry（localhost:5000/app:1.0）、digest 镜像（nginx@sha256:…）都能正确解析。
// compose 文本改写使用**原始镜像字符串**逐字替换，避免重建 repo:tag 后匹配不上。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
// 共享模块：semver 比较、镜像 registry 适配器、应用目录扫描、compose 模板解析
import * as semverLib from '../lib/semver.mjs';
import { createAdapter, parseImage, RegistryRequestError } from '../lib/registry.mjs';
import { listApps } from '../lib/apps.mjs';
import { resolveImageTemplate, rebuildImageDefault } from '../lib/compose.mjs';
// 汇总与渲染的唯一实现（lib/report.mjs）——本脚本不再 inline 重复实现计数/渲染
import {
  aggregateResults,
  renderSummary,
  renderMarkdown,
  exitCodeForResults,
} from '../lib/report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// 应用目录直接在仓库根，不在 apps/ 子目录下
const APPS_DIR = REPO_ROOT;

const APPS_FILTER = []; // 由 parseCliArgs 调用前填充（env + 位置参数），main 入口消费
function initAppsFilter() {
  if (APPS_FILTER.length > 0) return; // 幂等
  const fromEnv = (process.env.APPS_FILTER || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  APPS_FILTER.push(...fromEnv);
}

// 进程级运行选项（由 parseCliArgs 填充，main 入口消费）
// DRY_RUN:  true 时只输出 diff，不写盘、不创建新版本目录、不写 updates.json
//          （dry-run 模式，commit 前自查用；fix(anirss PR #14) 与 bookorbit 倒退回退
//           3.2.0 复盘教训：任何本地试运行都应该是只读）
// HELP:     true 时打印 usage 并退出 0
// VERBOSE:  true 时输出每个 formField 字段对比（dry-run 默认 false，正式模式有效）
const processOptions = { DRY_RUN: false, HELP: false, VERBOSE: false };

// ---------- 枚举：stage / reason ----------

/** 检测阶段（每条 result 的 stage 取值集合） */
export const STAGES = Object.freeze([
  'whitelist',
  'scan',
  'compose',
  'data-yml',
  'image-parse',
  'registry',
  'version',
  'write',
]);

/** 检测结论（reason 的机器可读码） */
export const REASONS = Object.freeze([
  'whitelisted',
  'no-version-dirs',
  'no-services',
  'data-yml-missing',
  'compose-missing',
  'data-yml-invalid',
  'compose-invalid',
  'image-unresolved',
  'image-template-unresolved',
  'digest-image',
  'no-tag',
  'tag-latest',
  'tag-unstable',
  'unsupported-registry',
  'no-stable-tag',
  'version-unrecognized',
  'registry-request-failed',
  'write-failed',
  'unexpected-error',
  'no-update',
  'update-found',
]);

/**
 * reason 码 → 人读说明（中文）
 * @type {Record<string, string>}
 */
const REASON_TEXT = Object.freeze({
  whitelisted: '已在白名单，手维护',
  'no-version-dirs': '无版本目录',
  'no-services': 'compose 无 services',
  'data-yml-missing': 'data.yml 不存在',
  'compose-missing': 'docker-compose.yml 不存在',
  'data-yml-invalid': 'data.yml 解析失败',
  'compose-invalid': 'compose 解析失败',
  'image-unresolved': '镜像字符串无法解析',
  'image-template-unresolved': '镜像模板无法解析',
  'digest-image': '镜像无 tag（digest 镜像不参与版本更新）',
  'no-tag': '镜像无 tag（digest 镜像不参与版本更新）',
  'tag-latest': '镜像 tag 为 latest，按仓库规则跳过',
  'tag-unstable': '镜像 tag 不稳定，跳过',
  'unsupported-registry': '不支持的 registry（{registry}），不做版本检测',
  'no-stable-tag': 'Registry 未返回可用的稳定 tag',
  'version-unrecognized': '版本目录形态无法识别',
  'registry-request-failed': 'Registry 请求失败',
  'write-failed': '写盘失败',
  'unexpected-error': '未预期异常',
  'no-update': '已是最新',
  'update-found': '检测到新版本 {to}',
});

/**
 * 把 reason 码渲染成人读说明
 * @param {string} code
 * @param {{registry?: string, to?: string}} [ctx]
 * @returns {string}
 */
export function formatReason(code, ctx = {}) {
  let text = REASON_TEXT[code] || code;
  if (ctx.registry) text = text.replace('{registry}', ctx.registry);
  if (ctx.to) text = text.replace('{to}', ctx.to);
  return text;
}

/** 跳过的 reason 优先级（数字越小越优先，用于 app 级别汇总时选代表 reason） */
const SKIP_REASON_PRIORITY = [
  'unexpected-error',
  'registry-request-failed',
  'data-yml-invalid',
  'compose-invalid',
  'write-failed',
  'version-unrecognized',
  'image-unresolved',
  'image-template-unresolved',
  'digest-image',
  'no-tag',
  'tag-latest',
  'tag-unstable',
  'unsupported-registry',
  'no-stable-tag',
  'data-yml-missing',
  'compose-missing',
  'no-services',
  'no-version-dirs',
  'whitelisted',
];

/** 不稳定 tag 黑名单（与 semver.isStable 语义对齐） */
const UNSTABLE_TAG_RE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i;

/**
 * 打印 usage（--help / -h）到 stdout
 */
function printHelp() {
  console.log(`detect-updates.mjs — 检测 hardcode 类应用镜像更新

用法:
  node .github/scripts/detect-updates.mjs [选项] [APPS_FILTER ...]

选项:
  --dry-run, -n       只检测与输出 diff，不写盘、不创建新版本目录、不写 updates.json
                       （CRITICAL: 任何本地试运行都应加此标志，否则会真实修改仓库
                        —— 审查 2026-10-14 复盘：bookorbit 3.4.0 被倒退回 3.2.0）
  --verbose, -v       输出每个 formField 字段对比（默认仅在 dry-run 下隐式启用）
  --help, -h          显示本帮助并退出

环境变量:
  APPS_FILTER         逗号分隔的应用短名 / 目录名列表（与命令行参数等价）
  DETECT_DRY_RUN=1    等价于 --dry-run（与 flag 互斥时以 flag 为准）

退出码:
  0  扫描完成且没有任何应用失败（含"完全没有更新"的情况）
  2  至少有一个应用 failed（Registry 请求失败 / 配置解析失败 / 写盘失败 / 未预期异常）
     —— 此时仍会跑完整个扫描并写出 updates.json 与汇总报告

输出:
  stdout 打印每应用结果表（app / status / stage / reason）与汇总行
  仓库根 updates.json（gitignored）含 updates / scanned / timestamp / results / summary

与 PR/push 流程配合:
  本脚本只检测 + 写盘。'开 PR + 合并' 由 .github/bin/open-update-pr.mjs 在 CI 步骤调用。
  本地试运行请用 --dry-run 避免污染工作树；CI 走的是正式模式（无 --dry-run）。
`);
}

/**
 * 解析命令行参数 + 环境变量，写入 processOptions
 * 重复 flag 取最后一次；未知 flag 抛错（不静默）
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{positional: string[]}}
 */
export function parseCliArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') {
      processOptions.DRY_RUN = true;
    } else if (a === '--verbose' || a === '-v') {
      processOptions.VERBOSE = true;
    } else if (a === '--help' || a === '-h') {
      processOptions.HELP = true;
    } else if (a.startsWith('--')) {
      throw new Error(`未知参数: ${a}（查看用法：node detect-updates.mjs --help）`);
    } else {
      positional.push(a);
    }
  }
  if (process.env.DETECT_DRY_RUN === '1' && !processOptions.DRY_RUN) {
    processOptions.DRY_RUN = true;
  }
  // dry-run 默认隐式 verbose（让用户看清每个 formField 改动）
  if (processOptions.DRY_RUN) processOptions.VERBOSE = true;
  return { positional };
}

// 应用级白名单：detect 跳过这些应用, 保留手维护状态。
// 原因:
//   - anythingllm: IMAGE 镜像 tag 使用变体前缀 (pg-1.16.0), 1Panel UI 版本参数已锁定到 1.16.0。
//     DockerHubAdapter 变体匹配会返回 pg-X.Y.Z, 复制出的新目录会与现有 1.16.0 风格不一致。
//     需手维护, 避免 detect 在 anythingllm/ 下新增 pg-1.17.0/ 等带变体前缀的目录。
//   - jellyfin: 4 个版本目录混用两种 tag 形态（纯 semver `10.11.11` + 日期型 `2026091410-arm64`），
//     且每个目录都有手维护内容（name / CACHE_FOLDER_PATH / UID / GID 等安装参数）。
//     日期型 tag 不被 DockerHubAdapter 变体正则识别（`^([a-zA-Z][a-zA-Z0-9]*)(?:-|$)/` 要求字母开头），
//     会 fallback 到 pure-semver 选取 → 命中 `10.11.11` → detect 认为"最新版本是 10.11.11"，
//     随即 cpSync `2026091410-arm64/` → `10.11.11/`，把 10.11.11 目录的手维护内容整体覆盖掉
//     （2026-09-25 auto-update 已实际发生：name 与 CACHE_FOLDER_PATH 被兄弟目录覆盖回旧值）。
//     jellyfin 镜像由用户在 1Panel UI 的 IMAGE 参数里手改（可换 nyanmisaka/jellyfin），
//     故整体跳过 detect，手维护。
// 任何新加进白名单的应用都需在 AGENTS.md / README.md 中说明 '手维护, 不走 auto-update'。
const SKIP_AUTO_UPDATE_APPS = new Set(['anythingllm', 'jellyfin']);

// 简易日志
const log = (...a) => console.log('[detect]', ...a);

// ---------- 工具：白名单判断（导出供单测） ----------
/**
 * 判断应用是否在白名单中（detect 跳过）
 * @param {string} appDir - 应用目录名（如 anythingllm, jupyter, ai00）
 * @returns {boolean}
 */
export function shouldSkipAutoUpdate(appDir) {
  return SKIP_AUTO_UPDATE_APPS.has(appDir);
}

/**
 * 判断是否允许把 fromDir 目录复制到 toDir（新建版本目录前的安全闸）
 *
 * 背景（2026-09-25 jellyfin 事故）：detect 把"最新 tag"当成目标目录名直接 cpSync，
 * 当目标目录已存在且与来源目录不同时，这是一次**跨目录覆盖**——目标目录里的
 * 手维护内容（name / CACHE_FOLDER_PATH / 自定义 formFields）会被来源目录整体顶掉。
 * 根因是日期型 tag（如 2026091410-arm64）不被变体正则识别，fallback 到 pure-semver
 * 选取后命中了另一个已存在的版本目录名。
 *
 * 规则：
 *   - 目标目录不存在 → 允许（正常新建版本目录）
 *   - 来源目录 == 目标目录 → 允许（幂等刷新同一目录）
 *   - 目标目录已存在且与来源不同 → 拒绝（宁可漏一次更新，也不摧毁目标目录）
 *
 * @param {string} fromDir - 来源版本目录名
 * @param {string} toDir - 目标版本目录名
 * @param {boolean} targetExists - 目标目录是否已存在
 * @returns {boolean}
 */
export function canCopyVersionDir(fromDir, toDir, targetExists) {
  if (!targetExists) return true;
  return fromDir === toDir;
}

// ---------- 工具：版本比较（semver.mjs 新旧 API 兼容层） ----------

/**
 * 把版本串拆成数字段（宽松语义：取所有数字片段）。
 * 例：'v3.2.18-arm32v7' → [3,2,18,32,7]；'2026091410-arm64' → [2026091410]
 * @param {string} v
 * @returns {number[]}
 */
export function looseVersionChunks(v) {
  const m = String(v ?? '').match(/\d+/g);
  return m ? m.map(Number) : [];
}

/**
 * 宽松版本比较（detect 内 min/max 启发式排序用）。
 * 优先使用 semver.mjs 新契约的 compareVersionsLoose；若该导出尚未就绪（旧 semver.mjs），
 * 用本文件内的等价实现兜底——**不 import 旧 semver 的 parse/compare**（它们会被删除）。
 * @param {string} a
 * @param {string} b
 * @returns {number} 负数 a<b，正数 a>b，0 相等
 */
export function compareVersionsLoose(a, b) {
  if (typeof semverLib.compareVersionsLoose === 'function') {
    return semverLib.compareVersionsLoose(a, b);
  }
  const ca = looseVersionChunks(a);
  const cb = looseVersionChunks(b);
  const len = Math.max(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const va = ca[i] ?? 0;
    const vb = cb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * 选出"最新的已知版本目录"。新契约提供 pickNewestVersionDir 时直接用；
 * 返回 null 表示"无法可靠识别"→ detect 回退到全量 detect 旧行为。
 * @param {string[]} dirs
 * @returns {string|null}
 */
function selectNewestVersionDir(dirs) {
  if (typeof semverLib.pickNewestVersionDir === 'function') {
    return semverLib.pickNewestVersionDir(dirs) ?? null;
  }
  // 旧 semver.mjs（无新 API）时的本地等价实现
  let best = null;
  for (const d of dirs) {
    if (!best || compareVersionsLoose(d, best) > 0) best = d;
  }
  return best;
}

// ---------- 工具：镜像分类（导出供单测） ----------

/**
 * 对一个 compose 里的 image 字符串做分类判定（集中化解析入口，audit task 5）。
 *
 * kind 取值：
 *   - 'variable'  变量型镜像（`${IMAGE}` / `${APP_VERSION}` 等模板）
 *   - 'invalid'   镜像字符串非法（parseImage 返回 null）——调用方必须记为 **failed**
 *   - 'digest'    只有 digest 没有 tag（`nginx@sha256:…`）→ skipped
 *   - 'no-tag'    既无 tag 也无 digest（`nginx`）→ skipped
 *   - 'hardcoded' 带 tag 的硬编码镜像 → 参与版本检测
 *
 * @param {string} image
 * @returns {{kind: 'variable'|'hardcoded'|'digest'|'no-tag'|'invalid', repo?: string, tag?: string, registry?: string, imageRef?: string, reason: string, code: string}}
 */
export function classifyServiceImage(image) {
  const raw = typeof image === 'string' ? image : String(image ?? '');
  if (raw.includes('$')) {
    return {
      kind: 'variable',
      reason: '变量型镜像模板，由 lib/compose.mjs 解析',
      code: 'image-template-unresolved',
    };
  }
  if (!raw.trim()) {
    return {
      kind: 'invalid',
      reason: formatReason('image-unresolved'),
      code: 'image-unresolved',
    };
  }
  const parsed = parseImage(raw);
  if (!parsed) {
    return {
      kind: 'invalid',
      reason: formatReason('image-unresolved'),
      code: 'image-unresolved',
    };
  }
  const imageRef = parsed.registry === 'dockerhub'
    ? parsed.repo
    : `${parsed.registry}/${parsed.repo}`;
  const base = {
    registry: parsed.registry,
    repo: parsed.repo,
    imageRef,
  };
  if (!parsed.tag) {
    const code = parsed.digest ? 'digest-image' : 'no-tag';
    return {
      kind: parsed.digest ? 'digest' : 'no-tag',
      reason: formatReason(code),
      code,
      ...base,
    };
  }
  return {
    kind: 'hardcoded',
    reason: `硬编码镜像 ${raw}`,
    code: 'no-update',
    tag: parsed.tag,
    ...base,
  };
}

/**
 * 兼容旧 API 的镜像分类（保留原有 status/reason 语义，供既有测试断言）
 * @param {string} image
 * @returns {object}
 */
export function classifyImage(image) {
  const raw = typeof image === 'string' ? image : String(image ?? '');
  if (!raw || raw.includes('$')) {
    return { status: 'skipped', reason: 'image-unresolved' };
  }
  const cls = classifyServiceImage(raw);
  if (cls.kind === 'invalid') {
    return { status: 'skipped', reason: 'image-unresolved' };
  }
  if (cls.kind === 'digest') {
    return { status: 'skipped', reason: 'digest-image', registry: cls.registry, repo: cls.repo, imageRef: cls.imageRef, digest: true };
  }
  if (cls.kind === 'no-tag') {
    return { status: 'skipped', reason: 'no-tag', registry: cls.registry, repo: cls.repo, imageRef: cls.imageRef };
  }
  const base = { registry: cls.registry, repo: cls.repo, imageRef: cls.imageRef, tag: cls.tag };
  if (cls.tag.toLowerCase() === 'latest') {
    return { status: 'skipped', reason: 'tag-latest', ...base };
  }
  if (UNSTABLE_TAG_RE.test(cls.tag)) {
    return { status: 'skipped', reason: 'tag-unstable', ...base };
  }
  if (cls.registry !== 'dockerhub' && cls.registry !== 'ghcr.io') {
    return { status: 'skipped', reason: 'unsupported-registry', ...base };
  }
  return { status: 'ok', ...base };
}

// ---------- 工具：解析 compose 与 data.yml ----------

/**
 * 解析 compose 内容，提取 services 列表（含 image 字段）
 * @param {string} content - compose 文件内容
 * @returns {Array<{name: string, image: string}>}
 */
export function parseCompose(content) {
  const doc = yaml.load(content);
  const services = doc?.services || {};
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    if (svc?.image) {
      out.push({ name, image: svc.image });
    }
  }
  return out;
}

/**
 * 解析 data.yml 内容
 * @param {string} content
 * @returns {object}
 */
export function parseDataYml(content) {
  return yaml.load(content) || {};
}

/**
 * 序列化对象为 YAML（保留块风格）
 * @param {object} obj
 * @returns {string}
 */
function serializeYaml(obj) {
  return yaml.dump(obj, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

/**
 * 找到 data.yml formFields 中匹配 image repo 的字段
 * 业务逻辑：用于变量型应用注入新 tag（detect 端行为优先，不强制使用 getAppMeta）
 * 统一用 parseImage 解析 default，不再用 split(':')（task-2 要求）。
 * @param {object} dataObj - data.yml 解析结果
 * @param {string} imageRepo - 镜像 repo（如 kragleer/anirss）
 * @returns {{index: number, field: object}|null}
 */
export function findFormFieldForImage(dataObj, imageRepo) {
  const fields = dataObj?.additionalProperties?.formFields || [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const def = String(f.default ?? '');
    if (!def) continue;
    const parsed = parseImage(def);
    if (!parsed) continue;
    if (parsed.repo === imageRepo) {
      return { index: i, field: f };
    }
    // 也匹配 envKey 暗示镜像变量（default 可能是裸 tag，此时 repo 不匹配 → 跳过）
    const implied = ['IMAGE', 'APP_VERSION', 'IMAGE_TAG', imageRepo.split('/').pop().toUpperCase()];
    if (implied.includes(f.envKey) && parsed.repo === imageRepo) {
      return { index: i, field: f };
    }
  }
  return null;
}

// ---------- 汇总：纯函数（导出供单测） ----------

/**
 * 统计每应用结果 → 汇总数字
 *
 * 委托给 lib/report.mjs 的 aggregateResults（唯一计数实现）。
 * @param {Array<{status?: string, updates?: number}>} results
 * @returns {{total: number, success: number, skipped: number, failed: number, updates: number}}
 */
export function buildResultSummary(results) {
  const agg = aggregateResults(results);
  return {
    total: agg.total,
    success: agg.success,
    skipped: agg.skipped,
    failed: agg.failed,
    updates: agg.updates,
  };
}

/**
 * 渲染每应用结果表 + 汇总行（stdout / CI 日志）
 *
 * 委托给 lib/report.mjs 的 renderSummary（唯一 console 渲染实现）。
 * @param {Array<{app: string, status: string, stage: string, reason: string, error?: string|null, updates?: number}>} results
 * @returns {string}
 */
export function formatResultReport(results) {
  return renderSummary(results);
}

/**
 * 由结果集决定进程退出码
 *
 * 委托给 lib/report.mjs 的 exitCodeForResults（唯一退出码判定实现）。
 * 契约：存在 failed → 2；否则（含空结果、全部 skipped）→ 0
 * @param {Array<{status?: string}>} results
 * @returns {number} 0 | 2
 */
export function overallExitCode(results) {
  return exitCodeForResults(results);
}

/**
 * determineExitCode：overallExitCode 的兼容别名
 * @param {Array<{status?: string}>} results
 * @returns {number}
 */
export function determineExitCode(results) {
  return overallExitCode(results);
}

// ---------- 主流程 ----------

/**
 * 加载别名表，构建 dir -> 配置 映射
 * 别名表中 dir 可指向嵌套路径（如 ramuses/photopea），供嵌套应用识别
 * @returns {Map<string, object>} aliasByDir
 */
function loadAliases() {
  const aliasesPath = path.join(REPO_ROOT, '.github', 'app-aliases.yml');
  if (!fs.existsSync(aliasesPath)) return new Map();
  const aliasesData = yaml.load(fs.readFileSync(aliasesPath, 'utf8')) || {};
  const aliases = aliasesData.aliases || {};
  const aliasByDir = new Map();
  for (const [name, conf] of Object.entries(aliases)) {
    const dir = conf.dir || name;
    // 确保 dir 属性始终存在（lib/apps.mjs listApps 依赖此字段）
    aliasByDir.set(dir, { ...conf, dir, _shortName: name });
  }
  return aliasByDir;
}

/**
 * 使用 adapter 获取镜像最新稳定 tag
 * @param {string} image - 完整镜像字符串（含 registry 前缀）
 * @param {string} [currentTag] - 当前使用的 tag（用于变体匹配，如 pg -> pg-1.16.0）
 * @returns {Promise<string|null>}
 * @throws {RegistryRequestError} Registry 请求失败（网络 / HTTP / JSON / 翻页）
 */
async function getLatestTag(image, currentTag) {
  const adapter = createAdapter(image);
  if (!adapter) return null;
  return await adapter.getLatestTag(image, currentTag);
}

/**
 * 获取应用的所有版本目录（排除 data、scripts、latest、隐藏目录）
 * @param {string} root
 * @param {string} appDir
 * @returns {string[]} 版本目录名数组
 */
function getAllVersionDirs(root, appDir) {
  const fullPath = path.join(root, appDir);
  let subDirs;
  try {
    subDirs = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const candidates = [];
  for (const sub of subDirs) {
    if (!sub.isDirectory()) continue;
    // 过滤隐藏目录，避免被误识别为版本
    if (sub.name === 'data' || sub.name === 'scripts' || sub.name === 'latest') continue;
    if (sub.name.startsWith('.')) continue;

    const subPath = path.join(fullPath, sub.name);
    const hasDataYml = fs.existsSync(path.join(subPath, 'data.yml'));
    const hasCompose = fs.existsSync(path.join(subPath, 'docker-compose.yml'));
    if (hasDataYml || hasCompose) {
      candidates.push(sub.name);
    }
  }
  return candidates;
}

/**
 * 写盘函数（DRY_RUN 时只 log，不真写）
 * 统一处理两种写盘需求：单文件 + 新建目录
 * 注意：DRY_RUN 下不再 cpSync 新版本目录（避免 dry-run 误污染），只输出 diff
 *
 * @param {string} appName - 应用名（仅 log 用）
 * @param {{path: string, content: string}[]} changes - 待写盘的文件列表
 * @param {{appName: string, fromDir: string, toDir: string}} [versionCopy] - 跨版本 cpSync
 * @returns {boolean} true=已真写，false=dry-run 跳过
 */
function applyChanges(appName, changes, versionCopy) {
  if (processOptions.DRY_RUN) {
    if (changes.length > 0) {
      log(appName, `[DRY-RUN] 跳过 ${changes.length} 个文件写盘`);
    }
    if (versionCopy) {
      const overwriteNote = versionCopy.overwrite ? '（会覆盖现有目录）' : '';
      log(appName, `[DRY-RUN] 跳过 cpSync: ${versionCopy.fromDir}/ -> ${versionCopy.toDir}/${overwriteNote}`);
    }
    return false;
  }
  if (versionCopy) {
    const src = path.join(APPS_DIR, versionCopy.appName, versionCopy.fromDir);
    const dst = path.join(APPS_DIR, versionCopy.appName, versionCopy.toDir);
    if (fs.existsSync(dst)) {
      log(appName, `⚠ 目标目录 ${versionCopy.toDir}/ 已存在，将覆盖`);
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.cpSync(src, dst, { recursive: true });
    log(appName, `cpSync: ${versionCopy.fromDir}/ -> ${versionCopy.toDir}/`);
  }
  for (const change of changes) {
    const filePath = path.join(REPO_ROOT, change.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, change.content, 'utf8');
    log(appName, `写入 ${change.path}`);
  }
  return true;
}

/**
 * 处理单个应用。
 * @param {string} appName
 * @returns {Promise<{result: object, updates: object[]}>}
 */
async function processApp(appName) {
  const result = {
    app: appName,
    status: 'success',
    stage: 'scan',
    reason: formatReason('no-update'),
    code: 'no-update',
    error: null,
    updates: 0,
  };
  const skipReasons = [];
  const skipCtx = new Map(); // reason 码 → 补充上下文（如 registry 名）
  let queried = false; // 是否真的向 registry 查询过（决定"已是最新" vs "跳过"）
  const addSkip = (reason, stage, ctx = {}) => {
    skipReasons.push(reason);
    if (!skipCtx.has(reason)) skipCtx.set(reason, ctx);
    log(appName, `skip[${stage}]: ${formatReason(reason, ctx)}`);
  };
  const fail = (stage, reason, error, ctx = {}) => {
    result.status = 'failed';
    result.stage = stage;
    result.reason = formatReason(reason, ctx);
    result.code = reason;
    result.error = error instanceof Error ? error.message : String(error);
    result.updates = 0;
    if (processOptions.VERBOSE && error instanceof Error && error.stack) {
      log(appName, 'stack:', error.stack);
    }
  };

  const appDir = path.join(APPS_DIR, appName);

  try {
    // 白名单：手维护应用, 跳过整个 detect 流程, 保留现有版本目录与 compose 不变。
    if (shouldSkipAutoUpdate(appName)) {
      log(appName, '在白名单中, 跳过 detect (手维护应用)');
      result.status = 'skipped';
      result.stage = 'whitelist';
      result.reason = formatReason('whitelisted');
      result.code = 'whitelisted';
      return { result, updates: [] };
    }

    // 获取所有版本子目录
    const versionDirs = getAllVersionDirs(REPO_ROOT, appName);
    if (versionDirs.length === 0) {
      log(appName, '无版本目录或无 compose，跳过');
      result.status = 'skipped';
      result.stage = 'scan';
      result.reason = formatReason('no-version-dirs');
      result.code = 'no-version-dirs';
      return { result, updates: [] };
    }

    // ── 跨版本保护：找出"已知最高版本"作为防倒退基准 ──────────────────
    // 复盘（2026-10-14 审查）：bookorbit/3.4.0 与 3.2.0 同属变量型应用（共享 APP_VERSION envKey），
    // detect 把两个 versionDir 都用同一份"最新 tag"覆盖，3.4.0 反而被 3.2.0 倒退回更低 tag。
    // 解决：detect 只处理 maxKnown（最新已知 versionDir）这一个；其它 versionDir 是历史归档
    // 保留在仓库供 1Panel UI 旧版本回滚用，**不应该**被 detect 覆盖。这与"cpSync 新版本目录
    // 保留旧版"的设计哲学一致——只是把"不更新历史版本"提前到 detect 阶段。
    const recognizable = versionDirs.filter(d => looseVersionChunks(d).length > 0);
    if (recognizable.length === 0) {
      log(appName, '所有 versionDir 的版本形态都无法识别，跳过');
      result.status = 'skipped';
      result.stage = 'version';
      result.reason = formatReason('version-unrecognized');
      result.code = 'version-unrecognized';
      return { result, updates: [] };
    }
    const maxKnown = selectNewestVersionDir(recognizable);
    if (maxKnown) {
      log(appName, `跨版本保护: maxKnown=${maxKnown}（仅处理此 versionDir，历史归档保留）`);
    } else {
      // 无法可靠识别 → 回退到原行为：所有 versionDir 都处理（保兼容）
      log(appName, '跨版本保护: 无可解析的 semver versionDir，回退到全量 detect');
    }

    // 对每个版本目录分别处理
    const allUpdates = [];
    for (const versionDir of versionDirs) {
      // 跨版本保护：只处理 maxKnown versionDir，历史归档保留
      // 复盘（2026-10-14）：bookorbit/3.2.0 与 3.4.0 共用 APP_VERSION envKey，
      // detect 把 3.2.0/default 改写为 3.4.0 后 cpSync 覆盖了 3.4.0/default 刚改写的 3.4.0，
      // 互相"竞争"造成跨版本倒退。正确做法：每个 versionDir 单独维护，互不干扰。
      if (maxKnown && versionDir !== maxKnown) {
        log(appName, `跨版本保护: ${versionDir} 非 maxKnown=${maxKnown}，跳过（历史归档保留）`);
        continue;
      }
      const composePath = path.join(appDir, versionDir, 'docker-compose.yml');
      const dataPath = path.join(appDir, versionDir, 'data.yml');

      if (!fs.existsSync(dataPath)) {
        log(appName, `${versionDir}/data.yml 不存在，跳过`);
        addSkip('data-yml-missing', 'data-yml');
        continue;
      }
      if (!fs.existsSync(composePath)) {
        log(appName, `${versionDir}/docker-compose.yml 不存在，跳过`);
        addSkip('compose-missing', 'compose');
        continue;
      }

      const composeContent = fs.readFileSync(composePath, 'utf8');
      const dataContent = fs.readFileSync(dataPath, 'utf8');

      let services;
      try {
        services = parseCompose(composeContent);
      } catch (e) {
        fail('compose', 'compose-invalid', e);
        return { result, updates: [] };
      }
      if (services.length === 0) {
        log(appName, `${versionDir} compose 无 services，跳过`);
        addSkip('no-services', 'compose');
        continue;
      }

      let dataObj;
      try {
        dataObj = parseDataYml(dataContent);
      } catch (e) {
        fail('data-yml', 'data-yml-invalid', e);
        return { result, updates: [] };
      }

      // 分类：hardcode vs 变量型（集中化解析入口 classifyServiceImage）
      const hardcoded = [];
      const variable = [];
      for (const svc of services) {
        const cls = classifyServiceImage(svc.image);
        if (cls.kind === 'variable') {
          variable.push(svc);
          continue;
        }
        if (cls.kind === 'invalid') {
          // 镜像串非法 → **failed**（绝不能当成"无更新"）
          fail('image-parse', 'image-unresolved', new Error(`镜像字符串无法解析: ${svc.image}`));
          return { result, updates: [] };
        }
        if (cls.kind === 'digest' || cls.kind === 'no-tag') {
          // 无 tag（含 digest-only）→ skipped（不是失败，也不是更新）
          log(appName, svc.name, `⚠ ${cls.reason}（${svc.image}），跳过该 service`);
          addSkip(cls.code, 'image-parse');
          continue;
        }
        // kind === 'hardcoded'
        if (cls.tag.toLowerCase() === 'latest') {
          log(appName, svc.name, `⚠ tag=latest（${svc.image}），跳过该 service`);
          addSkip('tag-latest', 'image-parse');
          continue;
        }
        if (UNSTABLE_TAG_RE.test(cls.tag)) {
          log(appName, svc.name, `⚠ tag 不稳定（${svc.image}），跳过该 service`);
          addSkip('tag-unstable', 'image-parse');
          continue;
        }
        // 不支持的 registry（自建 harbor / 带端口的私有 registry）→ skipped
        if (!createAdapter(svc.image)) {
          log(appName, svc.name, `⚠ 不支持的 registry（${cls.registry}），跳过该 service`);
          addSkip('unsupported-registry', 'image-parse', { registry: cls.registry });
          continue;
        }
        hardcoded.push({
          ...svc,
          repo: cls.repo,          // 不含 registry（用于匹配 data.yml formField）
          imageRef: cls.imageRef,  // 含 registry（用于展示）
          tag: cls.tag,
          registry: cls.registry,
        });
      }

      // ── 变量型应用处理 ──────────────────────────────────────────────
      // 变量型 compose 示例（bookorbit/photoprism/mineru/... 等 9 个应用都中这条分支）：
      //   - 单 envKey: image: ghcr.io/metacubex/mihomo:${VERSION}  field.default = 'ghcr.io/...:v1.19.18'
      //   - 双 envKey: image: ${APP_IMAGE}:${APP_VERSION}            APP_IMAGE=repo, APP_VERSION=tag
      // 两种形态都通过 lib/compose.mjs 的 resolveImageTemplate 统一解析为 (imageRepo, currentTag)，
      // 修复了原"按 envKey 单独 split(':')"对双 envKey 形态静默失败的 bug（2026-10-14 排查）。
      const variableTagChanges = [];
      const formFields = dataObj?.additionalProperties?.formFields || [];
      for (const svc of variable) {
        const resolved = resolveImageTemplate(svc.image, formFields);
        if (!resolved) {
          log(appName, svc.name, `image=${svc.image} 无法解析为 (imageRepo, currentTag)，跳过`);
          addSkip('image-template-unresolved', 'image-parse');
          continue;
        }
        const { imageRepo, currentTag, envKey } = resolved;

        // 检查 tag 是否为 latest（跳过）
        if (currentTag === 'latest') {
          log(appName, svc.name, `${envKey}=${currentTag} ⚠ tag=latest，跳过`);
          addSkip('tag-latest', 'image-parse');
          continue;
        }

        // 过滤不稳定关键字
        if (UNSTABLE_TAG_RE.test(currentTag)) {
          log(appName, svc.name, `${envKey}=${currentTag} ⚠ 包含不稳定关键字，跳过`);
          addSkip('tag-unstable', 'image-parse');
          continue;
        }

        // 构造完整镜像字符串供 registry 查询
        const fullImage = `${imageRepo}:${currentTag}`;
        const parsed = parseImage(fullImage);
        if (!parsed) {
          fail('image-parse', 'image-unresolved', new Error(`镜像字符串无法解析: ${fullImage}`));
          return { result, updates: [] };
        }
        if (!createAdapter(fullImage)) {
          log(appName, svc.name, `${fullImage} registry=${parsed.registry} 不受支持，跳过`);
          addSkip('unsupported-registry', 'image-parse', { registry: parsed.registry });
          continue;
        }

        // 向 registry 请求最新 tag（传递当前 tag 用于变体匹配）
        let latest;
        try {
          latest = await getLatestTag(fullImage, currentTag);
        } catch (e) {
          if (e instanceof RegistryRequestError) {
            fail('registry', 'registry-request-failed', e);
          } else {
            fail('registry', 'unexpected-error', e);
          }
          return { result, updates: [] };
        }
        queried = true;
        if (!latest) {
          log(appName, svc.name, `${fullImage} 无法获取最新 tag`);
          addSkip('no-stable-tag', 'registry');
          continue;
        }
        if (latest === currentTag) {
          log(appName, svc.name, `${fullImage} 已是最新`);
          continue;
        }

        log(appName, svc.name, `${fullImage} ⚠ ${currentTag} -> ${latest}`);
        const newDefaultVal = rebuildImageDefault(svc.image, envKey, imageRepo, latest);
        variableTagChanges.push({
          svcName: svc.name,
          envKey,
          imageRepo,
          fromTag: currentTag,
          toTag: latest,
          defaultVal: resolved.defaultVal,
          newDefaultVal,
        });
      }

      if (hardcoded.length === 0 && variableTagChanges.length === 0) {
        log(appName, `${versionDir} 全为变量型或 latest（${variable.length} 个变量），跳过`);
        continue;
      }

      // 检测最新 tag
      const changes = [];
      const serviceChanges = [];
      let hasAnyUpdate = false;
      let minFrom = null;
      let maxTo = null;

      for (const svc of hardcoded) {
        let latest;
        try {
          latest = await getLatestTag(svc.image, svc.tag);
        } catch (e) {
          if (e instanceof RegistryRequestError) {
            fail('registry', 'registry-request-failed', e);
          } else {
            fail('registry', 'unexpected-error', e);
          }
          return { result, updates: [] };
        }
        queried = true;
        if (!latest) {
          log(appName, svc.name, '无法获取最新 tag');
          addSkip('no-stable-tag', 'registry');
          continue;
        }
        if (latest === svc.tag) {
          log(appName, svc.name, `已是最新 (${svc.tag})`);
          continue;
        }
        log(appName, svc.name, `⚠ ${svc.tag} -> ${latest}`);
        hasAnyUpdate = true;
        if (!minFrom || compareVersionsLoose(svc.tag, minFrom) < 0) minFrom = svc.tag;
        if (!maxTo || compareVersionsLoose(latest, maxTo) > 0) maxTo = latest;
        // compose 文本改写使用**原始镜像字符串**逐字替换：
        // 重建 `repo:tag` 会丢掉 registry 前缀（docker.io/…）或端口（localhost:5000/…），
        // 导致 replaceAll 匹配不上原文。
        const origImage = svc.image;
        const origPrefix = origImage.slice(0, origImage.length - svc.tag.length - 1);
        serviceChanges.push({
          name: svc.name,
          repo: svc.repo,
          imageRef: svc.imageRef,
          from: svc.tag,
          to: latest,
          origImage,
          newImage: `${origPrefix}:${latest}`,
        });
      }

      // 变量型变更也纳入 serviceChanges（供 updates.json 输出）
      for (const vch of variableTagChanges) {
        serviceChanges.push({
          name: vch.svcName,
          repo: vch.imageRepo,
          imageRef: vch.imageRepo,
          from: vch.fromTag,
          to: vch.toTag,
        });
      }

      if (!hasAnyUpdate && variableTagChanges.length > 0) {
        // 变量型应用有更新：取最新 toTag 作为版本目录名
        const maxVarTo = variableTagChanges.reduce((max, ch) =>
          compareVersionsLoose(ch.toTag, max) > 0 ? ch.toTag : max, variableTagChanges[0].toTag);
        if (!maxTo || compareVersionsLoose(maxVarTo, maxTo) > 0) maxTo = maxVarTo;
        hasAnyUpdate = true;
      }

      if (!hasAnyUpdate) continue;

      // === 新建多版本目录（保留旧版用于回滚） ===
      // 1Panel UI 版本下拉 = 仓库目录名；检测到新 tag 后保留旧目录并新建新版本目录。
      // 例：anirss/v3.2.5/ 检测到 v3.2.6 → 保留 v3.2.5/，新建 v3.2.6/
      // 用户可在 1Panel UI 中切换版本，旧版本目录永久保留在仓库 git history 中。
      const oldVersionDir = versionDir;
      const newVersionDir = maxTo;

      // 不在这里真做 cpSync / rmSync ——
      // 把"是否要 cpSync 新版本目录"记到 update.versionCopy 字段，由 main 末尾 applyChanges
      // 统一在 DRY_RUN 判定后再做（DRY_RUN 模式下只 log 不真复制，避免污染工作树）
      let versionCopy = null;
      if (oldVersionDir === newVersionDir) {
        log(appName, `${versionDir} 目标版本与当前一致 (${newVersionDir})，跳过目录操作`);
      } else {
        const newDir = path.join(appDir, newVersionDir);
        const newDirExists = fs.existsSync(newDir);
        // 安全闸：目标目录已存在且与来源目录不同 → 跨目录覆盖会摧毁目标目录的手维护内容
        // （2026-09-25 jellyfin 事故：2026091410-arm64/ 覆盖掉 10.11.11/）
        if (!canCopyVersionDir(oldVersionDir, newVersionDir, newDirExists)) {
          log(appName, `⚠ 跳过：目标目录 ${newVersionDir}/ 已存在且不同于来源 ${oldVersionDir}/，跨目录覆盖会摧毁目标目录的手维护内容`);
          addSkip('version-unrecognized', 'version');
          continue;
        }
        if (newDirExists) {
          log(appName, `⚠ 目标目录 ${newVersionDir}/ 已存在，将覆盖`);
        }
        // 注意：先于 cpSync 读一次源目录的 compose/data.yml 用于新版本改写
        // （在 cpSync 之前，避免源被覆盖；这里只在内存操作，不写盘）
        versionCopy = {
          appName,
          fromDir: oldVersionDir,
          toDir: newVersionDir,
          // exists 标记让 applyChanges 在 DRY_RUN log 时一并说明
          overwrite: newDirExists,
        };
        log(appName, `[pending] cpSync: ${oldVersionDir}/ -> ${newVersionDir}/（DRY_RUN 不真做）`);
      }

      // 内存中替换 compose / data.yml
      let newCompose = composeContent;
      for (const ch of serviceChanges) {
        if (ch.origImage) {
          newCompose = newCompose.replaceAll(ch.origImage, ch.newImage);
        } else {
          const oldImg = `${ch.imageRef}:${ch.from}`;
          const newImg = `${ch.imageRef}:${ch.to}`;
          newCompose = newCompose.replaceAll(oldImg, newImg);
        }
      }

      // 修改 data.yml formFields（hardcode 类 + 变量型）
      let newData = dataContent;
      // hardcode 类：从 formFields 中找到匹配镜像 repo 的字段并替换 tag
      for (const ch of serviceChanges) {
        if (!ch.repo) continue;
        const found = findFormFieldForImage(dataObj, ch.repo);
        if (found) {
          const oldDefault = String(found.field.default);
          const newDefault = oldDefault.replace(`:${ch.from}`, `:${ch.to}`);
          if (oldDefault !== newDefault) {
            dataObj.additionalProperties.formFields[found.index].default = newDefault;
            log(appName, `data.yml formFields[${found.index}].default: ${oldDefault} -> ${newDefault}`);
          }
        } else {
          log(appName, `data.yml 未找到 ${ch.repo} 对应 formField`);
        }
      }
      // 变量型：直接修改对应 envKey 的 formField.default
      for (const vch of variableTagChanges) {
        const fields = dataObj?.additionalProperties?.formFields || [];
        const fieldIdx = fields.findIndex(f => f.envKey === vch.envKey);
        if (fieldIdx !== -1) {
          const oldDefault = String(fields[fieldIdx].default);
          dataObj.additionalProperties.formFields[fieldIdx].default = vch.newDefaultVal;
          log(appName, `data.yml formFields[${fieldIdx}].default: ${oldDefault} -> ${vch.newDefaultVal}`);
        }
      }
      newData = serializeYaml(dataObj);

      // 幂等保护：newData 与 dataContent 完全相同 → 跳过整个 app
      // 防"已最新"被误判为有更新（理论上 getLatestTag 已过滤 latest===currentTag，
      // 但 formField.default 字符串化时若带尾随空白或 yaml 顺序不同仍可能差 1 字节），
      // 此处双保险：序列化后整文对比。
      if (newData === dataContent && newCompose === composeContent) {
        log(appName, `${versionDir} 幂等: 写入内容与现有完全一致，跳过`);
        continue;
      }

      // 写入新版本目录
      changes.push({ path: `${appName}/${newVersionDir}/docker-compose.yml`, content: newCompose, to: maxTo });
      changes.push({ path: `${appName}/${newVersionDir}/data.yml`, content: newData, to: maxTo });

      allUpdates.push({ app: appName, from: minFrom, to: maxTo, services: serviceChanges, changes, versionDir, versionCopy });
    }

    // ── 汇总 app 级结论 ───────────────────────────────────────────────
    if (allUpdates.length > 0) {
      result.status = 'success';
      result.stage = 'scan';
      result.reason = formatReason('update-found', { to: allUpdates[0].to });
      result.code = 'update-found';
      result.error = null;
      result.updates = allUpdates.length;
      return { result, updates: allUpdates };
    }
    if (queried) {
      // 真的查过 registry 且没有新版本 → 一次**成功**的检测（"已是最新"）
      result.status = 'success';
      result.stage = 'scan';
      result.reason = formatReason('no-update');
      result.code = 'no-update';
      result.error = null;
      result.updates = 0;
      return { result, updates: [] };
    }
    if (skipReasons.length > 0) {
      // 没有查过 registry：有意的跳过（不是失败）
      result.status = 'skipped';
      const primary = pickPrimaryReason(skipReasons);
      result.stage = stageForReason(primary);
      result.reason = formatReason(primary, skipCtx.get(primary) || {});
      result.code = primary;
      result.error = null;
      result.updates = 0;
      return { result, updates: [] };
    }
    result.status = 'success';
    result.stage = 'scan';
    result.reason = formatReason('no-update');
    result.code = 'no-update';
    result.error = null;
    result.updates = 0;
    return { result, updates: [] };
  } catch (e) {
    // 未预期异常 → failed（不中断其它应用）
    fail('scan', 'unexpected-error', e);
    return { result, updates: [] };
  }
}

/**
 * reason 码 → 阶段
 * @param {string} code
 * @returns {string}
 */
export function stageForReason(code) {
  switch (code) {
    case 'whitelisted': return 'whitelist';
    case 'no-version-dirs': return 'scan';
    case 'no-services': return 'compose';
    case 'compose-missing':
    case 'compose-invalid': return 'compose';
    case 'data-yml-missing':
    case 'data-yml-invalid': return 'data-yml';
    case 'image-unresolved':
    case 'image-template-unresolved':
    case 'digest-image':
    case 'no-tag':
    case 'tag-latest':
    case 'tag-unstable':
    case 'unsupported-registry': return 'image-parse';
    case 'no-stable-tag':
    case 'registry-request-failed': return 'registry';
    case 'version-unrecognized': return 'version';
    case 'write-failed': return 'write';
    default: return 'scan';
  }
}

/**
 * 从多个 skip reason 中挑一个最具代表性的（优先级列表最靠前的）
 * @param {string[]} reasons
 * @returns {string}
 */
export function pickPrimaryReason(reasons) {
  if (!reasons || reasons.length === 0) return 'no-update';
  let best = reasons[0];
  let bestIdx = SKIP_REASON_PRIORITY.indexOf(best);
  if (bestIdx === -1) bestIdx = SKIP_REASON_PRIORITY.length;
  for (const r of reasons) {
    let idx = SKIP_REASON_PRIORITY.indexOf(r);
    if (idx === -1) idx = SKIP_REASON_PRIORITY.length;
    if (idx < bestIdx) {
      best = r;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * 追加 markdown 到 GitHub Step Summary 文件（若环境变量指向可写路径）
 * @param {string} markdown
 * @returns {boolean} 是否写入成功
 */
function appendStepSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return false;
  try {
    fs.appendFileSync(target, `${markdown}\n`, 'utf8');
    return true;
  } catch (e) {
    console.error('[detect] 写入 GITHUB_STEP_SUMMARY 失败:', e.message);
    return false;
  }
}

/**
 * 渲染 GitHub Step Summary 的 markdown（每应用结果表 + 汇总）
 *
 * 委托给 lib/report.mjs 的 renderMarkdown（唯一 markdown 渲染实现）。
 * @param {Array<object>} results
 * @param {{timestamp?: string, title?: string}} [opts]
 * @returns {string}
 */
function renderStepSummaryMarkdown(results, opts = {}) {
  return renderMarkdown(results, {
    title: opts.title ?? 'detect-updates 检测汇总',
    timestamp: opts.timestamp,
  });
}

async function main() {
  // 安全护栏：PR 事件下禁止写操作（防御纵深）
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    console.error(`[detect] 拒绝在 ${eventName} 事件下运行 detect-updates（PR 事件禁止写操作）`);
    process.exit(1);
  }

  // 加载别名表（dir 可能指向嵌套路径，如 ramuses/photopea）
  const aliasByDir = loadAliases();
  // shortName -> dir 映射：APPS_FILTER 支持按短名（如 photopea）或实际目录（如 ramuses/photopea）过滤
  const shortToDir = new Map();
  for (const [dir, conf] of aliasByDir.entries()) {
    shortToDir.set(conf._shortName, dir);
  }

  const allApps = listApps(REPO_ROOT, aliasByDir).map(a => a.dir);
  let targetApps = allApps;
  if (APPS_FILTER.length > 0) {
    const expanded = APPS_FILTER.map((f) => shortToDir.get(f) || f);
    targetApps = allApps.filter((a) => expanded.includes(a));
  }
  log(`扫描 ${targetApps.length} 个应用`);

  const updates = [];
  const results = [];
  for (const app of targetApps) {
    const { result, updates: appUpdates } = await processApp(app);
    results.push(result);
    if (appUpdates.length > 0) updates.push(...appUpdates);
  }

  // 将检测到的变更写入磁盘（供后续 git add 提交）
  // DRY_RUN 模式下只输出 diff，不真写（applyChanges 内部判定）
  // 注意：必须先做 versionCopy（cpSync + rmSync）再做 changes（覆盖 compose/data.yml），
  // 否则覆盖会写到一个不存在的目录中。
  // 写盘失败 → 该应用标记 failed（stage=write），但不影响其它应用。
  const resultByApp = new Map(results.map(r => [r.app, r]));
  const markWriteFailure = (app, e) => {
    const r = resultByApp.get(app);
    if (!r) return;
    r.status = 'failed';
    r.stage = 'write';
    r.reason = formatReason('write-failed');
    r.code = 'write-failed';
    r.error = e instanceof Error ? e.message : String(e);
    r.updates = 0;
    if (processOptions.VERBOSE && e instanceof Error && e.stack) {
      log(app, 'stack:', e.stack);
    }
  };

  for (const update of updates) {
    if (update.versionCopy) {
      try {
        applyChanges(update.app, [], update.versionCopy);
      } catch (e) {
        console.error(`[detect] ${update.app} cpSync 失败:`, e.message);
        markWriteFailure(update.app, e);
      }
    }
  }
  for (const update of updates) {
    if (update.changes.length > 0) {
      try {
        applyChanges(update.app, update.changes);
      } catch (e) {
        console.error(`[detect] ${update.app} 写盘失败:`, e.message);
        markWriteFailure(update.app, e);
      }
    }
  }

  const summary = buildResultSummary(results);

  // "有更新" 是正常业务流，不是退出码信号。
  // CI 通过 updates.json + has-updates 判定分流:
  //   - 无更新: updates.json 写空数组, has-updates=false, job success
  //   - 有更新: updates.json 写非空数组, has-updates=true, 开 PR 步骤跑
  // 真正异常（存在 failed 应用）→ updates.json 仍然写盘（供工作流摘要使用），随后 exit 2。
  // DRY_RUN 模式下 updates.json 也只输出到 stdout，不写盘（避免污染工作树）
  const out = {
    updates,
    scanned: targetApps.length,
    timestamp: new Date().toISOString(),
    results,
    summary,
  };
  if (processOptions.DRY_RUN) {
    log(`[DRY-RUN] 完成: ${updates.length} 个版本有更新（不写 updates.json）`);
    log(`[DRY-RUN] updates.json preview:`);
    console.log(JSON.stringify(out, null, 2));
  } else {
    fs.writeFileSync('updates.json', JSON.stringify(out, null, 2));
    log(`完成: ${updates.length} 个版本有更新`);
  }

  // 汇总报告：stdout + GitHub Step Summary
  console.log(formatResultReport(results));
  appendStepSummary(renderStepSummaryMarkdown(results, { timestamp: out.timestamp }));

  const exitCode = overallExitCode(results);
  if (exitCode !== 0) {
    console.error(`[detect] 存在 ${summary.failed} 个失败应用，退出码 ${exitCode}`);
  }
  process.exit(exitCode);
}

// 仅当作为 CLI 直接执行（而非被 import）时才跑 main()。
// 原因：原实现在模块顶层无条件调用 main().catch，测试 .github/lib/detect-updates.test.mjs
// 一旦 import 本文件即触发：DockerHub/GHCR 网络调用 → 写 updates.json → 抛错/退出，
// 导致 node --test 在第一个 case 之前静默终止，输出仅为 'test failed' + exit code 1。
// ESM 标准做法：用 import.meta.url 与 process.argv[1] 标准化后的 file:// URL 对比。
const isCliInvocation =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliInvocation) {
  // 1. 先从 env 读取 APPS_FILTER
  initAppsFilter();
  // 2. 解析 CLI 参数（含 --dry-run / --help / --verbose / 位置参数）
  //    注：必须在 main 之前调用，因为 processOptions 影响 main 内部的写盘行为
  let cliPositional;
  try {
    cliPositional = parseCliArgs(process.argv.slice(2)).positional;
  } catch (e) {
    console.error('[detect]', e.message);
    process.exit(1);
  }
  // 3. 把位置参数合并到 APPS_FILTER（与 GITHUB ENV 等价）
  if (cliPositional.length > 0) {
    APPS_FILTER.push(...cliPositional.filter(Boolean));
  }
  if (processOptions.HELP) {
    printHelp();
    process.exit(0);
  }
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}
