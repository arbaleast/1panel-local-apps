// .github/lib/image-policy.test.mjs
// 镜像 hardcode 策略回归测试。
//
// 锁死的不变量：
//   1. compose 里 `image:` 含 ${...} 的版本目录，必须落在例外清单内；
//   2. 例外清单与真实仓库现状一一对应（清单不腐化）；
//   3. AGENTS.md §6 的人类可读例外清单与代码常量一致（文档 ↔ 代码不脱节）。
//
// 回归背景：2026-11 hardcode 迁移漏掉 music-tag-web/2.8.1（bot 生成的变量型版本目录），
// 使「最新版反而是变量型」；当时没有任何检查在守这条规则。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  VARIABLE_IMAGE_EXCEPTIONS,
  findVariableImages,
  collectVariableImages,
  checkImagePolicy,
  parseDocumentedExceptions,
} from './image-policy.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('findVariableImages 只认 services.*.image 里的变量，其他 ${} 不误判', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: ghcr.io/foo/bar:${VERSION}',
    '    container_name: ${CONTAINER_NAME}',
    '    ports:',
    '      - "${PANEL_APP_PORT_HTTP}:8080"',
    '  sidecar:',
    '    image: ghcr.io/foo/sidecar:1.2.3',
    '',
  ].join('\n');
  const hits = findVariableImages(compose);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].service, 'web');
  assert.equal(hits[0].image, 'ghcr.io/foo/bar:${VERSION}');
});

test('findVariableImages 对非法 YAML 返回空数组（交给 lint 判定，不重复报错）', () => {
  assert.deepEqual(findVariableImages('services:\n  - [unclosed\n'), []);
});

test('全仓变量型镜像只出现在例外清单内（AGENTS.md §6）', () => {
  const found = collectVariableImages(ROOT);
  const keys = [...new Set(found.map((f) => `${f.app}/${f.versionDir}`))].sort();
  assert.deepEqual(
    keys,
    [...VARIABLE_IMAGE_EXCEPTIONS].sort(),
    `变量型镜像集合与例外清单不一致：实际 ${keys.join('、')}`,
  );
});

test('checkImagePolicy 对真实仓库无 error', () => {
  const { errors } = checkImagePolicy(ROOT);
  assert.deepEqual(errors, [], `镜像策略检查未通过：\n${errors.join('\n')}`);
});

test('checkImagePolicy 能抓出例外清单之外的变量型镜像（夹具）', () => {
  const fixture = join(tmpdir(), `image-policy-fixture-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'demo', '1.0.0'), { recursive: true });
    writeFileSync(
      join(fixture, 'demo', '1.0.0', 'docker-compose.yml'),
      'services:\n  demo:\n    image: ghcr.io/demo/app:${VERSION}\n',
      'utf8',
    );
    const { errors, found } = checkImagePolicy(fixture, []);
    assert.equal(found.length, 1);
    assert.equal(found[0].app, 'demo');
    assert.equal(found[0].versionDir, '1.0.0');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /demo\/1\.0\.0/);
    assert.match(errors[0], /hardcode/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('checkImagePolicy 能抓出例外清单腐化（条目已无变量型镜像）', () => {
  const fixture = join(tmpdir(), `image-policy-stale-${process.pid}`);
  try {
    mkdirSync(join(fixture, 'demo', '1.0.0'), { recursive: true });
    writeFileSync(
      join(fixture, 'demo', '1.0.0', 'docker-compose.yml'),
      'services:\n  demo:\n    image: ghcr.io/demo/app:1.0.0\n',
      'utf8',
    );
    const { errors } = checkImagePolicy(fixture, ['demo/1.0.0']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /清单腐化/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('AGENTS.md §6 的例外清单与代码常量一致（文档 ↔ 代码不脱节）', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const labels = parseDocumentedExceptions(agents);
  assert.ok(labels.length > 0, 'AGENTS.md §6 未找到「变量型例外」清单');

  // 文档标签可以写成应用名（该应用只有一个变量型版本目录）或精确的 <app>/<version>
  for (const label of labels) {
    const matched = VARIABLE_IMAGE_EXCEPTIONS.some(
      (key) => key === label || key.startsWith(`${label}/`),
    );
    assert.ok(matched, `AGENTS.md 中的例外 "${label}" 在代码例外清单中不存在`);
  }
  for (const key of VARIABLE_IMAGE_EXCEPTIONS) {
    const covered = labels.some((label) => key === label || key.startsWith(`${label}/`));
    assert.ok(covered, `代码例外 "${key}" 未在 AGENTS.md §6 中说明`);
  }
});
