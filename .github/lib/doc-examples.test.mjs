// .github/lib/doc-examples.test.mjs
// 文档中的 data.yml 示例 vs 真实 schema 一致性的回归测试。
//
// 锁死的不变量：
//   1. 仓库里所有文档示例都通过真实 schema 校验（示例不得与 lint 口径分叉）；
//   2. 校验器能抓出典型违规（type 枚举、formField type/rule 白名单、URL 协议）；
//   3. 示意性占位（`<app-key>`、`- ...`、`https://...`）不误报——文档示例本就是占位。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  extractCodeBlocks,
  isDataYmlLike,
  validateDataYmlExample,
  checkDocExamples,
} from './doc-examples.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('extractCodeBlocks 抽取围栏块并记录起始行号', () => {
  const md = ['# t', '', '```yaml', 'a: 1', '```', '', '```js', 'x', '```', ''].join('\n');
  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lang, 'yaml');
  assert.equal(blocks[0].content.trim(), 'a: 1');
  assert.equal(blocks[0].startLine, 3);
  assert.equal(blocks[1].lang, 'js');
});

test('isDataYmlLike 只认含 additionalProperties 的对象', () => {
  assert.equal(isDataYmlLike({ additionalProperties: { key: 'x' } }), true);
  assert.equal(isDataYmlLike({ services: {} }), false);
  assert.equal(isDataYmlLike(null), false);
  assert.equal(isDataYmlLike([1, 2]), false);
});

test('合法示例（含占位符）不报错', () => {
  const obj = {
    additionalProperties: {
      key: '<app-key>',
      name: '<app-key> <version>',
      type: 'tool',
      formFields: [{ type: 'text', default: 'x', label: { en: 'X' } }, '...'],
      website: 'https://...',
    },
  };
  assert.deepEqual(validateDataYmlExample(obj, 'demo.md:1'), []);
});

test('示例写错 type 枚举 → 报错', () => {
  const obj = { additionalProperties: { key: 'demo', name: 'demo', type: 'photo' } };
  const errs = validateDataYmlExample(obj, 'demo.md:1');
  assert.equal(errs.length, 1);
  assert.match(errs[0], /type = "photo"/);
});

test('示例缺必填字段 → 报错', () => {
  const obj = { additionalProperties: { name: 'demo' } };
  const errs = validateDataYmlExample(obj, 'demo.md:1');
  assert.ok(errs.some((e) => /缺少必填字段 `key`/.test(e)));
  assert.ok(errs.some((e) => /缺少必填字段 `type`/.test(e)));
});

test('示例 formField 用非法 type / rule → 报错（与 lint 同一套白名单）', () => {
  const obj = {
    additionalProperties: {
      key: 'demo',
      name: 'demo',
      type: 'tool',
      formFields: [{ type: 'boolean', rule: 'paramHttp', default: 'x', label: { en: 'X' } }],
    },
  };
  const errs = validateDataYmlExample(obj, 'demo.md:1');
  assert.ok(errs.some((e) => /type="boolean" 不在白名单/.test(e)));
  assert.ok(errs.some((e) => /rule="paramHttp" 不在白名单/.test(e)));
});

test('示例 URL 协议非法 → 报错', () => {
  const obj = {
    additionalProperties: {
      key: 'demo',
      name: 'demo',
      type: 'tool',
      website: 'ftp://example.com',
    },
  };
  const errs = validateDataYmlExample(obj, 'demo.md:1');
  assert.ok(errs.some((e) => /website/.test(e)));
});

test('仓库里所有文档示例都通过真实 schema 校验', () => {
  const files = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'README.md',
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => join('docs', f)),
  ];
  const { errors, checked } = checkDocExamples(ROOT, files);
  assert.deepEqual(errors, [], `文档示例与 schema 不一致：\n${errors.join('\n')}`);
  // 不能是空转：仓库里确实存在 data.yml 示例
  assert.ok(checked >= 2, `检出的 data.yml 示例过少（${checked}），检查可能空转`);
});

test('示例块 YAML 语法错误 → 报错而非崩溃', () => {
  const fixture = join(tmpdir(), `doc-examples-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'docs'), { recursive: true });
    writeFileSync(
      join(fixture, 'docs', 'bad.md'),
      '# bad\n\n```yaml\nadditionalProperties:\n  key: [unclosed\n```\n',
      'utf8',
    );
    const { errors } = checkDocExamples(fixture, [join('docs', 'bad.md')]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /示例 YAML 解析失败/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
