#!/usr/bin/env node
/**
 * check-docs.mjs — 文档质量校验（bin 层，无新增第三方依赖）。
 *
 * 校验范围（仓库根 README/AGENTS/CONTRIBUTING + docs/*.md）：
 *   1. 相对路径链接的目标文件必须存在；
 *   2. 带锚点（#fragment）的内部链接，锚点必须能在目标文件标题中匹配
 *      （GitHub slug 规则的宽容版：忽略大小写与标点差异）；
 *   3. Markdown 代码栅栏（```）必须成对闭合；
 *   4. router 文件 AGENTS.md 行数上限（可被 --max-lines 覆盖，默认 200）；
 *   5. docs/ 下不足 MIN_LINES 行的文档给出警告（防碎片化：应并入相邻主题文档）。
 *
 * 退出码：存在 error → 1；仅有 warning → 0（打印 PASSED (with warnings)）。
 * 不校验外链（http/https/mailto/data）与纯文本引用。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER = 'AGENTS.md';
const ROUTER_MAX_LINES_DEFAULT = 200;
const DOC_MIN_LINES = 40;

const errors = [];
const warnings = [];

function collectMarkdownFiles() {
  const files = [ROUTER, 'CONTRIBUTING.md', 'README.md'];
  for (const name of readdirSync(join(ROOT, 'docs'))) {
    if (name.endsWith('.md')) files.push(join('docs', name));
  }
  return files.filter((f) => existsSync(join(ROOT, f)));
}

/** GitHub 风格 slug 的宽容版：小写、去标点（保留字母数字与 CJK）、空白折叠为 -。 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function headingsOf(absPath) {
  const out = [];
  for (const line of readFileSync(absPath, 'utf8').split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push(slugify(m[2]));
  }
  return out;
}

function checkLink(fromFile, target, label, lineNo) {
  if (/^(https?:|mailto:|data:)/i.test(target)) return;
  // editor 风格 file:line（及 file:start-end）不算链接目标，去掉行号后缀再解析
  const hashIdx = target.indexOf('#');
  let pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? '' : decodeURIComponent(target.slice(hashIdx + 1));
  const lineMatch = /^(.+?):\d+(?:-\d+)?$/.exec(pathPart);
  if (lineMatch) {
    pathPart = lineMatch[1];
    warnings.push(
      `${fromFile}:${lineNo} 行号式链接已按纯路径解析: ${target} → ${pathPart}（GitHub 链接不渲染 :line）`,
    );
  }
  const abs = join(ROOT, dirname(fromFile), pathPart);
  if (!existsSync(abs)) {
    errors.push(`${fromFile}:${lineNo} 链接目标不存在: ${base}（"${label}"）`);
    return;
  }
  try {
    if (statSync(abs).isDirectory()) return;
  } catch {
    return;
  }
  if (!anchor) return;
  const slugs = headingsOf(abs);
  if (slugs.includes(anchor)) return;
  const compact = (s) => s.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '');
  if (slugs.some((s) => compact(s) === compact(anchor))) return;
  errors.push(
    `${fromFile}:${lineNo} 锚点在目标文件中找不到: ${base}（标题候选: ${slugs.slice(0, 6).join(' | ')}…）`,
  );
}

function checkFile(file, maxRouterLines) {
  const abs = join(ROOT, file);
  const text = readFileSync(abs, 'utf8');
  const lines = text.split('\n');

  // 1/2. 相对链接与锚点
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(linkRe)) {
      const [, label, target] = m;
      const clean = target.replace(/^<|>$/g, '');
      checkLink(file, clean, label, i + 1);
    }
  });

  // 3. 代码栅栏闭合
  const fenceCount = lines.filter((l) => /^\s*```/.test(l)).length;
  if (fenceCount % 2 !== 0) {
    errors.push(`${file}: 代码栅栏不闭合（\`\`\` 出现 ${fenceCount} 次，应为偶数）`);
  }

  // 4. router 行数上限
  if (file === ROUTER && lines.length > maxRouterLines) {
    errors.push(
      `${file}: ${lines.length} 行，超过 router 上限 ${maxRouterLines}（细节必须下沉到 docs/）`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const maxArg = args.indexOf('--max-lines');
  const maxRouterLines =
    maxArg !== -1 ? Number(args[maxArg + 1]) || ROUTER_MAX_LINES_DEFAULT : ROUTER_MAX_LINES_DEFAULT;

  const files = collectMarkdownFiles();
  for (const file of files) checkFile(file, maxRouterLines);

  // 5. 防碎片化：docs/ 下过短的文档警告
  for (const file of files) {
    if (!file.startsWith('docs/')) continue;
    const n = readFileSync(join(ROOT, file), 'utf8').split('\n').length;
    if (n < DOC_MIN_LINES) {
      warnings.push(`${file}: 仅 ${n} 行（<${DOC_MIN_LINES}），应并入相邻主题文档（防碎片化）`);
    }
  }

  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(
    errors.length
      ? `FAILED: ${errors.length} error, ${warnings.length} warning`
      : warnings.length
        ? `PASSED (with warnings): ${warnings.length} warning`
        : 'PASSED',
  );
  process.exitCode = errors.length ? 1 : 0;
}

main();
