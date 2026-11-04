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
 * - 件数（全 N 件）はサーバの total を使う
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

/** サーバの一覧応答（`GET /api/requests` の items）と同じ形の作り物。 */
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
}

async function mount(page: Page, options: MountOptions = {}): Promise<Call[]> {
  const calls: Call[] = [];
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
    // 起動データは空にして、一覧はサーバの絞り込み結果だけで描かせる（変換の経路も通す）
    items: [],
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
        // サーバの絞り込みと同じ規則（部署・状態・色は AND、色は「決定 ?? 候補」）
        let items = RECORDS.slice();
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
        return route.fulfill({
          json: { items: items.slice(start, start + pageSize), total, page, pageSize },
        });
      }
      return route.fulfill({ json: { items: [], version: 1 } });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://list.test/');
  await expect(page.locator('button[data-v="home"]')).toBeVisible();
  return calls;
}

const listCalls = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/requests?'));

async function openList(page: Page): Promise<void> {
  await page.locator('button[data-v="list"]').click();
  await expect(page.locator('#view')).toContainText('一覧');
}

test('色の絞り込みはサーバへ signal で送り、返った行をそのまま描く（画面では濾さない）', async ({ page }) => {
  const calls = await mount(page);
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
  await mount(page);
  await openList(page);
  await page.selectOption('#lc', 'y');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0002');
  await expect(page.locator('#ltb')).toContainText('REQ-2026-0003');
  await expect(page.locator('#ltb')).not.toContainText('REQ-2026-0001');
  await expect(page.locator('#view')).toContainText('2 件 ／ 全 2 件');
});

test('部署と状態の絞り込みもサーバへ送り、AND になる', async ({ page }) => {
  const calls = await mount(page);
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
  await mount(page, { failList: true });
  await openList(page);
  await page.selectOption('#lc', 'r');
  await expect(page.locator('#view')).toContainText('一覧を取得できませんでした（試験）');
});
