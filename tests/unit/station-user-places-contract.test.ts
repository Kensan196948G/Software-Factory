import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVALS, CONSTRAINTS, DATA_HANDLING, PLACES, USERS } from '../../src/shared/domain.js';

/**
 * ステーション画面（station.js）の選択肢が、サーバの正本（src/shared/domain.ts）と一致することを固定する。
 * 2026-11-18 のステージング検証で、画面の「だれが使う？」「どこで使う？」がサーバの enum より古く、
 * 選ぶと ERR-004（選べない値です）になることを実測した。
 * 海の上・作業船の追加（場所・利用者・データ・承認・制約・圏外テスト）も同じ理由で同期する。
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

  it('「守ること」はサーバの CONSTRAINTS と一致する（天気・波の項目を含む）', () => {
    expect(listOf('CONSTRAINTS')).toEqual([...CONSTRAINTS]);
  });

  it('「人に聞くこと」はサーバの APPROVALS と一致する（作業船・海の上を含む）', () => {
    expect(listOf('APPROVALS')).toEqual([...APPROVALS]);
  });

  it('「扱う情報」はサーバの DATA_HANDLING と一致する（作業船・環境の測定値を含む）', () => {
    const ui = new Function(`return ${js.match(/^const DATA=\[(.*?)\];$/ms)?.[0].replace('const DATA=', '')}`)() as {
      k: string;
      l: string;
    }[];
    expect(ui.map((d) => ({ key: d.k, label: d.l }))).toEqual(DATA_HANDLING.map((d) => ({ key: d.key, label: d.label })));
  });

  it('圏外テスト（現場試用）は「海の上」でも必要になる', () => {
    const match = js.match(/^const fieldUse=(.*);$/m);
    if (!match) throw new Error('station.js に fieldUse の定義がありません');
    const fieldUse = new Function(`return ${match[1]};`)() as (r: { places?: string[] }) => boolean;
    expect(fieldUse({ places: ['海の上（作業船・台船）'] })).toBe(true);
    expect(fieldUse({ places: ['陸の現場（屋外）'] })).toBe(true);
    expect(fieldUse({ places: ['電波の弱い現場'] })).toBe(true);
    expect(fieldUse({ places: ['事務所'] })).toBe(false);
  });

  it('サンプル入力（デモ用）はサーバ接続時・起動失敗時に出さない（ローカル見本の値で 400 にしない）', () => {
    expect(js).toContain("S.editId||window.__MSF__||BOOT_FAILED?'':");
  });
});
