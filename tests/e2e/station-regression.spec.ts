import { expect, test, type APIRequestContext, type BrowserContext, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * ステーション画面の回帰 E2E（2026-11-13 追加）。
 *
 * 2026-11-11 の画面置き換えで旧画面の E2E（tests/e2e-legacy/・tests/browser-legacy/）は CI から外れた。
 * ここでは、現行の画面に実在する機能のうち、旧 E2E が守っていた性質を実サーバ・実 DB で確かめる
 * （永続化・権限・理由が必要な遷移・一覧・利用者管理・監査ログ・注文書・ログアウト）。
 * 対応表と未被覆は docs/production/36-release-readiness-20261113.md にある。
 *
 * 約束:
 * - seed の依頼は変更しない。操作するのは、このファイルが登録した依頼（件名に E2E を含む）だけ。
 * - テストデータは架空（example.com）。起票者と部署は見本名簿（Mirai-Info の構造）から選ぶ
 *   （station.spec.ts の「一覧の起票者と部署が Mirai-Info に合う」が新しい依頼の行も見るため）。
 * - 追加のログインは 2 回だけ（管理者でない利用者・ログアウト）。共有のセッションは失効させない。
 * - 試験は互いに独立している（順序・再実行・単独実行に依存しない。利用者も依頼も試験ごとに作る）。
 * - 承認者（STEP 7）の選び方そのものは検証しない（別の試験で扱う）。
 */

type Role = 'requester' | 'desk' | 'approver';

type SFWindow = Window & {
  __SF: { S: { role: string; data: { items: { id: string; title: string; status: string }[] } } };
};

interface ApiError {
  error?: { code?: string; message?: string };
}
interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  actingRole: Role;
  isAdmin: boolean;
}
interface RequestDetail {
  id: string;
  title: string;
  status: string;
  version: number;
  orderVersion: number | null;
  signalDecided: string | null;
  criteria: string[];
  history: { action: string; note: string | null }[];
  comments: { text: string }[];
}
interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  roles: Role[];
}
interface Called<T> {
  status: number;
  body: T;
}

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';
const CRITERION = '登録した依頼が一覧とサーバの両方に残る';
const STATUS_DIALOG = '[data-a="status"][title="状態を変更"]';

const stamp = (): string => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/* ───────── サーバ（API）を直接呼ぶ。画面の表示とは独立に、サーバの正本を確かめるために使う ───────── */

async function callWith<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Called<T>> {
  const headers: Record<string, string> = { ...extraHeaders };
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
function call<T>(
  page: Page,
  method: string,
  path: string,
  data?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Called<T>> {
  return callWith<T>(page.request, method, path, data, extraHeaders);
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

/** サーバの「操作する人」（セッションの役割）を切り替える。画面は開き直すまで変わらない。 */
async function switchServerRole(page: Page, role: Role): Promise<void> {
  const res = await call<{ user: SessionUser }>(page, 'POST', '/api/auth/role', { role });
  expect(res.status).toBe(200);
  expect(res.body.user.actingRole).toBe(role);
}

/**
 * 準備用: API で依頼を 1 件登録する（画面の登録そのものは「登録した依頼は…」の試験で確かめる）。
 * 起票者と部署は見本名簿から、承認者はログイン中の利用者（承認者の役割を持つ管理者）にする。
 */
async function createViaApi(page: Page, title: string): Promise<{ id: string; deptCode: string; applicant: string }> {
  const user = await me(page);
  const roster = await call<{ items: { name: string; divisionCode: string }[] }>(page, 'GET', '/api/mirai/employees');
  const person = roster.body.items.find((p) => p.divisionCode);
  if (!person) throw new Error('見本名簿に部署つきの社員がいません');
  const res = await call<{ request: RequestDetail }>(page, 'POST', '/api/requests', {
    title,
    kind: 'new_tool',
    deptCode: person.divisionCode,
    applicant: person.name,
    problem: '回帰 E2E のための架空の困りごとです',
    purpose: '回帰 E2E で画面とサーバの挙動を確かめる',
    users: ['現場の担当者'],
    scope: ['依頼の登録', '状態の変更'],
    outOfScope: ['写真の加工'],
    criteria: [CRITERION],
    decides: 'g',
    approver: user.displayName,
    approverUserId: user.id,
  });
  expect(res.status, messageOf(res)).toBe(201);
  expect(res.body.request.status).toBe('received');
  return { id: res.body.request.id, deptCode: person.divisionCode, applicant: person.name };
}

/** API で状態の変更を送る（役割はサーバのセッションの役割。CSRF と最新の版を付ける）。 */
async function transitionApi(
  page: Page,
  id: string,
  to: string,
  extra: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<Called<unknown>> {
  const current = await detail(page, id);
  return call(
    page,
    'POST',
    `/api/requests/${encodeURIComponent(id)}/transitions`,
    { to, version: current.version, ...extra },
    extraHeaders,
  );
}

/**
 * サーバの規則を画面を通さずに確かめる: 理由なし（未指定・空白だけ）の遷移は 400 ERR-102 で拒否され、
 * 状態・版・履歴が変わらない。画面が送る前に止める作りでも、サーバの規則が緩んだら落ちるようにする。
 */
async function expectReasonRequiredByServer(page: Page, id: string, to: 'back' | 'cancel'): Promise<void> {
  for (const extra of [{}, { reason: '   ' }]) {
    const before = await detail(page, id);
    const denied = await transitionApi(page, id, to, extra);
    expect(denied.status).toBe(400);
    expect(codeOf(denied)).toBe('ERR-102');
    expect(messageOf(denied)).toContain('理由');
    const after = await detail(page, id);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.comments).toHaveLength(before.comments.length);
  }
}

/** 準備用: API で架空の利用者（依頼者の役割だけ）を 1 人作る。試験ごとに別の利用者を使う。 */
async function createRequesterViaApi(page: Page): Promise<{ id: string; email: string; password: string }> {
  const mark = stamp();
  const email = `e2e-regression-${mark}@example.com`;
  const password = `E2e-${mark}-${Math.random().toString(36).slice(2, 12)}`;
  const depts = await call<{ items: { code: string }[] }>(page, 'GET', '/api/catalog/departments');
  const deptCode = depts.body.items[0]?.code ?? '';
  const res = await call<{ user: ManagedUser }>(page, 'POST', '/api/admin/users', {
    email,
    displayName: `E2E 回帰 利用者 ${mark}`,
    deptCode,
    password,
    roles: ['requester'],
    isAdmin: false,
  });
  expect(res.status, messageOf(res)).toBe(201);
  expect(res.body.user.roles).toEqual(['requester']);
  expect(res.body.user.isActive).toBe(true);
  return { id: res.body.user.id, email, password };
}

/** 準備用: 受付 → 内容確認中 →（承認待ち →（承認済み））まで進める。終わったら受付担当に戻す。 */
async function advance(page: Page, id: string, upTo: 'review' | 'wait' | 'approved'): Promise<void> {
  await switchServerRole(page, 'desk');
  expect((await transitionApi(page, id, 'review')).status).toBe(200);
  if (upTo === 'review') return;
  expect((await transitionApi(page, id, 'wait')).status).toBe(200);
  if (upTo === 'wait') return;
  await switchServerRole(page, 'approver');
  const approved = await transitionApi(page, id, 'approved', { signal: 'g', checklistAcknowledged: true });
  expect(approved.status, messageOf(approved)).toBe(200);
  await switchServerRole(page, 'desk');
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

/** 確認・承認の画面で依頼を選び、右端パネルに出るまで待つ。 */
async function selectInReview(page: Page, id: string): Promise<void> {
  await gotoTab(page, 'review');
  await page.click(`#work .li[data-id="${id}"]`);
  await expect(page.locator('#rin .dp-h')).toContainText(id);
}

async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal.open')).toHaveCount(0);
}

/** 一覧をキーワードで絞り込む。 */
async function searchList(page: Page, keyword: string): Promise<void> {
  await gotoTab(page, 'list');
  await page.fill('#main [data-flt="fq"]', keyword);
}

/** 画面の登録（7 ステップ）。station.spec.ts と同じ手順で、サーバに現れるまで待って受付番号を返す。 */
async function createByScreen(page: Page, title: string): Promise<string> {
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');
  const next = () => page.click('#pane [data-a="next"]');
  await next();
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next();
  await page.fill('#stepBody [data-bind="title"]', title);
  await page.fill('#stepBody [data-bind="problem"]', '回帰 E2E のための架空の困りごとです');
  await page.fill('#stepBody [data-bind="purpose"]', '回帰 E2E で画面の登録がサーバに残ることを確かめる');
  await next();
  await page.fill('#stepBody [data-bind="scope"]', '依頼の登録\n状態の変更');
  await next();
  await page.fill('#stepBody [data-crit="0"]', CRITERION);
  await next();
  await page.click('#stepBody [data-a="one"][data-f="decides"][data-v="g"]');
  await next();
  await chooseApproverIfAsked(page);
  await page.click('#pane [data-a="submit"]');
  await expect
    .poll(
      async () => {
        const res = await call<{ items: { id: string; title: string }[] }>(
          page,
          'GET',
          `/api/requests?q=${encodeURIComponent(title)}`,
        );
        return res.body.items.filter((x) => x.title === title).length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  const list = await call<{ items: { id: string; title: string }[] }>(
    page,
    'GET',
    `/api/requests?q=${encodeURIComponent(title)}`,
  );
  const id = list.body.items.find((x) => x.title === title)?.id ?? '';
  expect(id).toMatch(/^REQ-\d{4}-\d{4}$/);
  return id;
}

/**
 * STEP 7 の承認者が利用者 ID で選ぶ欄（空選択で始まる）になっても、この試験を変えずに通すための分岐。
 * 欄があるときだけ、ログイン中の利用者を選ぶ。欄が無い画面では何もしない（承認者の選び方は検証しない）。
 */
async function chooseApproverIfAsked(page: Page): Promise<void> {
  const byId = page.locator('#stepBody select[data-bind="approverUserId"]');
  if ((await byId.count()) === 0) return;
  await byId.selectOption((await me(page)).id);
}

/** ダウンロードされたファイルの中身を読む。 */
async function textOf(download: Download): Promise<string> {
  const path = await download.path();
  return readFile(path, 'utf8');
}

/** 別の利用者としてログインした、独立したブラウザ（共有のセッションには触れない）。 */
async function loginInNewContext(
  page: Page,
  baseURL: string | undefined,
  email: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const browser = page.context().browser();
  if (!browser) throw new Error('ブラウザを取得できません');
  // 設定の storageState（共有のセッション）を引き継がないよう、空の状態を明示する
  const context = await browser.newContext({ baseURL, locale: 'ja-JP', storageState: { cookies: [], origins: [] } });
  const fresh = await context.newPage();
  await fresh.goto('/login');
  await fresh.getByLabel('メールアドレス').fill(email);
  await fresh.getByLabel('パスワード').fill(password);
  await fresh.getByRole('button', { name: 'ログイン' }).click();
  await fresh.waitForSelector('#nav');
  return { context, page: fresh };
}

test.beforeEach(async ({ page }) => {
  // どの試験も受付担当から始める（役割はサーバのセッションに残るため、前の試験の続きにしない）
  await switchServerRole(page, 'desk');
  await open(page);
});

test.afterEach(async ({ page }) => {
  // 後続の station.spec.ts が、このファイルの前と同じ役割で始まるように戻す
  await switchServerRole(page, 'desk');
});

test.describe('回帰: 永続化', () => {
  test('画面で登録した依頼は、再読み込み後も一覧・詳細・サーバに残る', async ({ page }) => {
    await actAs(page, 'requester');
    const title = `E2E 回帰 登録 ${stamp()}`;
    const id = await createByScreen(page, title);

    await open(page);
    await searchList(page, title);
    await expect(page.locator('#ltb tr')).toHaveCount(1);
    await expect(page.locator('#ltb tr').first()).toContainText(id);
    await expect(page.locator('#ltb tr').first()).toContainText('受付');
    await page.click(`#ltb tr[data-id="${id}"]`);
    await expect(page.locator('#drawer.open')).toContainText(title);
    await expect(page.locator('#drawer.open')).toContainText(CRITERION);

    const saved = await detail(page, id);
    expect(saved.title).toBe(title);
    expect(saved.status).toBe('received');
    expect(saved.criteria).toEqual([CRITERION]);
    expect(saved.history.map((h) => h.action)).toEqual(['受付']);
  });

  test('状態変更とコメントは、再読み込み後も残る', async ({ page }) => {
    const { id } = await createViaApi(page, `E2E 回帰 状態 ${stamp()}`);
    const comment = `E2E 回帰のコメント ${stamp()}`;
    await open(page);

    await selectInReview(page, id);
    await page.click(`#rin [data-a="status"][data-id="${id}"][data-v="review"]`);
    await expect(page.locator('#modal.open input[name="ns"][value="review"]')).toBeChecked();
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('review');

    await page.click('#rin [data-a="dtab"][data-v="log"]');
    await page.fill('#rin #ctx', comment);
    await page.click(`#rin [data-a="comment"][data-id="${id}"]`);
    await expect.poll(async () => (await detail(page, id)).comments.map((c) => c.text), { timeout: 30_000 }).toContain(comment);

    await open(page);
    await selectInReview(page, id);
    await expect(page.locator('#rin .dp-h')).toContainText('内容確認中');
    await page.click('#rin [data-a="dtab"][data-v="log"]');
    await expect(page.locator('#rin')).toContainText(comment);
    await expect(page.locator('#rin')).toContainText('状態を「内容確認中」に変更');
  });

  test('受付の依頼を編集すると、件名の変更が再読み込み後も残る', async ({ page }) => {
    const mark = stamp();
    const before = `E2E 回帰 編集前 ${mark}`;
    const after = `E2E 回帰 編集後 ${mark}`;
    const { id } = await createViaApi(page, before);
    await open(page);

    await selectInReview(page, id);
    await page.click(`#rin [data-a="edit"][data-id="${id}"]`);
    await page.waitForSelector('#stepBody');
    await page.click('#main [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', after);
    await page.click('#main [data-a="step"][data-v="6"]');
    await expect(page.locator('#pane [data-a="submit"]')).toContainText('この内容で更新する');
    await chooseApproverIfAsked(page);
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => (await detail(page, id)).title, { timeout: 30_000 }).toBe(after);
    expect((await detail(page, id)).version).toBeGreaterThan(1);

    await open(page);
    await searchList(page, after);
    await expect(page.locator('#ltb tr')).toHaveCount(1);
    await expect(page.locator('#ltb tr').first()).toContainText(id);
    await page.fill('#main [data-flt="fq"]', before);
    await expect(page.locator('#ltb')).toContainText('条件に合う依頼がありません');
  });

  test('操作する人の切り替えはサーバのセッションに反映され、再読み込み後も残る', async ({ page }) => {
    expect((await me(page)).actingRole).toBe('desk');
    await page.selectOption('#role', 'approver');
    await expect.poll(async () => (await me(page)).actingRole).toBe('approver');

    await open(page);
    await expect(page.locator('#role')).toHaveValue('approver');
    await expect.poll(async () => page.evaluate(() => (window as unknown as SFWindow).__SF.S.role)).toBe('approver');
  });
});

test.describe('回帰: 権限', () => {
  test('依頼者の役割では、承認と状態変更の操作が画面で無効になる', async ({ page }) => {
    const { id } = await createViaApi(page, `E2E 回帰 依頼者の画面 ${stamp()}`);
    await advance(page, id, 'wait');
    await actAs(page, 'requester');

    await selectInReview(page, id);
    await expect(page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="approved"]`)).toBeDisabled();
    await expect(page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="back"]`)).toBeDisabled();
    await expect(page.locator(`#rin [data-a="del"][data-id="${id}"]`)).toBeDisabled();
    await expect(page.locator('#rin .gatel')).toContainText('いまの役割（依頼者）では進められません');

    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal.open')).toContainText('いまの役割では変更できる状態がありません');
    await expect(page.locator('#modal input[name="ns"][value="approved"]')).toBeDisabled();
    await expect(page.locator('#modal input[name="ns"][value="done"]')).toBeDisabled();
    await expect(page.locator('#modal [data-a="sok"]')).toBeDisabled();
    await closeModal(page);
    expect(await serverStatus(page, id)).toBe('wait');
  });

  test('依頼者の役割で承認を送っても、サーバが拒否して状態は変わらず、拒否が監査に残る', async ({ page }) => {
    const { id } = await createViaApi(page, `E2E 回帰 依頼者の拒否 ${stamp()}`);
    await advance(page, id, 'wait');
    await switchServerRole(page, 'requester');

    // 監査の API は拒否の中身（どの状態へ送ったか）を返さないので、要求ごとの相関 ID で突き合わせる
    const mark = stamp();
    const approveCid = `e2e-deny-approved-${mark}`;
    const backCid = `e2e-deny-back-${mark}`;
    const approve = await transitionApi(
      page,
      id,
      'approved',
      { signal: 'g', checklistAcknowledged: true },
      { 'x-correlation-id': approveCid },
    );
    expect(approve.status).toBe(409);
    expect(codeOf(approve)).toBe('ERR-201');
    expect(messageOf(approve)).toContain('承認者だけ');
    const back = await transitionApi(
      page,
      id,
      'back',
      { reason: 'E2E 回帰: 依頼者は差し戻せない' },
      { 'x-correlation-id': backCid },
    );
    expect(back.status).toBe(409);
    expect(codeOf(back)).toBe('ERR-201');

    const after = await detail(page, id);
    expect(after.status).toBe('wait');
    expect(after.signalDecided).toBeNull();

    const audit = await call<{
      items: { action: string; targetId: string | null; result: string; role: string; correlationId: string | null }[];
    }>(page, 'GET', '/api/audit-logs?limit=500');
    expect(audit.status).toBe(200);
    // この依頼はこの試験だけが使う。拒否の記録は、送った 2 つの要求（承認・差戻し）に 1 件ずつ
    const denied = audit.body.items.filter((a) => a.targetId === id && a.action === 'request.transition_denied');
    expect(denied).toHaveLength(2);
    expect(denied.every((a) => a.result === 'denied' && a.role === 'requester')).toBe(true);
    expect(denied.filter((a) => a.correlationId === approveCid)).toHaveLength(1);
    expect(denied.filter((a) => a.correlationId === backCid)).toHaveLength(1);
  });

  test('受付担当は承認済みへ進められない（画面は無効、サーバは拒否）', async ({ page }) => {
    const { id } = await createViaApi(page, `E2E 回帰 受付担当 ${stamp()}`);
    await advance(page, id, 'wait');
    await open(page);

    await selectInReview(page, id);
    await expect(page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="approved"]`)).toBeDisabled();
    await expect(page.locator('#rin .gatel')).toContainText('いまの役割（受付担当）では進められません');
    await page.click(`#rin ${STATUS_DIALOG}`);
    await expect(page.locator('#modal input[name="ns"][value="approved"]')).toBeDisabled();
    await expect(page.locator('#modal input[name="ns"][value="back"]')).toBeEnabled();
    await closeModal(page);

    const approve = await transitionApi(page, id, 'approved', { signal: 'g', checklistAcknowledged: true });
    expect(approve.status).toBe(409);
    expect(codeOf(approve)).toBe('ERR-201');
    expect(messageOf(approve)).toContain('承認者だけ');
    const after = await detail(page, id);
    expect(after.status).toBe('wait');
    expect(after.signalDecided).toBeNull();
  });
});

test.describe('回帰: 理由が必要な遷移', () => {
  test('差戻しは理由が必須。理由つきで差し戻すと理由が残り、依頼者が再提出できる', async ({ page }) => {
    const { id } = await createViaApi(page, `E2E 回帰 差戻し ${stamp()}`);
    const reason = `E2E 回帰: 合格の条件を数字で書き直してください ${stamp()}`;

    // サーバ: 理由なしの差戻しを拒否する（画面は送る前に止めるので、API で直接確かめる）
    await expectReasonRequiredByServer(page, id, 'back');

    // 画面: 理由なしでは送らず、理由を求めてダイアログを開いたままにする
    await open(page);
    await selectInReview(page, id);
    await page.click(`#rin [data-a="status"][data-id="${id}"][data-v="back"]`);
    await expect(page.locator('#modal.open input[name="ns"][value="back"]')).toBeChecked();
    await page.click('#modal [data-a="sok"]');
    await expect(page.locator('#toast')).toContainText('理由をメモに書いてください');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    expect(await serverStatus(page, id)).toBe('received');

    await page.fill('#modal #nnote', reason);
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('back');
    const returned = await detail(page, id);
    expect(returned.comments.map((c) => c.text)).toContain(reason);
    expect(returned.history.at(-1)?.action).toBe('状態を「差戻し」に変更');

    await actAs(page, 'requester');
    await selectInReview(page, id);
    await expect(page.locator('#rin .note.n-bad')).toContainText('差戻し理由');
    await expect(page.locator('#rin .note.n-bad')).toContainText(reason);
    const resubmit = page.locator(`#rin [data-a="status"][data-id="${id}"][data-v="received"]`);
    await expect(resubmit).toBeEnabled();
    await expect(resubmit).toContainText('再提出する');
    await resubmit.click();
    await expect(page.locator('#modal.open input[name="ns"][value="received"]')).toBeChecked();
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('received');
  });

  test('取消は理由なしではサーバが拒否し、理由つきなら取消になって一覧から消える', async ({ page }) => {
    const title = `E2E 回帰 取消 ${stamp()}`;
    const { id } = await createViaApi(page, title);
    const reason = `E2E 回帰: 重複のため取り消します ${stamp()}`;

    // サーバ: 理由なしの取消を拒否する（画面の作りに関係なく、API で直接確かめる）
    await expectReasonRequiredByServer(page, id, 'cancel');

    // 画面: 理由なしで「取消」を確定しても取消にならない。落ち着いた後の表示は「受付」のままで、サーバの状態も変わらない
    // （途中のトーストの出方には依存しない。送る前に止める作りでも、送ってから拒否されて戻す作りでも成り立つ）
    await open(page);
    await selectInReview(page, id);
    await page.click(`#rin ${STATUS_DIALOG}`);
    await page.check('#modal input[name="ns"][value="cancel"]');
    await page.click('#modal [data-a="sok"]');
    await expect
      .poll(async () =>
        page.evaluate((rid) => (window as unknown as SFWindow).__SF.S.data.items.find((r) => r.id === rid)?.status ?? '', id),
      )
      .toBe('received');
    await expect(page.locator(`#work .li[data-id="${id}"] .badge`)).toHaveText('受付');
    expect(await serverStatus(page, id)).toBe('received');

    // ダイアログが閉じていれば開き直す（画面が送る前に理由を求めて開いたままにする作りでも、同じ手順で続けられる）
    if ((await page.locator('#modal.open').count()) === 0) {
      await selectInReview(page, id);
      await page.click(`#rin ${STATUS_DIALOG}`);
      await page.check('#modal input[name="ns"][value="cancel"]');
    }
    await page.fill('#modal #nnote', reason);
    await page.click('#modal [data-a="sok"]');
    await expect.poll(async () => serverStatus(page, id), { timeout: 30_000 }).toBe('cancel');
    expect((await detail(page, id)).comments.map((c) => c.text)).toContain(reason);

    await open(page);
    await searchList(page, title);
    await expect(page.locator('#ltb')).toContainText('条件に合う依頼がありません');
    const visible = await call<{ total: number }>(page, 'GET', `/api/requests?q=${encodeURIComponent(title)}`);
    expect(visible.body.total).toBe(0);
    // 取消はデータを消さない（表示から外すだけ）
    const kept = await call<{ total: number }>(page, 'GET', `/api/requests?includeDeleted=1&q=${encodeURIComponent(title)}`);
    expect(kept.body.total).toBe(1);
  });
});

test.describe('回帰: 一覧', () => {
  test('キーワードで絞り込め、0 件の表示になり、絞り込んだ内容を CSV に書き出せる', async ({ page }) => {
    const title = `E2E 回帰 検索 ${stamp()}`;
    const { id, applicant } = await createViaApi(page, title);
    await open(page);

    await searchList(page, title);
    await expect(page.locator('#ltb tr')).toHaveCount(1);
    await expect(page.locator('#ltb tr').first()).toContainText(id);
    await expect(page.locator('#lcnt')).toHaveText(/^1 件 ／ 全 \d+ 件$/);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#main [data-a="csv"]')]);
    expect(download.suggestedFilename()).toMatch(/^受付一覧_\d{8}\.csv$/);
    const lines = (await textOf(download)).split('\r\n');
    expect(lines[0]).toBe(
      '\ufeff"受付番号","件名","部署","依頼区分","起票者","信号（候補）","信号（決定）","状態","月あたり削減見込み(h)","受付日時","更新日時"',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"${id}","${title}"`);
    expect(lines[1]).toContain(`"${applicant}"`);
    expect(lines[1]).toContain('"受付"');

    // 受付番号でも探せる
    await page.fill('#main [data-flt="fq"]', id);
    await expect(page.locator('#ltb tr')).toHaveCount(1);
    await expect(page.locator('#ltb tr').first()).toContainText(title);

    await page.fill('#main [data-flt="fq"]', `該当なし ${stamp()}`);
    await expect(page.locator('#ltb')).toContainText('条件に合う依頼がありません');
    await expect(page.locator('#lcnt')).toHaveText(/^0 件 ／ 全 \d+ 件$/);
  });

  test('部署・状態・信号の絞り込みが重なって効き、解除で全件に戻る', async ({ page }) => {
    const { id, deptCode } = await createViaApi(page, `E2E 回帰 絞り込み ${stamp()}`);
    await open(page);
    await gotoTab(page, 'list');

    await page.selectOption('#main [data-flt="fd"]', deptCode);
    await page.selectOption('#main [data-flt="fs"]', 'received');
    await page.selectOption('#main [data-flt="fc"]', 'g');
    await expect(page.locator(`#ltb tr[data-id="${id}"]`)).toHaveCount(1);
    const deptLabel = await page.locator(`#ltb tr[data-id="${id}"] td`).nth(2).innerText();
    const rows = await page
      .locator('#ltb tr[data-id]')
      .evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').trim())));
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      expect(cells[2]).toBe(deptLabel.trim());
      expect(cells[4]).toContain('青');
      expect(cells[5]).toContain('受付');
    }

    // 信号だけ赤に変えると、青の依頼は出ない
    await page.selectOption('#main [data-flt="fc"]', 'r');
    await expect(page.locator(`#ltb tr[data-id="${id}"]`)).toHaveCount(0);

    await page.click('#main [data-a="clearFlt"]');
    await expect(page.locator('#main [data-flt="fd"]')).toHaveValue('');
    await expect(page.locator('#main [data-flt="fs"]')).toHaveValue('');
    await expect(page.locator('#main [data-flt="fc"]')).toHaveValue('');
    await expect(page.locator('#main [data-flt="fq"]')).toHaveValue('');
    await expect(page.locator(`#ltb tr[data-id="${id}"]`)).toHaveCount(1);
    const all = await call<{ total: number }>(page, 'GET', '/api/requests?pageSize=1');
    await expect(page.locator('#lcnt')).toHaveText(`${all.body.total} 件 ／ 全 ${all.body.total} 件`);
  });
});

test.describe('回帰: 利用者管理', () => {
  // 2 件はそれぞれ別の架空の利用者を作る（順序や再実行に依存しない。片方だけ実行しても通る）
  test('利用者を追加すると一覧に現れ、無効化と有効化を切り替えられる', async ({ page }) => {
    const mark = stamp();
    const account = {
      email: `e2e-regression-${mark}@example.com`,
      name: `E2E 回帰 利用者 ${mark}`,
      password: `E2e-${mark}-${Math.random().toString(36).slice(2, 12)}`,
    };
    const find = async (): Promise<ManagedUser | undefined> =>
      (await call<{ items: ManagedUser[] }>(page, 'GET', '/api/admin/users')).body.items.find((u) => u.email === account.email);

    try {
      await gotoTab(page, 'settings');
      await page.click('#setleft .li[data-v="users"]');
      await expect(page.locator('#rin [data-a="uAdd"]')).toBeVisible();
      const adminRow = page.locator('#rin .dlist .li').filter({ hasText: ADMIN_EMAIL });
      await expect(adminRow).toHaveCount(1);
      await expect(adminRow).toContainText('管理者');

      await page.click('#rin [data-a="uAdd"]');
      await page.fill('#modal #uName', account.name);
      await page.fill('#modal #uEmail', account.email);
      await page.fill('#modal #uPass', account.password);
      await expect(page.locator('#modal input[name="urole"][value="requester"]')).toBeChecked();
      await page.click('#modal [data-a="uAddOk"]');
      await expect(page.locator('#toast')).toContainText('利用者を追加しました');
      await expect(page.locator('#modal.open')).toHaveCount(0);

      const row = page.locator('#rin .dlist .li').filter({ hasText: account.email });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(account.name);
      await expect(row).toContainText('依頼者');
      // パスワードは一覧・トースト・端末の保存領域に出ない（入力欄そのものの扱いは 36 の「見つけた不具合」を参照）
      expect(await page.locator('#rin').innerText()).not.toContain(account.password);
      expect(await page.locator('#toast').innerText()).not.toContain(account.password);
      expect(await page.evaluate((pw) => JSON.stringify(Object.entries(localStorage)).includes(pw), account.password)).toBe(
        false,
      );

      const created = await find();
      expect(created).toBeDefined();
      expect(created?.roles).toEqual(['requester']);
      expect(created?.isAdmin).toBe(false);
      expect(created?.isActive).toBe(true);
      const userId = created?.id ?? '';
      // 自分自身（管理者）の行は操作しない
      expect(userId).not.toBe((await me(page)).id);

      const toggle = page.locator(`#rin [data-a="uToggle"][data-id="${userId}"]`);
      await expect(toggle).toHaveText('無効にする');
      await toggle.click();
      await expect.poll(async () => (await find())?.isActive).toBe(false);
      await expect(toggle).toHaveText('有効に戻す');
      await expect(row).toContainText('無効');

      await toggle.click();
      await expect.poll(async () => (await find())?.isActive).toBe(true);
      await expect(toggle).toHaveText('無効にする');
    } finally {
      // 後片付け: この試験が作った利用者は、成否にかかわらず無効にしておく（有効な試験用の利用者を残さない）
      const left = await find();
      if (left?.isActive) await call(page, 'PATCH', `/api/admin/users/${left.id}`, { isActive: false });
    }
  });

  test('管理者でない利用者には利用者管理を出さずサーバも拒否する。無効化するとセッションが使えなくなる', async ({
    page,
    baseURL,
  }) => {
    const account = await createRequesterViaApi(page);
    // 管理者が作った依頼を差戻しにしておく。依頼者が動かせるのは「本人の依頼」の差戻し → 再提出だけ
    const { id: requestId } = await createViaApi(page, `E2E 回帰 他人の依頼 ${stamp()}`);
    const returned = await transitionApi(page, requestId, 'back', { reason: 'E2E 回帰: 所有者の境界を確かめるために差し戻す' });
    expect(returned.status, messageOf(returned)).toBe(200);

    const other = await loginInNewContext(page, baseURL, account.email, account.password);
    try {
      const who = await callWith<{ user: SessionUser }>(other.context.request, 'GET', '/api/auth/me');
      expect(who.body.user.email).toBe(account.email);
      expect(who.body.user.isAdmin).toBe(false);
      expect(who.body.user.roles).toEqual(['requester']);

      await other.page.click('#nav a[data-v="settings"]');
      await other.page.click('#setleft .li[data-v="users"]');
      await expect(other.page.locator('#rin')).toContainText('利用者の管理は管理者だけができます');
      await expect(other.page.locator('#rin [data-a="uAdd"]')).toHaveCount(0);

      const users = await callWith(other.context.request, 'GET', '/api/admin/users');
      expect(users.status).toBe(403);
      expect(codeOf(users)).toBe('ERR-101');
      const audit = await callWith(other.context.request, 'GET', '/api/audit-logs');
      expect(audit.status).toBe(403);
      const role = await callWith(other.context.request, 'POST', '/api/auth/role', { role: 'approver' });
      expect(role.status).toBe(403);
      expect(codeOf(role)).toBe('ERR-101');

      // 所有者の境界: 依頼者に許される再提出（差戻し → 受付）でも、ほかの人の依頼は動かせない
      const before = await detail(page, requestId);
      expect(before.status).toBe('back');
      const move = await callWith(other.context.request, 'POST', `/api/requests/${requestId}/transitions`, {
        to: 'received',
        version: before.version,
      });
      expect(move.status).toBe(409);
      expect(codeOf(move)).toBe('ERR-201');
      expect(messageOf(move)).toContain('ほかの人の依頼は動かせません');
      const unchanged = await detail(page, requestId);
      expect(unchanged.status).toBe('back');
      expect(unchanged.version).toBe(before.version);

      // 同じ再提出を、依頼を作った本人が依頼者の役割で送ると通る（拒否の理由は所有者の違いだけ）
      await switchServerRole(page, 'requester');
      const own = await transitionApi(page, requestId, 'received');
      expect(own.status, messageOf(own)).toBe(200);
      expect(await serverStatus(page, requestId)).toBe('received');
      await switchServerRole(page, 'desk');

      // 管理者が無効化すると、その利用者のセッションは使えなくなる
      const off = await call<{ user: ManagedUser }>(page, 'PATCH', `/api/admin/users/${account.id}`, { isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.user.isActive).toBe(false);
      const expired = await callWith(other.context.request, 'GET', '/api/auth/me');
      expect(expired.status).toBe(401);
      await other.page.goto('/');
      await expect(other.page).toHaveURL(/\/login$/);
    } finally {
      await other.context.close();
      // 後片付け: 途中で失敗しても、この試験が作った利用者は無効にしておく
      await call(page, 'PATCH', `/api/admin/users/${account.id}`, { isActive: false });
    }
    // 共有のセッション（管理者）は影響を受けない
    expect((await me(page)).email).toBe(ADMIN_EMAIL);
  });
});

test.describe('回帰: 監査ログ・メール・注文書', () => {
  test('依頼の登録と状態変更が監査ログに出て、CSV とサーバの監査にも残る', async ({ page }) => {
    const title = `E2E 回帰 監査 ${stamp()}`;
    const { id } = await createViaApi(page, title);
    await advance(page, id, 'review');
    await open(page);

    await gotoTab(page, 'log');
    await page.fill('#main [data-flt="logq"]', id);
    await expect(page.locator('#logtb tr')).toHaveCount(2);
    await expect(page.locator('#logtb')).toContainText('受付');
    await expect(page.locator('#logtb')).toContainText('状態を「内容確認中」に変更');
    await expect(page.locator('#logtb')).toContainText(title);
    await expect(page.locator('#logcnt')).toHaveText('2件');

    const [filtered] = await Promise.all([page.waitForEvent('download'), page.click('#main [data-a="logcsv"]')]);
    expect(filtered.suggestedFilename()).toMatch(/^監査ログ_\d{8}\.csv$/);
    const lines = (await textOf(filtered)).split('\r\n');
    expect(lines[0]).toBe('\ufeff"日時","区分","操作者","役割","操作","対象","件名","メモ"');
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((line) => line.includes(`"${id}","${title}"`))).toBe(true);
    expect(lines.slice(1).join('\n')).toContain('"状態を「内容確認中」に変更"');

    // システム設定 → データ の「監査ログをCSVで」は、絞り込みに関係なく全件を書き出す
    await gotoTab(page, 'settings');
    await page.click('#setleft .li[data-v="data"]');
    const [whole] = await Promise.all([page.waitForEvent('download'), page.click('#rin [data-a="auditCsv"]')]);
    expect(whole.suggestedFilename()).toMatch(/^監査ログ_\d{8}\.csv$/);
    const wholeLines = (await textOf(whole)).split('\r\n');
    expect(wholeLines.length).toBeGreaterThan(3);
    expect(wholeLines.filter((line) => line.includes(`"${id}"`))).toHaveLength(2);

    const audit = await call<{
      items: { action: string; targetId: string | null; result: string }[];
      chain: { ok: boolean };
    }>(page, 'GET', '/api/audit-logs?limit=500');
    expect(audit.status).toBe(200);
    expect(audit.body.chain.ok).toBe(true);
    const actions = audit.body.items.filter((a) => a.targetId === id && a.result === 'success').map((a) => a.action);
    expect(actions).toContain('request.create');
    expect(actions).toContain('request.transition');
  });

  test('承認待ちにすると、承認依頼メールがシステム設定の送信簿に出る', async ({ page }) => {
    const title = `E2E 回帰 メール ${stamp()}`;
    const { id } = await createViaApi(page, title);
    await advance(page, id, 'wait');
    await open(page);

    await gotoTab(page, 'settings');
    await page.click('#setleft .li[data-v="mail"]');
    const row = page.locator('#rin .dlist .li').filter({ hasText: id });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`承認依頼 ${id} ${title}`);

    const outbox = await call<{ items: { subject: string; status: string }[] }>(page, 'GET', '/api/mail/outbox?limit=20');
    expect(outbox.status).toBe(200);
    const mail = outbox.body.items.filter((m) => m.subject.includes(id));
    expect(mail).toHaveLength(1);
    expect(mail[0]?.status).toBe('sent');
  });

  test('承認済みの依頼の注文書（YAML）を表示・コピー・ダウンロードでき、サーバの正本と対象と合格条件が合う', async ({ page }) => {
    const title = `E2E 回帰 注文書 ${stamp()}`;
    const { id } = await createViaApi(page, title);
    const idLine = `id: "${id}"`;
    const criterionLine = `- "${CRITERION}"`;

    // 承認前はサーバが注文書を出さない
    const early = await call(page, 'GET', `/api/requests/${id}/order`);
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('ERR-205');

    await advance(page, id, 'approved');
    const order = await call<{ yaml: string; version: number }>(page, 'GET', `/api/requests/${id}/order`);
    expect(order.status).toBe(200);
    expect(order.body.version).toBe(1);
    expect(order.body.yaml).toContain(idLine);
    expect(order.body.yaml).toContain(criterionLine);
    expect(order.body.yaml).toContain('order_version: 1');
    expect(order.body.yaml).toContain('decided: "青"');

    await open(page);
    await searchList(page, title);
    await page.click(`#ltb tr[data-id="${id}"]`);
    await page.click('#drawer.open [data-a="dtab"][data-v="yaml"]');
    const shown = page.locator('#drawer.open pre.yaml');
    await expect(shown).toContainText(idLine);
    await expect(shown).toContainText(criterionLine);
    await expect(shown).toContainText('status: "承認済み"');
    await expect(shown).toContainText('decided: "青"');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(`#drawer.open [data-a="ydl"][data-id="${id}"]`),
    ]);
    expect(download.suggestedFilename()).toBe(`${id}_注文書.yaml`);
    const file = await textOf(download);
    expect(file).toContain(idLine);
    expect(file).toContain(`title: "${title}"`);
    expect(file).toContain(criterionLine);

    // コピーは、画面がクリップボードへ渡す文字列を受け取って確かめる（実行環境のクリップボードの権限に左右されないため）
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
    expect(copied).toBe(file);
  });
});

test.describe('回帰: ログアウト', () => {
  test('ログアウトするとログイン画面へ戻り、そのセッションだけが失効する', async ({ page, baseURL, playwright }) => {
    // 共有のセッションを失効させないため、この試験だけ別のブラウザでログインする
    const own = await loginInNewContext(page, baseURL, ADMIN_EMAIL, ADMIN_PASSWORD);
    try {
      const cookies = await own.context.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      expect(cookies.length).toBeGreaterThan(0);
      expect((await callWith(own.context.request, 'GET', '/api/auth/me')).status).toBe(200);

      await own.page.click('#logoutbtn');
      await expect(own.page.locator('#modal.open')).toContainText('ログアウト');
      await own.page.click('#modal [data-a="cfok"]');
      await own.page.waitForURL(/\/login$/);
      await expect(own.page.getByLabel('メールアドレス')).toBeVisible();

      expect((await callWith(own.context.request, 'GET', '/api/auth/me')).status).toBe(401);
      await own.page.goto('/');
      await expect(own.page).toHaveURL(/\/login$/);

      // ブラウザの Cookie を消しただけではなく、サーバ側でセッションが失効している（控えた Cookie でも使えない）
      const replay = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: cookieHeader } });
      try {
        expect((await replay.get('/api/auth/me')).status()).toBe(401);
      } finally {
        await replay.dispose();
      }
    } finally {
      await own.context.close();
    }
    // 共有のセッションは生きている（後続の試験が使う）
    expect((await me(page)).email).toBe(ADMIN_EMAIL);
  });
});
