// lib/image-ref.test.mjs — 全局唯一镜像引用解析器的单元测试
//
// 覆盖目标 Phase 8 场景 1/2：
//   1) 8 种强制镜像引用格式逐字段断言
//   2) Docker Hub 别名归一、端口/Tag 消歧、digest 校验、非法形态、变量型判定
//
// 纯离线：不发起任何网络请求。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImageReference,
  classifyRegistryHost,
  isVariableImage,
  classifyVariableOrInvalid,
  DEFAULT_REGISTRY,
  DOCKER_HUB_HOSTS,
  OFFICIAL_NAMESPACE,
  REFERENCE_KINDS,
  SOURCES,
} from './image-ref.mjs';

const DIGEST_SHA = 'sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1';

// 辅助：逐字段断言，失败时能直接指出是哪个字段出错
function assertFields(actual, expected, label) {
  assert.ok(actual, `应能解析: ${label}`);
  for (const key of Object.keys(expected)) {
    assert.equal(actual[key], expected[key], `${label} 的 ${key} 字段不符`);
  }
}

describe('image-ref：常量导出', () => {
  it('常量取值符合约定', () => {
    assert.equal(DEFAULT_REGISTRY, 'docker.io');
    assert.deepEqual([...DOCKER_HUB_HOSTS], ['docker.io', 'index.docker.io', 'registry-1.docker.io']);
    assert.equal(OFFICIAL_NAMESPACE, 'library');
    assert.equal(REFERENCE_KINDS.HARDCODED, 'hardcoded');
    assert.equal(REFERENCE_KINDS.DIGEST, 'digest');
    assert.equal(REFERENCE_KINDS.NO_TAG, 'no-tag');
    assert.equal(REFERENCE_KINDS.VARIABLE, 'variable');
    assert.equal(REFERENCE_KINDS.INVALID, 'invalid');
    assert.equal(SOURCES.DOCKERHUB, 'dockerhub');
    assert.equal(SOURCES.GHCR, 'ghcr');
    assert.equal(SOURCES.CUSTOM, 'custom');
  });
});

describe('image-ref：8 种强制引用格式（逐字段）', () => {
  it('形态 1：nginx:1.27', () => {
    assertFields(
      parseImageReference('nginx:1.27'),
      {
        registry: 'docker.io',
        namespace: 'library',
        repository: 'nginx',
        repo: 'nginx',
        tag: '1.27',
        digest: null,
        original: 'nginx:1.27',
        source: 'dockerhub',
        referenceKind: 'hardcoded',
      },
      'nginx:1.27',
    );
  });

  it('形态 2：nginx（既无 tag 也无 digest → no-tag）', () => {
    assertFields(
      parseImageReference('nginx'),
      {
        registry: 'docker.io',
        namespace: 'library',
        repository: 'nginx',
        repo: 'nginx',
        tag: null,
        digest: null,
        original: 'nginx',
        source: 'dockerhub',
        referenceKind: 'no-tag',
      },
      'nginx',
    );
  });

  it('形态 3：jellyfin/jellyfin:10.10.7（Docker Hub 命名空间）', () => {
    assertFields(
      parseImageReference('jellyfin/jellyfin:10.10.7'),
      {
        registry: 'docker.io',
        namespace: 'jellyfin',
        repository: 'jellyfin',
        repo: 'jellyfin/jellyfin',
        tag: '10.10.7',
        digest: null,
        original: 'jellyfin/jellyfin:10.10.7',
        source: 'dockerhub',
        referenceKind: 'hardcoded',
      },
      'jellyfin/jellyfin:10.10.7',
    );
  });

  it('形态 4：ghcr.io/example/app:1.2.3', () => {
    assertFields(
      parseImageReference('ghcr.io/example/app:1.2.3'),
      {
        registry: 'ghcr.io',
        namespace: 'example',
        repository: 'app',
        repo: 'example/app',
        tag: '1.2.3',
        digest: null,
        original: 'ghcr.io/example/app:1.2.3',
        source: 'ghcr',
        referenceKind: 'hardcoded',
      },
      'ghcr.io/example/app:1.2.3',
    );
  });

  it('形态 5：ghcr.io:5000/example/app:1.2.3（端口属于 registry，不是 tag）', () => {
    assertFields(
      parseImageReference('ghcr.io:5000/example/app:1.2.3'),
      {
        registry: 'ghcr.io:5000',
        namespace: 'example',
        repository: 'app',
        repo: 'example/app',
        tag: '1.2.3',
        digest: null,
        original: 'ghcr.io:5000/example/app:1.2.3',
        source: 'custom',
        referenceKind: 'hardcoded',
      },
      'ghcr.io:5000/example/app:1.2.3',
    );
  });

  it('形态 6：registry.example.com:8443/team/subteam/app:stable（多级路径）', () => {
    assertFields(
      parseImageReference('registry.example.com:8443/team/subteam/app:stable'),
      {
        registry: 'registry.example.com:8443',
        namespace: 'team',
        repository: 'subteam/app',
        repo: 'team/subteam/app',
        tag: 'stable',
        digest: null,
        original: 'registry.example.com:8443/team/subteam/app:stable',
        source: 'custom',
        referenceKind: 'hardcoded',
      },
      'registry.example.com:8443/team/subteam/app:stable',
    );
  });

  it('形态 7：registry.example.com/team/app@sha256:…（只有 digest → digest 类型）', () => {
    assertFields(
      parseImageReference(`registry.example.com/team/app@${DIGEST_SHA}`),
      {
        registry: 'registry.example.com',
        namespace: 'team',
        repository: 'app',
        repo: 'team/app',
        tag: null,
        digest: DIGEST_SHA,
        original: `registry.example.com/team/app@${DIGEST_SHA}`,
        source: 'custom',
        referenceKind: 'digest',
      },
      'registry.example.com/team/app@digest',
    );
  });

  it('形态 8：ghcr.io/example/app:1.2.3@sha256:…（tag 与 digest 复合格式）', () => {
    assertFields(
      parseImageReference(`ghcr.io/example/app:1.2.3@${DIGEST_SHA}`),
      {
        registry: 'ghcr.io',
        namespace: 'example',
        repository: 'app',
        repo: 'example/app',
        tag: '1.2.3',
        digest: DIGEST_SHA,
        original: `ghcr.io/example/app:1.2.3@${DIGEST_SHA}`,
        source: 'ghcr',
        referenceKind: 'hardcoded',
      },
      'ghcr.io/example/app:1.2.3@digest',
    );
  });
});

describe('image-ref：Docker Hub 别名归一', () => {
  // 注意：当前实现只把「来源」归一为 dockerhub，registry 字段保留用户写的原始主机名
  // （docker.io / index.docker.io / registry-1.docker.io 三者都属 dockerhub 来源）。
  // 若后续实现把 registry 也强制归一为 'docker.io'，本用例需要同步更新。
  it('docker.io / index.docker.io / registry-1.docker.io 一律判定为 dockerhub 来源', () => {
    const cases = [
      ['docker.io/library/nginx:1.25', 'docker.io', 'library/nginx'],
      ['index.docker.io/nginx:1.25', 'index.docker.io', 'nginx'],
      ['registry-1.docker.io/nginx:1.25', 'registry-1.docker.io', 'nginx'],
    ];
    for (const [image, registry, repo] of cases) {
      const r = parseImageReference(image);
      assert.ok(r, `应能解析: ${image}`);
      assert.equal(r.registry, registry, `${image} 的 registry`);
      assert.equal(r.repo, repo, `${image} 的 repo`);
      assert.equal(r.source, 'dockerhub', `${image} 的 source`);
      assert.equal(r.tag, '1.25', `${image} 的 tag`);
    }
  });

  it('三个 Docker Hub 别名都归到同一个 source 分类', () => {
    for (const host of DOCKER_HUB_HOSTS) {
      assert.equal(classifyRegistryHost(host), 'dockerhub', `${host} 应为 dockerhub 来源`);
    }
  });

  it('docker.io 单段镜像同样补齐 library 命名空间', () => {
    const r = parseImageReference('docker.io/nginx:1.25');
    assert.equal(r.namespace, 'library');
    assert.equal(r.repository, 'nginx');
  });
});

describe('image-ref：端口与 Tag 消歧', () => {
  it('host:port/path:tag 中端口归 registry，tag 仍是 tag', () => {
    const r = parseImageReference('registry.example.com:8443/team/app:1.0');
    assert.equal(r.registry, 'registry.example.com:8443');
    assert.equal(r.tag, '1.0');
    assert.equal(r.repo, 'team/app');
  });

  it('path/name:tag 中的冒号是 tag，不是端口', () => {
    const r = parseImageReference('jellyfin/jellyfin:10.10.7');
    assert.equal(r.registry, 'docker.io');
    assert.equal(r.tag, '10.10.7');
  });

  it('端口 + 多级路径同时存在时两者都正确', () => {
    const r = parseImageReference('registry.example.com:5000/a/b/c:stable');
    assert.equal(r.registry, 'registry.example.com:5000');
    assert.equal(r.namespace, 'a');
    assert.equal(r.repository, 'b/c');
    assert.equal(r.repo, 'a/b/c');
    assert.equal(r.tag, 'stable');
  });

  it('无端口的 host/path:tag 不被误判为带端口', () => {
    const r = parseImageReference('registry.example.com/team/app:stable');
    assert.equal(r.registry, 'registry.example.com');
    assert.equal(r.tag, 'stable');
  });
});

describe('image-ref：digest 校验', () => {
  it('digest 缺少算法:内容 形式一律 null', () => {
    for (const image of ['nginx@sha256', 'nginx@:abc', 'nginx@sha256:']) {
      assert.equal(parseImageReference(image), null, `应解析失败: ${image}`);
    }
  });

  it('合法 digest 可解析', () => {
    const r = parseImageReference(`nginx@${DIGEST_SHA}`);
    assert.ok(r);
    assert.equal(r.digest, DIGEST_SHA);
    assert.equal(r.tag, null);
    assert.equal(r.referenceKind, 'digest');
  });
});

describe('image-ref：非法形态一律 null', () => {
  it('表驱动非法字符串', () => {
    const invalid = [
      '',                       // 空串
      '   ',                    // 全空白
      ' nginx',                 // 前导空白
      'nginx ',                 // 尾部空白
      'ng inx:1.0',             // 内部空白
      'nginx:1.0 1.1',          // 内部空白
      'nginx:${TAG}',           // 未展开的 compose 变量
      'nginx$',                 // 含 $
      'nginx?x=1',              // 含 ?
      'nginx#frag',             // 含 #
      ':1.0',                   // 空 repo
      'nginx:',                 // 空 tag
      'ghcr.io//org/repo',      // 路径中出现 //
      'ghcr.io/org//repo',      // 路径中出现 //
      'foo//bar',               // 路径中出现 //
      '/nginx',                 // 前导斜杠
      'nginx/',                 // 尾部斜杠
    ];
    for (const image of invalid) {
      assert.equal(parseImageReference(image), null, `应解析失败: ${JSON.stringify(image)}`);
    }
  });

  it('非字符串输入一律 null', () => {
    assert.equal(parseImageReference(null), null);
    assert.equal(parseImageReference(undefined), null);
    assert.equal(parseImageReference(123), null);
    assert.equal(parseImageReference({}), null);
  });
});

describe('image-ref：变量型与非法分类', () => {
  it('变量型镜像：isVariableImage=true，classifyVariableOrInvalid=variable', () => {
    assert.equal(isVariableImage('${IMAGE}:${APP_VERSION}'), true);
    assert.equal(classifyVariableOrInvalid('${IMAGE}:${APP_VERSION}'), 'variable');
  });

  it('变量型镜像不进入硬编码解析（parseImageReference 返回 null）', () => {
    assert.equal(parseImageReference('${IMAGE}:${APP_VERSION}'), null);
  });

  it('非法字符串：isVariableImage=false，classifyVariableOrInvalid=invalid', () => {
    assert.equal(isVariableImage('nginx:1.0 1.1'), false);
    assert.equal(classifyVariableOrInvalid('nginx:1.0 1.1'), 'invalid');
    assert.equal(classifyVariableOrInvalid(''), 'invalid');
    assert.equal(classifyVariableOrInvalid(null), 'invalid');
  });
});

describe('image-ref：registry 来源分类', () => {
  it('classifyRegistryHost 表驱动', () => {
    assert.equal(classifyRegistryHost('docker.io'), 'dockerhub');
    assert.equal(classifyRegistryHost('index.docker.io'), 'dockerhub');
    assert.equal(classifyRegistryHost('registry-1.docker.io'), 'dockerhub');
    assert.equal(classifyRegistryHost(null), 'dockerhub');
    assert.equal(classifyRegistryHost(undefined), 'dockerhub');
    assert.equal(classifyRegistryHost('ghcr.io'), 'ghcr');
    assert.equal(classifyRegistryHost('ghcr.io:5000'), 'custom');
    assert.equal(classifyRegistryHost('localhost:5000'), 'custom');
  });
});

describe('image-ref：original 往返一致性', () => {
  it('每个合法用例的 original 与输入完全一致', () => {
    const valid = [
      'nginx:1.27',
      'nginx',
      'jellyfin/jellyfin:10.10.7',
      'ghcr.io/example/app:1.2.3',
      'ghcr.io:5000/example/app:1.2.3',
      'registry.example.com:8443/team/subteam/app:stable',
      `registry.example.com/team/app@${DIGEST_SHA}`,
      `ghcr.io/example/app:1.2.3@${DIGEST_SHA}`,
      'docker.io/library/nginx:1.25',
      'index.docker.io/nginx:1.25',
      'registry-1.docker.io/nginx:1.25',
      'localhost:5000/app:1.0',
    ];
    for (const image of valid) {
      const r = parseImageReference(image);
      assert.ok(r, `应能解析: ${image}`);
      assert.equal(r.original, image, `original 应与输入一致: ${image}`);
    }
  });
});
