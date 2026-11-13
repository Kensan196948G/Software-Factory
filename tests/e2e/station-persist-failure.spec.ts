import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 保存に失敗したときの画面（2026-11-13 追加）。
 *
 * 旧 E2E（tests/e2e-legacy/persist.spec.ts）が守っていた「保存に失敗したら成功表示を出さず、
 * 入力を残す」性質は、2026-11-11 の画面置き換えで確かめられなくなっていた
 * （docs/production/36-release-readiness-20261113.md §7 の不具合 3）。
 * ここでは、POST / PATCH をブラウザ側で失敗させ、画面が成功を表示しないこと・入力が消えないこと・
 * サーバに依頼が作られない／変わらないことを確かめる。
 *
 * 約束:
 * - 操作するのはこのファイルが登録する依頼（件名に E2E を含む）だけ。seed の依頼は変更しない。
 * - 故障は page.route で作る（実サーバへは届かせない）。本番・Staging では実行しない。
 */

const CRITERION = '保存失敗の試験用の合格条件（数字で確認できる）';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#nav');
  await expect(page.locator('#stat')).toContainText('サーバ保存');
}

async function gotoTab(page: Page, view: string): Promise<void> {
  await page.click(`#nav a[data-v="${view}"]`);
  await expect(page.locator(`#nav a[data-v="${view}"]`)).toHaveClass(/\bon\b/);
}

async function gotoNew(page: Page): Promise<void> {
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');
}

/** STEP 1〜7 を入力し、送信はしない。 */
async function fillRequest(page: Page, title: string): Promise<void> {
  await gotoNew(page);
  const next = () => page.click('#pane [data-a="next"]');
  await next();
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next();
  await page.fill('#stepBody [data-bind="title"]', title);
  await page.fill('#stepBody [data-bind="problem"]', '保存失敗の試験のための架空の困りごとです');
  await page.fill('#stepBody [data-bind="purpose"]', '保存に失敗したときの画面の振る舞いを確かめる');
  await next();
  await page.fill('#stepBody [data-bind="scope"]', '依頼の登録');
  await next();
  await page.fill('#stepBody [data-crit="0"]', CRITERION);
  await next();
  await page.click('#stepBody [data-a="one"][data-f="decides"][data-v="g"]');
  await next();
  const byId = page.locator('#stepBody select[data-bind="approverUserId"]');
  if ((await byId.count()) > 0) await byId.selectOption((await me(page)).id);
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

interface Me {
  user: { id: string; displayName: string; actingRole: string };
}

async function me(page: Page): Promise<{ id: string; displayName: string; actingRole: string }> {
  const res = await callWith<Me>(page.request, 'GET', '/api/auth/me');
  return res.body.user;
}

interface RequestList {
  items: { id: string; title: string }[];
}

interface RequestDetail {
  request: { id: string; title: string; version: number };
}

async function countByTitle(page: Page, title: string): Promise<number> {
  const res = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(title)}`);
  return res.body.items.filter((x) => x.title === title).length;
}

async function detail(page: Page, id: string): Promise<{ id: string; title: string; version: number }> {
  const res = await callWith<RequestDetail>(page.request, 'GET', `/api/requests/${encodeURIComponent(id)}`);
  return res.body.request;
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.describe('保存に失敗したときの画面', () => {
  test('登録が失敗したら成功を表示せず、入力を残してやり直せる', async ({ page }) => {
    const title = `E2E 保存失敗 登録 ${stamp()}`;
    await open(page);
    await fillRequest(page, title);

    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-500', message: '保存に失敗しました（E2E の故障）' } }),
      });
    });

    await page.click('#pane [data-a="submit"]');

    // 失敗の表示だけが出て、受付スタンプ・成功のトースト・ボードへの移動は起きない。
    await expect(page.locator('#toast')).toContainText('保存に失敗しました（E2E の故障）');
    await expect(page.locator('#toast')).not.toContainText('受け付けました');
    await expect(page.locator('#stamp')).not.toHaveClass(/show/);

    // 入力は残っている（件名はステップ 3 にある）。最後のステップのままでも、もどれば入っている。
    await page.click('#main [data-a="step"][data-v="2"]');
    await expect(page.locator('#stepBody [data-bind="title"]')).toHaveValue(title);

    // サーバには作られていない。
    expect(await countByTitle(page, title)).toBe(0);

    // 故障を解けば、残っていた入力でそのままやり直せる。
    await page.unroute('**/api/requests');
    await page.click('#main [data-a="step"][data-v="6"]');
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => countByTitle(page, title), { timeout: 30_000 }).toBe(1);
  });

  test('編集が失敗したら成功を表示せず、サーバの内容も変えない', async ({ page }) => {
    const before = `E2E 保存失敗 編集前 ${stamp()}`;
    const after = `E2E 保存失敗 編集後 ${stamp()}`;

    await open(page);
    await fillRequest(page, before);
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => countByTitle(page, before), { timeout: 30_000 }).toBe(1);
    const list = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(before)}`);
    const id = list.body.items.find((x) => x.title === before)?.id ?? '';
    expect(id).toMatch(/^REQ-\d{4}-\d{4}$/);

    // 一覧（確認・承認）から編集画面を開く。
    await gotoTab(page, 'review');
    await page.click(`#work .li[data-id="${id}"]`);
    await expect(page.locator('#rin .dp-h')).toContainText(id);
    await page.click(`#rin [data-a="edit"][data-id="${id}"]`);
    await page.waitForSelector('#stepBody');
    await page.click('#main [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', after);
    await page.click('#main [data-a="step"][data-v="6"]');
    await expect(page.locator('#pane [data-a="submit"]')).toContainText('この内容で更新する');

    await page.route('**/api/requests/**', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-500', message: '更新に失敗しました（E2E の故障）' } }),
      });
    });

    await page.click('#pane [data-a="submit"]');

    await expect(page.locator('#toast')).toContainText('更新に失敗しました（E2E の故障）');
    await expect(page.locator('#toast')).not.toContainText('更新しました');
    // サーバは編集前のまま（版も上がらない）。
    const unchanged = await detail(page, id);
    expect(unchanged.title).toBe(before);
    expect(unchanged.version).toBe(1);

    // 入力は残っている。もどって確かめ、故障を解いてそのまま更新できる。
    await page.click('#main [data-a="step"][data-v="2"]');
    await expect(page.locator('#stepBody [data-bind="title"]')).toHaveValue(after);
    await page.unroute('**/api/requests/**');
    await page.click('#main [data-a="step"][data-v="6"]');
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => (await detail(page, id)).title, { timeout: 30_000 }).toBe(after);
    expect((await detail(page, id)).version).toBeGreaterThan(1);
  });

  test('送信中の修正を消さず、二重送信もしない', async ({ page }) => {
    const title = `E2E 保存失敗 送信中 ${stamp()}`;
    await open(page);
    await fillRequest(page, title);

    let posts = 0;
    let startedPost: () => void = () => undefined;
    let releasePost: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      startedPost = r;
    });
    const gate = new Promise<void>((r) => {
      releasePost = r;
    });
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      startedPost();
      await gate;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-500', message: '保存に失敗しました（E2E の故障）' } }),
      });
    });

    // 送信を 2 回押しても、サーバへの POST は 1 回だけ。
    await page.click('#pane [data-a="submit"]');
    await started; // 送信が始まったことを確かめてから次の操作をする
    await page.click('#pane [data-a="submit"]');

    // 応答を待つ間に、利用者がステップ 3 へ戻って件名を直す。
    await page.click('#main [data-a="step"][data-v="2"]');
    const edited = `${title}（送信中に修正）`;
    await page.fill('#stepBody [data-bind="title"]', edited);
    releasePost();

    await expect(page.locator('#toast')).toContainText('保存に失敗しました（E2E の故障）');
    expect(posts).toBe(1);
    // 送信前のスナップショットへ戻さず、送信中に直した内容を残す。
    await expect(page.locator('#stepBody [data-bind="title"]')).toHaveValue(edited);
    expect(await countByTitle(page, edited)).toBe(0);
  });

  test('応答が失われても、やり直しは同じ冪等キーで行い、二重に登録しない', async ({ page }) => {
    const title = `E2E 保存失敗 応答喪失 ${stamp()}`;
    const fixed = `${title}（直した件名）`;
    await open(page);
    await fillRequest(page, title);

    const keys: string[] = [];
    const bodies: { title?: string }[] = [];
    let posts = 0;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      keys.push(String(route.request().headers()['idempotency-key'] ?? ''));
      bodies.push(route.request().postDataJSON() as { title?: string });
      if (posts === 1) {
        // サーバには届く（作成される）が、応答を落とす。
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      return route.continue();
    });

    await page.click('#pane [data-a="submit"]');
    // 応答が落ちたことを待ってから次へ進む（送信中に押して無視された、で通らないようにする）。
    await expect(page.locator('#toast')).toContainText('通信できませんでした');
    await expect.poll(async () => page.evaluate(() => Boolean((window as unknown as { __SF?: { S?: { submitting?: boolean } } }).__SF?.S?.submitting))).toBe(false);
    expect(await countByTitle(page, title)).toBe(1);

    // 内容を直してから、やり直す。作成の本文は初回のままで、直した内容は PATCH で送られる。
    await page.click('#main [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', fixed);
    await page.click('#main [data-a="step"][data-v="6"]');
    await page.click('#pane [data-a="submit"]');

    await expect.poll(async () => await countByTitle(page, fixed), { timeout: 30_000 }).toBe(1);
    expect(posts).toBe(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]); // 同じ冪等キーで照合している
    expect(bodies[0]?.title).toBe(title); // 初回の本文（スナップショット）
    expect(bodies[1]).toEqual(bodies[0]); // 再試行も同じ本文（直した内容は PATCH）
    expect(await countByTitle(page, title)).toBe(0);
    await page.unroute('**/api/requests');
  });

  test('競合（409）で取り直した最新を、失敗の巻き戻しで上書きしない', async ({ page }) => {
    const before = `E2E 競合 前 ${stamp()}`;
    const after = `E2E 競合 後 ${stamp()}`;
    await open(page);
    await fillRequest(page, before);
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => countByTitle(page, before), { timeout: 30_000 }).toBe(1);
    const list = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(before)}`);
    const id = list.body.items.find((x) => x.title === before)?.id ?? '';

    // 画面で編集を開き、件名を変える（まだ送らない）。
    await gotoTab(page, 'review');
    await page.click(`#work .li[data-id="${id}"]`);
    await expect(page.locator('#rin .dp-h')).toContainText(id);
    await page.click(`#rin [data-a="edit"][data-id="${id}"]`);
    await page.waitForSelector('#stepBody');
    await page.click('#main [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', after);
    await page.click('#main [data-a="step"][data-v="6"]');

    // 画面が見ている版を古くする（別の操作でサーバの版だけ進める）。
    // 状態変更は受付担当の操作。共有セッションの役割を確かめる。
    expect((await me(page)).actingRole).toBe('desk');
    const current = await detail(page, id);
    const moved = await callWith(page.request, 'POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
      to: 'review',
      version: current.version,
    });
    expect(moved.status).toBe(200);

    await page.click('#pane [data-a="submit"]');

    await expect(page.locator('#toast')).toContainText('他の人が先に更新しました');
    // サーバは編集前のまま。画面の一覧も、取り直した最新（編集前）に戻る（古い写しを戻さない）。
    expect((await detail(page, id)).title).toBe(before);
    // 画面の一覧は「取り直した最新」（状態 review・版 2）になっている。
    // 古い写し（状態 received・版 1）へ戻していたら、ここで落ちる。
    await expect
      .poll(
        async () =>
          page.evaluate((reqId) => {
            const w = window as unknown as {
              __SF?: { S: { data: { items: { id: string; title: string; status: string; __v: number }[] } } };
            };
            const it = w.__SF?.S.data.items.find((x) => x.id === reqId);
            return it ? { title: it.title, status: it.status, v: it.__v } : null;
          }, id),
        { timeout: 15_000 },
      )
      .toEqual({ title: before, status: 'review', v: 2 });
    // 利用者の入力は残っている（やり直せる）。
    await page.click('#main [data-a="step"][data-v="2"]');
    await expect(page.locator('#stepBody [data-bind="title"]')).toHaveValue(after);
  });

  test('作成が 4xx で拒否されたら、直した内容で送り直せる（古い本文を送り続けない）', async ({ page }) => {
    const title = `E2E 保存失敗 拒否 ${stamp()}`;
    const fixed = `${title} 修正`;
    await open(page);
    await fillRequest(page, title);

    const bodies: { title?: string }[] = [];
    let first = true;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON() as { title?: string });
      if (first) {
        first = false;
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ERR-102', message: '件名が長すぎます（E2E の故障）' } }),
        });
      }
      return route.continue();
    });

    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#toast')).toContainText('件名が長すぎます');
    expect(await countByTitle(page, title)).toBe(0);

    // 直して送り直す。サーバに依頼は無いので、作成はやり直し（古い本文を再送しない）。
    await page.click('#main [data-a="step"][data-v="2"]');
    await page.fill('#stepBody [data-bind="title"]', fixed);
    await page.click('#main [data-a="step"][data-v="6"]');
    await page.click('#pane [data-a="submit"]');

    await expect.poll(async () => await countByTitle(page, fixed), { timeout: 30_000 }).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.title).toBe(fixed);
    await page.unroute('**/api/requests');
  });

  test('応答喪失後の再試行が 4xx でも、作成済みの依頼を二重に作らない', async ({ page }) => {
    const title = `E2E 保存失敗 再試行4xx ${stamp()}`;
    await open(page);
    await fillRequest(page, title);

    const keys: string[] = [];
    let posts = 0;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      keys.push(String(route.request().headers()['idempotency-key'] ?? ''));
      if (posts === 1) {
        await route.fetch();
        await route.abort('connectionreset'); // サーバには作成されるが応答を落とす
        return;
      }
      if (posts === 2) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ERR-429', message: '混雑しています（E2E の故障）' } }),
        });
      }
      return route.continue();
    });

    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#toast')).toContainText('通信できませんでした');
    await expect.poll(async () => page.evaluate(() => Boolean((window as unknown as { __SF?: { S?: { submitting?: boolean } } }).__SF?.S?.submitting))).toBe(false);
    expect(await countByTitle(page, title)).toBe(1);

    // 再試行は 429。ここで冪等キーを捨てると、次の再試行で二重に作ってしまう。
    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#toast')).toContainText('混雑しています（E2E の故障）');

    // 3 回目は同じキーで照合し、作成済みの依頼に合流する（増えない）。
    await page.click('#pane [data-a="submit"]');
    await expect.poll(async () => await countByTitle(page, title), { timeout: 30_000 }).toBe(1);
    expect(posts).toBe(3);
    expect(keys[2]).toBe(keys[0]);
    await page.unroute('**/api/requests');
  });

  test('作成済みの依頼が更新されていたら、二重に作らず最新を開く', async ({ page }) => {
    const title = `E2E 保存失敗 作成済み更新 ${stamp()}`;
    await open(page);
    await fillRequest(page, title);

    let posts = 0;
    await page.route('**/api/requests', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 1) {
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      return route.continue();
    });

    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#toast')).toContainText('通信できませんでした');
    await expect.poll(async () => page.evaluate(() => Boolean((window as unknown as { __SF?: { S?: { submitting?: boolean } } }).__SF?.S?.submitting))).toBe(false);
    const list = await callWith<RequestList>(page.request, 'GET', `/api/requests?q=${encodeURIComponent(title)}`);
    const id = list.body.items.find((x) => x.title === title)?.id ?? '';
    expect(id).toMatch(/^REQ-\d{4}-\d{4}$/);

    // 別の操作で、作成済みの依頼を更新しておく（冪等照合のときに「触られている」状態にする）。
    const current = await detail(page, id);
    const moved = await callWith(page.request, 'POST', `/api/requests/${encodeURIComponent(id)}/transitions`, {
      to: 'review',
      version: current.version,
    });
    expect(moved.status).toBe(200);

    // 再試行は「作成済みだが更新されている」と判定される。二重に作らず、最新を開く。
    await page.click('#pane [data-a="submit"]');
    await expect(page.locator('#toast')).toContainText('作成済み');
    expect(await countByTitle(page, title)).toBe(1);
    const state = await page.evaluate((reqId) => {
      const w = window as unknown as {
        __SF?: { S: { draft: unknown; data: { items: { id: string }[] } } };
      };
      return {
        draft: Boolean(w.__SF?.S.draft),
        adopted: Boolean(w.__SF?.S.data.items.some((x) => x.id === reqId)),
      };
    }, id);
    expect(state).toEqual({ draft: false, adopted: true });
    await page.unroute('**/api/requests');
  });
});
