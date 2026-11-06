/**
 * AUTH_MODE=access のリクエスト全体の動作（Cookie と JWT の関係、fail-closed と明示 opt-in）。
 * 公開鍵の取得はモックし、実ネットワークへ出ない。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, prepareTestDb, truncateBusiness } from './helpers.js';
import { config } from '../../src/api/config.js';
import { query } from '../../src/api/db.js';

const TEAM = 'https://integration-team.cloudflareaccess.example';
const AUD = 'integration-test-aud';
const USER_A = 'jwt-a@example.com';
const USER_B = 'jwt-b@example.com';
const SERVICE_PROXY = 'jwt-service@example.com';
const SERVICE_TOKEN = 'integration-client.access';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
  const now = Date.now() / 1000;
  const body = `${b64({ alg: 'RS256', kid: 'it' })}.${b64({ iss: TEAM, aud: [AUD], nbf: now - 10, exp: now + 600, ...claims })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(keys.privateKey).toString('base64url')}`;
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']) as string[];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

let app: FastifyInstance;
const restore = {
  authMode: config.authMode,
  team: config.accessTeamDomain,
  aud: config.accessAud,
  emails: config.accessAllowedEmails,
  domain: config.accessAllowedDomain,
  tokens: config.accessServiceTokenIds,
  trustEmailHeader: config.accessTrustEmailHeader,
  autoProvision: config.accessAutoProvision,
  appEnv: config.appEnv,
};
const fetchMock = vi.fn(async (_url: string) => {
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'it', alg: 'RS256', use: 'sig' };
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
});

async function me(headers: Record<string, string>) {
  return app.inject({ method: 'GET', url: '/api/auth/me', headers });
}

function emailOf(res: { json: () => unknown }): string {
  return (res.json() as { user: { email: string } }).user.email;
}

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await truncateBusiness();
  // このファイルが作った利用者を、後続のテストへ残さない
  await query(`delete from app_user where email like 'jwt-%@example.com'`);
  await app.close();
});

beforeEach(async () => {
  await truncateBusiness();
  config.authMode = 'access';
  config.accessAllowedEmails = [SERVICE_PROXY];
  config.accessAllowedDomain = 'example.com';
  config.accessServiceTokenIds = [SERVICE_TOKEN];
  config.accessTeamDomain = TEAM;
  config.accessAud = AUD;
  // Issue #102: ヘッダ信頼の opt-in は既定で無効。テスト環境（非本番・非 staging）として扱う。
  config.accessTrustEmailHeader = false;
  // 既存の JWT 経路のテストは「未登録の利用者が作られる」ことを前提にしているため、明示 opt-in にする。
  // 既定（opt-out）の挙動は『未登録利用者の自動登録は既定で無効』の describe で固定する。
  config.accessAutoProvision = true;
  config.appEnv = 'test';
});

afterEach(() => {
  config.authMode = restore.authMode;
  config.accessTeamDomain = restore.team;
  config.accessAud = restore.aud;
  config.accessAllowedEmails = restore.emails;
  config.accessAllowedDomain = restore.domain;
  config.accessServiceTokenIds = restore.tokens;
  config.accessTrustEmailHeader = restore.trustEmailHeader;
  config.accessAutoProvision = restore.autoProvision;
  config.appEnv = restore.appEnv;
});

describe('JWT 検証が有効なとき', () => {
  it('正しい JWT でセッションができ、利用者は JWT のメール', async () => {
    const res = await me({
      'cf-access-jwt-assertion': jwt({ email: USER_A }),
      'cf-access-authenticated-user-email': USER_B,
    });
    expect(res.statusCode).toBe(200);
    expect(emailOf(res)).toBe(USER_A);
    expect(res.headers['set-cookie']).toBeTruthy();
    expect(fetchMock.mock.calls.every(([url]) => url === `${TEAM}/cdn-cgi/access/certs`)).toBe(true);
  });

  it('本番では未登録の利用者を自動登録しない（管理者の自動付与の廃止）', async () => {
    const restoreEnv = config.appEnv;
    config.appEnv = 'production';
    try {
      const res = await me({ 'cf-access-jwt-assertion': jwt({ email: 'jwt-unknown@example.com' }) });
      expect(res.statusCode).toBe(401);
      const users = await query<{ count: number }>(
        `select count(*)::int as count from app_user where email = 'jwt-unknown@example.com'`,
      );
      expect(users.rows[0]?.count).toBe(0);
      const audit = await query<{ count: number }>(
        `select count(*)::int as count from audit_log where action = 'auth.access_denied' and target_type = 'user'`,
      );
      expect(audit.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      config.appEnv = restoreEnv;
    }
  });

  it('ヘッダのメールだけでは401', async () => {
    const res = await me({ 'cf-access-authenticated-user-email': USER_A });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('改ざんした JWT は401（500にしない）', async () => {
    const [header, , signature] = jwt({ email: USER_A }).split('.');
    const res = await me({ 'cf-access-jwt-assertion': `${header}.${b64({ email: USER_B })}.${signature}` });
    expect(res.statusCode).toBe(401);
  });

  it('発行済みの Cookie だけでは通らない', async () => {
    const first = await me({ 'cf-access-jwt-assertion': jwt({ email: USER_A }) });
    const res = await me({ cookie: cookieFrom(first) });
    expect(res.statusCode).toBe(401);
  });

  it('Cookie と同じ人の JWT なら既存セッションを使い、新しく作らない', async () => {
    const token = jwt({ email: USER_A });
    const first = await me({ 'cf-access-jwt-assertion': token });
    const res = await me({ cookie: cookieFrom(first), 'cf-access-jwt-assertion': token });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const sessions = await query<{ count: number }>('select count(*)::int as count from session');
    expect(sessions.rows[0]?.count).toBe(1);
  });

  it('Cookie と別人の JWT なら JWT の利用者へ切り替える', async () => {
    const first = await me({ 'cf-access-jwt-assertion': jwt({ email: USER_A }) });
    const res = await me({ cookie: cookieFrom(first), 'cf-access-jwt-assertion': jwt({ email: USER_B }) });
    expect(res.statusCode).toBe(200);
    expect(emailOf(res)).toBe(USER_B);
  });

  it('サービストークンは common_name が許可リストにあるときだけ通る', async () => {
    const allowed = await me({ 'cf-access-jwt-assertion': jwt({ common_name: SERVICE_TOKEN }) });
    expect(allowed.statusCode).toBe(200);
    expect(emailOf(allowed)).toBe(SERVICE_PROXY);
    const denied = await me({ 'cf-access-jwt-assertion': jwt({ common_name: 'other.access' }) });
    expect(denied.statusCode).toBe(401);
    const headerOnly = await me({ 'cf-access-client-id': SERVICE_TOKEN });
    expect(headerOnly.statusCode).toBe(401);
  });

  it('/healthz は JWT なしでも応答する', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('JWT 未設定は fail-closed（ヘッダ信頼は明示 opt-in のみ）', () => {
  // 未登録の許可メール。自動で利用者・セッションが作られないことを確かめる。
  const UNKNOWN = 'jwt-denied@example.com';

  beforeEach(() => {
    config.accessTeamDomain = '';
    config.accessAud = '';
    config.accessTrustEmailHeader = false;
    config.appEnv = 'test';
    fetchMock.mockClear();
  });

  it('許可メールのヘッダだけでは401（session も app_user も作らない）', async () => {
    const res = await me({ 'cf-access-authenticated-user-email': UNKNOWN });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();

    const sessions = await query<{ count: number }>('select count(*)::int as count from session');
    expect(sessions.rows[0]?.count).toBe(0);
    const users = await query<{ count: number }>('select count(*)::int as count from app_user where email = $1', [UNKNOWN]);
    expect(users.rows[0]?.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('クライアントIDのヘッダだけでは401', async () => {
    const res = await me({ 'cf-access-client-id': SERVICE_TOKEN });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('明示 opt-in があるときだけヘッダでセッションを作る（従来動作）', async () => {
    config.accessTrustEmailHeader = true;
    const first = await me({ 'cf-access-authenticated-user-email': USER_A });
    expect(first.statusCode).toBe(200);
    expect(emailOf(first)).toBe(USER_A);
    expect(fetchMock).not.toHaveBeenCalled();

    const second = await me({ cookie: cookieFrom(first) });
    expect(second.statusCode).toBe(200);
    expect(emailOf(second)).toBe(USER_A);
  });

  it('opt-in があっても APP_ENV=staging / production ではヘッダを信頼しない', async () => {
    config.accessTrustEmailHeader = true;
    for (const appEnv of ['staging', 'production'] as const) {
      config.appEnv = appEnv;
      const res = await me({ 'cf-access-authenticated-user-email': UNKNOWN });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const users = await query<{ count: number }>('select count(*)::int as count from app_user where email = $1', [UNKNOWN]);
    expect(users.rows[0]?.count).toBe(0);
  });

  it('許可外のメールは401', async () => {
    const res = await me({ 'cf-access-authenticated-user-email': 'someone@other.example' });
    expect(res.statusCode).toBe(401);
  });
});

describe('未登録利用者の自動登録は既定で無効（ACCESS_AUTO_PROVISION・Issue #102 の完了条件 3）', () => {
  // 実行のたびに作り直せるよう、このブロック専用の接頭辞にする。
  const UNREGISTERED = 'jwt-auto-noprovision@example.com';
  const OPT_IN = 'jwt-auto-optin@example.com';
  const EXISTING = 'jwt-auto-existing@example.com';

  async function roleRows(email: string) {
    return query<{ is_admin: boolean; roles: string[] }>(
      `select u.is_admin, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
         from app_user u
         left join user_role r on r.user_id = u.id
        where u.email = $1
        group by u.id`,
      [email],
    );
  }

  beforeEach(async () => {
    await query(`delete from app_user where email like 'jwt-auto-%@example.com'`);
    config.appEnv = 'test';
    // 既定（ACCESS_AUTO_PROVISION 未設定）と同じ状態にする。
    config.accessAutoProvision = false;
  });

  it('既定（無効）では未登録の JWT 利用者を 401 にし、app_user も session も作らない', async () => {
    const res = await me({ 'cf-access-jwt-assertion': jwt({ email: UNREGISTERED }) });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();

    expect((await roleRows(UNREGISTERED)).rows[0]).toBeUndefined();
    const sessions = await query<{ count: number }>('select count(*)::int as count from session');
    expect(sessions.rows[0]?.count).toBe(0);

    const audit = await query<{ diff: { reason?: string } }>(
      `select diff from audit_log
        where action = 'auth.access_denied' and target_type = 'user'
        order by id desc limit 1`,
    );
    expect(audit.rows[0]?.diff.reason).toBe('user_not_registered');
  });

  it('APP_ENV=staging でも既定（無効）では未登録利用者を作らない', async () => {
    config.appEnv = 'staging';
    const res = await me({ 'cf-access-jwt-assertion': jwt({ email: UNREGISTERED }) });
    expect(res.statusCode).toBe(401);
    expect((await roleRows(UNREGISTERED)).rows[0]).toBeUndefined();
    const audit = await query<{ diff: { reason?: string } }>(
      `select diff from audit_log
        where action = 'auth.access_denied' and target_type = 'user'
        order by id desc limit 1`,
    );
    expect(audit.rows[0]?.diff.reason).toBe('user_not_registered');
  });

  it('opt-in では作成するが、最小権限（is_admin=false・requester のみ）で監査に残す', async () => {
    config.accessAutoProvision = true;
    const res = await me({ 'cf-access-jwt-assertion': jwt({ email: OPT_IN }) });
    expect(res.statusCode).toBe(200);
    expect(emailOf(res)).toBe(OPT_IN);

    const user = (await roleRows(OPT_IN)).rows[0];
    expect(user?.is_admin).toBe(false);
    expect(user?.roles).toEqual(['requester']);

    const audit = await query<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'user.provisioned' order by id desc limit 1`,
    );
    expect(audit.rows[0]?.diff).toMatchObject({
      email: OPT_IN,
      isAdmin: false,
      roles: ['requester'],
      source: 'access_auto_provision',
    });
  });

  it('opt-in で作った利用者は、無効に戻してもログインできる（既存利用者を壊さない）', async () => {
    config.accessAutoProvision = true;
    expect((await me({ 'cf-access-jwt-assertion': jwt({ email: EXISTING }) })).statusCode).toBe(200);

    config.accessAutoProvision = false;
    const res = await me({ 'cf-access-jwt-assertion': jwt({ email: EXISTING }) });
    expect(res.statusCode).toBe(200);
    expect(emailOf(res)).toBe(EXISTING);
    // 再ログインで増えない。
    const users = await query<{ count: number }>('select count(*)::int as count from app_user where email = $1', [EXISTING]);
    expect(users.rows[0]?.count).toBe(1);
  });
});
