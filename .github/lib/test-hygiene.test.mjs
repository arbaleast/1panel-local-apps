// .github/lib/test-hygiene.test.mjs
//
// **测试隔离守卫**：测试进程绝不能冒充生产写入 GitHub Actions 的输出文件。
//
// 事故（2026-11-05）：`.github/lib/detect-updates-e2e.test.mjs` 的 `runDetect()`
// 把 `...process.env` 原样传给子进程 → CI 里 `GITHUB_STEP_SUMMARY` 被 detect 脚本
// 继承 → 每跑一次 detect 就往**真 step summary** 追加一段「detect-updates 检测汇总」。
// 6 个用例刷出 6 段（扫描应用数 1/1/1/1/2/4，正好对上 6 次 runDetect），
// CI 页面上的 step summary 完全被测试输出淹没。
//
// 本文件锁死两条不变量：
//   1. 静态：测试文件里出现 `GITHUB_STEP_SUMMARY` 等变量时，只能出现在
//      「从子进程 env 里删除它」或注释里，**不得**把它传下去。
//   2. 行为：detect 链路的 E2E 在 `GITHUB_STEP_SUMMARY` 指向真实文件时跑完，
//      该文件必须**一个字节都不写**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIB = path.join(ROOT, '.github', 'lib');

/** Actions 的输出文件变量（被子进程继承就会污染 CI 输出） */
const ACTIONS_OUTPUT_VARS = [
  'GITHUB_STEP_SUMMARY',
  'GITHUB_OUTPUT',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_STATE',
];

describe('测试隔离守卫：不得污染 CI 输出文件', () => {
  it('测试文件不得把 Actions 输出变量**作为 env 属性**传给子进程', () => {
    // 只认「对象字面量里的属性赋值」这一种真传参形态：
    //   env: { ...process.env, GITHUB_STEP_SUMMARY: summary }   ← 违规
    // 而 `.includes('GITHUB_STEP_SUMMARY')`（对 YAML 文本做字符串比对）不是传参 → 不算。
    const assignment = new RegExp(`(^|[,{\\s])(${ACTIONS_OUTPUT_VARS.join('|')})\\s*:`);
    const offenders = [];
    for (const name of fs.readdirSync(LIB).filter(n => n.endsWith('.test.mjs'))) {
      // 本文件自身就是守卫：它的行为验证**故意**把变量传给子进程（验证子进程不写）
      if (name === path.basename(fileURLToPath(import.meta.url))) continue;
      const lines = fs.readFileSync(path.join(LIB, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (/delete\s+env\[/.test(line)) return;
        if (/^\s*'GITHUB_[A-Z_]+',\s*$/.test(line)) return; // 清单数组元素
        if (assignment.test(line)) {
          offenders.push(`${name}:${i + 1}  ${trimmed}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `测试文件把 Actions 输出变量作为 env 属性传给了子进程（会污染 CI step summary）:\n${offenders.join('\n')}`,
    );
  });

  it('行为验证：detect E2E 跑完不得写 GITHUB_STEP_SUMMARY', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'));
    const summary = path.join(tmp, 'step-summary.md');
    fs.writeFileSync(summary, '');
    try {
      const res = spawnSync(
        process.execPath,
        ['--test', path.join(LIB, 'detect-updates-e2e.test.mjs')],
        {
          encoding: 'utf8',
          cwd: ROOT,
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
          timeout: 120000,
        },
      );
      assert.equal(res.status, 0, `detect E2E 应通过，stderr:\n${res.stderr}`);
      const written = fs.readFileSync(summary, 'utf8');
      assert.equal(
        written.length,
        0,
        `测试进程写进了 CI step summary（${written.length} 字节），测试必须剔除 GITHUB_STEP_SUMMARY：\n${written.slice(0, 500)}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
