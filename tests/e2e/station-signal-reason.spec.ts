import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 信号を候補よりゆるくして承認するときの理由（2026-11-13 追加）。
 *
 * サーバは「候補よりゆるい色にするときは理由が必須」を検査する（`src/shared/domain.ts` の
 * `validateApproval`）。画面が履歴の自動文（「信号の色を『青』に決定」）を理由として送っていたため、
 * 利用者がメモを書かなくてもこの検査を通り抜けていた（docs/production/38-… §7-1）。
 * ここでは、画面が (1) メモ無しでは送らない、(2) メモを書いたときは利用者のメモが理由として
 * サーバに残る（自動文が理由にならない）ことを確かめる。
 *
 * 約束: 操作するのはこのファイルが作る依頼だけ。故障注入はしない。
 */

interface Me {
  user: { id: string; displayName: string; actingRole: string };
}
interface RequestList {
  items: { id: string; title: string }[];
}
interface RequestDetail {
  request: {
    id: string;
    status: string;
    version: number;
    signalDecided: string | null;
    comments: { text: string }[];
    history: { action: string; note: string | null }[];
  };
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#nav');
  await expect(page.locator('#stat')).toContainText('サーバ保存');
}

async function gotoTab(page: Page, view: string): Promise<void> {
  await page.click(`#nav a[data-v="${view}"]`);
  await expect(page.locator(`#nav a[data-v="${view}"]`)).toHaveClass(/\bon\b/);
}

async function callWith<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
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
    body = text;
  }
  return { status: res.status(), body: body as T };
}

async function me(page: Page): Promise<{ id: string; displayName: string; actingRole: string }> {
  const res = await callWith<Me>(page.request, 'GET', '/api/auth/me');
  return res.body.user;
}

async function detail(page: Page, id: string): Promise<RequestDetail['request']> {
  const res = await callWith<RequestDetail>(page.request, 'GET', `/api/requests/${encodeURIComponent(id)}`);
  return res.body.request;
}

async function transition(page: Page, id: string, to: string): Promise<void> {
  const current = await detail(page, id);
  const res = await callWith<{ detail?: { version: number } }>(page.request, 'POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
    to,
    version: current.version,
  });
  expect(res.status, `transition ${to}`).toBe(200);
}

/** 7 ステップで登録する（「決める仕事」を黄にすると候補が黄になる）。 */
async function createWithSignal(page: Page, title: string): Promise<string> {
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');
  const next = () => page.click('#pane [data-a="next"]');
  await next();
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next();
  await page.fill('#stepBody [data-bind="title"]', title);
  await page.fill('#stepBody [data-bind="problem"]', '信号理由の試験のための架空の困りごとです');
  await page.fill('#stepBody [data-bind="purpose"]', '候補よりゆるい色で承認するときの理由を確かめる');
  await next();
  await page.fill('#stepBody [data-bind="scope"]', '依頼の登録');
  await next();
  await page.fill('#stepBody [data-crit="0"]', '信号理由の試験用の合格条件（数字で確認できる）');
  await next();
  await page.click('#stepBody [data-a="one"][data-f="decides"][data-v="y"]');
  await next();
  const byId = page.locator('#stepBody select[data-bind="approverUserId"]');
  if ((await byId.count()) > 0) await byId.selectOption((await me(page)).id);
  await page.click('#pane [data-a="submit"]');
  await expect
    .poll(
      async () => {
        const res = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(title)}`);
        return res.body.items.filter((x) => x.title === title).length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  const res = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(title)}`);
  const id = res.body.items.find((x) => x.title === title)?.id ?? '';
  expect(id).toMatch(/^REQ-\d{4}-\d{4}$/);
  return id;
}

/** 承認者が承認する操作を開く（承認待ちの依頼を右端パネルに出す）。 */
async function openApproval(page: Page, id: string): Promise<void> {
  await gotoTab(page, 'review');
  await page.click(`#work .li[data-id="${id}"]`);
  await expect(page.locator('#rin .dp-h')).toContainText(id);
  await page.click(`#rin [data-a="status"][data-id="${id}"][data-v="approved"]`);
  await expect(page.locator('#modal.open')).toHaveCount(1);
  await expect(page.locator('#apv')).toBeVisible();
}

test.describe('候補よりゆるい信号の承認理由', () => {
  test('メモが無ければ送らず、書いたメモだけが理由としてサーバに残る', async ({ page }) => {
    const title = `E2E 信号理由 ${stamp()}`;
    await open(page);
    const id = await createWithSignal(page, title);

    // 受付 → 内容確認中 → 承認待ち（画面ではなく API で進める。承認の画面だけを検証する）。
    await transition(page, id, 'review');
    await transition(page, id, 'wait');
    expect((await detail(page, id)).status).toBe('wait');

    // 承認者に切り替える。
    await page.selectOption('#role', 'approver');
    await expect.poll(async () => (await me(page)).actingRole).toBe('approver');
    await open(page);
    await openApproval(page, id);

    // 候補は黄。青（候補よりゆるい）を選び、メモは空のまま送ろうとする。
    await page.check('#modal input[name="fc"][value="g"]');
    await page.click('#modal [data-a="sok"]');

    await expect(page.locator('#toast')).toContainText('候補よりゆるい色にする理由をメモに書いてください');
    await expect(page.locator('#modal.open')).toHaveCount(1);
    expect((await detail(page, id)).status).toBe('wait');
    expect((await detail(page, id)).comments).toHaveLength(0);

    // メモを書けば通り、利用者のメモが理由（コメント）として残る。自動の履歴文は理由にならない。
    const reason = '現場の実測で青と判断した（E2E）';
    await page.fill('#nnote', reason);
    await page.click('#modal [data-a="sok"]');

    await expect.poll(async () => (await detail(page, id)).status, { timeout: 30_000 }).toBe('approved');
    const approved = await detail(page, id);
    expect(approved.signalDecided).toBe('g');
    expect(approved.comments.map((c) => c.text)).toEqual([reason]);
    expect(approved.comments.map((c) => c.text)).not.toContain('信号の色を「青」に決定');
    // サーバの履歴には決定内容が残る（自動文は履歴であって、理由ではない）。
    expect(approved.history.at(-1)?.note ?? '').toContain(reason);
  });
});
