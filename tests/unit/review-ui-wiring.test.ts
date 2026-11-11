import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// 確認・承認画面（D-01/D-21 第1弾）が、ナビ・画面描画・一覧順の定義に配線されていることを固定する。
// 画面の中身は E2E と axe で確かめる。ここは「配線が外れていないか」だけを見る。
it('確認・承認画面がナビと描画に配線されている', () => {
  const html = readFileSync('src/web/index.html', 'utf8');
  const js = readFileSync('src/web/public/console.js', 'utf8');
  expect(html).toContain('data-v="review"');
  expect(html).toContain('id="bdgReview"');
  expect(js).toContain('review: renderReview');
  expect(js).toContain('function renderReview()');
  expect(js).toContain("const REVIEW_ORDER = ['wait', 'review', 'received', 'back']");
});
