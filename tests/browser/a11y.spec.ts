import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 主要画面のアクセシビリティ自動検査（サーバ不要・全通信横取り）。
 *
 * `tests/browser/approver.spec.ts` と同じ方式で `src/web/index.html` /
 * `src/web/public/*.js` をそのまま読み込み、通信はすべて横取りする。
 * 実DB・実サーバ・本番/Staging・メールには一切接続しない（作り物のデータのみ）。
 *
 * 失敗にするのは axe-core の serious / critical だけ。moderate / minor は
 * 記録しない（既存画面の moderate を緑にするためにフィルタを緩めない）。
 * 既知の除外は「ルール + 対象要素」で最小に絞り、理由を docs/test.md と
 * docs/limitations.md（W-10）に記録する。
 */

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
  title: '架空のアクセシビリティ確認',
  applicant: user.displayName,
  applicantUserId: A,
  deptCode: 'dx',
  kind: 'new_tool',
  problem: '架空メモの整理を確認する',
  purpose: '主要画面のアクセシビリティを確認する',
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

async function mount(page: Page, options: { item?: ReturnType<typeof request> } = {}) {
  const item = options.item;
  const boot = {
    user,
    role: 'desk',
    csrf: 'synthetic-csrf',
    seq: item ? 1 : 0,
    items: item ? [item] : [],
    drafts: [],
    ops: null,
    approvers,
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'approver.test') return route.abort();
    if (url.pathname === '/') {
      const template = readFileSync(resolve('src/web/index.html'), 'utf8');
      const html = template.replace(
        '<!--MSF_BOOT-->',
        `<script type="application/json" id="msf-boot">${JSON.stringify(boot).replaceAll('<', '\\u003c')}</script>`,
      );
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.pathname === '/login') {
      return route.fulfill({ contentType: 'text/html', body: readFileSync(resolve('src/web/public/login.html'), 'utf8') });
    }
    if (url.pathname === '/login.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(resolve('src/web/public/login.js'), 'utf8'),
      });
    }
    if (url.pathname === '/bridge.js' || url.pathname === '/console.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(resolve('src/web/public' + url.pathname), 'utf8'),
      });
    }
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user } });
    if (url.pathname === '/api/auth/role') return route.fulfill({ json: { user } });
    if (url.pathname === '/api/approvers') return route.fulfill({ json: { items: approvers } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { items: [], version: 1 } });
    return route.fulfill({ status: 404, body: '' });
  });
}

/** 画面遷移アニメーション（.view の opacity）が終わるまで待つ。無限アニメは対象外。 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => {
      const end = a.effect?.getComputedTiming().endTime;
      return typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await page.waitForTimeout(120);
}

type AxeResults = Awaited<ReturnType<InstanceType<typeof AxeBuilder>['analyze']>>;
type Violation = AxeResults['violations'][number];
type ViolationNode = Violation['nodes'][number];

interface KnownExclusion {
  /** 対象画面。'*' は全画面。 */
  screen: string;
  /** axe-core のルールID。 */
  rule: string;
  /** axe の target と完全一致、または target の末尾一致（.kd のような可変パス用）。 */
  target: string | RegExp;
  /** 除外する理由（docs/test.md・docs/limitations.md W-10 と同じ内容）。 */
  reason: string;
  /** 解消先（Backlog / Issue / W-item）。 */
  tracking: string;
}

const KNOWN_EXCLUSIONS: KnownExclusion[] = [
  {
    screen: '*',
    rule: 'color-contrast',
    target: '.offline',
    reason:
      '「完全オフライン」バッジの緑（#1f9d55）on 淡緑（#e1f4e8）は 3.04:1。配色は原本（ベンダー）側で、画面の意味は変わらない。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'console-home',
    rule: 'color-contrast',
    target: /\.tm > \.kd$/,
    reason: '運用タイルの種別チップ（.kd、11px 太字）の teal on 淡teal は 2.87:1。文字が小さく原本の意匠。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'approver-select',
    rule: 'color-contrast',
    target: '.big > small',
    reason: '承認者選択の見出し横「時間／月」（13px 太字）の teal on 白は 3.32:1。見出しの補助表示。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'approver-select',
    rule: 'label',
    target: 'input[type="date"]',
    reason: '希望時期の日付入力に可視ラベルが無い（placeholder も空）。原本の入力欄で、編集時の文脈は直前の見出しにある。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'approver-select',
    rule: 'label',
    target: '#att',
    reason: '添付ファイル入力に可視ラベルが無い。選択後にファイル名を別要素（#attL）へ表示する原本の作り。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'approver-select',
    rule: 'scrollable-region-focusable',
    target: 'dl',
    reason: '注文書プレビュー（.order dl、max-height 330px + overflow:auto）にキーボードのフォーカスが乗らない。原本CSSの意匠。',
    tracking: 'W-10 / Backlog 6',
  },
  {
    screen: 'approver-select',
    rule: 'select-name',
    target: 'select[data-bind="approverUserId"]',
    reason: '承認者選択の select にアクセシブル名が無い。直前に承認者の見出しがあるため読み上げの文脈はあるが、名前は未設定。',
    tracking: 'W-10 / Backlog 6',
  },
];

function matchesTarget(target: readonly unknown[], pattern: string | RegExp): boolean {
  const joined = target.join(' ');
  if (typeof pattern === 'string') return joined === pattern;
  return pattern.test(joined);
}

/**
 * serious / critical だけを対象にし、既知の除外（ルール + 対象要素）だけを取り除く。
 * 除外に合致しないノードが1つでも残れば、その違反は失敗として残す。
 */
function remainingViolations(violations: Violation[], screen: string) {
  const exclusions = KNOWN_EXCLUSIONS.filter((e) => e.screen === screen || e.screen === '*');
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((violation) => {
      const allowed = (node: ViolationNode) =>
        exclusions.some((e) => e.rule === violation.id && matchesTarget(node.target, e.target));
      const nodes = violation.nodes.filter((node) => !allowed(node));
      return { ...violation, nodes };
    })
    .filter((violation) => violation.nodes.length > 0);
}

function formatViolations(violations: ReturnType<typeof remainingViolations>): string {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `  - ${n.target.join(' ')}\n    ${(n.failureSummary ?? '').split('\n').join(' / ')}`).join('\n'),
    )
    .join('\n\n');
}

async function expectNoSeriousViolations(page: Page, screen: string, scope?: string): Promise<void> {
  let builder = new AxeBuilder({ page });
  if (scope) builder = builder.include(scope);
  const results = await builder.analyze();
  // 検査が空振りしていないこと（ページが読み込めていないのに緑、を防ぐ）。
  expect(results.passes.length).toBeGreaterThan(0);
  const remaining = remainingViolations(results.violations, screen);
  expect(remaining, `アクセシビリティ違反（serious/critical）: ${screen}\n${formatViolations(remaining)}`).toEqual([]);
}

async function wizardToApprover(page: Page) {
  await page.getByRole('button', { name: '新しい依頼', exact: true }).click();
  await page.getByRole('button', { name: '新しい道具がほしい', exact: false }).click();
  await page.locator('#next').click();
  await page.getByRole('button', { name: '現場の担当者', exact: true }).click();
  await page.getByRole('button', { name: '事務所', exact: true }).click();
  await page.locator('#next').click();
  await page.locator('[data-bind="title"]').fill('架空のアクセシビリティ確認');
  await page.locator('[data-bind="problem"]').fill('架空のメモを整理する');
  await page.locator('[data-bind="purpose"]').fill('主要画面のアクセシビリティを確認する');
  await page.locator('#next').click();
  await page.locator('[data-bind="scope"]').fill('架空メモの記録');
  await page.locator('#next').click();
  await page.locator('[data-crit]').first().fill('再読込後に1件表示される');
  await page.locator('#next').click();
  await page.locator('[data-one="decides"][data-v="g"]').click();
  await page.locator('#next').click();
}

async function openDetail(page: Page) {
  await page.locator('button[data-v="list"]').click();
  await page.locator('tr').filter({ hasText: '架空のアクセシビリティ確認' }).click();
  await page.locator('#drawer.show').waitFor();
}

test.describe('主要画面のアクセシビリティ（axe-core serious/critical）', () => {
  test('ログイン画面', async ({ page }) => {
    await mount(page);
    await page.goto('http://approver.test/login');
    await page.getByRole('button', { name: 'ログイン' }).waitFor();
    await settle(page);
    await expectNoSeriousViolations(page, 'login');
  });

  test('コンソール初期表示', async ({ page }) => {
    await mount(page);
    await page.goto('http://approver.test/');
    await page.locator('button[data-v="home"]').waitFor();
    await settle(page);
    await expectNoSeriousViolations(page, 'console-home');
  });

  test('依頼詳細（ドロワー）', async ({ page }) => {
    await mount(page, { item: request() });
    await page.goto('http://approver.test/');
    await page.locator('button[data-v="home"]').waitFor();
    await openDetail(page);
    await settle(page);
    await expectNoSeriousViolations(page, 'request-detail', '#drawer');
  });

  test('注文書タブ', async ({ page }) => {
    await mount(page, { item: request() });
    await page.goto('http://approver.test/');
    await page.locator('button[data-v="home"]').waitFor();
    await openDetail(page);
    await page.locator('[data-dt="yaml"]').click();
    await page.locator('#drawer pre.yaml').waitFor();
    await settle(page);
    await expectNoSeriousViolations(page, 'order-tab', '#drawer');
  });

  test('承認者選択（ウィザード6）', async ({ page }) => {
    await mount(page);
    await page.goto('http://approver.test/');
    await page.locator('button[data-v="home"]').waitFor();
    await wizardToApprover(page);
    await page.locator('select[data-bind="approverUserId"]').waitFor();
    await settle(page);
    await expectNoSeriousViolations(page, 'approver-select');
  });
});
