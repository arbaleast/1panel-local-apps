// .github/lib/compose-render.test.mjs
// 覆盖 .github/lib/compose-render.mjs 的 1Panel 上下文模拟渲染。
//
// 锁死的关键语义：
//   1. 回归锚点：${ZIM_FILES}='*.zim' 插值后不得被当成 YAML alias、不得报错；
//   2. compose 变量插值的 6 种形态（${} / :- / - / :? / ? / $$ 转义）；
//   3. 字符串叶子才插值，数字/布尔/null 原样保留；
//   4. 纯函数性：buildPanelEnv 不修改传入的 fields。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import {
  PANEL_BUILTIN_ENV,
  synthValueForField,
  buildPanelEnv,
  interpolateValue,
  interpolateCompose,
  renderCompose,
} from './compose-render.mjs';

// ── 1. 回归锚点：*.zim 不得被当成 YAML alias ─────────────────
describe('回归锚点：${ZIM_FILES}=*.zim', () => {
  it('插值后不得报错，值保持字符串 "*.zim"', () => {
    const doc = { command: ['${ZIM_FILES}'] };
    const out = renderCompose(doc, { ZIM_FILES: '*.zim' });
    assert.equal(out.ok, true);
    assert.equal(out.error, null);
    assert.deepEqual(out.doc.command, ['*.zim']);
    assert.deepEqual(out.unresolved, []);
  });

  it('dump 后仍是普通字符串（不是 alias），可被重新 load 回来', () => {
    const out = renderCompose({ command: ['${ZIM_FILES}'] }, { ZIM_FILES: '*.zim' });
    const text = yaml.dump(out.doc);
    assert.match(text, /'\*\.zim'/);
    const back = yaml.load(text);
    assert.deepEqual(back.command, ['*.zim']);
  });

  it('对照坑：先文本替换再 yaml.load 会因 alias 失败（故必须先 load 再插值）', () => {
    // 源 compose 里占位符未加引号：`- ${ZIM_FILES}`
    const raw = 'command:\n  - ${ZIM_FILES}\n';
    // 错误路径：文本替换后再 load → `*.zim` 被 YAML 当成 alias → 解析失败
    assert.throws(() => yaml.load(raw.replace('${ZIM_FILES}', '*.zim')), /alias/);
    // 正确路径：先 load（此时还是普通字符串）→ 插值 → dump
    const parsed = yaml.load(raw);
    const out = renderCompose(parsed, { ZIM_FILES: '*.zim' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.doc.command, ['*.zim']);
  });
});

// ── 2. synthValueForField ─────────────────────────────────────
describe('synthValueForField', () => {
  it('有 default → 用 String(default)（数字型 default 也字符串化）', () => {
    assert.equal(synthValueForField({ type: 'number', default: 8080 }), '8080');
    assert.equal(synthValueForField({ type: 'text', default: 'hello' }), 'hello');
  });

  it('default 为空串 / undefined / null → 走合成分支', () => {
    assert.equal(synthValueForField({ type: 'number', default: '' }), '1024');
    assert.equal(synthValueForField({ type: 'number', default: undefined }), '1024');
    assert.equal(synthValueForField({ type: 'number', default: null }), '1024');
  });

  it('number → 1024', () => {
    assert.equal(synthValueForField({ type: 'number' }), '1024');
  });

  it('password → 固定假密钥 smoke-not-a-real-secret', () => {
    assert.equal(synthValueForField({ type: 'password' }), 'smoke-not-a-real-secret');
  });

  it('select → values[0].value', () => {
    assert.equal(
      synthValueForField({ type: 'select', values: [{ label: 'A', value: 'alpha' }, { value: 'beta' }] }),
      'alpha'
    );
  });

  it('select 缺 values / values 为空 → smoke', () => {
    assert.equal(synthValueForField({ type: 'select' }), 'smoke');
    assert.equal(synthValueForField({ type: 'select', values: [] }), 'smoke');
  });

  it('service → 127.0.0.1', () => {
    assert.equal(synthValueForField({ type: 'service' }), '127.0.0.1');
  });

  it('apps → 空串', () => {
    assert.equal(synthValueForField({ type: 'apps' }), '');
  });

  it('text → smoke；rule=paramPath → /tmp/smoke', () => {
    assert.equal(synthValueForField({ type: 'text' }), 'smoke');
    assert.equal(synthValueForField({ type: 'text', rule: 'paramPath' }), '/tmp/smoke');
  });

  it('未知 type → 退化为 text 规则', () => {
    assert.equal(synthValueForField({ type: 'weird' }), 'smoke');
    assert.equal(synthValueForField({}), 'smoke');
  });
});

// ── 3. buildPanelEnv ──────────────────────────────────────────
describe('buildPanelEnv', () => {
  it('内置 6 变量都在 env 里', () => {
    const { env } = buildPanelEnv([]);
    assert.equal(env.CONTAINER_NAME, 'smoke_container');
    assert.equal(env.HOST_IP, '127.0.0.1');
    assert.equal(env.HOST_ADDRESS, '127.0.0.1');
    assert.equal(env.PANEL_DB_PORT, '3306');
    assert.equal(env.CPUS, '1');
    assert.equal(env.MEMORY_LIMIT, '512M');
    assert.equal(Object.keys(PANEL_BUILTIN_ENV).length, 6);
  });

  it('opts.builtins 可覆盖内置变量', () => {
    const { env } = buildPanelEnv([], { builtins: { HOST_IP: '10.0.0.2' } });
    assert.equal(env.HOST_IP, '10.0.0.2');
    assert.equal(env.HOST_ADDRESS, '127.0.0.1');
  });

  it('必填无 default → 进 synthesized；有 default → 不进', () => {
    const { env, synthesized, declared, missing } = buildPanelEnv([
      { envKey: 'NO_DEFAULT', type: 'number', required: true },
      { envKey: 'WITH_DEFAULT', type: 'text', default: 'v1' },
    ]);
    assert.equal(env.NO_DEFAULT, '1024');
    assert.equal(env.WITH_DEFAULT, 'v1');
    assert.deepEqual(synthesized, ['NO_DEFAULT']);
    assert.deepEqual(declared, ['NO_DEFAULT', 'WITH_DEFAULT']);
    assert.deepEqual(missing, []);
  });

  it('所有 env 值都是字符串', () => {
    const { env } = buildPanelEnv([{ envKey: 'A', type: 'number', default: 80 }]);
    assert.equal(typeof env.A, 'string');
  });
});

// ── 4. interpolateValue ───────────────────────────────────────
describe('interpolateValue', () => {
  it('${VAR} → 取值', () => {
    const r = interpolateValue('a-${VAR}-b', { VAR: 'x' });
    assert.equal(r.value, 'a-x-b');
    assert.equal(r.error, null);
    assert.deepEqual(r.unresolved, []);
  });

  it('${VAR} 未定义 → 留空并记入 unresolved', () => {
    const r = interpolateValue('${NOPE}', {});
    assert.equal(r.value, '');
    assert.deepEqual(r.unresolved, ['NOPE']);
    assert.equal(r.error, null);
  });

  it('${VAR:-d} 未定义或空串 → d', () => {
    assert.equal(interpolateValue('${V:-d}', {}).value, 'd');
    assert.equal(interpolateValue('${V:-d}', { V: '' }).value, 'd');
    assert.equal(interpolateValue('${V:-d}', { V: 'x' }).value, 'x');
    assert.deepEqual(interpolateValue('${V:-d}', {}).unresolved, []);
  });

  it('${VAR-d} 仅未定义 → d（空串保留空串）', () => {
    assert.equal(interpolateValue('${V-d}', {}).value, 'd');
    assert.equal(interpolateValue('${V-d}', { V: '' }).value, '');
    assert.equal(interpolateValue('${V-d}', { V: 'x' }).value, 'x');
  });

  it('${VAR:?msg} 未定义或空串 → error=msg', () => {
    const r1 = interpolateValue('${V:?boom}', {});
    assert.equal(r1.error, 'boom');
    const r2 = interpolateValue('${V:?boom}', { V: '' });
    assert.equal(r2.error, 'boom');
    assert.equal(interpolateValue('${V:?boom}', { V: 'x' }).error, null);
    assert.equal(interpolateValue('${V:?boom}', { V: 'x' }).value, 'x');
  });

  it('${VAR?msg} 仅未定义 → error=msg（空串不报错）', () => {
    assert.equal(interpolateValue('${V?boom}', {}).error, 'boom');
    assert.equal(interpolateValue('${V?boom}', { V: '' }).error, null);
    assert.equal(interpolateValue('${V?boom}', { V: '' }).value, '');
  });

  it('$$VAR → 字面 $VAR，不插值', () => {
    const r = interpolateValue('$$VAR and ${VAR}', { VAR: 'x' });
    assert.equal(r.value, '$VAR and x');
    assert.deepEqual(r.unresolved, []);
  });

  it('多个未定义变量去重记入 unresolved', () => {
    const r = interpolateValue('${A}-${B}-${A}', {});
    assert.deepEqual(r.unresolved, ['A', 'B']);
  });
});

// ── 5. interpolateCompose ─────────────────────────────────────
describe('interpolateCompose', () => {
  it('嵌套对象与数组里的字符串都被插值', () => {
    const doc = {
      services: {
        app: {
          container_name: '${CONTAINER_NAME}',
          command: ['${ZIM_FILES}', 'run', '--port=${PORT}'],
          environment: { TZ: '${TZ:-Asia/Shanghai}' },
        },
      },
    };
    const r = interpolateCompose(doc, { CONTAINER_NAME: 'c1', ZIM_FILES: '*.zim', PORT: '8080' });
    assert.equal(r.error, null);
    assert.equal(r.doc.services.app.container_name, 'c1');
    assert.deepEqual(r.doc.services.app.command, ['*.zim', 'run', '--port=8080']);
    assert.equal(r.doc.services.app.environment.TZ, 'Asia/Shanghai');
  });

  it('非字符串叶子（数字/布尔/null）原样保留', () => {
    const doc = { a: 1, b: true, c: null, d: 3.5 };
    const r = interpolateCompose(doc, {});
    assert.equal(r.doc.a, 1);
    assert.equal(r.doc.b, true);
    assert.equal(r.doc.c, null);
    assert.equal(r.doc.d, 3.5);
  });

  it('未定义变量记入 unresolved（跨嵌套聚合去重）', () => {
    const doc = { x: '${MISSING}', y: { z: ['${MISSING}', '${OTHER}'] } };
    const r = interpolateCompose(doc, {});
    assert.deepEqual(r.unresolved, ['MISSING', 'OTHER']);
    assert.equal(r.error, null);
  });
});

// ── 6. renderCompose ──────────────────────────────────────────
describe('renderCompose', () => {
  it('正常 → ok=true，error=null', () => {
    const out = renderCompose({ services: { app: { image: 'r/a:1' } } }, {});
    assert.equal(out.ok, true);
    assert.equal(out.error, null);
    assert.equal(out.doc.services.app.image, 'r/a:1');
  });

  it('触发 ${VAR:?msg} → ok=false，error 含 msg，doc=null', () => {
    const out = renderCompose({ services: { app: { command: '${PORT:?端口必须设置}' } } }, {});
    assert.equal(out.ok, false);
    assert.match(out.error, /端口必须设置/);
    assert.equal(out.doc, null);
  });

  it('env 缺失某变量 → unresolved 非空但 ok=true', () => {
    const out = renderCompose({ services: { app: { command: 'run ${MISSING}' } } }, {});
    assert.equal(out.ok, true);
    assert.equal(out.error, null);
    assert.deepEqual(out.unresolved, ['MISSING']);
    assert.equal(out.doc.services.app.command, 'run ');
  });
});

// ── 7. 纯函数性 ───────────────────────────────────────────────
describe('纯函数性', () => {
  it('buildPanelEnv 不修改传入的 fields（深冻结下也不抛错）', () => {
    const fields = [
      { envKey: 'A', type: 'number' },
      { envKey: 'B', type: 'text', default: 'v' },
    ];
    const snapshot = JSON.stringify(fields);
    const deepFreeze = (obj) => {
      if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        for (const v of Object.values(obj)) deepFreeze(v);
      }
      return obj;
    };
    deepFreeze(fields);
    const r = buildPanelEnv(fields);
    assert.equal(r.env.A, '1024');
    assert.equal(r.env.B, 'v');
    assert.equal(JSON.stringify(fields), snapshot);
  });

  it('buildPanelEnv 不修改传入的 builtins', () => {
    const builtins = { HOST_IP: '10.0.0.2' };
    buildPanelEnv([], { builtins });
    assert.deepEqual(builtins, { HOST_IP: '10.0.0.2' });
  });

  it('interpolateCompose 不修改传入的 doc', () => {
    const doc = { services: { app: { command: ['${X}'] } } };
    interpolateCompose(doc, { X: 'v' });
    assert.deepEqual(doc.services.app.command, ['${X}']);
  });
});
