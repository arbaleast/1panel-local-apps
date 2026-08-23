#!/usr/bin/env node
// detect-updates.mjs — 检测 hardcode 类应用的镜像更新，修改文件并输出 updates.json
// 仅处理 compose 中 image 含硬编码 tag 的应用，变量型（${IMAGE} 等）整体跳过
// 适配 AGENTS.md "禁止 latest 作目录名" 规则：每应用可有多个具体版本目录；检测到新 tag 后
// 保留旧版本目录并 cpSync 新版本目录，1Panel UI 版本下拉展示所有历史版本，支持回滚。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
// 共享模块：semver 比较、镜像 registry 适配器、应用目录扫描
import { parse, compare } from '../lib/semver.mjs';
import { createAdapter } from '../lib/registry.mjs';
import { listApps } from '../lib/apps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// 应用目录直接在仓库根，不在 apps/ 子目录下
const APPS_DIR = REPO_ROOT;

const APPS_FILTER = (process.env.APPS_FILTER || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 应用级白名单：detect 跳过这些应用, 保留手维护状态。
// 原因:
//   - anythingllm: IMAGE 镜像 tag 使用变体前缀 (pg-1.16.0), 1Panel UI 版本参数已锁定到 1.16.0。
//     DockerHubAdapter 变体匹配会返回 pg-X.Y.Z, 复制出的新目录会与现有 1.16.0 风格不一致。
//     需手维护, 避免 detect 在 anythingllm/ 下新增 pg-1.17.0/ 等带变体前缀的目录。
// 任何新加进白名单的应用都需在 AGENTS.md / README.md 中说明 '手维护, 不走 auto-update'。
const SKIP_AUTO_UPDATE_APPS = new Set(['anythingllm']);

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

  // 对每个版本目录分别处理
  const allUpdates = [];
  for (const versionDir of versionDirs) {
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
    // 变量型 compose 示例：image: ${IMAGE}
    // 从 formField.default 中取完整镜像字符串（如 ghcr.io/metacubex/mihomo:v1.19.18）
    // 检测 registry 是否有新 tag → 新建版本目录（以 tag 为目录名）→ 更新 compose 和 formField.default
    const variableTagChanges = [];
    const dataObj = parseDataYml(dataContent);
    for (const svc of variable) {
      const varEnvKeys = [];
      // 从 image 字符串中提取 ${VAR} 环境变量名
      const matches = svc.image.matchAll(/\$\{([^}]+)\}/g);
      for (const m of matches) varEnvKeys.push(m[1]);

      for (const envKey of varEnvKeys) {
        // 查找对应 formField
        const fields = dataObj?.additionalProperties?.formFields || [];
        const fieldIdx = fields.findIndex(f => f.envKey === envKey);
        if (fieldIdx === -1) continue;
        const field = fields[fieldIdx];
        const defaultVal = String(field.default ?? '');
        if (!defaultVal) continue;

        // 提取镜像 repo 和当前 tag
        const [imageRepo, currentTag] = defaultVal.split(':');
        if (!imageRepo || !currentTag) continue;

        // 检查 tag 是否为 latest（跳过）
        if (currentTag === 'latest') {
          log(appName, svc.name, `${envKey}=${defaultVal} ⚠ tag=latest，跳过`);
          continue;
        }

        // 过滤不稳定关键字
        const UNSTABLE = /^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/;
        if (UNSTABLE.test(currentTag)) {
          log(appName, svc.name, `${envKey}=${defaultVal} ⚠ 包含不稳定关键字 "${currentTag}"，跳过`);
          continue;
        }

        // 向 registry 请求最新 tag（传递当前 tag 用于变体匹配）
        const latest = await getLatestTag(defaultVal, currentTag);
        if (!latest) {
          log(appName, svc.name, `${envKey}=${defaultVal} 无法获取最新 tag`);
          continue;
        }
        if (latest === currentTag) {
          log(appName, svc.name, `${envKey}=${defaultVal} 已是最新`);
          continue;
        }

        log(appName, svc.name, `${envKey}=${defaultVal} ⚠ ${currentTag} -> ${latest}`);
        variableTagChanges.push({
          svcName: svc.name,
          envKey,
          imageRepo,
          fromTag: currentTag,
          toTag: latest,
          defaultVal,
          newDefaultVal: `${imageRepo}:${latest}`,
        });
      }
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

    if (oldVersionDir === newVersionDir) {
      log(appName, `${versionDir} 目标版本与当前一致 (${newVersionDir})，跳过目录操作`);
    } else {
      const newDir = path.join(appDir, newVersionDir);
      if (fs.existsSync(newDir)) {
        log(appName, `⚠ 目标目录 ${newVersionDir}/ 已存在，将覆盖`);
        fs.rmSync(newDir, { recursive: true, force: true });
      }
      // 复制当前版本目录的全部内容到新版本目录
      fs.cpSync(path.join(appDir, oldVersionDir), newDir, { recursive: true });
      log(appName, `新建版本目录: ${oldVersionDir}/ -> ${newVersionDir}/（旧版保留）`);
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

    // 写入新版本目录
    changes.push({ path: `${appName}/${newVersionDir}/docker-compose.yml`, content: newCompose, to: maxTo });
    changes.push({ path: `${appName}/${newVersionDir}/data.yml`, content: newData, to: maxTo });

    allUpdates.push({ app: appName, from: minFrom, to: maxTo, services: serviceChanges, changes, versionDir });
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
      log(app, '处理失败:', e.message);
    }
  }

  // 将检测到的变更写入磁盘（供后续 git add 提交）
  for (const update of updates) {
    for (const change of update.changes) {
      const filePath = path.join(REPO_ROOT, change.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, change.content, 'utf8');
      log(update.app, `写入 ${change.path}`);
    }
  }

  const out = { updates, scanned: targetApps.length, timestamp: new Date().toISOString() };
  fs.writeFileSync('updates.json', JSON.stringify(out, null, 2));
  log(`完成: ${updates.length} 个版本有更新`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
