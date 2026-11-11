import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const approvers = [
  { id: A, displayName: '架空 同名', email: 'first@example.com', deptCode: 'dx' },
  { id: B, displayName: '架空 同名', email: 'second@example.com', deptCode: 'dx' },
];
const user = {
  id: A,
  displayName: '架空 同名',
  email: 'first@example.com',
  deptCode: 'dx',
  isAdmin: true,
  roles: ['requester', 'desk', 'approver'],
  actingRole: 'desk',
};
const request = (extra: Record<string, unknown> = {}) => ({
  id: 'REQ-2026-0001',
  version: 1,
  title: '架空の承認者選択確認',
  applicant: user.displayName,
  applicantUserId: A,
  deptCode: 'dx',
  kind: 'new_tool',
  problem: '架空メモの整理を確認する',
  purpose: '利用者IDが正しく保存されることを確認する',
  users: ['現場の担当者'],
  places: ['事務所'],
  scope: ['架空メモの記録'],
  outOfScope: ['実装と外部送信'],
  criteria: ['再読込後に1件の依頼が表示される'],
  decides: 'g',
  parties: 'internal',
  dataHandling: [],
  constraints: [],
  constraintsOther: [],
  approvals: [],
  approver: approvers[1]!.displayName,
  approverUserId: B,
  status: 'received',
  signalDecided: null,
  orderVersion: 0,
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
  history: [],
  comments: [],
  ...extra,
});
async function mount(
  page: Page,
  options: {
    directory?: unknown;
    item?: ReturnType<typeof request>;
    offline?: boolean;
    bridgeFail?: boolean;
    invalidUser?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const item = options.item;
  const boot = {
    user: options.invalidUser ? null : user,
    role: 'desk',
    csrf: 'synthetic-csrf',
    seq: item ? 1 : 0,
    items: item ? [item] : [],
    drafts: [],
    ops: null,
    approvers: 'directory' in options ? options.directory : approvers,
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'approver.test') return route.abort();
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
    if (url.pathname === '/bridge.js' && options.bridgeFail) return route.fulfill({ status: 503, body: '' });
    if (url.pathname === '/bridge.js' || url.pathname === '/console.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(resolve('src/web/public' + url.pathname), 'utf8'),
      });
    if (url.pathname.startsWith('/api/')) {
      const body = req.postData() ? JSON.parse(req.postData()!) : null;
      calls.push({ method: req.method(), path: url.pathname, body });
      if (url.pathname === '/api/auth/role') return route.fulfill({ json: { user: { ...user, actingRole: body.role } } });
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } });
      if (url.pathname === '/api/approvers') return route.fulfill({ json: { items: boot.approvers } });
      if (url.pathname === '/api/requests' && req.method() === 'POST')
        return route.fulfill({ json: { request: request({ ...body, approverUserId: body.approverUserId }) } });
      if (url.pathname === '/api/requests/REQ-2026-0001' && req.method() === 'PATCH')
        return route.fulfill({ json: { detail: request({ ...body, version: Number(body.version) + 1 }) } });
      if (url.pathname === '/api/drafts' && req.method() === 'POST')
        return route.fulfill({ json: { draft: { id: '33333333-3333-4333-8333-333333333333', ...body } } });
      return route.fulfill({ json: { items: [], version: 1 } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://approver.test/');
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  return calls;
}
async function wizard(page: Page) {
  await page.getByRole('button', { name: '新しい依頼', exact: true }).click();
  await page.getByRole('button', { name: '新しい道具がほしい', exact: false }).click();
  await page.locator('#next').click();
  await page.getByRole('button', { name: '現場の担当者', exact: true }).click();
  await page.getByRole('button', { name: '事務所', exact: true }).click();
  await page.locator('#next').click();
  await page.locator('[data-bind="title"]').fill('架空のID選択確認');
  await page.locator('[data-bind="problem"]').fill('架空のメモを整理する');
  await page.locator('[data-bind="purpose"]').fill('利用者IDの保存を確認する');
  await page.locator('#next').click();
  await page.locator('[data-bind="scope"]').fill('架空メモの記録');
  await page.locator('#next').click();
  await page.locator('[data-crit]').first().fill('再読込後に1件表示される');
  await page.locator('#next').click();
  await page.locator('[data-one="decides"][data-v="g"]').click();
  await page.locator('#next').click();
}
const select = (page: Page) => page.locator('select[data-bind="approverUserId"]');

test('実名簿をIDで区別し空選択では送信せず、選択したIDをPOSTする', async ({ page }) => {
  const calls = await mount(page);
  await wizard(page);
  await expect(select(page)).toHaveValue('');
  await expect(select(page)).toContainText('first@example.com');
  await expect(select(page)).toContainText('second@example.com');
  await expect(select(page)).not.toContainText('鈴木 一郎');
  await page.locator('#submit').click();
  expect(calls.filter((c) => c.path === '/api/requests' && c.method === 'POST')).toHaveLength(0);
  await select(page).selectOption(B);
  await page.locator('#submit').click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/requests' && c.method === 'POST').length).toBe(1);
  expect(calls.find((c) => c.path === '/api/requests' && c.method === 'POST')!.body).toMatchObject({
    approverUserId: B,
    approver: '架空 同名',
  });
});

test('編集で保存済みIDを復元し、同名の別人への変更をPATCHする', async ({ page }) => {
  const calls = await mount(page, { item: request() });
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空の承認者選択確認' }).click();
  await page.locator('#ded').click();
  await page.locator('[data-step="6"]').click();
  await expect(select(page)).toHaveValue(B);
  await select(page).selectOption(A);
  await page.locator('#submit').click();
  await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(1);
  expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ approverUserId: A, approver: '架空 同名' });
});

for (const [title, directory] of [
  ['空の名簿', []],
  ['取得できない名簿', null],
  ['不正な行を含む名簿', [{ id: 'invalid', displayName: '架空' }]],
] as const) {
  test(`${title}で見本へ戻さず送信を止める`, async ({ page }) => {
    const calls = await mount(page, { directory });
    await wizard(page);
    await expect(select(page)).toBeDisabled();
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toBeVisible();
    expect(calls.filter((c) => c.path === '/api/requests' && c.method === 'POST')).toHaveLength(0);
    await expect(page.locator('#stepBody')).not.toContainText('鈴木 一郎');
  });
}

test('旧氏名だけの依頼は同名の先頭を勝手に選ばない', async ({ page }) => {
  await mount(page, { item: request({ approverUserId: null }) });
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空の承認者選択確認' }).click();
  await page.locator('#ded').click();
  await page.locator('[data-step="6"]').click();
  await expect(select(page)).toHaveValue('');
});

test('退職等で名簿にないIDを勝手に別人へ切り替えない', async ({ page }) => {
  const calls = await mount(page, { directory: [approvers[0]], item: request() });
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空の承認者選択確認' }).click();
  await page.locator('#ded').click();
  await page.locator('[data-step="6"]').click();
  await expect(select(page)).not.toHaveValue(A);
  await page.locator('#submit').click();
  expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
});

test('サーバ復元後の変更なし同期で余分なPATCHを送らない', async ({ page }) => {
  const calls = await mount(page, { item: request() });
  await page.evaluate(async () => {
    const w = window as unknown as {
      __MSF__: { persist: (data: unknown) => Promise<unknown> };
      __MSF_UI__: { data: () => unknown };
    };
    await w.__MSF__.persist(w.__MSF_UI__.data());
  });
  expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
});

test('候補のHTML文字を文字列として表示しスクリプト実行しない', async ({ page }) => {
  await mount(page, { directory: [{ ...approvers[0], displayName: '<img src=x onerror=alert(1)>' }] });
  await wizard(page);
  await expect(select(page)).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#stepBody img')).toHaveCount(0);
});

test('下書きに選択IDが保存され再読込後も復元される', async ({ page }) => {
  const calls = await mount(page);
  await wizard(page);
  await select(page).selectOption(B);
  // Move back: renders + awaits the normal draft save path without submitting a request.
  await page.locator('#prev').click();
  await expect
    .poll(() =>
      calls
        .filter((c) => c.path.startsWith('/api/drafts') && ['POST', 'PUT'].includes(c.method))
        .some((c) => JSON.stringify(c.body).includes(B)),
    )
    .toBe(true);
  await page.locator('[data-step="6"]').click();
  await expect(select(page)).toHaveValue(B);
  const saved = await page.evaluate(() => localStorage.getItem('mirai-const-sf-console-v1-drafts') ?? '');
  expect(saved).toContain(B);
  await page.reload();
  await page.getByRole('button', { name: '新しい依頼', exact: true }).click();
  await page.locator('[data-res]').first().click();
  await expect(select(page)).toHaveValue(B);
});

test('同名でも本人ではない指定承認者の依頼は承認できない', async ({ page }) => {
  await mount(page, { item: request({ status: 'wait' }) });
  await page.selectOption('#role', 'approver');
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空の承認者選択確認' }).click();
  await expect(page.locator('#dnext')).toBeDisabled();
  await expect(page.locator('#role option:checked')).toContainText(user.displayName);
});

test('同姓同名の競合もメールを併記して違いを表示する', async ({ page }) => {
  await mount(page, { item: request() });
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空の承認者選択確認' }).click();
  await page.locator('#ded').click();
  await page.locator('[data-step="6"]').click();
  await select(page).selectOption(A);
  await page.evaluate(() => {
    const w = window as unknown as { __MSF_UI__: { data: () => { items: { __v: number }[] } } };
    w.__MSF_UI__.data().items[0]!.__v = 2;
  });
  await page.locator('#submit').click();
  await expect(page.locator('#conflict')).toContainText('first@example.com');
  await expect(page.locator('#conflict')).toContainText('second@example.com');
});

test('ウィザード外の氏名だけの取込でもbridgeがPOSTを止める', async ({ page }) => {
  const calls = await mount(page);
  await page.evaluate(async () => {
    const w = window as unknown as {
      __MSF__: { persist: (d: unknown) => Promise<unknown> };
      __MSF_UI__: { data: () => { items: Record<string, unknown>[] } };
    };
    const data = w.__MSF_UI__.data();
    data.items.push({
      id: 'REQ-2026-0002',
      title: '架空取込',
      approver: '架空 同名',
      status: 'received',
      history: [],
      comments: [],
      criteria: [],
    });
    await w.__MSF__.persist(data);
  });
  expect(calls.filter((c) => c.path === '/api/requests' && c.method === 'POST')).toHaveLength(0);
});
for (const mode of ['bridgeFail', 'invalidUser'] as const) {
  test(`接続ページの${mode}で見本モードへ戻さない`, async ({ page }) => {
    await mount(page, { [mode]: true });
    await page.getByRole('button', { name: '新しい依頼', exact: true }).click();
    await expect(page.locator('#role')).not.toContainText('鈴木 一郎');
    await page.locator('[data-step="6"]').click();
    await expect(page.locator('#stepBody')).not.toContainText('鈴木 一郎');
  });
}

test('単体オフライン原本の見本選択は維持する', async ({ page }) => {
  await mount(page, { offline: true });
  await wizard(page);
  await expect(page.locator('select[data-bind="approver"]')).toContainText('鈴木 一郎');
});
