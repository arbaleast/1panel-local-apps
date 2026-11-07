// .github/lib/image-policy.mjs
// 镜像 hardcode 策略（AGENTS.md §6 的可执行版本）。
//
// 为什么需要它：
//   「镜像一律 hardcode `image: tag`，仅少数例外」这条规则过去只写在文档里，
//   没有任何检查在守它。2026-11 的 hardcode 迁移就因为缺少守卫而漏掉
//   music-tag-web/2.8.1（bot 生成的变量型版本目录），导致「最新版反而是变量型」。
//   本模块把规则变成 CI 可验证的不变量：lint 扫描全仓 compose，
//   发现例外清单之外的变量型镜像即报 error。
//
// 单一事实来源：
//   例外清单在本文件（VARIABLE_IMAGE_EXCEPTIONS），AGENTS.md §6 是它的人类可读版本；
//   image-policy.test.mjs 断言两者一致（文档改了而代码没改、或反之，测试立刻失败）。
//
// 纯函数优先：IO 只在显式传路径时发生，便于单测夹具覆盖。

import yaml from 'js-yaml';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 允许使用变量型镜像的版本目录（`<app>/<version>`）。
 * 与 AGENTS.md §6「仅 4 个变量型例外」一一对应：
 *   - silo/RELEASE.2026-08：tag 为 RELEASE 时间戳，检测器无法识别版本序
 *   - infinity/cu124：cu124 为功能型单段 tag，非版本号
 *   - xunlei/beta：上游仅提供浮动 beta tag
 *   - immich/v3.0.3：机器学习镜像按安装表单在 CPU 版（v3.0.3）与 CUDA 版（v3.0.3-cuda）
 *     之间切换（`${ML_IMAGE}:${ML_IMAGE_TAG}` 形态）；tag 段仍是常规版本号，
 *     自动更新照常守护（与前三个「检测跳过」的例外性质不同）
 */
export const VARIABLE_IMAGE_EXCEPTIONS = [
  'silo/RELEASE.2026-08',
  'infinity/cu124',
  'xunlei/beta',
  'immich/v3.0.3',
];

/** 仓库根级目录中需要跳过的（不是应用目录） */
const SKIP_ROOT_DIRS = new Set(['.github', 'docs', 'node_modules', 'scripts']);

/**
 * 从 compose 文本中找出变量型 image（值里含 `${...}`）。
 * 用 YAML 解析而不是正则：compose 里 `${VAR}` 大量出现在 container_name / ports /
 * environment 中，只有 services.*.image 才是镜像，且写法（引号、行尾注释）各异。
 *
 * @param {string} composeText
 * @returns {{service: string, image: string}[]}
 */
export function findVariableImages(composeText) {
  const out = [];
  let doc;
  try {
    doc = yaml.load(composeText);
  } catch {
    return out; // YAML 非法交给 lint 报错，这里不重复判定
  }
  const services = doc?.services;
  if (!services || typeof services !== 'object') return out;
  for (const [name, svc] of Object.entries(services)) {
    const image = svc?.image;
    if (typeof image === 'string' && image.includes('${')) {
      out.push({ service: name, image });
    }
  }
  return out;
}

/**
 * 扫描仓库里所有 `<app>/<version>/docker-compose.yml` 的变量型镜像。
 *
 * @param {string} repoRoot
 * @returns {{app: string, versionDir: string, service: string, image: string}[]}
 */
export function collectVariableImages(repoRoot) {
  const out = [];
  let appDirs;
  try {
    appDirs = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const app of appDirs) {
    if (!app.isDirectory() || app.name.startsWith('.')) continue;
    if (SKIP_ROOT_DIRS.has(app.name)) continue;
    const appPath = join(repoRoot, app.name);
    let versions;
    try {
      versions = readdirSync(appPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const composePath = join(appPath, version.name, 'docker-compose.yml');
      if (!existsSync(composePath)) continue;
      let text;
      try {
        text = readFileSync(composePath, 'utf8');
      } catch {
        continue;
      }
      for (const hit of findVariableImages(text)) {
        out.push({ app: app.name, versionDir: version.name, service: hit.service, image: hit.image });
      }
    }
  }
  return out;
}

/**
 * 策略检查：变量型镜像只允许出现在例外清单内。
 *
 * 两条错误：
 *   1. 例外清单之外的变量型镜像 → 应改为 hardcode `image: repo:tag`；
 *   2. 例外清单里已不再使用变量型镜像的条目 → 清单腐化，应删除。
 *
 * @param {string} repoRoot
 * @param {string[]} [exceptions]
 * @returns {{errors: string[], found: {app: string, versionDir: string, service: string, image: string}[]}}
 */
export function checkImagePolicy(repoRoot, exceptions = VARIABLE_IMAGE_EXCEPTIONS) {
  const found = collectVariableImages(repoRoot);
  const errors = [];
  const used = new Set();

  for (const item of found) {
    const key = `${item.app}/${item.versionDir}`;
    used.add(key);
    if (!exceptions.includes(key)) {
      errors.push(
        `${key}: 变量型镜像 ${item.image}（service: ${item.service}）不在例外清单内` +
          `（允许：${exceptions.join('、')}）——应改为 hardcode \`image: repo:tag\``,
      );
    }
  }

  for (const key of exceptions) {
    if (!used.has(key)) {
      errors.push(`${key}: 例外清单条目已无变量型镜像（清单腐化，应从 AGENTS.md §6 与常量中移除）`);
    }
  }

  return { errors, found };
}

/**
 * 从 AGENTS.md 提取「变量型例外」清单（人类可读版本），用于文档 ↔ 代码一致性断言。
 * 取 §6 中含「变量型例外」的**那一条**里的反引号 token —— 必须止于下一个列表项，
 * 否则同段后续条目（如 compose 变量豁免清单里的 `${VAR}`）会被误当成例外。
 *
 * @param {string} agentsMd
 * @returns {string[]}
 */
export function parseDocumentedExceptions(agentsMd) {
  const idx = agentsMd.indexOf('变量型例外');
  if (idx === -1) return [];
  const rest = agentsMd.slice(idx);
  const nextBullet = rest.search(/\n\s*[-*]\s/); // 下一个列表项即本条结束
  const item = nextBullet === -1 ? rest : rest.slice(0, nextBullet);
  const labels = [];
  for (const m of item.matchAll(/`([^`]+)`/g)) {
    const token = m[1];
    // 只认形如 <app> 或 <app>/<version> 的标识符：
    // 命令（npm run x）、路径（.github/lib/x.mjs）、变量（${VAR}）都不是例外项。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?$/.test(token)) continue;
    labels.push(token);
  }
  return labels;
}
