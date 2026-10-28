import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { pool, query } from '../../src/api/db.js';
import { seedMaster } from '../../src/api/seed.js';
import { hashPassword } from '../../src/api/password.js';

export const TEST_USER = {
  email: 'test@example.com',
  password: 'test-pass-1234',
  displayName: 'テスト 太郎',
  deptCode: 'dx',
};

/** 管理者ではない利用者（権限の否定テスト用）。 */
export const TEST_MEMBER = {
  email: 'member@example.com',
  password: 'member-pass-1234',
  displayName: 'メンバー 花子',
  deptCode: 'dx',
};

async function ensureUser(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: { id: string }[]; rowCount: number | null }> },
  user: { email: string; password: string; displayName: string; deptCode: string },
  roles: string[],
  isAdmin: boolean,
): Promise<void> {
  const existing = await client.query('select id from app_user where email = $1', [user.email]);
  if (existing.rowCount) return;
  const hash = await hashPassword(user.password);
  const inserted = await client.query(
    `insert into app_user (email, display_name, dept_code, password_hash, is_admin) values ($1,$2,$3,$4,$5) returning id`,
    [user.email, user.displayName, user.deptCode, hash, isAdmin],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return;
  for (const role of roles) {
    await client.query('insert into user_role (user_id, role) values ($1,$2)', [id, role]);
  }
}

export async function prepareTestDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await seedMaster(client);
    await ensureUser(client, TEST_USER, ['requester', 'desk', 'approver'], true);
    await ensureUser(client, TEST_MEMBER, ['requester', 'approver'], false);
  } finally {
    client.release();
  }
}

export async function truncateBusiness(): Promise<void> {
  await query(
    `truncate table request, request_history, comment, approval, attachment, draft, idempotency, request_counter, session, audit_log, mail_outbox, ops_state restart identity cascade`,
  );
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ serveStatic: false });
  await app.ready();
  return app;
}

export interface Authed {
  cookie: string;
  csrf: string;
  /** 起動データなど利用者IDが要るアサーションで使う */
  user: { id: string };
}

async function login(
  app: FastifyInstance,
  user: { email: string; password: string },
  role?: string,
): Promise<Authed> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: user.email, password: user.password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { csrf: string; user: { id: string } };
  const setCookie = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  const authed = { cookie, csrf: body.csrf, user: body.user };
  if (role) {
    const switched = await app.inject({
      method: 'POST',
      url: '/api/auth/role',
      headers: { cookie: authed.cookie, 'x-csrf-token': authed.csrf, origin: 'http://127.0.0.1:8781' },
      payload: { role },
    });
    expect(switched.statusCode).toBe(200);
  }
  return authed;
}

/** 管理者（3役すべて）でログインする。 */
export async function loginAs(app: FastifyInstance, role?: string): Promise<Authed> {
  return login(app, TEST_USER, role);
}

/** 管理者ではない利用者（依頼者のみ）でログインする。権限の否定テスト用。 */
export async function loginAsMember(app: FastifyInstance): Promise<Authed> {
  return login(app, TEST_MEMBER);
}

export function authHeaders(auth: Authed): Record<string, string> {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: 'http://127.0.0.1:8781' };
}

export function sampleRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '工事写真の圏外保存のテスト',
    kind: 'improve_tool',
    deptCode: 'kaijo',
    applicant: 'テスト 太郎',
    contact: '内線 1234',
    toolId: 'kaijo-01',
    problem: '作業船の上では電波が弱く写真が送れない。',
    purpose: '圏外でも写真が消えずに残るようにする。',
    users: ['現場の担当者'],
    people: 40,
    places: ['海の上（作業船・台船）'],
    scope: ['圏外での一時保存'],
    outOfScope: ['発注者への直接提出'],
    criteria: ['圏外で撮った写真がアプリを閉じても消えない', '電波が戻ると自動で送られ、二重に登録されない'],
    decides: 'g',
    dataHandling: ['photo'],
    parties: 'internal',
    constraints: ['写真・記録の原本は加工しない'],
    constraintsOther: [],
    approvals: ['提出様式の変更'],
    frequency: 'd',
    minutesPerTime: 15,
    dataReady: 5,
    spread: 5,
    approver: '鈴木 一郎',
    ...overrides,
  };
}
