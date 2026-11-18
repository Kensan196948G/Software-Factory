import { request } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_STATE,
  expect,
  IS_ISO,
  LAYER,
  test,
  USER_EMAIL,
  USER_PASSWORD,
  USER_STATE,
} from './fixtures/roles';
import { loginWithPassword, logoutAndExpectLogin, openApp } from './fixtures/station';

/**
 * A11（共通）: 管理者と一般利用者の両方でログアウトすると、再アクセスでログインを求められる。
 * 対象: 層①②③。
 *
 * 層①は繰り返し実行できるよう、その場でパスワードログインして新しいセッションを作ってから
 * ログアウトする（共有の storageState を壊さない）。層②③はラウンドの最後に 1 回だけ実行し、
 * 人間が OTP で作った 2 つのセッションを終える。実行順は env/run-otp.ts が保証する。
 */
test(
  'A11 両方の役割でログアウトすると、再アクセスでログインを求められる',
  { tag: ['@iso', '@otp', '@prod-smoke', '@logout-last'] },
  async ({ admin, user, browser, baseURL, evidence }) => {
    const results: {
      who: string;
      afterLogoutPath: string;
      reaccessPath: string;
      bodyText: string;
      oldSessionStatus: number | null;
    }[] = [];

    if (IS_ISO) {
      for (const [who, email, password] of [
        ['admin', ADMIN_EMAIL, ADMIN_PASSWORD],
        ['user', USER_EMAIL, USER_PASSWORD],
      ] as const) {
        const session = await loginWithPassword(browser, email, password);
        try {
          await openApp(session.page);
          const saved = await session.context.storageState();
          const result = await logoutAndExpectLogin(session.page, 'iso');
          const probe = await request.newContext({ baseURL, storageState: saved });
          try {
            const me = await probe.get('/api/auth/me');
            expect(me.status(), `${who} のログアウト後もセッションが生きている`).toBe(401);
            results.push({ who, ...result, oldSessionStatus: me.status() });
          } finally {
            await probe.dispose();
          }
        } finally {
          await session.context.close();
        }
      }
    } else {
      for (const [who, session, statePath] of [
        ['admin', admin, ADMIN_STATE],
        ['user', user, USER_STATE],
      ] as const) {
        await openApp(session.page);
        const result = await logoutAndExpectLogin(session.page, LAYER);
        const probe = await request.newContext({ baseURL, storageState: statePath });
        try {
          const me = await probe.get('/api/auth/me', { failOnStatusCode: false });
          // Access 配下では、storageState に残る Access の Cookie（JWT）で API が再認証され、
          // アプリのログアウト後でも 200 + user になり得る。これはアプリのセッションが残っている
          // ことを意味しない。ブラウザの再アクセス（Access のログイン画面）で判定し、ここでは実測値だけ残す。
          results.push({ who, ...result, oldSessionStatus: me.status() });
        } finally {
          await probe.dispose();
        }
      }
    }

    expect(results.map((r) => r.who).sort()).toEqual(['admin', 'user']);
    for (const r of results) {
      expect(
        r.reaccessPath === '/login' || /login|access|Cloudflare/i.test(`${r.reaccessPath} ${r.bodyText}`),
        `${r.who} の再アクセスがログインになっていない`,
      ).toBe(true);
    }
    evidence.note('logout', results);
  },
);
