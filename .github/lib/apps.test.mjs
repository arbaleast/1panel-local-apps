// lib/apps.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SKIP_DIRS, listApps, getAppMeta, getCurrentVersion } from './apps.mjs';

describe('apps', () => {
  let tmpRoot;

  beforeEach(() => {
    // 在临时目录创建测试结构
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-test-'));
  });

  afterEach(() => {
    // teardown：删除临时目录
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 1. 嵌套应用：<root>/anythingllm/pg/... → 含 'anythingllm/pg'
  it('discovers nested app via alias table', () => {
    const aliasByDir = new Map([
      ['localanythingllm', { dir: 'anythingllm/pg', name: 'AnythingLLM', description: 'PG' }],
    ]);
    // 建立嵌套目录结构
    fs.mkdirSync(path.join(tmpRoot, 'anythingllm', 'pg'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'anythingllm', 'pg', 'docker-compose.yml'), 'version: "3.8"');
    fs.writeFileSync(path.join(tmpRoot, 'anythingllm', 'pg', 'data.yml'), 'additionalProperties:\n  key: pg\n');

    const apps = listApps(tmpRoot, aliasByDir);
    const dirs = apps.map(a => a.dir);
    assert.ok(dirs.includes('anythingllm/pg'), `Expected 'anythingllm/pg' in ${JSON.stringify(dirs)}`);
  });

  // 2. 跳过 SKIP_DIRS
  it('skips .github, scripts, node_modules and other forbidden dirs', () => {
    for (const skip of SKIP_DIRS) {
      fs.mkdirSync(path.join(tmpRoot, skip), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, skip, 'docker-compose.yml'), 'version: "3.8"');
    }

    const apps = listApps(tmpRoot);
    const dirs = apps.map(a => a.dir);
    for (const skip of SKIP_DIRS) {
      assert.ok(!dirs.includes(skip), `SKIP_DIR ${skip} should not appear in ${JSON.stringify(dirs)}`);
    }
  });

  // 3. additionalProperties.key === dirName 一致性；不一致 → null
  it('getAppMeta returns null when key does not match dirName', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'data.yml'),
      'additionalProperties:\n  key: different-name\n');

    const result = getAppMeta(tmpRoot, 'myapp');
    assert.equal(result, null);
  });

  // 4. getCurrentVersion 多版本取最大
  it('getCurrentVersion picks highest version from multiple candidates', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.0.0'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v2.0.0'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.5.0'), { recursive: true });
    for (const v of ['v1.0.0', 'v2.0.0', 'v1.5.0']) {
      fs.writeFileSync(path.join(tmpRoot, 'myapp', v, 'data.yml'), `additionalProperties:\n  key: ${v}`);
    }

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'v2.0.0');
  });

  // 5. getCurrentVersion 跳 latest
  it('getCurrentVersion skips latest/ directory', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'latest'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'latest', 'data.yml'), 'additionalProperties:\n  key: latest');
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'v1.0.0', 'data.yml'), 'additionalProperties:\n  key: v1.0.0');

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'v1.0.0');
  });

  // 6. getCurrentVersion 只有 latest 时回退 'latest'
  it('getCurrentVersion falls back to latest when no version dirs exist', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'latest'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'latest', 'data.yml'), 'additionalProperties:\n  key: latest');
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'data'), { recursive: true });

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'latest');
  });

  // 7. getCurrentVersion 跳 data / scripts 子目录
  it('getCurrentVersion skips data and scripts subdirectories', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'v1.0.0', 'data.yml'), 'additionalProperties:\n  key: v1.0.0');

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'v1.0.0');
  });

  // 8. getCurrentVersion 版本目录无 data.yml（只有 compose）→ 仍算
  it('getCurrentVersion counts dir with only docker-compose.yml', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.0.0'), { recursive: true });
    // 只有 docker-compose.yml，无 data.yml
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'v1.0.0', 'docker-compose.yml'), 'version: "3.8"');

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'v1.0.0');
  });

  // 9. listApps 别名表 dir 嵌套补全
  it('listApps resolves nested alias dir that does not appear as top-level', () => {
    const aliasByDir = new Map([
      ['localnested', { dir: 'deep/nested/app', name: 'Nested App', description: 'Test' }],
    ]);
    // 顶层无 deep 目录
    fs.mkdirSync(path.join(tmpRoot, 'deep', 'nested', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'deep', 'nested', 'app', 'docker-compose.yml'), 'version: "3.8"');
    fs.writeFileSync(path.join(tmpRoot, 'deep', 'nested', 'app', 'data.yml'), 'additionalProperties:\n  key: app\n');

    const apps = listApps(tmpRoot, aliasByDir);
    const dirs = apps.map(a => a.dir);
    assert.ok(dirs.includes('deep/nested/app'), `Expected 'deep/nested/app' in ${JSON.stringify(dirs)}`);
  });

  // 10. listApps 别名表 dir 路径不存在 → 跳过
  it('listApps skips alias whose dir path does not exist', () => {
    const aliasByDir = new Map([
      ['localghost', { dir: 'nonexistent/app', name: 'Ghost', description: 'Missing' }],
    ]);

    const apps = listApps(tmpRoot, aliasByDir);
    const dirs = apps.map(a => a.dir);
    assert.ok(!dirs.includes('nonexistent/app'), `Should not include nonexistent path: ${JSON.stringify(dirs)}`);
  });

  // 11. getCurrentVersion 跳过隐藏目录（.docs / .scripts 等），避免被误识别为版本
  it('getCurrentVersion skips hidden directories starting with dot', () => {
    fs.mkdirSync(path.join(tmpRoot, 'myapp', 'v1.0.0'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', '.docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'myapp', '.scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'myapp', 'v1.0.0', 'data.yml'), 'additionalProperties:\n  key: v1.0.0');
    fs.writeFileSync(path.join(tmpRoot, 'myapp', '.docs', 'README.md'), '# Docs');
    fs.writeFileSync(path.join(tmpRoot, 'myapp', '.scripts', 'build.sh'), '#!/bin/bash');

    const ver = getCurrentVersion(tmpRoot, 'myapp');
    assert.equal(ver, 'v1.0.0', `Expected v1.0.0 but got ${ver}; hidden dirs should be skipped`);
  });
});
