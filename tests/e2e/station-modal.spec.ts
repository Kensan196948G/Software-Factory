import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * ステーション画面のダイアログの回帰 E2E（実サーバ・実DB。CI は使い捨ての DB）。
 *
 * 1. 閉じたダイアログに、入力したパスワードを残さない（利用者の追加・パスワードの再設定）。
 *    旧画面では tests/browser-legacy/admin-users.spec.ts が守っていた性質。
 * 2. 理由（メモ）が必須の状態変更は、送信する前に止める（成功の表示を出さない）。
 *    サーバの決まりは src/shared/domain.ts の isReasonRequired。
 *
 * データはすべて架空（example.com）。ログインは auth.setup.ts の共有セッションを使い、追加のログインはしない。
 * seed の依頼と管理者自身は変更しない（この試験が作った依頼・利用者だけを操作する）。
 * 後片付け: 追加した利用者は最後に無効化する。依頼は物理削除の API が無いため、DB に残る（CI は使い捨ての DB）。
 */

type Role = 'requester' | 'desk' | 'approver';

type SFWindow = Window & {
  __SF: { S: { role: string; data: { items: { id: string; title: string; status: string }[] } } };
  __toasts?: { text: string; cls: string }[];
};

interface Called<T> {
  status: number;
  body: T;
}

interface SessionUser {
  id: string;
  displayName: string;
  actingRole: Role;
}

interface RequestDetail {
  id: string;
  status: string;
  version: number;
  comments: { text: string }[];
}

interface ManagedUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
  isActive: boolean;
}

/** 作り物のパスワード（実在のものではない）。画面に残らないことを確かめるための固定値。 */
const SYNTHETIC_PASSWORD_ADD = 'Synthetic-test-pass-add-2026';
const SYNTHETIC_PASSWORD_CANCEL = 'Synthetic-test-pass-cancel-2026';
const SYNTHETIC_PASSWORD_RESET = 'Synthetic-test-pass-reset-2026';
const SYNTHETIC_PASSWORD_REJECTED = 'Synthetic-test-pass-rejected-2026';
const SYNTHETIC_PASSWORD_OFFLINE = 'Synthetic-test-pass-offline-2026';
const SYNTHETIC_PASSWORD_STALE = 'Synthetic-test-pass-stale-2026';
const SYNTHETIC_PASSWORD_KEPT = 'Synthetic-test-pass-kept-2026';
/** サーバの方針（10文字以上）に届かない、拒否されるための値。 */
const TOO_SHORT_PASSWORD = 'short-7';
const SYNTHETIC_PASSWORDS = [
  SYNTHETIC_PASSWORD_ADD,
  SYNTHETIC_PASSWORD_CANCEL,
  SYNTHETIC_PASSWORD_RESET,
  SYNTHETIC_PASSWORD_REJECTED,
  SYNTHETIC_PASSWORD_OFFLINE,
  SYNTHETIC_PASSWORD_STALE,
  SYNTHETIC_PASSWORD_KEPT,
  TOO_SHORT_PASSWORD,
];

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const STATUS_DIALOG = '[data-a="status"][title="状態を変更"]';
const REASON_MESSAGE = '理由をメモに書いてください';

const stamp = (): string => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/* ───────── サーバ（API）を直接呼ぶ。画面とは独立に、サーバの正本を確かめるために使う ───────── */

async function callWith<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<Called<T>> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    const res = await request.get('/api/auth/csrf');
    const json = (await res.json()) as { csrf: string | null };
    if (json.csrf) headers['x-csrf-token'] = json.csrf;
  }
  const res = await request.fetch(path, { method, headers, ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status(), body: body as T };
}

/** 共有のセッション（auth.setup.ts の管理者）でサーバを呼ぶ。 */
function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<Called<T>> {
  return callWith<T>(page.request, method, path, data);
}

async function me(page: Page): Promise<SessionUser> {
  const res = await call<{ user: SessionUser }>(page, 'GET', '/api/auth/me');
  expect(res.status).toBe(200);
  return res.body.user;
}

async function detail(page: Page, id: string): Promise<RequestDetail> {
  const res = await call<{ request: RequestDetail }>(page, 'GET', `/api/requests/${encodeURIComponent(id)}`);
  expect(res.status).toBe(200);
  return res.body.request;
}

const serverStatus = async (page: Page, id: string): Promise<string> => (await detail(page, id)).status;

async function switchServerRole(page: Page, role: Role): Promise<void> {
  const res = await call<{ user: SessionUser }>(page, 'POST', '/api/auth/role', { role });
  expect(res.status).toBe(200);
  expect(res.body.user.actingRole).toBe(role);
}

/** 準備用: API で依頼を 1 件登録する。起票者と部署は見本名簿の社員、承認者はログイン中の利用者にする。 */
async function createViaApi(page: Page, title: string): Promise<string> {
  const user = await me(page);
  const roster = await call<{ items: { name: string; divisionCode: string }[] }>(page, 'GET', '/api/mirai/employees');
  const person = roster.body.items.find((p) => p.divisionCode);
  if (!person) throw new Error('見本名簿に部署つきの社員がいません');
  const res = await call<{ request: RequestDetail }>(page, 'POST', '/api/requests', {
    title,
    kind: 'new_tool',
    deptCode: person.divisionCode,
    applicant: person.name,
    problem: 'ダイアログの回帰 E2E のための架空の困りごとです',
    purpose: 'ダイアログの回帰 E2E で画面とサーバの挙動を確かめる',
    users: ['現場の担当者'],
    scope: ['依頼の登録', '状態の変更'],
    outOfScope: ['写真の加工'],
    criteria: ['登録した依頼が一覧とサーバの両方に残る'],
    decides: 'g',
    approver: user.displayName,
    approverUserId: user.id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.request.status).toBe('received');
  return res.body.request.id;
}

/** 準備用: API で状態を 1 つ進める（役割はサーバのセッションの役割）。 */
async function transitionApi(page: Page, id: string, to: string, extra: Record<string, unknown> = {}): Promise<void> {
  const current = await detail(page, id);
  const res = await call(page, 'POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
    to,
    version: current.version,
    ...extra,
  });
  expect(res.status, `${to}: ${JSON.stringify(res.body)}`).toBe(200);
}

/* ───────── 画面の操作 ───────── */

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#nav');
  await expect(page.locator('#stat')).toContainText('サーバ保存');
}

/** サーバの役割を切り替えてから画面を開き直す（画面の「操作する人」は起動データの役割で始まる）。 */
async function actAs(page: Page, role: Role): Promise<void> {
  await switchServerRole(page, role);
  await open(page);
  await expect.poll(async () => page.evaluate(() => (window as unknown as SFWindow).__SF.S.role)).toBe(role);
}

async function selectInReview(page: Page, id: string): Promise<void> {
  await page.click('#nav a[data-v="review"]');
  await page.click(`#work .li[data-id="${id}"]`);
  await expect(page.locator('#rin .dp-h')).toContainText(id);
}

async function openUsers(page: Page): Promise<void> {
  await page.click('#nav a[data-v="settings"]');
  await page.click('#setleft .li[data-v="users"]');
  await expect(page.locator('#rin [data-a="uAdd"]')).toBeVisible();
}

/**
 * 利用者の行の「パスワード」からダイアログを開く。
 * 右端のパネルはスクロールせず縮小して収める作りで、利用者が多い DB（同じ DB で試験を繰り返したとき）では
 * 下の行がパネルの外へ切れてマウスで押せない。ここで確かめたいのはダイアログの中身なので、行の位置に
 * 左右されないよう、ボタンへ click イベントを直接送る（画面の処理は document の click で受けている）。
 */
async function openPasswordDialog(page: Page, userId: string): Promise<void> {
  const button = page.locator(`#rin [data-a="uPw"][data-id="${userId}"]`);
  await expect(button).toHaveCount(1);
  await button.dispatchEvent('click');
  await expect(page.locator('#modal.open #uNewPw')).toBeVisible();
}

/** これ以降に出たトーストをすべて記録する（トーストは約 3 秒で消えるため、後から読めるようにする）。 */
async function watchToasts(page: Page): Promise<() => Promise<{ text: string; cls: string }[]>> {
  await page.evaluate(() => {
    const w = window as unknown as SFWindow;
    w.__toasts = [];
    const box = document.getElementById('toast');
    if (!box) throw new Error('#toast がありません');
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          const el = node as Element;
          (w.__toasts as { text: string; cls: string }[]).push({ text: el.textContent ?? '', cls: el.className ?? '' });
        });
      }
    }).observe(box, { childList: true });
  });
  return () => page.evaluate(() => (window as unknown as SFWindow).__toasts ?? []);
}

/** これ以降に画面が送った、依頼への書き込み（GET 以外）を記録する。 */
function watchRequestWrites(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET' && path.startsWith('/api/requests')) sent.push(`${req.method()} ${path}`);
  });
  return sent;
}

/**
 * 画面が次に送る 1 件（method と path が一致するもの）を、サーバへ届く前に止める。
 * held は画面が送った時点で解決する。release() で送り、応答はサーバのものをそのまま返す。
 */
async function holdNext(page: Page, method: string, path: string): Promise<{ held: Promise<void>; release: () => void }> {
  let seen: () => void = () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (seen = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let used = false;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (used || route.request().method() !== method) return route.fallback();
      used = true;
      seen();
      await gate;
      await route.continue();
    },
  );
  return { held, release };
}

/** 画面が送る該当のリクエストを、通信の失敗にする（サーバへは届かない）。 */
async function failRequests(page: Page, method: string, path: string): Promise<void> {
  await page.route(
    (url) => url.pathname === path,
    (route) => (route.request().method() === method ? route.abort('failed') : route.fallback()),
  );
}

/** 文字列が、入力欄の値・DOM・端末の保存領域のどこにも無いことを確かめるための調査。 */
async function traces(page: Page, secret: string) {
  return page.evaluate((pw) => {
    const fields = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLInputElement[];
    const inStore = (store: Storage): boolean => JSON.stringify(Object.entries(store)).includes(pw);
    return {
      inField: fields.some((el) => String(el.value ?? '').includes(pw)),
      filledPasswordFields: fields.filter((el) => el.type === 'password' && el.value !== '').length,
      inHtml: document.documentElement.outerHTML.includes(pw),
      inLocalStorage: inStore(localStorage),
      inSessionStorage: inStore(sessionStorage),
    };
  }, secret);
}

const NO_TRACE = { inField: false, filledPasswordFields: 0, inHtml: false, inLocalStorage: false, inSessionStorage: false };

/** 理由なしで「変更する」を押し、送信前に止まること（成功の表示なし・ダイアログは開いたまま・送信なし）を確かめる。 */
async function expectStoppedForReason(
  page: Page,
  id: string,
  to: string,
  before: string,
  toasts: () => Promise<{ text: string; cls: string }[]>,
  sent: string[],
): Promise<void> {
  const seen = (await toasts()).length;
  await page.check(`#modal input[name="ns"][value="${to}"]`);
  await expect(page.locator('#modal #nnote')).toHaveValue('');
  await page.click('#modal [data-a="sok"]');
  await expect.poll(async () => (await toasts()).slice(seen).map((t) => t.text)).toContain(REASON_MESSAGE);
  // 送信してしまう作りなら、この間にサーバへ届き、成功の表示も出ている
  await page.waitForTimeout(1500);
  const shown = (await toasts()).slice(seen);
  expect(
    shown.filter((t) => /にしました|承認/.test(t.text) || /\bok\b/.test(t.cls)),
    '成功の表示を出さない',
  ).toEqual([]);
  expect(shown.filter((t) => t.text === REASON_MESSAGE).length, '理由の案内は 1 回だけ（サーバの拒否が後から重ならない）').toBe(
    1,
  );
  await expect(page.locator('#modal.open')).toHaveCount(1);
  await expect(page.locator(`#modal input[name="ns"][value="${to}"]`)).toBeChecked();
  expect(sent, '理由が無いあいだはサーバへ送らない').toEqual([]);
  expect(await serverStatus(page, id)).toBe(before);
  expect(
    await page.evaluate((rid) => (window as unknown as SFWindow).__SF.S.data.items.find((r) => r.id === rid)?.status ?? '', id),
  ).toBe(before);
}

let initialRole: Role | null = null;

test.beforeEach(async ({ page }) => {
  if (!initialRole) initialRole = (await me(page)).actingRole;
  await open(page);
});

// 後続の試験（station.spec.ts など）が、この試験の役割の切り替えに影響されないように戻す
test.afterEach(async ({ page }) => {
  if (initialRole) await switchServerRole(page, initialRole);
});

test.describe.serial('ダイアログ: 入力したパスワードを残さない', () => {
  // 同じ架空の利用者を使う（追加 → 再設定 → 拒否 → 通信の失敗 → 入れ違い）。管理者自身のパスワードは変えない
  const account = { email: '', name: '', id: '' };
  const consoleLines: string[] = [];

  test.beforeEach(({ page }) => {
    consoleLines.length = 0;
    page.on('console', (message) => consoleLines.push(message.text()));
    page.on('pageerror', (error) => consoleLines.push(String(error)));
  });

  // 入力したパスワードを、ブラウザのコンソールにも出さない
  test.afterEach(() => {
    expect(consoleLines.filter((line) => SYNTHETIC_PASSWORDS.some((pw) => line.includes(pw))).length).toBe(0);
  });

  // 後片付け: 追加した利用者（依頼者の役割だけ）を無効化する。失敗は隠さない
  test.afterAll(async ({ browser }, testInfo) => {
    if (!account.email) return; // 利用者を追加する前に終わった
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      const list = await callWith<{ items: ManagedUser[] }>(context.request, 'GET', '/api/admin/users');
      expect(list.status).toBe(200);
      const created = list.body.items.find((u) => u.email === account.email);
      if (!created) return; // 追加そのものが失敗していた（片付けるものが無い）
      expect(created.isAdmin).toBe(false);
      const res = await callWith<{ user: ManagedUser }>(context.request, 'PATCH', `/api/admin/users/${created.id}`, {
        isActive: false,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user.isActive).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('利用者を追加した後、入力したパスワードが画面のどこにも残らない', async ({ page }) => {
    const mark = stamp();
    account.email = `e2e-modal-${mark}@example.com`;
    account.name = `E2E ダイアログ 利用者 ${mark}`;

    await openUsers(page);
    const toasts = await watchToasts(page);
    await page.click('#rin [data-a="uAdd"]');
    await expect(page.locator('#modal.open')).toBeVisible();
    await page.fill('#modal #uName', account.name);
    await page.fill('#modal #uEmail', account.email);
    await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_ADD);
    // 承認者の役割は付けない（承認者の候補を増やさない）
    await expect(page.locator('#modal input[name="urole"][value="requester"]')).toBeChecked();
    await expect(page.locator('#modal input[name="urole"][value="approver"]')).not.toBeChecked();
    await page.click('#modal [data-a="uAddOk"]');

    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('利用者を追加しました');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    await expect(page.locator('#rin .dlist .li').filter({ hasText: account.email })).toHaveCount(1);

    // 閉じたダイアログに入力欄を残さない。値は入力欄・DOM・端末の保存領域・トーストのどこにも無い
    await expect(page.locator('#modal input, #modal textarea')).toHaveCount(0);
    expect(await traces(page, SYNTHETIC_PASSWORD_ADD)).toEqual(NO_TRACE);
    expect((await toasts()).some((t) => t.text.includes(SYNTHETIC_PASSWORD_ADD))).toBe(false);

    const users = await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users');
    const created = users.body.items.find((u) => u.email === account.email);
    expect(created).toBeDefined();
    expect(created?.roles).toEqual(['requester']);
    expect(created?.isAdmin).toBe(false);
    account.id = created?.id ?? '';
    expect(account.id).not.toBe((await me(page)).id);
  });

  test('追加をキャンセル・Escape・背景クリックで閉じても、入力したパスワードが残らない', async ({ page }) => {
    await openUsers(page);
    const before = (await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length;
    const closers: [string, () => Promise<void>][] = [
      ['キャンセル', () => page.click('#modal [data-a="closeModal"]')],
      ['Escape', () => page.keyboard.press('Escape')],
      ['背景クリック', () => page.locator('#modal').click({ position: { x: 4, y: 4 } })],
    ];
    for (const [label, close] of closers) {
      await page.click('#rin [data-a="uAdd"]');
      await expect(page.locator('#modal.open')).toBeVisible();
      await page.fill('#modal #uName', `E2E ダイアログ 閉じる ${label}`);
      await page.fill('#modal #uEmail', `e2e-modal-closed-${stamp()}@example.com`);
      await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_CANCEL);
      await close();
      await expect(page.locator('#modal.open'), label).toHaveCount(0);
      await expect(page.locator('#modal input, #modal textarea'), label).toHaveCount(0);
      expect(await traces(page, SYNTHETIC_PASSWORD_CANCEL), label).toEqual(NO_TRACE);
    }
    // 閉じただけでは利用者を作らない。開き直したダイアログは空で始まる
    expect((await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length).toBe(before);
    await page.click('#rin [data-a="uAdd"]');
    await expect(page.locator('#modal #uPass')).toHaveValue('');
    await expect(page.locator('#modal #uName')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
  });

  test('パスワードを再設定した後、入力したパスワードが画面のどこにも残らない', async ({ page }) => {
    expect(account.id, '前の試験で利用者を追加できていること').not.toBe('');
    await openUsers(page);
    const toasts = await watchToasts(page);
    await openPasswordDialog(page, account.id);
    await expect(page.locator('#modal.open')).toContainText(account.email);
    await page.fill('#modal #uNewPw', SYNTHETIC_PASSWORD_RESET);
    const patched = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === `/api/admin/users/${account.id}`,
    );
    await page.click('#modal [data-a="uPwOk"]');
    expect((await patched).status()).toBe(200);

    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('パスワードを再設定しました');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    await expect(page.locator('#modal input, #modal textarea')).toHaveCount(0);
    expect(await traces(page, SYNTHETIC_PASSWORD_RESET)).toEqual(NO_TRACE);
    expect((await toasts()).some((t) => t.text.includes(SYNTHETIC_PASSWORD_RESET))).toBe(false);
  });

  test('サーバが拒否したときはダイアログを開いたまま、パスワード欄だけを空にする', async ({ page }) => {
    expect(account.id, '前の試験で利用者を追加できていること').not.toBe('');
    await openUsers(page);

    // 追加: 既に使われているメールアドレス（ERR-004）
    const toasts = await watchToasts(page);
    await page.click('#rin [data-a="uAdd"]');
    await page.fill('#modal #uName', 'E2E ダイアログ 重複');
    await page.fill('#modal #uEmail', account.email);
    await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_REJECTED);
    await page.click('#modal [data-a="uAddOk"]');
    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('このメールアドレスは既に使われています');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uPass')).toHaveValue('');
    // 入力し直すのはパスワードだけ（ほかの欄は残す）
    await expect(page.locator('#modal #uEmail')).toHaveValue(account.email);
    await expect(page.locator('#modal #uName')).toHaveValue('E2E ダイアログ 重複');
    expect(await traces(page, SYNTHETIC_PASSWORD_REJECTED)).toEqual(NO_TRACE);
    expect((await toasts()).some((t) => t.text === '利用者を追加しました')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);

    // 再設定: 方針（10文字以上）に届かないパスワード
    await openPasswordDialog(page, account.id);
    await page.fill('#modal #uNewPw', TOO_SHORT_PASSWORD);
    await page.click('#modal [data-a="uPwOk"]');
    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('パスワードは10文字以上にしてください');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uNewPw')).toHaveValue('');
    expect(await traces(page, TOO_SHORT_PASSWORD)).toEqual(NO_TRACE);
    expect((await toasts()).some((t) => t.text === 'パスワードを再設定しました')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);

    // 共有セッションの管理者は操作していない
    const admin = (await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.find(
      (u) => u.email === ADMIN_EMAIL,
    );
    expect(admin?.isAdmin).toBe(true);
  });

  test('通信に失敗したときもダイアログを開いたまま、パスワード欄だけを空にする', async ({ page }) => {
    expect(account.id, '前の試験で利用者を追加できていること').not.toBe('');
    await openUsers(page);
    const before = (await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length;
    const toasts = await watchToasts(page);
    const email = `e2e-modal-offline-${stamp()}@example.com`;

    // 追加: リクエストがサーバへ届かない
    await failRequests(page, 'POST', '/api/admin/users');
    await page.click('#rin [data-a="uAdd"]');
    await page.fill('#modal #uName', 'E2E ダイアログ 通信失敗');
    await page.fill('#modal #uEmail', email);
    await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_OFFLINE);
    await page.click('#modal [data-a="uAddOk"]');
    await expect.poll(async () => (await toasts()).filter((t) => /\bbad\b/.test(t.cls)).length).toBe(1);
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uPass')).toHaveValue('');
    await expect(page.locator('#modal #uEmail')).toHaveValue(email);
    await expect(page.locator('#modal #uName')).toHaveValue('E2E ダイアログ 通信失敗');
    expect(await traces(page, SYNTHETIC_PASSWORD_OFFLINE)).toEqual(NO_TRACE);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);

    // 再設定: リクエストがサーバへ届かない
    await failRequests(page, 'PATCH', `/api/admin/users/${account.id}`);
    await openPasswordDialog(page, account.id);
    await page.fill('#modal #uNewPw', SYNTHETIC_PASSWORD_OFFLINE);
    await page.click('#modal [data-a="uPwOk"]');
    await expect.poll(async () => (await toasts()).filter((t) => /\bbad\b/.test(t.cls)).length).toBe(2);
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uNewPw')).toHaveValue('');
    expect(await traces(page, SYNTHETIC_PASSWORD_OFFLINE)).toEqual(NO_TRACE);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);

    const shown = await toasts();
    expect(shown.filter((t) => /\bok\b/.test(t.cls))).toEqual([]);
    expect(shown.some((t) => t.text.includes(SYNTHETIC_PASSWORD_OFFLINE))).toBe(false);
    expect((await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length).toBe(before);
  });

  test('先の送信が後から失敗しても、開き直した別のダイアログのパスワードを消さない', async ({ page }) => {
    expect(account.id, '前の試験で利用者を追加できていること').not.toBe('');
    await openUsers(page);
    const before = (await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length;
    const toasts = await watchToasts(page);

    // 追加: 1 件目（既に使われているメールアドレス）を、サーバへ届く前に止めておく
    const firstAdd = await holdNext(page, 'POST', '/api/admin/users');
    await page.click('#rin [data-a="uAdd"]');
    await page.fill('#modal #uName', 'E2E ダイアログ 入れ違い 1');
    await page.fill('#modal #uEmail', account.email);
    await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_STALE);
    await page.click('#modal [data-a="uAddOk"]');
    await firstAdd.held;
    // 応答を待つあいだに閉じ、2 件目のダイアログを開いて入力する（まだ送らない）
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    const secondEmail = `e2e-modal-second-${stamp()}@example.com`;
    await page.click('#rin [data-a="uAdd"]');
    await page.fill('#modal #uName', 'E2E ダイアログ 入れ違い 2');
    await page.fill('#modal #uEmail', secondEmail);
    await page.fill('#modal #uPass', SYNTHETIC_PASSWORD_KEPT);
    // 1 件目がサーバに拒否される（ERR-004）。2 件目の入力はそのまま残る
    firstAdd.release();
    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('このメールアドレスは既に使われています');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uPass')).toHaveValue(SYNTHETIC_PASSWORD_KEPT);
    await expect(page.locator('#modal #uEmail')).toHaveValue(secondEmail);
    await expect(page.locator('#modal #uName')).toHaveValue('E2E ダイアログ 入れ違い 2');
    expect(await traces(page, SYNTHETIC_PASSWORD_STALE)).toEqual({ ...NO_TRACE, filledPasswordFields: 1 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    expect(await traces(page, SYNTHETIC_PASSWORD_KEPT)).toEqual(NO_TRACE);

    // 再設定: 1 件目（方針に届かないパスワード）を止めておき、開き直して別の値を入れる
    const firstReset = await holdNext(page, 'PATCH', `/api/admin/users/${account.id}`);
    await openPasswordDialog(page, account.id);
    await page.fill('#modal #uNewPw', TOO_SHORT_PASSWORD);
    await page.click('#modal [data-a="uPwOk"]');
    await firstReset.held;
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    await openPasswordDialog(page, account.id);
    await page.fill('#modal #uNewPw', SYNTHETIC_PASSWORD_KEPT);
    firstReset.release();
    await expect.poll(async () => (await toasts()).map((t) => t.text)).toContain('パスワードは10文字以上にしてください');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    await expect(page.locator('#modal #uNewPw')).toHaveValue(SYNTHETIC_PASSWORD_KEPT);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    expect(await traces(page, SYNTHETIC_PASSWORD_KEPT)).toEqual(NO_TRACE);

    // どちらも成功していない（利用者は増えず、成功の表示も出ていない）
    expect((await toasts()).filter((t) => /\bok\b/.test(t.cls))).toEqual([]);
    expect((await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.length).toBe(before);
  });
});

test.describe('ダイアログ: 理由が必須の状態変更は送信前に止める', () => {
  test('理由なしの「取消」は成功の表示を出さず、送信もしない', async ({ page }) => {
    const id = await createViaApi(page, `E2E ダイアログ 取消なし ${stamp()}`);
    await actAs(page, 'desk');
    await selectInReview(page, id);
    const toasts = await watchToasts(page);
    const sent = watchRequestWrites(page);

    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal.open')).toBeVisible();
    await expectStoppedForReason(page, id, 'cancel', 'received', toasts, sent);
    // 必須であることを、ダイアログの注記でも伝える
    await expect(page.locator('#modal.open')).toContainText('差戻し・見送り・取消は必須');

    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    expect(await serverStatus(page, id)).toBe('received');
  });

  test('理由を書けば「取消」にできる', async ({ page }) => {
    const id = await createViaApi(page, `E2E ダイアログ 取消あり ${stamp()}`);
    const reason = `E2E ダイアログ: 重複のため取り消します ${stamp()}`;
    await actAs(page, 'desk');
    await selectInReview(page, id);
    const toasts = await watchToasts(page);

    await page.click(`#rin ${STATUS_DIALOG}`);
    await page.check('#modal input[name="ns"][value="cancel"]');
    await page.fill('#modal #nnote', reason);
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('cancel');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    expect((await detail(page, id)).comments.map((c) => c.text)).toContain(reason);
    const shown = (await toasts()).map((t) => t.text);
    expect(shown).toContain(`${id} を「取消」にしました`);
    expect(shown).not.toContain(REASON_MESSAGE);
  });

  test('理由なしの「差戻し」「見送り」も、これまでどおり送信前に止まる', async ({ page }) => {
    const id = await createViaApi(page, `E2E ダイアログ 差戻し ${stamp()}`);
    await actAs(page, 'desk');
    await selectInReview(page, id);
    const toasts = await watchToasts(page);
    const sent = watchRequestWrites(page);

    // 「差戻し」のボタンから開くと、差戻しが選ばれた状態で始まる
    await page.click(`#rin [data-a="status"][data-id="${id}"][data-v="back"]`);
    await expect(page.locator('#modal.open input[name="ns"][value="back"]')).toBeChecked();
    await expectStoppedForReason(page, id, 'back', 'received', toasts, sent);
    await expectStoppedForReason(page, id, 'hold', 'received', toasts, sent);

    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    expect(await serverStatus(page, id)).toBe('received');
  });

  test('現場試用から実装中へ戻すときも理由が必須で、理由を書けば戻せる', async ({ page }) => {
    const id = await createViaApi(page, `E2E ダイアログ 戻し ${stamp()}`);
    // 準備: 受付 → 内容確認中 → 承認待ち → 承認済み → 実装中 → 検証中 → 現場試用（API）
    await switchServerRole(page, 'desk');
    await transitionApi(page, id, 'review');
    await transitionApi(page, id, 'wait');
    await switchServerRole(page, 'approver');
    await transitionApi(page, id, 'approved', { signal: 'g', checklistAcknowledged: true });
    await switchServerRole(page, 'desk');
    await transitionApi(page, id, 'dev');
    await transitionApi(page, id, 'verify');
    await transitionApi(page, id, 'field');

    const reason = `E2E ダイアログ: 現場で不具合が出たため実装へ戻します ${stamp()}`;
    await actAs(page, 'desk');
    await page.click('#nav a[data-v="board"]');
    await page.click(`#work .kc[data-id="${id}"]`);
    await expect(page.locator('#rin')).toContainText(id);
    const toasts = await watchToasts(page);
    const sent = watchRequestWrites(page);

    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal.open')).toBeVisible();
    await expectStoppedForReason(page, id, 'dev', 'field', toasts, sent);

    await page.fill('#modal #nnote', reason);
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('dev');
    expect((await detail(page, id)).comments.map((c) => c.text)).toContain(reason);
  });
});
