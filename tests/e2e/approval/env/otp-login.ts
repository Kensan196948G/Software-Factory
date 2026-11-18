/**
 * 層②③のログイン準備（人間が OTP を入力する）。
 *
 * エージェントは OTP を受け取らない・入力しない（資料 42 §1）。このスクリプトは
 * 画面を表示あり（headed）で開き、人間が Cloudflare Access の OTP ログインを終えて
 * アプリの画面（#nav）が出るまで待ち、そのセッションを storageState として保存する。
 * 保存先はリポジトリの外 ~/.config/mirai-sf/e2e-auth/{admin,user}.json、権限 0600。
 *
 * 実行:
 *   E2E_BASE_URL=https://sf.mirai-dx-platform.com E2E_LAYER=otp \
 *     pnpm -s exec tsx tests/e2e/approval/env/otp-login.ts
 *
 * 管理者 → 一般利用者の順に、別々のブラウザコンテキスト（Cookie も別）でログインする。
 * 2 回とも人間の操作が必要（OTP は 1 ラウンドで 2 回）。
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const layer = (process.env.E2E_LAYER ?? 'otp') as 'otp' | 'prod';
const baseUrl = (process.env.E2E_BASE_URL ?? '').trim().replace(/\/$/, '');
const allowAny = process.env.E2E_ALLOW_ANY_BASE === '1';
const expectedHost = layer === 'prod' ? 'sf-prod.mirai-dx-platform.com' : 'sf.mirai-dx-platform.com';
if (!baseUrl) {
  console.error('E2E_BASE_URL が必要です（例: https://sf.mirai-dx-platform.com）');
  process.exit(2);
}
if (!allowAny && !baseUrl.includes(expectedHost)) {
  console.error(`E2E_BASE_URL が層${layer === 'prod' ? '③' : '②'}の宛先ではありません（${expectedHost}）。`);
  process.exit(2);
}

const authDir = process.env.E2E_AUTH_DIR ?? join(homedir(), '.config', 'mirai-sf', 'e2e-auth');
mkdirSync(authDir, { recursive: true, mode: 0o700 });
chmodSync(authDir, 0o700);

const timeoutMs = Number(process.env.E2E_LOGIN_TIMEOUT_MS ?? 600_000);

function mask(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 3)}***@${domain ?? ''}`;
}

const roles = [
  {
    who: '管理者（承認者）',
    role: 'approver',
    email: process.env.E2E_ADMIN_EMAIL ?? '',
    path: process.env.E2E_ADMIN_STATE ?? join(authDir, 'admin.json'),
  },
  {
    who: '一般利用者（依頼者）',
    role: 'requester',
    email: process.env.E2E_USER_EMAIL ?? '',
    path: process.env.E2E_USER_STATE ?? join(authDir, 'user.json'),
  },
] as const;

async function waitForApp(page: Page): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await page.locator('#nav').count()) > 0) return true;
    } catch {
      // ページ遷移中の例外は無視して待つ
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

const browser = await chromium.launch({ headless: false });
try {
  for (const target of roles) {
    console.log(`\n${target.who} のログインを行います。`);
    if (target.email) console.log(`対象アカウント（マスク）: ${mask(target.email)}`);
    console.log('開いたブラウザで Cloudflare Access の OTP を入力し、アプリの画面が出るまで待ってください。');
    console.log('（このスクリプトは OTP を受け取らず、入力もしません。最大 10 分待ちます）');

    const context: BrowserContext = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      try {
        localStorage.clear();
      } catch {
        // 何もしない
      }
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const ok = await waitForApp(page);
    if (!ok) {
      await context.close();
      throw new Error(`${target.who} の画面（#nav）が出ませんでした。OTP ログインをやり直してください。`);
    }

    const me = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return { status: res.status, user: null };
      return { status: res.status, user: (await res.json()).user };
    });
    if (me.status !== 200 || !me.user) {
      await context.close();
      throw new Error(`${target.who} のセッションを確認できませんでした（/api/auth/me ${me.status}）`);
    }
    const actingRole = String((me.user as { actingRole?: string }).actingRole ?? '');
    const email = String((me.user as { email?: string }).email ?? '');
    if (target.email && email.toLowerCase() !== target.email.toLowerCase()) {
      await context.close();
      throw new Error(`${target.who} としてログインされていません（別のアカウント）。ブラウザを閉じてやり直してください。`);
    }
    if (actingRole !== target.role) {
      await context.close();
      throw new Error(`${target.who} の操作する人が ${target.role} ではありません（${actingRole}）。`);
    }

    await context.storageState({ path: target.path });
    chmodSync(target.path, 0o600);
    console.log(`保存しました: ${target.path}（0600、操作する人=${actingRole}）`);
    await context.close();
  }
  console.log('\n2 役分の storageState を保存しました。次に run-otp.ts を実行してください。');
} finally {
  await browser.close();
}
