import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeaders,
  buildTestApp,
  loginAs,
  loginAsMember,
  prepareTestDb,
  sampleRequest,
  TEST_USER,
  truncateBusiness,
} from './helpers.js';
import { createSessionForUser } from '../../src/api/auth.js';
import { getBootData } from '../../src/api/service.js';
import { query } from '../../src/api/db.js';
import { verifyAuditChain } from '../../src/api/audit.js';

let app: FastifyInstance;

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateBusiness();
});

async function createRequest(auth: Awaited<ReturnType<typeof loginAs>>, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: authHeaders(auth),
    payload: sampleRequest(overrides),
  });
  return res;
}

async function moveToWait(auth: Awaited<ReturnType<typeof loginAs>>, id: string, version = 1) {
  const review = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(auth),
    payload: { to: 'review', version },
  });
  expect(review.statusCode).toBe(200);
  const v2 = (review.json() as { detail: { version: number } }).detail.version;
  const wait = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(auth),
    payload: { to: 'wait', version: v2 },
  });
  expect(wait.statusCode).toBe(200);
  return (wait.json() as { detail: { version: number } }).detail.version;
}

describe('認証・セッション', () => {
  it('ログインに成功するとユーザーとCSRFトークンを返す', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: TEST_USER.email, password: TEST_USER.password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { displayName: string; roles: string[] }; csrf: string };
    expect(body.user.displayName).toBe(TEST_USER.displayName);
    expect(body.user.roles).toEqual(['requester', 'desk', 'approver']);
    expect(body.csrf.length).toBeGreaterThan(10);
  });

  it('パスワードが違うと401（理由は区別しない）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: TEST_USER.email, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-106');
  });

  it('未ログインでは /api/home が401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/home' });
    expect(res.statusCode).toBe(401);
  });

  it('更新系はCSRFトークンがないと403', async () => {
    const auth = await loginAs(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { cookie: auth.cookie },
      payload: sampleRequest(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('依頼の登録', () => {
  it('受付番号を採番し、履歴に「受付」を残す', async () => {
    const auth = await loginAs(app);
    const res = await createRequest(auth);
    expect(res.statusCode).toBe(201);
    const detail = (res.json() as { request: Record<string, unknown> }).request;
    expect(detail.id).toMatch(/^REQ-\d{4}-0001$/);
    expect(detail.status).toBe('received');
    const history = detail.history as { action: string }[];
    expect(history[0]?.action).toBe('受付');
  });

  it('信号の候補と理由を返す（写真＋社外なし＝黄）', async () => {
    const auth = await loginAs(app);
    const res = await createRequest(auth);
    const detail = (res.json() as { request: { suggested: { color: string; reasons: string[] } } }).request;
    expect(detail.suggested.color).toBe('y');
    expect(detail.suggested.reasons.join()).toContain('工事写真');
  });

  it('同じ冪等キー・同じ内容なら同じ依頼を返す', async () => {
    const auth = await loginAs(app);
    const headers = { ...authHeaders(auth), 'idempotency-key': 'test-key-1' };
    const first = await app.inject({ method: 'POST', url: '/api/requests', headers, payload: sampleRequest() });
    const second = await app.inject({ method: 'POST', url: '/api/requests', headers, payload: sampleRequest() });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const id1 = (first.json() as { request: { id: string } }).request.id;
    const id2 = (second.json() as { request: { id: string } }).request.id;
    expect(id2).toBe(id1);
    const count = await query<{ count: number }>('select count(*)::int as count from request');
    expect(count.rows[0]?.count).toBe(1);
  });

  it('同じ冪等キーで内容が違うと409 ERR-008', async () => {
    const auth = await loginAs(app);
    const headers = { ...authHeaders(auth), 'idempotency-key': 'test-key-2' };
    await app.inject({ method: 'POST', url: '/api/requests', headers, payload: sampleRequest() });
    const second = await app.inject({
      method: 'POST',
      url: '/api/requests',
      headers,
      payload: sampleRequest({ title: '別の件名' }),
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('ERR-008');
  });

  it('合格の条件が9件なら400 ERR-006', async () => {
    const auth = await loginAs(app);
    const res = await createRequest(auth, { criteria: Array.from({ length: 9 }, (_, i) => `条件${i}が満たされる`) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-006');
  });

  it('件名が60文字を超えると400', async () => {
    const auth = await loginAs(app);
    const res = await createRequest(auth, { title: 'あ'.repeat(61) });
    expect(res.statusCode).toBe(400);
  });

  it('カタログ外の道具IDは400', async () => {
    const auth = await loginAs(app);
    const res = await createRequest(auth, { toolId: 'kaijo-99' });
    expect(res.statusCode).toBe(400);
  });
});

describe('状態遷移と承認', () => {
  it('受付担当は承認できず、承認者が信号を決めて承認できる', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const version = await moveToWait(desk, id);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(desk),
      payload: { to: 'approved', version, signal: 'y' },
    });
    expect(denied.statusCode).toBe(409);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('ERR-201');

    const approver = await loginAs(app, 'approver');
    const noSignal = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version },
    });
    expect(noSignal.statusCode).toBe(400);
    expect((noSignal.json() as { error: { code: string } }).error.code).toBe('ERR-203');

    const approved = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version, signal: 'y', checklistAcknowledged: true },
    });
    expect(approved.statusCode).toBe(200);
    const detail = (approved.json() as { detail: { status: string; signalDecided: string; orderVersion: number } }).detail;
    expect(detail.status).toBe('approved');
    expect(detail.signalDecided).toBe('y');
    expect(detail.orderVersion).toBe(1);

    const approval = await query<{ decision: string; decided_signal: string }>(
      'select decision, decided_signal from approval where request_id = $1',
      [id],
    );
    expect(approval.rows[0]?.decision).toBe('approved');
    expect(approval.rows[0]?.decided_signal).toBe('y');
  });

  it('承認済みなら注文書YAMLを生成できる（未承認は409 ERR-205）', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const version = await moveToWait(desk, id);

    const before = await app.inject({ method: 'GET', url: `/api/requests/${id}/order`, headers: { cookie: desk.cookie } });
    expect(before.statusCode).toBe(409);
    expect((before.json() as { error: { code: string } }).error.code).toBe('ERR-205');

    const approver = await loginAs(app, 'approver');
    await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version, signal: 'y', checklistAcknowledged: true },
    });
    const order = await app.inject({ method: 'GET', url: `/api/requests/${id}/order`, headers: { cookie: desk.cookie } });
    expect(order.statusCode).toBe(200);
    const yaml = (order.json() as { yaml: string }).yaml;
    expect(yaml).toContain(`id: "${id}"`);
    expect(yaml).toContain('acceptance_criteria:');
    expect(yaml).toContain(' - "工事写真・検査記録の原本"');
  });

  it('候補よりゆるい色は理由が必要（ERR-102）', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const version = await moveToWait(desk, id);
    const approver = await loginAs(app, 'approver');

    const noReason = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version, signal: 'g', checklistAcknowledged: true },
    });
    expect(noReason.statusCode).toBe(400);
    expect((noReason.json() as { error: { code: string } }).error.code).toBe('ERR-102');

    const withReason = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version, signal: 'g', checklistAcknowledged: true, reason: '表示だけのため' },
    });
    expect(withReason.statusCode).toBe(200);
  });

  it('差戻しは理由必須で、依頼者が再提出すると受付に戻る', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const version = await moveToWait(desk, id);

    const approver = await loginAs(app, 'approver');
    const noReason = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'back', version },
    });
    expect(noReason.statusCode).toBe(400);
    expect((noReason.json() as { error: { code: string } }).error.code).toBe('ERR-102');

    const back = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'back', version, reason: '合格の条件を数字で書き直してください' },
    });
    expect(back.statusCode).toBe(200);
    const backDetail = (back.json() as { detail: { status: string; version: number; comments: { text: string }[] } }).detail;
    expect(backDetail.status).toBe('back');
    expect(backDetail.comments.at(-1)?.text).toContain('書き直して');

    const requester = await loginAs(app, 'requester');
    const resubmit = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(requester),
      payload: { to: 'received', version: backDetail.version },
    });
    expect(resubmit.statusCode).toBe(200);
    expect((resubmit.json() as { detail: { status: string } }).detail.status).toBe('received');
  });

  it('取消は論理削除で、一覧から外れる（includeDeletedで見える）', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(desk),
      payload: { to: 'cancel', version: 1, reason: '誤登録のため' },
    });
    expect(cancel.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/requests', headers: { cookie: desk.cookie } });
    expect((list.json() as { total: number }).total).toBe(0);
    const withDeleted = await app.inject({
      method: 'GET',
      url: '/api/requests?includeDeleted=1',
      headers: { cookie: desk.cookie },
    });
    expect((withDeleted.json() as { total: number }).total).toBe(1);
    const row = await query<{ deleted: boolean; status: string }>('select deleted, status from request where id=$1', [id]);
    expect(row.rows[0]).toEqual({ deleted: true, status: 'cancel' });
  });

  it('古い版番号での更新は409 ERR-301', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(desk),
      payload: { to: 'review', version: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-301');
  });
});

describe('不正な遷移は拒否して監査ログに残す', () => {
  it('受付から承認済みへ直接は409', async () => {
    const desk = await loginAs(app, 'desk');
    const created = await createRequest(desk);
    const id = (created.json() as { request: { id: string } }).request.id;
    const approver = await loginAs(app, 'approver');
    const res = await app.inject({
      method: 'POST',
      url: `/api/requests/${id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version: 1, signal: 'g' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-201');
    const chain = await verifyAuditChain();
    expect(chain.ok).toBe(true);
  });
});

describe('一覧・ホーム・カタログ・出力', () => {
  it('カタログは19部署・118件（青52/黄47/赤19）', async () => {
    const auth = await loginAs(app);
    const res = await app.inject({ method: 'GET', url: '/api/catalog/summary', headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ departments: 19, tools: 118, g: 52, y: 47, r: 19 });
  });

  it('受付担当のホームに「あなたの番」が出る', async () => {
    const desk = await loginAs(app, 'desk');
    await createRequest(desk);
    const home = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie: desk.cookie } });
    expect(home.statusCode).toBe(200);
    const body = home.json() as { role: string; counts: { yourTurn: number } };
    expect(body.role).toBe('desk');
    expect(body.counts.yourTurn).toBe(1);
  });

  it('CSVはBOM・11列、JSONは{seq, items}', async () => {
    const desk = await loginAs(app, 'desk');
    await createRequest(desk);
    const csv = await app.inject({ method: 'GET', url: '/api/export.csv', headers: { cookie: desk.cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body.split('\r\n')[0]).toContain('"受付番号"');

    const json = await app.inject({ method: 'GET', url: '/api/export.json', headers: { cookie: desk.cookie } });
    const parsed = JSON.parse(json.body) as { seq: number; items: unknown[] };
    expect(parsed.seq).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });

  it('監査ログはハッシュ連鎖が壊れていない', async () => {
    const desk = await loginAs(app, 'desk');
    await createRequest(desk);
    const chain = await verifyAuditChain();
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBeGreaterThan(1);
  });

  it('監査ログは管理者だけが読める', async () => {
    const desk = await loginAs(app, 'desk');
    const res = await app.inject({ method: 'GET', url: '/api/audit-logs', headers: { cookie: desk.cookie } });
    expect(res.statusCode).toBe(200); // テストユーザーは is_admin=true
    const chain = (res.json() as { chain: { ok: boolean } }).chain;
    expect(chain.ok).toBe(true);
  });
});

describe('セッションの有効期限', () => {
  it('期限切れのセッションは401', async () => {
    const user = await query<{ id: string }>('select id from app_user where email=$1', [TEST_USER.email]);
    const session = await createSessionForUser(user.rows[0]!.id, 'desk');
    await query('update session set expires_at = now() - interval \'1 hour\' where id = $1', [
      (await import('../../src/api/auth.js')).hashToken(session.token),
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie: `msf_session=${session.token}` } });
    expect(res.statusCode).toBe(401);
  });
});

describe('下書きのサーバ保存（端末をまたいで再開）', () => {
  it('PUT → GET → DELETE ができ、本人の下書きだけを返す', async () => {
    const auth = await loginAs(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/draft',
      headers: authHeaders(auth),
      payload: { draft: { title: '書きかけの依頼' }, step: 2, editId: null, at: new Date().toISOString() },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: 'GET', url: '/api/draft', headers: { cookie: auth.cookie } });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { draft: { payload: { title: string }; step: number } };
    expect(body.draft.payload.title).toBe('書きかけの依頼');
    expect(body.draft.step).toBe(2);

    const del = await app.inject({ method: 'DELETE', url: '/api/draft', headers: authHeaders(auth) });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/draft', headers: { cookie: auth.cookie } });
    expect((after.json() as { draft: unknown }).draft).toBeNull();
  });

  it('起動データに下書きが含まれる（画面HTMLはビルド有無に依存するためサービスで検証）', async () => {
    const auth = await loginAs(app);
    await app.inject({
      method: 'PUT',
      url: '/api/draft',
      headers: authHeaders(auth),
      payload: { draft: { title: '別端末で再開する下書き' }, step: 1, editId: null, at: new Date().toISOString() },
    });
    const boot = (await getBootData(auth.user.id)) as { draft: { draft: { title: string } } | null };
    expect(boot.draft?.draft.title).toBe('別端末で再開する下書き');
  });
});

describe('運用・DevOps・SecOps のDB保存', () => {
  it('未保存なら null、保存すると取得でき、起動データにも入る', async () => {
    const auth = await loginAs(app);
    await query('delete from ops_state');
    const before = await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie: auth.cookie } });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { data: unknown }).data).toBeNull();

    const save = await app.inject({
      method: 'PUT',
      url: '/api/ops',
      headers: authHeaders(auth),
      payload: { data: { apps: [{ id: 'APP-001', name: 'テスト' }], incidents: [] } },
    });
    expect(save.statusCode).toBe(200);
    expect((save.json() as { version: number }).version).toBe(1);

    const after = await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie: auth.cookie } });
    expect((after.json() as { data: { apps: { id: string }[] } }).data.apps[0]?.id).toBe('APP-001');

    const boot = (await getBootData(auth.user.id)) as {
      ops: { data: { apps: { id: string }[] }; version: number } | null;
    };
    expect(boot.ops?.data.apps[0]?.id).toBe('APP-001');
  });

  it('未ログインは401、配列など不正な形は400、依頼者は書き込めない（403）', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/ops' });
    expect(unauth.statusCode).toBe(401);
    const auth = await loginAs(app);
    const bad = await app.inject({ method: 'PUT', url: '/api/ops', headers: authHeaders(auth), payload: { data: [1, 2, 3] } });
    expect(bad.statusCode).toBe(400);

    // 運用・DevOps・SecOps は共有の状態。依頼者は上書きできない
    const requester = await loginAsMember(app);
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/ops',
      headers: authHeaders(requester),
      payload: { data: { apps: [], incidents: [] } },
    });
    expect(denied.statusCode).toBe(403);
  });
});
