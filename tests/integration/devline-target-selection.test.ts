/**
 * 依頼ごとの投入先リポジトリ（L-12）。
 * 外部はネットワークを使わない fake の IssueAdapter（2 repo）。DB は専用の _test。
 *
 * 固定する契約:
 * - 受理するのは 設定（DEVLINE_TARGET_REPOS）と台帳（DEVLINE_REPO_LEDGER）の**積集合**だけ（外は ERR-405）。
 * - 未指定は従来どおり既定（先頭の repo）。既存の依頼（NULL）は後方互換。
 * - 内容の編集（PATCH /api/requests/:id）で投入先は消えない。無ければ現状維持。
 * - 画面の選択は PATCH /api/requests/:id/devline-target。版と承認を動かさない。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { closePool, query } from '../../src/api/db.js';
import type { DevlineDeps } from '../../src/api/devline-service.js';
import { createFakeIssueAdapter, type FakeIssueAdapter } from '../../src/api/issue-adapter-fake.js';
import type { RepoAllowEntry } from '../../src/shared/devline.js';
import { authHeaders, loginAs, prepareTestDb, sampleRequest, truncateBusiness, type Authed } from './helpers.js';

const A = { name: 'msf-test/repo-a', repoId: '1001' };
const B = { name: 'msf-test/repo-b', repoId: '1002' };
/** 設定（DEVLINE_TARGET_REPOS）には載っているが台帳には無い repo。積集合の外。 */
const C = { name: 'msf-test/repo-c', repoId: '1003' };

const ledger: RepoAllowEntry[] = [
  { name: A.name, repoId: A.repoId, purpose: 'QA の既定（先頭）', private: true },
  { name: B.name, repoId: B.repoId, purpose: 'QA の選択', private: true },
];

const APPROVE = { to: 'approved', signal: 'g', checklistAcknowledged: true, reason: '作り物の承認' };

let app: FastifyInstance;
let adapter: FakeIssueAdapter;
let auth: Authed;
let serial = 0;

/** 新しい投入の既定先は設定の先頭（A）。 */
const deps = (): DevlineDeps => ({
  issueAdapter: adapter,
  targetRepo: A.name,
  allowedRepos: [A, B, C],
  ledger,
  now: () => new Date('2026-11-01T00:00:00Z'),
  httpTimeoutMs: 2000,
});

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  as?: Authed,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method,
    url,
    headers: authHeaders(as ?? auth),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const setRole = async (role: string): Promise<void> => {
  const res = await api('POST', '/api/auth/role', { role });
  expect(res.statusCode, res.body).toBe(200);
};

const detail = async (id: string): Promise<any> => (await api('GET', `/api/requests/${id}`)).json().request;

async function create(overrides: Record<string, unknown> = {}): Promise<any> {
  await setRole('requester');
  serial += 1;
  const res = await api(
    'POST',
    '/api/requests',
    sampleRequest({ approver: 'テスト 太郎', title: `投入先 QA ${serial}`, ...overrides }),
  );
  expect(res.statusCode, res.body).toBe(201);
  await setRole('desk');
  return res.json().request;
}

async function transition(id: string, body: Record<string, unknown>): Promise<void> {
  const current = await detail(id);
  const res = await api('POST', `/api/requests/${id}/transitions`, { version: current.version, ...body });
  expect(res.statusCode, res.body).toBe(200);
}

async function approved(overrides: Record<string, unknown> = {}): Promise<string> {
  const request = await create(overrides);
  await transition(request.id, { to: 'review' });
  await transition(request.id, { to: 'wait' });
  await setRole('approver');
  await transition(request.id, APPROVE);
  await setRole('desk');
  return request.id;
}

const handoff = async (id: string): Promise<LightMyRequestResponse> => {
  const current = await detail(id);
  return api('POST', `/api/orders/${id}/handoff`, { orderVersion: current.orderVersion });
};

const intents = async (id: string): Promise<any[]> =>
  (await query('select * from handoff_intent where request_id=$1 order by order_version', [id])).rows;

const intentStates = async (id: string): Promise<string[]> =>
  (await intents(id)).map((i) => String(i.state));

beforeAll(async () => {
  await prepareTestDb();
  adapter = createFakeIssueAdapter({
    repoIds: { [A.name]: A.repoId, [B.name]: B.repoId, [C.name]: C.repoId },
    baseSha: 'a'.repeat(40),
  });
  app = await buildApp({ serveStatic: false, devlineDeps: deps() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await truncateBusiness();
  await prepareTestDb();
  adapter.issues.length = 0;
  adapter.calls.length = 0;
  serial = 0;
  auth = await loginAs(app, 'requester');
});

describe('作成の受理と拒否（積集合）', () => {
  it('T-21: 積集合の外（未知・台帳だけ・設定だけ）は作成できない', async () => {
    await setRole('requester');
    for (const targetRepoId of ['evil/repo', C.name, 'msf-test/repo-z']) {
      const res = await api('POST', '/api/requests', sampleRequest({ approver: 'テスト 太郎', targetRepoId }));
      expect(res.statusCode, `${targetRepoId}: ${res.body}`).toBe(409);
      expect(res.json().error.code).toBe('ERR-405');
      expect(res.json().error.details).toMatchObject({ targetRepoId });
    }
    const rows = await query<{ c: number }>('select count(*)::int as c from request');
    expect(rows.rows[0]?.c).toBe(0);
  });

  it('T-22: 積集合の中は作成でき、詳細と監査に選択した repoId が残る', async () => {
    const request = await create({ targetRepoId: B.name });
    expect(request.targetRepoId).toBe(B.name);
    expect((await detail(request.id)).targetRepoId).toBe(B.name);
    const audit = await query<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action='request.create' and target_id=$1`,
      [request.id],
    );
    expect(audit.rows[0]?.diff).toMatchObject({ targetRepoId: B.name });
  });

  it('T-23: 未指定は NULL（従来どおり既定＝設定の先頭へ投入）', async () => {
    const request = await create();
    expect(request.targetRepoId).toBeNull();
    await setRole('desk');
    await transition(request.id, { to: 'review' });
    await transition(request.id, { to: 'wait' });
    await setRole('approver');
    await transition(request.id, APPROVE);
    await setRole('desk');
    const res = await handoff(request.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(adapter.issues[0]?.repo).toBe(A.name);
    expect((await intents(request.id))[0].target_repo_id).toBe(A.name);
    expect((await api('GET', `/api/requests/${request.id}/jobs`)).json().currentTargetRepo).toBe(A.name);
  });
});

describe('投入先の反映（handoff）', () => {
  it('T-24: 依頼が選んだ repo へ投入される（既定の repo ではない）', async () => {
    const id = await approved({ targetRepoId: B.name });
    const res = await handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(adapter.issues).toHaveLength(1);
    expect(adapter.issues[0]?.repo).toBe(B.name);
    expect((await intents(id))[0].target_repo_id).toBe(B.name);
    expect((await api('GET', `/api/requests/${id}/jobs`)).json().currentTargetRepo).toBe(B.name);
  });

  it('T-24b: 旧ルート（POST /api/requests/:id/handoff）も同じ投入先を使う', async () => {
    const id = await approved({ targetRepoId: B.name });
    const res = await api('POST', `/api/requests/${id}/handoff`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().issueNo).toBe(adapter.issues[0]?.number);
    expect(adapter.issues[0]?.repo).toBe(B.name);
  });
});

describe('後方互換（既存の依頼と既存のクライアント）', () => {
  it('T-25: 内容の編集で投入先は消えない（本文に targetRepoId が無ければ現状維持）', async () => {
    const request = await create({ targetRepoId: B.name });
    await setRole('desk');
    const patch = await api('PATCH', `/api/requests/${request.id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: request.title, purpose: '作り物の目的を直した' }),
      version: request.version,
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await detail(request.id)).targetRepoId).toBe(B.name);
  });

  it('T-26: 内容の更新では投入先を変えられない（変化する指定は ERR-004。同値の再送は受理）', async () => {
    const request = await create({ targetRepoId: B.name });
    await setRole('desk');
    const changed = await api('PATCH', `/api/requests/${request.id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: request.title, targetRepoId: A.name }),
      version: request.version,
    });
    expect(changed.statusCode, changed.body).toBe(400);
    expect(changed.json().error.code).toBe('ERR-004');
    expect((await detail(request.id)).targetRepoId).toBe(B.name);
    // 同じ値の再送（古い画面）は受理し、列は変わらない
    const same = await api('PATCH', `/api/requests/${request.id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: request.title, targetRepoId: B.name }),
      version: (await detail(request.id)).version,
    });
    expect(same.statusCode, same.body).toBe(200);
    expect((await detail(request.id)).targetRepoId).toBe(B.name);
  });

  it('T-26b: 内容の更新で null（未指定へ戻す）も変えられない（ERR-004）', async () => {
    const request = await create({ targetRepoId: B.name });
    await setRole('desk');
    const patch = await api('PATCH', `/api/requests/${request.id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: request.title, targetRepoId: null }),
      version: request.version,
    });
    expect(patch.statusCode, patch.body).toBe(400);
    expect(patch.json().error.code).toBe('ERR-004');
    expect((await detail(request.id)).targetRepoId).toBe(B.name);
  });

  it('T-27: 既存の NULL の依頼は、編集しても NULL のまま（既定の repo へ投入）', async () => {
    const request = await create();
    await setRole('desk');
    const patch = await api('PATCH', `/api/requests/${request.id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: request.title }),
      version: request.version,
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await detail(request.id)).targetRepoId).toBeNull();
  });
});

describe('食い違いを作れない（投入済みの依頼）', () => {
  it('T-51: 投入済みの依頼は内容の更新でも専用口でも別の repo に変えられない（job / Issue と食い違わない）', async () => {
    const id = await approved({ targetRepoId: B.name });
    expect((await handoff(id)).statusCode).toBe(200);
    expect((await intents(id))[0].target_repo_id).toBe(B.name);

    const content = await api('PATCH', `/api/requests/${id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: (await detail(id)).title, targetRepoId: A.name }),
      version: (await detail(id)).version,
    });
    expect(content.statusCode, content.body).toBe(400);
    expect(content.json().error.code).toBe('ERR-004');

    const dedicated = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: A.name });
    expect(dedicated.statusCode, dedicated.body).toBe(409);
    expect(dedicated.json().error.code).toBe('ERR-405');

    // 依頼・job・Issue・投入の記録がすべて B のまま（食い違いが無い）
    expect((await detail(id)).targetRepoId).toBe(B.name);
    expect(adapter.issues.every((i) => i.repo === B.name)).toBe(true);
    expect((await intents(id)).every((i) => i.target_repo_id === B.name)).toBe(true);
    // 同じ版の再投入は作られない（Issue が増えない）
    const again = await handoff(id);
    expect(again.json()).toMatchObject({ created: false, issueNo: adapter.issues[0]?.number });
    expect(adapter.issues).toHaveLength(1);
  });

  it('T-52: 未指定（null）へ戻す変更も、実効値（既定）で投入済みの repo と比べて拒否する', async () => {
    const id = await approved({ targetRepoId: B.name });
    expect((await handoff(id)).statusCode).toBe(200);
    const reset = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: null });
    expect(reset.statusCode, reset.body).toBe(409);
    expect(reset.json().error.code).toBe('ERR-405');
    expect(reset.json().error.details).toMatchObject({ targetRepo: B.name, effectiveTargetRepo: A.name });
    expect((await detail(id)).targetRepoId).toBe(B.name);
  });

  it('T-53: 既定の repo へ投入済みなら null へ戻しても実効値が同じなので通る（changed=false）', async () => {
    const id = await approved();
    expect((await handoff(id)).statusCode).toBe(200);
    expect((await intents(id))[0].target_repo_id).toBe(A.name);
    const reset = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: null });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().targetRepo.changed).toBe(false);
  });

  it('T-54: 保存済みの repo が積集合から外れたら fail-closed（投入は ERR-405・今の投入先は null）', async () => {
    const id = await approved({ targetRepoId: B.name });
    // 台帳・設定から外れた古い値が残っている状態（設定の変更で起こりうる）
    await query(`update request set target_repo_id='msf-test/repo-gone' where id=$1`, [id]);
    const jobs = await api('GET', `/api/requests/${id}/jobs`);
    expect(jobs.statusCode, jobs.body).toBe(200);
    expect(jobs.json().currentTargetRepo).toBeNull();
    const res = await handoff(id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ERR-405');
    expect(adapter.issues).toHaveLength(0);
  });

  it('T-55: 送信中の投入（sent）があるあいだは投入先を変えられない（ERR-301）', async () => {
    const id = await approved();
    expect((await handoff(id)).statusCode).toBe(200);
    const [create] = await intents(id);
    await query(
      `insert into handoff_intent
         (snapshot_id, request_id, order_version, target_repo_id, op_kind, state, marker, target_issue_no,
          attempts, sent_at, created_at, updated_at)
       select snapshot_id, request_id, order_version, target_repo_id, 'update_issue', 'sent', marker || '-sent', 1,
              1, now(), now(), now()
         from handoff_intent where id=$1`,
      [create.id],
    );
    expect((await intentStates(id))).toContain('sent');
    const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ERR-301');
    expect(res.json().error.details).toMatchObject({ handoffState: 'sent' });
    expect((await detail(id)).targetRepoId).toBeNull();
  });
});

describe('画面の選択（PATCH /api/requests/:id/devline-target）', () => {
  it('T-31: 選び直しても版と承認は動かない（監査に from / to を残す）', async () => {
    const id = await approved();
    const before = await detail(id);
    const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().targetRepo).toMatchObject({ requestId: id, targetRepoId: B.name, defaultRepo: A.name, changed: true });
    const after = await detail(id);
    expect(after.targetRepoId).toBe(B.name);
    expect(after.orderVersion).toBe(before.orderVersion);
    expect(after.status).toBe('approved');
    const audit = await query<{ diff: Record<string, unknown>; result: string }>(
      `select diff, result from audit_log where action='request.update' and target_id=$1 order by id desc limit 1`,
      [id],
    );
    expect(audit.rows[0]).toMatchObject({ result: 'success', diff: { field: 'targetRepoId', from: null, to: B.name } });
  });

  it('T-32: 同じ値を選び直しても監査を増やさない（changed=false）', async () => {
    const id = await approved();
    await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    const count = await query<{ c: number }>(`select count(*)::int as c from audit_log where action='request.update'`);
    const again = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(again.json().targetRepo.changed).toBe(false);
    const after = await query<{ c: number }>(`select count(*)::int as c from audit_log where action='request.update'`);
    expect(after.rows[0]?.c).toBe(count.rows[0]?.c);
  });

  it('T-33: 未指定（null）へ戻せる', async () => {
    const id = await approved({ targetRepoId: B.name });
    const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: null });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(id)).targetRepoId).toBeNull();
    expect((await api('GET', `/api/requests/${id}/jobs`)).json().currentTargetRepo).toBe(A.name);
  });

  it('T-34: 積集合の外は拒否（ERR-405）し、値は変わらない', async () => {
    const id = await approved({ targetRepoId: B.name });
    for (const targetRepoId of ['evil/repo', C.name]) {
      const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('ERR-405');
    }
    expect((await detail(id)).targetRepoId).toBe(B.name);
  });

  it('T-35: 投入できる役割（受付担当・承認者）だけが変えられる。依頼者は ERR-101', async () => {
    const id = await approved();
    await setRole('requester');
    const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ERR-101');
    const denied = await query<{ result: string }>(
      `select result from audit_log where action='request.update' and target_id=$1 order by id desc limit 1`,
      [id],
    );
    expect(denied.rows[0]?.result).toBe('denied');
  });

  it('T-36: 投入済み（別の repo）の依頼は変えられない（ERR-405）', async () => {
    const id = await approved();
    expect((await handoff(id)).statusCode).toBe(200);
    const res = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ERR-405');
    expect((await detail(id)).targetRepoId).toBeNull();
  });

  it('T-37: 結果未確定（unknown）の間は変えられない（ERR-301。先に照合）', async () => {
    const id = await approved();
    adapter.failNextSend('createThenLose');
    const res = await handoff(id);
    expect(res.statusCode, res.body).toBe(502);
    expect((await intents(id))[0].state).toBe('unknown');
    const changed = await api('PATCH', `/api/requests/${id}/devline-target`, { targetRepoId: B.name });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('ERR-301');
  });

  it('T-38: 保留の依頼は変えられない（ERR-201）。取り下げた依頼は見つからない（ERR-104）', async () => {
    const held = await create({ targetRepoId: B.name });
    await transition(held.id, { to: 'review' });
    await transition(held.id, { to: 'wait' });
    await transition(held.id, { to: 'hold', reason: '作り物の保留' });
    const res = await api('PATCH', `/api/requests/${held.id}/devline-target`, { targetRepoId: A.name });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ERR-201');

    const cancelled = await approved();
    await transition(cancelled, { to: 'cancel', reason: '作り物の取消' });
    const gone = await api('PATCH', `/api/requests/${cancelled}/devline-target`, { targetRepoId: A.name });
    expect(gone.statusCode, gone.body).toBe(404);
    expect(gone.json().error.code).toBe('ERR-104');
  });
});

describe('候補の一覧（GET /api/devline/target-repos）', () => {
  it('T-41: 積集合だけを、設定の順で、先頭を既定として返す', async () => {
    const res = await api('GET', '/api/devline/target-repos');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.defaultRepo).toBe(A.name);
    expect(body.items).toEqual([
      { name: A.name, repoId: A.repoId, purpose: 'QA の既定（先頭）', isDefault: true },
      { name: B.name, repoId: B.repoId, purpose: 'QA の選択', isDefault: false },
    ]);
    // 台帳に無い C は出さない（候補に上げてから拒否しない）
    expect(body.items.some((i: { name: string }) => i.name === C.name)).toBe(false);
  });
});
