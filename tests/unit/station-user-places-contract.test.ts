import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACES, USERS } from '../../src/shared/domain.js';

/**
 * ステーション画面（station.js）の選択肢が、サーバの正本（src/shared/domain.ts）と一致することを固定する。
 * 2026-11-18 のステージング検証で、画面の「だれが使う？」「どこで使う？」がサーバの enum より古く、
 * 選ぶと ERR-004（選べない値です）になることを実測した。合わせて、サンプル入力（ローカル見本の値）を
 * サーバ接続時に出さないことも固定する。
 */
const js = readFileSync('src/web/public/station.js', 'utf8');

/** station.js の `const NAME=[...];`（1 行）を取り出して配列にする。 */
function listOf(name: string): string[] {
  const match = js.match(new RegExp(`^const ${name}=\\[(.*?)\\];$`, 'm'));
  if (!match) throw new Error(`station.js に const ${name}= の定義がありません`);
  return new Function(`return [${match[1]}];`)() as string[];
}

describe('ステーション画面の選択肢（サーバの正本と一致）', () => {
  it('「だれが使う？」はサーバの USERS と一致する', () => {
    expect(listOf('USERS')).toEqual([...USERS]);
  });

  it('「どこで使う？」はサーバの PLACES と一致する', () => {
    expect(listOf('PLACES')).toEqual([...PLACES]);
  });

  it('サンプル入力（デモ用）はサーバ接続時に出さない（ローカル見本の値で 400 にしない）', () => {
    expect(js).toContain("S.editId||window.__MSF__?'':");
  });
});
