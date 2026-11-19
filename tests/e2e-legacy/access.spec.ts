import { expect, test } from '@playwright/test';

/**
 * Cloudflare Access 越しのスモーク（公開URL）。
 *
 * 認証は Access のサービストークン（ヘッダ）で行う。トークンは環境変数だけに置く。
 *   E2E_ACCESS_URL=https://sf.mirai-dx-platform.com
 *   E2E_ACCESS_CLIENT_ID=...  E2E_ACCESS_CLIENT_SECRET=...
 *
 * 未設定のときは skip（ローカルの E2E には影響しない）。
 * なお、アプリ側が ACCESS_SERVICE_TOKEN_IDS にクライアントIDを許可している必要がある。
 */
const url = process.env.E2E_ACCESS_URL;
const hasCreds = Boolean(process.env.E2E_ACCESS_CLIENT_ID && process.env.E2E_ACCESS_CLIENT_SECRET);

test.describe('Cloudflare Access 越しのスモーク', () => {
  test.skip(!url || !hasCreds, 'E2E_ACCESS_URL / E2E_ACCESS_CLIENT_ID / E2E_ACCESS_CLIENT_SECRET が未設定');

  test('Access を通過して受付コンソールが表示される', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url!, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('ソフトウェアファクトリー受付・運用コンソール');
    await page.click('button[data-v="list"]');
    await expect(page.locator('#view')).toContainText('一覧');
    await page.click('button[data-v="ops"]');
    await expect(page.locator('#view')).toContainText('運用');
    expect(errors).toEqual([]);
  });
});
