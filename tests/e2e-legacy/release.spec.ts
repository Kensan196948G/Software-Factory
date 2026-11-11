import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closePool, query } from '../../src/api/db.js';
import { buildPrMarker } from '../../src/shared/devline.js';
import type { DeployDocker, DeployProbe, DeployRunSpec } from '../../src/worker/deploy-docker.js';
import { runDeployOnce } from '../../src/worker/deploy-worker.js';
import { createRunner } from '../../src/worker/fake-runner.js';
import { runOnce } from '../../src/worker/loop.js';
import { FAKE_REPO, FAKE_REPO_ID, startFakeGithub, type FakeGithub } from '../integration/fake-github-server.js';

/**
 * 人の承認 → merge → 検証環境への配備 → 戻しの縦断試験（実ブラウザ＋実 API）。
 *
 * すべて fake: GitHub はローカルの fake サーバ、runner は fake、docker は stub（コンテナを作らない）。
 * この試験の成功は実 GitHub・実 Docker での動作を示さない（実 Docker の部品は tests/docker/devline-deploy.test.ts）。
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

let fake: FakeGithub;
let base = '';
const servers: ChildProcess[] = [];
let pageErrors: string[] = [];

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

/** 試験用の資格情報ファイル（作り物の値。API は投入と同じくファイルから読む）。 */
function fakeSecretsFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'msf-e2e-secrets-')), 'secrets.env');
  writeFileSync(file, 'DEVLINE_GITHUB_TOKEN=fake-token-for-local-test\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

async function startApi(): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('node_modules/.bin/tsx', ['src/api/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      REQUIRE_ORIGIN_SECRET: '0',
      MAIL_MODE: 'file',
      MAIL_APPROVAL_TO: 'approver@example.com',
      MAIL_OUTBOX_DIR: '.mail/e2e-outbox',
      GITHUB_API_URL: fake.url,
      GITHUB_TOKEN: 'fake-token-for-local-test',
      GITHUB_REPO: FAKE_REPO,
      DEVLINE_SECRETS_FILE: fakeSecretsFile(),
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_BASE_URL: url,
      DEVLINE_TARGET_REPOS: `${FAKE_REPO}:${FAKE_REPO_ID}`,
    },
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

/* stub の docker。コンテナは作らず、呼び出しだけを覚える。 */
const containers = new Map<string, DeployRunSpec>();
const images = new Set<string>();
let loads = 0;
/* stub の成果物。CI の run の代わりで、実 GitHub の artifact を使わない。イメージ ID は要求の head から決める。 */
const imageIdOf = (head: string): string => `sha256:${head.padEnd(64, '0')}`;
const docker: DeployDocker = {
  loadImage: async () => {
    loads += 1;
    return { ref: 'sandbox-artifact:ci', id: lastImageId };
  },
  adoptImage: async ({ id }) => {
    images.add(id);
  },
  discardImage: async () => undefined,
  hasImage: async (d) => images.has(d),
  containerState: async (n) => (containers.has(n) ? 'own' : 'none'),
  run: async (spec) => {
    containers.set(spec.name, spec);
    return { baseUrl: 'http://192.0.2.10:8080' };
  },
  remove: async (n) => {
    containers.delete(n);
  },
};
let lastImageId = '';
let probe: DeployProbe = { check: async () => ({ health: true, smoke: true }) };

const deployOnce = (): ReturnType<typeof runDeployOnce> =>
  runDeployOnce({
    owner: 'e2e-stub',
    docker,
    probe,
    artifacts: {
      fetch: async (req) => {
        lastImageId = imageIdOf(req.headSha);
        return {
          ok: true,
          tarPath: '/nonexistent/image.tar',
          imageId: lastImageId,
          runId: req.runId,
          runAttempt: req.runAttempt,
          artifactId: 9001,
          tarSha256: 'e'.repeat(64),
          cleanup: () => undefined,
        };
      },
    },
    clock: () => new Date(),
  });

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

async function setUiRole(page: Page, role: string): Promise<void> {
  await page.selectOption('#role', role);
  await page.waitForTimeout(300);
}

type Detail = { id: string; version: number; orderVersion: number };

async function transition(page: Page, id: string, to: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cur = (await callApi<{ request: Detail }>(page, 'GET', `/api/requests/${id}`)).request;
  await callApi(page, 'POST', `/api/requests/${id}/transitions`, {
    to,
    version: cur.version,
    checklistAcknowledged: true,
    redAcknowledged: true,
    ...extra,
  });
}

/** API で承認 → 投入、fake runner で pr_ready まで進め、ローカルの fake GitHub の PR を載せる。 */
async function prReady(page: Page, title: string): Promise<{ id: string; jobId: string; headSha: string; pr: number }> {
  await setApiRole(page, 'requester');
  const res = await callApi<{ request: Detail }>(page, 'POST', '/api/requests', {
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
  });
  const id = res.request.id;
  await setApiRole(page, 'desk');
  await transition(page, id, 'review');
  await transition(page, id, 'wait');
  await setApiRole(page, 'approver');
  await transition(page, id, 'approved', { signal: 'g' });
  const detail = (await callApi<{ request: Detail }>(page, 'GET', `/api/requests/${id}`)).request;
  await callApi(page, 'POST', `/api/orders/${id}/handoff`, { orderVersion: detail.orderVersion });
  const runner = createRunner('fake', 'success');
  let jobId = '';
  let headSha = '';
  for (let i = 0; i < 8; i += 1) {
    const { rows } = await query<{ id: string; state: string; head_sha: string | null }>(
      'select id, state, head_sha from job where request_id=$1',
      [id],
    );
    jobId = rows[0]?.id ?? '';
    headSha = rows[0]?.head_sha ?? '';
    if (rows[0]?.state === 'pr_ready') break;
    await runOnce({
      owner: 'e2e-fake',
      runner,
      scenario: 'success',
      clock: () => new Date(),
      allowedRepos: [{ name: FAKE_REPO, repoId: FAKE_REPO_ID }],
    });
  }
  expect(headSha).toMatch(/^[0-9a-f]{40}$/);
  const pr = 700 + fake.pulls.length;
  fake.pulls.push({
    number: pr,
    head: headSha,
    body: `${buildPrMarker({ jobId, attemptNo: 1, headSha })}\n\n作り物の PR`,
    state: 'open',
    merged: false,
    mergeSha: null,
  });
  fake.trees[headSha] = 'e'.repeat(40);
  await query(`update job set work_state = work_state || jsonb_build_object('pr', $2::jsonb) where id=$1`, [
    jobId,
    JSON.stringify({ number: pr, url: `${fake.url}/${FAKE_REPO}/pull/${pr}` }),
  ]);
  return { id, jobId, headSha, pr };
}

async function login(page: Page): Promise<void> {
  await page.goto(`${base}/login`);
  await page.getByLabel('メールアドレス').fill(EMAIL);
  await page.getByLabel('パスワード').fill(PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForSelector('button[data-v="home"]');
}

async function reloadAs(page: Page, role: string): Promise<void> {
  await page.reload();
  await page.waitForSelector('button[data-v="home"]');
  await setApiRole(page, role);
  await setUiRole(page, role);
}

async function openDrawer(page: Page, title: string): Promise<Locator> {
  await page.click('button[data-v="list"]');
  await page.waitForTimeout(200);
  await page.locator(`tr:has-text("${title}")`).first().click();
  await expect(page.locator('#drawer')).toHaveClass(/show/);
  return page.locator('#drawer [data-dl-panel]').first();
}

test.skip(!/_test$/.test(dbName), '`_test` で終わる DB でのみ実行する');

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fake = await startFakeGithub();
  base = await startApi();
});

test.afterAll(async () => {
  await Promise.all(servers.map(stop));
  await fake?.close();
  await closePool();
});

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  fake.overrides.length = 0;
  probe = { check: async () => ({ health: true, smoke: true }) };
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // 前の試験の残りを片付ける（試行は古い順に取られる）
  while ((await deployOnce()).kind !== 'idle');
  await login(page);
});

test.afterEach(() => {
  expect(pageErrors, '画面の例外').toEqual([]);
});

test('承認者だけに操作が出る。未承認は「準備完了・承認待ち」で止まり、承認前の merge と配備は API でも拒否される', async ({
  page,
}) => {
  const title = `release-gate-${Date.now()}`;
  const c = await prReady(page, title);
  await reloadAs(page, 'desk');
  const p = await openDrawer(page, title);
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('準備完了・承認待ち');
  await expect(p.locator('[data-dl-release]')).toHaveCount(0);
  await expect(p).not.toContainText('公開済み');

  // 役割が違う・承認前の配備は拒否される
  const denied = await page.evaluate(
    async ([jobId, sha]) => {
      const msf = (window as unknown as { __MSF__: { api: (m: string, p: string, b?: unknown) => Promise<unknown> } }).__MSF__;
      const out: string[] = [];
      for (const [action, body] of [
        ['approve-merge', { headSha: sha }],
        ['approve-deploy', { sha, digest: `sha256:${'0'.repeat(64)}`, environment: 'local-verify' }],
      ] as const) {
        try {
          await msf.api('POST', `/api/jobs/${jobId}/${action}`, body);
          out.push('ok');
        } catch (e) {
          out.push(String((e as { code?: string }).code));
        }
      }
      return out;
    },
    [c.jobId, c.headSha] as const,
  );
  expect(denied).toEqual(['ERR-101', 'ERR-101']);
  await setApiRole(page, 'approver');
  const notMerged = await page.evaluate(
    async ([jobId, sha]) => {
      const msf = (window as unknown as { __MSF__: { api: (m: string, p: string, b?: unknown) => Promise<unknown> } }).__MSF__;
      try {
        await msf.api('POST', `/api/jobs/${jobId}/approve-deploy`, {
          sha,
          digest: `sha256:${'0'.repeat(64)}`,
          environment: 'local-verify',
        });
        return 'ok';
      } catch (e) {
        return String((e as { code?: string }).code);
      }
    },
    [c.jobId, c.headSha] as const,
  );
  expect(notMerged).toBe('ERR-201');
  expect(fake.access.some((a) => a.method === 'PUT')).toBe(false);
  expect(fake.pulls.find((x) => x.number === c.pr)?.merged).toBe(false);
});

test('画面の操作で merge → 成果物 → 配備 → 戻し。完全な SHA と digest と証跡が出る（fake GitHub・stub docker）', async ({
  page,
}) => {
  // 前の版を1つ載せる（API で進める）
  const firstTitle = `release-first-${Date.now()}`;
  const first = await prReady(page, firstTitle);
  await setApiRole(page, 'approver');
  await callApi(page, 'POST', `/api/jobs/${first.jobId}/approve-merge`, { headSha: first.headSha });
  await deployOnce();
  const firstEv = (
    await callApi<{ release: Record<string, { mergeSha: string; imageDigest: string; environment: string }> }>(
      page,
      'GET',
      `/api/requests/${first.id}/jobs`,
    )
  ).release[first.jobId]!;
  await callApi(page, 'POST', `/api/jobs/${first.jobId}/approve-deploy`, {
    sha: firstEv.mergeSha,
    digest: firstEv.imageDigest,
    environment: firstEv.environment,
  });
  await deployOnce();

  const title = `release-flow-${Date.now()}`;
  const c = await prReady(page, title);
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);

  // merge
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('準備完了・承認待ち');
  await expect(p).toContainText(c.headSha);
  await p.locator('[data-dl-release="approve-merge"]').click();
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('merge 済み');
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('ローカルの連携先');
  await expect(p.locator('[data-dl-row="merge"] [data-dl-kind]')).toHaveText('fake');
  const pull = fake.pulls.find((x) => x.number === c.pr)!;
  expect(pull.merged).toBe(true);
  // merge だけでは配備されず、成果物ができるまで配備の操作は出ない
  await expect(p.locator('[data-dl-release="approve-deploy"]')).toHaveCount(0);

  // worker（stub）が CI の成果物を取得して照合する（作らない）
  const loadsBefore = loads;
  expect(await deployOnce()).toMatchObject({ attemptKind: 'build', state: 'succeeded' });
  expect(loads).toBe(loadsBefore + 1);
  await reloadAs(page, 'approver');
  const p2 = await openDrawer(page, title);
  const digest = imageIdOf(c.headSha);
  await expect(p2.locator('[data-dl-row="artifact"]')).toContainText(digest);
  await expect(p2.locator('[data-dl-row="artifact"]')).toContainText('CI で検査した成果物そのもの');
  await expect(p2.locator('[data-dl-row="artifact"]')).toContainText('artifact 9001');
  await expect(p2.locator('[data-dl-row="deploy"]')).toContainText('準備完了・承認待ち');
  await expect(p2).toContainText('local-verify');

  // 配備の承認。worker（stub）が digest をそのまま起動する
  await p2.locator('[data-dl-release="approve-deploy"]').click();
  await expect(p2.locator('[data-dl-release-msg]')).toContainText('配備を受け付けました');
  expect(await deployOnce()).toMatchObject({ attemptKind: 'deploy', state: 'succeeded' });
  expect(loads).toBe(loadsBefore + 1);
  expect(containers.get('msf-sandbox-verify')).toMatchObject({ digest, version: pull.mergeSha });
  // 再読込なしで結果が出る（pending / running の間だけ読み直す）。終わったら読み直しの説明は消える
  await expect(p2.locator('[data-dl-row="deploy"]')).toContainText('配備済み（検証環境）', { timeout: 15_000 });
  await expect(p2.locator('[data-dl-release-msg]')).toHaveCount(0);
  await reloadAs(page, 'approver');
  const p3 = await openDrawer(page, title);
  await expect(p3.locator('[data-dl-row="deploy"]')).toContainText('配備済み（検証環境）');
  await expect(p3.locator('[data-dl-row="deploy"]')).toContainText('このホストからだけ届く内部ネットワークの検証環境');
  await expect(p3.locator('[data-dl-row="deploy"]')).not.toContainText('公開');
  await expect(p3.locator('[data-dl-row="deploy"]')).not.toContainText('本番');
  await expect(p3.locator('[data-dl-row="deploy"]')).toContainText('http://192.0.2.10:8080');
  await expect(p3.locator('[data-dl-row="job"]')).toContainText('配備済み（検証環境）');
  await expect(p3.locator('[data-dl-row="ac-detail"]')).toContainText('AC-1');
  await expect(p3).not.toContainText('公開済み');

  // 戻し（理由が必須）
  const back = p3.locator('[data-dl-release="rollback"]');
  await expect(p3).toContainText(firstEv.imageDigest);
  await back.click();
  await expect(page.locator('.toast, #toast').first()).toContainText('戻す理由');
  await p3.locator('[data-dl-input="rollback-reason"]').fill('見つけた不具合（作り物）');
  await back.click();
  await expect(p3.locator('[data-dl-release-msg]')).toContainText('戻しを受け付けました');
  expect(await deployOnce()).toMatchObject({ attemptKind: 'rollback', state: 'succeeded' });
  expect(containers.get('msf-sandbox-verify')).toMatchObject({ digest: firstEv.imageDigest });
  await reloadAs(page, 'approver');
  const p4 = await openDrawer(page, title);
  await expect(p4.locator('[data-dl-row="rollback"]')).toContainText('前の版へ戻しました');
  await expect(p4.locator('[data-dl-row="rollback"]')).toContainText('見つけた不具合');
  await expect(p4.locator('[data-dl-release="rollback"]')).toHaveCount(0);

  // 証跡の縦断（fake GitHub・stub docker）。再読込の後も同じ順で辿れる
  const rows = await p4.locator('[data-dl-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dl-row')));
  const order = ['issue', 'job', 'ci', 'pr', 'merge', 'artifact', 'deploy', 'rollback'];
  expect(order.map((k) => rows.indexOf(k)).every((v, i, a) => v >= 0 && (i === 0 || v > (a[i - 1] as number)))).toBe(true);
  await expect(p4.locator('[data-dl-row="ac-detail"]')).toContainText('AC-1');
  await expect(p4.locator('[data-dl-row="pr"]')).toContainText(String(c.pr));
  const approvals = p4.locator('[data-dl-row="merge"] [data-dl-approvals]');
  await expect(approvals).toContainText('承認：');
  await expect(approvals).toContainText('申請：');
  await expect(approvals).toContainText(`${FAKE_REPO} PR #${c.pr}`);
  await expect(approvals).toContainText(c.headSha);
  await expect(approvals).toContainText('merge に使用');
  await expect(p4.locator('[data-dl-row="merge"] [data-dl-control-note]')).toContainText('本番の承認統制を満たしません');
  await expect(p4.locator('[data-dl-row="merge"]')).toContainText('ローカルの連携先');
  await expect(p4.locator('[data-dl-row="deploy"] [data-dl-kind]')).toHaveText('fake');
});

test('受付の「完了」だけでは配備済みと表示しない', async ({ page }) => {
  const title = `release-done-only-${Date.now()}`;
  const c = await prReady(page, title);
  await setApiRole(page, 'approver');
  for (const to of ['dev', 'verify', 'field', 'release_wait', 'done']) {
    await transition(page, c.id, to);
  }
  expect((await callApi<{ request: { status: string } }>(page, 'GET', `/api/requests/${c.id}`)).request.status).toBe('done');
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);
  await expect(p.locator('[data-dl-row="deploy"]')).not.toContainText('配備済み');
  await expect(p.locator('[data-dl-row="deploy"]')).toContainText('記録はありません');
  await expect(p.locator('[data-dl-row="artifact"]')).toContainText('記録はありません');
  await expect(p.locator('[data-dl-row="job"]')).not.toContainText('配備済み');
});

test('merge の承認を取り消すと失効の記録が残り、再読込の後も出る', async ({ page }) => {
  const title = `release-revoke-${Date.now()}`;
  const c = await prReady(page, title);
  // GitHub 側の拒否で merge が進まない状態（承認の行は残る）
  fake.pulls.find((x) => x.number === c.pr)!.mergeReply = { status: 405, body: { message: 'not mergeable' } };
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);
  await p.locator('[data-dl-release="approve-merge"]').click();
  await expect(p.locator('[data-dl-release-msg]')).toBeVisible();
  await expect(p.locator('[data-dl-row="merge"] [data-dl-approvals]')).toContainText('有効');
  await p.locator('[data-dl-input="revoke-reason"]').fill('作り物の取消理由');
  await p.locator('[data-dl-release="revoke-approval"]').click();
  await expect(p.locator('[data-dl-release-msg]')).toContainText('承認を取り消しました');
  await reloadAs(page, 'approver');
  const p2 = await openDrawer(page, title);
  const approvals = p2.locator('[data-dl-row="merge"] [data-dl-approvals]');
  await expect(approvals).toContainText('取消で失効');
  await expect(approvals).toContainText('取消の記録');
  await expect(approvals).toContainText('作り物の取消理由');
  await expect(p2.locator('[data-dl-release="revoke-approval"]')).toHaveCount(0);
});

test('配備が health で落ちると前の版へ戻り、失敗として表示する。DevOps の KPI は実の集計', async ({ page }) => {
  const title = `release-fail-${Date.now()}`;
  const c = await prReady(page, title);
  await setApiRole(page, 'approver');
  const before = await callApi<{ stopped: number; mergeWaiting: number }>(page, 'GET', '/api/devline/summary');
  expect(before.mergeWaiting).toBeGreaterThanOrEqual(1);
  await reloadAs(page, 'approver');
  await page.click('button[data-v="devops"]');
  await expect(page.locator('[data-dl-kpi="merge"]')).toHaveText(String(before.mergeWaiting));
  await expect(page.locator('[data-dl-kpi="stopped"]')).toHaveText(String(before.stopped));
  await expect(page.locator('#view')).toContainText('リリース判定待ち（見本）');
  // 見本の数値を実績に見せない
  await page.click('button[data-v="secops"]').catch(() => undefined);
  await expect(page.locator('#view')).toContainText('見本');
  await page.click('button[data-v="devops"]');

  await callApi(page, 'POST', `/api/jobs/${c.jobId}/approve-merge`, { headSha: c.headSha });
  await deployOnce();
  const ev = (
    await callApi<{ release: Record<string, { mergeSha: string; imageDigest: string; environment: string }> }>(
      page,
      'GET',
      `/api/requests/${c.id}/jobs`,
    )
  ).release[c.jobId]!;
  await callApi(page, 'POST', `/api/jobs/${c.jobId}/approve-deploy`, {
    sha: ev.mergeSha,
    digest: ev.imageDigest,
    environment: ev.environment,
  });
  probe = { check: async (_url, sha) => ({ health: sha !== ev.mergeSha, smoke: sha !== ev.mergeSha }) };
  expect(await deployOnce()).toMatchObject({ attemptKind: 'deploy', state: 'failed', errorCode: 'health_failed' });
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);
  await expect(p.locator('[data-dl-row="deploy"]')).toContainText('配備に失敗');
  await expect(p.locator('[data-dl-row="deploy"]')).toContainText(/前の版|消しました/);
  await expect(p.locator('[data-dl-row="job"]')).toContainText('merged');
  await expect(p.locator('[data-dl-row="deploy"]')).not.toContainText('配備済み');
  const after = await callApi<{ stopped: number }>(page, 'GET', '/api/devline/summary');
  expect(after.stopped).toBe(before.stopped + 1);
});

test('merge の結果不明は「照合する」で確定し、作り直さない', async ({ page }) => {
  const title = `release-unknown-${Date.now()}`;
  const c = await prReady(page, title);
  // 接続を切る前に merge を確定させ、応答だけを失う
  const responder = (req: { method: string; path: string }): { status: number; destroy: true } | null => {
    if (req.method === 'PUT' && req.path.endsWith('/merge')) {
      const pull = fake.pulls.find((x) => x.number === c.pr)!;
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeSha = '6'.repeat(40);
      fake.trees[pull.mergeSha] = fake.trees[c.headSha] as string;
      // 直後の読み直しも落とし、結果不明にする
      fake.overrides.unshift(() => ({ status: 0, destroy: true }));
      return { status: 0, destroy: true };
    }
    fake.overrides.unshift(responder);
    return null;
  };
  fake.overrides.push(responder);
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);
  await p.locator('[data-dl-release="approve-merge"]').click();
  await expect(p.locator('[data-dl-release-msg]')).toContainText('照合');
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('結果不明');
  const puts = fake.access.filter((a) => a.method === 'PUT').length;
  await p.locator('[data-dl-release="reconcile-merge"]').click();
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('merge 済み');
  expect(fake.access.filter((a) => a.method === 'PUT').length).toBe(puts);
});

test('merge の結果不明の照合は読むだけ。未 merge なら承認のボタンへ戻り、押すまで送らない', async ({ page }) => {
  const title = `release-unmerged-${Date.now()}`;
  const c = await prReady(page, title);
  // 送信の応答を失う（merge は届いていない）。直後の読み直しも落とす
  const responder = (req: { method: string; path: string }): { status: number; destroy: true } | null => {
    if (req.method === 'PUT' && req.path.endsWith('/merge')) {
      fake.overrides.unshift(() => ({ status: 0, destroy: true }));
      return { status: 0, destroy: true };
    }
    fake.overrides.unshift(responder);
    return null;
  };
  fake.overrides.push(responder);
  await reloadAs(page, 'approver');
  const p = await openDrawer(page, title);
  await p.locator('[data-dl-release="approve-merge"]').click();
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('結果不明');
  const puts = fake.access.filter((a) => a.method === 'PUT').length;
  await p.locator('[data-dl-release="reconcile-merge"]').click();
  await expect(p.locator('[data-dl-release-msg]')).toContainText('PR は未 merge でした');
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('承認待ち');
  await expect(p.locator('[data-dl-release="reconcile-merge"]')).toHaveCount(0);
  expect(fake.access.filter((a) => a.method === 'PUT').length).toBe(puts);
  // 人が押して初めて送る
  await p.locator('[data-dl-release="approve-merge"]').click();
  await expect(p.locator('[data-dl-row="merge"]')).toContainText('merge 済み');
  expect(fake.access.filter((a) => a.method === 'PUT').length).toBe(puts + 1);
  expect(c.pr).toBeGreaterThan(0);
});
