// lib/version-writer.mjs — 新版本目录的**原子生成**（Staging → Validation → Commit）
//
// ── 为什么有这个模块 ─────────────────────────────────────────────────────
// 审计 P1-4/P1-5/P1-6/P1-8：旧实现（scripts/detect-updates.mjs 的 applyChanges）
// 直接把新版本目录 cpSync 进**正式仓库树**，随后逐个 writeFileSync 覆盖
// compose / data.yml：
//     fs.rmSync(dst, { recursive: true, force: true });  // ← 裸递归删正式目录
//     fs.cpSync(src, dst, { recursive: true });           // ← 直写正式树（非原子）
//     fs.writeFileSync(filePath, change.content);         // ← 逐文件写
// 后果（三个真实故障模式）：
//   1. cpSync 中途失败 → 仓库树留下**半写版本目录**（缺 data/、scripts/init.sh），
//      后续 `git add` 会把它提交进批次 PR。
//   2. rmSync 无 allowlist、无身份复核 → 一旦守卫被绕过，**既有历史版本目录被整目录删除**。
//   3. 校验发生在落树**之后**（workflow 的 npm run lint），坏内容先进树、先进远端分支。
//
// ── staging 布局 ─────────────────────────────────────────────────────────
//   <repoRoot>/.staging/<app>/data.yml            ← 应用根 data.yml 的副本（供 lint 扫描）
//   <repoRoot>/.staging/<app>/<toDir>/…           ← 待提交的新版本目录
// 选这个布局而不是 `<app>/.staging-xxx/` 的原因：
//   · lint-apps.mjs 只认「root/<应用目录>/<版本目录>」结构，staging 必须**长得像一个应用**
//     才能被 SSOT 校验器扫到（否则 listApps 扫到 0 个应用 → 假绿）。
//   · staging 与正式目录同在仓库根 → 同一文件系统 → `renameSync` 是原子操作。
//   · `.staging` 以点开头 → 不会被任何版本目录扫描器当成版本目录；已加入 .gitignore。
//
// ── 本模块的契约 ─────────────────────────────────────────────────────────
//   · 生成一律在受控 staging 目录完成，正式目录在校验通过前**零改动**。
//   · 正式目录已存在时**永不删除、永不覆盖**：
//       - 内容完全一致 → 幂等跳过（IDEMPOTENT）
//       - 内容不一致   → 冲突拦截（CONFLICT）
//   · 失败清理**只删本次创建的 staging 目录**（路径必须落在 `.staging` 之内）。
//
// 分层：lib 层只用 node:fs / node:path，零第三方依赖（CONTRIBUTING §4）。
// SSOT 校验（lint-apps.mjs）由调用方在 staging 目录上执行，本模块不做规则判断。

import fs from 'node:fs';
import path from 'node:path';

/** staging 根目录名（点前缀 → 不会被版本目录扫描器识别；已 gitignore） */
export const STAGING_ROOT_NAME = '.staging';

/** 目标版本目录的处置方式 */
export const TARGET_CREATE = 'CREATE';          // 目标不存在 → 新建
export const TARGET_UPDATE = 'UPDATE';          // 同名目录 → 就地更新受管文件
export const TARGET_IDEMPOTENT = 'IDEMPOTENT';  // 目标已存在且内容一致 → 幂等跳过
export const TARGET_CONFLICT = 'CONFLICT';      // 目标已存在且内容不同 → 拦截

/**
 * 判断一个路径是否落在 staging 根目录之内（清理前的安全护栏）
 * @param {string} target
 * @param {string} stagingRoot
 * @returns {boolean}
 */
export function isInsideStagingRoot(target, stagingRoot) {
  if (!target || typeof target !== 'string' || !stagingRoot) return false;
  const rel = path.relative(path.resolve(stagingRoot), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 生成 staging 根目录路径
 * @param {string} root 仓库根
 * @returns {string}
 */
export function stagingRootPath(root) {
  return path.join(root, STAGING_ROOT_NAME);
}

/**
 * 判定目标版本目录的处置方式（纯函数，便于单测）
 *
 * 规则（按目标 §四.1 / §四.2）：
 *   - 目标不存在                      → CREATE（新建）
 *   - 目标存在且**同名**（更新当前版本目录的受管文件） → UPDATE
 *   - 目标存在且与产物**完全一致**     → IDEMPOTENT（幂等跳过，不报错）
 *   - 目标存在且内容不同              → CONFLICT（报错拦截，**禁止覆盖**）
 *
 * @param {{toDir: string, exists: boolean, sameName?: boolean, identical?: boolean}} params
 * @returns {{action: string, reason: string}}
 */
export function resolveVersionTarget({ toDir, exists, sameName = false, identical = false }) {
  if (!exists) {
    return { action: TARGET_CREATE, reason: 'target-not-exists' };
  }
  if (sameName) {
    return { action: TARGET_UPDATE, reason: 'same-version-dir' };
  }
  if (identical) {
    return { action: TARGET_IDEMPOTENT, reason: 'already-exists-identical' };
  }
  return { action: TARGET_CONFLICT, reason: 'already-exists-conflict' };
}

/**
 * 列出目录下所有文件（相对路径，排序）
 * @param {string} dir
 * @returns {string[]}
 */
export function listFilesRecursive(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        walk(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk('');
  return out.sort();
}

/**
 * 比较两个目录树是否**完全一致**（文件集合 + 每个文件内容）
 *
 * 用于「目标目录已存在」的幂等判定：一致 → 幂等跳过；不一致 → 冲突拦截。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isIdenticalDir(a, b) {
  const fa = listFilesRecursive(a);
  const fb = listFilesRecursive(b);
  if (fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] !== fb[i]) return false;
    let ba;
    let bb;
    try {
      ba = fs.readFileSync(path.join(a, fa[i]));
      bb = fs.readFileSync(path.join(b, fb[i]));
    } catch {
      return false;
    }
    if (!ba.equals(bb)) return false;
  }
  return true;
}

/**
 * 在 staging 目录中生成新版本目录的内容
 *
 * 流程：复制来源版本目录 → 写入受管文件（compose / data.yml）→ 复制应用根 data.yml
 * （让 lint 能把 staging 当成一个完整应用扫描）→ 返回 staging 路径。
 * **正式目录不被触碰。**
 *
 * @param {{root: string, app: string, fromDir: string, toDir: string,
 *          files?: Array<{file: string, content: string}>,
 *          stagingRoot?: string}} params
 * @returns {{staging: string, stagingAppDir: string, stagingRoot: string,
 *            dst: string, src: string, files: string[]}}
 * @throws {Error} 来源目录不存在 / staging 创建失败
 */
export function stageVersionDir({ root, app, fromDir, toDir, files = [], stagingRoot }) {
  const appDir = path.join(root, app);
  const src = path.join(appDir, fromDir);
  const dst = path.join(appDir, toDir);
  const sRoot = stagingRoot || stagingRootPath(root);
  const stagingAppDir = path.join(sRoot, app);
  const staging = path.join(stagingAppDir, toDir);

  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`来源版本目录不存在: ${path.join(app, fromDir)}`);
  }

  // 清掉上一次可能残留的同名 staging（异常中断后的自愈）
  cleanupStagingDir({ stagingRoot: sRoot, app, toDir });

  fs.mkdirSync(stagingAppDir, { recursive: true });
  try {
    fs.cpSync(src, staging, { recursive: true });
    // 应用根 data.yml 副本：让 SSOT 校验器能把 staging 当成完整应用扫描
    const rootData = path.join(appDir, 'data.yml');
    if (fs.existsSync(rootData)) {
      fs.copyFileSync(rootData, path.join(stagingAppDir, 'data.yml'));
    }
  } catch (e) {
    cleanupStagingDir({ stagingRoot: sRoot, app, toDir });
    throw e;
  }

  const written = [];
  try {
    for (const f of files) {
      if (!f || typeof f.file !== 'string') continue;
      const target = path.join(staging, f.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content, 'utf8');
      written.push(f.file);
    }
  } catch (e) {
    cleanupStagingDir({ stagingRoot: sRoot, app, toDir });
    throw e;
  }

  return { staging, stagingAppDir, stagingRoot: sRoot, dst, src, files: written };
}

/**
 * 把 staging 目录**原子提交**到正式版本目录
 *
 * - CREATE：`renameSync(staging, dst)`（同文件系统 → 原子）。dst 必须不存在。
 * - UPDATE（同名目录）：只把**受管文件**从 staging 原子替换到正式目录；
 *   正式目录的其余文件（data/、scripts/）**保持不动**。
 *   替换前先把原文件备份到 staging 内 `.backup/`，失败时回滚。
 * - IDEMPOTENT / CONFLICT：不动正式目录，由调用方决定后续。
 *
 * @param {{staging: string, dst: string, action: string, files?: string[]}} params
 * @returns {{committed: boolean, replaced: string[]}}
 * @throws {Error} 提交失败（调用方负责清理 staging）
 */
export function commitStagingDir({ staging, dst, action, files = [] }) {
  if (action === TARGET_CREATE) {
    if (fs.existsSync(dst)) {
      throw new Error(`目标版本目录已存在，拒绝覆盖: ${dst}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(staging, dst);
    return { committed: true, replaced: [] };
  }

  if (action === TARGET_UPDATE) {
    const backupDir = path.join(staging, '.backup');
    const replaced = [];
    const backups = [];
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      for (const rel of files) {
        const live = path.join(dst, rel);
        if (!fs.existsSync(live)) continue;
        const backup = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(live, backup);
        backups.push({ live, backup });
      }
      // 先全部写好临时文件，再逐个 rename（每个 rename 原子）
      const temps = [];
      for (const rel of files) {
        const staged = path.join(staging, rel);
        if (!fs.existsSync(staged)) continue;
        const tmp = path.join(dst, `.${path.basename(rel)}.tmp-${process.pid}`);
        fs.copyFileSync(staged, tmp);
        temps.push({ tmp, live: path.join(dst, rel) });
      }
      for (const t of temps) {
        fs.renameSync(t.tmp, t.live);
      }
      for (const t of temps) replaced.push(path.relative(dst, t.live));
      return { committed: true, replaced };
    } catch (e) {
      // 回滚：把备份写回原位
      for (const b of backups) {
        try {
          fs.copyFileSync(b.backup, b.live);
        } catch {
          /* 回滚失败：保留原异常，调用方会保留 staging 供诊断 */
        }
      }
      throw e;
    }
  }

  return { committed: false, replaced: [] };
}

/**
 * 清理 staging 目录 —— **只允许**删除 `.staging` 根目录之内的内容
 *
 * 安全护栏：目标路径必须落在 stagingRoot 之内（`isInsideStagingRoot`）。
 * 绝不会删除用户已有文件或存量版本目录。
 *
 * 清理范围是**整个** `<stagingRoot>/<app>/`（含版本目录副本与应用根 data.yml 副本）——
 * 该目录里的内容全部由本模块创建，不存在需要保留的东西。
 *
 * @param {{stagingRoot: string, app: string, toDir?: string}} params
 * @returns {boolean} 是否真的删除了
 */
export function cleanupStagingDir({ stagingRoot, app, toDir }) {
  if (!stagingRoot || !app) return false;
  const appDir = path.join(stagingRoot, app);
  if (!isInsideStagingRoot(appDir, stagingRoot)) return false;
  if (toDir) {
    const target = path.join(appDir, toDir);
    if (!isInsideStagingRoot(target, stagingRoot)) return false;
  }
  try {
    if (!fs.existsSync(appDir)) return false;
    fs.rmSync(appDir, { recursive: true, force: true });
    // `.staging` 根目录空了也一并清掉（**不删**仓库其它内容）
    try {
      if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) {
        fs.rmdirSync(stagingRoot);
      }
    } catch {
      /* 非致命 */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理仓库里**所有**残留 staging（异常中断后的自愈）
 *
 * 只删 `.staging` 根目录内的内容。
 *
 * @param {string} root 仓库根
 * @returns {string[]} 被清理的相对路径
 */
export function cleanupStaleStaging(root) {
  const sRoot = stagingRootPath(root);
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(sRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (cleanupStagingDir({ stagingRoot: sRoot, app: e.name })) {
      removed.push(e.name);
    }
  }
  return removed;
}
