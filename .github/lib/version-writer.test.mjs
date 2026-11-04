// .github/lib/version-writer.test.mjs
// 锁死「版本目录原子生成」（Staging → Validation → Commit）的行为契约。
//
// 对应目标 §四：
//   §四.1 历史版本不可变 —— 正式版本目录**永不**被删除 / 覆盖
//   §四.2 前置存在性检查与幂等 —— 一致 → IDEMPOTENT；不一致 → CONFLICT（拦截）
//   §四.3 临时目录原子写入 —— staging → 校验 → rename
//   §四.4 安全回滚 —— 只清本次 staging，绝不碰用户已有文件 / 存量版本目录
//   §四.5 独立性 —— 新版本目录生成不影响旧版本目录
//
// 测试全部在 .agent_cache/（已 gitignore）下的临时目录里跑，
// 不触碰仓库真实应用目录，也**不触网**。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TARGET_CREATE,
  TARGET_UPDATE,
  TARGET_IDEMPOTENT,
  TARGET_CONFLICT,
  STAGING_ROOT_NAME,
  cleanupStagingDir,
  cleanupStaleStaging,
  commitStagingDir,
  isIdenticalDir,
  isInsideStagingRoot,
  resolveVersionTarget,
  stageVersionDir,
  stagingRootPath,
} from './version-writer.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TMP_BASE = path.join(ROOT, '.agent_cache', 'vw-test');

/** 建一个最小应用：<root>/<app>/<version>/{data.yml,docker-compose.yml} */
function makeApp(root, app, version, compose = 'image: nginx:1.0\n') {
  const dir = path.join(root, app, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.yml'), 'additionalProperties:\n  key: x\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(root, app, 'data.yml'), 'additionalProperties:\n  key: x\n');
  return dir;
}

let tmp = null;

before(() => {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  tmp = fs.mkdtempSync(path.join(TMP_BASE, 'root-'));
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('resolveVersionTarget（目标处置判定，纯函数）', () => {
  it('目标不存在 → CREATE', () => {
    const r = resolveVersionTarget({ toDir: 'v2', exists: false });
    assert.equal(r.action, TARGET_CREATE);
    assert.equal(r.reason, 'target-not-exists');
  });

  it('目标存在且同名 → UPDATE（就地更新受管文件）', () => {
    const r = resolveVersionTarget({ toDir: 'v2', exists: true, sameName: true });
    assert.equal(r.action, TARGET_UPDATE);
  });

  it('目标存在且内容一致 → IDEMPOTENT（幂等跳过，不报错）', () => {
    const r = resolveVersionTarget({ toDir: 'v2', exists: true, identical: true });
    assert.equal(r.action, TARGET_IDEMPOTENT);
    assert.equal(r.reason, 'already-exists-identical');
  });

  it('目标存在且内容不同 → CONFLICT（拦截，绝不覆盖）', () => {
    const r = resolveVersionTarget({ toDir: 'v2', exists: true, identical: false });
    assert.equal(r.action, TARGET_CONFLICT);
    assert.equal(r.reason, 'already-exists-conflict');
  });
});

describe('isInsideStagingRoot（删除安全护栏）', () => {
  it('staging 之内 → true', () => {
    const s = path.join('/tmp/x', '.staging');
    assert.equal(isInsideStagingRoot(path.join(s, 'app', 'v1'), s), true);
  });

  it('staging 之外 → false', () => {
    const s = path.join('/tmp/x', '.staging');
    assert.equal(isInsideStagingRoot('/tmp/x/app/v1', s), false);
    assert.equal(isInsideStagingRoot(path.join(s, '..', 'app'), s), false);
  });
});

describe('stageVersionDir（staging 生成）', () => {
  it('在 .staging 下生成新版本目录，且**不触碰**正式目录', () => {
    const root = path.join(tmp, 'stage-basic');
    makeApp(root, 'demo', 'v1.0.0');
    const dst = path.join(root, 'demo', 'v2.0.0');

    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v2.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' }],
    });

    assert.equal(staged.dst, dst);
    assert.ok(staged.staging.includes(path.join(STAGING_ROOT_NAME, 'demo', 'v2.0.0')));
    // staging 内容正确
    assert.equal(
      fs.readFileSync(path.join(staged.staging, 'docker-compose.yml'), 'utf8'),
      'image: nginx:2.0.0\n',
    );
    // 应用根 data.yml 副本存在（让 SSOT 校验器能把 staging 当完整应用扫）
    assert.ok(fs.existsSync(path.join(staged.stagingAppDir, 'data.yml')));
    // **正式目录尚未被创建** —— 校验通过前零污染
    assert.equal(fs.existsSync(dst), false);
  });

  it('来源目录不存在 → 抛错，且不留 staging 残留', () => {
    const root = path.join(tmp, 'stage-missing');
    makeApp(root, 'demo', 'v1.0.0');
    assert.throws(
      () => stageVersionDir({ root, app: 'demo', fromDir: 'nope', toDir: 'v2.0.0', files: [] }),
      /来源版本目录不存在/,
    );
    const sRoot = stagingRootPath(root);
    assert.equal(fs.existsSync(path.join(sRoot, 'demo', 'nope')), false);
  });
});

describe('commitStagingDir（原子提交）', () => {
  it('CREATE → rename 进正式目录，正式目录内容完整', () => {
    const root = path.join(tmp, 'commit-create');
    makeApp(root, 'demo', 'v1.0.0');
    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v2.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' }],
    });
    commitStagingDir({ staging: staged.staging, dst: staged.dst, action: TARGET_CREATE, files: staged.files });

    assert.ok(fs.existsSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml')));
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:2.0.0\n',
    );
    // staging 已随 rename 移走
    assert.equal(fs.existsSync(staged.staging), false);
  });

  it('CREATE 且目标已存在 → 抛错（拒绝覆盖）', () => {
    const root = path.join(tmp, 'commit-conflict');
    makeApp(root, 'demo', 'v1.0.0');
    makeApp(root, 'demo', 'v2.0.0', 'image: nginx:EXISTING\n');
    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v2.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:NEW\n' }],
    });
    assert.throws(
      () => commitStagingDir({ staging: staged.staging, dst: staged.dst, action: TARGET_CREATE, files: staged.files }),
      /已存在，拒绝覆盖/,
    );
    // 既有目录内容**未被改动**
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:EXISTING\n',
    );
  });

  it('UPDATE → 只替换受管文件，其余文件保持不动', () => {
    const root = path.join(tmp, 'commit-update');
    makeApp(root, 'demo', 'v1.0.0');
    // 受管文件之外的存量文件
    fs.writeFileSync(path.join(root, 'demo', 'v1.0.0', 'README.md'), '手维护内容\n');
    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v1.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:9.9.9\n' }],
    });
    commitStagingDir({ staging: staged.staging, dst: staged.dst, action: TARGET_UPDATE, files: staged.files });

    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v1.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:9.9.9\n',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v1.0.0', 'README.md'), 'utf8'),
      '手维护内容\n',
    );
    // 不留临时文件
    assert.equal(fs.readdirSync(path.join(root, 'demo', 'v1.0.0')).some(f => f.includes('.tmp-')), false);
  });
});

describe('幂等 / 冲突判定（端到端，§四.2）', () => {
  it('目标已存在且内容一致 → IDEMPOTENT，不覆盖、不报错', () => {
    const root = path.join(tmp, 'idem');
    makeApp(root, 'demo', 'v1.0.0');
    // 先手工造出与 staging 产物完全一致的目标目录
    makeApp(root, 'demo', 'v2.0.0', 'image: nginx:2.0.0\n');
    fs.writeFileSync(path.join(root, 'demo', 'v2.0.0', 'data.yml'), 'additionalProperties:\n  key: x\n');

    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v2.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' }],
    });
    const identical = isIdenticalDir(staged.dst, staged.staging);
    const decision = resolveVersionTarget({ toDir: 'v2.0.0', exists: true, identical });

    assert.equal(identical, true);
    assert.equal(decision.action, TARGET_IDEMPOTENT);
    // 幂等路径不写正式目录
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:2.0.0\n',
    );
  });

  it('目标已存在且内容不同 → CONFLICT，正式目录零改动', () => {
    const root = path.join(tmp, 'conflict');
    makeApp(root, 'demo', 'v1.0.0');
    makeApp(root, 'demo', 'v2.0.0', 'image: nginx:OLD\n');

    const staged = stageVersionDir({
      root,
      app: 'demo',
      fromDir: 'v1.0.0',
      toDir: 'v2.0.0',
      files: [{ file: 'docker-compose.yml', content: 'image: nginx:NEW\n' }],
    });
    const identical = isIdenticalDir(staged.dst, staged.staging);
    const decision = resolveVersionTarget({ toDir: 'v2.0.0', exists: true, identical });

    assert.equal(identical, false);
    assert.equal(decision.action, TARGET_CONFLICT);
    // 正式目录内容保持原样（未被覆盖）
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:OLD\n',
    );
  });
});

describe('cleanupStagingDir / cleanupStaleStaging（安全回滚）', () => {
  it('只删 staging 根之内的内容', () => {
    const root = path.join(tmp, 'cleanup');
    makeApp(root, 'demo', 'v1.0.0');
    const staged = stageVersionDir({ root, app: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0', files: [] });
    assert.ok(fs.existsSync(staged.staging));

    assert.equal(cleanupStagingDir({ stagingRoot: staged.stagingRoot, app: 'demo', toDir: 'v2.0.0' }), true);
    assert.equal(fs.existsSync(staged.staging), false);
    // 正式目录毫发无损
    assert.ok(fs.existsSync(path.join(root, 'demo', 'v1.0.0', 'data.yml')));
  });

  it('拒绝删除 staging 根之外的路径（用户已有文件零污染）', () => {
    const root = path.join(tmp, 'cleanup-guard');
    makeApp(root, 'demo', 'v1.0.0');
    const victim = path.join(root, 'demo', 'v1.0.0');
    assert.equal(cleanupStagingDir({ stagingRoot: stagingRootPath(root), app: 'demo/v1.0.0' }), false);
    assert.ok(fs.existsSync(victim));
  });

  it('cleanupStaleStaging 清掉异常中断的残留 staging', () => {
    const root = path.join(tmp, 'cleanup-stale');
    makeApp(root, 'demo', 'v1.0.0');
    const stale = path.join(stagingRootPath(root), 'demo', 'v2.0.0');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'data.yml'), 'partial');

    const removed = cleanupStaleStaging(root);
    assert.deepEqual(removed, ['demo']);
    assert.equal(fs.existsSync(stale), false);
    // 正式目录不受影响
    assert.ok(fs.existsSync(path.join(root, 'demo', 'v1.0.0', 'data.yml')));
  });
});

describe('isIdenticalDir', () => {
  it('内容一致 → true', () => {
    const root = path.join(tmp, 'identical');
    makeApp(root, 'a', 'v1');
    makeApp(root, 'b', 'v1');
    assert.equal(isIdenticalDir(path.join(root, 'a', 'v1'), path.join(root, 'b', 'v1')), true);
  });

  it('内容不同 → false', () => {
    const root = path.join(tmp, 'different');
    makeApp(root, 'a', 'v1', 'image: nginx:1\n');
    makeApp(root, 'b', 'v1', 'image: nginx:2\n');
    assert.equal(isIdenticalDir(path.join(root, 'a', 'v1'), path.join(root, 'b', 'v1')), false);
  });

  it('文件集合不同 → false', () => {
    const root = path.join(tmp, 'different-files');
    makeApp(root, 'a', 'v1');
    makeApp(root, 'b', 'v1');
    fs.writeFileSync(path.join(root, 'b', 'v1', 'extra.txt'), 'x');
    assert.equal(isIdenticalDir(path.join(root, 'a', 'v1'), path.join(root, 'b', 'v1')), false);
  });
});
