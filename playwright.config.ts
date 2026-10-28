import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8781);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    // Cloudflare Access 越しのスモーク（E2E_ACCESS_URL 指定時のみ）。トークンは環境変数だけに置く。
    ...(process.env.E2E_ACCESS_CLIENT_ID && process.env.E2E_ACCESS_CLIENT_SECRET
      ? {
          extraHTTPHeaders: {
            'CF-Access-Client-Id': process.env.E2E_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': process.env.E2E_ACCESS_CLIENT_SECRET,
          },
        }
      : {}),
    headless: true,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: process.env.E2E_SERVER_CMD ?? 'node scripts/local-run.mjs tsx src/api/server.ts',
        url: `${BASE_URL}/healthz`,
        reuseExistingServer: true,
        timeout: 60_000,
        // E2E では承認依頼メールをローカルの送信BOXへ必ず書き出す（宛先が無いと積まれないため）
        env: {
          ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
          MAIL_MODE: process.env.MAIL_MODE ?? 'file',
          MAIL_APPROVAL_TO: process.env.MAIL_APPROVAL_TO ?? 'approver@example.com',
          MAIL_OUTBOX_DIR: process.env.MAIL_OUTBOX_DIR ?? '.mail/e2e-outbox',
        },
      },
});
