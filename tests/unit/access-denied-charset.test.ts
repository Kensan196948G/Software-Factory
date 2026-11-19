import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Access で認証できないときの HTML は文字コードを明示する。
// 明示しないとブラウザが Shift_JIS と解釈し、日本語が文字化けする（2026-11-11 実測）。
it('認証できないときの HTML 応答は charset=utf-8 を明示する', () => {
  const app = readFileSync('src/api/app.ts', 'utf8');
  const route = app.slice(app.indexOf("app.get('/',"), app.indexOf("app.get('/login'"));
  expect(route).toContain("type('text/html; charset=utf-8')");
  expect(route).not.toContain("type('text/html')");
});
