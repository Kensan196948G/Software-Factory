import { expect, test, type Page } from '@playwright/test';

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'kensan1969@gmail.com';
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
    if (msf?.api) await msf.api('DELETE', '/api/draft').catch(() => undefined);
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

async function clickInCard(page: Page, title: string, actionText: string): Promise<boolean> {
  return page.evaluate(
    ([t, a]) => {
      const leaf = Array.from(document.querySelectorAll('*')).find(
        (x) => x.children.length === 0 && (x.textContent || '').includes(t),
      );
      if (!leaf) return false;
      let node: Element | null = leaf;
      while (node && node.querySelectorAll('button').length === 0) node = node.parentElement;
      if (!node) return false;
      const btn = Array.from(node.querySelectorAll('button')).find((b) => (b.textContent || '').includes(a));
      if (!btn) return false;
      (btn as HTMLButtonElement).click();
      return true;
    },
    [title, actionText] as const,
  );
}

async function gotoView(page: Page, view: string): Promise<void> {
  await page.click(`button[data-v="${view}"]`);
  await page.waitForTimeout(400);
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
  await setValue(page, 'main textarea', 0, 'コンソールから登録した困りごと。APIとDBに保存されることを確認する。');
  await setValue(page, 'main textarea', 1, '受付データがPostgreSQLに残ることを確認する。');
  await nextStep(page);

  await setValue(page, 'main textarea', 0, '受付データのAPI保存\nDBへの反映確認');
  await setValue(page, 'main textarea', 1, '運用画面の見本データ');
  await nextStep(page);

  await setValue(page, 'main input[type=text]', 0, '受付で登録した依頼がDBに保存され、再読み込みしても残る');
  await nextStep(page);

  await clickText(page, '青記録・整理・検索・お知らせ', false);
  await nextStep(page);

  await clickText(page, 'この内容で受け付ける');
  await page.waitForTimeout(800);
}

async function setRole(page: Page, role: string): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(400);
}

test('ログインしてコンソールが表示される', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('みらい建設工業 ソフトウェアファクトリー受付・運用コンソール');
  await expect(page.locator('.rail')).toContainText('新しい依頼');
  await expect(page.locator('.rail')).toContainText('ボード');
  await expect(page.locator('.rail')).toContainText('SecOps');
});

test('ログイン失敗はエラーを表示する', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('ログイン');
});

test('依頼を登録し、再読み込みしてもDBから残る', async ({ page }) => {
  await login(page);
  const title = `コンソールE2E ${Date.now()}`;
  await createRequest(page, title);
  await expect(page.locator('body')).toContainText('受付');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ソフトウェアファクトリー受付・運用コンソール');
  await gotoView(page, 'list');
  await page.waitForTimeout(400);
  await expect(page.locator('body')).toContainText(title);
});

test('役割切替がAPIのセッションに反映される', async ({ page }) => {
  await login(page);
  await setRole(page, 'approver');
  const me = await page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    return res.json();
  });
  expect(me.user.actingRole).toBe('approver');
});

test('承認できる（承認者のみ）', async ({ page }) => {
  await login(page);
  const title = `コンソール承認 ${Date.now()}`;
  await createRequest(page, title);

  // 受付担当として 内容確認中 → 承認待ち
  await setRole(page, 'desk');
  await gotoView(page, 'board');
  expect(await clickInCard(page, title, '内容確認中')).toBe(true);
  await page.waitForTimeout(900);
  expect(await clickInCard(page, title, '承認待ち')).toBe(true);
  await page.waitForTimeout(900);

  // 承認者に切り替えて承認
  await setRole(page, 'approver');
  await gotoView(page, 'board');
  let opened = await clickInCard(page, title, '承認済み');
  if (!opened) {
    await gotoView(page, 'home');
    opened = await clickInCard(page, title, '承認済み');
  }
  expect(opened).toBe(true);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const modal = document.querySelector('#modal')!;
    const cb = modal.querySelector('input[type=checkbox]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent!.trim() === '変更する') as HTMLButtonElement;
    btn.click();
  });
  await page.waitForTimeout(900);
  await page.reload();
  await gotoView(page, 'list');
  await page.waitForTimeout(400);
  const row = page.locator(`tr:has-text("${title}")`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('承認済み');
});

test('一覧の検索で0件の表示になる', async ({ page }) => {
  await login(page);
  await gotoView(page, 'list');
  await page.waitForTimeout(400);
  await page.locator('#lq').fill('該当なし-zzzz-9999');
  await page.waitForTimeout(400);
  await expect(page.locator('body')).toContainText('条件に合う依頼がありません');
});

test('下書きがサーバに保存され、別端末（別コンテキスト）で再開できる', async ({ page, browser }) => {
  await login(page);
  const title = `下書きE2E ${Date.now()}`;
  try {
    await clickText(page, '新しい依頼');
    await page.waitForTimeout(300);
    await clickText(page, '新しい道具がほしい', false);
    await nextStep(page);
    await clickText(page, '現場の担当者');
    await clickText(page, '事務所');
    await nextStep(page);
    await setValue(page, 'main input[type=text]', 0, title);
    await page.waitForTimeout(1500);

    const origin = new URL(page.url()).origin;
    const cookies = await page.context().cookies();
    const other = await browser.newContext();
    await other.addCookies(cookies);
    const p2 = await other.newPage();
    await p2.goto(`${origin}/`);
    await expect(p2.getByText('書きかけの依頼があります')).toBeVisible();
    await expect(p2.locator('body')).toContainText(title);
    await p2.getByRole('button', { name: '続きから再開' }).click();
    await expect(p2.locator('main input[type=text]').first()).toHaveValue(title);
    await other.close();
  } finally {
    await resetDraft(page);
  }
});

test('運用データがDBに保存され、再読み込みで復元される', async ({ page }) => {
  await login(page);
  // 初回表示で見本データがDBへ保存される（seed-on-first-load）
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/ops');
      const body = await res.json();
      return Boolean(body.data && Array.isArray(body.data.apps));
    })
    .toBe(true);

  const state = await (await page.request.get('/api/ops')).json();
  const apps = state.data.apps as { name: string }[];
  const before = apps[0]!.name;
  const changed = `E2E変更 ${Date.now()}`;
  await page.evaluate(async (data) => {
    // @ts-expect-error 画面が公開しているAPIヘルパー
    await window.__MSF__.api('PUT', '/api/ops', { data });
  }, { ...state.data, apps: [{ ...apps[0], name: changed }, ...apps.slice(1)] });

  await page.reload();
  await page.click('button[data-v="ops"]');
  await expect(page.locator('body')).toContainText(changed);

  // 元に戻す
  await page.evaluate(async (data) => {
    // @ts-expect-error 画面が公開しているAPIヘルパー
    await window.__MSF__.api('PUT', '/api/ops', { data });
  }, { ...state.data, apps: [{ ...apps[0], name: before }, ...apps.slice(1)] });
});
