import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * ステーション画面「新しい依頼」STEP 7 の承認者選択の回帰。
 *
 * 承認できるのは approver_user_id の本人だけなので、承認者は表示名ではなく利用者 ID で選ぶ。
 * 実サーバ・実 DB に対して、選んだ人の ID が保存されること、編集で付け替えられること、
 * 名簿に無い ID・名前だけの旧データ・取得できない名簿で別人へ自動で切り替えないことを確かめる。
 * 利用者はすべて架空（example.com）。作った承認者はテストの終わりに無効化する。
 */

type SFWindow = Window & {
  __SF: { S: { role: string; data: { items: { id: string; title: string; approver?: string }[] } } };
  __MSF__?: { persist: (data: unknown) => Promise<unknown> };
  __MSF_UI__?: { data: () => unknown };
  __xss?: number;
};
type Role = 'requester' | 'desk' | 'approver';
type Approver = { id: string; displayName: string; email: string };
type ServerRequest = { id: string; title: string; approver: string; approverUserId: string | null; version: number };
type ApiResult = { status: number; json: Record<string, unknown> | null };

const RUN = Date.now().toString(36);
const SELECT = '#stepBody select[data-bind="approverUserId"]';
let serial = 0;
const created: string[] = [];

async function open(page: Page): Promise<void> {
  // ログインは auth.setup.ts の共有セッションを使う（試行回数の上限を避ける）
  await page.goto('/');
  await page.waitForSelector('#nav');
}

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

async function setRole(page: Page, role: Role): Promise<void> {
  if ((await page.locator('#role').inputValue()) !== role) await page.selectOption('#role', role);
  await expect.poll(async () => page.evaluate(() => (window as unknown as SFWindow).__SF.S.role)).toBe(role);
  await page.waitForTimeout(200);
}

/** 架空の承認者を 1 人作る（管理者の API）。作った人は afterEach で無効化する。 */
async function createApprover(page: Page, displayName: string): Promise<Approver> {
  serial += 1;
  const depts = await api(page, 'GET', '/api/catalog/departments');
  const deptCode = ((depts.json?.items as { code: string }[] | undefined) ?? [])[0]?.code;
  expect(deptCode).toBeTruthy();
  const email = `apv-${RUN}-${serial}@example.com`;
  const res = await api(page, 'POST', '/api/admin/users', {
    email,
    displayName,
    deptCode,
    password: `T-${randomUUID()}`,
    roles: ['approver'],
    isAdmin: false,
  });
  expect(res.status).toBe(201);
  const user = res.json?.user as { id: string } | undefined;
  expect(user?.id).toBeTruthy();
  created.push(user!.id);
  return { id: user!.id, displayName, email };
}

async function deactivate(page: Page, id: string): Promise<void> {
  const res = await api(page, 'PATCH', `/api/admin/users/${id}`, { isActive: false });
  expect(res.status).toBe(200);
}

/** STEP 1〜6 を埋めて STEP 7（承認者）を開く。 */
async function toStep7(page: Page, title: string): Promise<void> {
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');
  const next = () => page.click('#pane [data-a="next"]');
  await next();
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next();
  await page.fill('#stepBody [data-bind="title"]', title);
  await page.fill('#stepBody [data-bind="problem"]', '承認者を利用者IDで選べるかを確かめたい');
  await page.fill('#stepBody [data-bind="purpose"]', '選んだ承認者の利用者IDがサーバに保存されることを確認する');
  await next();
  await page.fill('#stepBody [data-bind="scope"]', '承認者の選択\n承認者の付け替え');
  await next();
  await page.fill('#stepBody [data-crit="0"]', '選んだ承認者の利用者IDが依頼に保存される');
  await next();
  await page.click('#stepBody [data-a="one"][data-f="decides"][data-v="g"]');
  await next();
  await expect(page.locator('#pane')).toContainText('承認者（業務責任者）');
}

async function findByTitle(page: Page, title: string): Promise<ServerRequest | null> {
  const list = await api(page, 'GET', '/api/requests?q=' + encodeURIComponent(title));
  const hit = ((list.json?.items as ServerRequest[] | undefined) ?? []).find((x) => x.title === title);
  return hit ?? null;
}

async function serverRequest(page: Page, id: string): Promise<ServerRequest> {
  const res = await api(page, 'GET', '/api/requests/' + encodeURIComponent(id));
  expect(res.status).toBe(200);
  return res.json?.request as ServerRequest;
}

/** 承認者を名前だけで指定した依頼を API で作る（利用者 ID を持たない旧データの再現）。 */
async function createNameOnlyRequest(page: Page, title: string, approver: string): Promise<ServerRequest> {
  // 起票者と部署は見本の社員名簿から取る（一覧の表示を確かめる他の spec と矛盾させない）
  const roster = await api(page, 'GET', '/api/mirai/employees');
  const person = ((roster.json?.items as { name: string; divisionCode: string }[] | undefined) ?? [])[0];
  expect(person?.divisionCode).toBeTruthy();
  const res = await api(page, 'POST', '/api/requests', {
    title,
    kind: 'new_tool',
    deptCode: person!.divisionCode,
    applicant: person!.name,
    problem: '承認者が名前だけの依頼を再現する',
    purpose: '名前だけの承認者を別の人へ自動で割り当てないことを確認する',
    users: ['現場の担当者'],
    scope: ['承認者の再選択'],
    criteria: ['承認者を選び直すまで保存されない'],
    decides: 'g',
    approver,
  });
  expect(res.status).toBe(201);
  return res.json?.request as ServerRequest;
}

/** STEP 7 で承認者を選んで登録し、サーバに現れた依頼を返す。 */
async function register(page: Page, title: string, approverId: string): Promise<ServerRequest> {
  await toStep7(page, title);
  await page.selectOption(SELECT, approverId);
  await page.click('#pane [data-a="submit"]');
  await expect.poll(async () => (await findByTitle(page, title))?.id ?? '', { timeout: 30_000 }).toMatch(/^REQ-\d{4}-\d{4}$/);
  const hit = await findByTitle(page, title);
  return serverRequest(page, hit!.id);
}

/** ボードで依頼を選び、右端パネルの編集から STEP 7 を開く。 */
async function editStep7(page: Page, id: string): Promise<void> {
  await page.click('#nav a[data-v="board"]');
  await page.click(`#work .kc[data-id="${id}"]`);
  await page.click(`#rin [data-a="edit"][data-id="${id}"]`);
  await page.waitForSelector('#stepBody');
  await page.click('#main .wsteps [data-a="step"][data-v="6"]');
  await expect(page.locator('#pane')).toContainText('承認者（業務責任者）');
}

/** いま走っている同期と、その次の 1 回が終わるまで待つ。 */
async function settleSync(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as SFWindow;
    if (w.__MSF__ && w.__MSF_UI__) await w.__MSF__.persist(w.__MSF_UI__.data());
  });
}

function watch(page: Page, method: string): Request[] {
  const seen: Request[] = [];
  page.on('request', (req) => {
    if (req.method() === method && new URL(req.url()).pathname.startsWith('/api/requests')) seen.push(req);
  });
  return seen;
}

/** 起動データ（HTML に埋め込まれた JSON）を書き換えて画面を開く。サーバ・DB は変えない。 */
async function openWithBoot(page: Page, patch: (boot: Record<string, unknown>) => void): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const res = await route.fetch();
      const html = await res.text();
      const body = html.replace(
        /(<script type="application\/json" id="msf-boot">)([\s\S]*?)(<\/script>)/,
        (_all, head: string, json: string, tail: string) => {
          const boot = JSON.parse(json) as Record<string, unknown>;
          patch(boot);
          return head + JSON.stringify(boot).replace(/</g, '\\u003c') + tail;
        },
      );
      await route.fulfill({ response: res, body });
    },
  );
  await open(page);
}

test.describe('ステーション画面の承認者選択（利用者ID）', () => {
  let initialRole: Role | null = null;

  test.beforeEach(async ({ page }) => {
    await open(page);
    if (!initialRole) initialRole = (await page.locator('#role').inputValue()) as Role;
  });

  test.afterEach(async ({ page }) => {
    // 後続の spec（station.spec.ts など）に、このファイルの承認者と役割を残さない
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.goto('/');
    await page.waitForSelector('#nav');
    for (const id of created.splice(0)) await api(page, 'PATCH', `/api/admin/users/${id}`, { isActive: false });
    if (initialRole) await api(page, 'POST', '/api/auth/role', { role: initialRole });
  });

  test('同名の承認者を選択肢で区別でき、選んだ人の利用者IDで登録される', async ({ page }) => {
    const name = `架空 同名 ${RUN}a`;
    const first = await createApprover(page, name);
    const second = await createApprover(page, name);
    await open(page);
    await setRole(page, 'requester');
    const posts = watch(page, 'POST');
    const title = `承認者ID 同名 ${RUN}`;
    await toStep7(page, title);

    const select = page.locator(SELECT);
    await expect(select).toHaveValue('');
    const labels = await select.locator('option').allInnerTexts();
    const same = labels.filter((l) => l.includes(name));
    expect(same).toHaveLength(2);
    expect(new Set(same).size).toBe(2);
    expect(same.some((l) => l.includes(first.email))).toBe(true);
    expect(same.some((l) => l.includes(second.email))).toBe(true);
    await expect(select.locator(`option[value="${second.id}"]`)).toContainText(second.email);

    await select.selectOption(second.id);
    // 右端のプレビューでも、どちらの人を選んだかが分かる
    await expect(page.locator('#rin')).toContainText(second.email);
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => (await findByTitle(page, title))?.id ?? '', { timeout: 30_000 }).toMatch(/^REQ-/);

    const saved = await serverRequest(page, (await findByTitle(page, title))!.id);
    expect(saved.approverUserId).toBe(second.id);
    expect(saved.approverUserId).not.toBe(first.id);
    expect(saved.approver).toBe(name);
    const post = posts.find((r) => new URL(r.url()).pathname === '/api/requests');
    expect(post?.postDataJSON()).toMatchObject({ approverUserId: second.id, approver: name });
  });

  test('編集で承認者を別の人へ変えると、サーバの承認者が変わる', async ({ page }) => {
    const before = await createApprover(page, `架空 付替前 ${RUN}`);
    const after = await createApprover(page, `架空 付替後 ${RUN}`);
    await open(page);
    await setRole(page, 'requester');
    const made = await register(page, `承認者ID 付替 ${RUN}`, before.id);
    expect(made.approverUserId).toBe(before.id);

    await open(page);
    await setRole(page, 'desk');
    const patches = watch(page, 'PATCH');
    await editStep7(page, made.id);
    await expect(page.locator(SELECT)).toHaveValue(before.id);
    await page.selectOption(SELECT, after.id);
    await page.click('#pane [data-a="submit"]');

    await expect.poll(async () => (await serverRequest(page, made.id)).approverUserId, { timeout: 30_000 }).toBe(after.id);
    const saved = await serverRequest(page, made.id);
    expect(saved.approver).toBe(after.displayName);
    expect(saved.version).toBeGreaterThan(made.version);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.postDataJSON()).toMatchObject({ approverUserId: after.id, approver: after.displayName });
  });

  test('承認者を変えずに内容だけ編集すると、承認者の利用者IDが保たれる', async ({ page }) => {
    const keep = await createApprover(page, `架空 保持 ${RUN}`);
    await open(page);
    await setRole(page, 'requester');
    const title = `承認者ID 保持 ${RUN}`;
    const made = await register(page, title, keep.id);

    await open(page);
    await setRole(page, 'desk');
    const patches = watch(page, 'PATCH');
    await editStep7(page, made.id);
    await expect(page.locator(SELECT)).toHaveValue(keep.id);
    await page.click('#main .wsteps [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', title + ' 改');
    await page.click('#main .wsteps [data-a="step"][data-v="6"]');
    await expect(page.locator(SELECT)).toHaveValue(keep.id);
    await page.click('#pane [data-a="submit"]');

    await expect.poll(async () => (await serverRequest(page, made.id)).title, { timeout: 30_000 }).toBe(title + ' 改');
    const saved = await serverRequest(page, made.id);
    expect(saved.approverUserId).toBe(keep.id);
    expect(saved.approver).toBe(keep.displayName);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.postDataJSON()).toMatchObject({ approverUserId: keep.id });
  });

  test('何も変えずに編集を保存しても、余分な更新を送らない', async ({ page }) => {
    const keep = await createApprover(page, `架空 無変更 ${RUN}`);
    await open(page);
    await setRole(page, 'requester');
    const made = await register(page, `承認者ID 無変更 ${RUN}`, keep.id);

    await open(page);
    await setRole(page, 'desk');
    const patches = watch(page, 'PATCH');
    await editStep7(page, made.id);
    await page.click('#pane [data-a="submit"]');
    await settleSync(page);

    expect(patches).toHaveLength(0);
    const saved = await serverRequest(page, made.id);
    expect(saved.approverUserId).toBe(keep.id);
    expect(saved.version).toBe(made.version);
  });

  test('承認者が未選択のままでは登録に進めない', async ({ page }) => {
    await setRole(page, 'requester');
    const posts = watch(page, 'POST');
    const title = `承認者ID 未選択 ${RUN}`;
    await toStep7(page, title);
    await expect(page.locator(SELECT)).toHaveValue('');
    await page.click('#pane [data-a="submit"]');

    await expect(page.locator('#err')).toBeVisible();
    await expect(page.locator('#err')).toContainText('承認者を選んでください');
    await expect(page.locator('#pane')).toContainText('承認者（業務責任者）');
    await expect(page.locator('#stamp')).toBeHidden();
    await expect(page.locator('#toast')).not.toContainText('受け付けました');
    await settleSync(page);
    expect(posts.filter((r) => new URL(r.url()).pathname === '/api/requests')).toHaveLength(0);
    expect(await findByTitle(page, title)).toBeNull();
  });

  test('名簿から外れた承認者の依頼を編集しても、別の人へ自動で切り替えない', async ({ page }) => {
    const gone = await createApprover(page, `架空 退任 ${RUN}`);
    await open(page);
    await setRole(page, 'requester');
    const made = await register(page, `承認者ID 名簿外 ${RUN}`, gone.id);
    await deactivate(page, gone.id);

    await open(page);
    await setRole(page, 'desk');
    const patches = watch(page, 'PATCH');
    await editStep7(page, made.id);
    const select = page.locator(SELECT);
    // 名簿に無い ID は「選べない現在の値」として残し、名簿の誰かには置き換えない
    await expect(select).toHaveValue(gone.id);
    await expect(select.locator('option:checked')).toBeDisabled();
    await expect(select.locator('option:checked')).toContainText(gone.displayName);
    await expect(page.locator('#pane')).toContainText('承認者を選び直してください');
    await page.click('#pane [data-a="submit"]');

    await expect(page.locator('#err')).toContainText('承認者を選び直してください');
    await expect(page.locator('#toast')).not.toContainText('更新しました');
    await settleSync(page);
    expect(patches).toHaveLength(0);
    const saved = await serverRequest(page, made.id);
    expect(saved.approverUserId).toBe(gone.id);
    expect(saved.version).toBe(made.version);
  });

  test('名前だけの旧い依頼は、同じ名前の人へ自動で割り当てない', async ({ page }) => {
    // 旧 API の互換（名前だけの指定）で、利用者 ID の無い依頼を作る。その後に同じ名前の承認者が現れた状況にする
    const name = `架空 旧名 ${RUN}`;
    const legacy = await createNameOnlyRequest(page, `承認者ID 旧名 ${RUN}`, name);
    expect(legacy.approverUserId).toBeNull();
    const sameName = await createApprover(page, name);
    await open(page);
    await setRole(page, 'desk');
    const patches = watch(page, 'PATCH');
    await editStep7(page, legacy.id);

    const select = page.locator(SELECT);
    await expect(select).toHaveValue('');
    await expect(select.locator('option:checked')).toContainText(name);
    await expect(select.locator(`option[value="${sameName.id}"]`)).toHaveCount(1);
    await expect(page.locator('#pane')).toContainText('承認者を選び直してください');
    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#err')).toContainText('承認者を選び直してください');
    await expect(page.locator('#toast')).not.toContainText('更新しました');
    await settleSync(page);
    expect(patches).toHaveLength(0);
    expect((await serverRequest(page, legacy.id)).approverUserId).toBeNull();
  });

  test('候補の表示名の HTML 文字は文字列として表示され、実行されない', async ({ page }) => {
    const markup = `<img src=x onerror="window.__xss=1">${RUN}`;
    const evil = await createApprover(page, markup);
    await open(page);
    await setRole(page, 'requester');
    await toStep7(page, `承認者ID 表示 ${RUN}`);

    const option = page.locator(`${SELECT} option[value="${evil.id}"]`);
    await expect(option).toHaveText(markup);
    await page.selectOption(SELECT, evil.id);
    await expect(page.locator('#rin')).toContainText(markup);
    await page.click('#nav a[data-v="settings"]');
    await page.click('#setleft .li[data-v="approvers"]');
    await expect(page.locator('#rin')).toContainText(markup);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as SFWindow).__xss)).toBeUndefined();
  });

  test('承認者名簿を取得できないときは、見本の名前へ戻さず登録を止める', async ({ page }) => {
    await openWithBoot(page, (boot) => {
      boot.approvers = null;
    });
    await setRole(page, 'requester');
    const posts = watch(page, 'POST');
    const title = `承認者ID 名簿なし ${RUN}`;
    await toStep7(page, title);

    await expect(page.locator(SELECT)).toBeDisabled();
    await expect(page.locator('#pane')).toContainText('承認者一覧を取得できない');
    await expect(page.locator('#stepBody')).not.toContainText('鈴木 一郎');
    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#err')).toContainText('承認者一覧を取得できない');
    await expect(page.locator('#stamp')).toBeHidden();
    await expect(page.locator('#toast')).not.toContainText('受け付けました');
    await settleSync(page);
    expect(posts.filter((r) => new URL(r.url()).pathname === '/api/requests')).toHaveLength(0);
    // 設定の承認者タブにも、見本の名前を出さない
    await page.click('#nav a[data-v="settings"]');
    await page.click('#setleft .li[data-v="approvers"]');
    await expect(page.locator('#rin')).toContainText('サーバの利用者管理');
    await expect(page.locator('#rin')).not.toContainText('鈴木 一郎');
  });

  test('サーバ接続の処理を読めないときは、見本の承認者で登録できない', async ({ page }) => {
    await page.route('**/station-bridge.js*', (route) => route.fulfill({ status: 503, body: '' }));
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('#nav');
    await toStep7(page, `承認者ID 接続なし ${RUN}`);

    await expect(page.locator(SELECT)).toBeDisabled();
    await expect(page.locator('#stepBody')).not.toContainText('鈴木 一郎');
    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#err')).toBeVisible();
    await expect(page.locator('#pane')).toContainText('承認者（業務責任者）');
  });

  test('オフライン単体の見本は、これまでどおり名前の一覧から選べる', async ({ page }) => {
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
    const title = `承認者 見本 ${RUN}`;
    await toStep7(page, title);

    await expect(page.locator(SELECT)).toHaveCount(0);
    const select = page.locator('#stepBody select[data-bind="approver"]');
    await expect(select).toHaveValue('鈴木 一郎');
    await expect(select.locator('option')).toHaveText(['鈴木 一郎', '田中 誠司', '松本 綾']);
    await select.selectOption('田中 誠司');
    await page.click('#pane [data-a="submit"]');
    await expect
      .poll(async () =>
        page.evaluate((t) => {
          const item = (window as unknown as SFWindow).__SF.S.data.items.find((r) => r.title === t);
          return item ? item.approver : '';
        }, title),
      )
      .toBe('田中 誠司');
    expect(calls).toEqual([]);
  });
});
