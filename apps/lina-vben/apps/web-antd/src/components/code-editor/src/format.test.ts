import { describe, expect, it } from 'vitest';

import { formatJsonText } from './format';

describe('formatJsonText', () => {
  it('重排为两空格缩进', () => {
    expect(formatJsonText('{"a":[1,2],"b":{"c":true}}')).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": true\n  }\n}',
    );
  });

  it('超过 15 位有效数字的数字原样保留', () => {
    expect(
      formatJsonText('{"id":12345678901234567890,"rate":0.12345678901234567}'),
    ).toBe(
      '{\n  "id": 12345678901234567890,\n  "rate": 0.12345678901234567\n}',
    );
  });

  it('非法 JSON、空内容、重复键返回 null', () => {
    expect(formatJsonText('{"a":1,}')).toBeNull();
    expect(formatJsonText('  ')).toBeNull();
    expect(formatJsonText('{"a":1,"a":2}')).toBeNull();
  });
});
