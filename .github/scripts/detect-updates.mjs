#!/usr/bin/env node
// detect-updates.mjs — 检测 hardcode 类应用的镜像更新，修改文件并输出 updates.json
// 仅处理 compose 中 image 含硬编码 tag 的应用，变量型（${IMAGE} 等）整体跳过
// 适配 AGENTS.md "禁止 latest 作目录名" 规则：每应用可有多个具体版本目录；检测到新 tag 后
// 保留旧版本目录并 cpSync 新版本目录，1Panel UI 版本下拉展示所有历史版本，支持回滚。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
// 共享模块：semver 比较、镜像 registry 适配器、应用目录扫描
import { parse, compare } from '../lib/semver.mjs';
import { createAdapter } from '../lib/registry.mjs';
import { listApps } from '../lib/apps.mjs';
import { resolveImageTemplate, rebuildImageDefault } from '../lib/compose.mjs';

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
  0  完成（无更新 / 有更新 / dry-run 均视为正常）
  1  脚本异常（依赖缺失 / 配置错误 / 内部异常）

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

// ---------- 工具：解析 compose 与 data.yml ----------

/**
 * 解析 compose 内容，提取 services 列表（含 image 字段）
 * @param {string} content - compose 文件内容
 * @returns {Array<{name: string, image: string}>}
 */
function parseCompose(content) {
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
function parseDataYml(content) {
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
 * @param {object} dataObj - data.yml 解析结果
 * @param {string} imageRepo - 镜像 repo（如 kragleer/anirss）
 * @returns {{index: number, field: object}|null}
 */
function findFormFieldForImage(dataObj, imageRepo) {
  const fields = dataObj?.additionalProperties?.formFields || [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const def = String(f.default ?? '');
    if (def.startsWith(imageRepo + ':') || def === imageRepo) {
      return { index: i, field: f };
    }
    // 也匹配 envKey 暗示镜像变量
    if (['IMAGE', 'APP_VERSION', 'IMAGE_TAG', imageRepo.split('/').pop().toUpperCase()].includes(f.envKey)) {
      const defRepo = def.split(':')[0];
      if (defRepo === imageRepo) {
        return { index: i, field: f };
      }
    }
  }
  return null;
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
 */
async function getLatestTag(image, currentTag) {
  return await createAdapter(image).getLatestTag(image, currentTag);
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

async function processApp(appName) {
  const appDir = path.join(APPS_DIR, appName);

  // 白名单：手维护应用, 跳过整个 detect 流程, 保留现有版本目录与 compose 不变。
  if (shouldSkipAutoUpdate(appName)) {
    log(appName, '在白名单中, 跳过 detect (手维护应用)');
    return null;
  }

  // 获取所有版本子目录
  const versionDirs = getAllVersionDirs(REPO_ROOT, appName);
  if (versionDirs.length === 0) {
    log(appName, '无版本目录或无 compose，跳过');
    return null;
  }

  // ── 跨版本保护：找出"已知最高版本"作为防倒退基准 ──────────────────
  // 复盘（2026-10-14 审查）：bookorbit/3.4.0 与 3.2.0 同属变量型应用（共享 APP_VERSION envKey），
  // detect 把两个 versionDir 都用同一份"最新 tag"覆盖，3.4.0 反而被 3.2.0 倒退回更低 tag。
  // 解决：detect 只处理 maxKnown（最新已知 versionDir）这一个；其它 versionDir 是历史归档
  // 保留在仓库供 1Panel UI 旧版本回滚用，**不应该**被 detect 覆盖。这与"cpSync 新版本目录
  // 保留旧版"的设计哲学一致——只是把"不更新历史版本"提前到 detect 阶段。
  // parse() 期望 string（v.replace），与现有 compare() 签名一致。
  let maxKnown = null;
  for (const vd of versionDirs) {
    if (!parse(vd)) continue;
    if (!maxKnown || compare(vd, maxKnown) > 0) maxKnown = vd;
  }
  if (maxKnown) {
    log(appName, `跨版本保护: maxKnown=${maxKnown}（仅处理此 versionDir，历史归档保留）`);
  } else {
    // 所有 versionDir 都无法 semver 解析（如都是日期格式 2024.08.01）
    // 此时回退到原行为：所有 versionDir 都处理（保兼容）
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
      continue;
    }

    const composeContent = fs.readFileSync(composePath, 'utf8');
    const dataContent = fs.readFileSync(dataPath, 'utf8');

    const services = parseCompose(composeContent);
    if (services.length === 0) {
      log(appName, `${versionDir} compose 无 services，跳过`);
      continue;
    }

    // 分类：hardcode vs 变量型
    const hardcoded = [];
    const variable = [];
    for (const svc of services) {
      if (svc.image.includes('$')) {
        variable.push(svc);
      } else if (svc.image.includes(':')) {
        const [repo, tag] = svc.image.split(':');
        if (tag === 'latest') {
          log(appName, svc.name, '⚠ tag=latest，违反 AGENTS.md 规则，跳过该 service');
          continue;
        }
        hardcoded.push({ ...svc, repo, tag });
      } else {
        log(appName, svc.name, '无 tag，跳过');
      }
    }

    // ── 变量型应用处理 ──────────────────────────────────────────────
    // 变量型 compose 示例（bookorbit/photoprism/mineru/... 等 9 个应用都中这条分支）：
    //   - 单 envKey: image: ghcr.io/metacubex/mihomo:${VERSION}  field.default = 'ghcr.io/...:v1.19.18'
    //   - 双 envKey: image: ${APP_IMAGE}:${APP_VERSION}            APP_IMAGE=repo, APP_VERSION=tag
    // 两种形态都通过 lib/compose.mjs 的 resolveImageTemplate 统一解析为 (imageRepo, currentTag)，
    // 修复了原"按 envKey 单独 split(':')"对双 envKey 形态静默失败的 bug（2026-10-14 排查）。
    const variableTagChanges = [];
    const dataObj = parseDataYml(dataContent);
    const formFields = dataObj?.additionalProperties?.formFields || [];
    for (const svc of variable) {
      const resolved = resolveImageTemplate(svc.image, formFields);
      if (!resolved) {
        log(appName, svc.name, `image=${svc.image} 无法解析为 (imageRepo, currentTag)，跳过`);
        continue;
      }
      const { imageRepo, currentTag, envKey } = resolved;

      // 检查 tag 是否为 latest（跳过）
      if (currentTag === 'latest') {
        log(appName, svc.name, `${envKey}=${currentTag} ⚠ tag=latest，跳过`);
        continue;
      }

      // 过滤不稳定关键字
      const UNSTABLE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/;
      if (UNSTABLE.test(currentTag)) {
        log(appName, svc.name, `${envKey}=${currentTag} ⚠ 包含不稳定关键字，跳过`);
        continue;
      }

      // 构造完整镜像字符串供 registry 查询
      const fullImage = `${imageRepo}:${currentTag}`;

      // 向 registry 请求最新 tag（传递当前 tag 用于变体匹配）
      const latest = await getLatestTag(fullImage, currentTag);
      if (!latest) {
        log(appName, svc.name, `${fullImage} 无法获取最新 tag`);
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
      const latest = await getLatestTag(svc.image, svc.tag);
      if (!latest) {
        log(appName, svc.name, '无法获取最新 tag');
        continue;
      }
      if (latest === svc.tag) {
        log(appName, svc.name, `已是最新 (${svc.tag})`);
        continue;
      }
      log(appName, svc.name, `⚠ ${svc.tag} -> ${latest}`);
      hasAnyUpdate = true;
      if (!minFrom || compare(svc.tag, minFrom) < 0) minFrom = svc.tag;
      if (!maxTo || compare(latest, maxTo) > 0) maxTo = latest;
      serviceChanges.push({
        name: svc.name,
        repo: svc.repo,
        from: svc.tag,
        to: latest,
      });
    }

    // 变量型变更也纳入 serviceChanges（供 updates.json 输出）
    for (const vch of variableTagChanges) {
      serviceChanges.push({
        name: vch.svcName,
        repo: vch.imageRepo,
        from: vch.fromTag,
        to: vch.toTag,
      });
    }

    if (!hasAnyUpdate && variableTagChanges.length > 0) {
      // 变量型应用有更新：取最新 toTag 作为版本目录名
      const maxVarTo = variableTagChanges.reduce((max, ch) =>
        compare(ch.toTag, max) > 0 ? ch.toTag : max, variableTagChanges[0].toTag);
      if (!maxTo || compare(maxVarTo, maxTo) > 0) maxTo = maxVarTo;
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
      const oldImg = `${ch.repo}:${ch.from}`;
      const newImg = `${ch.repo}:${ch.to}`;
      newCompose = newCompose.replaceAll(oldImg, newImg);
    }

    // 修改 data.yml formFields（hardcode 类 + 变量型）
    let newData = dataContent;
    // hardcode 类：从 formFields 中找到匹配镜像 repo 的字段并替换 tag
    for (const ch of serviceChanges) {
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

  if (allUpdates.length === 0) return null;

  return allUpdates;
}

async function main() {
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
  for (const app of targetApps) {
    try {
      const r = await processApp(app);
      if (r) updates.push(...r); // processApp 现在返回数组
    } catch (e) {
      if (processOptions.VERBOSE) {
        log(app, '处理失败:', e.stack || e);
      } else {
        log(app, '处理失败:', e.message);
      }
    }
  }

  // 将检测到的变更写入磁盘（供后续 git add 提交）
  // DRY_RUN 模式下只输出 diff，不真写（applyChanges 内部判定）
  // 注意：必须先做 versionCopy（cpSync + rmSync）再做 changes（覆盖 compose/data.yml），
  // 否则覆盖会写到一个不存在的目录中。
  for (const update of updates) {
    if (update.versionCopy) {
      applyChanges(update.app, [], update.versionCopy);
    }
  }
  for (const update of updates) {
    if (update.changes.length > 0) {
      applyChanges(update.app, update.changes);
    }
  }

  // "有更新" 是正常业务流,不再是退出码信号。
  // CI 通过 updates.json + has-updates 判定分流:
  //   - 无更新: updates.json 写空数组, has-updates=false, job success
  //   - 有更新: updates.json 写非空数组, has-updates=true, 开 PR 步骤跑
  // 真正异常（脚本崩溃 / 依赖缺失）由 main().catch 兜底 process.exit(1)。
  // DRY_RUN 模式下 updates.json 也只输出到 stdout，不写盘（避免污染工作树）
  const out = { updates, scanned: targetApps.length, timestamp: new Date().toISOString() };
  if (processOptions.DRY_RUN) {
    log(`[DRY-RUN] 完成: ${updates.length} 个版本有更新（不写 updates.json）`);
    log(`[DRY-RUN] updates.json preview:`);
    console.log(JSON.stringify(out, null, 2));
  } else {
    fs.writeFileSync('updates.json', JSON.stringify(out, null, 2));
    log(`完成: ${updates.length} 个版本有更新`);
  }
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
