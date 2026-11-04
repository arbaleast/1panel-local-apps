// .github/lib/detect-updates.test.mjs
// 覆盖 .github/scripts/detect-updates.mjs 中导出的纯函数：
// - shouldSkipAutoUpdate: 白名单早返回依赖此函数
// - parseCliArgs: CLI 参数解析（--dry-run / --help / --verbose / 位置参数）
// 强耦合 APPS_DIR/REPO_ROOT 的 processApp/main 不便直测。
//
// 注意：parseCliArgs 会修改模块顶层 processOptions（设 DRY_RUN/HELP/VERBOSE 标志）。
// 这是设计选择（避免每次调用传 opts），但意味着测试只能验证"不抛错"与"返回值"，
// 跨 case 的状态泄漏由模块本身保证（CLI 入口只调用一次）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldSkipAutoUpdate,
  parseCliArgs,
  canCopyVersionDir,
  classifyImage,
  determineExitCode,
  pickPrimaryReason,
  compareVersionsLoose,
  looseVersionChunks,
  findFormFieldForImage,
  parseCompose,
  parseDataYml,
  classifyServiceImage,
  buildResultSummary,
  formatResultReport,
  overallExitCode,
  formatReason,
  stageForReason,
  applyChanges,
} from '../scripts/detect-updates.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('detect-updates 白名单', () => {
  // 1. 白名单内应用 → true（被跳过）
  it('shouldSkipAutoUpdate: anythingllm 在白名单中 → true', () => {
    assert.equal(shouldSkipAutoUpdate('anythingllm'), true);
  });

  // 2. 已知非白名单应用 → false（正常走 detect）
  it('shouldSkipAutoUpdate: anirss 不在白名单 → false', () => {
    assert.equal(shouldSkipAutoUpdate('anirss'), false);
  });

  // 3. 完全不存在的应用名 → false
  it('shouldSkipAutoUpdate: 不存在的应用名 → false', () => {
    assert.equal(shouldSkipAutoUpdate('nonexistent-app-xyz'), false);
  });

  // 4. 大小写敏感：白名单是小写 'anythingllm'，大写不命中
  it('shouldSkipAutoUpdate: 大小写敏感，AnythingLLM 不命中', () => {
    assert.equal(shouldSkipAutoUpdate('AnythingLLM'), false);
    assert.equal(shouldSkipAutoUpdate('ANYTHINGLLM'), false);
  });

  // 5. 空字符串 / 特殊字符 → false（不应抛错或误命中）
  it('shouldSkipAutoUpdate: 空字符串/特殊字符不命中', () => {
    assert.equal(shouldSkipAutoUpdate(''), false);
    assert.equal(shouldSkipAutoUpdate(' '), false);
    assert.equal(shouldSkipAutoUpdate('anythingllm-extra'), false);
    assert.equal(shouldSkipAutoUpdate('preanythingllm'), false);
  });

  // 6. jellyfin 手维护（日期型 tag 会被 fallback 到 pure-semver，跨目录覆盖 10.11.11/）
  it('shouldSkipAutoUpdate: jellyfin 在白名单中 → true', () => {
    assert.equal(shouldSkipAutoUpdate('jellyfin'), true);
  });
});

describe('canCopyVersionDir（跨目录覆盖安全闸）', () => {
  // 目标目录不存在 → 允许（正常新建版本目录）
  it('目标目录不存在 → 允许复制', () => {
    assert.equal(canCopyVersionDir('10.11.11', '10.12.0', false), true);
  });

  // 来源 == 目标 → 允许（幂等刷新同一目录）
  it('来源目录与目标目录相同 → 允许复制', () => {
    assert.equal(canCopyVersionDir('10.11.11', '10.11.11', true), true);
  });

  // 目标已存在且与来源不同 → 拒绝（2026-09-25 jellyfin 事故形态）
  it('目标目录已存在且不同于来源 → 拒绝复制', () => {
    assert.equal(canCopyVersionDir('2026091410-arm64', '10.11.11', true), false);
  });

  // 反向形态同样拒绝
  it('反向跨目录覆盖 → 拒绝复制', () => {
    assert.equal(canCopyVersionDir('10.11.11', '2026091410-arm64', true), false);
  });
});

describe('parseCliArgs', () => {
  // 6. --dry-run / -n 不抛错
  it('--dry-run: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--dry-run']));
  });

  it('-n 短名等价于 --dry-run', () => {
    assert.doesNotThrow(() => parseCliArgs(['-n']));
  });

  // 7. --help / -h
  it('--help: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--help']));
  });

  it('-h 短名不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['-h']));
  });

  // 8. --verbose / -v
  it('--verbose: 不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['--verbose']));
  });

  it('-v 短名不抛错', () => {
    assert.doesNotThrow(() => parseCliArgs(['-v']));
  });

  // 9. 未知 flag 抛错（不静默吞错）
  it('未知 flag 抛错', () => {
    assert.throws(
      () => parseCliArgs(['--no-such-flag']),
      /未知参数/,
    );
  });

  // 10. 位置参数收集
  it('位置参数: 收集到 positional 数组', () => {
    const { positional } = parseCliArgs(['bookorbit', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });

  // 11. 位置参数与 flag 混合
  it('位置参数 + flag 混合: 分离正确', () => {
    const { positional } = parseCliArgs(['bookorbit', '--dry-run', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });

  // 12. 空参数
  it('空参数: 返回空 positional', () => {
    const { positional } = parseCliArgs([]);
    assert.deepEqual(positional, []);
  });

  // 13. 短名组合（真实使用: `node detect-updates.mjs -n bookorbit`）
  it('短名 + 位置参数: 完整命令模拟', () => {
    const { positional } = parseCliArgs(['-n', 'bookorbit', 'photoprism']);
    assert.deepEqual(positional, ['bookorbit', 'photoprism']);
  });
});

describe('classifyImage（镜像分类）', () => {
  // 普通镜像（无 registry 前缀）
  it('普通镜像 + tag → ok', () => {
    const r = classifyImage('kragleer/anirss:v3.2.18');
    assert.equal(r.status, 'ok');
    assert.equal(r.registry, 'dockerhub');
    assert.equal(r.repo, 'kragleer/anirss');
    assert.equal(r.imageRef, 'kragleer/anirss');
    assert.equal(r.tag, 'v3.2.18');
  });

  // ghcr.io 镜像：repo 不含 registry，imageRef 含 registry
  it('ghcr.io 镜像 → ok，repo/imageRef 分离', () => {
    const r = classifyImage('ghcr.io/traefik/traefik:v3.6.6');
    assert.equal(r.status, 'ok');
    assert.equal(r.registry, 'ghcr.io');
    assert.equal(r.repo, 'traefik/traefik');
    assert.equal(r.imageRef, 'ghcr.io/traefik/traefik');
    assert.equal(r.tag, 'v3.6.6');
  });

  // registry 带端口
  it('registry 带端口 → unsupported-registry', () => {
    const r = classifyImage('localhost:5000/app:1.0');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'unsupported-registry');
  });

  // 自定义 registry
  it('自定义 registry → unsupported-registry', () => {
    const r = classifyImage('registry.example.com/org/app:1.2.3');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'unsupported-registry');
  });

  // 解析失败
  it('无法解析的镜像 → image-unresolved', () => {
    assert.equal(classifyImage('${IMAGE}:${TAG}').reason, 'image-unresolved');
    assert.equal(classifyImage('').reason, 'image-unresolved');
    assert.equal(classifyImage('ng inx:1.0').reason, 'image-unresolved');
  });

  // digest 镜像不可更新
  it('digest 镜像 → digest-image', () => {
    const r = classifyImage('nginx@sha256:abcdef');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'digest-image');
  });

  // 无 tag
  it('无 tag 无 digest → no-tag', () => {
    const r = classifyImage('kragleer/anirss');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'no-tag');
  });

  // tag=latest
  it('tag=latest → tag-latest', () => {
    const r = classifyImage('kragleer/anirss:latest');
    assert.equal(r.status, 'skipped');
    assert.equal(r.reason, 'tag-latest');
  });

  // 不稳定 tag
  it('nightly / dev / beta 等不稳定 tag → tag-unstable', () => {
    assert.equal(classifyImage('a/b:nightly').reason, 'tag-unstable');
    assert.equal(classifyImage('a/b:dev').reason, 'tag-unstable');
    assert.equal(classifyImage('a/b:beta').reason, 'tag-unstable');
    assert.equal(classifyImage('a/b:rc1').status, 'ok', 'rc1 不是整词黑名单命中');
  });
});

describe('determineExitCode（退出码）', () => {
  // 无失败 → 0
  it('全部成功 → 退出码 0', () => {
    assert.equal(determineExitCode([{ status: 'success' }, { status: 'skipped' }]), 0);
  });

  // 存在失败 → 2（Registry 失败必须非零退出）
  it('存在 failed → 退出码 2', () => {
    assert.equal(
      determineExitCode([
        { status: 'success' },
        { status: 'failed', stage: 'registry', reason: 'registry-request-failed' },
      ]),
      2,
    );
  });

  // 空结果 → 0
  it('空结果 → 退出码 0', () => {
    assert.equal(determineExitCode([]), 0);
    assert.equal(determineExitCode(undefined), 0);
  });

  // skipped 不影响退出码（跳过 ≠ 失败）
  it('只有 skipped 不影响退出码', () => {
    assert.equal(determineExitCode([{ status: 'skipped' }, { status: 'skipped' }]), 0);
  });
});

describe('pickPrimaryReason（app 级 reason 汇总）', () => {
  it('优先返回更严重的 reason', () => {
    assert.equal(pickPrimaryReason(['no-services', 'tag-latest']), 'tag-latest');
    assert.equal(pickPrimaryReason(['no-services', 'registry-request-failed']), 'registry-request-failed');
  });

  it('单个 reason 原样返回', () => {
    assert.equal(pickPrimaryReason(['whitelisted']), 'whitelisted');
  });

  it('空输入 → no-update', () => {
    assert.equal(pickPrimaryReason([]), 'no-update');
  });
});

describe('compareVersionsLoose / looseVersionChunks', () => {
  it('比较数值段', () => {
    assert.ok(compareVersionsLoose('3.2.18', '3.2.9') > 0);
    assert.ok(compareVersionsLoose('3.2.9', '3.2.18') < 0);
    assert.equal(compareVersionsLoose('3.2.18', '3.2.18'), 0);
  });

  it('日期型版本目录可比较', () => {
    assert.ok(compareVersionsLoose('2026091410-arm64', '10.11.11') > 0);
  });

  it('多段数字版本可比较', () => {
    assert.ok(compareVersionsLoose('26.04.5.1.1', '2.1.5') > 0);
  });

  it('无法识别的版本 → 空 chunks', () => {
    assert.deepEqual(looseVersionChunks('foo'), []);
    assert.deepEqual(looseVersionChunks(''), []);
    assert.deepEqual(looseVersionChunks('v3.2.18'), [3, 2, 18]);
  });
});

describe('parseCompose / parseDataYml（解析失败可识别）', () => {
  it('compose 解析出 services', () => {
    const services = parseCompose('services:\n  app:\n    image: nginx:1.25\n');
    assert.equal(services.length, 1);
    assert.equal(services[0].image, 'nginx:1.25');
  });

  it('非法 YAML 抛错（由 detect 归类为 failed）', () => {
    assert.throws(() => parseCompose('services:\n  - a\n   bad: [unclosed'));
    assert.throws(() => parseDataYml('key: [unclosed'));
  });

  it('data.yml 解析出 formFields', () => {
    const obj = parseDataYml('additionalProperties:\n  formFields:\n    - envKey: APP_VERSION\n      default: "3.2.0"\n');
    assert.equal(obj.additionalProperties.formFields[0].envKey, 'APP_VERSION');
  });
});

describe('findFormFieldForImage（统一用 parseImage 解析 default）', () => {
  it('匹配 default 为完整镜像字符串的字段', () => {
    const obj = {
      additionalProperties: {
        formFields: [
          { envKey: 'IMAGE', default: 'kragleer/anirss:v3.2.18' },
        ],
      },
    };
    const found = findFormFieldForImage(obj, 'kragleer/anirss');
    assert.ok(found);
    assert.equal(found.index, 0);
  });

  it('ghcr.io 镜像：default 含 registry 时按 repo（不含 registry）匹配', () => {
    const obj = {
      additionalProperties: {
        formFields: [
          { envKey: 'IMAGE', default: 'ghcr.io/traefik/traefik:v3.6.6' },
        ],
      },
    };
    const found = findFormFieldForImage(obj, 'traefik/traefik');
    assert.ok(found);
    assert.equal(found.index, 0);
  });

  it('无匹配返回 null', () => {
    const obj = {
      additionalProperties: {
        formFields: [{ envKey: 'IMAGE', default: 'other/repo:1.0' }],
      },
    };
    assert.equal(findFormFieldForImage(obj, 'kragleer/anirss'), null);
  });

  it('非法 default（空串）跳过，不抛错', () => {
    const obj = {
      additionalProperties: {
        formFields: [{ envKey: 'IMAGE', default: '' }],
      },
    };
    assert.equal(findFormFieldForImage(obj, 'kragleer/anirss'), null);
  });
});

describe('classifyServiceImage（集中化镜像分类）', () => {
  it('变量型镜像 → kind=variable', () => {
    const r = classifyServiceImage('${IMAGE}:${APP_VERSION}');
    assert.equal(r.kind, 'variable');
  });

  it('普通硬编码镜像 → kind=hardcoded，带 repo/tag', () => {
    const r = classifyServiceImage('kragleer/anirss:v3.2.18');
    assert.equal(r.kind, 'hardcoded');
    assert.equal(r.repo, 'kragleer/anirss');
    assert.equal(r.tag, 'v3.2.18');
    assert.equal(r.registry, 'dockerhub');
  });

  it('ghcr.io 硬编码镜像 → kind=hardcoded，repo 不含 registry', () => {
    const r = classifyServiceImage('ghcr.io/traefik/traefik:v3.6.6');
    assert.equal(r.kind, 'hardcoded');
    assert.equal(r.registry, 'ghcr.io');
    assert.equal(r.repo, 'traefik/traefik');
    assert.equal(r.tag, 'v3.6.6');
  });

  it('带端口的 registry（localhost:5000/app:1.0）→ 正确拆出 repo/tag', () => {
    const r = classifyServiceImage('localhost:5000/app:1.0');
    assert.equal(r.kind, 'hardcoded');
    assert.equal(r.registry, 'localhost:5000');
    assert.equal(r.repo, 'app');
    assert.equal(r.tag, '1.0');
  });

  it('digest-only 镜像 → kind=digest（skipped，不是失败）', () => {
    const r = classifyServiceImage('nginx@sha256:abcdef');
    assert.equal(r.kind, 'digest');
    assert.equal(r.code, 'digest-image');
  });

  it('无 tag 镜像 → kind=no-tag', () => {
    const r = classifyServiceImage('kragleer/anirss');
    assert.equal(r.kind, 'no-tag');
    assert.equal(r.code, 'no-tag');
  });

  it('非法镜像串 → kind=invalid（必须记为 failed）', () => {
    assert.equal(classifyServiceImage('ng inx:1.0').kind, 'invalid');
    assert.equal(classifyServiceImage('').kind, 'invalid');
    assert.equal(classifyServiceImage('   ').kind, 'invalid');
    assert.equal(classifyServiceImage('repo:').kind, 'invalid');
  });
});

describe('buildResultSummary（结果聚合）', () => {
  it('统计 success / skipped / failed / updates', () => {
    const s = buildResultSummary([
      { app: 'a', status: 'success', updates: 2 },
      { app: 'b', status: 'success', updates: 0 },
      { app: 'c', status: 'skipped', updates: 0 },
      { app: 'd', status: 'failed', updates: 0 },
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.success, 2);
    assert.equal(s.skipped, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.updates, 2);
  });

  it('skipped 不计入 failed', () => {
    const s = buildResultSummary([
      { app: 'a', status: 'skipped' },
      { app: 'b', status: 'skipped' },
    ]);
    assert.equal(s.failed, 0);
    assert.equal(s.skipped, 2);
  });

  it('空结果 → 全 0', () => {
    assert.deepEqual(buildResultSummary([]), {
      total: 0, success: 0, skipped: 0, failed: 0, updates: 0,
    });
    assert.deepEqual(buildResultSummary(undefined), {
      total: 0, success: 0, skipped: 0, failed: 0, updates: 0,
    });
  });
});

describe('formatResultReport（每应用结果表）', () => {
  const results = [
    { app: 'anirss', status: 'success', stage: 'scan', reason: '检测到新版本 1.2.3', updates: 1 },
    { app: 'jellyfin', status: 'skipped', stage: 'whitelist', reason: '已在白名单，手维护', updates: 0 },
    {
      app: 'brokenapp',
      status: 'failed',
      stage: 'registry',
      reason: 'Registry 请求失败',
      error: 'Registry 请求失败: fetch failed',
      updates: 0,
    },
  ];

  it('包含每个应用名 / 状态 / 阶段 / 原因', () => {
    const text = formatResultReport(results);
    assert.match(text, /anirss/);
    assert.match(text, /jellyfin/);
    assert.match(text, /brokenapp/);
    assert.match(text, /success/);
    assert.match(text, /skipped/);
    assert.match(text, /failed/);
    assert.match(text, /whitelist/);
    assert.match(text, /registry/);
  });

  it('失败应用名与原因出现在报告中', () => {
    const text = formatResultReport(results);
    assert.match(text, /brokenapp/);
    assert.match(text, /Registry 请求失败/);
  });

  it('包含失败底层错误信息', () => {
    const text = formatResultReport(results);
    assert.match(text, /fetch failed/);
  });

  it('包含汇总行（success/skipped/failed/总数）', () => {
    const text = formatResultReport(results);
    assert.match(text, /共 3 个应用/);
    assert.match(text, /success 1/);
    assert.match(text, /skipped 1/);
    assert.match(text, /failed 1/);
  });
});

describe('overallExitCode（退出码契约）', () => {
  it('存在 failed → 2', () => {
    assert.equal(
      overallExitCode([
        { status: 'success' },
        { status: 'failed', stage: 'registry', reason: 'Registry 请求失败' },
      ]),
      2,
    );
  });

  it('无 failed（含全部 skipped / success）→ 0', () => {
    assert.equal(overallExitCode([{ status: 'success' }, { status: 'skipped' }]), 0);
    assert.equal(overallExitCode([{ status: 'skipped' }]), 0);
    assert.equal(overallExitCode([]), 0);
    assert.equal(overallExitCode(undefined), 0);
  });
});

describe('formatReason / stageForReason', () => {
  it('reason 码 → 人读说明', () => {
    assert.equal(formatReason('whitelisted'), '已在白名单，手维护');
    assert.equal(formatReason('no-services'), 'compose 无 services');
    assert.equal(formatReason('image-unresolved'), '镜像字符串无法解析');
    assert.equal(formatReason('registry-request-failed'), 'Registry 请求失败');
    assert.equal(formatReason('no-update'), '已是最新');
    assert.match(formatReason('update-found', { to: '1.2.3' }), /1\.2\.3/);
  });

  it('unsupported-registry 说明里带 registry 名', () => {
    assert.match(formatReason('unsupported-registry', { registry: 'harbor.local' }), /harbor\.local/);
  });

  it('reason 码 → 阶段', () => {
    assert.equal(stageForReason('whitelisted'), 'whitelist');
    assert.equal(stageForReason('compose-invalid'), 'compose');
    assert.equal(stageForReason('data-yml-invalid'), 'data-yml');
    assert.equal(stageForReason('image-unresolved'), 'image-parse');
    assert.equal(stageForReason('registry-request-failed'), 'registry');
    assert.equal(stageForReason('version-unrecognized'), 'version');
    assert.equal(stageForReason('write-failed'), 'write');
  });
});

// ─── 2026-11 可靠性治理：staging 原子写盘 / 幂等 / 冲突 / 回滚 ──────────────

describe('applyChanges（staging → 校验 → 原子提交）', () => {
  const TMP_BASE = path.join(ROOT, '.agent_cache', 'detect-test');

  /** 建一个最小应用目录 */
  function makeApp(root, app, version) {
    const dir = path.join(root, app, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.yml'), 'additionalProperties:\n  key: x\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'image: nginx:1.0.0\n');
    fs.writeFileSync(path.join(root, app, 'data.yml'), 'additionalProperties:\n  key: x\n');
    return dir;
  }

  // 每次运行都用**唯一**临时目录（避免上一次运行残留导致幂等判定被提前命中）
  function freshRoot() {
    fs.mkdirSync(TMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TMP_BASE, 'root-'));
  }

  const noopValidate = () => [];

  it('生成新版本目录：staging → 校验 → 原子 rename，正式目录内容正确', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    const out = applyChanges(
      'demo',
      [
        { path: 'demo/v2.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' },
        { path: 'demo/v2.0.0/data.yml', file: 'data.yml', content: 'additionalProperties:\n  key: x\n' },
      ],
      { appName: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0' },
      { root, validate: noopValidate, dryRun: false },
    );
    assert.equal(out.written, true);
    assert.equal(out.action, 'CREATE');
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:2.0.0\n',
    );
    // staging 已清理
    assert.equal(fs.existsSync(path.join(root, '.staging', 'demo', 'v2.0.0')), false);
  });

  it('校验失败 → 抛错，正式目录**零污染**，staging 被清理', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    assert.throws(
      () =>
        applyChanges(
          'demo',
          [{ path: 'demo/v2.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'BAD\n' }],
          { appName: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0' },
          { root, validate: () => ['staging 不合法'], dryRun: false },
        ),
      /未通过 SSOT 校验/,
    );
    // 正式目录未被创建
    assert.equal(fs.existsSync(path.join(root, 'demo', 'v2.0.0')), false);
    // 旧版本目录完好
    assert.ok(fs.existsSync(path.join(root, 'demo', 'v1.0.0', 'docker-compose.yml')));
    // staging 已清理
    assert.equal(fs.existsSync(path.join(root, '.staging', 'demo', 'v2.0.0')), false);
  });

  it('目标目录已存在且内容一致 → 幂等跳过（ALREADY_EXISTS），不覆盖', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    // 预置一个与产物完全一致的目标目录
    makeApp(root, 'demo', 'v2.0.0');
    fs.writeFileSync(
      path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'),
      'image: nginx:2.0.0\n',
    );

    const out = applyChanges(
      'demo',
      [{ path: 'demo/v2.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' }],
      { appName: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0' },
      { root, validate: noopValidate, dryRun: false },
    );
    assert.equal(out.written, false);
    assert.equal(out.action, 'IDEMPOTENT');
    // 内容未被改动
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:2.0.0\n',
    );
  });

  it('目标目录已存在且内容不同 → 冲突报错，正式目录零改动', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    makeApp(root, 'demo', 'v2.0.0');
    fs.writeFileSync(
      path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'),
      'image: nginx:MANUAL\n',
    );

    assert.throws(
      () =>
        applyChanges(
          'demo',
          [{ path: 'demo/v2.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' }],
          { appName: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0' },
          { root, validate: noopValidate, dryRun: false },
        ),
      /历史版本不可变|拒绝覆盖/,
    );
    // 既有内容保持原样
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v2.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:MANUAL\n',
    );
  });

  it('同一版本重复执行 → 完全幂等（第二次不再产生变更）', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    const changes = [
      { path: 'demo/v2.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'image: nginx:2.0.0\n' },
      { path: 'demo/v2.0.0/data.yml', file: 'data.yml', content: 'additionalProperties:\n  key: x\n' },
    ];
    const vcopy = { appName: 'demo', fromDir: 'v1.0.0', toDir: 'v2.0.0' };
    const first = applyChanges('demo', changes, vcopy, { root, validate: noopValidate, dryRun: false });
    assert.equal(first.written, true);

    const second = applyChanges('demo', changes, vcopy, { root, validate: noopValidate, dryRun: false });
    assert.equal(second.written, false);
    assert.equal(second.action, 'IDEMPOTENT');
    // 没有产生第二份目录、没有损坏文件
    assert.equal(fs.existsSync(path.join(root, 'demo', 'v2.0.0', 'data.yml')), true);
  });

  it('就地更新同名版本目录：只改受管文件，其余文件不动', () => {
    const root = freshRoot();
    makeApp(root, 'demo', 'v1.0.0');
    fs.writeFileSync(path.join(root, 'demo', 'v1.0.0', 'README.md'), '手维护\n');
    const out = applyChanges(
      'demo',
      [{ path: 'demo/v1.0.0/docker-compose.yml', file: 'docker-compose.yml', content: 'image: nginx:9.9.9\n' }],
      undefined,
      { root, validate: noopValidate, dryRun: false },
    );
    assert.equal(out.written, true);
    assert.equal(out.action, 'UPDATE');
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v1.0.0', 'docker-compose.yml'), 'utf8'),
      'image: nginx:9.9.9\n',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'demo', 'v1.0.0', 'README.md'), 'utf8'),
      '手维护\n',
    );
  });
});
