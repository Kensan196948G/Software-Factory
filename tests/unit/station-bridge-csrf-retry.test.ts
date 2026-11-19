import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// F-3: 403 のときの CSRF 取り直しは「CSRF が切り替わったとき」だけ行う。
// 旧実装は権限拒否（ERR-101・ERR-105 など）でも 1 回送り直していたため、1 操作で
// 拒否要求と監査（approval.self_denied など）が二重になっていた。
// 画面での実測は tests/e2e/approval/02-p0-approve.spec.ts の A7 が行う。
it('403 の再送は CSRF の Cookie が変わったときだけ行う', () => {
  const bridge = readFileSync('src/web/public/station-bridge.js', 'utf8');
  // 目印は画面が送った値と Cookie の値の差（セッションが切り替わると Cookie だけ変わる）。
  expect(bridge).toContain('function cookieValue(name)');
  expect(bridge).toContain("const fresh = cookieValue('msf_csrf')");
  expect(bridge).toContain('if (fresh && fresh !== csrf)');
  // 403 なら無条件に取り直す旧実装（/api/auth/csrf の読み直し）を残さない。
  expect(bridge).not.toContain('/api/auth/csrf');
});
