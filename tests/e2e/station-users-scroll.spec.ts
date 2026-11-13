import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * ステーション画面「システム設定 → 利用者」の一覧が長くなったときの回帰（2026-11-13 追加）。
 *
 * 隔離 DB に利用者を 32 人入れた状態で、既存の回帰 E2E
 * 「利用者を追加すると一覧に現れ、無効化と有効化を切り替えられる」がタイムアウトした。
 * 原因は、右端パネルの設定画面が中身を縮小して高さに収めようとしていたこと（fitPane）。
 * 一覧の行が増えると縮小が追いつかず、下端の行・ボタンが overflow:hidden のパネルの外へ出て、
 * スクロールもできないためマウスで押せなくなっていた。
 *
 * ここでは、利用者を 18 人作ったうえで、
 * - 一覧がパネルの高さを超えたときに、パネルの中で縦にスクロールできる（ページ全体は伸びない）
 * - 最下行の「パスワード」ボタンまでスクロールでき、押すとダイアログが開く
 * を確かめる。作った利用者は、成否にかかわらずテストの終わりに無効化する（削除の API は無い）。
 * 依頼の起票者には使わず、共有のセッション（auth.setup.ts の管理者）も失効させない。
 */

const RUN = Date.now().toString(36);
/** このファイルが作る利用者のメール（後始末は、この形の利用者をサーバの一覧から探して無効化する）。 */
const OWN_EMAIL = /^scroll-[a-z0-9]+-\d+@example\.com$/;
/** 1 画面に収まらない行数。既定のビューポート（1280x720）で一覧がパネルの高さを超える。 */
const USERS = 18;

type ManagedUser = { id: string; email: string; displayName: string; isActive: boolean };
type ApiResult = { status: number; json: Record<string, unknown> | null };

/** 共有のセッションで API を呼ぶ（CSRF は毎回取り直す）。 */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<ApiResult> {
  return page.evaluate(
    async ([m, p, b]) => {
      const token = await fetch('/api/auth/csrf').then((r) => r.json());
      const res = await fetch(p as string, {
        method: m as string,
        headers: { 'content-type': 'application/json', 'x-csrf-token': String(token.csrf || '') },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
    [method, path, body] as const,
  );
}

/** 架空の利用者を 1 人作る（依頼者の役割だけ）。メールは example.com で一意にする。 */
async function createUser(page: Page, index: number): Promise<string> {
  const depts = await api(page, 'GET', '/api/catalog/departments');
  const deptCode = ((depts.json?.items as { code: string }[] | undefined) ?? [])[0]?.code;
  expect(deptCode).toBeTruthy();
  const email = `scroll-${RUN}-${index}@example.com`;
  const res = await api(page, 'POST', '/api/admin/users', {
    email,
    displayName: `E2E 一覧 ${RUN}-${index}`,
    deptCode,
    password: `T-${randomUUID()}`,
    roles: ['requester'],
    isAdmin: false,
  });
  expect(res.status).toBe(201);
  return email;
}

/** このファイルが作った利用者を無効化する（削除の API が無いため。手元ではなくサーバの一覧から探す）。 */
async function sweepOwnUsers(page: Page): Promise<void> {
  const own = async () => {
    const list = await api(page, 'GET', '/api/admin/users');
    expect(list.status).toBe(200);
    const items = (list.json?.items as ManagedUser[] | undefined) ?? [];
    return items.filter((u) => u.isActive && OWN_EMAIL.test(u.email));
  };
  for (const user of await own()) {
    const res = await api(page, 'PATCH', `/api/admin/users/${user.id}`, { isActive: false });
    expect(res.status).toBe(200);
  }
  expect(await own()).toHaveLength(0);
}

/** 画面を開く。相対 URL の fetch は about:blank では失敗するので、API を呼ぶ前に必ず開く。 */
async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#nav');
}

async function openUsers(page: Page): Promise<void> {
  await open(page);
  await page.click('#nav a[data-v="settings"]');
  await page.click('#setleft .li[data-v="users"]');
  await expect(page.locator('#rin [data-a="uAdd"]')).toBeVisible();
}

test.describe('回帰: 利用者一覧のスクロール', () => {
  // 行が増えても 1 画面に収まらない状況を作るため、ビューポートを固定する（既定と同じ 1280x720）
  test.use({ viewport: { width: 1280, height: 720 } });

  test.afterEach(async ({ page }) => {
    // 画面を開く前に失敗した回でも、後始末（作成した利用者の無効化）は必ず行う
    if (!/^https?:/.test(page.url())) await open(page);
    await sweepOwnUsers(page);
  });

  test('利用者が増えても一覧の最下行までスクロールでき、パスワードのダイアログを開ける', async ({ page }) => {
    await open(page);
    const created: string[] = [];
    for (let i = 0; i < USERS; i += 1) created.push(await createUser(page, i));
    const listed = await api(page, 'GET', '/api/admin/users');
    const mine = ((listed.json?.items as ManagedUser[] | undefined) ?? []).filter((u) => created.includes(u.email));
    expect(mine).toHaveLength(USERS);

    await openUsers(page);
    const pane = page.locator('#rin');
    // パネル自体が縦にスクロールする（縮小して収める作りのままなら overflow:visible のまま＝切れる）
    await expect
      .poll(async () => pane.evaluate((el) => getComputedStyle(el).overflowY), {
        message: '利用者の一覧がパネルの中でスクロールできません（下端の行とボタンが切れます）',
      })
      .toMatch(/^(auto|scroll)$/);
    // 一覧がパネルの高さを超えている（この状態で、縮小して収める作りだと下端が切れる）
    await expect
      .poll(async () => pane.evaluate((el) => el.scrollHeight - el.clientHeight), {
        message: '利用者の一覧がパネルの高さを超えていません（この試験の前提）',
      })
      .toBeGreaterThan(0);

    // スクロールはパネルの中で完結する（ページ全体は縦に伸びない）
    expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerHeight),
    );

    // 最下行（いちばん後に作った利用者）のメールを読み、その「パスワード」ボタンまでスクロールして押す
    const lastRow = pane.locator('.dlist .li').last();
    const lastEmail = (await lastRow.locator('.m .mono').first().innerText()).trim();
    expect(OWN_EMAIL.test(lastEmail), `最下行がこの試験で作った利用者ではありません: ${lastEmail}`).toBe(true);
    const password = lastRow.locator('[data-a="uPw"]');
    await password.scrollIntoViewIfNeeded();
    await expect(password).toBeInViewport();
    await expect.poll(async () => pane.evaluate((el) => Math.round(el.scrollTop))).toBeGreaterThan(0);
    await password.click();

    // 押せたことの証拠: その利用者のパスワード再設定ダイアログが開く
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal')).toContainText('パスワードを再設定');
    await expect(page.locator('#modal')).toContainText(lastEmail);
    await page.click('#modal [data-a="closeModal"]');
    await expect(page.locator('#modal.open')).toHaveCount(0);

    // 一覧のほかの行もスクロールで押せる（最下行だけの偶然ではない）
    const second = pane.locator('.dlist .li').nth(1);
    const secondPassword = second.locator('[data-a="uPw"]');
    await secondPassword.scrollIntoViewIfNeeded();
    await secondPassword.click();
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await page.click('#modal [data-a="closeModal"]');
    await expect(page.locator('#modal.open')).toHaveCount(0);
  });
});
