// .github/lib/compose-cli-check.test.mjs
//
// 阶段 2「`docker compose config` 真实渲染校验」的回归测试。
//
// 关键不变量：
//   1. **CLI 不可用时必须降级**，且降级原因可读 —— 绝不把「没跑 compose」说成「compose config 通过」。
//   2. 校验时写的是**原始 compose + .env**（不是预先插值后的 YAML），
//      让 compose 自己做插值 —— 这样 `${VAR:?msg}` 之类的失败才会被真正抓到。
//   3. 临时目录必须在结束后清掉（不留宿主机残留）。
//
// 测试全部用**注入的 spawn stub**，绝不真的调用 docker。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectComposeCli, checkComposeWithCli } from '../bin/compose-cli-check.mjs';

test('detectComposeCli：CLI 可用 → available=true 并回传版本', () => {
  const spawn = () => ({ status: 0, stdout: 'Docker Compose version v2.29.0\n', stderr: '' });
  const r = detectComposeCli({ spawn });
  assert.equal(r.available, true);
  assert.match(r.version, /v2\.29\.0/);
  assert.equal(r.reason, null);
});

test('detectComposeCli：CLI 不存在 → available=false 且 reason 非空', () => {
  const spawn = () => { const e = new Error('spawn docker ENOENT'); throw e; };
  const r = detectComposeCli({ spawn });
  assert.equal(r.available, false);
  assert.ok(r.reason && r.reason.length > 0);
});

test('detectComposeCli：非零退出 → available=false 且 reason 含退出码', () => {
  const spawn = () => ({ status: 127, stdout: '', stderr: 'docker: command not found' });
  const r = detectComposeCli({ spawn });
  assert.equal(r.available, false);
  assert.match(r.reason, /127/);
});

test('checkComposeWithCli：compose 解析失败 → ok=false 且 error 含 compose 的 stderr', () => {
  const spawn = () => ({ status: 1, stdout: '', stderr: 'service "app" refers to undefined variable X' });
  const r = checkComposeWithCli(
    { composeRaw: 'services:\n  app:\n    image: nginx\n', env: { X: '1' }, label: 'demo/1.0.0/docker-compose.yml' },
    { spawn },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /undefined variable X/);
});

test('checkComposeWithCli：compose 解析成功 → ok=true', () => {
  const spawn = () => ({ status: 0, stdout: 'name: demo\n', stderr: '' });
  const r = checkComposeWithCli(
    { composeRaw: 'services:\n  app:\n    image: nginx\n', env: {}, label: 'demo/1.0.0/docker-compose.yml' },
    { spawn },
  );
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
});

test('checkComposeWithCli：写给 compose 的是**原始 compose + .env**（不是插值后的 YAML）', () => {
  let seen = null;
  const spawn = (cmd, args, opts) => {
    // 临时目录会在调用结束后被清掉 → 必须在 spawn 回调里就地读取内容
    const fIdx = args.indexOf('-f');
    const composeFile = args[fIdx + 1];
    seen = {
      cmd,
      args,
      composeFile,
      composeText: fs.readFileSync(composeFile, 'utf8'),
      envText: fs.readFileSync(path.join(path.dirname(composeFile), '.env'), 'utf8'),
    };
    return { status: 0, stdout: '', stderr: '' };
  };
  const raw = 'services:\n  app:\n    image: nginx:${TAG}\n';
  checkComposeWithCli({ composeRaw: raw, env: { TAG: '1.25' }, label: 'demo/1.0.0/docker-compose.yml' }, { spawn });
  assert.ok(seen, 'spawn 应被调用');
  assert.equal(seen.cmd, 'docker');
  assert.ok(seen.args.includes('config'));
  // compose 文件必须在临时目录里（-f 指向临时路径），且内容仍是原始文本
  assert.ok(seen.composeFile.includes('1panel-compose-cfg-'));
  assert.equal(seen.composeText, raw);
  // .env 必须写入 1Panel 上下文变量
  assert.match(seen.envText, /^TAG=1\.25$/m);
});

test('checkComposeWithCli：结束后不残留临时目录', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('1panel-compose-cfg-'));
  const spawn = () => ({ status: 0, stdout: '', stderr: '' });
  checkComposeWithCli({ composeRaw: 'services: {}\n', env: {}, label: 'demo/1.0.0/docker-compose.yml' }, { spawn });
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('1panel-compose-cfg-'));
  assert.deepEqual(after, before);
});
