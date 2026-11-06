// bin/manifest-collector.mjs — 收集全仓镜像并拉取 manifest 元数据（bin/ 层：允许 fs + 网络）
//
// 定位：**bin 层胶水**，不是新的规则引擎。
//   · 扫描范围与 bin/lint-apps.mjs 的版本目录口径**完全一致**（排除 data/scripts/点目录，**包含 latest/**）。
//   · 镜像引用解析复用 lib/image-ref.mjs#parseImageReference（唯一解析器）；
//     变量型镜像复用 lib/compose.mjs#resolveImageTemplate。
//   · 网络请求复用 lib/registry.mjs#fetchManifest（复用既有 fetchWithRetry / 并发闸门 / 认证）。
//   · 本模块**只拉 JSON 元数据**（OCI Image Index / Manifest / Image Config），
//     **绝不 pull 镜像层**（静态检查阶段禁止下载数 GB 的层）。
//
// 失败语义（目标 §五.3）：网络受限 / 私有源 / 限流 / 不支持的 registry →
//   一律返回 status='unverified' 并写明原因，**绝不静默当成「验证通过」**。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { stripCommentedLines } from '../lib/consistency.mjs';
import { resolveImageTemplate } from '../lib/compose.mjs';
import { fetchManifest, createManifestCache } from '../lib/registry.mjs';

/**
 * 列出某个应用目录下的版本目录名。
 * 口径与 bin/lint-apps.mjs#lintAllVersionDirs 一致：排除 data / scripts / 点目录，**包含 latest/**。
 * @param {string} appDirAbs
 * @returns {string[]}
 */
export function listVersionDirs(appDirAbs) {
  let entries = [];
  try { entries = readdirSync(appDirAbs, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'data' && e.name !== 'scripts' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((v) => existsSync(join(appDirAbs, v, 'data.yml')) || existsSync(join(appDirAbs, v, 'docker-compose.yml')))
    .sort();
}

/**
 * 从一个 compose 文件里解析出全部镜像字符串（变量型已按 formFields default 解析）。
 * @param {string} composeAbs
 * @param {Array<object>} fields - 版本级 formFields
 * @returns {Array<{image:string, source:'literal'|'variable'|'unresolved'}>}
 */
export function extractImages(composeAbs, fields) {
  let raw;
  try { raw = readFileSync(composeAbs, 'utf8'); } catch { return []; }
  let doc;
  try { doc = yaml.load(stripCommentedLines(raw).map((l) => l.text).join('\n')); } catch { return []; }
  const out = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    const image = svc?.image;
    if (typeof image !== 'string' || !image) continue;
    if (!image.includes('${')) { out.push({ image, source: 'literal' }); continue; }
    const tpl = resolveImageTemplate(image, fields);
    if (!tpl) { out.push({ image, source: 'unresolved' }); continue; }
    // 形态 2：defaultVal 本身就是完整镜像串；形态 3：defaultVal 只是 tag
    const resolved = tpl.defaultVal.startsWith(`${tpl.imageRepo}:`)
      ? tpl.defaultVal
      : `${tpl.imageRepo}:${tpl.defaultVal}`;
    out.push({ image: resolved, source: 'variable' });
  }
  return out;
}

/**
 * 全仓收集镜像并拉取 manifest。
 *
 * @param {string} root - 仓库根
 * @param {{cacheFile?:string|null, log?:(msg:string)=>void, fetchImpl?:Function}} [opts]
 * @returns {Promise<{manifests:Map<string,object>, images:string[], unverified:string[]}>}
 */
export async function collectManifests(root, opts = {}) {
  const { cacheFile = null, log = () => {}, fetchImpl } = opts;

  // ── 1. 扫描全仓镜像 ────────────────────────────────────────────────────
  const appDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !['.github', 'scripts', '.git', 'node_modules', '.agent_cache', 'docs'].includes(n))
    .filter((n) => existsSync(join(root, n, 'data.yml')) || existsSync(join(root, n, 'docker-compose.yml')))
    .sort();

  /** @type {Map<string, object>} */
  const manifests = new Map();
  /** @type {Set<string>} */
  const imageSet = new Set();

  for (const app of appDirs) {
    const appAbs = join(root, app);
    for (const version of listVersionDirs(appAbs)) {
      const vAbs = join(appAbs, version);
      const composeAbs = join(vAbs, 'docker-compose.yml');
      if (!existsSync(composeAbs)) continue;

      let fields = [];
      const dataAbs = join(vAbs, 'data.yml');
      if (existsSync(dataAbs)) {
        try {
          const d = yaml.load(readFileSync(dataAbs, 'utf8'));
          fields = d?.additionalProperties?.formFields ?? d?.formFields ?? [];
        } catch { /* 结构问题由 lint 负责；此处只影响镜像解析 */ }
      }

      for (const { image, source } of extractImages(composeAbs, fields)) {
        if (source === 'unresolved') continue;
        imageSet.add(image);
      }
    }
  }

  const images = [...imageSet].sort();
  log(`manifest 采集：${images.length} 个去重镜像`);

  // ── 2. 磁盘缓存（跨 run 复用，防限流）────────────────────────────────
  let diskCache = {};
  if (cacheFile && existsSync(cacheFile)) {
    try { diskCache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { diskCache = {}; }
  }

  // ── 3. 并发拉取（内存缓存 + 磁盘缓存；失败不缓存）────────────────────
  // ⚠️ 并发与熔断（实测：Docker Hub 不可达时，串行拉 138 个镜像要 40 分钟）：
  //   · 并发 6（registry 内部还有全局闸门 4 + 单适配器闸门 4，这里只是不串行）
  //   · **熔断**：同一 registry 连续 N 次**网络级**失败（不是 401/404 那种逐镜像判定）
  //     → 判定该 registry 本轮不可达，剩余镜像直接标 UNVERIFIED 并写明原因。
  const CONCURRENCY = 6;
  const HOST_FAILURE_THRESHOLD = 3;
  const cache = createManifestCache({ ttlMs: 30 * 60 * 1000 });
  const results = new Map();
  let okCount = 0;
  /** @type {Map<string, number>} */
  const hostFailures = new Map();
  /** @type {Set<string>} */
  const deadHosts = new Set();

  /** 取镜像所属 registry 主机（用于熔断分组） */
  function hostOf(image) {
    const first = image.split('/')[0];
    return (image.includes('/') && first.includes('.')) ? first : 'docker.io';
  }
  /** 网络级失败（区别于 401/404 那种逐镜像判定） */
  function isNetworkFailure(reason) {
    return /请求失败|网络不可达|fetch failed|timeout|ECONN/i.test(String(reason ?? ''));
  }

  async function fetchOne(image) {
    const host = hostOf(image);
    if (deadHosts.has(host)) {
      return { status: 'unverified', reason: `registry ${host} 本轮不可达（连续网络失败已熔断），未查询` };
    }
    let res;
    try {
      res = await fetchManifest(image, { cache, fetchImpl, timeoutMs: 15000, retries: 1 });
    } catch (err) {
      res = { status: 'unverified', reason: `请求异常: ${err?.message ?? String(err)}` };
    }
    if (res.status !== 'ok' && isNetworkFailure(res.reason)) {
      const n = (hostFailures.get(host) ?? 0) + 1;
      hostFailures.set(host, n);
      if (n >= HOST_FAILURE_THRESHOLD) {
        deadHosts.add(host);
        log(`manifest: registry ${host} 连续 ${n} 次网络失败 → 本轮熔断（剩余镜像标记 UNVERIFIED）`);
      }
    }
    return res;
  }

  // 磁盘缓存只认「成功」的结果
  for (const image of images) {
    if (diskCache[image]?.status === 'ok') { results.set(image, diskCache[image]); okCount++; }
  }

  const pending = images.filter((i) => !results.has(i));
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const image = pending[cursor++];
      const res = await fetchOne(image);
      results.set(image, res);
      if (res.status === 'ok') { okCount++; diskCache[image] = res; }
      else { delete diskCache[image]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, () => worker()));

  if (cacheFile) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(diskCache, null, 2));
    } catch { /* 缓存写失败不影响主流程 */ }
  }

  const unverified = [...results.entries()].filter(([, r]) => r.status !== 'ok').map(([i]) => i);
  log(`manifest 采集完成：PASSED ${okCount} ｜ UNVERIFIED ${unverified.length}`);

  return { manifests: results, images, unverified };
}
