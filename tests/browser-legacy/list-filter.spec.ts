import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 一覧の絞り込みがサーバ（SQL）で効くことの画面試験（L-08）。
 *
 * `tests/browser/admin-users.spec.ts` と同じ方式で、`src/web/index.html` と
 * `src/web/public/*.js` をそのまま読み込み、通信はすべて横取りする。
 * 実DB・実サーバ・本番/Staging・メールには一切接続しない（作り物のデータのみ）。
 *
 * 確かめること:
 * - 部署・状態・色の絞り込みは、`GET /api/requests` のクエリとしてサーバへ送る
 * - 取得した全件を画面で濾さない（サーバが返した行をそのまま描く）
 * - 表示はサーバの最新（状態・件名・決定色）。ただし未同期の編集は消さない
 * - 起動データに無い依頼（別の端末で作られた等）でも、詳細を開ける（作り直しの POST をしない）
 * - 条件を行き来したとき、遅れて届いた古い応答を採用しない
 * - 表示の上限までしか出していないときは、そのことを隠さない
 * - サーバが失敗したら、空の一覧にせず理由を出す
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';

interface ApiRecord {
  [key: string]: unknown;
  id: string;
  status: string;
  deptCode: string;
  signalDecided: string | null;
  suggested: string;
}

/**
 * サーバのレコード（一覧の items / 詳細の request）と同じ形の作り物。
 * 起動データにも同じ形で置く（画面はブリッジの変換を通して読む）。
 */
function apiRecord(over: Record<string, unknown>): ApiRecord {
  return {
    id: 'REQ-2026-0001',
    seq: 1,
    year: 2026,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    applicant: '架空 太郎',
    applicantUserId: null,
    deptCode: 'kaijo',
    deptName: '海洋部',
    contact: null,
    title: '合成の依頼',
    kind: 'improve_tool',
    toolId: null,
    toolName: null,
    problem: '合成の困りごと',
    purpose: '合成の目的',
    users: ['現場の担当者'],
    people: 3,
    places: [],
    scope: ['合成の作るもの'],
    outOfScope: [],
    criteria: ['合成の合格条件'],
    decides: 'g',
    dataHandling: [],
    parties: 'internal',
    constraints: [],
    constraintsOther: [],
    approvals: [],
    frequency: 'w',
    minutesPerTime: 10,
    dataReady: 5,
    spread: 3,
    wishDate: null,
    approver: '架空 承認者',
    approverUserId: null,
    status: 'received',
    signalDecided: null,
    tailoring: null,
    orderVersion: 0,
    version: 1,
    deleted: false,
    issueNo: null,
    targetRepoId: null,
    history: [],
    comments: [],
    // 一覧の summary が付ける項目
    suggested: 'g',
    measure: 1,
    staleDays: 1,
    staleLevel: 'ok',
    yourTurn: { target: false, action: '' },
    nextBy: 'desk',
    approverIsMe: true,
    ...over,
  } as ApiRecord;
}

/**
 * 作り物の3件。
 * - 0001: 候補は「赤」だが、画面の判定材料（decides='g'・データなし・社内）だけなら「青」。
 *   色で画面が濾していたら消える行。サーバの赤で残ることを確かめる。
 * - 0002: 承認者の決定が「黄」（候補は青）。決定が候補より優先される。
 * - 0003: 候補が「黄」の道具（DX推進部）。
 */
const RECORDS: ApiRecord[] = [
  apiRecord({ id: 'REQ-2026-0001', suggested: 'r', title: '合成の赤' }),
  apiRecord({
    id: 'REQ-2026-0002',
    suggested: 'g',
    signalDecided: 'y',
    title: '合成の黄（決定）',
    status: 'wait',
  }),
  apiRecord({ id: 'REQ-2026-0003', suggested: 'y', deptCode: 'dx', title: '合成の黄（候補）' }),
];

interface Call {
  method: string;
  url: string;
}

interface MountOptions {
  failList?: boolean;
  /** 起動データ（ブリッジが画面の依頼へ変換する）。省略すると空。 */
  bootItems?: ApiRecord[];
  /** 詳細（`GET /api/requests/:id`）の応答。無い id は 404。 */
  details?: Record<string, ApiRecord>;
  /**
   * 一覧の応答。省略すると RECORDS をサーバの絞り込みと同じ規則で返す。
   * `seq` は同じ signal での取得回数（1 が最初）。
   */
  list?: (url: URL, seq: number) => { items: ApiRecord[]; total: number; page: number; pageSize: number };
  /**
   * 指定した signal の**最初の**一覧取得を、releaseHold() まで保留する。
   * 条件を A→B→A と変えたあとに古い応答を返し、それが採用されないことを確かめるための門。
   */
  holdFirstSignal?: string;
  /** 指定した id の詳細 GET を、releaseDetail() まで保留する。 */
  holdDetail?: string;
}

function filterRecords(records: ApiRecord[], url: URL): { items: ApiRecord[]; total: number; page: number; pageSize: number } {
  let items = records.slice();
  const dept = url.searchParams.get('dept');
  if (dept) items = items.filter((r) => r.deptCode === dept);
  const status = url.searchParams.get('status');
  if (status) items = items.filter((r) => status.split(',').includes(r.status));
  const signal = url.searchParams.get('signal');
  if (signal) items = items.filter((r) => (r.signalDecided ?? r.suggested) === signal);
  const total = items.length;
  const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') ?? '50'), 1), 500);
  const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize };
}

interface Mounted {
  calls: Call[];
  /** holdFirstSignal で保留した最初の応答を返す（古い応答をあとから届かせる）。 */
  releaseHold: () => void;
  /** holdDetail で保留した詳細応答を返す。 */
  releaseDetail: () => void;
}

async function mount(page: Page, options: MountOptions = {}): Promise<Mounted> {
  const calls: Call[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseDetail = () => {};
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  const signalCounts = new Map<string, number>();
  const boot = {
    user: {
      id: USER_ID,
      displayName: '架空 受付',
      email: 'desk@example.com',
      deptCode: 'kaijo',
      isAdmin: false,
      roles: ['requester', 'desk', 'approver'],
      actingRole: 'desk',
    },
    role: 'desk',
    csrf: 'synthetic-csrf',
    seq: 3,
    items: options.bootItems ?? [],
    drafts: [],
    ops: null,
    approvers: [],
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'list.test') return route.abort();
    if (url.pathname === '/') {
      const template = readFileSync(resolve('src/web/index.html'), 'utf8');
      const html = template.replace(
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
      calls.push({ method: req.method(), url: url.pathname + url.search });
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: boot.user } });
      if (url.pathname === '/api/auth/csrf') return route.fulfill({ json: { csrf: 'synthetic-csrf' } });
      if (url.pathname === '/api/auth/role') return route.fulfill({ json: { user: boot.user } });
      if (url.pathname === '/api/approvers') return route.fulfill({ json: { items: [] } });
      if (url.pathname === '/api/requests' && req.method() === 'GET') {
        if (options.failList) {
          return route.fulfill({
            status: 500,
            json: { error: { code: 'ERR-900', message: '一覧を取得できませんでした（試験）' } },
          });
        }
        const signal = url.searchParams.get('signal') ?? '';
        const seq = (signalCounts.get(signal) ?? 0) + 1;
        signalCounts.set(signal, seq);
        if (options.holdFirstSignal === signal && seq === 1) await gate; // 古い応答は release まで届けない
        const res = options.list ? options.list(url, seq) : filterRecords(RECORDS, url);
        return route.fulfill({ json: res });
      }
      if (url.pathname.startsWith('/api/requests/') && req.method() === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/requests/'.length).split('/')[0] ?? '');
        const found = options.details?.[id];
        if (!found) return route.fulfill({ status: 404, json: { error: { code: 'ERR-404', message: '見つかりません' } } });
        if (options.holdDetail === id) await detailGate;
        return route.fulfill({ json: { request: found } });
      }
      return route.fulfill({ json: { items: [], version: 1 } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://list.test/');
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  return { calls, releaseHold: () => release(), releaseDetail: () => releaseDetail() };
}

const listCalls = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/requests?'));
const detailCalls = (calls: Call[]) =>
  calls.filter(
    (c) => c.method === 'GET' && c.url.startsWith('/api/requests/') && /^\/api\/requests\/REQ-\d{4}-\d{4}$/.test(c.url),
  );
const postCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url === '/api/requests');

async function openList(page: Page): Promise<void> {
  await page.locator('button[data-v="list"]').click();
  await expect(page.locator('#view')).toContainText('一覧');
}

test('色の絞り込みはサーバへ signal で送り、返った行をそのまま描く（画面では濾さない）', async ({ page }) => {
  const { calls } = await mount(page, { bootItems: [] });
  await openList(page);

  // 絞り込み無しでは、サーバへ一覧を取りに行かない（従来どおり起動データを描く）
  expect(listCalls(calls)).toHaveLength(0);

  await page.selectOption('#lc', 'r');
  // サーバが「赤」と言った行（画面の判定材料では青）が、そのまま出る
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0001');
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0002');
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0003');
  await expect(page.locator('#view')).toContainText('1 件 ／ 全 1 件');

  const sent = listCalls(calls);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.at(-1)?.url).toContain('signal=r');
  expect(sent.at(-1)?.url).toContain('pageSize=500');
});

test('承認者の決定は候補より優先される（決定黄の依頼が黄で出る）', async ({ page }) => {
  await mount(page, { bootItems: [] });
  await openList(page);
  await page.selectOption('#lc', 'y');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0002');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0003');
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0001');
  await expect(page.locator('#view')).toContainText('2 件 ／ 全 2 件');
});

test('部署と状態の絞り込みもサーバへ送り、AND になる', async ({ page }) => {
  const { calls } = await mount(page, { bootItems: [] });
  await openList(page);

  await page.selectOption('#ld', 'kaijo');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0001');
  expect(listCalls(calls).at(-1)?.url).toContain('dept=kaijo');

  await page.selectOption('#ls', 'wait');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0002');
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0001');
  const url = listCalls(calls).at(-1)?.url ?? '';
  expect(url).toContain('dept=kaijo');
  expect(url).toContain('status=wait');
  await expect(page.locator('#view')).toContainText('1 件 ／ 全 1 件');
});

test('サーバが失敗したら、空の一覧にせず理由を出す', async ({ page }) => {
  await mount(page, { bootItems: [], failList: true });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#view')).toContainText('一覧を取得できませんでした（試験）');
});

test('表示はサーバの最新（状態・件名・決定色）。手元の古い写しを優先しない', async ({ page }) => {
  // 起動データは古い（受付・決定なし・題名も古い）。一覧のサーバ応答は最新（承認待ち・赤・題名も新しい）。
  const stale = apiRecord({
    id: 'REQ-2026-0002',
    title: '古い題名',
    status: 'received',
    signalDecided: null,
    suggested: 'g',
  });
  const fresh = apiRecord({
    id: 'REQ-2026-0002',
    title: '新しい題名',
    status: 'wait',
    signalDecided: 'r',
    suggested: 'y',
    version: 2, // サーバの方が版が進んでいる
  });
  const { calls } = await mount(page, {
    bootItems: [stale],
    list: (url) => filterRecords([fresh], url),
    details: { 'REQ-2026-0002': fresh },
  });
  await openList(page);

  // 絞り込み前（起動データ）は、手元の値のまま
  await expect(page.locator('#ltb')).toContainText('古い題名');

  await page.selectOption('#lc', 'r');
  // サーバの最新で描く（古い「受付・青・古い題名」を残さない）
  await expect(page.locator('#ltb')).toContainText('新しい題名');
  await expect(page.locator('#ltb')).not.toContainText('古い題名');
  await expect(page.locator('#ltb')).toContainText('承認待ち');
  expect(detailCalls(calls)).toHaveLength(0); // 一覧の応答だけで描く（依頼ごとの取り直しはしない）

  // 詳細も、版が進んでいれば取り直してから開く（古い手元を最新として出さない）
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0002' }).click();
  await expect(page.locator('#drawer')).toContainText('新しい題名');
  expect(detailCalls(calls).some((c) => c.url === '/api/requests/REQ-2026-0002')).toBe(true);
  expect(postCalls(calls)).toHaveLength(0);
});

test('詳細の取り直しに失敗したら、古い内容を最新として出さない', async ({ page }) => {
  const stale = apiRecord({
    id: 'REQ-2026-0002',
    title: '古い題名',
    status: 'received',
    signalDecided: null,
    suggested: 'g',
  });
  const fresh = apiRecord({
    id: 'REQ-2026-0002',
    title: '新しい題名',
    status: 'wait',
    signalDecided: 'r',
    suggested: 'y',
    version: 2,
  });
  // 詳細は取れない（404）
  await mount(page, { bootItems: [stale], list: (url) => filterRecords([fresh], url) });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#ltb')).toContainText('新しい題名');

  await page.locator('#ltb tr', { hasText: 'REQ-2026-0002' }).click();
  // 読み込み中のまま古い内容を出さず、失敗を理由つきで出す
  await expect(page.locator('#drawer')).toContainText('依頼を読み込めませんでした');
  await expect(page.locator('#drawer')).not.toContainText('古い題名');
});

test('起動データに無い依頼でも詳細を開ける（作り直しの POST をしない）', async ({ page }) => {
  const existing = apiRecord({
    id: 'REQ-2026-0001',
    title: '既存の依頼',
    suggested: 'g',
    history: [{ at: '2026-11-01T00:00:00.000Z', actorName: '架空 太郎', role: 'desk', action: '受付', note: null }],
  });
  const onlyInList = apiRecord({ id: 'REQ-2026-0009', title: '別端末で作られた依頼', suggested: 'r' });
  const detail = apiRecord({
    id: 'REQ-2026-0009',
    title: '別端末で作られた依頼',
    suggested: 'r',
    history: [{ at: '2026-11-03T00:00:00.000Z', actorName: '架空 花子', role: 'desk', action: '受付', note: null }],
    comments: [{ at: '2026-11-03T01:00:00.000Z', by: '架空 承認者', text: '合成のコメント' }],
  });
  const { calls } = await mount(page, {
    bootItems: [existing],
    list: (url) => filterRecords([onlyInList], url),
    details: { 'REQ-2026-0009': detail },
  });
  await openList(page);

  // 既存の依頼は、これまでどおり起動データから開く
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0001' }).click();
  await expect(page.locator('#drawer')).toContainText('既存の依頼');
  await page.locator('#dx').click();

  // 一覧にだけ出る依頼は、詳細を取り直して開く（閉じない・履歴とコメントが欠けない）
  await page.selectOption('#lc', 'r');
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0009' }).click();
  await expect(page.locator('#drawer')).toContainText('別端末で作られた依頼');
  // コメントと履歴も詳細から来ている（空で上書きしない）
  await page.locator('#drawer [data-dt="log"]').click();
  await expect(page.locator('#drawer')).toContainText('合成のコメント');
  await expect(page.locator('#drawer')).toContainText('受付');
  expect(detailCalls(calls).some((c) => c.url === '/api/requests/REQ-2026-0009')).toBe(true);
  expect(postCalls(calls)).toHaveLength(0); // 作り直し（二重の POST）をしない

  // 画面の依頼に 1 件だけ加わり、2 回目も開ける（増殖しない）
  const countLocal = () =>
    page.evaluate(
      () =>
        (window as unknown as { __MSF_UI__: { data: () => { items: { id: string }[] } } }).__MSF_UI__
          .data()
          .items.filter((x) => x.id === 'REQ-2026-0009').length,
    );
  expect(await countLocal()).toBe(1);
  await page.locator('#dx').click();
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0009' }).click();
  await expect(page.locator('#drawer')).toContainText('別端末で作られた依頼');
  expect(await countLocal()).toBe(1);
});

test('A→B→A と切り替えたあと、保留していた古い応答を返しても採用しない', async ({ page }) => {
  const oldRed = apiRecord({ id: 'REQ-2026-0001', title: '古い赤', suggested: 'r' });
  const newRed = apiRecord({ id: 'REQ-2026-0001', title: '新しい赤', suggested: 'r', version: 3 });
  // 赤の「1 回目」の応答だけを門で止める。2 回目の赤はすぐに新しい内容を返す。
  const { releaseHold } = await mount(page, {
    bootItems: [],
    holdFirstSignal: 'r',
    list: (url, seq) => {
      const items = url.searchParams.get('signal') === 'r' ? (seq === 1 ? [oldRed] : [newRed]) : RECORDS;
      return filterRecords(items, url);
    },
  });
  await openList(page);

  // A（赤・1回目）は保留される
  await page.selectOption('#lc', 'r');
  await page.waitForTimeout(150);
  // B（黄）はすぐ返る
  await page.selectOption('#lc', 'y');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0002');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0003');
  // A へ戻す（2回目の赤は新しい内容）
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#ltb')).toContainText('新しい赤');
  await expect(page.locator('#view')).toContainText('全 1 件');

  // 保留していた 1 回目の赤（古い topic）を、あとから返す
  releaseHold();
  await page.waitForTimeout(500);
  await expect(page.locator('#ltb')).toContainText('新しい赤');
  await expect(page.locator('#ltb')).not.toContainText('古い赤');
  await expect(page.locator('#view')).toContainText('全 1 件');
});

test('表示の上限（5000 件）までしか出していないときは、全件でないことを出す', async ({ page }) => {
  const total = 5200;
  const virtual = Array.from({ length: total }, (_, i) =>
    apiRecord({ id: `REQ-2026-${String(i + 1).padStart(4, '0')}`, suggested: 'r', title: `合成 ${i + 1}` }),
  );
  await mount(page, {
    bootItems: [],
    list: (url) => {
      const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') ?? '50'), 1), 500);
      const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
      const start = (page - 1) * pageSize;
      return { items: virtual.slice(start, start + pageSize), total, page, pageSize };
    },
  });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#view')).toContainText('全 5200 件');
  await expect(page.locator('#view')).toContainText('一覧に出せる上限（5000 件）までを表示しています');
});

test('取り込んだ行は、キーワードを打っても・絞り込みを外しても消えない', async ({ page }) => {
  const onlyInList = apiRecord({ id: 'REQ-2026-0009', title: '別端末で作られた依頼', suggested: 'r' });
  const detail = apiRecord({
    id: 'REQ-2026-0009',
    title: '別端末で作られた依頼',
    suggested: 'r',
    history: [{ at: '2026-11-03T00:00:00.000Z', actorName: '架空 花子', role: 'desk', action: '受付', note: null }],
  });
  const { calls } = await mount(page, {
    bootItems: [],
    list: (url) => filterRecords([onlyInList], url),
    details: { 'REQ-2026-0009': detail },
  });
  await openList(page);

  // 色で絞って、一覧にだけ出る依頼を取り込む（詳細を開く）
  await page.selectOption('#lc', 'r');
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0009' }).click();
  await expect(page.locator('#drawer')).toContainText('別端末で作られた依頼');
  await page.locator('#dx').click();

  // キーワードを打っても残る（該当する語）
  await page.locator('#lq').fill('別端末');
  await page.waitForTimeout(200);
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0009');
  // 該当しない語では消える（検索は従来どおり画面側）
  await page.locator('#lq').fill('該当なし-zzzz');
  await page.waitForTimeout(200);
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0009');
  await page.locator('#lq').fill('');
  await page.waitForTimeout(200);

  // 絞り込みを外しても消えない（画面の依頼に入っている）
  await page.selectOption('#lc', '');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0009');
  // もう一度絞っても出る
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0009');
  expect(postCalls(calls)).toHaveLength(0);
});

test('未同期の編集があっても、サーバの新しい状態・決定色・滞留を反映する', async ({ page }) => {
  const stale = apiRecord({
    id: 'REQ-2026-0002',
    title: '古い題名',
    status: 'received',
    signalDecided: null,
    suggested: 'g',
  });
  const fresh = apiRecord({
    id: 'REQ-2026-0002',
    title: 'サーバの題名',
    status: 'wait',
    signalDecided: 'r',
    suggested: 'y',
    version: 2,
    staleDays: 9,
  });
  await mount(page, { bootItems: [stale], list: (url) => filterRecords([fresh], url), details: { 'REQ-2026-0002': fresh } });
  await openList(page);

  // 題名だけ未送信の編集にする（base と異なる項目）
  await page.evaluate(() => {
    const w = window as unknown as { __MSF_UI__: { data: () => { items: { id: string; title: string }[] } } };
    const item = w.__MSF_UI__.data().items.find((x) => x.id === 'REQ-2026-0002');
    if (item) item.title = '未送信の題名';
  });

  await page.selectOption('#lc', 'r');
  // 未送信の題名は残し、状態・色・滞留はサーバの最新にする（古い「受付・青」を出さない）
  await expect(page.locator('#ltb')).toContainText('未送信の題名');
  await expect(page.locator('#ltb')).not.toContainText('古い題名');
  await expect(page.locator('#ltb')).toContainText('承認待ち');
  await expect(page.locator('#ltb tr', { hasText: '未送信の題名' })).toContainText('赤');
  await expect(page.locator('#ltb tr', { hasText: '未送信の題名' })).toContainText('9日');
});

test('版が同じでも更新時刻が新しければ詳細を取り直す（投入先の変更）', async ({ page }) => {
  const boot = apiRecord({
    id: 'REQ-2026-0002',
    title: '投入先の依頼',
    suggested: 'r',
    version: 1,
    updatedAt: '2026-11-02T00:00:00.000Z',
    targetRepoId: null,
  });
  const fresh = apiRecord({
    id: 'REQ-2026-0002',
    title: '投入先の依頼',
    suggested: 'r',
    version: 1,
    updatedAt: '2026-11-03T00:00:00.000Z',
    targetRepoId: 'repo-new',
  });
  const { calls } = await mount(page, {
    bootItems: [boot],
    list: (url) => filterRecords([fresh], url),
    details: { 'REQ-2026-0002': fresh },
  });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0002' }).click();

  await expect(page.locator('#drawer')).toContainText('投入先の依頼');
  expect(detailCalls(calls).some((c) => c.url === '/api/requests/REQ-2026-0002')).toBe(true);
  const target = await page.evaluate(() => {
    const w = window as unknown as { __MSF_UI__: { data: () => { items: { id: string; __targetRepo: string | null }[] } } };
    return w.__MSF_UI__.data().items.find((x) => x.id === 'REQ-2026-0002')?.__targetRepo ?? null;
  });
  expect(target).toBe('repo-new');
});

test('一覧にだけある依頼の詳細を閉じても、次の同期で取り消さない', async ({ page }) => {
  const onlyInList = apiRecord({ id: 'REQ-2026-0009', title: '別端末で作られた依頼', suggested: 'r' });
  const detail = apiRecord({
    id: 'REQ-2026-0009',
    title: '別端末で作られた依頼',
    suggested: 'r',
    history: [{ at: '2026-11-03T00:00:00.000Z', actorName: '架空 花子', role: 'desk', action: '受付', note: null }],
  });
  const { calls, releaseDetail } = await mount(page, {
    bootItems: [],
    list: (url) => filterRecords([onlyInList], url),
    details: { 'REQ-2026-0009': detail },
    holdDetail: 'REQ-2026-0009',
  });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await page.locator('#ltb tr', { hasText: 'REQ-2026-0009' }).click();
  await page.waitForTimeout(100);
  await page.locator('#dx').click(); // 詳細を読み込む前に閉じる
  releaseDetail();
  await page.waitForTimeout(400);

  // 次の同期を明示的に走らせる。base にだけある依頼を「画面から消えた」と誤判定して
  // 取消（POST /transitions to=cancel）しないこと。
  await page.evaluate(async () => {
    const w = window as unknown as {
      __MSF_UI__: { data: () => unknown };
      __MSF__: { persist: (d: unknown) => Promise<unknown> };
    };
    await w.__MSF__.persist(w.__MSF_UI__.data());
  });
  await page.waitForTimeout(300);
  const transitions = calls.filter((c) => c.method === 'POST' && c.url.includes('/transitions'));
  expect(transitions).toHaveLength(0);
  const count = await page.evaluate(() => {
    const w = window as unknown as { __MSF_UI__: { data: () => { items: { id: string }[] } } };
    return w.__MSF_UI__.data().items.filter((x) => x.id === 'REQ-2026-0009').length;
  });
  expect(count).toBe(1);
});

test('起動データが5000件に達しているときは、絞り込み無しでもサーバの total を使う', async ({ page }) => {
  const total = 5200;
  const virtual = Array.from({ length: total }, (_, i) =>
    apiRecord({ id: `REQ-2026-${String(i + 1).padStart(4, '0')}`, suggested: 'g', title: `合成 ${i + 1}` }),
  );
  await mount(page, {
    bootItems: [],
    list: (url) => {
      const pageSize = Math.min(Math.max(Number(url.searchParams.get('pageSize') ?? '50'), 1), 500);
      const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
      const start = (page - 1) * pageSize;
      return { items: virtual.slice(start, start + pageSize), total, page, pageSize };
    },
  });
  // 起動データが取得上限（5000件）に達した状態を作る（画面はサーバの total を使うべき）
  await page.evaluate(() => {
    const w = window as unknown as { __MSF_UI__: { data: () => { items: unknown[] } } };
    const data = w.__MSF_UI__.data();
    while (data.items.length < 5000) data.items.push({});
  });
  await openList(page);
  await expect(page.locator('#view')).toContainText('全 5200 件');
  await expect(page.locator('#view')).toContainText('一覧に出せる上限（5000 件）までを表示しています');
});
