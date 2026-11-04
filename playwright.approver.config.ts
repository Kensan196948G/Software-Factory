import { defineConfig, devices } from '@playwright/test';
/**
 * Fully intercepted synthetic UI tests (approver regressions + a11y + admin users):
 * no server, production, DB, or email access.
 */
export default defineConfig({
  testDir: 'tests/browser',
  testMatch: ['approver.spec.ts', 'a11y.spec.ts', 'admin-users.spec.ts'],
  timeout: 30000,
  workers: 1,
  use: { headless: true, locale: 'ja-JP', ...devices['Desktop Chrome'] },
  reporter: [['list']],
});
