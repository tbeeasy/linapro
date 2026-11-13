import { describe, expect, it, vi } from 'vitest';

import {
  coerceValueForType,
  isValidJsonText,
  normalizeFormValue,
  resolveConfigModalLayout,
  valueFieldSchema,
} from './data';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

vi.mock('@vben/locales', () => ({
  $t: (key: string) => key,
}));

describe('json 值类型', () => {
  it('弹窗按 spacious 档加宽并提供全屏入口', () => {
    const layout = resolveConfigModalLayout('json');
    expect(layout.density).toBe('spacious');
    expect(layout.fullscreenButton).toBe(true);
    expect(layout.editorHeight).toBe('clamp(360px, 52vh, 640px)');
  });

  it('富文本沿用改名后的 editorHeight', () => {
    expect(resolveConfigModalLayout('richtext').editorHeight).toBe(
      'clamp(360px, 52vh, 640px)',
    );
    expect(resolveConfigModalLayout('text').editorHeight).toBe('');
  });

  it('值字段渲染 JsonEditor 并带 JSON 校验规则', () => {
    const schema = valueFieldSchema({
      configKey: 'demo.json',
      options: [],
      valueType: 'json',
    });
    expect(schema.component).toBe('JsonEditor');
    expect(schema.componentProps).toMatchObject({
      height: 'clamp(360px, 52vh, 640px)',
    });

    const rule = schema.rules as { safeParse: (value: unknown) => any };
    expect(rule.safeParse('{"a":[1,2]}').success).toBe(true);
    expect(rule.safeParse('42').success).toBe(true);
    expect(rule.safeParse('{"a":1,}').success).toBe(false);
    expect(rule.safeParse('').success).toBe(false);
  });

  it('其他类型不返回自带校验规则', () => {
    const schema = valueFieldSchema({
      configKey: 'demo.text',
      options: [],
      valueType: 'text',
    });
    expect(schema.rules).toBeUndefined();
  });

  it('isValidJsonText 只判断合法性', () => {
    expect(isValidJsonText('[1,2]')).toBe(true);
    expect(isValidJsonText('"abc"')).toBe(true);
    expect(isValidJsonText('{a:1}')).toBe(false);
    expect(isValidJsonText('   ')).toBe(false);
    expect(isValidJsonText(undefined)).toBe(false);
  });

  it('回显与提交都原样保留 JSON 字符串', () => {
    const text = '{\n  "a": [1, 2]\n}';
    expect(coerceValueForType('json', text)).toBe(text);
    expect(normalizeFormValue('json', text)).toBe(text);
    expect(normalizeFormValue('json', undefined)).toBe('');
  });
});
