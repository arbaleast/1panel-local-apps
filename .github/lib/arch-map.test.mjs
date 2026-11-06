// lib/arch-map.test.mjs — 架构映射与木桶交集计算的单元测试
//
// 覆盖目标 §五.3（CPU 多架构兼容性核验）的映射与集合运算基础：
//   1) 版本目录名 → 架构变体推断
//   2) GPU 变体目录判定
//   3) 多集合交集与木桶效应（含「未核实」语义）
//   4) 声明 vs 实际的差集
//
// 纯离线：不发起任何网络请求。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_ARCHS,
  archFromVersionDir,
  isGpuVariantDir,
  intersectArchs,
  effectiveArch,
  diffDeclared,
} from './arch-map.mjs';

describe('arch-map：REPO_ARCHS 常量', () => {
  it('仓库支持的架构集合固定', () => {
    assert.deepEqual([...REPO_ARCHS], ['amd64', 'arm64', 'arm/v7', '386']);
    assert.ok(Object.isFrozen(REPO_ARCHS));
  });
});

describe('arch-map：archFromVersionDir 版本目录 → 架构变体', () => {
  it('架构变体目录命中', () => {
    assert.equal(archFromVersionDir('2026091410-arm64'), 'arm64');
    assert.equal(archFromVersionDir('full-v1.12.2-arm64'), 'arm64');
    assert.equal(archFromVersionDir('v2.5.0-arm64v8'), 'arm64');
    assert.equal(archFromVersionDir('v3.2.32-arm32v7'), 'arm/v7');
  });

  it('非架构变体目录 → null', () => {
    assert.equal(archFromVersionDir('2026091410'), null);
    assert.equal(archFromVersionDir('1.11.2-ls41'), null);
    assert.equal(archFromVersionDir('server-cuda12-v0.4.9'), null);
    assert.equal(archFromVersionDir('latest'), null);
    assert.equal(archFromVersionDir('v0.3.8'), null);
  });

  it('只看最后一个 - 之后的后缀', () => {
    assert.equal(archFromVersionDir('a-b-arm64'), 'arm64');
    assert.equal(archFromVersionDir('arm64-v1.0'), null);
  });

  it('arm32vN 仅 v7 归一，其余 null', () => {
    assert.equal(archFromVersionDir('x-arm32v7'), 'arm/v7');
    assert.equal(archFromVersionDir('x-arm32v8'), null);
    assert.equal(archFromVersionDir('x-armv7'), 'arm/v7');
  });

  it('非法输入 → null', () => {
    assert.equal(archFromVersionDir(''), null);
    assert.equal(archFromVersionDir(null), null);
    assert.equal(archFromVersionDir(undefined), null);
    assert.equal(archFromVersionDir(123), null);
  });
});

describe('arch-map：isGpuVariantDir GPU 变体目录判定', () => {
  it('命中关键字的目录名 → true', () => {
    for (const dir of [
      'gpu-nvidia-latest',
      'gpu-amd-latest',
      'server-cuda12-v0.4.9',
      'server-vulkan-v0.4.9',
      '261029-cuda',
      'cu124',
    ]) {
      assert.equal(isGpuVariantDir(dir), true, `应判为 GPU 变体: ${dir}`);
    }
  });

  it('普通目录名 → false', () => {
    for (const dir of [
      '2026091410',
      '2026091410-arm64',
      'full-v1.12.2',
      'v1.0.0',
      'latest',
    ]) {
      assert.equal(isGpuVariantDir(dir), false, `不应判为 GPU 变体: ${dir}`);
    }
  });

  it('非法输入 → false', () => {
    assert.equal(isGpuVariantDir(''), false);
    assert.equal(isGpuVariantDir(null), false);
    assert.equal(isGpuVariantDir(undefined), false);
  });
});

describe('arch-map：intersectArchs 多集合交集', () => {
  it('取所有集合的公共元素（保序）', () => {
    assert.deepEqual(intersectArchs([['amd64', 'arm64'], ['arm64', 'amd64']]), ['amd64', 'arm64']);
    assert.deepEqual(intersectArchs([['amd64', 'arm64'], ['amd64']]), ['amd64']);
    assert.deepEqual(intersectArchs([['a', 'b'], ['b', 'c']]), ['b']);
  });

  it('空数组 → []', () => {
    assert.deepEqual(intersectArchs([]), []);
  });

  it('空集合参与交集 → []', () => {
    assert.deepEqual(intersectArchs([['amd64'], []]), []);
  });

  it('结果去重', () => {
    assert.deepEqual(intersectArchs([['amd64', 'amd64'], ['amd64']]), ['amd64']);
  });
});

describe('arch-map：effectiveArch 木桶效应', () => {
  it('全部集合非空 → 交集，unverified=false', () => {
    const r = effectiveArch([['amd64', 'arm64'], ['arm64', '386']]);
    assert.deepEqual(r.archs, ['arm64']);
    assert.equal(r.unverified, false);
  });

  it('单集合 → 该集合本身', () => {
    const r = effectiveArch([['amd64', 'arm64']]);
    assert.deepEqual(r.archs, ['amd64', 'arm64']);
    assert.equal(r.unverified, false);
  });

  it('⚠️ 任一集合为空 → archs=null 且 unverified=true（不得当成「无支持架构」）', () => {
    const r = effectiveArch([['amd64', 'arm64'], []]);
    assert.equal(r.archs, null, '未核实时架构必须是 null，而不是 []');
    assert.equal(r.unverified, true);
  });

  it('⚠️ 集合缺失（非数组）同样视为未核实', () => {
    const r = effectiveArch([['amd64'], null]);
    assert.equal(r.archs, null);
    assert.equal(r.unverified, true);
  });

  it('⚠️ 空输入数组 → archs=null 且 unverified=true', () => {
    const r = effectiveArch([]);
    assert.equal(r.archs, null);
    assert.equal(r.unverified, true);
  });

  it('有集合但交集为空 → archs=[] 且 unverified=false（确实无公共架构）', () => {
    const r = effectiveArch([['amd64'], ['arm64']]);
    assert.deepEqual(r.archs, []);
    assert.equal(r.unverified, false);
  });
});

describe('arch-map：diffDeclared 声明 vs 实际差集', () => {
  it('多声明：声明了但镜像未发布的架构', () => {
    const r = diffDeclared(['amd64', 'arm64', 'arm/v7'], ['amd64', 'arm64']);
    assert.deepEqual(r.overdeclared, ['arm/v7']);
    assert.deepEqual(r.underdeclared, []);
  });

  it('少声明：镜像发布了但未声明的架构', () => {
    const r = diffDeclared(['amd64'], ['amd64', 'arm64', '386']);
    assert.deepEqual(r.overdeclared, []);
    assert.deepEqual(r.underdeclared, ['arm64', '386']);
  });

  it('完全一致 → 两侧都为空', () => {
    const r = diffDeclared(['amd64', 'arm64'], ['amd64', 'arm64']);
    assert.deepEqual(r.overdeclared, []);
    assert.deepEqual(r.underdeclared, []);
  });

  it('两侧都不一致 → 两侧都有内容', () => {
    const r = diffDeclared(['amd64', 'arm64'], ['arm64', '386']);
    assert.deepEqual(r.overdeclared, ['amd64']);
    assert.deepEqual(r.underdeclared, ['386']);
  });

  it('非法输入按空数组处理', () => {
    assert.deepEqual(diffDeclared(null, null), { overdeclared: [], underdeclared: [] });
  });
});
