import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  authHeaders,
  buildTestApp,
  loginAs,
  prepareTestDb,
  sampleRequest,
  TEST_MEMBER,
  TEST_USER,
  truncateBusiness,
  type Authed,
} from './helpers.js';
import { config } from '../../src/api/config.js';
import { query } from '../../src/api/db.js';

let app: FastifyInstance;

const ORIGIN = 'http://127.0.0.1:8781';
const APPROVER_PASSWORD = 'separation-approver-1234';
const APPROVER_NEW_PASSWORD = 'separation-new-pass-5678';
const APPROVER = {
  email: 'sep-approver@example.com',
  displayName: '分離 承認者',
  password: APPROVER_PASSWORD,
};

type Session = Authed;

interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  deptCode: string;
  roles: string[];
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  deactivatedAt: string | null;
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw ?? ''];
  return cookies.map((c) => String(c).split(';')[0]).join('; ');
}

async function loginWith(email: string, password: string, role?: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { csrf: string; user: { id: string } };
  const session = { cookie: cookieOf(res), csrf: body.csrf, user: body.user };
  if (role) {
    const switched = await app.inject({
      method: 'POST',
      url: '/api/auth/role',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: ORIGIN },
      payload: { role },
    });
    expect(switched.statusCode).toBe(200);
  }
  return session;
}

async function createUser(
  admin: Session,
  overrides: Partial<{ email: string; displayName: string; deptCode: string; password: string; roles: string[]; isAdmin: boolean }> = {},
): Promise<ManagedUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: authHeaders(admin),
    payload: {
      email: APPROVER.email,
      displayName: APPROVER.displayName,
      deptCode: 'dx',
      password: APPROVER_PASSWORD,
      roles: ['approver'],
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { user: ManagedUser }).user;
}

async function patchUser(admin: Session, userId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${userId}`,
    headers: authHeaders(admin),
    payload,
  });
}

async function createRequestAs(session: Session, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: authHeaders(session),
    payload: sampleRequest(extra),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { request: { id: string; version: number; approverUserId?: string | null } }).request;
}

async function moveToWait(session: Session, id: string, version: number): Promise<number> {
  const review = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(session),
    payload: { to: 'review', version },
  });
  expect(review.statusCode).toBe(200);
  const v2 = (review.json() as { detail: { version: number } }).detail.version;
  const wait = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(session),
    payload: { to: 'wait', version: v2 },
  });
  expect(wait.statusCode).toBe(200);
  return (wait.json() as { detail: { version: number } }).detail.version;
}

async function approve(session: Session, id: string, version: number) {
  return app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(session),
    payload: { to: 'approved', version, signal: 'y', checklistAcknowledged: true },
  });
}

async function userIdOf(email: string): Promise<string> {
  const rows = await query<{ id: string }>('select id from app_user where email = $1', [email]);
  const id = rows.rows[0]?.id;
  if (!id) throw new Error(`利用者が居ません: ${email}`);
  return id;
}

async function audits(action: string, targetId?: string) {
  const sql = targetId
    ? 'select action, result, actor_user_id, actor_name, diff from audit_log where action = $1 and target_id = $2 order by id'
    : 'select action, result, actor_user_id, actor_name, diff from audit_log where action = $1 order by id';
  return (await query<{ action: string; result: string; actor_user_id: string | null; actor_name: string; diff: unknown }>(
    sql,
    targetId ? [action, targetId] : [action],
  )).rows;
}

async function cleanupSeparationUsers(): Promise<void> {
  await query("delete from app_user where email like 'sep-%@example.com'");
}

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await cleanupSeparationUsers();
});

beforeEach(async () => {
  await truncateBusiness();
  await cleanupSeparationUsers();
});

describe('利用者管理（複数ユーザー）', () => {
  it('管理者は利用者を作成・一覧でき、作った利用者は scrypt のパスワードでログインできる', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);
    expect(user.email).toBe(APPROVER.email);
    expect(user.roles).toEqual(['approver']);
    expect(user.isActive).toBe(true);
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('password');

    const createdAudit = await audits('user.create', user.id);
    expect(createdAudit).toHaveLength(1);
    expect(createdAudit[0]!.result).toBe('success');
    expect(createdAudit[0]!.actor_user_id).toBe(admin.user.id);
    expect(createdAudit[0]!.actor_name).toBe(TEST_USER.displayName);
    expect((createdAudit[0]!.diff as { email?: string }).email).toBe(APPROVER.email);

    const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: authHeaders(admin) });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { email: string; roles: string[] }[] }).items;
    expect(items.find((u) => u.email === APPROVER.email)?.roles).toEqual(['approver']);

    const session = await loginWith(APPROVER.email, APPROVER.password);
    expect(session.user.id).toBe(user.id);
  });

  it('管理者以外は利用者の一覧・作成・変更ができない', async () => {
    const member = await loginWith(TEST_MEMBER.email, TEST_MEMBER.password);
    const list = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: member.cookie } });
    expect(list.statusCode).toBe(403);

    const create = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(member),
      payload: {
        email: 'sep-forbidden@example.com',
        displayName: '作れない人',
        deptCode: 'dx',
        password: APPROVER_PASSWORD,
        roles: ['approver'],
      },
    });
    expect(create.statusCode).toBe(403);
    expect(await query("select 1 from app_user where email = 'sep-forbidden@example.com'")).toHaveProperty('rowCount', 0);

    const patch = await patchUser(member, (await userIdOf(TEST_USER.email)), { isActive: false });
    expect(patch.statusCode).toBe(403);
  });

  it('同じメールアドレス・不正な部署・短いパスワードは作成を拒否し、拒否も監査に残す', async () => {
    const admin = await loginAs(app);
    await createUser(admin);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        email: APPROVER.email,
        displayName: '重複 太郎',
        deptCode: 'dx',
        password: APPROVER_PASSWORD,
        roles: ['approver'],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    expect((duplicate.json() as { error: { code: string } }).error.code).toBe('ERR-004');
    const denied = await audits('user.create', APPROVER.email);
    expect(denied.map((a) => a.result)).toContain('denied');
    expect(denied[0]!.actor_user_id).toBe(admin.user.id);

    const badDept = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        email: 'sep-bad-dept@example.com',
        displayName: '部署 違い',
        deptCode: 'no-such-dept',
        password: APPROVER_PASSWORD,
        roles: ['approver'],
      },
    });
    expect(badDept.statusCode).toBe(400);

    const weakPassword = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        email: 'sep-weak@example.com',
        displayName: '弱い パスワード',
        deptCode: 'dx',
        password: 'short',
        roles: ['approver'],
      },
    });
    expect(weakPassword.statusCode).toBe(400);
    expect((weakPassword.json() as { error: { details?: { field?: string } } }).error.details?.field).toBe('password');
  });

  it('ロールの付け替えは3役に正規化して監査に前後を残す', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);
    const res = await patchUser(admin, user.id, { roles: ['approver', 'requester', 'approver'] });
    expect(res.statusCode).toBe(200);
    const updated = (res.json() as { user: { roles: string[] } }).user;
    expect(updated.roles).toEqual(['requester', 'approver']);

    const log = await audits('user.roles', user.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('success');
    expect(log[0]!.actor_user_id).toBe(admin.user.id);
    const diff = log[0]!.diff as { before: string[]; after: string[] };
    expect(diff.before).toEqual(['approver']);
    expect(diff.after).toEqual(['requester', 'approver']);
  });

  it('パスワード変更は旧パスワードを無効にし、その利用者のセッションを失効させ、監査に残す', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);
    const before = await loginWith(APPROVER.email, APPROVER.password);

    const changed = await patchUser(admin, user.id, { password: APPROVER_NEW_PASSWORD });
    expect(changed.statusCode).toBe(200);

    // 変更前に作ったセッションは失効する
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: before.cookie } });
    expect(me.statusCode).toBe(401);
    // 旧パスワードは通らない
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: APPROVER.email, password: APPROVER_PASSWORD },
    });
    expect(oldPassword.statusCode).toBe(401);
    // 新パスワードは通る
    await loginWith(APPROVER.email, APPROVER_NEW_PASSWORD);

    const log = await audits('user.password', user.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('success');
    expect(log[0]!.actor_user_id).toBe(admin.user.id);
    expect(JSON.stringify(log[0]!.diff)).not.toContain(APPROVER_NEW_PASSWORD);
    expect(JSON.stringify(log[0]!.diff)).not.toContain('scrypt$');
  });

  it('無効化した利用者はログインできず、既存のセッションも使えない。無効化は監査に残る', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);
    const session = await loginWith(APPROVER.email, APPROVER.password);

    const res = await patchUser(admin, user.id, { isActive: false });
    expect(res.statusCode).toBe(200);
    const updated = (res.json() as { user: { isActive: boolean; deactivatedAt: string | null } }).user;
    expect(updated.isActive).toBe(false);
    expect(updated.deactivatedAt).toBeTruthy();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: APPROVER.email, password: APPROVER_PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session.cookie } });
    expect(me.statusCode).toBe(401);

    const log = await audits('user.deactivate', user.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('success');
    expect(log[0]!.actor_user_id).toBe(admin.user.id);
  });

  it('自分自身は無効化できない（拒否も監査に残す）', async () => {
    const admin = await loginAs(app);
    const res = await patchUser(admin, admin.user.id, { isActive: false });
    expect(res.statusCode).toBe(400);

    const log = await audits('user.deactivate', admin.user.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('denied');
    expect((log[0]!.diff as { reason?: string }).reason).toBe('self');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin.cookie } });
    expect(me.statusCode).toBe(200);
  });
});

describe('承認者マスタ（ユーザーID優先）', () => {
  it('承認者一覧はユーザー表から返し、名前一致よりユーザーID指定を優先して宛先を決める', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);

    const directory = await app.inject({ method: 'GET', url: '/api/approvers', headers: { cookie: admin.cookie } });
    expect(directory.statusCode).toBe(200);
    const items = (directory.json() as { items: { id: string; displayName: string; email: string }[] }).items;
    expect(items.find((a) => a.id === user.id)).toMatchObject({
      displayName: APPROVER.displayName,
      email: APPROVER.email,
    });

    // 承認者欄は名前のまま、ユーザーIDで明示する（依頼の approver_user_id とメール宛先が ID 優先になる）
    const created = await createRequestAs(admin, { approverUserId: user.id });
    expect(created.approverUserId).toBe(user.id);
    await moveToWait(admin, created.id, created.version);

    const mails = await query<{ to_email: string }>('select to_email from mail_outbox where request_id = $1 order by id', [
      created.id,
    ]);
    expect(mails.rows[0]!.to_email).toBe(APPROVER.email);
  });

  it('承認者欄の表示名からもユーザー表を引く（後方互換）。居なければ名前だけのまま', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);

    const bound = await createRequestAs(admin, { approver: APPROVER.displayName });
    expect(bound.approverUserId).toBe(user.id);

    const unbound = await createRequestAs(admin, { approver: '鈴木 一郎' });
    expect(unbound.approverUserId ?? null).toBeNull();
  });

  it('存在しない・承認者ロールでないユーザーIDを指定すると ERR-004 で断る', async () => {
    const admin = await loginAs(app);
    const notApprover = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: authHeaders(admin),
      payload: {
        email: 'sep-requester@example.com',
        displayName: '依頼 だけ',
        deptCode: 'dx',
        password: APPROVER_PASSWORD,
        roles: ['requester'],
      },
    });
    expect(notApprover.statusCode).toBe(201);
    const requesterId = (notApprover.json() as { user: { id: string } }).user.id;

    for (const approverUserId of [requesterId, '00000000-0000-4000-8000-000000000000']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: authHeaders(admin),
        payload: sampleRequest({ approverUserId }),
      });
      expect(res.statusCode, approverUserId).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-004');
    }
  });

  it('ログイン中の /api/meta は承認者マスタを返し、未ログインには実在のメールを出さない', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);

    const authed = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie: admin.cookie } });
    expect(authed.statusCode).toBe(200);
    const approvers = (authed.json() as { approvers: { name: string; email: string }[] }).approvers;
    expect(approvers.find((a) => a.email === APPROVER.email)?.name).toBe(APPROVER.displayName);

    const publicMeta = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(publicMeta.statusCode).toBe(200);
    const publicApprovers = (publicMeta.json() as { approvers: { email: string }[] }).approvers;
    expect(publicApprovers.some((a) => a.email === APPROVER.email)).toBe(false);
    expect(publicApprovers.map((a) => a.email)).toContain('suzuki@example.com');
    expect(user.id).toBeTruthy();
  });
});

describe('自己承認の拒否（ERR-105）', () => {
  it('依頼の作成者と承認者が同じなら 403 ERR-105。依頼は変わらず、監査に actor と理由が残る', async () => {
    const admin = await loginAs(app);
    const created = await createRequestAs(admin);
    const waitVersion = await moveToWait(admin, created.id, created.version);
    // 承認には「承認者」の役割が要る。同じ利用者でも、依頼を作ったのは別の役割のセッション。
    const approver = await loginAs(app, 'approver');

    const restore = config.allowSelfApproval;
    config.allowSelfApproval = false;
    try {
      const res = await approve(approver, created.id, waitVersion);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-105');
    } finally {
      config.allowSelfApproval = restore;
    }

    const row = await query<{ status: string; version: number }>('select status, version from request where id = $1', [created.id]);
    expect(row.rows[0]!.status).toBe('wait');
    expect(row.rows[0]!.version).toBe(waitVersion);

    const log = await audits('approval.self_denied', created.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('denied');
    expect(log[0]!.actor_user_id).toBe(admin.user.id);
    expect((log[0]!.diff as { reason?: string }).reason).toBe('self_approval');
  });

  it('開発既定（ALLOW_SELF_APPROVAL=1）では従来どおり自己承認できる（後方互換）', async () => {
    const admin = await loginAs(app);
    const created = await createRequestAs(admin);
    const waitVersion = await moveToWait(admin, created.id, created.version);
    expect(config.allowSelfApproval).toBe(true);
    const approver = await loginAs(app, 'approver');

    const res = await approve(approver, created.id, waitVersion);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { detail: { status: string } }).detail.status).toBe('approved');
  });

  it('別の利用者（承認者）なら承認できる。承認記録に承認者のユーザーIDが残る', async () => {
    const admin = await loginAs(app);
    const created = await createRequestAs(admin, { approver: TEST_MEMBER.displayName });
    const waitVersion = await moveToWait(admin, created.id, created.version);
    const memberId = await userIdOf(TEST_MEMBER.email);
    expect((await query<{ approver_user_id: string | null }>('select approver_user_id from request where id = $1', [created.id]))
      .rows[0]!.approver_user_id).toBe(memberId);

    const member = await loginWith(TEST_MEMBER.email, TEST_MEMBER.password, 'approver');
    const res = await approve(member, created.id, waitVersion);
    expect(res.statusCode).toBe(200);

    const approval = await query<{ approver_user_id: string | null; decision: string }>(
      'select approver_user_id, decision from approval where request_id = $1 order by at desc limit 1',
      [created.id],
    );
    expect(approval.rows[0]).toMatchObject({ approver_user_id: memberId, decision: 'approved' });
  });

  it('二重承認は拒否し、拒否の理由も監査に残す（同時・再送の両方）', async () => {
    const admin = await loginAs(app);
    const created = await createRequestAs(admin, { approver: TEST_MEMBER.displayName });
    const waitVersion = await moveToWait(admin, created.id, created.version);
    const member = await loginWith(TEST_MEMBER.email, TEST_MEMBER.password, 'approver');
    expect((await approve(member, created.id, waitVersion)).statusCode).toBe(200);

    // 同じ版のままの再送（ほかの人が先に承認した）→ 409 ERR-301
    const stale = await approve(member, created.id, waitVersion);
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe('ERR-301');

    // 最新の版で「もう承認済み」を承認しようとする → 409 ERR-201
    const detail = await app.inject({ method: 'GET', url: `/api/requests/${created.id}`, headers: { cookie: admin.cookie } });
    const freshVersion = (detail.json() as { request: { version: number } }).request.version;
    const duplicate = await approve(admin, created.id, freshVersion);
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error: { code: string } }).error.code).toBe('ERR-201');

    const conflictLog = await audits('request.transition_denied', created.id);
    expect(conflictLog.some((a) => (a.diff as { reason?: string }).reason === 'version_conflict')).toBe(true);
    const duplicateLog = await audits('approval.duplicate_denied', created.id);
    expect(duplicateLog).toHaveLength(1);
    expect(duplicateLog[0]!.result).toBe('denied');
    expect((duplicateLog[0]!.diff as { reason?: string }).reason).toBe('already_in_state');

    const approvals = await query<{ count: number }>('select count(*)::int as count from approval where request_id = $1', [
      created.id,
    ]);
    expect(approvals.rows[0]!.count).toBe(1);
  });
});

describe('無効ユーザーの拒否', () => {
  it('無効化された承認者は既存セッションでも承認できず、依頼も変わらない', async () => {
    const admin = await loginAs(app);
    const user = await createUser(admin);
    const approver = await loginWith(APPROVER.email, APPROVER.password, 'approver');

    const created = await createRequestAs(admin, { approver: APPROVER.displayName });
    const waitVersion = await moveToWait(admin, created.id, created.version);

    const deactivated = await patchUser(admin, user.id, { isActive: false });
    expect(deactivated.statusCode).toBe(200);

    const res = await approve(approver, created.id, waitVersion);
    expect(res.statusCode).toBe(401);

    const row = await query<{ status: string }>('select status from request where id = $1', [created.id]);
    expect(row.rows[0]!.status).toBe('wait');
    const log = await audits('user.deactivate', user.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.result).toBe('success');
    expect(log[0]!.actor_user_id).toBe(admin.user.id);
  });
});
