import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ステーション画面（src/web/public/station.js）の DevOps タブには「マージ」のボタンが 2 種類ある。
//  - 実ジョブの「merge を承認」: data-job を読み、サーバの /api/jobs/:id/approve-merge を呼ぶ
//  - 見本（サーバ接続なしで動く画面）の「マージする」: 画面の状態だけを書き換える
// どちらも同じ devMerge という名前だったため、JavaScript では後に書いた見本の定義が有効になり、
// 実ジョブのボタンを押しても見本の処理が走っていた（devMerge が 2 回定義されていた）。
// ここでは、名前が分かれていること・見本のボタンが別名を指していることを固定する。
// 画面の動きそのものは E2E で確かめる。
const js = readFileSync('src/web/public/station.js', 'utf8');

/** 定義（メソッド名(el){ の形）の数を数える。名前が前方一致で別の関数を拾わないよう、直後が ( であることも見る。 */
function countDefs(name: string): number {
  return (js.match(new RegExp(`(?:^|\\n)\\s*${name}\\(el\\)\\{`, 'g')) ?? []).length;
}

it('実ジョブの devMerge と見本の devMergeSample が、それぞれ 1 つずつ定義されている', () => {
  // 実ジョブ側（data-job を読む定義）は残す
  expect(countDefs('devMerge')).toBe(1);
  expect(countDefs('devMergeSample')).toBe(1);
  // 画面のコードから devMerge を参照する箇所は、実ジョブのボタンとその定義だけにする
  const refs = js.match(/devMerge(?!Sample)/g) ?? [];
  expect(refs).toHaveLength(2);
});

it('見本の「マージする」は devMergeSample を指し、実ジョブの「merge を承認」は devMerge のまま', () => {
  // 見本のボタン生成（merge:()=>abtn(...)）の action
  expect(js).toContain("abtn('merge','devMergeSample','マージする','loop'");
  expect(js).not.toContain("abtn('merge','devMerge','マージする'");
  // 実ジョブのボタン（data-job つき）
  expect(js).toContain("abtn('merge','devMerge','merge を承認','check',{id:r.id,job:j.id,cls:'ok',ready:true})");
});

it('実ジョブの devMerge は data-job を読み、サーバの approve-merge を呼ぶ（見本の処理に置き換わっていない）', () => {
  const line = js.split('\n').find((l) => l.startsWith(' devMerge(el){'));
  if (!line) throw new Error('station.js に実ジョブの devMerge の定義がありません');
  expect(line).toContain('el.dataset.job');
  expect(line).toContain("'approve-merge'");
  // 見本側は逆にサーバを呼ばない（画面の状態だけを書き換える）
  const sample = js.split('\n').find((l) => l.startsWith(' devMergeSample(el){'));
  if (!sample) throw new Error('station.js に devMergeSample の定義がありません');
  expect(sample).not.toContain('approve-merge');
  expect(sample).not.toContain('dlAct');
});
