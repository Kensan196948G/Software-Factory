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
