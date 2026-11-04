/**
 * docs.test.mjs — 文档体系回归测试（lib 层，仅 node:test + fs）。
 *
 * 锁定的不变量：
 *   1. check-docs.mjs 在当前工作树上必须全绿（相对链接 / 锚点 / 代码栅栏 / router 行数）。
 *   2. package.json 中的 docs:check 命令与 bin/check-docs.mjs 一一对应。
 *   3. AGENTS.md router 行数受控，且路由索引覆盖 docs/ 全部手册（防「孤儿手册」）。
 *   4. AGENTS.md 作为路由器不得内嵌长篇细则（行数 + 「详见手册」结构）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_MAX_LINES = 200;

function runDocsCheck() {
  const r = spawnSync(process.execPath, [join('.github', 'bin', 'check-docs.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r;
}

test('check-docs.mjs 对当前文档树全绿（链接/锚点/栅栏/router 行数）', () => {
  const r = runDocsCheck();
  assert.equal(r.status, 0, `check-docs 退出码 ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PASSED/, `check-docs 输出缺少 PASSED：\n${r.stdout}`);
  // 不允许静默吞错
  assert.doesNotMatch(r.stdout, /\bERROR\b/, `check-docs 输出包含 ERROR：\n${r.stdout}`);
});

test('package.json 的 docs:check 脚本指向 bin/check-docs.mjs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const cmd = pkg.scripts && pkg.scripts['docs:check'];
  assert.ok(cmd, 'package.json 缺少 docs:check 脚本');
  const m = /node\s+(\S+)$/.exec(cmd);
  assert.ok(m, `docs:check 命令无法解析: ${cmd}`);
  const binPath = m[1].replace(/^\.\//, '');
  assert.ok(
    existsSync(join(ROOT, binPath)),
    `docs:check 指向的脚本不存在: ${binPath}`,
  );
  // package.json 中不存在未落地的幽灵命令（跳过 --test 等 node 自身 flag）
  for (const [name, script] of Object.entries(pkg.scripts)) {
    const tokens = script.split(/\s+/);
    const idx = tokens.indexOf('node');
    if (idx === -1) continue;
    const pathToken = tokens.slice(idx + 1).find((t) => !t.startsWith('-'));
    if (!pathToken) continue;
    // glob 型命令（如 node --test "lib/*.test.mjs"）不做存在性检查
    if (/[*?[]/.test(pathToken)) continue;
    assert.ok(
      existsSync(join(ROOT, pathToken.replace(/^\.\//, ''))),
      `scripts.${name} 指向不存在的脚本: ${script}`,
    );
  }
});

test('AGENTS.md 是受控行数的路由器，且路由覆盖 docs/ 全部手册', () => {
  const router = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const lines = router.split('\n');
  assert.ok(
    lines.length <= ROUTER_MAX_LINES,
    `AGENTS.md ${lines.length} 行超过 router 上限 ${ROUTER_MAX_LINES}`,
  );
  const docFiles = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
  assert.ok(docFiles.length >= 7, `docs/ 手册数量异常: ${docFiles.length}`);
  for (const f of docFiles) {
    assert.ok(
      router.includes(`docs/${f}`),
      `AGENTS.md 路由索引未覆盖 docs/${f}（成为孤儿手册）`,
    );
  }
  // router 必须给每个手册一个「主文档」指向，避免细节内嵌
  assert.match(
    router,
    /任务路由索引/,
    'AGENTS.md 缺少「任务路由索引」段',
  );
});
