import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('button[data-v="home"]');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ソフトウェアファクトリー受付・運用コンソール');
  await resetDraft(page);
}

/** 下書きはサーバにも残る（端末をまたいで再開できる）。テストは毎回まっさらから始める。 */
async function resetDraft(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      localStorage.clear();
    } catch {
      /* localStorage が使えない環境では何もしない */
    }
    const msf = (window as unknown as { __MSF__?: { api?: (method: string, path: string) => Promise<unknown> } }).__MSF__;
    if (msf?.api) await msf.api('DELETE', '/api/drafts').catch(() => undefined);
  });
}

async function clickText(page: Page, text: string, exact = true): Promise<boolean> {
  return page.evaluate(
    ([t, ex]) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const b = buttons.find((x) => (ex ? x.textContent.trim() === t : x.textContent.includes(t)));
      if (!b) return false;
      b.click();
      return true;
    },
    [text, exact] as const,
  );
}

async function setValue(page: Page, selector: string, index: number, value: string): Promise<void> {
  await page.evaluate(
    ([sel, idx, v]) => {
      const el = document.querySelectorAll(sel)[idx] as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) throw new Error(`要素がありません: ${sel}[${idx}]`);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [selector, index, value] as const,
  );
}

async function nextStep(page: Page): Promise<void> {
  await clickText(page, 'つぎへ');
  await page.waitForTimeout(250);
}

async function createRequest(page: Page, title: string): Promise<void> {
  await clickText(page, '新しい依頼');
  await page.waitForTimeout(250);
  await clickText(page, '新しい道具がほしい', false);
  await nextStep(page);

  await clickText(page, '現場の担当者');
  await clickText(page, '事務所');
  await nextStep(page);

  await setValue(page, 'main input[type=text]', 0, title);
  await setValue(page, 'main textarea', 0, '確認・承認画面の確認用に登録した困りごと。');
  await setValue(page, 'main textarea', 1, '右端パネルで要点を確かめて進める。');
  await nextStep(page);

  await setValue(page, 'main textarea', 0, '確認・承認画面の一覧に表示されること');
  await setValue(page, 'main textarea', 1, '実装と外部送信');
  await nextStep(page);

  await setValue(page, 'main input[type=text]', 0, '確認・承認画面から状態を進められる');
  await nextStep(page);

  await clickText(page, '青記録・整理・検索・お知らせ', false);
  await nextStep(page);
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id as string);
  await page.selectOption('select[data-bind="approverUserId"]', me);

  await clickText(page, 'この内容で受け付ける');
  await page.waitForTimeout(800);
}

async function setRole(page: Page, role: string): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(400);
}

async function gotoView(page: Page, view: string): Promise<void> {
  await page.click(`button[data-v="${view}"]`);
  await page.waitForTimeout(400);
}

test('確認・承認: 判断待ちを左に並べ、右パネルで確かめて進められる', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const title = `確認承認 ${Date.now()}`;
  await setRole(page, 'requester');
  await createRequest(page, title);

  // 受付担当として、起票した依頼を「受付」から「承認待ち」まで進める。
  await setRole(page, 'desk');
  await gotoView(page, 'review');
  await expect(page.locator('.review')).toBeVisible();
  await expect(page.locator('#rpanel')).toBeVisible();

  // 左の一覧は 承認待ち → 内容確認中 → 受付 → 差戻し の順。
  const rows = page.locator('.rrow');
  const statuses = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status));
  expect(statuses.length).toBeGreaterThan(0);
  const order = ['wait', 'review', 'received', 'back'];
  const idx = statuses.map((s) => order.indexOf(s ?? ''));
  expect(idx).toEqual([...idx].sort((a, b) => a - b));

  // ナビのバッジは判断待ちの件数と一致する。
  await expect(page.locator('#bdgReview')).toHaveText(String(statuses.length));

  // 起票した依頼（受付）を選ぶと、ドロワーを開かず右パネルだけが切り替わる。
  await rows.filter({ hasText: title }).click();
  await expect(page.locator('#rpanel')).toContainText(title);
  await expect(page.locator('#drawer')).not.toHaveClass(/show/);

  // 受付 → 内容確認中 → 承認待ち（役割に合うボタンだけが出る）。
  await page.locator('#rvNext').click();
  await expect(rows.filter({ hasText: title })).toContainText('内容確認中');
  await rows.filter({ hasText: title }).click();
  await page.locator('#rvNext').click();
  await expect(rows.filter({ hasText: title })).toContainText('承認待ち');

  // 承認者に切り替えると「承認する」「差し戻す」が出る。
  await setRole(page, 'approver');
  await rows.filter({ hasText: title }).click();
  await expect(page.locator('#rvApprove')).toBeVisible();
  await expect(page.locator('#rvBack')).toBeVisible();

  // 承認ダイアログ（既存の承認前チェック付き）が開き、次の状態が承認済みで選ばれている。
  await page.locator('#rvApprove').click();
  await expect(page.locator('#modal')).toContainText('承認前チェック（自動）');
  await expect(page.locator('#modal input[name="ns"]:checked')).toHaveValue('approved');
  await clickText(page, 'キャンセル');

  // 依頼者では進めるボタンが出ず、理由と次の担当が出る。
  await setRole(page, 'requester');
  await rows.filter({ hasText: title }).click();
  await expect(page.locator('#rpanel')).toContainText('では進められません');
  await expect(page.locator('#rvApprove')).toHaveCount(0);
  await expect(page.locator('#rvNext')).toHaveCount(0);

  // 承認者は「受付」も動かせる。ボタンがあるのに「進められません」と書かない。
  await setRole(page, 'requester');
  const title2 = `確認承認 受付 ${Date.now()}`;
  await createRequest(page, title2);
  await setRole(page, 'approver');
  await gotoView(page, 'review');
  await rows.filter({ hasText: title2 }).click();
  await expect(page.locator('#rvNext')).toBeVisible();
  await expect(page.locator('#rpanel')).not.toContainText('では進められません');
  await expect(page.locator('.rp-who')).toContainText('次に動かすのは 受付担当 です');

  // 右端パネルはスクロールせず、ページも横にはみ出さない。
  const fit = await page.evaluate(() => {
    const body = document.querySelector('.rp-body') as HTMLElement | null;
    const act = document.querySelector('.rp-act') as HTMLElement | null;
    return {
      bodyFits: Boolean(body && body.scrollHeight <= body.clientHeight + 8),
      actInView: Boolean(act && act.getBoundingClientRect().bottom <= window.innerHeight + 1),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(fit.bodyFits).toBe(true);
  expect(fit.actInView).toBe(true);
  expect(fit.overflowX).toBe(false);
});
