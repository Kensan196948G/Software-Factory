import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * UI 保存（bridge.persist と submit）の結果待ちと、再提出の本文保存の試験。
 * 作り物のデータだけを使う。API の失敗は page.route で返す。
 */

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

type Detail = { id: string; title: string; status: string; version: number; problem: string; comments: unknown[] };

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('button[data-v="home"]');
  await setApiRole(page, 'requester');
  await resetDrafts(page);
  await page.reload();
  await page.waitForSelector('button[data-v="home"]');
}

async function callApi<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, p, b]) => {
      const msf = (window as unknown as { __MSF__: { api: (m: string, p: string, b?: unknown) => Promise<unknown> } }).__MSF__;
      return msf.api(m as string, p as string, b ?? undefined);
    },
    [method, path, body] as const,
  ) as Promise<T>;
}

async function resetDrafts(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* localStorage が使えない環境では何もしない */
    }
  });
  await callApi(page, 'DELETE', '/api/drafts');
}

async function setApiRole(page: Page, role: string): Promise<void> {
  await callApi(page, 'POST', '/api/auth/role', { role });
}

async function setUiRole(page: Page, role: string): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(300);
}

async function clickText(page: Page, text: string, exact = true): Promise<void> {
  const clicked = await page.evaluate(
    ([t, ex]) => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        ex ? x.textContent!.trim() === t : x.textContent!.includes(t as string),
      );
      if (!b) return false;
      b.click();
      return true;
    },
    [text, exact] as const,
  );
  if (!clicked) throw new Error(`ボタンがありません: ${text}`);
}

async function setValue(page: Page, selector: string, index: number, value: string): Promise<void> {
  await page.evaluate(
    ([sel, idx, v]) => {
      const el = document.querySelectorAll(sel as string)[idx as number] as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) throw new Error(`要素がありません: ${sel}[${idx}]`);
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [selector, index, value] as const,
  );
}

async function nextStep(page: Page): Promise<void> {
  await clickText(page, 'つぎへ');
  await page.waitForTimeout(150);
}

/** 新規登録のウィザードを、最後の確認画面（「この内容で受け付ける」）まで進める */
async function fillWizard(page: Page, title: string): Promise<void> {
  await clickText(page, '新しい依頼');
  await page.waitForTimeout(150);
  await clickText(page, '新しい道具がほしい', false);
  await nextStep(page);
  await clickText(page, '現場の担当者');
  await clickText(page, '事務所');
  await nextStep(page);
  await setValue(page, 'main input[type=text]', 0, title);
  await setValue(page, 'main textarea', 0, 'E2E の困りごと（作り物）');
  await setValue(page, 'main textarea', 1, 'E2E の目的（作り物）');
  await nextStep(page);
  await setValue(page, 'main textarea', 0, '作るもの（作り物）');
  await setValue(page, 'main textarea', 1, '作らないもの（作り物）');
  await nextStep(page);
  await setValue(page, 'main input[type=text]', 0, '再読み込みしても残る');
  await nextStep(page);
  await clickText(page, '青記録・整理・検索・お知らせ', false);
  await nextStep(page);
  await expect(page.locator('#submit')).toBeVisible();
}

function inputOf(title: string): Record<string, unknown> {
  return {
    title,
    kind: 'new_tool',
    deptCode: 'keiei',
    applicant: 'E2E 起票者',
    contact: null,
    toolId: null,
    problem: 'E2E の困りごと（作り物）',
    purpose: 'E2E の目的（作り物）',
    users: ['現場の担当者'],
    people: null,
    places: ['事務所'],
    scope: ['作るもの（作り物）'],
    outOfScope: ['作らないもの（作り物）'],
    criteria: ['再読み込みしても残る'],
    decides: 'g',
    dataHandling: [],
    parties: 'internal',
    constraints: [],
    constraintsOther: [],
    approvals: [],
    frequency: null,
    minutesPerTime: null,
    dataReady: null,
    spread: null,
    wishDate: null,
  };
}

/** UI の起票で依頼を作り、一覧の確定（サーバ保存）まで待って詳細を返す */
async function createViaUi(page: Page, title: string): Promise<Detail> {
  await fillWizard(page, title);
  await page.locator('#submit').click();
  await expect.poll(() => findByTitle(page, title).then((r) => r?.id ?? null), { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator('#stamp')).not.toHaveClass(/show/, { timeout: 10_000 });
  return (await findByTitle(page, title))!;
}

async function listRequests(page: Page): Promise<Detail[]> {
  const res = await callApi<{ items: Detail[] }>(page, 'GET', '/api/requests?pageSize=200&sort=updated');
  return res.items;
}

async function findByTitle(page: Page, title: string): Promise<Detail | undefined> {
  const hit = (await listRequests(page)).find((r) => r.title === title);
  return hit ? getDetail(page, hit.id) : undefined;
}

async function getDetail(page: Page, id: string): Promise<Detail> {
  return (await callApi<{ request: Detail }>(page, 'GET', `/api/requests/${id}`)).request;
}

async function transition(page: Page, id: string, to: string, extra: Record<string, unknown> = {}): Promise<Detail> {
  const cur = await getDetail(page, id);
  const res = await callApi<{ detail: Detail }>(page, 'POST', `/api/requests/${id}/transitions`, {
    to,
    version: cur.version,
    checklistAcknowledged: true,
    redAcknowledged: true,
    ...extra,
  });
  return res.detail;
}

function localItem(page: Page, id: string): Promise<{ id: string; title: string; status: string; comments: unknown[] } | null> {
  return page.evaluate(
    (rid) =>
      (window as unknown as { __MSF_UI__: { data: () => { items: { id: string }[] } } }).__MSF_UI__
        .data()
        .items.find((x) => x.id === rid) as never,
    id,
  );
}

async function openDrawer(page: Page, title: string): Promise<void> {
  await page.click('button[data-v="list"]');
  await page.waitForTimeout(200);
  await page.locator(`tr:has-text("${title}")`).first().click();
  await expect(page.locator('#drawer')).toHaveClass(/show/);
}

/** 詳細の「編集」からウィザードの最終段階へ移動する */
async function openEditAtLastStep(page: Page, title: string): Promise<void> {
  await openDrawer(page, title);
  const fix = page.locator('#tfix');
  if (await fix.count()) await fix.click();
  else await page.locator('#ded').click();
  // 3段階目（件名）へ
  await page.locator('.stp').nth(2).click();
  await expect(page.locator('main input[type=text]').first()).toBeVisible();
}

async function gotoLastStep(page: Page): Promise<void> {
  await page.locator('.stp').last().click();
  await expect(page.locator('#submit')).toBeVisible();
}

/** 指定の method + path に一度 500 を返す。route を外すまで何度でも失敗させる。 */
async function failRoute(page: Page, method: string, pattern: string | RegExp, status = 500): Promise<() => number> {
  let hits = 0;
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    hits += 1;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: status === 409 ? 'ERR-301' : 'ERR-401',
          message: status === 409 ? 'ほかの人が先に更新しました（最新を表示します）' : '処理を完了できませんでした',
        },
      }),
    });
  });
  return () => hits;
}

function countRequests(page: Page, method: string, pattern: RegExp): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() === method && pattern.test(new URL(r.url()).pathname)) n += 1;
  });
  return () => n;
}

const REQUESTS = /\/api\/requests$/;
const ONE_REQUEST = /\/api\/requests\/REQ-\d{4}-\d{4}$/;
const TRANSITIONS = /\/api\/requests\/REQ-\d{4}-\d{4}\/transitions$/;
const COMMENTS = /\/api\/requests\/REQ-\d{4}-\d{4}\/comments$/;

test.describe('UI 保存の結果待ち', () => {
  test('bridge.persist は結果を返す（reject しない）。同期中の呼び出しは次の同期にまとまる', async ({ page }) => {
    await login(page);
    const created = await createViaUi(page, `persist API ${Date.now()}`);

    await failRoute(page, 'POST', COMMENTS);
    const failed = await page.evaluate(async (id) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<unknown> };
        __MSF_UI__: { data: () => { items: { id: string; comments: unknown[] }[] } };
      };
      const data = w.__MSF_UI__.data();
      data.items.find((x) => x.id === id)!.comments.push({ at: new Date().toISOString(), by: 'E2E', text: '失敗するコメント' });
      return w.__MSF__.persist(data);
    }, created.id);
    expect(failed).toMatchObject({ ok: false, code: 'ERR-401', status: 500 });
    expect(typeof (failed as { error: string }).error).toBe('string');
    await page.unroute(COMMENTS);

    // 失敗した変更は残らない（次の persist で再送されない）
    expect((await localItem(page, created.id))!.comments).toHaveLength(0);
    const sent = countRequests(page, 'POST', COMMENTS);

    // 同期中に 2 回呼ぶと、後から呼んだ 2 件は同じ次の同期で反映される
    const results = await page.evaluate(async (id) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<{ ok: boolean }> };
        __MSF_UI__: { data: () => { items: { id: string; comments: unknown[] }[] } };
      };
      const data = w.__MSF_UI__.data();
      const it = data.items.find((x) => x.id === id)!;
      const push = (text: string) => it.comments.push({ at: new Date().toISOString(), by: 'E2E', text });
      push('一つ目');
      const a = w.__MSF__.persist(data);
      push('二つ目');
      const b = w.__MSF__.persist(data);
      push('三つ目');
      const c = w.__MSF__.persist(data);
      return Promise.all([a, b, c]);
    }, created.id);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(sent()).toBe(3);
    const detail = await getDetail(page, created.id);
    expect((detail.comments as { text: string }[]).map((c) => c.text)).toEqual(['一つ目', '二つ目', '三つ目']);
  });

  test('新規登録: 失敗したら成功表示を出さず入力を保持し、再送で成功して下書きが消える', async ({ page }) => {
    await login(page);
    const title = `新規失敗 ${Date.now()}`;
    await fillWizard(page, title);
    const before = await page.evaluate(
      () => (window as unknown as { __MSF_UI__: { data: () => { items: unknown[] } } }).__MSF_UI__.data().items.length,
    );

    // 入力の下書きがサーバに保存されるまで待つ
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(1);

    const hits = await failRoute(page, 'POST', REQUESTS);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);

    await expect(page.locator('#toast .toast.ng')).toContainText('処理を完了できませんでした');
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.waitForTimeout(500);
    await expect(page.locator('#stamp')).not.toHaveClass(/show/);
    await expect(page.locator('#toast')).not.toContainText('受け付けました');
    // ウィザードに留まり、失敗した依頼はローカルに残らない
    await expect(page.locator('#submit')).toBeVisible();
    await expect(page.locator('#submit')).toBeEnabled();
    expect(
      await page.evaluate(
        () => (window as unknown as { __MSF_UI__: { data: () => { items: unknown[] } } }).__MSF_UI__.data().items.length,
      ),
    ).toBe(before);
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(title);
    expect((await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items).toHaveLength(1);
    expect(await findByTitle(page, title)).toBeUndefined();

    // 再送で成功する
    await page.unroute(REQUESTS);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    await expect(page.locator('#toast')).toContainText('受け付けました', { timeout: 5000 });
    const saved = await findByTitle(page, title);
    expect(saved?.status).toBe('received');
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(0);
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await expect(page.getByText('書きかけの依頼があります')).toHaveCount(0);
  });

  test('新規登録: 受付番号はサーバが返した値を表示し、他の依頼を壊さない', async ({ page }) => {
    await login(page);
    const title = `番号衝突 ${Date.now()}`;
    await fillWizard(page, title);

    // 画面を開いたあとに別の端末が番号を取った状態を作る（画面のローカル採番と衝突する）
    const seqBefore = await page.evaluate(
      () => (window as unknown as { __MSF_UI__: { data: () => { seq: number } } }).__MSF_UI__.data().seq,
    );
    const other = (
      await callApi<{ request: Detail }>(page, 'POST', '/api/requests', {
        ...inputOf(`別端末の依頼 ${Date.now()}`),
        approver: '鈴木 一郎',
        clientId: `REQ-${new Date().getFullYear()}-${String(seqBefore + 1).padStart(4, '0')}`,
      })
    ).request;
    expect(other.id).toBe(`REQ-${new Date().getFullYear()}-${String(seqBefore + 1).padStart(4, '0')}`);

    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    const saved = await findByTitle(page, title);
    expect(saved).toBeDefined();
    expect(saved!.id).not.toBe(other.id);
    await expect(page.locator('#stampNo')).toHaveText(saved!.id);
    await expect(page.locator('#toast')).toContainText(`受け付けました（${saved!.id}）`, { timeout: 5000 });

    // ローカルの依頼も番号がサーバに揃い、別端末の依頼は取消されない
    expect((await localItem(page, saved!.id))?.title).toBe(title);
    await page.waitForTimeout(500);
    expect((await getDetail(page, other.id)).status).toBe('received');
    expect((await getDetail(page, other.id)).title).toContain('別端末の依頼');
    expect((await getDetail(page, saved!.id)).status).toBe('received');
  });

  test('二重クリックしても依頼は 1 件だけ作られる', async ({ page }) => {
    await login(page);
    const title = `二重クリック ${Date.now()}`;
    await fillWizard(page, title);
    const posts = countRequests(page, 'POST', REQUESTS);
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.locator('#submit').dblclick();
    // 送信中はボタンが押せない
    await expect(page.locator('#submit')).toBeDisabled();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    await page.unroute(REQUESTS);
    expect(posts()).toBe(1);
    const same = (await listRequests(page)).filter((r) => r.title === title);
    expect(same).toHaveLength(1);
  });

  test('編集の保存失敗: 成功表示を出さず入力を残し、再送で成功して下書きが消える', async ({ page }) => {
    await login(page);
    const title = `編集失敗 ${Date.now()}`;
    const created = await createViaUi(page, title);
    const edited = `${title} 編集後`;

    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, edited);
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(1);
    await gotoLastStep(page);

    const hits = await failRoute(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.waitForTimeout(400);
    await expect(page.locator('#toast')).not.toContainText('を更新しました');
    await expect(page.locator('#submit')).toBeVisible();
    // 楽観更新は戻り、入力（下書き）は残る
    expect((await localItem(page, created.id))?.title).toBe(title);
    expect((await getDetail(page, created.id)).title).toBe(title);
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(edited);
    expect((await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items).toHaveLength(1);

    await page.unroute(ONE_REQUEST);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect((await getDetail(page, created.id)).title).toBe(edited);
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(0);
  });

  test('差戻し → 直して再提出 → 再読込: 本文と状態（受付）が残る', async ({ page }) => {
    await login(page);
    const title = `再提出 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'back', { reason: '直してください（作り物）' });
    await setApiRole(page, 'requester');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');

    const edited = `${title} 直した`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, edited);
    await setValue(page, 'main textarea', 0, '直した困りごと（作り物）');
    await gotoLastStep(page);
    await expect(page.locator('#submit')).toContainText('直した内容で再提出する');
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('を直して再提出しました');

    const api = await getDetail(page, created.id);
    expect(api.title).toBe(edited);
    expect(api.problem).toBe('直した困りごと（作り物）');
    expect(api.status).toBe('received');

    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await page.click('button[data-v="list"]');
    const row = page.locator(`tr:has-text("${edited}")`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('受付');
  });

  test('再提出の途中失敗（PATCH 成功・遷移失敗）: 進んだ版を保持し、再送で 409 にならず成功する', async ({ page }) => {
    await login(page);
    const title = `途中失敗 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'back', { reason: '直してください（作り物）' });
    await setApiRole(page, 'requester');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');

    const edited = `${title} 直した`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, edited);
    await gotoLastStep(page);
    const hits = await failRoute(page, 'POST', TRANSITIONS);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await expect(page.locator('#submit')).toBeVisible();

    // サーバは本文だけ進み、状態は差戻しのまま
    const mid = await getDetail(page, created.id);
    expect(mid.title).toBe(edited);
    expect(mid.status).toBe('back');
    expect((await localItem(page, created.id))?.status).toBe('back');
    expect((await localItem(page, created.id))?.title).toBe(edited);

    await page.unroute(TRANSITIONS);
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('を直して再提出しました');
    const done = await getDetail(page, created.id);
    expect(done.status).toBe('received');
    expect(done.title).toBe(edited);
  });

  test('承認済みの依頼を編集: サーバが承認待ちへ戻したら画面に反映し、再承認しない', async ({ page }) => {
    await login(page);
    const title = `承認後編集 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await transition(page, created.id, 'wait');
    await setApiRole(page, 'approver');
    await transition(page, created.id, 'approved', { signal: 'g' });
    await setApiRole(page, 'desk');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');

    const transitions = countRequests(page, 'POST', TRANSITIONS);
    const edited = `${title} 変更`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, edited);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('承認をやり直す必要があります');
    await expect(page.locator('#toast')).toContainText('を更新しました');

    const api = await getDetail(page, created.id);
    expect(api.status).toBe('wait');
    expect(api.title).toBe(edited);
    expect(transitions()).toBe(0);
    expect((await localItem(page, created.id))?.status).toBe('wait');
    await expect(page.locator('#drawer')).toContainText('承認待ち');

    // base の版も進んでいる（続けて編集しても 409 にならない）
    await page.locator('#ded').click();
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, `${edited} 再`);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    // 1 回目の成功表示がまだ残っている場合があるので、API の結果で待つ
    await expect.poll(async () => (await getDetail(page, created.id)).title).toBe(`${edited} 再`);
    await expect(page.locator('#err')).toHaveCount(0);
  });

  test('409（他の人が更新）: 入力を保持して最新を取り直し、自動で上書き再送しない', async ({ page }) => {
    await login(page);
    const title = `競合 ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 自分の編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await gotoLastStep(page);

    // 別の人が先に更新（画面の持つ base は古くなる）
    const theirs = `${title} 別の人の編集`;
    const cur = await getDetail(page, created.id);
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(theirs),
      approver: '鈴木 一郎',
      version: cur.version,
    });

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('他の人');
    await page.waitForTimeout(800);
    expect(patches()).toBe(1);
    expect((await getDetail(page, created.id)).title).toBe(theirs);
    expect((await localItem(page, created.id))?.title).toBe(theirs);
    await expect(page.locator('#toast')).not.toContainText('を更新しました');
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(mine);
    expect((await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items).toHaveLength(1);

    // 利用者が改めて送れば、最新の版に対する更新として通る
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect((await getDetail(page, created.id)).title).toBe(mine);
    expect(patches()).toBe(2);
  });

  test('状態変更ダイアログ: ERR-201 の 409 はサーバの理由を表示する（他の人の更新と誤表示しない）', async ({ page }) => {
    await login(page);
    const title = `権限拒否 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'desk');
    await openDrawer(page, title);

    await page.locator('#dst').click();
    const modal = page.locator('#modal');
    await modal.locator('input[name=ns][value=back]').check({ force: true });
    await modal.locator('#nnote').fill('直してください（作り物）');

    await page.route(TRANSITIONS, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'ERR-201', message: 'この依頼の承認者ではありません' } }),
          })
        : route.fallback(),
    );
    await modal.locator('#sok').click();
    await expect(page.locator('#toast .toast.ng')).toContainText('この依頼の承認者ではありません');
    await expect(page.locator('#toast')).not.toContainText('他の人');
    expect((await localItem(page, created.id))?.status).toBe('review');
  });

  test('利用者の声→依頼: 入力画面へ渡し、受付の成功後だけ運用データへ結び付ける', async ({ page }) => {
    await login(page);
    await setUiRole(page, 'desk');
    const fb = () =>
      page.evaluate(() => {
        const ui = (
          window as unknown as {
            __MSF_UI__: {
              data: () => { ops: { feedback: { id: string; status: string; ref?: string }[] }; items: { id: string }[] };
            };
          }
        ).__MSF_UI__;
        const d = ui.data();
        const f = d.ops.feedback.find((x) => x.status === '未対応');
        return { first: f ? f.id : null, list: d.ops.feedback, count: d.items.length };
      });
    await page.locator('button[data-v="ops"]').click();
    const before = await fb();
    expect(before.first).toBeTruthy();
    const target = before.first as string;
    const act = page.locator(`[data-act="fbreq|${target}"]`);
    await page.locator('[data-vt="otab|fb"]').click();
    await act.click();
    // 依頼は作らず入力画面へ。運用データも変えない
    await expect(page.getByText('新しい道具がほしい').first()).toBeVisible();
    const during = await fb();
    expect(during.count).toBe(before.count);
    expect(during.list.find((x) => x.id === target)?.status).toBe('未対応');
    expect(during.list.find((x) => x.id === target)?.ref).toBeUndefined();

    // 必須項目を書いて受け付けると、はじめて結び付く
    const title = `利用者の声から ${Date.now()}`;
    const created = await createViaUi(page, title);
    await expect.poll(async () => (await fb()).list.find((x) => x.id === target)?.ref ?? null).toBe(created.id);
    expect((await fb()).list.find((x) => x.id === target)?.status).toBe('依頼にした');
  });

  test('利用者の声→依頼: 書きかけの下書きがあれば消さずに案内する', async ({ page }) => {
    await login(page);
    await setUiRole(page, 'desk');
    await clickText(page, '新しい依頼');
    await page.waitForTimeout(150);
    await clickText(page, '新しい道具がほしい', false);
    await nextStep(page);
    await clickText(page, '現場の担当者');
    await nextStep(page);
    const draftTitle = `残す下書き ${Date.now()}`;
    await setValue(page, 'main input[type=text]', 0, draftTitle);
    await expect
      .poll(() => callApi<{ items: { draft?: { title?: string } }[] }>(page, 'GET', '/api/drafts').then((r) => r.items.length))
      .toBeGreaterThan(0);

    await page.locator('button[data-v="ops"]').click();
    await page.locator('[data-vt="otab|fb"]').click();
    await page.locator('[data-act^="fbreq|"]').first().click();
    await expect(page.locator('#toast .toast.ng')).toContainText('書きかけ');
    const drafts = await callApi<{ items: { draft?: { title?: string } }[] }>(page, 'GET', '/api/drafts');
    expect(drafts.items.some((d) => d.draft?.title === draftTitle)).toBe(true);
  });

  test('状態変更ダイアログ: 失敗したら成功表示を出さず状態を戻す。再送で成功する', async ({ page }) => {
    await login(page);
    const title = `ダイアログ ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'desk');
    await openDrawer(page, title);
    const local = await localItem(page, created.id);
    expect(local?.status).toBe('review');

    await page.locator('#dst').click();
    const modal = page.locator('#modal');
    await expect(modal).toContainText('変更する');
    await modal.locator('input[name=ns][value=back]').check({ force: true });
    await modal.locator('#nnote').fill('直してください（作り物）');

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    const hits = await failRoute(page, 'POST', TRANSITIONS, 409);
    await modal.locator('#sok').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#toast .toast.ng')).toContainText('他の人');
    await expect(page.locator('#toast')).not.toContainText('にしました');
    expect((await localItem(page, created.id))?.status).toBe('review');
    expect((await localItem(page, created.id))?.comments).toHaveLength(0);
    // ダイアログは閉じず、メモを保持する
    await expect(modal.locator('#nnote')).toHaveValue('直してください（作り物）');

    await page.unroute(TRANSITIONS);
    await modal.locator('#sok').click();
    await expect(page.locator('#toast')).toContainText('にしました');
    expect((await getDetail(page, created.id)).status).toBe('back');
    // 内容が同じ遷移では PATCH を送らない
    expect(patches()).toBe(0);
    // コメントが二重に作られない
    expect((await getDetail(page, created.id)).comments).toHaveLength(1);
  });

  test('内容が同じ遷移: 承認済みから開発中へ進めても PATCH を送らず、承認を取り消さない', async ({ page }) => {
    await login(page);
    const title = `内容不変の遷移 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await transition(page, created.id, 'wait');
    await setApiRole(page, 'approver');
    await transition(page, created.id, 'approved', { signal: 'g' });
    await setApiRole(page, 'desk');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'desk');

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    await page.click('button[data-v="board"]');
    await page.locator(`button[data-nx="${created.id}"]`).click();
    await expect.poll(async () => (await getDetail(page, created.id)).status).toBe('dev');
    await page.waitForTimeout(300);
    expect(patches()).toBe(0);
    expect((await localItem(page, created.id))?.status).toBe('dev');
  });

  test('コメントの失敗: 依頼を戻し、次の persist で再送しない', async ({ page }) => {
    await login(page);
    const title = `コメント失敗 ${Date.now()}`;
    const created = await createViaUi(page, title);
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await openDrawer(page, title);
    await page.locator('#drawer [data-dt="log"]').click();

    const hits = await failRoute(page, 'POST', COMMENTS);
    await page.evaluate(() => {
      const ctx = document.querySelector('#ctx') as HTMLTextAreaElement | null;
      if (ctx) ctx.value = '失敗するコメント';
      (document.querySelector('#cad') as HTMLButtonElement | null)?.click();
    });
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#toast .toast.ng')).toBeVisible();
    await expect.poll(async () => (await localItem(page, created.id))?.comments.length).toBe(0);
    await page.unroute(COMMENTS);

    const posts = countRequests(page, 'POST', COMMENTS);
    await page.evaluate(() =>
      (
        window as unknown as { __MSF__: { persist: (d: unknown) => Promise<unknown> }; __MSF_UI__: { data: () => unknown } }
      ).__MSF__.persist((window as unknown as { __MSF_UI__: { data: () => unknown } }).__MSF_UI__.data()),
    );
    await page.waitForTimeout(300);
    expect(posts()).toBe(0);
    expect((await getDetail(page, created.id)).comments).toHaveLength(0);
  });
});
