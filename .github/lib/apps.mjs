// lib/apps.mjs — 应用目录扫描与元数据读取
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pickNewestVersionDir } from './version.mjs';

// 仓库根目录（lib/ 的父级）
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 扫描时跳过的目录名
 * @type {Set<string>}
 */
export const SKIP_DIRS = new Set(['.github', 'scripts', '.git', 'node_modules', '.agent_cache']);

/**
 * 加载别名表（.github/app-aliases.yml）—— **别名表的唯一加载实现**。
 *
 * 之前 validate-batch / detect-updates / sync-readme 各写了一份同样的加载逻辑，
 * 三份副本会随修改分叉（单点定义原则）。现在统一到这里。
 *
 * 键 = 实际目录（dir）；值 = 该应用的主名与历史别名：
 *   - `_shortName`：展示用主名。多个条目指向同一 dir 时，**目录同名条目优先**
 *     （canonical 优先）。否则旧名（perplexica → vane）会覆盖当前名，
 *     导致 README「应用列表」与应用目录 key（vane）自相矛盾。
 *   - `aliases`：指向同一 dir 的其它历史名，仍可用于按名解析（APPS_FILTER 等）。
 *
 * @param {string} [root] - 仓库根目录
 * @returns {Map<string, {dir: string, _shortName: string, aliases: string[], preferred_version?: string}>}
 */
export function loadAliases(root = ROOT) {
  const map = new Map();
  const file = path.join(root, '.github', 'app-aliases.yml');
  if (!fs.existsSync(file)) return map;
  let data;
  try {
    data = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return map;
  }
  const aliases = (data && data.aliases) || {};
  for (const [name, conf] of Object.entries(aliases)) {
    if (!conf || typeof conf !== 'object') continue;
    const dir = conf.dir || name;
    const existing = map.get(dir);
    if (!existing) {
      map.set(dir, { ...conf, dir, _shortName: name, aliases: [] });
      continue;
    }
    // 同 dir 多个条目：目录同名者（canonical）作为主名，其余记为历史别名
    if (name === dir && existing._shortName !== dir) {
      map.set(dir, {
        ...conf,
        dir,
        _shortName: name,
        aliases: [...existing.aliases, existing._shortName],
      });
    } else {
      existing.aliases.push(name);
    }
  }
  return map;
}

/**
 * 由别名表构建 shortName → dir 映射（**含历史别名**），供 APPS_FILTER 按名过滤。
 * 旧名仍可解析（perplexica → vane），当前名也可解析（vane → vane）。
 *
 * @param {Map<string, {dir: string, _shortName: string, aliases?: string[]}>} aliasByDir
 * @returns {Map<string, string>}
 */
export function buildShortToDir(aliasByDir) {
  const shortToDir = new Map();
  for (const [dir, conf] of aliasByDir.entries()) {
    shortToDir.set(conf._shortName, dir);
    for (const alias of conf.aliases || []) shortToDir.set(alias, dir);
  }
  return shortToDir;
}

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
    // ⚠️ 实现已收敛到 lib/version.mjs（唯一事实来源）。
    //    mode='archive' = 历史归档口径（全候选按数字段比较，数字段相同时取目录名字典序大者），
    //    与既有行为**逐字一致**（README「当前版本」列依赖它，见下方注释）。
    return pickNewestVersionDir(candidates, 'archive');
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
