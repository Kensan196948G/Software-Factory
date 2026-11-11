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
