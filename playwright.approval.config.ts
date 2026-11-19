import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

/**
 * 承認プロセス E2E（docs/production/51-approval-e2e-*.md）。
 *
 * 層はタグで分ける（@iso / @otp / @prod-smoke）。プロジェクトを選んで実行する:
 *   pnpm exec playwright test -c playwright.approval.config.ts --project=iso
 *   pnpm exec playwright test -c playwright.approval.config.ts --project=otp
 *   pnpm exec playwright test -c playwright.approval.config.ts --project=prod-smoke
 *
 * サーバは起動しない（E2E_BASE_URL の外部サーバへ向ける）。層①の使い捨て環境は
 * tests/e2e/approval/env/run-iso.ts が DB・API・偽 GitHub を作ってからこの設定で実行する。
 * 層②③は人間が OTP でログインした storageState を E2E_AUTH_DIR に置いてから実行する。
 *
 * 判定は再試行 0。trace は失敗時だけ残す。レポートは HTML と JSON の両方。
 */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? join('test-results', 'approval');
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18997';

export default defineConfig({
  testDir: 'tests/e2e/approval',
  // 並行して層①を回しても、他の実行の成果物を消さない（既定の test-results を共有しない）。
  outputDir: join(EVIDENCE_DIR, 'artifacts'),
  timeout: Number(process.env.E2E_TIMEOUT_MS ?? 240_000),
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: false,
  reporter: [
    ['list'],
    ['html', { outputFolder: join(EVIDENCE_DIR, 'html'), open: 'never' }],
    ['json', { outputFile: join(EVIDENCE_DIR, 'results.json') }],
  ],
  use: {
    baseURL: BASE_URL,
    headless: process.env.E2E_HEADED !== '1',
    locale: 'ja-JP',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // 層① 隔離環境（使い捨て DB・別ポート API・AUTH_MODE=password）。全自動。
    { name: 'iso', grep: /@iso/ },
    // 層② Staging（Cloudflare Access OTP）。P0 を 1 回。
    { name: 'otp', grep: /@otp/ },
    // 層③ 本番（Cloudflare Access OTP）。スモーク 5 件。
    { name: 'prod-smoke', grep: /@prod-smoke/ },
  ],
});
