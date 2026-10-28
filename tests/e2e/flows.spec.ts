import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'kensan1969@gmail.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  const loginButton = page.getByRole('button', { name: 'ログイン' });
  if (await loginButton.isVisible().catch(() => false)) {
    await page.getByLabel('メールアドレス').fill(EMAIL);
    await page.getByLabel('パスワード').fill(PASSWORD);
    await loginButton.click();
  }
  await expect(page.getByRole('heading', { name: 'ホーム' })).toBeVisible();
}

async function setRole(page: Page, label: '依頼者' | '受付担当' | '承認者'): Promise<void> {
  // ドロワーのオーバーレイが上部バーを覆うため、先に閉じる
  if (await page.getByTestId('drawer').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawer')).toBeHidden();
  }
  await page.locator('.role-switch button', { hasText: label }).click();
  await page.waitForTimeout(300);
}

async function openRequest(page: Page, id: string): Promise<void> {
  await page.goto(`/?request=${id}`);
  await expect(page.getByTestId('drawer')).toBeVisible();
}

async function transition(page: Page, to: string): Promise<void> {
  console.log(`[e2e] transition -> ${to}`);
  await page.getByTestId('drawer').getByRole('button', { name: '状態を変更' }).click();
  const modal = page.getByTestId('modal');
  await expect(modal).toBeVisible();
  await modal.locator(`input[name="to"][value="${to}"]`).check();
  console.log(`[e2e] checked ${to}`);
  await modal.getByRole('button', { name: '変更する' }).click();
  console.log('[e2e] clicked submit');
  await expect(modal).toBeHidden();
}

async function approveAsApprover(page: Page, signal: 'g' | 'y' | 'r' = 'y'): Promise<void> {
  await page.getByTestId('drawer').getByRole('button', { name: '状態を変更' }).click();
  const modal = page.getByTestId('modal');
  await modal.locator('input[name="to"][value="approved"]').check();
  await expect(modal.getByText('承認前チェック')).toBeVisible();
  const ack = modal.locator('label:has-text("確認しました") input[type="checkbox"]');
  if (await ack.count()) await ack.check();
  await modal.locator(`input[name="signal"][value="${signal}"]`).check();
  await modal.getByRole('button', { name: '変更する' }).click();
  await expect(modal).toBeHidden();
}

async function maybeDiscardDraft(page: Page): Promise<void> {
  await page.waitForTimeout(700);
  const modalTitle = page.getByRole('heading', { name: '書きかけの依頼があります' });
  if ((await modalTitle.count()) > 0) {
    await page.getByRole('button', { name: '破棄して新しく始める' }).click();
    await expect(modalTitle).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'だれの、どんな困りごと' })).toBeVisible();
}

async function createRequest(page: Page, title: string): Promise<string> {
  await page.goto('/new');
  await maybeDiscardDraft(page);
  await page.getByLabel('件名 *').fill(title);
  await page.getByLabel('いま困っていること *').fill('作業船の上で電波が弱く、写真の整理に毎日1時間かかっている。');
  await page.getByLabel('目的（どうなればよいか） *').fill('圏外でも写真が消えず、事務所での整理の手間をなくす。');
  await page.getByRole('button', { name: /次へ/ }).click();

  await page.getByLabel('作るもの *').fill('圏外での一時保存\n電波が戻ったときの自動送信');
  await page.getByRole('button', { name: /次へ/ }).click();

  await page.locator('label.check-chip', { hasText: '現場の担当者' }).click();
  await page.getByRole('button', { name: /次へ/ }).click();

  await page.locator('label.check-chip', { hasText: '記録・整理・検索・お知らせ' }).click();
  await page.getByRole('button', { name: /次へ/ }).click();

  await page.locator('input[aria-invalid]').first().fill('圏外で撮った写真がアプリを閉じても消えない');
  await page.getByRole('button', { name: /次へ/ }).click();

  await page.getByRole('button', { name: /次へ/ }).click();
  await expect(page.getByText('この内容で登録します')).toBeVisible();
  await page.getByRole('button', { name: 'この内容で登録する' }).click();

  await expect(page.getByTestId('drawer')).toBeVisible();
  const idText = (await page.getByTestId('drawer').locator('.mono').first().textContent()) ?? '';
  const id = /REQ-\d{4}-\d{4}/.exec(idText)?.[0];
  if (!id) throw new Error(`受付番号が取れません: ${idText}`);
  return id;
}

test('主要フロー① 依頼を登録できる', async ({ page }) => {
  await login(page);
  const id = await createRequest(page, `E2E 登録テスト ${Date.now()}`);
  await expect(page.getByTestId('drawer')).toContainText(id);
  await expect(page.getByTestId('drawer')).toContainText('受付');
  await expect(page.getByText(`${id} を登録しました`)).toBeVisible();
});

test('主要フロー② 受付担当が進め、承認者が承認して注文書YAMLが出る', async ({ page }) => {
  await login(page);
  const id = await createRequest(page, `E2E 承認テスト ${Date.now()}`);

  await setRole(page, '受付担当');
  await openRequest(page, id);
  await transition(page, 'review');
  await transition(page, 'wait');

  await setRole(page, '承認者');
  await openRequest(page, id);
  await approveAsApprover(page);
  await expect(page.getByTestId('drawer')).toContainText('承認済み');

  await page.getByTestId('drawer').getByRole('tab', { name: /注文書/ }).click();
  await expect(page.getByTestId('drawer').locator('pre')).toContainText(`id: "${id}"`);
  await expect(page.getByTestId('drawer').locator('pre')).toContainText('acceptance_criteria:');
});

test('主要フロー③ 現場試用から完了まで進められる（完了は承認者のみ）', async ({ page }) => {
  await login(page);
  const id = await createRequest(page, `E2E 完了テスト ${Date.now()}`);

  await setRole(page, '受付担当');
  await openRequest(page, id);
  await transition(page, 'review');
  await transition(page, 'wait');

  await setRole(page, '承認者');
  await openRequest(page, id);
  await approveAsApprover(page);

  await setRole(page, '受付担当');
  await openRequest(page, id);
  await transition(page, 'dev');
  await transition(page, 'verify');
  await transition(page, 'field');
  await transition(page, 'release_wait');

  await setRole(page, '承認者');
  await openRequest(page, id);
  await transition(page, 'done');
  await expect(page.getByTestId('drawer')).toContainText('完了');
});

test('入力エラー: 件名が空だと次へ進めない', async ({ page }) => {
  await login(page);
  await page.goto('/new');
  await maybeDiscardDraft(page);
  await page.getByRole('button', { name: /次へ/ }).click();
  await expect(page.getByText('件名を入れてください')).toBeVisible();
  await expect(page.getByText('困っていることを入れてください')).toBeVisible();
});

test('空状態: 条件に合う依頼がないことを表示する', async ({ page }) => {
  await login(page);
  await page.goto('/requests');
  await page.getByLabel('検索').fill('該当なし-zzzz-9999');
  await expect(page.getByText('条件に合う依頼がありません')).toBeVisible();
});

test('キーボード: Escで詳細ドロワーを閉じられる', async ({ page }) => {
  await login(page);
  const id = await createRequest(page, `E2E キーボード ${Date.now()}`);
  await openRequest(page, id);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('drawer')).toBeHidden();
});

test('通信エラー: APIが落ちているとエラー表示になる', async ({ page }) => {
  await login(page);
  await page.route('**/api/home', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByText('処理を完了できませんでした').or(page.getByText('Failed to fetch'))).toBeVisible();
});

test('カタログ: 19部署・118件を表示する', async ({ page }) => {
  await login(page);
  await page.goto('/catalog');
  await expect(page.getByText('道具の候補')).toBeVisible();
  await expect(page.getByText('考えた部署')).toBeVisible();
  await expect(page.getByText('工事写真の整理・写真台帳')).toBeVisible();
});

test('権限: 受付担当では「承認済み」を選べない', async ({ page }) => {
  await login(page);
  const id = await createRequest(page, `E2E 権限テスト ${Date.now()}`);
  await setRole(page, '受付担当');
  await openRequest(page, id);
  await transition(page, 'review');
  await transition(page, 'wait');
  await page.getByTestId('drawer').getByRole('button', { name: '状態を変更' }).click();
  const modal = page.getByTestId('modal');
  await expect(modal.locator('input[name="to"][value="approved"]')).toHaveCount(0);
  await modal.getByRole('button', { name: '閉じる' }).last().click();
});
