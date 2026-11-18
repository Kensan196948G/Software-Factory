import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { IS_ISO, requestTitle, type Api, type Layer, LAYER, RUN_ID } from './roles';

/**
 * ステーション画面（SCR-01〜）の操作ヘルパー。
 * 既存の UI 予行（docs/production/48-...）と同じ導線・セレクタを使う。
 * 状態・版・監査の判定は、画面の表示に加えて API の読み取りで突き合わせる。
 */

export type Signal = 'g' | 'y' | 'r';
export type Status =
  'received' | 'review' | 'wait' | 'approved' | 'dev' | 'verify' | 'field' | 'release_wait' | 'done' | 'back' | 'hold' | 'cancel';

/**
 * 件名を実行内で一意にする。`--repeat-each` は繰り返しごとに新しいワーカーを作るため、
 * モジュールの連番は 0 に戻る。連番だけだと同じ件名の依頼が増え、A1 の「1 件だけ残る」が壊れる。
 * 実行 ID（1 回の run-iso で固定）に乱数を足し、DB が同じでも衝突しないようにする。
 */
export function uniqueTitle(slug: string): string {
  const nonce = randomBytes(3).toString('hex');
  return requestTitle(`${slug} ${RUN_ID.slice(-6)}${nonce}`);
}

export interface ServerRequest {
  id: string;
  title: string;
  status: Status;
  version: number;
  orderVersion: number;
  signalDecided: string | null;
  approverUserId: string | null;
  approver: string;
  applicantUserId: string | null;
  deleted?: boolean;
}

export interface User {
  id: string;
  displayName: string;
  email: string;
  actingRole: string;
  roles: string[];
  isAdmin: boolean;
}

export async function currentUser(api: Api): Promise<User> {
  const res = await api.get('/api/auth/me');
  expect(res.status, 'ログイン中の利用者を取得できません').toBe(200);
  return res.body.user as User;
}

export async function serverRequest(api: Api, id: string): Promise<ServerRequest> {
  const res = await api.get(`/api/requests/${encodeURIComponent(id)}`);
  expect(res.status, `依頼 ${id} を取得できません`).toBe(200);
  return res.body.request as ServerRequest;
}

export async function waitStatus(api: Api, id: string, status: Status, timeout = 20_000): Promise<ServerRequest> {
  let latest: ServerRequest | null = null;
  await expect
    .poll(
      async () => {
        latest = await serverRequest(api, id);
        return latest.status;
      },
      { timeout, message: `依頼 ${id} が ${status} になるのを待っています` },
    )
    .toBe(status);
  return latest as unknown as ServerRequest;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#nav', { timeout: 30_000 });
}

export interface RegisterOptions {
  title: string;
  decides?: Signal;
  criteria?: string[];
  approverUserId?: string;
  users?: string[];
  scope?: string[];
}

/**
 * 新しい依頼を 7 ステップで登録し、受付番号を返す。
 * 承認者は、指定が無ければ画面の選択肢の先頭（有効な承認者）を選ぶ。
 */
export async function registerRequest(
  page: Page,
  opts: RegisterOptions,
): Promise<{ id: string; toast: string; stampText: string }> {
  const decides = opts.decides ?? 'g';
  const criteria = opts.criteria ?? ['検索結果が2秒以内に表示される', '同じ番号を二重に登録できない'];
  await openApp(page);
  await page.click('#nav a[data-v="new"]');
  await page.waitForSelector('#stepBody');

  const next = async (): Promise<void> => {
    await page.click('#pane [data-a="next"]');
    await page.waitForTimeout(120);
    const err = page.locator('#err');
    if (await err.isVisible().catch(() => false)) {
      throw new Error(`入力の検証で止まりました: ${(await err.innerText()).slice(0, 200)}`);
    }
  };

  await next(); // STEP 2（だれが使う？）
  await page.click('#stepBody [data-a="chip"][data-f="users"]');
  await next(); // STEP 3（件名・困りごと・目的）
  await page.fill('#stepBody [data-bind="title"]', opts.title);
  await page.fill('#stepBody [data-bind="problem"]', '検証用の作り物の困りごと（実データは使わない）');
  await page.fill('#stepBody [data-bind="purpose"]', '承認プロセスが設計どおりに動くことを確かめる');
  await page.locator('#stepBody [data-bind="title"]').blur();
  await next(); // STEP 4（作るもの）
  const scope = opts.scope ?? ['E2E の確認'];
  await page.fill('#stepBody [data-bind="scope"]', scope.join('\n'));
  await next(); // STEP 5（合格の条件）
  await page.fill('#stepBody [data-crit="0"]', criteria[0] as string);
  if (criteria.length > 1) {
    await page.click('#stepBody [data-a="addC"]');
    await page.waitForSelector('#stepBody [data-crit="1"]');
    for (let i = 1; i < criteria.length; i += 1) {
      if (i > 1) await page.click('#stepBody [data-a="addC"]');
      await page.fill(`#stepBody [data-crit="${i}"]`, criteria[i] as string);
    }
  }
  await next(); // STEP 6（道具の性質＝信号の候補）
  await page.click(`#stepBody [data-a="one"][data-f="decides"][data-v="${decides}"]`);
  await next(); // STEP 7（承認者）
  const select = page.locator('#stepBody select[data-bind="approverUserId"]');
  await select.waitFor();
  if (opts.approverUserId) {
    await select.selectOption(opts.approverUserId);
  } else {
    const values = await select
      .locator('option')
      .evaluateAll((options) =>
        options.filter((o) => !(o as HTMLOptionElement).disabled).map((o) => (o as HTMLOptionElement).value),
      );
    const first = values.find((v) => v !== '');
    expect(first, '承認者の選択肢がありません（承認者ロールの有効な利用者が必要）').toBeTruthy();
    await select.selectOption(first as string);
  }
  await page.click('#pane [data-a="submit"]');
  // 受付スタンプは即時に出るが、トーストは 1.5 秒後に出る（画面の実装）。トーストを待ってから
  // スタンプの textContent を読む（スタンプは 1.5 秒で隠れるため innerText では空になり得る）。
  await waitToast(page, /受け付けました/, 20_000);
  const toast = await lastToast(page);
  const stampText = (await page.locator('#stampNo').evaluate((el) => (el.textContent ?? '').trim())) || '';
  await page.waitForSelector('#board', { timeout: 30_000 }).catch(() => undefined);
  return { id: stampText, toast, stampText };
}

/** 最後に積まれたトーストの文言（無ければ空）。 */
export async function lastToast(page: Page): Promise<string> {
  const toast = page.locator('#toast > *');
  if ((await toast.count()) === 0) return '';
  return (await toast.last().innerText()).trim();
}

export async function waitToast(page: Page, pattern: RegExp, timeout = 15_000): Promise<string> {
  await expect
    .poll(
      async () => {
        const text = await lastToast(page);
        return pattern.test(text) ? text : '';
      },
      { timeout, message: `トースト ${pattern} を待っています` },
    )
    .not.toBe('');
  return lastToast(page);
}

/** 詳細（右端パネル #rin）をレビュー画面から開く。 */
export async function openFromReview(page: Page, id: string): Promise<void> {
  await page.click('#nav a[data-v="review"]');
  await page.waitForSelector('#work');
  const row = page.locator(`#work [data-id="${id}"]`).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.waitForSelector(`#rin [data-a="status"][data-id="${id}"]`, { timeout: 20_000 });
}

/** 一覧から詳細ドロワーを開く（承認済みなどレビュー画面に出ない状態用）。 */
export async function openFromList(page: Page, id: string): Promise<void> {
  await page.click('#nav a[data-v="list"]');
  await page.waitForSelector('#ltb tr[data-id]');
  await page.fill('#main [data-flt="fq"]', id);
  await page.waitForTimeout(400);
  const row = page.locator(`#ltb tr[data-id="${id}"]`);
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.waitForSelector('#drawer.open', { timeout: 20_000 });
  await page.waitForSelector(`#din [data-a="status"][data-id="${id}"]`, { timeout: 20_000 });
}

/** 「操作する人」の選択を試みる（保持していない役割なら 403 になる）。 */
export async function trySwitchRole(page: Page, role: 'requester' | 'desk' | 'approver'): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(400);
}

export interface StatusResult {
  ok: boolean;
  toast: string;
  modalOpen: boolean;
  status: Status;
  version: number;
  appStatus: string;
}

/**
 * 状態変更ダイアログを開いて送信する。理由が必須の遷移では reason を入れる。
 * 送信前の抑止（クライアント側）と、サーバ拒否の両方を実測できるように、結果を返す。
 */
export async function submitStatus(
  page: Page,
  api: Api,
  id: string,
  to: Status,
  opts: { reason?: string; main?: boolean; root?: '#rin' | '#din' } = {},
): Promise<StatusResult> {
  const root = opts.root ?? '#rin';
  if (opts.main) {
    const main = page.locator(`${root} [data-a="status"][data-id="${id}"][data-v="${to}"]`);
    await main.waitFor({ timeout: 15_000 });
    await main.click();
  } else {
    await page.click(`${root} [data-a="status"][data-id="${id}"][title="状態を変更"]`);
  }
  await page.waitForSelector('#modal.open');
  const radio = page.locator(`#modal input[name="ns"][value="${to}"]`);
  await radio.waitFor();
  expect(await radio.isDisabled(), `「${to}」への変更が画面で選べません（役割・状態の不一致）`).toBe(false);
  await radio.check();
  if (opts.reason !== undefined) await page.fill('#modal #nnote', opts.reason);
  await page.click('#modal [data-a="sok"]');
  // クライアント側の抑止（トースト・ダイアログ継続）か、サーバの応答かを待つ
  await page.waitForTimeout(700);
  const modalOpen = (await page.locator('#modal.open').count()) > 0;
  const toast = await lastToast(page);
  if (modalOpen) {
    const now = await serverRequest(api, id);
    return { ok: false, toast, modalOpen, status: now.status, version: now.version, appStatus: now.status };
  }
  const now = await waitStatus(api, id, to).catch(async () => serverRequest(api, id));
  await page.waitForTimeout(200);
  return { ok: now.status === to, toast, modalOpen, status: now.status, version: now.version, appStatus: now.status };
}

/** 受付 → 内容確認中 → 承認待ち（受付担当の職務を承認者が兼ねる）。 */
export async function advanceToWait(page: Page, api: Api, id: string): Promise<void> {
  await openFromReview(page, id);
  const review = await submitStatus(page, api, id, 'review', { main: true });
  expect(review.ok, `内容確認中へ進めません: ${review.toast}`).toBe(true);
  await page.waitForTimeout(200);
  const wait = await submitStatus(page, api, id, 'wait', {});
  expect(wait.ok, `承認待ちへ進めません: ${wait.toast}`).toBe(true);
}

export interface ApproveOptions {
  signal?: Signal;
  reason?: string;
  redAck?: boolean;
  openDialog?: boolean;
}

export interface ApproveResult {
  clicked: boolean;
  done: boolean;
  toast: string;
  modalOpen: boolean;
  status: Status;
  version: number;
}

/**
 * 承認（信号の色を決める）を画面から実行する。
 * done=false のときは送信されていない（画面の抑止、またはサーバ拒否）。toast と状態で判別する。
 */
export async function approveViaUi(page: Page, api: Api, id: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const root = '#rin';
  const main = page.locator(`${root} [data-a="status"][data-id="${id}"][data-v="approved"]`);
  await main.waitFor({ timeout: 20_000 });
  const disabled = await main.isDisabled();
  if (disabled) {
    const now = await serverRequest(api, id);
    return { clicked: false, done: false, toast: '', modalOpen: false, status: now.status, version: now.version };
  }
  await main.click();
  await page.waitForSelector('#modal.open');
  const signal = opts.signal;
  if (signal) {
    await page.check(`#modal input[name="fc"][value="${signal}"]`);
  }
  if (signal === 'r' && opts.redAck === true) await page.check('#modal #redok');
  if (signal === 'r' && opts.redAck === false) {
    const box = page.locator('#modal #redok');
    if (await box.isChecked()) await box.uncheck();
  }
  if (opts.reason !== undefined) await page.fill('#modal #nnote', opts.reason);
  // 直前のトーストが残っていると、送信前の抑止と取り違える。消してから送る。
  await page.evaluate(() => {
    document.querySelectorAll('#toast > *').forEach((el) => el.remove());
  });
  await page.click('#modal [data-a="sok"]');
  // クライアント抑止のトーストは 3.2 秒で消えるため、まず短い猶予で読む。
  await page.waitForTimeout(500);
  const blockedToast = await lastToast(page);
  let done = false;
  if (!blockedToast) {
    done = await page
      .waitForSelector('#modal #rsdone', { state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!done) {
    const modalOpen = (await page.locator('#modal.open').count()) > 0;
    const toast = await lastToast(page);
    const now = await serverRequest(api, id);
    return { clicked: true, done: false, toast, modalOpen, status: now.status, version: now.version };
  }
  const now = await waitStatus(api, id, 'approved');
  return { clicked: true, done: true, toast: '', modalOpen: true, status: now.status, version: now.version };
}

/** 承認完了ダイアログの「注文書を見る」から注文書タブを開き、画面の YAML を返す。 */
export async function openOrderFromSuccessModal(page: Page, _id: string): Promise<string> {
  await page.click('#modal [data-a="lineYaml"]');
  await page.waitForSelector(`#rin pre.yaml, #din pre.yaml`, { timeout: 20_000 });
  await page.waitForSelector(`#rin .ptabs button.on, #din .ptabs button.on`, { timeout: 10_000 }).catch(() => undefined);
  const yaml = page.locator('#rin pre.yaml, #din pre.yaml').first();
  await yaml.waitFor();
  return (await yaml.innerText()).trim();
}

/** 一覧から承認済み依頼の注文書タブを開く（再承認後の order_version 確認など）。 */
export async function openOrderFromList(page: Page, id: string): Promise<string> {
  await openFromList(page, id);
  const yamlTab = page.locator('#din .ptabs button', { hasText: '注文書' });
  await yamlTab.click();
  await page.waitForSelector('#din pre.yaml', { timeout: 20_000 });
  return (await page.locator('#din pre.yaml').innerText()).trim();
}

export async function closeModal(page: Page): Promise<void> {
  if ((await page.locator('#modal.open [data-a="closeModal"]').count()) > 0) {
    await page.click('#modal.open [data-a="closeModal"]');
  }
}

export async function closeDrawer(page: Page): Promise<void> {
  if ((await page.locator('#drawer.open').count()) > 0) {
    await page.click('#din [data-a="closeDrawer"]').catch(async () => {
      await page.keyboard.press('Escape');
    });
    await page.waitForSelector('#drawer.open', { state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }
}

/** API で依頼を作る（画面の登録が本題ではない準備に使う）。 */
export async function createRequestViaApi(
  api: Api,
  opts: { title: string; decides?: Signal; approverUserId: string; approverName: string; applicant: string; criteria?: string[] },
): Promise<ServerRequest> {
  const res = await api.post('/api/requests', {
    title: opts.title,
    kind: 'new_tool',
    deptCode: 'kaijo',
    applicant: opts.applicant,
    problem: 'E2E の準備で作る作り物の依頼（実データは使わない）',
    purpose: '承認プロセスの検証',
    users: ['現場の担当者'],
    places: ['事務所'],
    scope: ['E2E の確認'],
    outOfScope: ['本番データ'],
    criteria: opts.criteria ?? ['検証用の条件が満たされる'],
    decides: opts.decides ?? 'g',
    dataHandling: [],
    parties: 'internal',
    constraints: [],
    constraintsOther: [],
    approvals: [],
    approver: opts.approverName,
    approverUserId: opts.approverUserId,
  });
  expect(res.status, `依頼を作成できません: ${res.text.slice(0, 300)}`).toBe(201);
  return res.body.request as ServerRequest;
}

/** API で状態を進める（準備・後片付け用。P0 の判定は画面で行う）。 */
export async function transitionViaApi(
  api: Api,
  id: string,
  to: Status,
  opts: { reason?: string; signal?: Signal; redAck?: boolean } = {},
): Promise<ServerRequest> {
  const now = await serverRequest(api, id);
  const res = await api.post(`/api/requests/${encodeURIComponent(id)}/transitions`, {
    to,
    version: now.version,
    reason: opts.reason ?? '',
    ...(opts.signal ? { signal: opts.signal } : {}),
    checklistAcknowledged: true,
    redAcknowledged: opts.redAck ?? true,
  });
  expect(res.status, `状態を ${to} にできません: ${res.text.slice(0, 300)}`).toBe(200);
  // /transitions の応答は { detail: RequestDetail, warnings }。detail が依頼そのもの。
  return res.body.detail as ServerRequest;
}

/** 本番・Staging の後片付け。依頼を理由付きで取消す（削除はしない）。 */
export async function cancelRequest(api: Api, id: string, reason: string): Promise<void> {
  const now = await serverRequest(api, id);
  if (['cancel', 'hold'].includes(now.status)) return;
  const res = await api.post(`/api/requests/${encodeURIComponent(id)}/transitions`, {
    to: 'cancel',
    version: now.version,
    reason,
    checklistAcknowledged: true,
    redAcknowledged: true,
  });
  if (res.status !== 200) throw new Error(`取消できません（${id}）: ${res.text.slice(0, 200)}`);
}

export async function auditLogs(api: Api, limit = 500): Promise<{ items: any[]; chain: any }> {
  const res = await api.get(`/api/audit-logs?limit=${limit}`);
  expect(res.status, '監査ログを取得できません').toBe(200);
  return res.body as { items: any[]; chain: any };
}

/** 監査ハッシュ連鎖の検証（db:verify）。層①だけが DB へ直接実行できる。 */
export function runDbVerify(): { ok: boolean; output: string } {
  const url = process.env.E2E_DB_URL;
  if (!url) throw new Error('E2E_DB_URL がありません（db:verify は層①だけで実行します）');
  try {
    const output = execFileSync('pnpm', ['-s', 'exec', 'tsx', 'scripts/db.ts', 'verify'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` };
  }
}

/** ログアウト後、再アクセスでログインを求められることを確かめる。 */
export async function logoutAndExpectLogin(
  page: Page,
  layer: Layer = LAYER,
): Promise<{ afterLogoutPath: string; reaccessPath: string; bodyText: string }> {
  await closeModal(page);
  await closeDrawer(page);
  await page.click('#logoutbtn');
  await page.waitForSelector('#modal.open');
  await page.click('#modal [data-a="cfok"]');
  await page.waitForURL(/\/(login|cdn-cgi\/access\/logout)|cloudflareaccess\.com/, { timeout: 30_000 });
  const afterLogoutPath = new URL(page.url()).pathname;
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000);
  const reaccessPath = new URL(page.url()).pathname;
  const bodyText = (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).slice(0, 500);
  await expect(page.locator('#nav'), 'ログアウト後もアプリの画面が出ている').toHaveCount(0);
  if (layer === 'iso') {
    await page.waitForSelector('#form', { timeout: 20_000 });
    expect(reaccessPath).toBe('/login');
  } else {
    // Cloudflare Access のログイン（OTP）画面に戻る。アプリのシェルは出ない。
    expect(`${reaccessPath} ${bodyText}`).toMatch(/login|Access|access|メール|Sign in|ログイン/i);
  }
  return { afterLogoutPath, reaccessPath, bodyText };
}

/** 層①だけで使う: パスワードで新しいセッションを作る（層②③は OTP が要るため使わない）。 */
export async function loginWithPassword(
  browser: Browser,
  email: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page }> {
  expect(IS_ISO, 'パスワードログインは層①だけで使う（層②③は OTP）').toBe(true);
  expect(email, 'E2E_ADMIN_EMAIL / E2E_USER_EMAIL がありません').not.toBe('');
  expect(password, 'E2E_ADMIN_PASSWORD / E2E_USER_PASSWORD がありません').not.toBe('');
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('#nav', { timeout: 30_000 });
  return { context, page };
}
