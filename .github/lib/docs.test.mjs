/**
 * docs.test.mjs — 文档体系回归测试（lib 层，仅 node:test + fs）。
 *
 * 锁定的不变量：
 *   1. check-docs.mjs 在当前工作树上必须全绿（相对链接 / 锚点 / 代码栅栏 / router 行数）。
 *   2. package.json 中的 docs:check 命令与 bin/check-docs.mjs 一一对应。
 *   3. AGENTS.md router 行数受控，且路由索引覆盖 docs/ 全部手册（防「孤儿手册」）。
 *   4. AGENTS.md 作为路由器不得内嵌长篇细则（行数 + 「详见手册」结构）。
 *   5. 死链分支必须「报 ERROR 退出 1」而不是抛未捕获异常（回归：base 未定义导致 CI 崩）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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

test('应用根 README 也纳入校验范围（全仓文档无死链）', () => {
  // 回归：应用 README 曾有 21 处死链（bookorbit / infinity / marginalia / silo），
  // 因为不在扫描范围内而长期无人发现。
  const apps = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'docs')
    .filter((e) => e.name !== 'node_modules' && e.name !== 'scripts')
    .filter((e) => existsSync(join(ROOT, e.name, 'README.md')));
  assert.ok(apps.length >= 50, `应用 README 数量异常: ${apps.length}`);

  for (const app of apps) {
    const file = join(app.name, 'README.md');
    const text = readFileSync(join(ROOT, file), 'utf8');
    const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const m of text.matchAll(linkRe)) {
      const target = m[2].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|data:|#)/i.test(target)) continue;
      const pathPart = target.split('#')[0];
      if (!pathPart) continue;
      assert.ok(
        existsSync(join(ROOT, app.name, pathPart)),
        `${file}: 死链 ${target}（目标不存在）`,
      );
    }
  }
});

test('check-docs.mjs 报出幽灵 npm 脚本（文档引用了不存在的仓库脚本）', () => {
  const fixture = join(tmpdir(), `check-docs-ghost-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    writeFileSync(join(fixture, 'AGENTS.md'), '# router\n', 'utf8');
    writeFileSync(join(fixture, 'CONTRIBUTING.md'), '# c\n', 'utf8');
    writeFileSync(join(fixture, 'README.md'), '跑 `npm run not-a-real-script`\n', 'utf8');
    writeFileSync(join(fixture, 'docs', 'a.md'), '# a\n', 'utf8');
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
      'utf8',
    );

    const r = spawnSync(
      process.execPath,
      [join(ROOT, '.github', 'bin', 'check-docs.mjs'), '--root', fixture],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(r.status, 1, `幽灵脚本应退出 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /not-a-real-script/, `应指出幽灵脚本：\n${r.stdout}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('应用 README 里的容器内 npm 命令不误报（仓库脚本检查只覆盖仓库级文档）', () => {
  const fixture = join(tmpdir(), `check-docs-appnpm-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    mkdirSync(join(fixture, 'demo'), { recursive: true });
    writeFileSync(join(fixture, 'AGENTS.md'), '# router\n', 'utf8');
    writeFileSync(join(fixture, 'CONTRIBUTING.md'), '# c\n', 'utf8');
    writeFileSync(join(fixture, 'README.md'), '# r\n', 'utf8');
    writeFileSync(join(fixture, 'docs', 'a.md'), '# a\n', 'utf8');
    // 应用 README 描述的是容器内应用自己的 package.json
    writeFileSync(join(fixture, 'demo', 'README.md'), '容器内跑 `npm run restore`\n', 'utf8');
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
      'utf8',
    );

    const r = spawnSync(
      process.execPath,
      [join(ROOT, '.github', 'bin', 'check-docs.mjs'), '--root', fixture],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(r.status, 0, `应用 README 的容器内命令不应报错：\n${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('check-docs.mjs 遇到死链时报告 ERROR 并退出 1（不得抛未捕获异常）', () => {
  const fixture = join(tmpdir(), `check-docs-fixture-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    writeFileSync(join(fixture, 'AGENTS.md'), '# router\n\n- [缺失目标](missing.md)\n', 'utf8');
    writeFileSync(join(fixture, 'CONTRIBUTING.md'), '# contributing\n', 'utf8');
    writeFileSync(join(fixture, 'README.md'), '# readme\n', 'utf8');
    writeFileSync(join(fixture, 'docs', 'a.md'), '# a\n', 'utf8');

    const r = spawnSync(
      process.execPath,
      [join(ROOT, '.github', 'bin', 'check-docs.mjs'), '--root', fixture],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(r.status, 1, `死链应退出 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ERROR/, `应输出 ERROR：\n${r.stdout}`);
    assert.match(r.stdout, /missing\.md/, `ERROR 应指出缺失目标：\n${r.stdout}`);
    // 关键回归：不得出现未捕获异常（如 ReferenceError: base is not defined）
    assert.doesNotMatch(
      r.stderr,
      /ReferenceError|TypeError|is not defined/,
      `死链分支不得崩溃：\n${r.stderr}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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
