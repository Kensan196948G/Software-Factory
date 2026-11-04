import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 利用者管理（管理者のみ・サーバ接続時のみ）の画面試験。
 *
 * `tests/browser/approver.spec.ts` と同じ方式で、`src/web/index.html` と
 * `src/web/public/*.js` をそのまま読み込み、通信はすべて横取りする。
 * 実DB・実サーバ・本番/Staging・メールには一切接続しない（作り物のデータのみ）。
 *
 * 確かめること:
 * - 管理者にだけ管理メニューを出し、非管理者とオフライン見本では出さない
 * - 一覧（メール・表示名・部署・ロール・管理者・有効/無効）を表示する
 * - 追加に成功するとパスワード欄が空になり、値が DOM・localStorage・トーストに残らない
 * - 403/400 のサーバの error.code（ERR-xxx）とメッセージを表示する（握りつぶさない）
 * - ロール変更と有効/無効は PATCH で送る。自分自身の無効化は危険な確認をはさむ
 */

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const DESK_ID = '22222222-2222-4222-8222-222222222222';
const INACTIVE_ID = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';

/** 作り物のパスワード。実在のものではない。画面・DOM・localStorage に残らないことを確かめる。 */
const SYNTHETIC_PASSWORD = 'Synthetic-Pass-2026';

const adminBootUser = {
  id: ADMIN_ID,
  displayName: '架空 管理者',
  email: 'admin@example.com',
  deptCode: 'dx',
  isAdmin: true,
  roles: ['requester', 'desk', 'approver'],
  actingRole: 'desk',
};

const memberBootUser = {
  ...adminBootUser,
  displayName: '架空 受付',
  email: 'desk@example.com',
  isAdmin: false,
  roles: ['desk'],
};

interface ManagedUserMock {
  id: string;
  email: string;
  displayName: string;
  deptCode: string;
  isAdmin: boolean;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  deactivatedAt: string | null;
}

function managedUsers(): ManagedUserMock[] {
  return [
    {
      id: ADMIN_ID,
      email: 'admin@example.com',
      displayName: '架空 管理者',
      deptCode: 'dx',
      isAdmin: true,
      isActive: true,
      roles: ['requester', 'desk', 'approver'],
      createdAt: '2026-11-03T00:00:00Z',
      deactivatedAt: null,
    },
    {
      id: DESK_ID,
      email: 'desk@example.com',
      displayName: '架空 受付',
      deptCode: 'dx',
      isAdmin: false,
      isActive: true,
      roles: ['desk'],
      createdAt: '2026-11-03T00:00:00Z',
      deactivatedAt: null,
    },
    {
      id: INACTIVE_ID,
      email: 'off@example.com',
      displayName: '架空 無効',
      deptCode: 'keiei',
      isAdmin: false,
      isActive: false,
      roles: ['requester'],
      createdAt: '2026-11-03T00:00:00Z',
      deactivatedAt: '2026-11-04T00:00:00Z',
    },
  ];
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface Fail {
  status: number;
  code: string;
  message: string;
}

async function mount(
  page: Page,
  options: { isAdmin?: boolean; offline?: boolean; failCreate?: boolean; failPatch?: Fail & { id: string } } = {},
): Promise<Call[]> {
  const calls: Call[] = [];
  // サーバの代わりに持つ作り物の名簿。作成・変更の応答を一覧へ反映する（GET はこの写しを返す）
  let directory: ManagedUserMock[] = managedUsers();
  const bootUser = options.isAdmin === false ? memberBootUser : adminBootUser;
  const boot = {
    user: bootUser,
    role: 'desk',
    csrf: 'synthetic-csrf',
    seq: 0,
    items: [],
    drafts: [],
    ops: null,
    approvers: [],
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'admin.test') return route.abort();
    if (url.pathname === '/') {
      const template = readFileSync(resolve('src/web/index.html'), 'utf8');
      const html = options.offline
        ? template.replace('<script src="/bridge.js"></script>', '')
        : template.replace(
            '<!--MSF_BOOT-->',
            `<script type="application/json" id="msf-boot">${JSON.stringify(boot).replaceAll('<', '\\u003c')}</script>`,
          );
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.pathname === '/bridge.js' || url.pathname === '/console.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(resolve('src/web/public' + url.pathname), 'utf8'),
      });
    }
    if (url.pathname.startsWith('/api/')) {
      const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
      calls.push({ method: req.method(), path: url.pathname, body });
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: bootUser } });
      if (url.pathname === '/api/auth/csrf') return route.fulfill({ json: { csrf: 'synthetic-csrf' } });
      if (url.pathname === '/api/auth/role') return route.fulfill({ json: { user: bootUser } });
      if (url.pathname === '/api/approvers') return route.fulfill({ json: { items: [] } });
      if (url.pathname === '/api/admin/users' && req.method() === 'GET') {
        return route.fulfill({ json: { items: directory } });
      }
      if (url.pathname === '/api/admin/users' && req.method() === 'POST') {
        if (options.failCreate) {
          return route.fulfill({
            status: 403,
            json: { error: { code: 'ERR-101', message: 'この操作をする権限がありません' } },
          });
        }
        const created: ManagedUserMock = {
          id: NEW_ID,
          email: String(body?.email ?? ''),
          displayName: String(body?.displayName ?? ''),
          deptCode: String(body?.deptCode ?? ''),
          isAdmin: Boolean(body?.isAdmin),
          isActive: true,
          roles: Array.isArray(body?.roles) ? (body!.roles as string[]) : [],
          createdAt: '2026-11-04T00:00:00Z',
          deactivatedAt: null,
        };
        directory = [...directory, created];
        return route.fulfill({ status: 201, json: { user: created } });
      }
      if (url.pathname.startsWith('/api/admin/users/') && req.method() === 'PATCH') {
        const id = url.pathname.split('/').pop() ?? '';
        if (options.failPatch && options.failPatch.id === id) {
          return route.fulfill({
            status: options.failPatch.status,
            json: { error: { code: options.failPatch.code, message: options.failPatch.message } },
          });
        }
        const current = directory.find((u) => u.id === id);
        const updated = { ...current, ...body } as ManagedUserMock;
        directory = directory.map((u) => (u.id === id ? updated : u));
        return route.fulfill({ json: { user: updated } });
      }
      return route.fulfill({ json: { items: [], version: 1 } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://admin.test/');
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  return calls;
}

const adminMenu = (page: Page) => page.getByRole('button', { name: '利用者管理' });

async function openAdmin(page: Page) {
  await adminMenu(page).click();
  await expect(page.locator('#auTb')).toBeVisible();
}

test('管理者にだけ利用者管理のメニューを出す', async ({ page }) => {
  await mount(page);
  await expect(adminMenu(page)).toBeVisible();
});

test('管理者でない利用者には管理メニューを出さない', async ({ page }) => {
  await mount(page, { isAdmin: false });
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  await expect(adminMenu(page)).toHaveCount(0);
});

test('オフライン見本では管理メニューを出さず、既存の画面はそのまま使える', async ({ page }) => {
  await mount(page, { offline: true });
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  await expect(adminMenu(page)).toHaveCount(0);
  // オフライン原本の見本モードが生きている（役割の切替と一覧が出る）
  await expect(page.locator('#role')).toContainText('鈴木 一郎');
  await page.locator('button[data-v="list"]').click();
  await expect(page.locator('#view')).toContainText('一覧');
});

test('一覧にメール・表示名・部署・ロール・管理者・有効/無効を表示する', async ({ page }) => {
  await mount(page);
  await openAdmin(page);
  await expect(page.locator('#auTb tr')).toHaveCount(3);
  const self = page.locator('#auTb tr', { hasText: 'admin@example.com' });
  await expect(self).toContainText('架空 管理者');
  await expect(self).toContainText('DX推進部');
  await expect(self).toContainText('管理者');
  await expect(self).toContainText('あなた');
  await expect(self).toContainText('有効');
  const desk = page.locator('#auTb tr', { hasText: 'desk@example.com' });
  await expect(desk).toContainText('受付担当');
  await expect(desk).toContainText('有効');
  const inactive = page.locator('#auTb tr', { hasText: 'off@example.com' });
  await expect(inactive).toContainText('無効');
  await expect(inactive).toContainText('経営企画室');
});

test('追加に成功するとパスワード欄が空になり、値が DOM・localStorage・トーストに残らない', async ({ page }) => {
  const calls = await mount(page);
  await openAdmin(page);
  await page.locator('#auEmail').fill('new@example.com');
  await page.locator('#auName').fill('架空 新人');
  await page.locator('#auDept').selectOption('dx');
  await page.locator('#auPass').fill(SYNTHETIC_PASSWORD);
  await page.locator('#auRole-requester').check();
  await page.locator('#auRole-approver').check();
  await page.locator('#auAdmin').check();
  await page.locator('#auSubmit').click();

  await expect.poll(() => calls.filter((c) => c.path === '/api/admin/users' && c.method === 'POST').length).toBe(1);
  const post = calls.find((c) => c.path === '/api/admin/users' && c.method === 'POST')!;
  expect(post.body).toMatchObject({
    email: 'new@example.com',
    displayName: '架空 新人',
    deptCode: 'dx',
    roles: ['requester', 'approver'],
    isAdmin: true,
  });
  // パスワードは送るが、画面の状態には残さない
  expect(post.body!.password).toBe(SYNTHETIC_PASSWORD);
  await expect(page.locator('#auPass')).toHaveValue('');
  await expect(page.locator('#auFormMsg')).toContainText('パスワード欄は空にしました');
  await expect(page.locator('#auEmail')).toHaveValue('');
  await expect(page.locator('#auTb')).toContainText('new@example.com');

  const leaked = await page.evaluate((pw) => {
    const values = Array.from(document.querySelectorAll('input, textarea')).map(
      (el) => (el as HTMLInputElement).value,
    );
    return {
      inField: values.includes(pw),
      inBody: document.body.innerHTML.includes(pw),
      inStore: JSON.stringify({ ...localStorage }).includes(pw),
      inToast: (document.getElementById('toast')?.textContent ?? '').includes(pw),
    };
  }, SYNTHETIC_PASSWORD);
  expect(leaked).toEqual({ inField: false, inBody: false, inStore: false, inToast: false });
});

test('403 はサーバの ERR-101 とメッセージを表示し、パスワードを残さない', async ({ page }) => {
  await mount(page, { failCreate: true });
  await openAdmin(page);
  await page.locator('#auEmail').fill('new@example.com');
  await page.locator('#auName').fill('架空 新人');
  await page.locator('#auPass').fill(SYNTHETIC_PASSWORD);
  await page.locator('#auRole-desk').check();
  await page.locator('#auSubmit').click();

  await expect(page.locator('#auFormMsg')).toContainText('ERR-101');
  await expect(page.locator('#auFormMsg')).toContainText('この操作をする権限がありません');
  await expect(page.locator('#auListMsg')).toContainText('ERR-101');
  await expect(page.locator('#auPass')).toHaveValue('');
  // 403 を握りつぶして成功にしない（一覧の行は増えない）
  await expect(page.locator('#auTb')).not.toContainText('new@example.com');
});

test('無効化は isActive:false を PATCH し、自分自身は危険な確認をはさむ', async ({ page }) => {
  const calls = await mount(page, {
    failPatch: { id: ADMIN_ID, status: 400, code: 'ERR-003', message: '自分自身は無効化できません' },
  });
  await openAdmin(page);

  const desk = page.locator('#auTb tr', { hasText: 'desk@example.com' });
  await desk.getByRole('button', { name: '無効化' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(1);
  expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ isActive: false });
  await expect(page.locator('#auTb tr', { hasText: 'desk@example.com' })).toContainText('無効');
  await expect(page.locator('#auTb tr', { hasText: 'desk@example.com' })).toContainText('有効化');

  // 自分自身の無効化は、危険な確認をはさんでからサーバに送る（拒否も表示する）
  const self = page.locator('#auTb tr', { hasText: 'admin@example.com' });
  await self.getByRole('button', { name: '無効化' }).click();
  await expect(page.locator('#mmask')).toHaveClass(/show/);
  await expect(page.locator('#modal')).toContainText('自分自身を無効化しますか？');
  expect(calls.filter((c) => c.method === 'PATCH').length).toBe(1); // 確認の前には送らない
  await page.locator('#auDangerOk').click();
  await expect
    .poll(() => calls.filter((c) => c.method === 'PATCH' && c.path.endsWith(ADMIN_ID)).length)
    .toBe(1);
  await expect(page.locator('#auListMsg')).toContainText('ERR-003');
  await expect(page.locator('#auListMsg')).toContainText('自分自身は無効化できません');
});

test('ロール変更は roles を PATCH し、サーバの応答をチェックに反映する', async ({ page }) => {
  const calls = await mount(page);
  await openAdmin(page);
  const self = page.locator('#auTb tr', { hasText: 'admin@example.com' });
  await self.locator('input[data-urole][value="approver"]').uncheck();
  await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(1);
  const patch = calls.find((c) => c.method === 'PATCH')!;
  expect(patch.path).toBe('/api/admin/users/' + ADMIN_ID);
  expect(patch.body).toEqual({ roles: ['requester', 'desk'] });
  await expect(page.locator('#auListMsg')).toContainText('ロールを変更しました');
  await expect(self.locator('input[data-urole][value="approver"]')).not.toBeChecked();
});

test('ロールを全部外したときは送らずに知らせる', async ({ page }) => {
  const calls = await mount(page);
  await openAdmin(page);
  const rare = page.locator('#auTb tr', { hasText: 'off@example.com' });
  // 最後の1つは外せない（サーバはロール0件を拒否する）。画面はその場で戻して知らせる
  await rare.locator('input[data-urole][value="requester"]').click();
  await expect(page.locator('#auListMsg')).toContainText('ロールは1つ以上選んでください');
  expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  // サーバの値（1つ以上）へ戻る
  await expect(rare.locator('input[data-urole][value="requester"]')).toBeChecked();
});
