#!/usr/bin/env node
/**
 * sync-readme.mjs — 同步仓库根 README.md 的"应用列表"表格
 *
 * 流程：
 * 1. 读取 .github/app-aliases.yml 构建别名映射
 * 2. 扫描仓库根目录，发现所有应用目录
 * 3. 对每个应用按优先级链取"说明"和"当前版本"
 * 4. 读取 README.md，定位 ## 应用列表 下的 Markdown 表格
 * 5. 整体重写该表格
 *
 * "说明"优先级：别名表 desc > 根 data.yml shortDescZh > 版本 data.yml shortDescZh > README 第一段首句 > 空
 * "当前版本"优先级：别名表 preferred_version > 版本号最大的非 latest 目录（semver 排序）> latest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

// ---------- 常量 ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 根目录下需要跳过的非应用目录
const SKIP_DIRS = new Set(['.github', 'scripts', '.git', 'node_modules', '.agent_cache']);

// 简易日志
const log = (...a) => console.log('[sync-readme]', ...a);

// ---------- 工具函数 ----------

/**
 * 安全读取 YAML 文件
 * @param {string} filePath - 文件路径
 * @returns {object|null} 解析后的对象，失败返回 null
 */
function readYaml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content) || {};
  } catch {
    return null;
  }
}

/**
 * 从 data.yml 对象中提取 shortDescZh（兼容两种层级结构）
 * 优先检查 additionalProperties.shortDescZh，再检查顶层 shortDescZh
 * @param {object} data - data.yml 解析结果
 * @returns {string|null}
 */
function extractShortDesc(data) {
  if (!data) return null;
  // 优先: additionalProperties.shortDescZh
  const fromAdditional = data.additionalProperties?.shortDescZh;
  if (fromAdditional) return String(fromAdditional);
  // 回退: 顶层 shortDescZh
  const fromRoot = data.shortDescZh;
  if (fromRoot) return String(fromRoot);
  return null;
}

/**
 * 从 README.md 中提取第一个非标题、非空行作为描述回退
 * @param {string} readmePath - README 文件路径
 * @returns {string|null} 首段首句（截取到第一个句号或换行）
 */
function getFirstSentence(readmePath) {
  try {
    const content = fs.readFileSync(readmePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过标题行和空行
      if (!trimmed || trimmed.startsWith('#')) continue;
      // 取到第一个句号或整行（取较短者）
      const periodIdx = trimmed.indexOf('。');
      if (periodIdx > 0) return trimmed.substring(0, periodIdx + 1);
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析语义化版本号字符串，返回数值数组用于比较
 * 例如 "10.11.11" -> [10, 11, 11]，"1.2.3-rc1" -> [1, 2, 3]
 * @param {string} ver - 版本字符串
 * @returns {number[]}
 */
function parseSemver(ver) {
  // 去除前缀 v 和后缀预发布标签（如 -rc3、-beta1）
  const cleaned = ver.replace(/^v/, '').replace(/-.*$/, '');
  return cleaned.split('.').map(Number);
}

/**
 * 比较两个语义化版本号
 * @param {string} a - 版本 A
 * @param {string} b - 版本 B
 * @returns {number} 负数表示 a < b，正数表示 a > b
 */
function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ---------- 应用目录判断 ----------

/**
 * 判断一个目录是否是应用目录
 * 应用目录 = 有 data.yml（根或 latest/ 版本下）或在别名表中有映射
 * @param {string} dirPath - 目录完整路径
 * @param {string} dirName - 目录名
 * @param {Map} aliasByDir - 目录名 -> 别名配置 的映射
 * @returns {boolean}
 */
function isAppDir(dirPath, dirName, aliasByDir) {
  if (SKIP_DIRS.has(dirName)) return false;
  // 别名表中有映射，直接认定为应用
  if (aliasByDir.has(dirName)) return true;
  // 有根 data.yml
  if (fs.existsSync(path.join(dirPath, 'data.yml'))) return true;
  // 有 latest/data.yml（无根 data.yml 但有 latest 版本）
  if (fs.existsSync(path.join(dirPath, 'latest', 'data.yml'))) return true;
  return false;
}

// ---------- 获取应用信息 ----------

/**
 * 获取应用的说明文本（按优先级链）
 * @param {string} dirName - 应用目录名
 * @param {object|null} alias - 别名配置
 * @returns {string} 说明文本，可能为空串
 */
function getDescription(dirName, alias) {
  // 1. 别名表 desc
  if (alias?.desc) return alias.desc;

  const rootDataPath = path.join(REPO_ROOT, dirName, 'data.yml');
  const rootData = readYaml(rootDataPath);

  // 2. 根 data.yml shortDescZh
  const rootDesc = extractShortDesc(rootData);
  if (rootDesc) return rootDesc;

  // 3. 版本 data.yml shortDescZh（扫描所有版本目录取第一个有效的）
  const appDir = path.join(REPO_ROOT, dirName);
  try {
    const entries = fs.readdirSync(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const verDataPath = path.join(appDir, entry.name, 'data.yml');
      const verData = readYaml(verDataPath);
      const verDesc = extractShortDesc(verData);
      if (verDesc) return verDesc;
    }
  } catch {
    // 目录读取失败，继续回退
  }

  // 4. README.md 第一段首句
  const readmePath = path.join(appDir, 'README.md');
  const firstSentence = getFirstSentence(readmePath);
  if (firstSentence) return firstSentence;

  // 5. 空
  return '';
}

/**
 * 获取应用的当前版本（按优先级链）
 * @param {string} dirName - 应用目录名
 * @param {object|null} alias - 别名配置
 * @returns {string} 版本字符串
 */
function getVersion(dirName, alias) {
  // 1. 别名表 preferred_version
  if (alias?.preferred_version) return alias.preferred_version;

  const appDir = path.join(REPO_ROOT, dirName);

  // 2. 扫描版本目录，取非 latest 中版本号最大的
  try {
    const entries = fs.readdirSync(appDir, { withFileTypes: true });
    const versionDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name !== 'latest' && name !== 'data' && name !== 'scripts');
    // 必须是包含 data.yml 的版本目录
    const validVersions = versionDirs.filter((v) =>
      fs.existsSync(path.join(appDir, v, 'data.yml'))
    );
    if (validVersions.length > 0) {
      // 按 semver 降序排列，取最大者
      const sorted = validVersions.sort((a, b) => compareVersions(b, a));
      return sorted[0];
    }
  } catch {
    // 目录读取失败
  }

  // 3. 回退到 latest
  return 'latest';
}

// ---------- 主流程 ----------

/**
 * 主函数：扫描应用、生成表格、替换 README
 */
function main() {
  // 1. 读取别名表
  const aliasesPath = path.join(REPO_ROOT, '.github', 'app-aliases.yml');
  if (!fs.existsSync(aliasesPath)) {
    log('❌ 未找到 .github/app-aliases.yml');
    process.exit(1);
  }
  const aliasesData = readYaml(aliasesPath);
  const aliases = aliasesData?.aliases || {};

  // 构建正向映射: shortName -> alias 配置
  const aliasByName = new Map(Object.entries(aliases));

  // 构建反向映射: dirName -> alias 配置（用于别名表中指定了 dir 的条目）
  const aliasByDir = new Map();
  for (const [name, conf] of Object.entries(aliases)) {
    const dir = conf.dir || name;
    aliasByDir.set(dir, { ...conf, _shortName: name });
  }

  log(`加载别名表: ${Object.keys(aliases).length} 条`);

  // 2. 扫描根目录，发现所有应用
  const appDirs = [];
  const rootEntries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (isAppDir(path.join(REPO_ROOT, entry.name), entry.name, aliasByDir)) {
      appDirs.push(entry.name);
    }
  }

  // 2.1 补充别名表 dir 指向嵌套路径的应用（如 ramuses/photopea）
  // 根一级目录扫描无法发现嵌套目录，需按别名表 dir 显式补充
  for (const [name, conf] of Object.entries(aliases)) {
    const dir = conf.dir || name;
    if (/[\\/]/.test(dir) && !appDirs.includes(dir)) {
      const dirPath = path.join(REPO_ROOT, dir);
      if (
        fs.existsSync(path.join(dirPath, 'data.yml')) ||
        fs.existsSync(path.join(dirPath, 'latest', 'data.yml'))
      ) {
        appDirs.push(dir);
        log(`发现嵌套应用: ${dir}`);
      }
    }
  }

  // 按 shortName 字母序排列
  appDirs.sort((a, b) => {
    const nameA = aliasByDir.get(a)?._shortName || a;
    const nameB = aliasByDir.get(b)?._shortName || b;
    return nameA.localeCompare(nameB);
  });

  log(`发现 ${appDirs.length} 个应用: ${appDirs.join(', ')}`);

  // 3. 收集每个应用的信息
  const rows = [];
  for (const dirName of appDirs) {
    const alias = aliasByDir.get(dirName) || aliasByName.get(dirName) || null;
    const shortName = alias?._shortName || alias?.dir ? (alias._shortName || dirName) : dirName;

    const desc = getDescription(dirName, alias);
    const version = getVersion(dirName, alias);

    rows.push({ name: shortName, desc, version });
    log(`  ${shortName}: desc="${desc}", version=${version}`);
  }

  // 4. 读取 README.md
  const readmePath = path.join(REPO_ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) {
    log('❌ 未找到 README.md');
    process.exit(1);
  }
  const readme = fs.readFileSync(readmePath, 'utf8');
  const lines = readme.split('\n');

  // 5. 定位 ## 应用列表 标题行
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## 应用列表') {
      sectionStart = i;
      break;
    }
  }
  if (sectionStart === -1) {
    log('❌ README.md 中未找到 "## 应用列表" 标题');
    process.exit(1);
  }

  // 6. 定位表格起止行
  // 表格起始：从 sectionStart 之后的第一个 |--- 行（分隔行）
  let tableSepStart = -1;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|---') || lines[i].trim().startsWith('| ---')) {
      tableSepStart = i;
      break;
    }
  }
  if (tableSepStart === -1) {
    log('❌ 未找到表格分隔行 (|---)');
    process.exit(1);
  }

  // 表格起始行 = 分隔行 - 1（表头行）
  const tableHeaderStart = tableSepStart - 1;

  // 表格结束：从分隔行之后，找到第一个不以 | 开头的行
  let tableEnd = tableSepStart + 1;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith('|')) {
    tableEnd++;
  }
  // tableEnd 现在指向表格之后的第一个非表格行

  // 7. 生成新表格内容
  const tableLines = [
    '| 应用 | 说明 | 当前版本 |',
    '|------|------|----------|',
    ...rows.map((r) => `| ${r.name} | ${r.desc} | ${r.version} |`),
  ];

  // 8. 替换表格：保留前后的空行
  const newLines = [
    ...lines.slice(0, tableHeaderStart),
    ...tableLines,
    ...lines.slice(tableEnd),
  ];

  // 9. 写回 README.md
  const newContent = newLines.join('\n');
  fs.writeFileSync(readmePath, newContent, 'utf8');
  log(`✅ README.md 已更新: ${rows.length} 行`);
}

// 执行
main();
