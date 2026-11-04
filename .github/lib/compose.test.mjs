// .github/lib/compose.test.mjs
// 覆盖 .github/lib/compose.mjs 的 resolveImageTemplate / rebuildImageDefault。
// 关键场景：bookorbit/photoprism/mineru/... 等 9 个应用的双 envKey 形态
//（'${IMAGE}:${APP_VERSION}'）在原 detect 变量型分支会被静默跳过。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageTemplate, rebuildImageDefault } from './compose.mjs';

const SINGLE_FIELDS = [
  { envKey: 'IMAGE', default: 'ghcr.io/metacubex/mihomo:v1.19.18' },
];

const DOUBLE_FIELDS = [
  { envKey: 'APP_IMAGE', default: 'ghcr.io/bookorbit/bookorbit' },
  { envKey: 'APP_VERSION', default: '3.2.0' },
];

const DOUBLE_FIELDS_PHOTOPRISM = [
  { envKey: 'APP_IMAGE', default: 'ghcr.io/photoprism/photoprism' },
  { envKey: 'APP_VERSION', default: '260919-28c46a116' },
];

describe('resolveImageTemplate', () => {
  // ── 非变量型 ─────────────────────────────────────────────
  it('hardcode（无 ${}）→ null', () => {
    assert.equal(resolveImageTemplate('ghcr.io/foo/bar:1.2.3', []), null);
  });

  it('空字符串 image → null', () => {
    assert.equal(resolveImageTemplate('', SINGLE_FIELDS), null);
  });

  it('image 不是字符串 → null', () => {
    assert.equal(resolveImageTemplate(undefined, SINGLE_FIELDS), null);
  });

  // ── 形态 2：单 envKey 持有完整镜像字符串 ─────────────────
  it('形态 2：单 ${VERSION} + field.default 含完整字符串', () => {
    const r = resolveImageTemplate('ghcr.io/foo/bar:${VERSION}', [
      { envKey: 'VERSION', default: 'ghcr.io/metacubex/mihomo:v1.19.18' },
    ]);
    assert.equal(r.imageRepo, 'ghcr.io/metacubex/mihomo');
    assert.equal(r.currentTag, 'v1.19.18');
    assert.equal(r.envKey, 'VERSION');
    assert.equal(r.defaultVal, 'ghcr.io/metacubex/mihomo:v1.19.18');
  });

  it('形态 2：envKey 找不到 → null', () => {
    const r = resolveImageTemplate('ghcr.io/foo/bar:${MISSING}', SINGLE_FIELDS);
    assert.equal(r, null);
  });

  it('形态 2：default 为空 → null', () => {
    const r = resolveImageTemplate('ghcr.io/foo/bar:${EMPTY}', [
      { envKey: 'EMPTY', default: '' },
    ]);
    assert.equal(r, null);
  });

  it('形态 2：default 不含 ":" → null（无法拆分）', () => {
    const r = resolveImageTemplate('ghcr.io/foo/bar:${X}', [
      { envKey: 'X', default: 'only-repo-no-tag' },
    ]);
    assert.equal(r, null);
  });

  it('形态 2：默认端口 80 在 repo 内（ghcr.io:443/foo） 也能拆（parseImage 识别 registry 端口）', () => {
    const r = resolveImageTemplate('${X}', [
      { envKey: 'X', default: 'ghcr.io:443/foo/bar:1.0.0' },
    ]);
    assert.equal(r.imageRepo, 'ghcr.io:443/foo/bar');
    assert.equal(r.currentTag, '1.0.0');
  });

  it('形态 2：docker.io 前缀原样保留（不归一化 repo 写法）', () => {
    const r = resolveImageTemplate('${X}', [
      { envKey: 'X', default: 'docker.io/library/nginx:1.25' },
    ]);
    assert.equal(r.imageRepo, 'docker.io/library/nginx');
    assert.equal(r.currentTag, '1.25');
  });

  it('形态 2：digest 镜像（无 tag）→ null（版本被摘要锁定，不做自动更新）', () => {
    const r = resolveImageTemplate('${X}', [
      { envKey: 'X', default: 'nginx@sha256:abc123' },
    ]);
    assert.equal(r, null);
  });

  it('形态 2：tag+digest 镜像 → null（摘要锁定，不做自动更新）', () => {
    const r = resolveImageTemplate('${X}', [
      { envKey: 'X', default: 'nginx:1.25@sha256:abc123' },
    ]);
    assert.equal(r, null);
  });

  it('形态 2：非法镜像名（含空格）→ null', () => {
    const r = resolveImageTemplate('${X}', [
      { envKey: 'X', default: 'foo bar:1.0' },
    ]);
    assert.equal(r, null);
  });

  // ── 形态 3：双 envKey，repo 与 tag 拆到不同字段（核心修复场景）──
  it('形态 3：bookorbit ${APP_IMAGE}:${APP_VERSION} 重组为完整镜像', () => {
    const r = resolveImageTemplate('${APP_IMAGE}:${APP_VERSION}', DOUBLE_FIELDS);
    assert.equal(r.imageRepo, 'ghcr.io/bookorbit/bookorbit');
    assert.equal(r.currentTag, '3.2.0');
    // 写回时只动 APP_VERSION 那个字段
    assert.equal(r.envKey, 'APP_VERSION');
    assert.equal(r.defaultVal, '3.2.0');
  });

  it('形态 3：photoprism ${APP_IMAGE}:${APP_VERSION} 含复杂 tag 也工作', () => {
    const r = resolveImageTemplate(
      '${APP_IMAGE}:${APP_VERSION}',
      DOUBLE_FIELDS_PHOTOPRISM
    );
    assert.equal(r.imageRepo, 'ghcr.io/photoprism/photoprism');
    assert.equal(r.currentTag, '260919-28c46a116');
    assert.equal(r.envKey, 'APP_VERSION');
  });

  it('形态 3：registry 端口（localhost:5000/app）也能正确拆分', () => {
    const r = resolveImageTemplate('${IMAGE}:${TAG}', [
      { envKey: 'IMAGE', default: 'localhost:5000/app' },
      { envKey: 'TAG', default: '1.0' },
    ]);
    assert.equal(r.imageRepo, 'localhost:5000/app');
    assert.equal(r.currentTag, '1.0');
    assert.equal(r.envKey, 'TAG');
  });

  it('形态 3：image 模板在 tag 后带额外字面量 → null（保守放弃，避免写回丢字面量）', () => {
    const r = resolveImageTemplate('${IMAGE}:${TAG}-extra', [
      { envKey: 'IMAGE', default: 'ghcr.io/foo/bar' },
      { envKey: 'TAG', default: '1.0.0' },
    ]);
    assert.equal(r, null);
  });

  it('形态 3：envKey 顺序异常（${VERSION}:${IMAGE}）→ null（parseImage 判非法，保守放弃）', () => {
    // 拼出 "1.0.0:foo/bar"：首个路径段含 ':' 会被当成 registry:port，整体不是合法镜像
    const r = resolveImageTemplate('${VERSION}:${IMAGE}', [
      { envKey: 'VERSION', default: '1.0.0' },
      { envKey: 'IMAGE', default: 'foo/bar' },
    ]);
    assert.equal(r, null);
  });

  it('形态 3：envKey 之一缺失 → null', () => {
    const r = resolveImageTemplate('${A}:${B}', [
      { envKey: 'A', default: 'foo/bar' },
    ]);
    assert.equal(r, null);
  });

  it('形态 3：envKey 默认值含 ":" → null（保守放弃）', () => {
    const r = resolveImageTemplate('${A}:${B}', [
      { envKey: 'A', default: 'foo:bar' }, // 异常：repo 不应含冒号
      { envKey: 'B', default: '1.0.0' },
    ]);
    assert.equal(r, null);
  });

  it('形态 3：envKey 默认值都为空 → null', () => {
    const r = resolveImageTemplate('${A}:${B}', [
      { envKey: 'A', default: '' },
      { envKey: 'B', default: '' },
    ]);
    assert.equal(r, null);
  });

  it('3+ envKey（暂不支持）→ null', () => {
    const r = resolveImageTemplate('${A}:${B}:${C}', [
      { envKey: 'A', default: 'foo' },
      { envKey: 'B', default: 'bar' },
      { envKey: 'C', default: '1.0' },
    ]);
    assert.equal(r, null);
  });

  // ── 边界：同 image 内 envKey 重复出现也应正常 ──
  it('形态 2：image 含同一 ${} 两次不影响解析', () => {
    const r = resolveImageTemplate('${X}/${X}', [
      { envKey: 'X', default: 'foo/bar:1.0.0' },
    ]);
    // 拼出 "foo/bar:1.0.0/foo/bar:1.0.0"，lastIndexOf 拆出 repo="foo/bar:1.0.0/foo/bar"，tag="1.0.0"
    // 仅锁住"不抛错 + lastIndexOf 一致"语义，不保证业务合理
    assert.equal(r.currentTag, '1.0.0');
  });
});

describe('rebuildImageDefault', () => {
  it('形态 2：返回完整 imageRepo:newTag', () => {
    const out = rebuildImageDefault(
      'ghcr.io/foo/bar:${VERSION}',
      'VERSION',
      'ghcr.io/foo/bar',
      '1.2.4'
    );
    assert.equal(out, 'ghcr.io/foo/bar:1.2.4');
  });

  it('形态 3：tagKey 双 envKey 形态 → 只返回 newTag（写回 tag 字段）', () => {
    const out = rebuildImageDefault(
      '${APP_IMAGE}:${APP_VERSION}',
      'APP_VERSION',
      'ghcr.io/bookorbit/bookorbit',
      '3.4.0'
    );
    assert.equal(out, '3.4.0');
  });

  it('envKey 与 image 中不匹配 → 兜底返回 newTag', () => {
    const out = rebuildImageDefault(
      'ghcr.io/foo/bar:${VERSION}',
      'WRONG_KEY',
      'ghcr.io/foo/bar',
      '9.9.9'
    );
    assert.equal(out, '9.9.9');
  });
});
