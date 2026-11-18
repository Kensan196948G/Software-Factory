import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * 表示名と「操作する人」の回帰 E2E（2026-11-18）。
 *
 * 所有者の指示: アカウントの表示名は DB の app_user.display_name を正とし、Mirai-Info 名簿
 * （window.__SF_ACTORS__）は画面の表示名に使わない。名簿は起票者・部署の選択などの既存用途だけに残す。
 * 「操作する人」の選択肢は、そのセッションの利用者が持つ役割（user_role）だけを出し、
 * ラベルは「表示名（役割名）」にする（不具合 F-6 / F-2 の解消）。
 *
 * ここでは実サーバ・実 DB に対して、役割を 1 つだけ持つ利用者と 3 つ持つ利用者で確かめる。
 * 画面の関数の決まりは tests/unit/station-display-name-wiring.test.ts が固定している。
 */

type Role = 'requester' | 'desk' | 'approver';

interface Called<T> {
  status: number;
  body: T;
}
interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  isActive: boolean;
}
interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  actingRole: Role;
}
interface Person {
  name: string;
}
interface Account {
  id: string;
  email: string;
  password: string;
  displayName: string;
}

/** 所有者の指示にある名簿の代表者名。表示名・「操作する人」に出てはいけない。 */
const ROSTER_REP_NAMES = ['山田 敏久', '鈴木 一郎', '石原 慎太郎', '佐藤 花子'];

const stamp = (): string => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/* ───────── サーバ（API）を直接呼ぶ。管理者の共有セッション（auth.setup.ts）を使う ───────── */

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

/** 準備用: 架空の利用者を 1 人作る（表示名と、持たせる役割を指定する）。 */
async function createUser(page: Page, displayName: string, roles: Role[]): Promise<Account> {
  const mark = stamp();
  const email = `e2e-display-${mark}@example.com`;
  // 検証用のパスワードは試験のたびに作る。ログに出さない（結果のメッセージにも入れない）。
  const password = `E2e-${mark}-${Math.random().toString(36).slice(2, 12)}`;
  const depts = await call<{ items: { code: string }[] }>(page, 'GET', '/api/catalog/departments');
  const deptCode = depts.body.items[0]?.code ?? '';
  const res = await call<{ user: ManagedUser }>(page, 'POST', '/api/admin/users', {
    email,
    displayName,
    deptCode,
    password,
    roles,
    isAdmin: false,
  });
  expect(res.status).toBe(201);
  expect(res.body.user.roles).toEqual(roles);
  return { id: res.body.user.id, email, password, displayName };
}

/** 後片付け: この試験が作った利用者を無効にする（有効な試験用の利用者を残さない）。 */
async function deactivate(page: Page, id: string): Promise<void> {
  const res = await call(page, 'PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { isActive: false });
  expect(res.status).toBe(200);
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
  const context = await browser.newContext({ baseURL, locale: 'ja-JP', storageState: { cookies: [], origins: [] } });
  const fresh = await context.newPage();
  await fresh.goto('/login');
  await fresh.getByLabel('メールアドレス').fill(email);
  await fresh.getByLabel('パスワード').fill(password);
  await fresh.getByRole('button', { name: 'ログイン' }).click();
  await fresh.waitForSelector('#nav');
  return { context, page: fresh };
}

/* ───────── 画面から読む ───────── */

async function sessionUser(page: Page): Promise<SessionUser> {
  const res = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me');
    return ((await response.json()) as { user: SessionUser }).user;
  });
  return res;
}

async function rosterNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/mirai/employees');
    const json = (await response.json()) as { items?: Person[] };
    return (json.items || []).map((p) => p.name);
  });
}

/** 名簿から、部署を持つ社員を 1 人選ぶ（起票者の名前と部署は名簿のまま使う）。 */
async function rosterPerson(page: Page): Promise<{ name: string; divisionCode: string }> {
  return page.evaluate(async () => {
    const response = await fetch('/api/mirai/employees');
    const json = (await response.json()) as { items?: { name: string; divisionCode: string }[] };
    const person = (json.items || []).find((p) => p && p.name && p.divisionCode);
    if (!person) throw new Error('見本名簿に部署つきの社員がいません');
    return person;
  });
}

const CRITERION = '送信ボタンを押すと、入力した内容が消えずに残る';

/** 準備用: その画面の利用者として依頼を 1 件登録する（起票者は名簿の社員名にする）。 */
async function createRequestAs(page: Page, title: string, approver: Account): Promise<string> {
  const person = await rosterPerson(page);
  const res = await call<{ request: { id: string } }>(page, 'POST', '/api/requests', {
    title,
    kind: 'new_tool',
    deptCode: person.divisionCode,
    applicant: person.name,
    problem: 'E2E のための架空の困りごとです',
    purpose: '自分の依頼が「あなたの依頼」に表示されることを確かめる',
    users: ['現場の担当者'],
    scope: ['依頼の表示'],
    outOfScope: ['写真の加工'],
    criteria: [CRITERION],
    decides: 'g',
    approver: approver.displayName,
    approverUserId: approver.id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.request.id;
}

const roleOptions = (page: Page): Promise<string[]> => page.locator('#role option').allInnerTexts();
const actorName = (page: Page): Promise<string | null> => page.locator('#actorav .av').getAttribute('title');
const greeting = (page: Page): Promise<string> => page.locator('#main .hero h2').innerText();

/** 名簿の代表者名（実データの代表者と、所有者の指示にある 4 名）が、どこにも出ていないこと。 */
async function expectNoRosterNames(page: Page, selectLabel: string): Promise<void> {
  const header = await page.locator('header.top').innerText();
  const people = await rosterNames(page);
  expect(people.length).toBeGreaterThan(0);
  for (const name of [...people, ...ROSTER_REP_NAMES]) {
    expect(selectLabel).not.toContain(name);
    expect(header).not.toContain(name);
  }
}

test.describe('表示名と「操作する人」（app_user.display_name と user_role）', () => {
  test('承認者の役割だけを持つ利用者: 「管理者（承認者…）」になり、依頼者・受付担当は出ない', async ({ page, baseURL }) => {
    const account = await createUser(page, '管理者', ['approver']);
    let other: { context: BrowserContext; page: Page } | undefined;
    try {
      other = await loginInNewContext(page, baseURL, account.email, account.password);
      const p = other.page;

      // サーバの正本: 表示名「管理者」・役割は承認者だけ・操作中の役割も承認者
      const user = await sessionUser(p);
      expect(user.displayName).toBe('管理者');
      expect(user.roles).toEqual(['approver']);
      expect(user.actingRole).toBe('approver');

      // ヘッダ（挨拶・アバター）は表示名。名簿の代表者名（鈴木 一郎 等）ではない
      expect(await greeting(p)).toContain('管理者さん');
      expect(await actorName(p)).toBe('管理者');
      await expect(p.locator('#actorav')).toContainText('管');

      // 「操作する人」は承認者だけ。ラベルは「表示名（役割名）」
      const options = await roleOptions(p);
      expect(options).toEqual(['管理者（承認者（業務責任者））']);
      expect(await p.locator('#role').inputValue()).toBe('approver');
      const selectLabel = await p.locator('#role').innerText();
      expect(selectLabel).not.toContain('依頼者');
      expect(selectLabel).not.toContain('受付担当');

      // 名簿の代表者名は、ヘッダにも選択肢にも出ない（修正前は名簿の代表者名が出ていた）
      await expectNoRosterNames(p, options.join('\n'));
    } finally {
      if (other) await other.context.close();
      await deactivate(page, account.id);
    }
  });

  test('依頼者の役割だけを持つ利用者: 「一般利用者（依頼者）」になり、受付担当・承認者は出ない', async ({ page, baseURL }) => {
    const account = await createUser(page, '一般利用者', ['requester']);
    let other: { context: BrowserContext; page: Page } | undefined;
    try {
      other = await loginInNewContext(page, baseURL, account.email, account.password);
      const p = other.page;

      const user = await sessionUser(p);
      expect(user.displayName).toBe('一般利用者');
      expect(user.roles).toEqual(['requester']);
      expect(user.actingRole).toBe('requester');

      expect(await greeting(p)).toContain('一般利用者さん');
      expect(await actorName(p)).toBe('一般利用者');

      const options = await roleOptions(p);
      expect(options).toEqual(['一般利用者（依頼者）']);
      expect(await p.locator('#role').inputValue()).toBe('requester');
      const selectLabel = await p.locator('#role').innerText();
      expect(selectLabel).not.toContain('受付担当');
      expect(selectLabel).not.toContain('承認者');

      await expectNoRosterNames(p, options.join('\n'));

      // 「あなたの依頼」は、表示名と名簿名が違っても自分の依頼を出す（applicant_user_id で判定）
      const approver = await createUser(page, '承認 担当', ['approver']);
      try {
        const title = `自分の依頼 ${stamp()}`;
        const id = await createRequestAs(p, title, approver);
        await p.reload();
        await p.waitForSelector('#nav');
        const mine = p.locator('.card', { hasText: 'あなたの依頼' });
        await expect(mine).toContainText(title);
        await expect(mine).toContainText(id);

        // 詳細を開くと、持っていない受付担当・承認者への切替ボタンは出ない（F-2）
        await mine.getByText(title).click();
        await p.waitForSelector('#drawer.open');
        await expect(p.locator('#drawer')).toContainText(title);
        await expect(p.locator('#drawer [data-a="role"]')).toHaveCount(0);

        // サーバ接続時は、設定「起動したとき、ログイン画面から始める」でも見本のログインを出さない
        // （見本のログインは全 3 役割を出し、サーバのセッションを無視して画面の役割を変えてしまう: F-2 の別経路）
        await p.evaluate(() => localStorage.setItem('sf-station-v1-settings', JSON.stringify({ startLogin: true })));
        await p.reload();
        await p.waitForSelector('#nav');
        await expect(p.locator('#auth')).not.toHaveClass(/open/);
        expect(await roleOptions(p)).toEqual(['一般利用者（依頼者）']);
        expect((await sessionUser(p)).actingRole).toBe('requester');
      } finally {
        await deactivate(page, approver.id);
      }
    } finally {
      if (other) await other.context.close();
      await deactivate(page, account.id);
    }
  });

  test('3 役割を持つ利用者: 3 つ出て、役割の切替（POST /api/auth/role）が従来どおり動く', async ({ page, baseURL }) => {
    const account = await createUser(page, '全役割 利用者', ['requester', 'desk', 'approver']);
    let other: { context: BrowserContext; page: Page } | undefined;
    try {
      other = await loginInNewContext(page, baseURL, account.email, account.password);
      const p = other.page;

      // 初期値はサーバの操作中の役割（受付担当を持つので desk）。候補から外れて空にならない
      expect(await p.locator('#role').inputValue()).toBe('desk');

      const options = await roleOptions(p);
      expect(options).toEqual([
        '全役割 利用者（依頼者）',
        '全役割 利用者（受付担当（IT・DX））',
        '全役割 利用者（承認者（業務責任者））',
      ]);
      await expectNoRosterNames(p, options.join('\n'));

      // 承認者へ切り替える: 画面の役割とサーバのセッションの役割が変わる。表示名は変わらない
      await p.selectOption('#role', 'approver');
      await expect.poll(async () => (await sessionUser(p)).actingRole).toBe('approver');
      expect(await p.locator('#role').inputValue()).toBe('approver');
      expect(await p.locator('#role option:checked').innerText()).toBe('全役割 利用者（承認者（業務責任者））');
      expect(await actorName(p)).toBe('全役割 利用者');

      // 依頼者へ戻す
      await p.selectOption('#role', 'requester');
      await expect.poll(async () => (await sessionUser(p)).actingRole).toBe('requester');
      expect(await p.locator('#role').inputValue()).toBe('requester');
    } finally {
      if (other) await other.context.close();
      await deactivate(page, account.id);
    }
  });
});
