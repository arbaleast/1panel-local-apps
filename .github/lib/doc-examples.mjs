// .github/lib/doc-examples.mjs
// 文档中的 data.yml 示例 vs 真实 schema 的一致性校验（纯函数，仅 js-yaml）。
//
// 为什么需要它：
//   docs/data-yml-schema.md、docs/app-structure.md 里手写着 data.yml 示例，
//   但它们从来没有被真实 schema 校验过——示例里写错 type / rule / 必填字段时，
//   文档会与 lint 的实际口径静默分叉（这正是「文档一致性」的经典失守点）。
//   本模块把示例也纳入 lint 同一套规则（lib/schema.mjs 的纯函数），
//   使「文档示例」与「真实 schema」永远保持一致。
//
// 占位符容忍：
//   文档示例是示意性的（含 `<app-key>`、`...` 之类占位），不是可安装的真实文件。
//   因此只校验「能确定判定」的规则（枚举取值、必填字段、formField 结构与白名单），
//   对占位值不做判定，避免制造无意义的噪音。

import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateFormField,
  validateUrlField,
  ROOT_REQUIRED_FIELDS,
  TYPE_ENUM,
} from './schema.mjs';

/** 明显的占位值：不含可判定信息 */
function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return true;
  if (v === '...') return true;
  // <app-key> / <应用显示名> / xxx 之类
  return /^<[^>]*>$/.test(v) || /^\.{2,}$/.test(v) || /^x{2,}$/i.test(v);
}

/**
 * 从 markdown 中抽取围栏代码块（```lang ... ```）。
 *
 * @param {string} markdown
 * @returns {{lang: string, content: string, startLine: number}[]}
 */
export function extractCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let current = null;
  lines.forEach((line, i) => {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (!fence) {
      if (current) current.content.push(line);
      return;
    }
    if (current) {
      blocks.push({ lang: current.lang, content: current.content.join('\n'), startLine: current.startLine });
      current = null;
    } else {
      current = { lang: fence[1] || '', content: [], startLine: i + 1 };
    }
  });
  return blocks;
}

/**
 * 判断一个解析后的对象是否像 data.yml（含 additionalProperties）。
 * @param {unknown} obj
 */
export function isDataYmlLike(obj) {
  return Boolean(obj && typeof obj === 'object' && !Array.isArray(obj) && obj.additionalProperties);
}

/**
 * 校验一个 data.yml 示例对象（根级或版本级形态）。
 *
 * @param {unknown} obj 解析后的 YAML 对象
 * @param {string} path 报错定位用（如 'docs/data-yml-schema.md:33'）
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateDataYmlExample(obj, path) {
  const errors = [];
  if (!isDataYmlLike(obj)) {
    errors.push(`${path}: 示例不是 data.yml 形态（缺少 additionalProperties）`);
    return errors;
  }
  const ap = obj.additionalProperties;
  if (!ap || typeof ap !== 'object' || Array.isArray(ap)) {
    errors.push(`${path}: additionalProperties 必须是对象`);
    return errors;
  }

  // 1) 必填字段
  for (const field of ROOT_REQUIRED_FIELDS) {
    if (ap[field] === undefined) {
      errors.push(`${path}: additionalProperties 缺少必填字段 \`${field}\``);
    }
  }

  // 2) type 枚举
  if (ap.type !== undefined && !isPlaceholder(ap.type) && !TYPE_ENUM.includes(ap.type)) {
    errors.push(
      `${path}: additionalProperties.type = ${JSON.stringify(ap.type)}，合法值只有 ${TYPE_ENUM.join(' / ')}`,
    );
  }

  // 3) formFields 结构与白名单（占位条目跳过）
  if (ap.formFields !== undefined) {
    if (!Array.isArray(ap.formFields)) {
      errors.push(`${path}: additionalProperties.formFields 必须是数组`);
    } else {
      ap.formFields.forEach((field, i) => {
        if (field === null || typeof field !== 'object' || Array.isArray(field)) {
          // 形如 `- ...` 的示意占位，跳过
          return;
        }
        for (const err of validateFormField(field, `${path}.formFields[${i}]`)) {
          errors.push(err);
        }
      });
    }
  }

  // 4) URL 字段（占位 URL 跳过）
  for (const fieldName of ['website', 'github', 'logo']) {
    const val = ap[fieldName];
    if (val === undefined || isPlaceholder(val)) continue;
    for (const err of validateUrlField(val, fieldName, path)) {
      errors.push(err);
    }
  }

  return errors;
}

/**
 * 扫描一批 markdown 文件里的 data.yml 示例并校验。
 *
 * @param {string} repoRoot
 * @param {string[]} relFiles 相对 repoRoot 的 markdown 路径
 * @returns {{errors: string[], checked: number}}
 */
export function checkDocExamples(repoRoot, relFiles) {
  const errors = [];
  let checked = 0;
  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    for (const block of extractCodeBlocks(text)) {
      if (!/^ya?ml$/i.test(block.lang)) continue;
      let parsed;
      try {
        parsed = yaml.load(block.content);
      } catch (e) {
        errors.push(`${rel}:${block.startLine}: 示例 YAML 解析失败: ${e.message}`);
        continue;
      }
      if (!isDataYmlLike(parsed)) continue;
      checked += 1;
      const path = `${rel}:${block.startLine}`;
      errors.push(...validateDataYmlExample(parsed, path));
    }
  }
  return { errors, checked };
}
