import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  FAKE_LOGIN,
  FAKE_REPO,
  FAKE_REPO_ID,
  startFakeGithub,
  type FakeGithub,
  type FakeReply,
} from '../integration/fake-github-server.js';

/**
 * 「開発ラインへ投入」の縦断試験（実ブラウザ＋実 API＋ローカル fake GitHub）。
 *
 * この spec は自分で fake GitHub と API を起動する。実 GitHub・実 AI へは送らない。
 * 依頼はすべて作り物。ブラウザから自分の origin 以外へ出る通信は abort して 0 件を確かめる。
 * `_test` で終わる DB でなければ skip する（skip は成功ではない）。
 */

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';
const dbName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

type Detail = { id: string; title: string; status: string; version: number; orderVersion: number; issueNo: number | null };
type JobsBody = {
  items: { id: string; state: string; runnerKind: string; orderVersion: number }[];
  handoffs: { orderVersion: number; state: string; issueNo: number | null; issueUrl: string | null; issueSource: string }[];
};

let fake: FakeGithub;
let base = '';
let baseNoAllow = '';
const servers: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    REQUIRE_ORIGIN_SECRET: '0',
    MAIL_MODE: 'file',
    MAIL_APPROVAL_TO: 'approver@example.com',
    MAIL_OUTBOX_DIR: '.mail/e2e-outbox',
    GITHUB_API_URL: fake.url,
    GITHUB_TOKEN: 'fake-token-for-local-test',
    GITHUB_REPO: FAKE_REPO,
    ...extra,
  };
}

async function startApi(allowed: string): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('node_modules/.bin/tsx', ['src/api/server.ts'], {
    env: childEnv({ PORT: String(port), HOST: '127.0.0.1', APP_BASE_URL: url, DEVLINE_TARGET_REPOS: allowed }),
    stdio: 'ignore',
  });
  servers.push(child);
  for (let i = 0; i < 120; i += 1) {
    const ok = await fetch(`${url}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return url;
    await delay(250);
  }
  throw new Error('API が起動しませんでした');
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

test.skip(!/_test$/.test(dbName), '`_test` で終わる DB でのみ実行する');

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fake = await startFakeGithub();
  base = await startApi(`${FAKE_REPO}:${FAKE_REPO_ID}`);
  baseNoAllow = await startApi('');
});

test.afterAll(async () => {
  await Promise.all(servers.map(stop));
  await fake?.close();
});

/* 通信先とモーダルの監視。どの試験でも、外へ出る通信とブラウザのモーダルは 0 件。 */
let leaked: string[] = [];
let dialogs: string[] = [];
let pageErrors: string[] = [];

async function guard(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1' || u.port === new URL(fake.url).port) {
      leaked.push(u.origin);
      return route.abort();
    }
    return route.fallback();
  });
  context.on('page', (p) => {
    p.on('dialog', (d) => watchDialog(d));
    p.on('pageerror', (e) => pageErrors.push(e.message));
  });
}

function watchDialog(d: { type(): string; dismiss(): Promise<void> }): void {
  dialogs.push(d.type());
  void d.dismiss();
}

test.beforeEach(async ({ context, page }) => {
  leaked = [];
  dialogs = [];
  pageErrors = [];
  fake.overrides.length = 0;
  fake.access.length = 0;
  fake.onWrite = null;
  fake.repoPrivate = true;
  await guard(context);
  page.on('dialog', (d) => watchDialog(d));
  page.on('pageerror', (e) => pageErrors.push(e.message));
});

test.afterEach(() => {
  expect(leaked, '自分の origin 以外への通信').toEqual([]);
  expect(dialogs, 'ブラウザのモーダル').toEqual([]);
  expect(pageErrors, '画面の例外').toEqual([]);
});

const creates = (): number => fake.access.filter((a) => a.method === 'POST' && a.path.endsWith('/issues')).length;
const patches = (): number => fake.access.filter((a) => a.method === 'PATCH').length;

/** 条件に合う要求にだけ1回答える。overrides は毎要求で消費されるので、合わないときは積み直す。 */
function onceOn(match: (r: { method: string; path: string }) => boolean, reply: (body: any) => FakeReply): void {
  const responder = (req: { method: string; path: string; body: any }): FakeReply | null => {
    if (match(req)) return reply(req.body);
    fake.overrides.unshift(responder);
    return null;
  };
  fake.overrides.push(responder);
}
const isCreate = (r: { method: string; path: string }): boolean => r.method === 'POST' && r.path.endsWith('/issues');

/** 作成してから接続を切る（応答の喪失）。 */
function loseResponseAfterCreate(): void {
  onceOn(isCreate, (body) => {
    fake.addForeignIssue({ login: FAKE_LOGIN, title: body.title, body: body.body });
    return { status: 0, destroy: true };
  });
}

/** 作らずに接続を切る。 */
function dropWithoutCreate(): void {
  onceOn(isCreate, () => ({ status: 0, destroy: true }));
}

async function login(page: Page, at = base): Promise<void> {
  await page.goto(`${at}/login`);
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('button[data-v="home"]');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* 使えない環境では何もしない */
    }
  });
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

const setApiRole = (page: Page, role: string): Promise<unknown> => callApi(page, 'POST', '/api/auth/role', { role });
const getDetail = async (page: Page, id: string): Promise<Detail> =>
  (await callApi<{ request: Detail }>(page, 'GET', `/api/requests/${id}`)).request;

async function setUiRole(page: Page, role: string): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(300);
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
    approver: '鈴木 一郎',
  };
}

async function transition(page: Page, id: string, to: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cur = await getDetail(page, id);
  await callApi(page, 'POST', `/api/requests/${id}/transitions`, {
    to,
    version: cur.version,
    checklistAcknowledged: true,
    redAcknowledged: true,
    ...extra,
  });
}

async function createWaiting(page: Page, title: string): Promise<string> {
  await setApiRole(page, 'requester');
  const res = await callApi<{ request: Detail }>(page, 'POST', '/api/requests', inputOf(title));
  await setApiRole(page, 'desk');
  await transition(page, res.request.id, 'review');
  await transition(page, res.request.id, 'wait');
  return res.request.id;
}

/** API で承認まで進めて画面を読み直す（承認の記録に承認者の利用者 ID が入る）。 */
async function createApproved(page: Page, title: string, uiRole = 'desk'): Promise<string> {
  const id = await createWaiting(page, title);
  await setApiRole(page, 'approver');
  await transition(page, id, 'approved', { signal: 'g' });
  await reloadAs(page, uiRole);
  return id;
}

async function reloadAs(page: Page, uiRole: string): Promise<void> {
  await page.reload();
  await page.waitForSelector('button[data-v="home"]');
  await setUiRole(page, uiRole);
}

async function openDrawer(page: Page, title: string): Promise<void> {
  await page.click('button[data-v="list"]');
  await page.waitForTimeout(200);
  await page.locator(`tr:has-text("${title}")`).first().click();
  await expect(page.locator('#drawer')).toHaveClass(/show/);
}

const panel = (page: Page, scope = '#drawer'): Locator => page.locator(`${scope} [data-dl-panel]`).first();
const handoffBtn = (page: Page, scope = '#drawer'): Locator => panel(page, scope).locator('[data-dl="handoff"]');
const statusLine = (page: Page, scope = '#drawer'): Locator => panel(page, scope).locator('[data-dl-status]');

async function openLineTab(page: Page): Promise<void> {
  await page.click('button[data-v="devops"]');
  await page.waitForTimeout(200);
  await page.locator('[data-vt="dvtab|line"]').click();
  await page.waitForTimeout(200);
}

const seqOf = (page: Page): Promise<{ issue: number; pr: number }> =>
  page.evaluate(
    () =>
      (window as unknown as { __MSF_UI__: { data: () => { ops: { seq: { issue: number; pr: number } } } } }).__MSF_UI__.data().ops
        .seq,
  );

const countOrderPosts = (page: Page): (() => number) => {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/orders\/[^/]+\/handoff$/.test(new URL(r.url()).pathname)) n += 1;
  });
  return () => n;
};

const jobsOf = (page: Page, id: string): Promise<JobsBody> => callApi<JobsBody>(page, 'GET', `/api/requests/${id}/jobs`);

test.describe('開発ラインへ投入', () => {
  test('GUI で承認して投入: Issue 番号・URL・版・job を表示し、再読込後も残る。作成は1回で状態は変わらない', async ({ page }) => {
    await login(page);
    const title = `投入 ${Date.now()}`;
    const id = await createWaiting(page, title);
    await setApiRole(page, 'approver');
    await reloadAs(page, 'approver');

    // 画面の承認ダイアログで承認する（修正前の見本パイプもここで作られる）
    await openDrawer(page, title);
    await page.locator('#dst').click();
    const modal = page.locator('#modal');
    await modal.locator('input[name=ns][value=approved]').check({ force: true });
    await modal.locator('input[name=fc][value=g]').check({ force: true });
    if (await modal.locator('#pcok').count()) await modal.locator('#pcok').check({ force: true });
    await modal.locator('#sok').click();
    await expect.poll(async () => (await getDetail(page, id)).status).toBe('approved');
    await page.keyboard.press('Escape');
    // 運用データの保存は 400ms 遅れて送られる。読み直しで失わないように待つ
    await page.waitForTimeout(800);

    await setApiRole(page, 'desk');
    await reloadAs(page, 'desk');
    const seqBefore = await seqOf(page);
    const posts = countOrderPosts(page);

    await openLineTab(page);
    const card = `.card.pipe:has-text("${title}")`;
    await page
      .locator(card)
      .getByRole('button', { name: /開発ラインへ投入|Issueを作る/ })
      .click();

    // ここが修正前の失敗点: API を呼ばずローカルで番号を作っていた
    await expect.soft.poll(posts, { timeout: 5_000 }).toBe(1);
    await expect.soft.poll(creates, { timeout: 5_000 }).toBe(1);
    expect.soft((await seqOf(page)).issue, 'ローカル採番をしない').toBe(seqBefore.issue);
    expect.soft((await getDetail(page, id)).status, '投入で受付の状態を動かさない').toBe('approved');
    expect(test.info().errors, '修正前の振る舞いの失敗').toEqual([]);

    const issue = fake.issues[fake.issues.length - 1]!;
    expect(issue.body!.split('\n')[0]).toContain(`request=${id}`);
    const p = panel(page, card);
    await expect(p.locator('[data-dl-row="issue"]')).toContainText(`Issue #${issue.number}`);
    await expect(p.locator('[data-dl-row="issue"] a')).toHaveAttribute('href', issue.html_url);
    await expect(p.locator('[data-dl-row="issue"]')).toContainText('版 1');
    const job = (await jobsOf(page, id)).items[0]!;
    await expect(p.locator('[data-dl-row="job"]')).toContainText(job.id.slice(0, 8));

    // サーバの version を取り直している（次のボード操作が 409 にならない）
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText(`Issue #${issue.number}`);
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveAttribute('href', issue.html_url);
    await expect(panel(page).locator('[data-dl-row="job"]')).toContainText(job.id.slice(0, 8));
    expect(creates()).toBe(1);
  });

  test('投入の直後に画面のまま（再読込なし）ボードで進めても 409 にならない', async ({ page }) => {
    await login(page);
    const title = `投入後ボード ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    await handoffBtn(page).click();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    await page
      .locator('#drawer .x, #dclose, [data-close]')
      .first()
      .click({ timeout: 2_000 })
      .catch(() => page.keyboard.press('Escape'));

    await page.click('button[data-v="board"]');
    await page.locator(`button[data-nx="${id}"]`).click();
    await expect.poll(async () => (await getDetail(page, id)).status).toBe('dev');
    await page.waitForTimeout(200);
    await expect(page.locator('#toast .toast.ng')).toHaveCount(0);
    expect(creates()).toBe(1);
  });

  test('二重クリックしても作成は1回。送信中はボタンが無効で、再描画でも有効に戻らない', async ({ page }) => {
    await login(page);
    const title = `二重 ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    fake.onWrite = () => gate;
    const btn = handoffBtn(page);
    await btn.evaluate((b) => {
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
    await expect(btn).toBeDisabled();
    await expect(statusLine(page)).toContainText('送信中');
    // 同期の結果などで描き直されても送信中のまま
    await page.evaluate(() =>
      (window as unknown as { __MSF_UI__: { syncApplied: (c: boolean) => void } }).__MSF_UI__.syncApplied(true),
    );
    await expect(handoffBtn(page)).toBeDisabled();
    release();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    expect(creates()).toBe(1);
  });

  test('2タブ同時でも作成は1回。負けたタブも最後は同じ Issue を示す', async ({ page, context }) => {
    await login(page);
    const title = `2タブ ${Date.now()}`;
    await createApproved(page, title);
    const page2 = await context.newPage();
    await page2.goto(base);
    await page2.waitForSelector('button[data-v="home"]');
    await setUiRole(page2, 'desk');
    await openDrawer(page, title);
    await openDrawer(page2, title);

    fake.onWrite = () => delay(400);
    await Promise.all([handoffBtn(page).click(), handoffBtn(page2).click()]);
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page2).locator('[data-dl-row="issue"] a')).toBeVisible({ timeout: 20_000 });
    expect(creates()).toBe(1);
    expect(await panel(page2).locator('[data-dl-row="issue"] a').getAttribute('href')).toBe(
      await panel(page).locator('[data-dl-row="issue"] a').getAttribute('href'),
    );
  });

  test('応答喪失: 結果不明を表示し、Issue ができたように見せない。再度押すと照合で回収する', async ({ page }) => {
    await login(page);
    const title = `応答喪失 ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    loseResponseAfterCreate();
    await handoffBtn(page).click();

    await expect(statusLine(page)).toContainText('結果不明・要照合');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    await expect(handoffBtn(page)).toContainText('照合');
    expect(creates()).toBe(1);

    // 再読込しても結果不明のまま残る
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(statusLine(page)).toContainText('結果不明・要照合');

    const before = fake.access.length;
    await handoffBtn(page).click();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    expect(creates(), '再送せず照合で回収した').toBe(1);
    expect(fake.access.slice(before).some((a) => a.method === 'GET' && a.path.endsWith('/issues'))).toBe(true);
    expect((await jobsOf(page, id)).handoffs[0]!.state).toBe('succeeded');
  });

  test('作られていない結果不明: 再度押しても再送しない。confirm_absent は承認者・管理者だけが画面内の確認で実行できる', async ({
    page,
  }) => {
    await login(page);
    const title = `不在確認 ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    dropWithoutCreate();
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('結果不明・要照合');
    expect(creates()).toBe(1);

    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('見つかりませんでした');
    expect(creates(), '照合だけで再送しない').toBe(1);

    // 受付担当には出さない（管理者アカウントでも画面の役で分ける）
    await expect(panel(page).locator('[data-dl="absent-open"]')).toHaveCount(0);
    await expect(panel(page)).toContainText('承認者か管理責任者');

    for (const role of ['ops', 'sec', 'auditor']) {
      await setUiRole(page, role);
      await page.waitForTimeout(100);
      await expect(page.locator('#drawer [data-dl="absent-open"]')).toHaveCount(0);
    }

    // キーボードだけで操作する
    await setUiRole(page, 'approver');
    await page.locator('#drawer [data-dl="absent-open"]').first().focus();
    await page.keyboard.press('Enter');
    const form = page.locator('#drawer [data-dl-form]').first();
    await expect(form).toBeVisible();
    const submit = form.locator('[data-dl="absent-do"]');
    await expect(submit).toBeDisabled();
    await form.locator('textarea').fill('GitHub の一覧を人が確かめた（作り物）');
    await expect(submit).toBeDisabled();
    await form.locator('input[type=checkbox]').check();
    await expect(submit).toBeEnabled();

    // やめることもできる（送らない）
    await form.locator('[data-dl="absent-cancel"]').click();
    await expect(form).toHaveCount(0);
    expect(creates()).toBe(1);

    await page.locator('#drawer [data-dl="absent-open"]').first().click();
    const form2 = page.locator('#drawer [data-dl-form]').first();
    await form2.locator('textarea').fill('GitHub の一覧を人が確かめた（作り物）');
    await form2.locator('input[type=checkbox]').check();
    await form2.locator('[data-dl="absent-do"]').focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    expect(creates(), '明示の確認の後だけ再作成').toBe(2);
  });

  test('再承認で版が上がる: 再投入で同じ Issue を更新し、新しい版を表示する', async ({ page }) => {
    await login(page);
    const title = `再承認 ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    await handoffBtn(page).click();
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText('版 1');
    const first = (await jobsOf(page, id)).handoffs[0]!;

    // 編集で承認待ちへ戻り、再承認で版が上がる
    const cur = await getDetail(page, id);
    await setApiRole(page, 'desk');
    await callApi(page, 'PATCH', `/api/requests/${id}`, {
      ...inputOf(title),
      problem: 'E2E の困りごと 改（作り物）',
      version: cur.version,
    });
    await setApiRole(page, 'approver');
    if ((await getDetail(page, id)).status !== 'approved') await transition(page, id, 'approved', { signal: 'g' });
    const after = await getDetail(page, id);
    expect(after.orderVersion).toBeGreaterThan(1);

    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(handoffBtn(page)).toContainText(`版 ${after.orderVersion}`);
    await expect(handoffBtn(page)).toContainText(`#${first.issueNo}`);
    await handoffBtn(page).click();
    // 更新前の行にも「いまの版 N は未反映」と版の番号が出るので、その表示が消えるまで待つ
    await expect(panel(page).locator('[data-dl-row="issue"]')).not.toContainText('未反映');
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText(`版 ${after.orderVersion}`);
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText(`Issue #${first.issueNo}`);
    expect(creates(), '作成は増えない').toBe(1);
    expect(patches(), '同じ Issue を更新').toBe(1);
    const issue = fake.issues.find((i) => i.number === first.issueNo)!;
    expect(issue.body!.split('\n')[0]).toContain(`version=${after.orderVersion}`);
    // 古い版の job は取り消され、実行済みに見せない
    const jobs = await jobsOf(page, id);
    expect(jobs.items.find((j) => j.orderVersion === 1)?.state).toBe('cancelled');
    await expect(panel(page).locator('[data-dl-row="job-old"]')).toContainText('中止');
  });

  test('前の版の結果不明は新しい版でも照合でき、見つからなければ確定して作り直せる', async ({ page }) => {
    await login(page);
    const title = `前の版の不明 ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    dropWithoutCreate();
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('結果不明・要照合');

    // 再承認で版を上げる
    const cur = await getDetail(page, id);
    await setApiRole(page, 'desk');
    await callApi(page, 'PATCH', `/api/requests/${id}`, {
      ...inputOf(title),
      problem: '版を上げる（作り物）',
      version: cur.version,
    });
    await setApiRole(page, 'approver');
    if ((await getDetail(page, id)).status !== 'approved') await transition(page, id, 'approved', { signal: 'g' });
    await reloadAs(page, 'approver');
    await openDrawer(page, title);
    await expect(statusLine(page)).toContainText('結果不明・要照合');
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText('結果不明');
    await expect(handoffBtn(page)).toContainText('照合する');
    const before = creates();
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('見つかりませんでした');
    expect(creates(), '照合だけで再送しない').toBe(before);
    await panel(page).locator('[data-dl="absent-open"]').click();
    const form = panel(page).locator('[data-dl-form]');
    await form.locator('textarea').fill('GitHub の一覧を人が確かめた（作り物）');
    await form.locator('input[type=checkbox]').check();
    await form.locator('[data-dl="absent-do"]').click();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    expect(creates()).toBe(before + 1);
  });

  test('投入の待ちの間に書いたコメントを失わない', async ({ page }) => {
    await login(page);
    const title = `投入中の編集 ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/orders\/[^/]+\/handoff$/, async (route) => {
      await held;
      return route.fallback();
    });
    await handoffBtn(page).click();
    await page.evaluate((rid) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<unknown> };
        __MSF_UI__: { data: () => { items: { id: string; comments?: unknown[] }[] } };
      };
      const data = w.__MSF_UI__.data();
      const item = data.items.find((x) => x.id === rid)!;
      (item.comments ??= []).push({ at: new Date().toISOString(), by: '作り物', text: '投入中のコメント' });
      void w.__MSF__.persist(data);
    }, id);
    release();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    await expect
      .poll(async () => ((await getDetail(page, id)) as unknown as { comments: { text: string }[] }).comments.map((c) => c.text))
      .toContain('投入中のコメント');
  });

  test('許可リストが空: 「開発ライン未接続」と表示し、外部へ送らず、Issue ができたように見せない', async ({ page }) => {
    await login(page, baseNoAllow);
    const title = `未接続 ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    const seq = await seqOf(page);
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('開発ライン未接続');
    // 記録を読めて、投入の記録が何も無いときだけ断定する
    await expect(statusLine(page)).toContainText('Issue は作られていません');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText('未接続');
    expect(fake.access, 'fake GitHub への送信').toHaveLength(0);
    expect((await seqOf(page)).issue).toBe(seq.issue);
  });

  /* 投入の記録を作り物で返す。#42 の残りの再現に使う（投入の POST は外へ送らせない）。 */
  const fakeJobs = (
    page: Page,
    id: string,
    handoffs: Record<string, unknown>[],
    currentTargetRepo: string | null,
  ): Promise<unknown> =>
    page.route(`**/api/requests/${id}/jobs`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], evidence: {}, currentTargetRepo, handoffs }),
      }),
    );
  const unknownHandoff = (targetRepo: string): Record<string, unknown> => ({
    orderVersion: 1,
    state: 'unknown',
    op: 'create_issue',
    issueNo: null,
    issueUrl: null,
    issueSource: 'fake',
    attempts: 1,
    nextAttemptAt: null,
    updatedAt: '2026-11-01T00:00:00.000Z',
    targetRepo,
  });
  const reject405 = (page: Page): Promise<unknown> =>
    page.route(/\/api\/orders\/[^/]+\/handoff$/, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-405', message: '開発ラインの設定が正しくありません' } }),
      }),
    );

  test('details のない ERR-405: 結果不明の投入があれば「Issue は作られていません」と断定しない', async ({ page }) => {
    await login(page);
    const title = `断定なし ${Date.now()}`;
    const id = await createApproved(page, title);
    await fakeJobs(page, id, [unknownHandoff(FAKE_REPO)], FAKE_REPO);
    await reject405(page);
    await openDrawer(page, title);
    await expect(handoffBtn(page)).toContainText('照合する');
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('開発ライン未接続');
    await expect(statusLine(page)).not.toContainText('Issue は作られていません');
    await expect(statusLine(page)).toContainText('今回の投入は送っていません');
  });

  test('details のない ERR-405: 投入の記録を読めないときも断定しない', async ({ page }) => {
    await login(page);
    const title = `記録不明 ${Date.now()}`;
    const id = await createApproved(page, title);
    await page.route(`**/api/requests/${id}/jobs`, (route) => route.abort());
    await reject405(page);
    await openDrawer(page, title);
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('開発ライン未接続');
    await expect(statusLine(page)).not.toContainText('Issue は作られていません');
  });

  test('別のリポジトリの結果不明: 照合を案内せず、対象と理由と次の手順を出す。送信もしない', async ({ page }) => {
    await login(page);
    const title = `別リポジトリ ${Date.now()}`;
    const id = await createApproved(page, title);
    const other = 'other-owner/other-repo';
    await fakeJobs(page, id, [unknownHandoff(other)], FAKE_REPO);
    const posts = countOrderPosts(page);
    await openDrawer(page, title);
    await expect(statusLine(page)).toContainText(other);
    await expect(statusLine(page)).toContainText('照合できません');
    await expect(statusLine(page)).toContainText('次の手順');
    await expect(panel(page)).not.toContainText('照合する');
    await expect(handoffBtn(page)).toHaveCount(0);
    await expect(panel(page).locator('[data-dl-row="issue"]')).toContainText(other);
    expect(posts()).toBe(0);
  });

  test('同じリポジトリの結果不明は「照合する」のまま。今の連携先が分からないときは別リポジトリと決めつけない', async ({
    page,
  }) => {
    await login(page);
    const title = `同じリポジトリ ${Date.now()}`;
    const id = await createApproved(page, title);
    await fakeJobs(page, id, [unknownHandoff(FAKE_REPO)], null);
    await openDrawer(page, title);
    await expect(handoffBtn(page)).toContainText('照合する');
    await expect(statusLine(page)).not.toContainText('別のリポジトリ');
  });

  test('同期と refreshRequest が重なってもコメントを重複送信しない', async ({ page }) => {
    await login(page);
    const title = `同期と取り直し ${Date.now()}`;
    const id = await createApproved(page, title);
    let posted = 0;
    let stored = (): void => undefined;
    const reached = new Promise<void>((r) => (stored = r));
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/requests/${id}/comments`, async (route) => {
      posted += 1;
      // サーバには保存させ、応答だけ遅らせる（base が古いまま GET が新しい内容を返す状況）
      const res = await route.fetch();
      stored();
      await held;
      await route.fulfill({ response: res });
    });
    await page.evaluate((rid) => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<unknown>; refreshRequest: (i: string) => Promise<unknown> };
        __MSF_UI__: { data: () => { items: { id: string; comments?: unknown[] }[] } };
        __raced?: Promise<unknown>[];
      };
      const data = w.__MSF_UI__.data();
      const item = data.items.find((x) => x.id === rid)!;
      (item.comments ??= []).push({ at: new Date().toISOString(), by: '作り物', text: '重ならないコメント' });
      w.__raced = [w.__MSF__.persist(data)];
    }, id);
    await reached;
    await page.evaluate((rid) => {
      const w = window as unknown as {
        __MSF__: { refreshRequest: (i: string) => Promise<unknown> };
        __raced: Promise<unknown>[];
      };
      w.__raced.push(w.__MSF__.refreshRequest(rid));
    }, id);
    await page.waitForTimeout(300);
    release();
    await page.evaluate(async () => {
      const w = window as unknown as {
        __MSF__: { persist: (d: unknown) => Promise<unknown> };
        __MSF_UI__: { data: () => unknown };
        __raced: Promise<unknown>[];
      };
      await Promise.all(w.__raced);
      // 重複が手元に残っていれば、次の同期で送られる
      await w.__MSF__.persist(w.__MSF_UI__.data());
    });
    const texts = ((await getDetail(page, id)) as unknown as { comments: { text: string }[] }).comments
      .map((c) => c.text)
      .filter((t) => t === '重ならないコメント');
    expect(texts).toHaveLength(1);
    expect(posted).toBe(1);
    const live = await page.evaluate((rid) => {
      const w = window as unknown as { __MSF_UI__: { data: () => { items: { id: string; comments?: { text: string }[] }[] } } };
      return (w.__MSF_UI__.data().items.find((x) => x.id === rid)?.comments ?? []).filter((c) => c.text === '重ならないコメント')
        .length;
    }, id);
    expect(live).toBe(1);
  });

  test('「CI 成功」「受入条件」「PR 候補の準備完了」を別の行と言葉で出す（応答は作り物）', async ({ page }) => {
    await login(page);
    const title = `用語 ${Date.now()}`;
    const id = await createApproved(page, title);
    const jobId = '55555555-5555-4555-8555-555555555555';
    const paint = async (state: string, evidence: Record<string, unknown>): Promise<void> => {
      await page.unroute(`**/api/requests/${id}/jobs`).catch(() => undefined);
      await page.route(`**/api/requests/${id}/jobs`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: jobId,
                requestId: id,
                orderVersion: 1,
                runnerKind: 'docker-claude',
                state,
                stopReason: state === 'stopped' ? 'ci_incomplete' : null,
                stopDetail:
                  state === 'stopped' ? { cause: 'AC 未確認', unconfirmedAcs: ['AC-1'], acArtifact: 'unknown_ac_id' } : null,
                orderCurrent: true,
                costJpy: 0,
              },
            ],
            handoffs: [],
            currentTargetRepo: FAKE_REPO,
            evidence: {
              [jobId]: {
                attempts: 1,
                verificationSources: ['github'],
                hasPrDraft: state === 'pr_ready',
                ciRunUrl: 'https://github.invalid/x/y/actions/runs/1',
                ciSource: 'github',
                ...evidence,
              },
            },
          }),
        }),
      );
      await reloadAs(page, 'desk');
      await openDrawer(page, title);
    };
    const row = (name: string): Locator => panel(page).locator(`[data-dl-row="${name}"]`);
    const ac = (label: string, confirmed: number): Record<string, unknown> => ({
      total: 1,
      confirmed,
      failed: 0,
      unconfirmed: 1 - confirmed,
      label,
      items: [{ acId: 'AC-1', mark: confirmed ? '○' : '未確認', testIds: [] }],
    });

    // CI は成功、AC は証跡の欠落: CI の行で成功と言っても、AC の行と job は合格に見せない
    await paint('stopped', { ciResult: 'success', ac: ac('受入条件 未確認あり', 0) });
    await expect(row('ci')).toContainText('CI 成功');
    await expect(row('ac')).toContainText('受入条件 未確認あり');
    await expect(row('ac')).not.toContainText('全件確認');
    await expect(row('job')).toContainText('証跡の欠落');
    await expect(panel(page)).not.toContainText('受入合格');

    // CI の記録があるだけでは成功と言わない
    await paint('stopped', { ciResult: 'failure', ac: ac('受入条件 未確認あり', 0) });
    await expect(row('ci')).toContainText('CI 失敗');
    await expect(row('ci')).not.toContainText('CI 成功');

    // pr_ready は PR 候補の準備完了で、受入の合格ではない
    await paint('pr_ready', { ciResult: 'success', ac: ac('受入条件 全件確認', 1) });
    await expect(row('job')).toContainText('受入の合格ではありません');
    await expect(row('ac')).toContainText('全件確認');
  });

  test('公開リポジトリ: 「開発ライン未接続」と表示し、Issue を作らない', async ({ page }) => {
    fake.repoPrivate = false;
    await login(page);
    const title = `公開repo ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('開発ライン未接続');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    expect(creates()).toBe(0);
  });

  test('通信断・500: 成功表示をせず再試行でき、応答だけ失っても作成は1回', async ({ page }) => {
    await login(page);
    const title = `通信断 ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    const pattern = /\/api\/orders\/[^/]+\/handoff$/;

    await page.route(pattern, (route) => route.abort());
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('通信できませんでした');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    await expect(handoffBtn(page)).toBeEnabled();
    await page.unroute(pattern);

    await page.route(pattern, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ERR-401', message: '処理を完了できませんでした' } }),
      }),
    );
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('処理を完了できませんでした');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    await expect(handoffBtn(page)).toBeEnabled();
    await page.unroute(pattern);
    expect(creates()).toBe(0);

    // API までは届いて成功したが、ブラウザが応答を失った
    let aborted = false;
    await page.route(pattern, async (route) => {
      await route.fetch();
      await route.abort();
      aborted = true;
    });
    await handoffBtn(page).click();
    await expect.poll(() => aborted).toBe(true);
    await page.unroute(pattern);
    await expect.poll(creates).toBe(1);
    // 成功は応答ではなくサーバの記録で確かめて表示する（押し直さなくても回収される）
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    await expect(handoffBtn(page)).toHaveCount(0);
    expect(creates()).toBe(1);
  });

  test('Issue 作成の失敗（4xx）: 成功表示をせず再試行できる', async ({ page }) => {
    await login(page);
    const title = `4xx ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    onceOn(isCreate, () => ({ status: 422, body: { message: 'Validation Failed' } }));
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('作られていません');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    await expect(handoffBtn(page)).toBeEnabled();
    await handoffBtn(page).click();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    expect(creates()).toBe(2);
  });

  test('見本の承認記録（approver_user_id なし）: ERR-205 の理由と次の手順を表示する', async ({ page }) => {
    await login(page);
    await setApiRole(page, 'desk');
    const list = await callApi<{ items: { id: string; title: string; status: string }[] }>(
      page,
      'GET',
      '/api/requests?pageSize=200',
    );
    const sample = list.items.find((r) => r.status === 'approved' && /^REQ-2026-000\d$/.test(r.id));
    expect(sample, '見本データに承認済みの依頼がある').toBeTruthy();
    await reloadAs(page, 'desk');
    await openDrawer(page, sample!.title);
    await handoffBtn(page).click();
    await expect(statusLine(page)).toContainText('投入できません');
    await expect(statusLine(page)).toContainText('承認者が利用者IDで確認できません');
    await expect(statusLine(page)).toContainText('承認し直');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toHaveCount(0);
    expect(creates()).toBe(0);
  });

  test('権限: 依頼者には投入ボタンを出さない。内部監査は押せない', async ({ page }) => {
    await login(page);
    const title = `権限 ${Date.now()}`;
    await createApproved(page, title, 'requester');
    await openDrawer(page, title);
    await expect(handoffBtn(page)).toBeDisabled();
    await expect(panel(page)).toContainText('受付担当か承認者');
    await setUiRole(page, 'auditor');
    await expect(page.locator('#drawer [data-dl="handoff"]').first()).toBeDisabled();
    expect(creates()).toBe(0);
  });
});

test.describe('見本と実依頼の分離', () => {
  test('見本の操作は実依頼で実行できず、受付の状態が進まない', async ({ page }) => {
    await login(page);
    const title = `見本封じ ${Date.now()}`;
    const id = await createApproved(page, title, 'approver');
    // 実依頼に見本のパイプが残っている場面（以前の版で保存された ops など）を作る
    const steps = [
      { step: 2 },
      { step: 5 },
      { step: 6, esc: 'L3' },
      { step: 6 },
      { step: 9, pr: 900, prItems: Array(10).fill(1) },
      { step: 10, merged: '鈴木 一郎' },
      { step: 11, merged: '鈴木 一郎' },
    ];
    const posts = countOrderPosts(page);
    for (const s of steps) {
      await page.evaluate(
        ([rid, patch]) => {
          const o = (
            window as unknown as { __MSF_UI__: { data: () => { ops: { pipes: Record<string, unknown> } } } }
          ).__MSF_UI__.data().ops;
          o.pipes[rid as string] = {
            step: 1,
            issue: 777,
            pr: null,
            checks: {},
            same: 0,
            total: 0,
            hours: 0,
            cost: 0,
            esc: '',
            fail: 0,
            prItems: [],
            merged: '',
            ai: '',
            ...(patch as object),
          };
        },
        [id, s] as const,
      );
      for (const role of ['desk', 'approver']) {
        await setUiRole(page, role);
        await openLineTab(page);
        const card = page.locator(`.card.pipe:has-text("${title}")`);
        await expect(card).toBeVisible();
        const sampleBtn = card.locator('[data-dl-row="sample"] button');
        await expect(sampleBtn).toBeDisabled();
        await expect(card.locator('[data-dl-row="sample"]')).toContainText('見本');
        await expect(card.locator('[data-dl-row="sample"]')).toContainText('実行できません');
        await expect(card.locator('[data-act^="pipe|"]')).toHaveCount(0);
      }
    }
    const after = await getDetail(page, id);
    expect(after.status, '見本の操作で状態が進まない').toBe('approved');
    expect(posts()).toBe(0);
    expect(creates()).toBe(0);
    await expect(page.locator('#modal')).not.toHaveClass(/show/);
  });

  test('ボードの通常の状態変更は動き、見本の PR・検査結果を作らない', async ({ page }) => {
    await login(page);
    const title = `ボード ${Date.now()}`;
    const id = await createApproved(page, title);
    const seq = await seqOf(page);
    await page.click('button[data-v="board"]');
    await page.locator(`button[data-nx="${id}"]`).click();
    await expect.poll(async () => (await getDetail(page, id)).status).toBe('dev');
    await page.waitForTimeout(200);
    await page.locator(`button[data-nx="${id}"]`).click();
    await expect.poll(async () => (await getDetail(page, id)).status).toBe('verify');
    const pipe = await page.evaluate(
      (rid) =>
        (window as unknown as { __MSF_UI__: { data: () => { ops: { pipes: Record<string, unknown> } } } }).__MSF_UI__.data().ops
          .pipes[rid] ?? null,
      id,
    );
    expect(pipe, '実依頼に見本のパイプを作らない').toBeNull();
    const after = await seqOf(page);
    expect(after.issue).toBe(seq.issue);
    expect(after.pr).toBe(seq.pr);
    await openDrawer(page, title);
    await expect(panel(page).locator('[data-dl-row="ci"]')).toContainText('未接続');
    await expect(panel(page).locator('[data-dl-row="pr"]')).toContainText('未接続');
  });

  test('fake の job は「fake」と表示し、実行確認済みに見せない。worker で pr_ready まで進めても同じ', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);
    const title = `fake job ${Date.now()}`;
    const id = await createApproved(page, title);
    await openDrawer(page, title);
    await handoffBtn(page).click();
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    await expect(panel(page).locator('[data-dl-row="job"] [data-dl-kind]')).toHaveText('fake');
    await expect(panel(page).locator('[data-dl-row="ci"] [data-dl-kind]')).toHaveText('未接続');
    // fake サーバの Issue も fake
    await expect(panel(page).locator('[data-dl-row="issue"] [data-dl-kind]')).toHaveText('fake');

    const worker = spawn('node_modules/.bin/tsx', ['src/worker/main.ts'], {
      env: childEnv({
        DEVLINE_WORKER_ENABLED: '1',
        DEVLINE_RUNNER_KIND: 'fake',
        DEVLINE_FAKE_SCENARIO: 'success',
        DEVLINE_TARGET_REPOS: `${FAKE_REPO}:${FAKE_REPO_ID}`,
      }),
      stdio: 'ignore',
    });
    try {
      await expect
        .poll(async () => (await jobsOf(page, id)).items[0]?.state, { timeout: 120_000, intervals: [1_000] })
        .toBe('pr_ready');
    } finally {
      await stop(worker);
    }
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(panel(page).locator('[data-dl-row="job"]')).toContainText('人の確認待ち');
    for (const row of ['issue', 'job', 'plan', 'ci', 'pr']) {
      await expect(panel(page).locator(`[data-dl-row="${row}"] [data-dl-kind]`), row).toHaveText('fake');
    }
    // merge・成果物・配備・戻しは、記録が無ければ未接続のまま（準備完了でも実行済みに見せない）
    for (const row of ['merge', 'artifact', 'deploy', 'rollback']) {
      await expect(panel(page).locator(`[data-dl-row="${row}"] [data-dl-kind]`), row).toHaveText('未接続');
    }
    await expect(panel(page)).not.toContainText('実行確認済み');
    expect((await getDetail(page, id)).status, 'job が進んでも受付の状態は動かない').toBe('approved');
  });

  test('区別は色だけに頼らない: 4種類とも文字で出る', async ({ page }) => {
    await login(page);
    const title = `区別 ${Date.now()}`;
    const id = await createApproved(page, title);
    // 実 GitHub の証跡が来たときの表示だけを、応答の差し替えで確かめる（実 GitHub には送らない）
    await page.route(`**/api/requests/${id}/jobs`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [],
          handoffs: [
            {
              orderVersion: 1,
              state: 'succeeded',
              op: 'create_issue',
              issueNo: 5,
              issueUrl: 'https://github.invalid/x/y/issues/5',
              issueSource: 'github',
              attempts: 1,
              nextAttemptAt: null,
              updatedAt: new Date().toISOString(),
            },
          ],
          evidence: {},
        }),
      }),
    );
    await page.evaluate((rid) => {
      const o = (
        window as unknown as { __MSF_UI__: { data: () => { ops: { pipes: Record<string, unknown> } } } }
      ).__MSF_UI__.data().ops;
      o.pipes[rid] = {
        step: 5,
        issue: 777,
        pr: null,
        checks: {},
        same: 0,
        total: 0,
        hours: 0,
        cost: 0,
        esc: '',
        fail: 0,
        prItems: [],
        merged: '',
        ai: '',
      };
    }, id);
    await openDrawer(page, title);
    const p = panel(page);
    await expect(p.locator('[data-dl-row="issue"] [data-dl-kind]')).toHaveText('実行確認済み');
    await expect(p.locator('[data-dl-row="ci"] [data-dl-kind]')).toHaveText('未接続');
    await expect(p.locator('[data-dl-row="sample"] [data-dl-kind]')).toHaveText('見本');
    // 見本の番号を実物のリンクにしない
    await expect(p.locator('[data-dl-row="sample"] a')).toHaveCount(0);
  });

  test('docker-claude の job と github の検証は実行確認済み。github.com 以外の連携先は fake', async ({ page }) => {
    await login(page);
    const title = `実 runner ${Date.now()}`;
    const id = await createApproved(page, title);
    const jobId = '33333333-3333-3333-3333-333333333333';
    const respond = (evidence: Record<string, unknown>): void => {
      void page.unroute(`**/api/requests/${id}/jobs`);
      void page.route(`**/api/requests/${id}/jobs`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: jobId,
                requestId: id,
                orderVersion: 1,
                state: 'pr_ready',
                runnerKind: 'docker-claude',
                stopReason: null,
                orderCurrent: true,
                costJpy: 120,
              },
            ],
            handoffs: [],
            evidence: { [jobId]: evidence },
          }),
        }),
      );
    };
    respond({
      attempts: 2,
      verificationSources: ['github'],
      hasPrDraft: true,
      pr: { number: 12, url: 'https://github.invalid/x/y/pull/12', source: 'github' },
      ciRunUrl: 'https://github.invalid/x/y/actions/runs/1',
      ciSource: 'github',
      ac: {
        total: 2,
        confirmed: 2,
        failed: 0,
        unconfirmed: 0,
        label: '受入条件 全件確認',
        items: [
          { acId: 'AC-1', mark: '○', testIds: ['AC-1: t'] },
          { acId: 'AC-2', mark: '○', testIds: ['AC-2: t'] },
        ],
      },
    });
    await openDrawer(page, title);
    const p = panel(page);
    for (const row of ['job', 'plan', 'ci', 'ac', 'pr']) {
      await expect(p.locator(`[data-dl-row="${row}"] [data-dl-kind]`), row).toHaveText('実行確認済み');
    }
    await expect(p.locator('[data-dl-row="plan"]')).toContainText('docker-claude');
    await expect(p.locator('[data-dl-row="plan"]')).toContainText('120 円');
    await expect(p.locator('[data-dl-row="ci"]')).toContainText('GitHub Actions');
    await expect(p.locator('[data-dl-row="ac"]')).toContainText('受入条件 全件確認（確認 2 / 2）');
    await expect(p.locator('[data-dl-row="job"]')).toContainText('受入の合格ではありません');
    await expect(p.locator('[data-dl-row="pr"] a')).toHaveText('PR #12');
    await expect(p.locator('[data-dl-row="pr"]')).toContainText('AI は merge しません');

    // ローカルの連携先の結果は実物に見せない
    respond({
      attempts: 2,
      verificationSources: ['github'],
      hasPrDraft: true,
      pr: { number: 12, url: 'http://127.0.0.1:1/x/y/pull/12', source: 'fake' },
      ciRunUrl: 'http://127.0.0.1:1/x/y/actions/runs/1',
      ciSource: 'fake',
    });
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(panel(page).locator('[data-dl-row="ci"] [data-dl-kind]')).toHaveText('fake');
    await expect(panel(page).locator('[data-dl-row="pr"] [data-dl-kind]')).toHaveText('fake');
    await expect(panel(page).locator('[data-dl-row="ci"]')).toContainText('実 GitHub ではありません');
  });

  test('実 job は完了していない段階を実行確認済みにしない。AC 未確認は理由を出す（応答は作り物）', async ({ page }) => {
    await login(page);
    const title = `実 job 途中 ${Date.now()}`;
    const id = await createApproved(page, title);
    const jobId = '44444444-4444-4444-4444-444444444444';
    const respond = (job: Record<string, unknown>, evidence: Record<string, unknown>): void => {
      void page.unroute(`**/api/requests/${id}/jobs`);
      void page.route(`**/api/requests/${id}/jobs`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: jobId,
                requestId: id,
                orderVersion: 1,
                runnerKind: 'docker-claude',
                stopReason: null,
                orderCurrent: true,
                costJpy: 10,
                ...job,
              },
            ],
            handoffs: [],
            evidence: { [jobId]: evidence },
          }),
        }),
      );
    };
    const kind = (row: string) => panel(page).locator(`[data-dl-row="${row}"] [data-dl-kind]`);

    respond({ state: 'queued' }, { attempts: 0, verificationSources: [], hasPrDraft: false });
    await openDrawer(page, title);
    await expect(kind('job')).toHaveText('未接続');
    await expect(panel(page)).not.toContainText('実行確認済み');

    for (const state of ['planning', 'implementing', 'revising']) {
      respond({ state }, { attempts: 1, verificationSources: [], hasPrDraft: false });
      await reloadAs(page, 'desk');
      await openDrawer(page, title);
      await expect(kind('job'), state).toHaveText('実行中');
      await expect(kind('plan'), state).toHaveText('実行中');
      await expect(panel(page), state).not.toContainText('実行確認済み');
    }

    // 検査待ち: 実装は終わっているが、job と CI は実行中
    respond({ state: 'verifying' }, { attempts: 2, verificationSources: [], hasPrDraft: false });
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(kind('job')).toHaveText('実行中');
    await expect(kind('ci')).toHaveText('実行中');
    await expect(kind('ac')).toHaveText('未接続');

    respond(
      {
        state: 'stopped',
        stopReason: 'ci_incomplete',
        stopDetail: { cause: 'AC 未確認', unconfirmedAcs: ['AC-2'] },
      },
      {
        attempts: 2,
        verificationSources: ['github'],
        hasPrDraft: false,
        ciRunUrl: 'https://github.invalid/x/y/actions/runs/1',
        ciSource: 'github',
        ac: {
          total: 2,
          confirmed: 1,
          failed: 0,
          unconfirmed: 1,
          label: '受入条件 未確認あり',
          items: [
            { acId: 'AC-1', mark: '○', testIds: ['AC-1: t'] },
            { acId: 'AC-2', mark: '未確認', testIds: [] },
          ],
        },
      },
    );
    await reloadAs(page, 'desk');
    await openDrawer(page, title);
    await expect(kind('job')).toHaveText('停止');
    await expect(kind('plan')).toHaveText('停止');
    await expect(kind('ac')).toHaveText('未接続');
    await expect(panel(page).locator('[data-dl-row="job"]')).toContainText('AC 未確認（AC-2）');
    await expect(panel(page).locator('[data-dl-row="ac"]')).toContainText('受入条件 未確認あり（確認 1 / 2）');
    await expect(panel(page).locator('[data-dl-row="ac"]')).not.toContainText('全件確認');
  });

  test('jobs を読めないときは未接続と表示する', async ({ page }) => {
    await login(page);
    const title = `未取得 ${Date.now()}`;
    const id = await createApproved(page, title);
    await page.route(`**/api/requests/${id}/jobs`, (route) => route.abort());
    await openDrawer(page, title);
    await expect(panel(page).locator('[data-dl-row="job"] [data-dl-kind]')).toHaveText('未接続');
    await expect(panel(page)).toContainText('読み込めませんでした');
  });

  test('キーボードで投入でき、結果へフォーカスが移る', async ({ page }) => {
    await login(page);
    const title = `キーボード ${Date.now()}`;
    await createApproved(page, title);
    await openDrawer(page, title);
    await handoffBtn(page).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).locator('[data-dl-row="issue"] a')).toBeVisible();
    await expect(statusLine(page)).toBeFocused();
    expect(creates()).toBe(1);
    await expect(statusLine(page)).toHaveAttribute('role', 'status');
    // リンクも Tab で届く
    await page.keyboard.press('Tab');
    const focusedIn = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-dl-panel]')));
    expect(focusedIn).toBe(true);
  });
});

test.describe('見本モード（サーバ未接続）', () => {
  test('window.__MSF__ が無ければ従来どおりローカルで進む', async ({ page }) => {
    await login(page);
    await page.route(`${base}/`, async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<script type="application\/json" id="msf-boot">[\s\S]*?<\/script>/, '');
      await route.fulfill({ response: res, body: html });
    });
    const posts = countOrderPosts(page);
    await page.goto(`${base}/`);
    await page.waitForSelector('button[data-v="home"]');
    expect(await page.evaluate(() => (window as unknown as { __MSF__: unknown }).__MSF__)).toBeNull();
    await setUiRole(page, 'desk');
    await openLineTab(page);
    const seq = await seqOf(page);
    await page
      .getByRole('button', { name: /Issueを作る/ })
      .first()
      .click();
    await expect.poll(async () => (await seqOf(page)).issue).toBe(seq.issue + 1);
    await expect(page.locator('#toast')).toContainText(`Issue #${seq.issue + 1}`);
    expect(posts()).toBe(0);
    expect(creates()).toBe(0);
    await page
      .getByRole('button', { name: /AIの作業を進める/ })
      .first()
      .click();
    await expect(page.locator('#toast')).toContainText('シミュレーション');
  });
});
