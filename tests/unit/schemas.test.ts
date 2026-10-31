import { describe, expect, it } from 'vitest';
import {
  commentSchema,
  draftSchema,
  importSchema,
  loginSchema,
  requestInputSchema,
  roleSchema,
  transitionSchema,
} from '../../src/api/schemas.js';

function firstMessage(schema: { safeParse: (v: unknown) => { error?: { issues: { message: string }[] } } }, input: unknown) {
  return schema.safeParse(input).error?.issues[0]?.message;
}

describe('検証メッセージ（画面に出る文言を固定する）', () => {
  it.each([
    ['未入力', loginSchema, {}, 'Required'],
    ['本文なし', roleSchema, undefined, 'Required'],
    ['列挙の未入力', roleSchema, {}, 'Required'],
    ['型違い', loginSchema, { email: 1, password: 'p' }, 'Expected string, received number'],
    ['null', requestInputSchema, null, 'Expected object, received null'],
    ['配列', draftSchema, { draft: [], step: 0 }, 'Expected object, received array'],
    ['小数', draftSchema, { draft: {}, step: 1.5 }, 'Expected integer, received float'],
    ['列挙違い', roleSchema, { role: 'x' }, "Invalid enum value. Expected 'requester' | 'desk' | 'approver', received 'x'"],
    ['メール', loginSchema, { email: 'a@b', password: 'p' }, 'Invalid email'],
    ['文字列の下限', commentSchema, { text: ' ' }, 'String must contain at least 1 character(s)'],
    ['文字列の上限', commentSchema, { text: 'x'.repeat(2001) }, 'String must contain at most 2000 character(s)'],
    ['数値の上限', draftSchema, { draft: {}, step: 7 }, 'Number must be less than or equal to 6'],
    ['数値の下限', importSchema, { seq: -1, items: [] }, 'Number must be greater than or equal to 0'],
    ['正の数', transitionSchema, { to: 'review', version: 0 }, 'Number must be greater than 0'],
    [
      '配列の上限',
      importSchema,
      { items: Array(5001).fill({ id: 'a', title: 'b' }) },
      'Array must contain at most 5000 element(s)',
    ],
  ])('%s', (_name, schema, input, message) => {
    expect(firstMessage(schema, input)).toBe(message);
  });

  it('スキーマで指定した日本語メッセージが優先される', () => {
    expect(firstMessage(requestInputSchema.shape.title, ' ')).toBe('件名を入れてください');
    expect(firstMessage(requestInputSchema.shape.title, 'あ'.repeat(61))).toBe('件名は60文字までです');
    expect(firstMessage(requestInputSchema.shape.criteria, Array(9).fill('c'))).toBe('合格の条件は8件までです');
  });
});
