// lib/schema.test.mjs — data.yml 校验逻辑测试
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  validateFormField,
  validateKeyMatch,
  validateUrlField,
  normalizeFormField,
  FORMFIELD_TYPE_WHITELIST,
  FORMFIELD_RULE_WHITELIST,
} from './schema.mjs';

describe('validateFormField', () => {

  test('type=text（合法）', () => {
    const errors = validateFormField({ envKey: 'TZ', type: 'text' }, 'formFields[0].envKey=TZ');
    assert.strictEqual(errors.length, 0);
  });

  test('type=number（合法）', () => {
    const errors = validateFormField({ envKey: 'PORT', type: 'number', default: '8080' }, 'formFields[0]');
    assert.strictEqual(errors.length, 0);
  });

  test('type=number default 无法转数字', () => {
    const errors = validateFormField({ envKey: 'PORT', type: 'number', default: 'abc' }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('无法转为数字')));
  });

  test('type=select 有 values（合法）', () => {
    const field = { envKey: 'MODE', type: 'select', values: [{ label: 'a', value: 'a' }] };
    const errors = validateFormField(field, 'formFields[0]');
    assert.strictEqual(errors.length, 0);
  });

  test('type=select 缺少 values', () => {
    const errors = validateFormField({ envKey: 'MODE', type: 'select' }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('type=select 但缺少 values')));
  });

  test('type=boolean（1Panel UI 不渲染）', () => {
    const errors = validateFormField({ envKey: 'ENABLE', type: 'boolean' }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('type=boolean 在 1Panel UI 中不渲染')));
  });

  test('type 不在白名单', () => {
    const errors = validateFormField({ envKey: 'X', type: 'checkbox' }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('不在白名单内')));
  });

  test('rule 不在白名单', () => {
    const errors = validateFormField({ envKey: 'X', type: 'text', rule: 'invalidRule' }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('rule="invalidRule" 不在白名单')));
  });

  test('rule 在白名单（paramPort）', () => {
    const errors = validateFormField({ envKey: 'PORT', type: 'number', rule: 'paramPort' }, 'formFields[0]');
    assert.strictEqual(errors.length, 0);
  });

  test('label 值为非字符串', () => {
    const errors = validateFormField({ envKey: 'TZ', type: 'text', label: { zh: 123 } }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('label.zh: 值须为字符串')));
  });

  test('values 元素缺少 label/value', () => {
    const errors = validateFormField({ envKey: 'X', type: 'select', values: [{ foo: 'bar' }] }, 'formFields[0]');
    assert.ok(errors.some(e => e.includes('须有 label 和 value')));
  });

});

describe('validateKeyMatch', () => {

  test('key 与目录名一致', () => {
    const errors = validateKeyMatch('mihomo', 'mihomo', 'data.yml');
    assert.strictEqual(errors.length, 0);
  });

  test('key 与嵌套目录末段一致（anythingllm/pg）', () => {
    const errors = validateKeyMatch('pg', 'anythingllm/pg', 'data.yml');
    assert.strictEqual(errors.length, 0);
  });

  test('key 与目录名不一致', () => {
    const errors = validateKeyMatch('wrong', 'mihomo', 'data.yml');
    assert.ok(errors.some(e => e.includes('与目录名')));
    assert.ok(errors.some(e => e.includes('"mihomo" 不一致')));
  });

});

describe('validateUrlField', () => {

  test('undefined（可选字段）', () => {
    assert.strictEqual(validateUrlField(undefined, 'website', 'props').length, 0);
  });

  test('https URL（合法）', () => {
    assert.strictEqual(validateUrlField('https://example.com', 'website', 'props').length, 0);
  });

  test('http URL（合法）', () => {
    assert.strictEqual(validateUrlField('http://example.com', 'website', 'props').length, 0);
  });

  test('非 URL 格式', () => {
    const errors = validateUrlField('not-a-url', 'website', 'props');
    assert.ok(errors.some(e => e.includes('http')));
  });

  test('空字符串（可选）', () => {
    assert.strictEqual(validateUrlField('', 'website', 'props').length, 0);
  });

});

describe('normalizeFormField', () => {

  test('已有 label 对象', () => {
    const field = { envKey: 'TZ', type: 'text', label: { zh: '时区', en: 'TZ' } };
    const result = normalizeFormField(field);
    assert.deepStrictEqual(result.label, { zh: '时区', en: 'TZ' });
  });

  test('仅有 labelEn/labelZh，补充 label 对象', () => {
    const field = { envKey: 'TZ', type: 'text', labelEn: 'TZ', labelZh: '时区' };
    const result = normalizeFormField(field);
    assert.deepStrictEqual(result.label, { en: 'TZ', zh: '时区' });
  });

  test('无 label 无 labelEn/labelZh，保持原样', () => {
    const field = { envKey: 'TZ', type: 'text' };
    const result = normalizeFormField(field);
    assert.strictEqual(result.label, undefined);
  });

});

describe('WHITELIST 常量', () => {

  test('FORMFIELD_TYPE_WHITELIST 包含 6 种合法 type', () => {
    const types = ['text', 'number', 'password', 'service', 'select', 'apps'];
    for (const t of types) {
      assert.ok(FORMFIELD_TYPE_WHITELIST.has(t), `应有 ${t}`);
    }
    assert.ok(!FORMFIELD_TYPE_WHITELIST.has('boolean'));
    assert.ok(!FORMFIELD_TYPE_WHITELIST.has('checkbox'));
  });

  test('FORMFIELD_RULE_WHITELIST 包含所有合法 rule', () => {
    const rules = ['paramImageTag', 'paramPort', 'paramPath', 'paramCommon', 'paramSelect', 'paramComplexity'];
    for (const r of rules) {
      assert.ok(FORMFIELD_RULE_WHITELIST.has(r), `应有 ${r}`);
    }
  });

});
