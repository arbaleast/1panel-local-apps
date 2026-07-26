#!/usr/bin/env node
// detect-updates.mjs — 检测 hardcode 类应用的镜像更新，修改文件并输出 updates.json
// 仅处理 compose 中 image 含硬编码 tag 的应用，变量型（${IMAGE} 等）跳过

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// 应用目录直接在仓库根，不在 apps/ 子目录下
const APPS_DIR = REPO_ROOT;
// 需过滤的非应用目录
const SKIP_DIRS = new Set(['.github', 'scripts', '.git', 'node_modules', '.agent_cache']);

const APPS_FILTER = (process.env.APPS_FILTER || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 简易日志
const log = (...a) => console.log('[detect]', ...a);

// ---------- 工具：Docker Hub / GitHub Container Registry 查询 ----------

async function getLatestTagFromDockerHub(repo) {
  const url = `https://hub.docker.com/v2/repositories/${repo}/tags/?page_size=20&ordering=last_updated`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const tags = (data.results || []).map((r) => r.name);
  // 过滤不稳定 tag
  const stable = tags.filter((t) => !/^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i.test(t));
  return stable[0] || null;
}

async function getLatestTagFromGHCR(repo) {
  // repo 形如 immich-app/immich-server
  const url = `https://api.github.com/orgs/${repo.split('/')[0]}/packages/container/${repo.split('/')[1]}/versions?per_page=20`;
  const headers = {};
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const tags = (data || [])
    .map((v) => v.metadata?.container?.tags || [])
    .flat();
  const stable = tags.filter((t) => !/^(latest|nightly|dev|edge|alpha|beta|rc|main|master)$/i.test(t));
  return stable[0] || null;
}

async function getLatestTag(image) {
  if (image.startsWith('ghcr.io/')) {
    const repo = image.replace(/^ghcr\.io\//, '').split(':')[0];
    return await getLatestTagFromGHCR(repo);
  }
  const repo = image.split(':')[0];
  return await getLatestTagFromDockerHub(repo);
}

// ---------- 工具：解析 compose 与 data.yml ----------

function parseCompose(content) {
  // 简单 yaml 解析即可，提取 services.<name>.image
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

function parseDataYml(content) {
  return yaml.load(content) || {};
}

function serializeYaml(obj) {
  // 保留块风格，避免行内格式污染
  return yaml.dump(obj, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

// 找到 data.yml formFields 中匹配 image repo 的字段
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

function listApps() {
  if (!fs.existsSync(APPS_DIR)) return [];
  const dirs = fs.readdirSync(APPS_DIR, { withFileTypes: true });
  return dirs
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
    .map((d) => d.name);
}

/**
 * 在应用目录中查找包含 docker-compose.yml 的版本子目录
 * 优先返回 latest/，否则返回版本号最大的目录
 * @param {string} appDir - 应用完整路径
 * @returns {string|null} 版本目录名，未找到返回 null
 */
function findVersionDir(appDir) {
  let entries;
  try {
    entries = fs.readdirSync(appDir, { withFileTypes: true });
  } catch {
    return null;
  }
  // 收集包含 docker-compose.yml 的子目录
  const candidates = entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(appDir, e.name, 'docker-compose.yml')))
    .map((e) => e.name);
  if (candidates.length === 0) return null;
  // 优先 latest
  if (candidates.includes('latest')) return 'latest';
  // 按语义化版本号排序，取最大
  candidates.sort((a, b) => {
    const pa = a.replace(/^v/, '').replace(/-.*$/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').replace(/-.*$/, '').split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  });
  return candidates[candidates.length - 1];
}

async function processApp(appName) {
  const appDir = path.join(APPS_DIR, appName);

  // 查找版本子目录（compose 在 <app>/<version>/docker-compose.yml）
  const versionDir = findVersionDir(appDir);
  if (!versionDir) {
    log(appName, '无版本目录或无 compose，跳过');
    return null;
  }

  const composePath = path.join(appDir, versionDir, 'docker-compose.yml');
  const dataPath = path.join(appDir, versionDir, 'data.yml');

  if (!fs.existsSync(dataPath)) {
    log(appName, `${versionDir}/data.yml 不存在，跳过`);
    return null;
  }

  const composeContent = fs.readFileSync(composePath, 'utf8');
  const dataContent = fs.readFileSync(dataPath, 'utf8');

  const services = parseCompose(composeContent);
  if (services.length === 0) {
    log(appName, 'compose 无 services，跳过');
    return null;
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
        log(appName, svc.name, 'tag=latest，跳过');
        continue;
      }
      hardcoded.push({ ...svc, repo, tag });
    } else {
      log(appName, svc.name, '无 tag，跳过');
    }
  }

  if (hardcoded.length === 0) {
    log(appName, `全为变量型或 latest（${variable.length} 个变量），跳过`);
    return null;
  }

  // 检测最新 tag
  const dataObj = parseDataYml(dataContent);
  const changes = [];
  const serviceChanges = [];
  let hasAnyUpdate = false;
  let minFrom = null;
  let maxTo = null;

  for (const svc of hardcoded) {
    const latest = await getLatestTag(svc.image);
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
    if (!minFrom || svc.tag < minFrom) minFrom = svc.tag;
    if (!maxTo || latest > maxTo) maxTo = latest;
    serviceChanges.push({
      name: svc.name,
      repo: svc.repo,
      from: svc.tag,
      to: latest,
    });
  }

  if (!hasAnyUpdate) return null;

  // 修改 compose
  let newCompose = composeContent;
  for (const ch of serviceChanges) {
    const oldImg = `${ch.repo}:${ch.from}`;
    const newImg = `${ch.repo}:${ch.to}`;
    newCompose = newCompose.replaceAll(oldImg, newImg);
  }

  // 修改 data.yml formFields
  let newData = dataContent;
  for (const ch of serviceChanges) {
    const found = findFormFieldForImage(dataObj, ch.repo);
    if (found) {
      const oldDefault = String(found.field.default);
      const newDefault = oldDefault.replace(`:${ch.from}`, `:${ch.to}`);
      if (oldDefault !== newDefault) {
        // 用 yaml dump 整个对象，定位行后替换
        // 简化方案：序列化整个 data.yml（可能引入格式微调）
        dataObj.additionalProperties.formFields[found.index].default = newDefault;
        log(appName, `data.yml formFields[${found.index}].default: ${oldDefault} -> ${newDefault}`);
      }
    } else {
      log(appName, `data.yml 未找到 ${ch.repo} 对应 formField`);
    }
  }
  newData = serializeYaml(dataObj);

  changes.push({ path: `${appName}/${versionDir}/docker-compose.yml`, content: newCompose, to: maxTo });
  changes.push({ path: `${appName}/${versionDir}/data.yml`, content: newData, to: maxTo });

  return { app: appName, from: minFrom, to: maxTo, services: serviceChanges, changes };
}

async function main() {
  const allApps = listApps();
  const targetApps = APPS_FILTER.length > 0 ? allApps.filter((a) => APPS_FILTER.includes(a)) : allApps;
  log(`扫描 ${targetApps.length} 个应用`);

  const updates = [];
  for (const app of targetApps) {
    try {
      const r = await processApp(app);
      if (r) updates.push(r);
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
  log(`完成: ${updates.length} 个应用有更新`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
