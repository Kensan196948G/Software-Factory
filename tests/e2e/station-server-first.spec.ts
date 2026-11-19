import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * ステーション画面の回帰 E2E（2026-11-18 追加。F-3 / F-1）。
 *
 * F-3: 状態変更の画面は、サーバの応答が返る前に成功の演出（トースト・承認の完了表示・紙吹雪）を出していた。
 *      サーバが拒否しても「承認しました」が出て、画面の状態・履歴・コメントも進んで見えていた。
 *      ここでは、サーバが拒否したときに
 *        - 成功の演出（トースト・承認の完了表示・紙吹雪）が一切出ないこと
 *        - 画面の状態・履歴・コメント・信号が元に戻ること（サーバの正本と同じ）
 *        - サーバの依頼が変わっていないこと
 *      を確かめる。拒否は、実サーバの拒否（承認者ではない人の承認・遷移表に無い変更）と、
 *      ブラウザ側で作る応答（403）の両方を使う。403 の試験では、故障を解けば同じ画面からやり直せることも見る。
 * F-1: 注文書タブとダウンロードは、サーバ接続時に API（GET /api/requests/:id/order）の確定版を出す。
 *      承認後に order_version が画面で読め、ダウンロードの内容が API の YAML と一致することを確かめる。
 *
 * 約束:
 * - seed の依頼は変更しない。操作するのはこのファイルが登録する依頼（件名に E2E を含む）だけ。
 * - 実サーバの拒否を使う試験では、依頼の承認者を別の利用者にして、共有セッションの利用者が承認する
 *   （サーバは ERR-201 で拒否する。画面の役割の判定だけでは止まらない組）。
 * - 追加した承認者は最後に無効化する。依頼は物理削除の API が無いため DB に残る（CI は使い捨ての DB）。
 */

type Role = 'requester' | 'desk' | 'approver';

type SFWindow = Window & {
  __SF: {
    S: {
      role: string;
      data: {
        items: { id: string; status: string; signalFinal?: string; history?: unknown[]; comments?: unknown[] }[];
      };
    };
  };
  __toasts?: { text: string; cls: string }[];
};

type Called<T> = { status: number; body: T };

interface SessionUser {
  id: string;
  displayName: string;
  actingRole: Role;
  roles: Role[];
}

interface RequestDetail {
  id: string;
  title: string;
  status: string;
  version: number;
  signalDecided: string | null;
  history: { action: string }[];
  comments: { text: string }[];
}

interface ManagedUser {
  id: string;
  displayName: string;
  roles: string[];
  isActive: boolean;
}

interface ApiError {
  error?: { code?: string; message?: string };
}

const CRITERION = '状態変更の成功はサーバの応答のあとに出す（数字で確認できる）';
const STATUS_DIALOG = '[data-a="status"][title="状態を変更"]';

const stamp = (): string => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/* ───────── サーバ（API）を直接呼ぶ ───────── */

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

function call<T>(page: Page, method: string, path: string, data?: unknown): Promise<Called<T>> {
  return callWith<T>(page.request, method, path, data);
}

const codeOf = (res: Called<unknown>): string => (res.body as ApiError | null)?.error?.code ?? '';
const messageOf = (res: Called<unknown>): string => (res.body as ApiError | null)?.error?.message ?? '';

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

/** 準備用: API で依頼を 1 件登録する。承認者は指定でき、省略時はログイン中の利用者。 */
async function createViaApi(page: Page, title: string, approver?: { id: string; displayName: string }): Promise<{ id: string }> {
  const user = await me(page);
  const roster = await call<{ items: { name: string; divisionCode: string }[] }>(page, 'GET', '/api/mirai/employees');
  const person = roster.body.items.find((p) => p.divisionCode);
  if (!person) throw new Error('見本名簿に部署つきの社員がいません');
  const who = approver ?? { id: user.id, displayName: user.displayName };
  const res = await call<{ request: RequestDetail }>(page, 'POST', '/api/requests', {
    title,
    kind: 'new_tool',
    deptCode: person.divisionCode,
    applicant: person.name,
    problem: 'F-3 の回帰 E2E のための架空の困りごとです',
    purpose: 'サーバが拒否したときに成功の演出を出さないことを確かめる',
    users: ['現場の担当者'],
    scope: ['状態の変更'],
    outOfScope: ['写真の加工'],
    criteria: [CRITERION],
    decides: 'g',
    approver: who.displayName,
    approverUserId: who.id,
  });
  expect(res.status, messageOf(res)).toBe(201);
  expect(res.body.request.status).toBe('received');
  return { id: res.body.request.id };
}

/** 準備用: API で状態を進める（役割はサーバのセッションの役割。CSRF と最新の版を付ける）。 */
async function transitionApi(page: Page, id: string, to: string, extra: Record<string, unknown> = {}): Promise<void> {
  const current = await detail(page, id);
  const res = await call(page, 'POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
    to,
    version: current.version,
    ...extra,
  });
  expect(res.status, messageOf(res)).toBe(200);
}

/** 準備用: 架空の承認者を 1 人作る（このファイルの最後で無効化する）。 */
async function createApproverViaApi(page: Page): Promise<{ id: string; displayName: string }> {
  const mark = stamp();
  const depts = await call<{ items: { code: string }[] }>(page, 'GET', '/api/catalog/departments');
  const res = await call<{ user: ManagedUser }>(page, 'POST', '/api/admin/users', {
    email: `e2e-server-first-${mark}@example.com`,
    displayName: `E2E 承認者 ${mark}`,
    deptCode: depts.body.items[0]?.code ?? '',
    password: `E2e-${mark}-${Math.random().toString(36).slice(2, 12)}`,
    roles: ['approver'],
    isAdmin: false,
  });
  expect(res.status, messageOf(res)).toBe(201);
  expect(res.body.user.roles).toEqual(['approver']);
  return { id: res.body.user.id, displayName: res.body.user.displayName };
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
  await expect(page.locator('#role')).toHaveValue(role);
  await expect.poll(async () => page.evaluate(() => (window as unknown as SFWindow).__SF.S.role)).toBe(role);
}

async function gotoTab(page: Page, view: string): Promise<void> {
  await page.click(`#nav a[data-v="${view}"]`);
  await expect(page.locator(`#nav a[data-v="${view}"]`)).toHaveClass(/\bon\b/);
}

async function selectInReview(page: Page, id: string): Promise<void> {
  await gotoTab(page, 'review');
  await page.click(`#work .li[data-id="${id}"]`);
  await expect(page.locator('#rin .dp-h')).toContainText(id);
}

/** これから画面が出すトーストを記録する。 */
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

/** 画面の依頼（ローカルの写し）の、巻き戻しを確かめる項目。 */
async function localRequest(
  page: Page,
  id: string,
): Promise<{ status: string; history: number; comments: number; signalFinal: string } | null> {
  return page.evaluate((rid) => {
    const it = (window as unknown as SFWindow).__SF.S.data.items.find((x) => x.id === rid);
    if (!it) return null;
    return {
      status: it.status,
      history: (it.history ?? []).length,
      comments: (it.comments ?? []).length,
      signalFinal: it.signalFinal ?? '',
    };
  }, id);
}

/** このファイルが作る承認者のメール。後始末はこの形の有効な利用者をサーバの一覧から探して無効化する。 */
const APPROVER_EMAIL_PREFIX = 'e2e-server-first-';
let initialRole: Role | null = null;

/** このファイルが作った承認者を有効なまま残さない（前回の実行の残りも無効化する）。 */
async function sweepApprovers(page: Page): Promise<void> {
  const list = await call<{ items: { id: string; email: string; isActive: boolean }[] }>(page, 'GET', '/api/admin/users');
  expect(list.status).toBe(200);
  const own = list.body.items.filter((u) => u.isActive && u.email.startsWith(APPROVER_EMAIL_PREFIX));
  for (const user of own) {
    const res = await call(page, 'PATCH', `/api/admin/users/${user.id}`, { isActive: false });
    expect(res.status).toBe(200);
  }
}

test.beforeEach(async ({ page }) => {
  await open(page);
  if (!initialRole) initialRole = (await page.locator('#role').inputValue()) as Role;
});

test.afterEach(async ({ page }) => {
  // 後続の spec に、このファイルの承認者・故障の差し込み・画面の役割を残さない
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto('/');
  await page.waitForSelector('#nav');
  await sweepApprovers(page);
  if (initialRole) {
    const res = await call(page, 'POST', '/api/auth/role', { role: initialRole });
    expect(res.status).toBe(200);
  }
});

/* ───────── F-3: サーバの拒否より先に成功の演出を出さない ───────── */

test.describe('状態変更はサーバの応答を待ってから成功を表示する', () => {
  test('承認者が違うためサーバが拒否したら、承認の完了表示を出さず、状態・履歴・コメントを戻す', async ({ page }) => {
    const title = `E2E サーバ先行 承認拒否 ${stamp()}`;
    const approver = await createApproverViaApi(page);
    const { id } = await createViaApi(page, title, approver);

    // 承認待ちまで進める（画面の役割は最後に受付担当へ戻る）
    await switchServerRole(page, 'desk');
    await transitionApi(page, id, 'review');
    await transitionApi(page, id, 'wait');

    // 共有セッションの利用者を承認者の役割にする。依頼の承認者は別の人なので、サーバは ERR-201 で拒否する。
    await actAs(page, 'approver');
    await selectInReview(page, id);
    const before = await localRequest(page, id);
    const beforeServer = await detail(page, id);
    const toasts = await watchToasts(page);

    // 承認（信号の色は候補のまま）を送る
    await page.click(`#rin [data-a="status"][data-id="${id}"][data-v="approved"]`);
    await expect(page.locator('#modal.open')).toBeVisible();
    await page.check('#modal input[name="fc"][value="g"]');
    await page.click('#modal [data-a="sok"]');

    // サーバのエラーだけが出る。成功のトースト・承認の完了表示・紙吹雪は出ない。
    await expect(page.locator('#toast')).toContainText('この依頼の承認者ではありません');
    const shown = (await toasts()).map((t) => t.text);
    expect(shown.filter((t) => t.includes('を「承認済み」にしました'))).toEqual([]);
    await expect(page.locator('#modal.open')).not.toContainText('承認完了');
    await expect(page.locator('#rsdone')).toHaveCount(0);
    await expect(page.locator('.confetti')).toHaveCount(0);

    // 画面の写しは、送る前（サーバの正本と同じ）に戻っている。
    expect(await localRequest(page, id)).toEqual(before);
    // サーバの依頼も変わっていない（版・履歴・コメント）。
    const afterServer = await detail(page, id);
    expect(afterServer.status).toBe('wait');
    expect(afterServer.version).toBe(beforeServer.version);
    expect(afterServer.signalDecided).toBeNull();
    expect(afterServer.history).toHaveLength(beforeServer.history.length);
    expect(afterServer.comments).toHaveLength(beforeServer.comments.length);

    // 画面を閉じても、承認済みにはなっていない。
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal.open')).toHaveCount(0);
    await expect(page.locator('#rin')).toContainText('承認待ち');
  });

  test('遷移表に無い「完了」をサーバが拒否したら、成功のトーストも紙吹雪も出さない', async ({ page }) => {
    const title = `E2E サーバ先行 紙吹雪 ${stamp()}`;
    const { id } = await createViaApi(page, title);

    // 承認済みまで進めておく。承認済み → 完了 は遷移表に無い（サーバは ERR-201 で拒否する）。
    await switchServerRole(page, 'desk');
    await transitionApi(page, id, 'review');
    await transitionApi(page, id, 'wait');
    await switchServerRole(page, 'approver');
    await transitionApi(page, id, 'approved', { signal: 'g', checklistAcknowledged: true });

    await actAs(page, 'approver');
    // 承認済みは「確認・承認」の一覧に出ないので、ボードから選ぶ
    await gotoTab(page, 'board');
    await page.click(`#work .kc[data-id="${id}"]`);
    await expect(page.locator('#rin')).toContainText(id);
    const before = await localRequest(page, id);
    const beforeServer = await detail(page, id);
    const toasts = await watchToasts(page);

    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal.open')).toBeVisible();
    await page.check('#modal input[name="ns"][value="done"]');
    await page.click('#modal [data-a="sok"]');

    await expect(page.locator('#toast')).toContainText('その状態へは変更できません');
    const shown = (await toasts()).map((t) => t.text);
    expect(shown.filter((t) => t.includes('を「完了」にしました'))).toEqual([]);
    await expect(page.locator('.confetti')).toHaveCount(0);

    expect(await localRequest(page, id)).toEqual(before);
    const afterServer = await detail(page, id);
    expect(afterServer.status).toBe('approved');
    expect(afterServer.version).toBe(beforeServer.version);
    expect(afterServer.history).toHaveLength(beforeServer.history.length);
    expect(afterServer.comments).toHaveLength(beforeServer.comments.length);
  });

  test('応答が 403 のときは成功を出さず、故障を解けば同じ画面からやり直せる', async ({ page }) => {
    const title = `E2E サーバ先行 403 ${stamp()}`;
    const { id } = await createViaApi(page, title);

    await actAs(page, 'desk');
    await selectInReview(page, id);
    const before = await localRequest(page, id);
    const beforeServer = await detail(page, id);
    const toasts = await watchToasts(page);

    await page.route('**/api/requests/*/transitions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-201', message: '権限がありません（E2E の故障）' } }),
      });
    });

    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal.open')).toBeVisible();
    await page.check('#modal input[name="ns"][value="review"]');
    await page.click('#modal [data-a="sok"]');

    await expect(page.locator('#toast')).toContainText('権限がありません（E2E の故障）');
    const shown = (await toasts()).map((t) => t.text);
    expect(shown.filter((t) => t.includes('を「内容確認中」にしました'))).toEqual([]);
    await expect(page.locator('.confetti')).toHaveCount(0);

    expect(await localRequest(page, id)).toEqual(before);
    const afterServer = await detail(page, id);
    expect(afterServer.status).toBe('received');
    expect(afterServer.version).toBe(beforeServer.version);
    expect(afterServer.history).toHaveLength(beforeServer.history.length);

    // 故障が解ければ、同じダイアログのままやり直せる（成功のトーストはこのときだけ出る）。
    await page.unroute('**/api/requests/*/transitions');
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('review');
    await expect(page.locator('#toast')).toContainText(`${id} を「内容確認中」にしました`);
    await expect(page.locator('#modal.open')).toHaveCount(0);
  });
});

/* ───────── F-1: 注文書はサーバの確定版を表示・ダウンロードする ───────── */

test.describe('注文書タブとダウンロードはサーバの確定版を使う', () => {
  test('承認後に注文書タブを開くと order_version が表示され、ダウンロードが API と一致する', async ({ page }) => {
    const title = `E2E 確定版 注文書 ${stamp()}`;
    const { id } = await createViaApi(page, title);

    // 承認前はサーバが注文書を出さない（ERR-205）
    const early = await call(page, 'GET', `/api/requests/${encodeURIComponent(id)}/order`);
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('ERR-205');

    await switchServerRole(page, 'desk');
    await transitionApi(page, id, 'review');
    await transitionApi(page, id, 'wait');
    await switchServerRole(page, 'approver');
    await transitionApi(page, id, 'approved', { signal: 'g', checklistAcknowledged: true });

    const order = await call<{ yaml: string; version: number }>(page, 'GET', `/api/requests/${encodeURIComponent(id)}/order`);
    expect(order.status).toBe(200);
    expect(order.body.version).toBe(1);
    expect(order.body.yaml).toContain('schema_version: "1.0"');
    expect(order.body.yaml).toContain('order_version: 1');
    expect(order.body.yaml).toContain(`id: "${id}"`);

    await actAs(page, 'desk');
    await gotoTab(page, 'list');
    await page.fill('#main [data-flt="fq"]', title);
    await page.click(`#ltb tr[data-id="${id}"]`);
    await expect(page.locator('#drawer.open .dp-h')).toContainText(id);

    // 注文書タブ: API の確定版が出る（order_version が画面で読める）
    await page.click('#drawer.open [data-a="dtab"][data-v="yaml"]');
    const shown = page.locator('#drawer.open pre.yaml');
    await expect(shown).toContainText('order_version: 1');
    await expect(shown).toContainText('schema_version: "1.0"');
    await expect(page.locator('#drawer.open')).toContainText('サーバの確定版');
    await expect(page.locator('#drawer.open')).toContainText('order_version: 1');
    expect((await shown.textContent())?.trim()).toBe(order.body.yaml.trim());

    // ダウンロードの内容が API の YAML と一致する
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(`#drawer.open [data-a="ydl"][data-id="${id}"]`),
    ]);
    expect(download.suggestedFilename()).toBe(`${id}_注文書.yaml`);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const file = Buffer.concat(chunks).toString('utf8');
    expect(file).toBe(order.body.yaml);

    // コピーも同じ文面を渡す
    await page.evaluate(() => {
      const holder = window as unknown as { __copied?: string };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            holder.__copied = text;
          },
        },
      });
    });
    await page.click(`#drawer.open [data-a="ycopy"][data-id="${id}"]`);
    await expect(page.locator('#toast')).toContainText('注文書をコピーしました');
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
    expect(copied).toBe(order.body.yaml);
  });

  test('サーバ非接続の見本では、注文書は従来どおり入力内容から作り、サーバは呼ばない', async ({ page }) => {
    // 起動データとサーバ接続の処理を外し、オフライン単体の見本として開く（station-approver.spec.ts と同じ作り）
    const calls: string[] = [];
    await page.route(
      (url) => url.pathname === '/',
      async (route) => {
        const res = await route.fetch();
        const html = (await res.text())
          .replace(/<script type="application\/json" id="msf-boot">[\s\S]*?<\/script>/, '')
          .replace(/<script src="\/station-bridge\.js[^"]*"><\/script>/, '');
        await route.fulfill({ response: res, body: html });
      },
    );
    await page.addInitScript(() => localStorage.clear());
    page.on('request', (req) => {
      if (new URL(req.url()).pathname.startsWith('/api/')) calls.push(req.method() + ' ' + new URL(req.url()).pathname);
    });

    await page.goto('/');
    await page.waitForSelector('#nav');
    await expect(page.locator('#stat')).toContainText('完全オフライン');

    await page.click('#nav a[data-v="list"]');
    const row = page.locator('#ltb tr[data-id]').first();
    await expect(row).toBeVisible();
    const rowId = (await row.getAttribute('data-id')) ?? '';
    expect(rowId).toMatch(/^REQ-/);
    await page.click(`#ltb tr[data-id="${rowId}"]`);
    await expect(page.locator('#drawer.open .dp-h')).toContainText(rowId);

    await page.click('#drawer.open [data-a="dtab"][data-v="yaml"]');
    const shown = page.locator('#drawer.open pre.yaml');
    await expect(shown).toContainText(`id: "${rowId}"`);
    // 見本は toYAML（サーバの確定版ではない）なので、order_version も「サーバの確定版」の印も無い
    await expect(shown).not.toContainText('order_version');
    await expect(page.locator('#drawer.open')).not.toContainText('サーバの確定版');
    expect(calls).toEqual([]);
  });
});
