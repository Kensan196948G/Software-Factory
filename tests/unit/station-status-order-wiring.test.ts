import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ステーション画面（src/web/public/station.js）の「サーバの結果を先に確かめる」配線を固定する。
//  - F-3: 状態変更は保存の応答を待ってから成功の演出（画面の確定・完了ダイアログ・成功トースト・紙吹雪）を出す。
//        失敗したら演出を出さず、状態・履歴・コメントを元に戻す。
//  - F-1: 注文書タブ・コピー・ダウンロードは、サーバ接続時は API の確定版（order_version つき）を使う。
//        サーバ非接続の見本は従来どおり toYAML を使う。
// 画面の動きそのものは tests/e2e/station-server-first.spec.ts が実サーバで確かめる。
// ここは、画面の関数を取り出して、順序と分岐の配線が崩れていないかだけを見る。
const js = readFileSync('src/web/public/station.js', 'utf8');

/** station.js の関数定義（定義の行から、次の列 0 の } まで）を取り出す。 */
function blockOf(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`station.js に function ${name} がありません`);
  const end = js.indexOf('\n}', start);
  if (end < 0) throw new Error(`function ${name} の終わりが見つかりません`);
  return js.slice(start, end + 2);
}

it('状態変更は保存の応答を待ってから、成功の演出を出す', () => {
  const block = blockOf('applyStatus');
  expect(block).toContain('await persist()');
  const saved = block.indexOf('await persist()');
  // 画面の確定・承認の完了ダイアログ・成功トースト・紙吹雪は、すべて保存の後ろにある
  for (const effect of ['closeModal();render()', 'lineModal(r,fc)', "toast(r.id+' を「'", 'confetti(110)']) {
    const at = block.indexOf(effect);
    expect(at, `${effect} が保存より前にあります`).toBeGreaterThan(saved);
  }
});

it('状態変更が失敗したら演出を出さず、送った内容のままなら状態・履歴・コメントを元に戻す', () => {
  const block = blockOf('applyStatus');
  expect(block).toContain('res.ok!==true');
  expect(block).toContain('S.data.items[k]=prev');
  expect(block).toContain('save(S.data)');
  // 失敗の分岐は、成功の演出（注文書の破棄以降）へ進まずに return する
  const failed = block.indexOf('res.ok!==true');
  const success = block.indexOf('delete ORD[id]');
  expect(failed).toBeGreaterThan(-1);
  expect(success).toBeGreaterThan(failed);
  expect(block.slice(failed, success)).toContain('return;');
});

it('状態変更の送信中は二重に送らない', () => {
  expect(blockOf('applyStatus')).toContain('if(S.statusSending)return;');
});

it('注文書タブは orderPanel を使い、サーバ接続時は API の確定版（order_version）を出す', () => {
  expect(js).toContain("if(S.dtab==='yaml')body=orderPanel(r);");
  const panel = blockOf('orderPanel');
  expect(panel).toContain('order_version:');
  expect(panel).toContain('ensureOrder(r.id)');
  const fetchBlock = blockOf('ensureOrder');
  expect(fetchBlock).toContain("'/api/requests/'+encodeURIComponent(id)+'/order'");
  expect(fetchBlock).toContain('res.yaml');
});

it('サーバ非接続の見本では、注文書は従来どおり toYAML を使う', () => {
  expect(blockOf('orderFor')).toContain('if(!window.__MSF__)return {yaml:toYAML(r)');
  expect(blockOf('orderPanel')).toContain("let head='',yaml=toYAML(r)");
});

it('注文書のコピーとダウンロードは、表示と同じ文面（orderFor）を使う', () => {
  expect(js).toContain('ycopy(el){const r=find(el.dataset.id);if(!r)return;void orderFor(r)');
  expect(js).toContain('ydl(el){const r=find(el.dataset.id);if(!r)return;void orderFor(r)');
});
