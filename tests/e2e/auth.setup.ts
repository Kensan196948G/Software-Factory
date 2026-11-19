import { test as setup } from '@playwright/test';

/**
 * E2E のログインは 1 回だけ行い、そのセッションを全テストで使う。
 * サーバは同一 IP からのログイン試行を 15 分で 10 回までに制限しているため
 * （ERR-302）、テストごとにログインすると必ず途中で止まる。
 */
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('#nav');
  await page.context().storageState({ path: 'test-results/.auth/station.json' });
});
