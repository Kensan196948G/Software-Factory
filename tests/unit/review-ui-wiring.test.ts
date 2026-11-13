import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ステーション画面（docs/design/software-factory-station-devsecops.html が正本）が、
// ナビ・確認/承認の描画・右端パネル・サーバ同期に配線されていることを固定する。
// 画面の中身は E2E と axe で確かめる。ここは「配線が外れていないか」だけを見る。
it('確認・承認画面がナビと描画に配線されている', () => {
  const html = readFileSync('src/web/index.html', 'utf8');
  const js = readFileSync('src/web/public/station.js', 'utf8');
  expect(html).toContain('<!--MSF_BOOT-->');
  expect(html).toContain('<script src="/station.js"></script>');
  expect(html).toContain('id="nav"');
  expect(js).toContain("['review','確認・承認','stamp']");
  expect(js).toContain('V.review=function()');
  expect(js).toContain('const ord={wait:0,review:1,received:2,back:3}');
});

it('依頼の保存がサーバ同期と端末保存の両方を通る', () => {
  const js = readFileSync('src/web/public/station.js', 'utf8');
  expect(js).toContain('window.__MSF__.persist(S.data,opts)');
  expect(js).toContain('save(S.data)');
  expect(js).toContain('window.__MSF_UI__');
});

it('ブリッジはステーションの保存キーとカタログを使う', () => {
  const bridge = readFileSync('src/web/public/station-bridge.js', 'utf8');
  expect(bridge).toContain("const KEY = 'sf-station-v1'");
  expect(bridge).toContain('window.__SF_CATALOG__');
});

// 承認できるのは approver_user_id の本人だけ。新しい依頼の承認者は、表示名ではなく利用者 ID で選ぶ
// （同名の人がいても選んだ本人が承認者になる）。挙動は tests/e2e/station-approver.spec.ts が確かめる。
it('サーバ接続時の承認者は利用者IDで選び、表示名から利用者を引かない', () => {
  const js = readFileSync('src/web/public/station.js', 'utf8');
  expect(js).toContain('<select data-bind="approverUserId"');
  expect(js).toContain('<option value="${E(a.id)}"');
  expect(js).toContain(
    "if(k==='approverUserId'){const a=APV_BY_ID.get(v);d.approverUserId=a?a.id:null;d.approver=a?String(a.displayName):'';return}",
  );
  // 表示名の一致で利用者 ID を決める処理（同名の先頭の人に割り当ててしまう）を残さない
  expect(js).not.toMatch(/displayName\s*===\s*d\.approver/);
  expect(js).not.toMatch(/approvers\.find\(/);
  // 同名かどうかは Map で数える（素のオブジェクトだと constructor などの表示名で数え間違え、併記が出ない）
  expect(js).toContain('const APV_DUP=APV.items.reduce((c,a)=>c.set(a.displayName,(c.get(a.displayName)||0)+1),new Map());');
  expect(js).toContain('if(!(APV_DUP.get(a.displayName)>1))return String(a.displayName);');
  expect(js).not.toMatch(/APV_DUP\[/);
});

it('承認者の未選択・名簿外・名簿なしは登録の前に止め、先頭の人へ自動で割り当てない', () => {
  const js = readFileSync('src/web/public/station.js', 'utf8');
  expect(js).toContain('if(i===6){const m=apvErr(d);if(m)e.push(m)}');
  expect(js).toContain('if(!APV_BY_ID.has(id))return');
  expect(js).toContain("approver:(MSF_ON?'':(CFGX?CFGX.approvers[0]:APPROVERS[0])),approverUserId:null");
  // 起動データがあるのに接続の処理を読めなかったときも、見本の承認者へ戻さない
  expect(js).toContain("const MSF_ON=!!(window.__MSF__||document.getElementById('msf-boot'))");
  // ブリッジも、利用者 ID の無い依頼を送らない（ERR-004）
  const bridge = readFileSync('src/web/public/station-bridge.js', 'utf8');
  expect(bridge).toContain('requireSelectedApprover(it.__postAs || it)');
  expect(bridge).toContain('requireSelectedApprover(it);');
});

it('承認者の候補は HTML エスケープして出し、オフラインの見本は名前の一覧のまま', () => {
  const js = readFileSync('src/web/public/station.js', 'utf8');
  expect(js).toContain('>${E(apvLabel(a))}</option>');
  expect(js).toContain("<select data-bind=\"approver\">${L.map(a=>`<option${d.approver===a?' selected':''}>${E(a)}</option>`)");
  expect(js).not.toContain('>${a}</option>');
});
