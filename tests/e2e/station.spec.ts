import { expect, test, type Page } from '@playwright/test';

/**
 * ステーション画面（docs/design/software-factory-station-devsecops.html が正本）の E2E。
 *
 * 実サーバ・実DB（CI は使い捨ての DB）に対して、画面の操作だけで
 * 「依頼の登録 → 確認 → 承認」まで進むことを確かめる。
 * 旧画面の E2E は tests/e2e-legacy/ に退避してある（画面が変わったため）。
 */

type SFWindow = Window & {
  __SF: { S: { role: string; data: { items: { id: string; title: string; status: string }[] } } };
};

async function login(page: Page): Promise<void> {
  // ログインは auth.setup.ts で 1 回だけ行い、保存したセッションを使う（試行回数の上限を避ける）
  await page.goto('/');
  await page.waitForSelector('#nav');
  await expect(page.locator('#main')).toContainText('ダッシュボード');
}

async function setRole(page: Page, role: 'requester' | 'desk' | 'approver'): Promise<void> {
  if ((await page.locator('#role').inputValue()) !== role) await page.selectOption('#role', role);
  await expect.poll(async () => page.evaluate(() => (window as unknown as SFWindow).__SF.S.role)).toBe(role);
  await page.waitForTimeout(200);
}

async function gotoTab(page: Page, view: string): Promise<void> {
  await page.click(`#nav a[data-v="${view}"]`);
  await page.waitForTimeout(250);
}

/**
 * 7 ステップの画面操作で依頼を登録し、サーバに現れるまで待って ID を返す。
 * 手順は画面のステップ（種類 → 使う人 → 内容 → 作るもの → 合格条件 → 何をするか → 承認者）。
 */
async function createRequest(page: Page, title: string): Promise<string> {
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');
  const next = () => page.click('#pane [data-a="next"]');
  await next();
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next();
  await page.fill('#stepBody [data-bind="title"]', title);
  await page.fill('#stepBody [data-bind="problem"]', '画面から依頼を登録できるかを確かめたい');
  await page.fill('#stepBody [data-bind="purpose"]', '画面の操作だけでサーバに依頼が保存されることを確認する');
  await next();
  await page.fill('#stepBody [data-bind="scope"]', '依頼の登録\n状態の変更');
  await next();
  await page.fill('#stepBody [data-crit="0"]', '登録した依頼が一覧とサーバの両方に残る');
  await next();
  await page.click('#stepBody [data-a="one"][data-f="decides"][data-v="g"]');
  await next();
  await page.click('#pane [data-a="submit"]');
  await expect
    .poll(
      async () =>
        page.evaluate(async (t) => {
          const res = await fetch('/api/requests?q=' + encodeURIComponent(t));
          const json = await res.json();
          return (json.items || []).filter((x: { title: string }) => x.title === t).length;
        }, title),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const id = await page.evaluate((t) => {
    const item = (window as unknown as SFWindow).__SF.S.data.items.find((r) => r.title === t);
    return item ? item.id : '';
  }, title);
  expect(id).toMatch(/^REQ-\d{4}-\d{4}$/);
  return id;
}

async function serverStatus(page: Page, id: string): Promise<string> {
  return page.evaluate(async (rid) => {
    const res = await fetch('/api/requests/' + encodeURIComponent(rid));
    const json = await res.json();
    return json.request ? json.request.status : '';
  }, id);
}

async function serverSignal(page: Page, id: string): Promise<string> {
  return page.evaluate(async (rid) => {
    const res = await fetch('/api/requests/' + encodeURIComponent(rid));
    const json = await res.json();
    return json.request ? (json.request.signalDecided || '') : '';
  }, id);
}

/** 確認・承認の画面から、右端パネルの状態変更で遷移し、サーバに反映されるまで待つ。 */
async function moveStatus(page: Page, id: string, to: string, signal?: 'g' | 'y' | 'r'): Promise<void> {
  await page.click('#nav a[data-v="review"]');
  await page.waitForTimeout(300);
  await page.click(`#work .li[data-id="${id}"]`);
  await page.click(`#rin [data-a="status"][data-id="${id}"]`);
  await page.waitForSelector('#modal.open');
  await page.check(`#modal input[name="ns"][value="${to}"]`);
  if (signal) await page.check(`#modal input[name="fc"][value="${signal}"]`);
  await page.click('#modal [data-a="sok"]');
  await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe(to);
  // 承認後は完了ダイアログが開いたままになる（閉じるまで次の操作を遮る）
  if ((await page.locator('#modal.open').count()) > 0) {
    const close = page.locator('#modal [data-a="closeModal"]').first();
    if ((await close.count()) > 0) await close.click();
    else await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
  }
}

test.describe('ステーション画面', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('ダッシュボードがサーバの依頼で表示される', async ({ page }) => {
    await expect(page).toHaveTitle('ソフトウェアファクトリーステーション');
    await expect(page.locator('#stat')).toContainText('サーバ保存');
    await expect(page.locator('#nav')).toContainText('ダッシュボード');
    await expect(page.locator('#nav')).toContainText('監査ログ');
    await expect(page.locator('#main')).toContainText('信号の色の割合');
    await expect(page.locator('#main')).toContainText('新しい依頼をはじめる');
  });

  test('すべての画面が開き、コンソールエラーが出ない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
    });
    const views = ['dash', 'review', 'board', 'list', 'catalog', 'devops', 'secops', 'log', 'settings'];
    for (const view of views) {
      await gotoTab(page, view);
      await expect(page.locator('#main')).not.toBeEmpty();
      await expect(page.locator('#main')).not.toContainText('undefined');
    }
    expect(errors).toEqual([]);
  });

  test('依頼を登録し、受付 → 内容確認中 → 承認待ち → 承認済みまで進められる', async ({ page }) => {
    await setRole(page, 'requester');
    const title = `E2E ステーション ${Date.now()}`;
    const id = await createRequest(page, title);
    expect(await serverStatus(page, id)).toBe('received');

    await setRole(page, 'desk');
    await moveStatus(page, id, 'review');
    await moveStatus(page, id, 'wait');

    await setRole(page, 'approver');
    await moveStatus(page, id, 'approved', 'g');
    expect(await serverSignal(page, id)).toBe('g');

    // 一覧にも反映されている
    await gotoTab(page, 'list');
    await page.fill('#main [data-flt="fq"]', title);
    await expect(page.locator('#ltb')).toContainText(title);
    await expect(page.locator('#main')).toContainText('承認済み');
  });

  test('一覧の状態フィルタが効く', async ({ page }) => {
    await gotoTab(page, 'list');
    await page.selectOption('#main [data-flt="fs"]', 'done');
    const rows = page.locator('#ltb tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      await expect(rows.nth(i)).toContainText('完了');
    }
  });

  test('道具カタログがサーバの部署を表示する', async ({ page }) => {
    await gotoTab(page, 'catalog');
    await expect(page.locator('#main')).toContainText('道具カタログ');
    const depts = await page.locator('#catleft .li[data-v]').count();
    expect(depts).toBeGreaterThan(0);
    await page.fill('#main [data-flt="catq"]', '写真');
    await expect(page.locator('#catleft')).toContainText('検索結果');
  });

  test('監査ログに依頼の履歴とサーバの記録が出る', async ({ page }) => {
    await gotoTab(page, 'log');
    await expect(page.locator('#main')).toContainText('監査ログ');
    await expect(page.locator('#logtb tr')).not.toHaveCount(0);
    await expect(page.locator('#main')).toContainText('依頼');
    // サーバの監査（ログイン・設定など）も区分から見られる
    await page.click('#main [data-a="logk"][data-v="auth"]');
    await expect(page.locator('#logtb')).toContainText('ログイン');
  });

  test('システム設定の承認者タブにサーバの承認者が出る', async ({ page }) => {
    await gotoTab(page, 'settings');
    await page.click('#setleft .li[data-v="approvers"]');
    await expect(page.locator('#rin')).toContainText('承認者');
    await expect(page.locator('#rin')).toContainText('サーバの利用者管理');
  });

  test('システム設定で利用者を確認できる', async ({ page }) => {
    await gotoTab(page, 'settings');
    await page.click('#setleft .li[data-v="users"]');
    await expect(page.locator('#rin')).toContainText('利用者を追加');
    await expect(page.locator('#rin')).toContainText('管理者');
    await page.click('#rin [data-a="uAdd"]');
    await expect(page.locator('#modal.open')).toBeVisible();
    await expect(page.locator('#modal #uEmail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
  });

  test('ボードから状態変更のダイアログを開ける', async ({ page }) => {
    await gotoTab(page, 'board');
    const card = page.locator('#work .kc').first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#rin')).toContainText('依頼');
    const statusBtn = page.locator('#rin [data-a="status"]').first();
    if ((await statusBtn.count()) > 0) {
      await statusBtn.click();
      await expect(page.locator('#modal.open')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#modal.open')).toHaveCount(0);
    }
  });

  test('テーマをダークに切り替えられ、再読み込みでも残る', async ({ page }) => {
    await page.click('#themebtn');
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.reload();
    await page.waitForSelector('#nav');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.click('#themebtn');
  });

  test('狭い画面でも主要な操作が見える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await expect(page.locator('#nav')).toBeVisible();
    await expect(page.locator('#main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
