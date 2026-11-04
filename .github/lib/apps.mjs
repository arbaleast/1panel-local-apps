// lib/apps.mjs — 应用目录扫描与元数据读取
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { compareVersionsLoose } from './semver.mjs';

// 仓库根目录（lib/ 的父级）
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 扫描时跳过的目录名
 * @type {Set<string>}
 */
export const SKIP_DIRS = new Set(['.github', 'scripts', '.git', 'node_modules', '.agent_cache']);

/**
 * 列出所有应用目录
 * @param {string} [root] - 可选，覆盖默认 ROOT
 * @param {Map<string, {dir: string, name: string, description?: string}>} [aliasByDir] - 别名表
 * @returns {Array<{dir: string, shortName: string, aliasEntry?: object}>}
 */
export function listApps(root = ROOT, aliasByDir = new Map()) {
  const result = [];

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const appDir = path.join(root, entry.name);

    // 校验 data.yml 或 docker-compose.yml 任一存在
    const hasDataYml = fs.existsSync(path.join(appDir, 'data.yml'));
    const hasCompose = fs.existsSync(path.join(appDir, 'docker-compose.yml'));

    if (!hasDataYml && !hasCompose) continue;

    result.push({ dir: entry.name, shortName: entry.name });
  }

  // 遍历别名表，补充嵌套路径应用
  for (const [dir, alias] of aliasByDir) {
    const aliasDir = alias.dir;
    if (!aliasDir.includes('/')) continue; // 非嵌套别名，跳过

    // 检查根级是否已存在（直接目录匹配优先）
    const topLevel = aliasDir.split('/')[0];
    if (result.some(r => r.dir === topLevel)) continue;

    // 校验嵌套路径是否存在（data.yml 或 docker-compose.yml）
    const nestedCompose = path.join(root, aliasDir, 'docker-compose.yml');
    const nestedData = path.join(root, aliasDir, 'data.yml');
    const nestedLatest = path.join(root, aliasDir, 'latest', 'docker-compose.yml');

    let exists = fs.existsSync(nestedCompose) || fs.existsSync(nestedData);
    if (!exists) {
      // 尝试 latest/ 子目录
      exists = fs.existsSync(nestedLatest) || fs.existsSync(path.join(root, aliasDir, 'latest', 'data.yml'));
    }

    if (exists) {
      result.push({ dir: aliasDir, shortName: topLevel, aliasEntry: alias });
    }
  }

  // 按 shortName 字母序
  result.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return result;
}

/**
 * 读取应用根级 data.yml 元数据
 * @param {string} [root]
 * @param {string} appDir - 应用目录名（可能含 / 嵌套）
 * @returns {{ key: string, type: string, name: string, description: string, raw: object }|null}
 */
export function getAppMeta(root = ROOT, appDir) {
  const metaPath = path.join(root, appDir, 'data.yml');
  let data;
  try {
    data = yaml.load(fs.readFileSync(metaPath, 'utf8'));
  } catch (_) {
    return null;
  }

  const key = data?.additionalProperties?.key;
  // 一致性校验：key 必须与目录末段一致
  const dirName = appDir.split('/').pop();
  if (key !== dirName) return null;

  return {
    key,
    type: data?.type ?? 'tool',
    name: data?.name ?? dirName,
    description: data?.description ?? '',
    raw: data,
  };
}

/**
 * 获取应用当前版本
 * @param {string} [root]
 * @param {string} appDir
 * @returns {string|null} 版本字符串或 null
 */
export function getCurrentVersion(root = ROOT, appDir) {
  const fullPath = path.join(root, appDir);
  let subDirs;
  try {
    subDirs = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  // 收集版本候选目录（排除 data、scripts、latest）
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

  if (candidates.length > 0) {
    // ⚠️ 历史归档口径（**必须保持行为不变**）：按数字段大小选最大，
    //    数字段相同时取完整目录名 localeCompare 更大的那个。
    //    - 同号变体后缀目录（`1.11.2-ls41` / `3.64.0-v1` / `v3.2.53-arm32v7`）
    //      与同号正式版数字段相等 → 变体后缀目录胜出（handbrake / losslesscut 口径）；
    //    - 日期型目录（`2026091410-arm64`）数字段远大于 semver 目录 → 日期型胜出
    //      （jellyfin 口径，README「当前版本」列必须保持原样）。
    //    这里**不能**改用严格 SemVer 优先级：SemVer 认为 prerelease 低于正式版，
    //    会把 `1.11.2-ls41` 变成 `1.11.2`，从而改动 README（审计要求行为不变）。
    let best = candidates[0];
    for (const c of candidates.slice(1)) {
      const r = compareVersionsLoose(c, best);
      if (r > 0 || (r === 0 && c.localeCompare(best) > 0)) best = c;
    }
    return best;
  }

  // 无版本目录时，检查 latest/ 子目录
  const latestPath = path.join(fullPath, 'latest');
  if (fs.existsSync(latestPath)) {
    const hasDataYml = fs.existsSync(path.join(latestPath, 'data.yml'));
    const hasCompose = fs.existsSync(path.join(latestPath, 'docker-compose.yml'));
    if (hasDataYml || hasCompose) {
      return 'latest';
    }
  }

  return null;
}
