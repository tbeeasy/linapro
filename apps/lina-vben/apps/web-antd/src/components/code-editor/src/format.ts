import JsonBigint from 'json-bigint';

/**
 * 原生 JSON.parse 会把超过 15 位有效数字的数字截断精度，格式化会悄悄改掉
 * 管理员存的大整数 ID；这里用 json-bigint 解析，长数字按原样写回。
 */
const preciseJson = JsonBigint({ strict: true });

/**
 * 把 JSON 文本重排为两空格缩进；文本不是合法 JSON 时返回 null，调用方据此提示。
 */
export function formatJsonText(text: string): null | string {
  if (!text.trim()) {
    return null;
  }
  try {
    return preciseJson.stringify(preciseJson.parse(text), null, 2);
  } catch {
    return null;
  }
}
