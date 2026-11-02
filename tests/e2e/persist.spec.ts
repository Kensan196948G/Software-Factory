import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * UI 保存（bridge.persist と submit）の結果待ちと、再提出の本文保存の試験。
 * 作り物のデータだけを使う。API の失敗は page.route で返す。
 */

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

type Detail = { id: string; title: string; status: string; version: number; problem: string; comments: unknown[] };

/** 表示されたトーストをすべて記録する（数秒で消えるので、否定の確認は履歴で行う） */
async function recordToasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __toastsSeen?: string[] };
    w.__toastsSeen = [];
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of Array.from(r.addedNodes)) {
          if (node instanceof HTMLElement && node.classList.contains('toast'))
            w.__toastsSeen!.push((node.classList.contains('ng') ? '[ng]' : '') + (node.textContent ?? ''));
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function expectNoToast(page: Page, text: string): Promise<void> {
  const seen = await page.evaluate(() => (window as unknown as { __toastsSeen?: string[] }).__toastsSeen ?? []);
  expect(seen.join('\n')).not.toContain(text);
}

async function login(page: Page): Promise<void> {
  await recordToasts(page);
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

function cancelledAudits(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __MSF_UI__: { data: () => { ops: { audit: { action: string }[] } } } }).__MSF_UI__
        .data()
        .ops.audit.filter((a) => a.action === '状態の変更を取り消した').length,
  );
}

/** 運用データを見本の状態に戻す（未対応の声・未完了の障害を使う試験を、DB の残りに左右されないようにする） */
async function resetOpsData(page: Page): Promise<void> {
  await expect.poll(async () => Boolean((await callApi<{ data: unknown }>(page, 'GET', '/api/ops')).data)).toBe(true);
  await page.evaluate(async () => {
    const w = window as unknown as {
      __MSF_UI__: { data: () => { items: unknown[] } };
      __MSF__: { api: (m: string, p: string, b?: unknown) => Promise<{ version: number }> };
    };
    const cur = await w.__MSF__.api('GET', '/api/ops');
    // SF はコンソールのトップレベル定数（window のプロパティではない）
    // @ts-expect-error 画面のグローバルスコープにある
    const data = SF.seedOps(w.__MSF_UI__.data().items) as unknown;
    await w.__MSF__.api('PUT', '/api/ops', { data, version: cur.version });
  });
  await page.reload();
  await page.waitForSelector('button[data-v="home"]');
}

/** 表示された失敗のトーストを待つ（同期の結果が確定した印） */
async function waitForFailureToast(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const seen = await page.evaluate(() => (window as unknown as { __toastsSeen?: string[] }).__toastsSeen ?? []);
        return seen.some((t) => t.startsWith('[ng]'));
      },
      { timeout: 45_000 },
    )
    .toBe(true);
}

/** 取消の遷移（to: cancel）の回数を数える */
function countCancels(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !TRANSITIONS.test(new URL(r.url()).pathname)) return;
    const body = r.postDataJSON() as { to?: string } | null;
    if (body?.to === 'cancel') n += 1;
  });
  return () => n;
}

/** 既存の依頼がサーバでも画面の一覧でも元のままであること */
async function expectExistingKept(page: Page, existing: Detail): Promise<void> {
  const server = await getDetail(page, existing.id);
  expect(server.status).toBe(existing.status);
  expect(server.title).toBe(existing.title);
  await expect.poll(async () => (await localItem(page, existing.id))?.status).toBe(existing.status);
  await page.click('button[data-v="list"]');
  await expect(page.locator(`tr:has-text("${existing.title}")`)).toHaveCount(1);
}

/** 端末に残っている下書きの件名 */
async function localDraftTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('mirai-const-sf-console-v1-drafts');
    const list = raw ? (JSON.parse(raw) as { draft?: { title?: string } }[]) : [];
    return list.map((o) => o.draft?.title ?? '');
  });
}

async function localCountByTitle(page: Page, title: string): Promise<number> {
  return page.evaluate(
    (t) =>
      (window as unknown as { __MSF_UI__: { data: () => { items: { title: string }[] } } }).__MSF_UI__
        .data()
        .items.filter((x) => x.title === t).length,
    title,
  );
}

/** 希望日の入力欄がある段階へ移動して入力する */
async function setWishDate(page: Page, wish: string): Promise<void> {
  const count = await page.locator('.stp').count();
  for (let i = 0; i < count; i++) {
    await page.locator('.stp').nth(i).click();
    await page.waitForTimeout(100);
    const date = page.locator('main input[type=date]');
    if (await date.count()) {
      await date.first().fill(wish);
      await date.first().dispatchEvent('input');
      await date.first().dispatchEvent('change');
      return;
    }
  }
  throw new Error('希望日の入力欄がありません');
}

type IncidentView = { id: string; status: string; app?: string; req?: string; prevention?: string };

async function incidentOf(page: Page, id: string): Promise<IncidentView> {
  return page.evaluate(
    (iid) =>
      (window as unknown as { __MSF_UI__: { data: () => { ops: { incidents: IncidentView[] } } } }).__MSF_UI__
        .data()
        .ops.incidents.find((x) => x.id === iid) as IncidentView,
    id,
  );
}

/** 未完了の障害を開き、その ID を返す */
async function openableIncident(page: Page): Promise<string> {
  const id = await page.evaluate(
    () =>
      (window as unknown as { __MSF_UI__: { data: () => { ops: { incidents: IncidentView[] } } } }).__MSF_UI__
        .data()
        .ops.incidents.find((x) => x.status !== '完了' && (x.app || x.req))?.id,
  );
  if (!id) throw new Error('未完了の障害がありません');
  await page.locator('button[data-v="ops"]').click();
  await page.locator('[data-vt="otab|inc"]').click();
  await page.locator(`[data-act="incd|${id}"]`).click();
  return id;
}

/** 運用データから渡された入力に、必須項目を書き足して最終段階まで進める */
async function completeOriginDraft(page: Page, title: string): Promise<void> {
  await page.locator('.stp').nth(1).click();
  await page.waitForTimeout(100);
  const applicant = page.locator('main input[type=text]').first();
  if (!(await applicant.inputValue())) await applicant.fill('E2E 起票者');
  await page.locator('.stp').nth(2).click();
  await page.waitForTimeout(100);
  await setValue(page, 'main input[type=text]', 0, title);
  await setValue(page, 'main textarea', 0, 'E2E の困りごと（作り物）');
  await setValue(page, 'main textarea', 1, 'E2E の目的（作り物）');
  await nextStep(page);
  await setValue(page, 'main textarea', 0, '作るもの（作り物）');
  await nextStep(page);
  await setValue(page, 'main input[type=text]', 0, '再読み込みしても残る');
  await nextStep(page);
  await clickText(page, '青記録・整理・検索・お知らせ', false);
  await nextStep(page);
  await expect(page.locator('#submit')).toBeVisible();
}

/** 別の端末が次の番号を先に取った状態を作り、衝突する番号を返す */
async function takeNextLocalId(page: Page): Promise<string> {
  const seq = await page.evaluate(
    () => (window as unknown as { __MSF_UI__: { data: () => { seq: number } } }).__MSF_UI__.data().seq,
  );
  const id = `REQ-${new Date().getFullYear()}-${String(seq + 1).padStart(4, '0')}`;
  const res = await callApi<{ request: Detail }>(page, 'POST', '/api/requests', {
    ...inputOf(`別端末の依頼 ${Date.now()}`),
    approver: '鈴木 一郎',
    clientId: id,
  });
  expect(res.request.id).toBe(id);
  return id;
}

const REQUESTS = /\/api\/requests$/;
const ONE_REQUEST = /\/api\/requests\/REQ-\d{4}-\d{4}$/;
const TRANSITIONS = /\/api\/requests\/REQ-\d{4}-\d{4}\/transitions$/;
const COMMENTS = /\/api\/requests\/REQ-\d{4}-\d{4}\/comments$/;
const APP_500 = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
};

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

    await expect(page.locator('#toast .toast.ng', { hasText: '処理を完了できませんでした' }).first()).toBeVisible();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.waitForTimeout(500);
    expect(await page.locator('#stamp').getAttribute('class')).not.toContain('show');
    await expectNoToast(page, '受け付けました');
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
    await expectNoToast(page, 'を更新しました');
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
    await expectNoToast(page, 'を更新しました');
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(mine);
    expect((await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items).toHaveLength(1);

    // 差分（項目名と両方の値）を画面内に出し、選ぶまで送らない
    const panel = page.locator('#conflict');
    await expect(panel).toContainText('件名');
    await expect(panel).toContainText(theirs);
    await expect(panel).toContainText(mine);
    await gotoLastStep(page);
    await expect(page.locator('#submit')).toBeDisabled();
    await page.waitForTimeout(300);
    expect(patches()).toBe(1);
    expect((await getDetail(page, created.id)).title).toBe(theirs);

    // 「自分の内容で上書きする」を選んだときだけ、最新の版に対して送る
    await page.locator('#cfOverwrite').click();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect((await getDetail(page, created.id)).title).toBe(mine);
    expect(patches()).toBe(2);
  });

  test('409 → 最新を取り込む: 相手の内容を入力へ取り込み、送らず編集を続ける', async ({ page }) => {
    await login(page);
    const title = `競合取り込み ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 自分の編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await gotoLastStep(page);

    const theirs = `${title} 別の人の編集`;
    const cur = await getDetail(page, created.id);
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(theirs),
      approver: '鈴木 一郎',
      version: cur.version,
    });

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toContainText(theirs);
    await page.locator('#cfTake').click();
    await expect(page.locator('#conflict')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(patches()).toBe(1);
    expect((await getDetail(page, created.id)).title).toBe(theirs);
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(theirs);

    // 編集し直して送ると、確認なしで通る（取り込んだ版が基準になる）
    const again = `${theirs} 追記`;
    await setValue(page, 'main input[type=text]', 0, again);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect((await getDetail(page, created.id)).title).toBe(again);
  });

  test('再読込をはさんでも、古い版の下書きで相手の変更を黙って上書きしない', async ({ page }) => {
    await login(page);
    const title = `古い下書き ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 自分の編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await expect
      .poll(async () => {
        const d = await callApi<{ items: { draft?: { title?: string } }[] }>(page, 'GET', '/api/drafts');
        return d.items.some((x) => x.draft?.title === mine);
      })
      .toBe(true);

    const theirs = `${title} 別の人の編集`;
    const cur = await getDetail(page, created.id);
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(theirs),
      approver: '鈴木 一郎',
      version: cur.version,
    });

    // 再読込すると base は最新になる。下書きは古い版のまま
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await page.getByRole('button', { name: '続きから再開' }).click();
    await gotoLastStep(page);
    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toContainText(theirs);
    await page.waitForTimeout(300);
    expect(patches()).toBe(0);
    expect((await getDetail(page, created.id)).title).toBe(theirs);
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
    await expect(page.locator('#toast .toast.ng', { hasText: 'この依頼の承認者ではありません' }).first()).toBeVisible();
    await expectNoToast(page, '他の人');
    expect((await localItem(page, created.id))?.status).toBe('review');
  });

  test('利用者の声→依頼: 入力画面へ渡し、受付の成功後だけ運用データへ結び付ける', async ({ page }) => {
    await login(page);
    await resetOpsData(page);
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
    await resetOpsData(page);
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
    await expect(page.locator('#toast .toast.ng', { hasText: '書きかけ' }).first()).toBeVisible();
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
    await expect(page.locator('#toast .toast.ng', { hasText: '他の人' }).first()).toBeVisible();
    await expectNoToast(page, 'にしました');
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

  test('応答だけ失われた POST: 同じキーの再送で二重登録しない', async ({ page }) => {
    await login(page);
    const title = `応答喪失 ${Date.now()}`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let lost = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (lost) return route.fallback();
      lost = true;
      // サーバまで届けて保存させ、応答だけ捨てる
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    // サーバには 1 件できているが、画面は受付済みと表示しない
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
    expect(await page.locator('#stamp').getAttribute('class')).not.toContain('show');

    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const same = (await listRequests(page)).filter((r) => r.title === title);
    expect(same).toHaveLength(1);
    await expect(page.locator('#stampNo')).toHaveText(same[0]!.id);
    expect(await localCountByTitle(page, title)).toBe(1);
  });

  test('応答喪失 → 再読込 → 下書きから再送しても二重登録しない', async ({ page }) => {
    await login(page);
    const title = `応答喪失再読込 ${Date.now()}`;
    await fillWizard(page, title);
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    await page.unroute(REQUESTS);
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(1);
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await page.getByRole('button', { name: '続きから再開' }).click();
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
  });

  test('POST 成功後の PATCH 失敗 → 再送: 画面にも サーバにも重複を作らない', async ({ page }) => {
    await login(page);
    const title = `途中失敗の新規 ${Date.now()}`;
    await fillWizard(page, title);
    const posts = countRequests(page, 'POST', REQUESTS);
    // サーバの返却と入力に差を作り、POST の直後に PATCH を走らせる
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { request: { title: string } };
      body.request.title = `${body.request.title} サーバ整形`;
      await route.fulfill({ response: res, json: body });
    });
    const hits = await failRoute(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    expect(await page.locator('#stamp').getAttribute('class')).not.toContain('show');
    await page.unroute(REQUESTS);
    await page.unroute(ONE_REQUEST);

    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    const server = (await listRequests(page)).filter((r) => r.title === title);
    expect(server).toHaveLength(1);
    expect(posts()).toBe(1);
    const dup = await page.evaluate(
      (id) =>
        (window as unknown as { __MSF_UI__: { data: () => { items: { id: string }[] } } }).__MSF_UI__
          .data()
          .items.filter((x) => x.id === id).length,
      server[0]!.id,
    );
    expect(dup).toBe(1);
  });

  test('遷移の成功後にコメントだけ失敗: 遷移は成功として反映し、コメントの失敗だけを伝える', async ({ page }) => {
    await login(page);
    const title = `コメントだけ失敗 ${Date.now()}`;
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
    // 遷移の理由とは別のコメントが手元にある状態を作る
    await page.evaluate((id) => {
      const d = (
        window as unknown as { __MSF_UI__: { data: () => { items: { id: string; comments: unknown[] }[] } } }
      ).__MSF_UI__.data();
      d.items.find((x) => x.id === id)!.comments.push({ at: new Date().toISOString(), by: 'E2E', text: '別のコメント' });
    }, created.id);
    const auditsBefore = await cancelledAudits(page);
    const hits = await failRoute(page, 'POST', COMMENTS);
    await modal.locator('#sok').click();
    await expect.poll(hits).toBe(1);

    await expect(page.locator('#toast')).toContainText('にしました');
    await expect(page.locator('#toast .toast.ng', { hasText: 'コメント' }).first()).toBeVisible();
    await expect(page.locator('#mmask')).not.toHaveClass(/show/);
    expect((await getDetail(page, created.id)).status).toBe('back');
    expect((await localItem(page, created.id))?.status).toBe('back');
    // 取り消しの監査を書かない（運用データは試験をまたいで残るので差で見る）
    expect(await cancelledAudits(page)).toBe(auditsBefore);
    await page.unroute(COMMENTS);
  });

  test('ボードの「進める」: 保存の結果を待ってから表示し、失敗後に「元に戻す」を出さない', async ({ page }) => {
    await login(page);
    const title = `進める ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'desk');
    await page.click('button[data-v="board"]');

    // 応答が遅い間は成功を表示しない。失敗したら「元に戻す」も出さない
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(TRANSITIONS, async (route) => {
      await gate;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
      });
    });
    await page.locator(`button[data-nx="${created.id}"]`).click();
    await page.waitForTimeout(300);
    await expectNoToast(page, '進めました');
    release();
    await expect(page.locator('#toast .toast.ng', { hasText: '処理を完了できませんでした' }).first()).toBeVisible();
    await expectNoToast(page, '進めました');
    await expect(page.locator('#toast .tact')).toHaveCount(0);
    expect((await localItem(page, created.id))?.status).toBe('received');
    await page.unroute(TRANSITIONS);

    // 成功すれば「元に戻す」が出る。元に戻す保存が失敗したら「元に戻しました」を出さない
    await page.click('button[data-v="board"]');
    await page.locator(`button[data-nx="${created.id}"]`).click();
    await expect(page.locator('#toast')).toContainText('進めました');
    expect((await getDetail(page, created.id)).status).toBe('review');
    const hits = await failRoute(page, 'POST', TRANSITIONS);
    await page.locator('#toast .tact').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#toast .toast.ng', { hasText: '処理を完了できませんでした' }).first()).toBeVisible();
    await expectNoToast(page, '元に戻しました');
    expect((await localItem(page, created.id))?.status).toBe('review');
  });

  test('サンプルに戻す: 保存に失敗したら成功表示を出さない', async ({ page }) => {
    await login(page);
    const created = await createViaUi(page, `サンプル戻し ${Date.now()}`);
    await failRoute(page, 'POST', REQUESTS);
    await failRoute(page, 'POST', TRANSITIONS);
    await failRoute(page, 'PUT', /\/api\/ops$/);
    await page.click('button[data-v="data"]');
    await page.locator('#dr').click();
    await page.locator('#mmask button:has-text("サンプルに戻す")').last().click();
    await expect(page.locator('#toast .toast.ng').first()).toBeVisible();
    // 件数が多いと失敗の確定まで時間がかかる。依頼が戻るのを待ってから表示履歴を見る
    await expect.poll(async () => (await localItem(page, created.id))?.id, { timeout: 30_000 }).toBe(created.id);
    await expectNoToast(page, 'サンプルデータに戻しました');
  });

  test('JSON の取り込み: 保存に失敗したら成功表示を出さない', async ({ page }) => {
    await login(page);
    const created = await createViaUi(page, `取り込み ${Date.now()}`);
    await failRoute(page, 'POST', REQUESTS);
    await failRoute(page, 'POST', TRANSITIONS);
    await failRoute(page, 'PUT', /\/api\/ops$/);
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: [{ id: 'REQ-2026-9001', title: '取り込みの見本（作り物）' }] })),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await expect(page.locator('#toast .toast.ng').first()).toBeVisible();
    // 件数が多いと失敗の確定まで時間がかかる。依頼が戻るのを待ってから表示履歴を見る
    await expect.poll(async () => (await localItem(page, created.id))?.id, { timeout: 30_000 }).toBe(created.id);
    await expectNoToast(page, '件を取り込みました');
  });

  test('エスカレーション: 接続時は見本の判断を開けず、実依頼の状態を変えない', async ({ page }) => {
    await login(page);
    const title = `エスカレーション ${Date.now()}`;
    const created = await createViaUi(page, title);
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await transition(page, created.id, 'wait');
    await setApiRole(page, 'approver');
    await transition(page, created.id, 'approved', { signal: 'g' });
    await transition(page, created.id, 'dev');
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'approver');
    await page.evaluate((id) => {
      const d = (
        window as unknown as {
          __MSF_UI__: { data: () => { ops: { pipes: Record<string, Record<string, unknown>> } } };
        }
      ).__MSF_UI__.data();
      const p = d.ops.pipes[id] ?? (d.ops.pipes[id] = {});
      Object.assign(p, { step: 6, esc: 'L3', same: 2, fail: 2, total: 2, hours: 1, checks: {}, prItems: [], cost: 0 });
    }, created.id);
    // 接続時は見本のパイプから実依頼の状態を動かさない（開発ライン接続で閉じた経路）
    await page.click('button[data-v="devops"]');
    await expect(page.locator(`[data-act="pipe|${created.id}"]`)).toHaveCount(0);
    await expect(page.locator('#mmask')).not.toHaveClass(/show/);
    expect((await getDetail(page, created.id)).status).toBe('dev');
  });

  for (const wish of ['2026-12-31', '2027-01-01', '2027-01-31', '2027-02-28']) {
    test(`希望日 ${wish}: 受付 → 再読込 → 編集の反復でずれない`, async ({ page }) => {
      await login(page);
      const title = `希望日 ${wish} ${Date.now()}`;
      await fillWizard(page, title);
      await setWishDate(page, wish);
      await gotoLastStep(page);
      await page.locator('#submit').click();
      await expect(page.locator('#stamp')).toHaveClass(/show/);
      await expect(page.locator('#stamp')).not.toHaveClass(/show/, { timeout: 10_000 });
      const created = (await findByTitle(page, title)) as Detail & { wishDate: string };
      expect(created.wishDate).toBe(wish);

      let current = title;
      for (let round = 1; round <= 2; round++) {
        await page.reload();
        await page.waitForSelector('button[data-v="home"]');
        await openEditAtLastStep(page, current);
        current = `${title} 編集${round}`;
        await setValue(page, 'main input[type=text]', 0, current);
        await gotoLastStep(page);
        await page.locator('#submit').click();
        await expect.poll(async () => (await getDetail(page, created.id)).title).toBe(current);
        const after = (await getDetail(page, created.id)) as Detail & { wishDate: string };
        expect(after.wishDate).toBe(wish);
        await expect(page.locator('#submit')).toHaveCount(0);
      }
      await page.reload();
      await page.waitForSelector('button[data-v="home"]');
      await openDrawer(page, current);
      await expect(page.locator('#drawer')).toContainText(wish);
    });
  }

  test('再発防止→依頼: 入力画面へ渡し、受付の成功後だけ結び付く。失敗では結び付かない', async ({ page }) => {
    await login(page);
    await resetOpsData(page);
    await setUiRole(page, 'ops');
    const target = await openableIncident(page);
    await page.locator('#ireq').click();
    await expect(page.locator('#submit, #next').first()).toBeVisible();
    expect((await incidentOf(page, target)).prevention ?? '').not.toContain('REQ-');

    const title = `再発防止から ${Date.now()}`;
    await completeOriginDraft(page, title);
    const hits = await failRoute(page, 'POST', REQUESTS);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    expect((await incidentOf(page, target)).prevention ?? '').not.toContain('REQ-');
    await page.unroute(REQUESTS);

    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    const saved = (await findByTitle(page, title))!;
    await expect.poll(async () => (await incidentOf(page, target)).prevention ?? '').toContain(saved.id);
    // 運用データとしてサーバにも実 ID で残る
    await expect
      .poll(async () => {
        const ops = await callApi<{ data: { incidents: { id: string; prevention: string }[] } }>(page, 'GET', '/api/ops');
        return ops.data.incidents.find((x) => x.id === target)?.prevention ?? '';
      })
      .toContain(saved.id);
  });

  test('再発防止→依頼: サーバが別の番号を振ったら実 ID で結び付く', async ({ page }) => {
    await login(page);
    await resetOpsData(page);
    await setUiRole(page, 'ops');
    const target = await openableIncident(page);
    await page.locator('#ireq').click();
    const title = `再発防止の番号 ${Date.now()}`;
    await completeOriginDraft(page, title);
    const local = await takeNextLocalId(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    const saved = (await findByTitle(page, title))!;
    expect(saved.id).not.toBe(local);
    await expect(page.locator('#stampNo')).toHaveText(saved.id);
    await expect.poll(async () => (await incidentOf(page, target)).prevention ?? '').toContain(saved.id);
    expect((await incidentOf(page, target)).prevention ?? '').not.toContain(local);
  });

  test('利用者の声→依頼: サーバが別の番号を振ったら実 ID で結び付く', async ({ page }) => {
    await login(page);
    await resetOpsData(page);
    await setUiRole(page, 'desk');
    await page.locator('button[data-v="ops"]').click();
    await page.locator('[data-vt="otab|fb"]').click();
    const act = page.locator('[data-act^="fbreq|"]').first();
    const target = ((await act.getAttribute('data-act')) as string).split('|')[1] as string;
    await act.click();
    const title = `利用者の声の番号 ${Date.now()}`;
    await completeOriginDraft(page, title);
    const local = await takeNextLocalId(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    const saved = (await findByTitle(page, title))!;
    expect(saved.id).not.toBe(local);
    const ref = () =>
      page.evaluate(
        (id) =>
          (window as unknown as { __MSF_UI__: { data: () => { ops: { feedback: { id: string; ref?: string }[] } } } }).__MSF_UI__
            .data()
            .ops.feedback.find((x) => x.id === id)?.ref ?? null,
        target,
      );
    await expect.poll(ref).toBe(saved.id);
  });

  test('サーバへ保存できなかった端末の下書きは、新規・運用データ・編集の開始で消えない', async ({ page }) => {
    await login(page);
    await resetOpsData(page);
    const existing = await createViaUi(page, `編集対象 ${Date.now()}`);
    const title = `端末だけの下書き ${Date.now()}`;
    await page.route(/\/api\/drafts(\/.*)?$/, (route) =>
      ['POST', 'PUT'].includes(route.request().method())
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
          })
        : route.fallback(),
    );
    await clickText(page, '新しい依頼');
    await page.waitForTimeout(150);
    const fresh = page.locator('#dfnew');
    if (await fresh.count()) await fresh.click();
    await clickText(page, '新しい道具がほしい', false);
    await nextStep(page);
    await clickText(page, '現場の担当者');
    await nextStep(page);
    await setValue(page, 'main input[type=text]', 0, title);
    await expect.poll(() => localDraftTitles(page)).toContain(title);
    await page.waitForTimeout(800);
    await page.unroute(/\/api\/drafts(\/.*)?$/);

    // サーバに別の下書きがあっても、再読込で消えない
    await callApi(page, 'POST', '/api/drafts', { draft: { title: 'サーバの下書き', criteria: [''] }, step: 0, editId: null });
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    expect(await localDraftTitles(page)).toContain(title);

    // 1) 新規の開始
    await clickText(page, '新しい依頼');
    await page.locator('#dfnew').click();
    await page.waitForTimeout(800);
    expect(await localDraftTitles(page)).toContain(title);

    // 2) 運用データからの開始
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'desk');
    await page.locator('button[data-v="ops"]').click();
    await page.locator('[data-vt="otab|fb"]').click();
    await page.locator('[data-act^="fbreq|"]').first().click();
    await page.waitForTimeout(800);
    expect(await localDraftTitles(page)).toContain(title);

    // 3) 編集の開始
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await setUiRole(page, 'requester');
    await openDrawer(page, existing.title);
    await page.locator('#ded').click();
    await page.waitForTimeout(800);
    expect(await localDraftTitles(page)).toContain(title);

    // 一覧から再開できる
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await clickText(page, '新しい依頼');
    await page.locator(`#modal .drc:has-text("${title}") button`).click();
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(title);
  });

  test('応答喪失のあとに入力を直して再送: 同じキーで照合してから更新し、2 件にしない', async ({ page }) => {
    await login(page);
    const title = `応答喪失の修正 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let lost = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (lost) return route.fallback();
      lost = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');

    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
    const same = all.filter((r) => r.title === fixed);
    expect(same).toHaveLength(1);
    await expect(page.locator('#stampNo')).toHaveText(same[0]!.id);
    expect(await localCountByTitle(page, fixed)).toBe(1);
  });

  test('送信中はほかの画面へ移れない。送信後に下書きが残らない', async ({ page }) => {
    await login(page);
    const title = `送信中の移動 ${Date.now()}`;
    await fillWizard(page, title);
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(1);
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.locator('#submit').click();
    await page.click('button[data-v="home"]');
    await expect(page.locator('#submit')).toBeVisible();
    await expect(page.locator('#toast .toast.ng', { hasText: '送信中' }).first()).toBeVisible();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    await page.unroute(REQUESTS);
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(0);
    expect(await localDraftTitles(page)).not.toContain(title);
  });

  test('遷移の理由に含まれる語のコメントも送られる（部分一致で落とさない）', async ({ page }) => {
    await login(page);
    const title = `部分一致 ${Date.now()}`;
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
    await page.evaluate((id) => {
      const d = (
        window as unknown as { __MSF_UI__: { data: () => { items: { id: string; comments: unknown[] }[] } } }
      ).__MSF_UI__.data();
      d.items.find((x) => x.id === id)!.comments.push({ at: new Date().toISOString(), by: 'E2E', text: '直して' });
    }, created.id);
    await modal.locator('#sok').click();
    await expect(page.locator('#toast')).toContainText('にしました');
    const texts = ((await getDetail(page, created.id)).comments as { text: string }[]).map((c) => c.text).sort();
    expect(texts).toEqual(['直して', '直してください（作り物）'].sort());
  });

  test('JSON の取り込みで一部だけ失敗: 件数を出し、全件成功とは表示しない', async ({ page }) => {
    await login(page);
    const created = await createViaUi(page, `取り込み元 ${Date.now()}`);
    const row = await localItem(page, created.id);
    const stamp = Date.now();
    const okTitle = `取り込み成功 ${stamp}`;
    const ngTitle = `取り込み失敗 ${stamp}`;
    // 受付番号の形にしない（サーバが採番する。DB に残る依頼の番号と重なると更新になるため）
    const rows = [okTitle, ngTitle].map((t, i) => ({ ...row, id: `E2E-${stamp}-${i + 1}`, title: t, comments: [] }));
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as { title: string };
      if (body.title !== ngTitle) return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
      });
    });
    await failRoute(page, 'POST', TRANSITIONS);
    await failRoute(page, 'PUT', /\/api\/ops$/);
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: rows })),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await expect(page.locator('#toast')).toContainText('2 件中 1 件');
    await expectNoToast(page, '2 件を取り込みました');
    expect(await localCountByTitle(page, okTitle)).toBe(1);
    expect(await localCountByTitle(page, ngTitle)).toBe(0);
  });

  test('サンプルに戻す: POST だけ失敗しても既存の依頼を取り消さない（実サーバの遷移）', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `取消しない サンプル ${Date.now()}`);
    await page.waitForTimeout(600); // 受付の監査の PUT を済ませる
    const opsPuts = countRequests(page, 'PUT', /\/api\/ops$/);
    // 受付担当は取消できる（依頼者は取消の遷移を拒否されるので、回帰を検出できない）
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const cancels = countCancels(page);
    await failRoute(page, 'POST', REQUESTS);
    await page.click('button[data-v="data"]');
    await page.locator('#dr').click();
    await page.locator('#mmask button:has-text("サンプルに戻す")').last().click();
    await waitForFailureToast(page);
    await page.waitForTimeout(500);
    expect(cancels()).toBe(0);
    await expectNoToast(page, 'サンプルデータに戻しました');
    await expectExistingKept(page, existing);
    await page.waitForTimeout(600);
    expect(opsPuts()).toBe(0);
  });

  test('JSON の取り込み: POST だけ全件失敗しても既存の依頼を取り消さない（実サーバの遷移）', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `取消しない 全件 ${Date.now()}`);
    // 受付担当は取消できる（依頼者は取消の遷移を拒否されるので、回帰を検出できない）
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const row = await localItem(page, existing.id);
    await page.waitForTimeout(600); // 受付の監査の PUT を済ませる
    const appsBefore = (await callApi<{ data: { apps: unknown[] } }>(page, 'GET', '/api/ops')).data.apps.length;
    const opsPuts = countRequests(page, 'PUT', /\/api\/ops$/);
    const cancels = countCancels(page);
    await failRoute(page, 'POST', REQUESTS);
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ items: [{ ...row, id: `E2E-${Date.now()}-1`, title: '失敗する行（作り物）', comments: [] }] }),
      ),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await waitForFailureToast(page);
    await page.waitForTimeout(500);
    expect(cancels()).toBe(0);
    await expectNoToast(page, '件を取り込みました');
    await expectExistingKept(page, existing);
    // 置き換えをやめたので、運用データは送らない。サーバでも元のまま
    await page.waitForTimeout(600);
    expect(opsPuts()).toBe(0);
    await expect
      .poll(async () => (await callApi<{ data: { apps: unknown[] } }>(page, 'GET', '/api/ops')).data.apps.length)
      .toBe(appsBefore);
  });

  test('JSON の取り込み: 一部の POST だけ失敗: 件数を出し、既存の依頼を取り消さない（実サーバの遷移）', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `取消しない 一部 ${Date.now()}`);
    // 受付担当は取消できる（依頼者は取消の遷移を拒否されるので、回帰を検出できない）
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const row = await localItem(page, existing.id);
    const stamp = Date.now();
    const okTitle = `一部 成功 ${stamp}`;
    const ngTitle = `一部 失敗 ${stamp}`;
    const rows = [okTitle, ngTitle].map((t, i) => ({ ...row, id: `E2E-${stamp}-${i + 1}`, title: t, comments: [] }));
    const cancels = countCancels(page);
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON() as { title: string };
      if (body.title !== ngTitle) return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
      });
    });
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: rows })),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await waitForFailureToast(page);
    await expect(page.locator('#toast')).toContainText('2 件中 1 件');
    await page.waitForTimeout(500);
    expect(cancels()).toBe(0);
    await expectExistingKept(page, existing);
    expect(await localCountByTitle(page, okTitle)).toBe(1);
    expect(await localCountByTitle(page, ngTitle)).toBe(0);
  });

  test('編集の PATCH が失敗した同期でも、画面にない依頼を取り消さない', async ({ page }) => {
    await login(page);
    const stamp = Date.now();
    const kept = await createViaUi(page, `取消しない 残す ${stamp}`);
    const removed = await createViaUi(page, `取消しない 消す ${stamp}`);
    // 受付担当は取消できる（依頼者は取消の遷移を拒否されるので、回帰を検出できない）
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const cancels = countCancels(page);
    await failRoute(page, 'PATCH', ONE_REQUEST);
    const result = await page.evaluate(
      async ([keepId, dropId]) => {
        const w = window as unknown as {
          __MSF__: { persist: (d: unknown) => Promise<{ ok: boolean }> };
          __MSF_UI__: { data: () => { items: { id: string; title: string }[] } };
        };
        const data = w.__MSF_UI__.data();
        data.items.find((x) => x.id === keepId)!.title += ' 変更';
        data.items.splice(
          data.items.findIndex((x) => x.id === dropId),
          1,
        );
        return w.__MSF__.persist(data);
      },
      [kept.id, removed.id] as const,
    );
    expect(result.ok).toBe(false);
    expect(cancels()).toBe(0);
    expect((await getDetail(page, removed.id)).status).toBe(removed.status);
    expect((await localItem(page, removed.id))?.id).toBe(removed.id);
    expect((await localItem(page, kept.id))?.title).toBe(kept.title);
    await page.unroute(ONE_REQUEST);
  });

  test('同期に失敗がなければ、画面から消した依頼は従来どおり取消になる', async ({ page }) => {
    await login(page);
    const removed = await createViaUi(page, `取消する ${Date.now()}`);
    // 受付担当は取消できる（依頼者は取消の遷移を拒否されるので、回帰を検出できない）
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const cancels = countCancels(page);
    const result = await page.evaluate(async (dropId) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<{ ok: boolean }> };
        __MSF_UI__: { data: () => { items: { id: string }[] } };
      };
      const data = w.__MSF_UI__.data();
      data.items.splice(
        data.items.findIndex((x) => x.id === dropId),
        1,
      );
      return w.__MSF__.persist(data);
    }, removed.id);
    expect(result.ok).toBe(true);
    expect(cancels()).toBe(1);
    expect((await getDetail(page, removed.id)).status).toBe('cancel');
  });

  test('照合の再送が 4xx（セッション切れ）でも、確定するまで同じキーのまま。直して再送しても 1 件', async ({ page }) => {
    await login(page);
    const title = `照合 4xx ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let call = 0;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      call += 1;
      if (call === 1) {
        // サーバに保存させて応答だけ捨てる
        await route.fetch();
        return route.abort('connectionreset');
      }
      if (call === 2) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'ERR-101', message: 'ログインし直してください' } }),
        });
      }
      return route.fallback();
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');

    // 照合の再送がセッション切れで失敗する
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('ログインし直してください');

    // 入力を直して送っても、同じキーで照合してから更新する
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
  });

  test('初回の送信が 4xx（確定した拒否）なら、直して再送するときは新しいキーで送る', async ({ page }) => {
    await login(page);
    const title = `初回 4xx ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let call = 0;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      call += 1;
      if (call > 1) return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-001', message: '入力を確かめてください' } }),
      });
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('入力を確かめてください');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect((await listRequests(page)).filter((r) => r.title === fixed)).toHaveLength(1);
  });

  test('部署と道具の不整合（実サーバ）→ 部署を直す → 成功して 1 件', async ({ page }) => {
    await login(page);
    const title = `不整合 ${Date.now()}`;
    await fillWizard(page, title);
    await page.locator('.stp').nth(0).click();
    await clickText(page, 'いまある道具を良くしたい', false);
    await page.locator('[data-pick]').first().click();
    await page.locator('[data-tool]:not([data-tool=""])').first().click();
    await page.locator('.stp').nth(1).click();
    const dept = page.locator('main [data-bind="dept"]');
    const right = await dept.inputValue();
    const wrong = await dept.evaluate(
      (el, cur) => Array.from((el as HTMLSelectElement).options).find((o) => o.value && o.value !== cur)!.value,
      right,
    );
    await dept.selectOption(wrong);
    await gotoLastStep(page);

    const posts = countRequests(page, 'POST', REQUESTS);
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('組み合わせ');
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(0);

    await page.locator('.stp').nth(1).click();
    await page.locator('main [data-bind="dept"]').selectOption(right);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect(posts()).toBe(2);
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
  });

  test('アプリの 500（作られていない）→ 入力を直す → 同じキーで照合して直した内容の 1 件', async ({ page }) => {
    await login(page);
    const title = `500 未確定 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let failed = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (failed) return route.fallback();
      failed = true;
      return route.fulfill(APP_500);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('保存の commit 後の 500 → 入力を直す → 再送しても受付は 1 件', async ({ page }) => {
    await login(page);
    const title = `commit 後の 500 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let failed = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (failed) return route.fallback();
      failed = true;
      await route.fetch(); // サーバには保存される
      return route.fulfill(APP_500);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);

    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(keys[1]).toBe(keys[0]);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('500 が続く間は入力を直しても新しいキーで送らない', async ({ page }) => {
    await login(page);
    const title = `500 が続く ${Date.now()}`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill(APP_500);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, `${title} 直した`);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect.poll(() => keys.length).toBe(2);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    expect(keys[1]).toBe(keys[0]);
    expect(await page.locator('#stamp').getAttribute('class')).not.toContain('show');
  });

  /** POST の応答を失わせ、作られた依頼を他の人の更新で変えておく。入力を直して再送の直前まで進める。 */
  async function lostPostThenOtherEdit(page: Page, title: string, fixed: string): Promise<Detail> {
    await fillWizard(page, title);
    let lost = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.fallback();
      lost = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    const created = (await findByTitle(page, title)) as Detail;
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(title),
      approver: '鈴木 一郎',
      problem: '他の人の修正（作り物）',
      version: created.version,
    });
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    return created;
  }

  test('応答喪失の照合で他の人の更新を見つけたら、選ぶまで PATCH も遷移もしない', async ({ page }) => {
    await login(page);
    const title = `照合で競合 ${Date.now()}`;
    const fixed = `${title} 直した`;
    const created = await lostPostThenOtherEdit(page, title, fixed);
    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    const moves = countRequests(page, 'POST', TRANSITIONS);

    await page.locator('#submit').click();
    const panel = page.locator('#conflict');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(fixed);
    await expect(panel).toContainText('他の人の修正（作り物）');
    await expect(page.locator('#submit')).toBeDisabled();
    await page.waitForTimeout(500);
    expect(patches()).toBe(0);
    expect(moves()).toBe(0);
    expect(await page.locator('#stamp').getAttribute('class')).not.toContain('show');
    const untouched = await getDetail(page, created.id);
    expect(untouched.title).toBe(title);
    expect(untouched.problem).toBe('他の人の修正（作り物）');
    expect(await localCountByTitle(page, untouched.title)).toBe(1);

    // 上書きを選んだときだけ、最新の版に対して 1 回送る
    await page.locator('#cfOverwrite').click();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect(patches()).toBe(1);
    expect((await getDetail(page, created.id)).title).toBe(fixed);
    expect((await listRequests(page)).filter((r) => r.title === title || r.title === fixed)).toHaveLength(1);
  });

  test('照合で差戻しを見つけたら、受付へ戻さず、最新を取り込める', async ({ page }) => {
    await login(page);
    const title = `照合で差戻し ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    let lost = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.fallback();
      lost = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    const created = (await findByTitle(page, title)) as Detail;
    await setApiRole(page, 'desk');
    await transition(page, created.id, 'review');
    await transition(page, created.id, 'back', { reason: '差戻しの理由（作り物）' });
    const moved = await getDetail(page, created.id);
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    const moves = countRequests(page, 'POST', TRANSITIONS);
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toBeVisible();
    await page.waitForTimeout(500);
    expect(patches()).toBe(0);
    expect(moves()).toBe(0);
    const after = await getDetail(page, created.id);
    expect(after.status).toBe('back');
    expect(after.version).toBe(moved.version);

    await page.locator('#cfTake').click();
    await expect(page.locator('#conflict')).toHaveCount(0);
    await expect(page.locator('#toast')).toContainText('最新の内容を取り込みました');
    expect(patches()).toBe(0);
    expect((await getDetail(page, created.id)).status).toBe('back');
  });

  test('作成後の PATCH 失敗 → 他の人の更新 → 再読込 → 再送: 上書きせず競合で止める', async ({ page }) => {
    await login(page);
    const title = `作成後の競合 ${Date.now()}`;
    await fillWizard(page, title);
    // サーバの返却と入力に差を作り、POST の直後に PATCH を走らせる
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { request: { title: string } };
      body.request.title = `${body.request.title} サーバ整形`;
      await route.fulfill({ response: res, json: body });
    });
    const hits = await failRoute(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect.poll(hits).toBe(1);
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.unroute(REQUESTS);
    await page.unroute(ONE_REQUEST);
    const created = (await findByTitle(page, title)) as Detail;
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(title),
      approver: '鈴木 一郎',
      problem: '他の人の修正（作り物）',
      version: created.version,
    });
    await expect.poll(async () => (await callApi<{ items: unknown[] }>(page, 'GET', '/api/drafts')).items.length).toBe(1);
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await page.getByRole('button', { name: '続きから再開' }).click();
    await gotoLastStep(page);

    const patches = countRequests(page, 'PATCH', ONE_REQUEST);
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toBeVisible();
    await page.waitForTimeout(500);
    expect(patches()).toBe(0);
    expect((await getDetail(page, created.id)).problem).toBe('他の人の修正（作り物）');
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
  });

  const CSRF_403 = {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'ERR-101', message: '操作を確認できませんでした' } }),
  };

  test('CSRF の再試行が commit 後に 500 → 入力を直して再送しても受付は 1 件', async ({ page }) => {
    await login(page);
    const title = `CSRF 後の 500 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (keys.length === 1) return route.fulfill(CSRF_403);
      if (keys.length > 2) return route.fallback();
      await route.fetch(); // 再試行はサーバに保存される
      return route.fulfill(APP_500);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(new Set(keys).size).toBe(1);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('CSRF の再試行が ERR-301: 403 と取り違えず競合の画面を出す', async ({ page }) => {
    await login(page);
    const title = `CSRF 後の競合 ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 自分の編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await gotoLastStep(page);
    const theirs = `${title} 別の人の編集`;
    const cur = await getDetail(page, created.id);
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(theirs),
      approver: '鈴木 一郎',
      version: cur.version,
    });
    let first = true;
    await page.route(ONE_REQUEST, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      if (!first) return route.fallback();
      first = false;
      return route.fulfill(CSRF_403);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toBeVisible();
    expect((await getDetail(page, created.id)).title).toBe(theirs);
  });

  test('コメントの失敗: 別の依頼を開いていたら、その依頼の入力欄へ戻さない', async ({ page }) => {
    await login(page);
    const stamp = Date.now();
    const titleA = `コメント元 ${stamp}`;
    const titleB = `コメント別 ${stamp}`;
    await createViaUi(page, titleA);
    await createViaUi(page, titleB);
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    await openDrawer(page, titleA);
    await page.locator('#drawer [data-dt="log"]').click();
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(COMMENTS, async (route) => {
      await held;
      return route.fulfill(APP_500);
    });
    await page.evaluate(() => {
      (document.querySelector('#ctx') as HTMLTextAreaElement).value = 'A へのコメント';
      (document.querySelector('#cad') as HTMLButtonElement).click();
    });
    await page.keyboard.press('Escape');
    await openDrawer(page, titleB);
    await page.locator('#drawer [data-dt="log"]').click();
    release();
    await expect(page.locator('#toast .toast.ng')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('#ctx')).toHaveValue('');
  });

  test('最初の工程では「もどる」を押せない', async ({ page }) => {
    await login(page);
    await page.click('button[data-v="new"]');
    await expect(page.locator('#prev')).toBeDisabled();
  });

  test('JSON の取り込み: コメントだけ失敗しても、取り込み成功とは表示せず既存を取り消さない', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `コメントで不成立 ${Date.now()}`);
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const row = await localItem(page, existing.id);
    const stamp = Date.now();
    const cancels = countCancels(page);
    await failRoute(page, 'POST', COMMENTS);
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          items: [
            {
              ...row,
              id: `E2E-${stamp}-1`,
              title: `コメントつき ${stamp}`,
              comments: [{ at: '2026-11-01T00:00:00.000Z', by: '作り物', text: '作り物のコメント' }],
            },
          ],
        }),
      ),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await waitForFailureToast(page);
    await expect(page.locator('#toast')).toContainText('1 件は登録しましたが');
    await expectNoToast(page, '件を取り込みました');
    await page.waitForTimeout(500);
    expect(cancels()).toBe(0);
    await expectExistingKept(page, existing);
  });

  test('取り込みの成功後、同期の失敗で完了・見送りの依頼を画面へ戻さない', async ({ page }) => {
    await login(page);
    const stamp = Date.now();
    const heldTitle = `見送り済み ${stamp}`;
    const held = await createViaUi(page, heldTitle);
    const keep = await createViaUi(page, `残す依頼 ${stamp}`);
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    await transition(page, held.id, 'hold', { reason: '見送りの理由（作り物）' });
    await page.reload();
    await page.waitForSelector('button[data-v="home"]');
    const row = await localItem(page, keep.id);
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: [row] })),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await expect(page.locator('#toast')).toContainText('件を取り込みました');
    expect(await localCountByTitle(page, heldTitle)).toBe(0);

    await failRoute(page, 'POST', COMMENTS);
    await page.evaluate(async (id) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<unknown> };
        __MSF_UI__: { data: () => { items: { id: string; comments: unknown[] }[] } };
      };
      const data = w.__MSF_UI__.data();
      data.items
        .find((x) => x.id === id)
        ?.comments.push({ at: new Date().toISOString(), by: '作り物', text: '失敗するコメント' });
      await w.__MSF__.persist(data);
    }, keep.id);
    await page.waitForTimeout(300);
    expect(await localCountByTitle(page, heldTitle)).toBe(0);
    expect((await getDetail(page, held.id)).status).toBe('hold');
  });

  test('照合の再送に中継の 4xx（JSON なし）が返っても、新しいキーで送らず 1 件', async ({ page }) => {
    await login(page);
    const title = `中継の 4xx ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      if (keys.length === 1) {
        await route.fetch();
        return route.abort('connectionreset');
      }
      if (keys.length === 2) return route.fulfill({ status: 413, contentType: 'text/html', body: '<html>too large</html>' });
      return route.fallback();
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect.poll(() => keys.length).toBe(2);
    await expect(page.locator('#submit')).toBeEnabled();
    expect(keys[1]).toBe(keys[0]);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(new Set(keys).size).toBe(1);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('コードのない 409 でも競合の画面を出し、次の送信で黙って上書きしない', async ({ page }) => {
    await login(page);
    const title = `コードなし 409 ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 自分の編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await gotoLastStep(page);
    const theirs = `${title} 別の人の編集`;
    const cur = await getDetail(page, created.id);
    await callApi(page, 'PATCH', `/api/requests/${created.id}`, {
      ...inputOf(theirs),
      approver: '鈴木 一郎',
      version: cur.version,
    });
    await page.route(ONE_REQUEST, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 409, contentType: 'text/plain', body: 'conflict' })
        : route.fallback(),
    );
    await page.locator('#submit').click();
    await expect(page.locator('#conflict')).toBeVisible();
    await expect(page.locator('#submit')).toBeDisabled();
    expect((await getDetail(page, created.id)).title).toBe(theirs);
  });

  test('読み込み直しても、操作する人の表示は実際の役割のまま', async ({ page }) => {
    await login(page);
    await setApiRole(page, 'approver');
    await page.reload();
    await expect(page.locator('#role')).toHaveValue('approver');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/auth/role') && r.request().method() === 'POST');
    await page.selectOption('#role', 'desk');
    await saved;
    await page.reload();
    await expect(page.locator('#role')).toHaveValue('desk');
    await setApiRole(page, 'requester');
  });

  test('送信中は役割を切り替えられない', async ({ page }) => {
    await login(page);
    const title = `送信中の役割 ${Date.now()}`;
    await fillWizard(page, title);
    const before = await page.locator('#role').inputValue();
    const other = before === 'desk' ? 'requester' : 'desk';
    const switches = countRequests(page, 'POST', /\/api\/auth\/role$/);
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await held;
      return route.fallback();
    });
    await page.locator('#submit').click();
    await expect(page.locator('#submit')).toBeDisabled();
    await page.locator('#role').selectOption(other);
    await expect(page.locator('#role')).toHaveValue(before);
    expect(switches()).toBe(0);
    release();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
  });

  test('状態変更の保存中はダイアログを閉じられず、失敗したらメモが残る', async ({ page }) => {
    await login(page);
    const title = `保存中のダイアログ ${Date.now()}`;
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
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(TRANSITIONS, async (route) => {
      await held;
      return route.fulfill(APP_500);
    });
    await modal.locator('#sok').click();
    await expect(modal.locator('#sok')).toBeDisabled();
    await page.locator('#mmask').click({ position: { x: 3, y: 3 } });
    await expect(page.locator('#mmask')).toHaveClass(/show/);
    release();
    await expect(page.locator('#toast .toast.ng').first()).toBeVisible();
    await expect(page.locator('#mmask')).toHaveClass(/show/);
    await expect(modal.locator('#nnote')).toHaveValue('直してください（作り物）');
    await expect(modal.locator('#sok')).toBeEnabled();
  });

  async function expectFormLocked(page: Page, locked: boolean): Promise<void> {
    const state = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('#pane');
      const controls = [...(pane?.querySelectorAll<HTMLInputElement>('input,select,textarea') ?? [])];
      return { inert: pane?.inert, total: controls.length, enabled: controls.filter((c) => !c.disabled).length };
    });
    expect(state.total).toBeGreaterThan(0);
    expect(state.inert).toBe(locked);
    if (locked) expect(state.enabled).toBe(0);
    else expect(state.enabled).toBeGreaterThan(0);
  }

  test('新規の送信中は入力全体を止める。失敗したら戻り、入力は残る', async ({ page }) => {
    await login(page);
    const title = `送信中の入力 ${Date.now()}`;
    await fillWizard(page, title);
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    let failed = false;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (failed) return route.fallback();
      failed = true;
      await held;
      return route.fulfill(APP_500);
    });
    await page.locator('#submit').click();
    await expect(page.locator('#submit')).toBeDisabled();
    await expectFormLocked(page, true);
    // 入力欄へ書こうとしても受け付けない
    await expect(page.locator('#pane input, #pane select, #pane textarea').first().fill('x', { timeout: 500 })).rejects.toThrow();
    release();
    await expect(page.locator('#err')).toContainText('処理を完了できませんでした');
    await expectFormLocked(page, false);
    await expect(page.locator('#submit')).toBeEnabled();
    await page.locator('.stp').nth(2).click();
    await expect(page.locator('main input[type=text]').first()).toHaveValue(title);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/);
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
  });

  test('編集の送信中も入力全体を止める。遅れて成功しても失う入力がない', async ({ page }) => {
    await login(page);
    const title = `編集の送信中 ${Date.now()}`;
    const created = await createViaUi(page, title);
    const mine = `${title} 編集`;
    await openEditAtLastStep(page, title);
    await setValue(page, 'main input[type=text]', 0, mine);
    await gotoLastStep(page);
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(ONE_REQUEST, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await held;
      return route.fallback();
    });
    await page.locator('#submit').click();
    await expect(page.locator('#submit')).toBeDisabled();
    await expectFormLocked(page, true);
    release();
    await expect(page.locator('#toast')).toContainText('を更新しました');
    expect((await getDetail(page, created.id)).title).toBe(mine);
  });

  test('通信断の後の照合が 400 → 件名を直す → 成功して 1 件', async ({ page }) => {
    await login(page);
    const title = `照合 400 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let call = 0;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      call += 1;
      const body = route.request().postDataJSON() as { title: string };
      if (call === 1) return route.abort('connectionreset'); // サーバへ届かない
      if (body.title !== title) return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-003', message: '入力の形が正しくありません' } }),
      });
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    // 照合は同じキーと同じ本文で送る
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('入力の形が正しくありません');
    expect(keys[1]).toBe(keys[0]);

    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('入力を直してから送った照合が 400 でも、続けて直した本文で送り 1 件になる', async ({ page }) => {
    await login(page);
    const title = `直してから照合 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    let call = 0;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      call += 1;
      const body = route.request().postDataJSON() as { title: string };
      if (call === 1) return route.abort('connectionreset');
      if (body.title !== title) return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-003', message: '入力の形が正しくありません' } }),
      });
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toContainText('通信できませんでした');
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(call).toBe(3);
    expect((await listRequests(page)).filter((r) => r.title === fixed)).toHaveLength(1);
  });

  test('502（確定した応答なし）は結果不明として扱い、直して送っても 1 件', async ({ page }) => {
    await login(page);
    const title = `502 ${Date.now()}`;
    const fixed = `${title} 直した`;
    await fillWizard(page, title);
    const keys: (string | undefined)[] = [];
    let call = 0;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      keys.push(route.request().headers()['idempotency-key']);
      call += 1;
      if (call > 1) return route.fallback();
      // サーバには保存され、途中の中継が 502 を返した状況
      await route.fetch();
      return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
    });
    await page.locator('#submit').click();
    await expect(page.locator('#err')).toBeVisible();
    await page.locator('.stp').nth(2).click();
    await setValue(page, 'main input[type=text]', 0, fixed);
    await gotoLastStep(page);
    await page.locator('#submit').click();
    await expect(page.locator('#stamp')).toHaveClass(/show/, { timeout: 5000 });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const all = await listRequests(page);
    expect(all.filter((r) => r.title === fixed)).toHaveLength(1);
    expect(all.filter((r) => r.title === title)).toHaveLength(0);
  });

  test('JSON の取り込み: 既存 ID の行が更新済みなら、その件数を伝える', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `更新済み ${Date.now()}`);
    await setApiRole(page, 'desk');
    await setUiRole(page, 'desk');
    const row = await localItem(page, existing.id);
    const stamp = Date.now();
    const changed = `${existing.title} 取り込みで変更`;
    const ngTitle = `更新済み 失敗 ${stamp}`;
    await page.route(REQUESTS, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
      });
    });
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          items: [
            { ...row, title: changed },
            { ...row, id: `E2E-${stamp}-1`, title: ngTitle, comments: [] },
          ],
        }),
      ),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await waitForFailureToast(page);
    await expect(page.locator('#toast')).toContainText('1 件は更新済み');
    await expect(page.locator('#toast')).toContainText('取り消していません');
    expect((await getDetail(page, existing.id)).title).toBe(changed);
    expect((await getDetail(page, existing.id)).status).toBe(existing.status);
  });

  test('JSON の取り込み（全件成功）: 運用データの PUT は依頼の同期の成功後', async ({ page }) => {
    await login(page);
    const existing = await createViaUi(page, `全件成功 ${Date.now()}`);
    await setApiRole(page, 'approver');
    await setUiRole(page, 'approver');
    const row = await localItem(page, existing.id);
    await page.waitForTimeout(600);
    const order: string[] = [];
    page.on('requestfinished', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'POST' && REQUESTS.test(path)) order.push('post');
      if (r.method() === 'POST' && TRANSITIONS.test(path)) order.push('cancel');
    });
    page.on('request', (r) => {
      if (r.method() === 'PUT' && /\/api\/ops$/.test(new URL(r.url()).pathname)) order.push('ops');
    });
    const title = `全件成功の行 ${Date.now()}`;
    await page.click('button[data-v="data"]');
    await page.locator('#importFile').setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: [{ ...row, id: `E2E-${Date.now()}-1`, title, comments: [] }] })),
    });
    await page.locator('#mmask button:has-text("取り込む")').last().click();
    await expect(page.locator('#toast')).toContainText('1 件を取り込みました', { timeout: 45_000 });
    await expect.poll(() => order.includes('ops')).toBe(true);
    const firstOps = order.indexOf('ops');
    expect(order.lastIndexOf('post')).toBeLessThan(firstOps);
    expect(order.lastIndexOf('cancel')).toBeLessThan(firstOps);
    expect((await listRequests(page)).filter((r) => r.title === title)).toHaveLength(1);
    await resetOpsData(page);
  });
});
