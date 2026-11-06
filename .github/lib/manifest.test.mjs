// lib/manifest.test.mjs — manifest / image config 纯函数解析层单元测试
//
// 覆盖目标 §五.3（CPU 多架构兼容性核验）的解析基础：
//   1) OCI platform → 1Panel 仓库架构名映射
//   2) index 平台集合提取（过滤 buildx attestation 占位）
//   3) 单架构 manifest 的 config digest 与 image config 提取
//
// 纯离线：不发起任何网络请求。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toRepoArch,
  extractPlatforms,
  extractConfigDigest,
  extractImageConfig,
} from './manifest.mjs';

describe('manifest：toRepoArch 平台 → 仓库架构名', () => {
  it('linux/arm + variant v7 → arm/v7', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: 'arm', variant: 'v7' }), 'arm/v7');
  });

  it('linux/arm64 → arm64（无论是否带 variant）', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: 'arm64' }), 'arm64');
    assert.equal(toRepoArch({ os: 'linux', architecture: 'arm64', variant: 'v8' }), 'arm64');
  });

  it('linux/amd64 → amd64', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: 'amd64' }), 'amd64');
  });

  it('linux/386 → 386', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: '386' }), '386');
  });

  it('linux/arm 无 variant → arm', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: 'arm' }), 'arm');
  });

  it('非 linux 操作系统 → null', () => {
    assert.equal(toRepoArch({ os: 'windows', architecture: 'amd64' }), null);
    assert.equal(toRepoArch({ os: 'darwin', architecture: 'arm64' }), null);
  });

  it('字段缺失 / 非对象 → null', () => {
    assert.equal(toRepoArch(null), null);
    assert.equal(toRepoArch(undefined), null);
    assert.equal(toRepoArch({}), null);
    assert.equal(toRepoArch({ os: 'linux' }), null);
    assert.equal(toRepoArch({ architecture: 'amd64' }), null);
    assert.equal(toRepoArch({ os: 'linux', architecture: '' }), null);
  });

  it('未知架构 → null', () => {
    assert.equal(toRepoArch({ os: 'linux', architecture: 'riscv64' }), null);
  });
});

describe('manifest：extractPlatforms 平台集合提取', () => {
  it('index：提取多架构平台并去重排序', () => {
    const body = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } },
        { digest: 'sha256:b', platform: { os: 'linux', architecture: 'arm64' } },
        { digest: 'sha256:c', platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
        { digest: 'sha256:d', platform: { os: 'linux', architecture: 'amd64' } },
      ],
    };
    const r = extractPlatforms(body);
    assert.equal(r.kind, 'index');
    assert.deepEqual(r.platforms, ['amd64', 'arm/v7', 'arm64']);
    assert.equal(r.rawPlatforms.length, 4);
  });

  it('index：过滤 unknown 与 attestation-manifest 占位条目', () => {
    const body = {
      manifests: [
        { digest: 'sha256:a', platform: { os: 'linux', architecture: 'amd64' } },
        { digest: 'sha256:u', platform: { os: 'unknown', architecture: 'unknown' } },
        { digest: 'sha256:x', platform: { os: 'unknown', architecture: 'attestation-manifest' } },
        {
          digest: 'sha256:y',
          platform: {
            os: 'unknown',
            architecture: 'unknown',
            annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
          },
        },
      ],
    };
    const r = extractPlatforms(body);
    assert.equal(r.kind, 'index');
    assert.deepEqual(r.platforms, ['amd64']);
    assert.equal(r.rawPlatforms.length, 1);
    assert.deepEqual(r.rawPlatforms[0], { os: 'linux', architecture: 'amd64', variant: null });
  });

  it('index：arm + variant v7 归一为 arm/v7', () => {
    const body = {
      manifests: [{ platform: { os: 'linux', architecture: 'arm', variant: 'v7' } }],
    };
    assert.deepEqual(extractPlatforms(body).platforms, ['arm/v7']);
  });

  it('单架构 manifest（无 manifests 数组）→ kind=manifest，platforms=[]', () => {
    const body = {
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: 'sha256:cfg', size: 123 },
      layers: [],
    };
    const r = extractPlatforms(body);
    assert.equal(r.kind, 'manifest');
    assert.deepEqual(r.platforms, []);
    assert.deepEqual(r.rawPlatforms, []);
  });

  it('非法 / 空 body → kind=manifest，platforms=[]', () => {
    for (const body of [null, undefined, {}, 'x', 42]) {
      const r = extractPlatforms(body);
      assert.equal(r.kind, 'manifest');
      assert.deepEqual(r.platforms, []);
    }
  });
});

describe('manifest：extractConfigDigest', () => {
  it('取 config.digest', () => {
    assert.equal(extractConfigDigest({ config: { digest: 'sha256:abc' } }), 'sha256:abc');
  });

  it('缺失 / 空值 → null', () => {
    assert.equal(extractConfigDigest({}), null);
    assert.equal(extractConfigDigest(null), null);
    assert.equal(extractConfigDigest({ config: {} }), null);
    assert.equal(extractConfigDigest({ config: { digest: '' } }), null);
  });
});

describe('manifest：extractImageConfig', () => {
  it('完整形态：平台 + 运行身份', () => {
    const body = {
      os: 'linux',
      architecture: 'arm64',
      variant: 'v8',
      config: {
        User: '1000:1000',
        Env: ['PATH=/usr/bin', 'FOO=bar'],
      },
    };
    assert.deepEqual(extractImageConfig(body), {
      os: 'linux',
      architecture: 'arm64',
      variant: 'v8',
      user: '1000:1000',
      env: ['PATH=/usr/bin', 'FOO=bar'],
    });
  });

  it('User 为 null → 原样保留 null', () => {
    const r = extractImageConfig({ os: 'linux', architecture: 'amd64', config: { User: null } });
    assert.equal(r.user, null);
  });

  it('User 为空字符串 → 原样保留空字符串（不归一成 null）', () => {
    const r = extractImageConfig({ os: 'linux', architecture: 'amd64', config: { User: '' } });
    assert.equal(r.user, '');
  });

  it('User 字段缺失 → null', () => {
    assert.equal(extractImageConfig({ os: 'linux', architecture: 'amd64', config: {} }).user, null);
    assert.equal(extractImageConfig({}).user, null);
  });

  it('Env 缺失 / 非数组 → []', () => {
    assert.deepEqual(extractImageConfig({ config: {} }).env, []);
    assert.deepEqual(extractImageConfig({ config: { Env: 'PATH=/x' } }).env, []);
    assert.deepEqual(extractImageConfig(null).env, []);
  });

  it('平台字段缺失 → null', () => {
    const r = extractImageConfig({ config: { User: 'root' } });
    assert.equal(r.os, null);
    assert.equal(r.architecture, null);
    assert.equal(r.variant, null);
  });
});
