/**
 * /healthz の認証状態（Issue #102 の残リスク）。
 * 「JWT 未設定 + Access ヘッダ信頼無効」でも /healthz は 200 を返すため、
 * 外形監視が認証全断を検知できるように auth.status を追加する。秘密の値は返さない。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, prepareTestDb } from './helpers.js';
import { config } from '../../src/api/config.js';

const TEAM = 'https://secret-team.cloudflareaccess.example';
const AUD = 'secret-aud-should-not-appear';
const ALLOWED_EMAIL = 'secret-user-should-not-appear@example.com';

let app: FastifyInstance;
const restore = {
  authMode: config.authMode,
  team: config.accessTeamDomain,
  aud: config.accessAud,
  emails: config.accessAllowedEmails,
  domain: config.accessAllowedDomain,
  trustEmailHeader: config.accessTrustEmailHeader,
  appEnv: config.appEnv,
  isProduction: config.isProduction,
};

type HealthBody = {
  status: string;
  app: string;
  version: string;
  commit: string;
  environment: string;
  db: { ok: boolean; latencyMs?: number; error?: string };
  auth: {
    mode: string;
    jwtConfigured: boolean;
    headerTrustEnabled: boolean;
    allowlistConfigured: boolean;
    usersActive?: number;
    status: string;
  };
  now: string;
};

async function health(): Promise<{ res: Awaited<ReturnType<FastifyInstance['inject']>>; body: HealthBody }> {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  return { res, body: res.json() as HealthBody };
}

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  config.authMode = 'access';
  config.accessTeamDomain = '';
  config.accessAud = '';
  config.accessAllowedEmails = [];
  config.accessAllowedDomain = 'example.com';
  config.accessTrustEmailHeader = false;
  config.appEnv = 'test';
  config.isProduction = false;
});

afterEach(() => {
  config.authMode = restore.authMode;
  config.accessTeamDomain = restore.team;
  config.accessAud = restore.aud;
  config.accessAllowedEmails = restore.emails;
  config.accessAllowedDomain = restore.domain;
  config.accessTrustEmailHeader = restore.trustEmailHeader;
  config.appEnv = restore.appEnv;
  config.isProduction = restore.isProduction;
});

describe('/healthz の auth 情報', () => {
  it('既存の項目を保ったまま auth を追加で返す（password モードは ready）', async () => {
    config.authMode = 'password';
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    // 既存の契約（追加のみ）
    expect(body.status).toBe('ok');
    expect(body.app).toBe('mirai-sf-intake');
    expect(typeof body.version).toBe('string');
    expect(typeof body.commit).toBe('string');
    expect(body.environment).toBe('test');
    expect(body.db.ok).toBe(true);
    expect(typeof body.now).toBe('string');
    // auth は password モードでは Access の設定を使わない
    expect(body.auth).toMatchObject({
      mode: 'password',
      jwtConfigured: false,
      headerTrustEnabled: false,
      allowlistConfigured: true,
      status: 'ready',
    });
    // 有効な利用者の件数（C-07）。件数だけで、メール・ID・名前は返さない
    expect(typeof body.auth.usersActive).toBe('number');
    expect(body.auth.usersActive).toBeGreaterThanOrEqual(0);
  });

  it('access モードで JWT が設定済みなら ready', async () => {
    config.accessTeamDomain = TEAM;
    config.accessAud = AUD;
    config.accessAllowedEmails = [ALLOWED_EMAIL];
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.auth.jwtConfigured).toBe(true);
    expect(body.auth.status).toBe('ready');
  });

  it('本番相当で JWT 未設定・ヘッダ信頼無効なら 200 のまま misconfigured（認証不能を検知できる）', async () => {
    config.appEnv = 'production';
    config.isProduction = true;
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.auth).toMatchObject({
      mode: 'access',
      jwtConfigured: false,
      headerTrustEnabled: false,
      allowlistConfigured: true,
      status: 'misconfigured',
    });
    expect(typeof body.auth.usersActive).toBe('number');
  });

  it('JWT 未設定でも開発・テストのヘッダ信頼 opt-in が有効なら ready', async () => {
    config.accessTrustEmailHeader = true;
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.auth.headerTrustEnabled).toBe(true);
    expect(body.auth.status).toBe('ready');
  });

  it('staging ではヘッダ信頼の opt-in が効かず misconfigured', async () => {
    config.accessTrustEmailHeader = true;
    config.appEnv = 'staging';
    config.isProduction = true;
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.auth.headerTrustEnabled).toBe(false);
    expect(body.auth.status).toBe('misconfigured');
  });

  it('許可リストが空なら JWT が設定済みでも misconfigured', async () => {
    config.accessTeamDomain = TEAM;
    config.accessAud = AUD;
    config.accessAllowedEmails = [];
    config.accessAllowedDomain = '';
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.auth.jwtConfigured).toBe(true);
    expect(body.auth.allowlistConfigured).toBe(false);
    expect(body.auth.status).toBe('misconfigured');
  });

  it('team domain・AUD・メールアドレスは応答に出さない（キーも値も）', async () => {
    config.accessTeamDomain = TEAM;
    config.accessAud = AUD;
    config.accessAllowedEmails = [ALLOWED_EMAIL];
    const { res } = await health();
    const text = res.body;
    expect(text).not.toContain(TEAM);
    expect(text).not.toContain('cloudflareaccess.example');
    expect(text).not.toContain(AUD);
    expect(text).not.toContain(ALLOWED_EMAIL);
    expect(text).not.toContain('secret-user-should-not-appear');
    const auth = (res.json() as HealthBody).auth;
    expect(Object.keys(auth).sort()).toEqual(
      ['allowlistConfigured', 'headerTrustEnabled', 'jwtConfigured', 'mode', 'status', 'usersActive'].sort(),
    );
  });

  it('usersActive は有効な app_user の件数と一致する（DB を変更しない）', async () => {
    const { pool } = await import('../../src/api/db.js');
    const counted = await pool.query<{ count: number }>('select count(*)::int as count from app_user where is_active');
    const { res, body } = await health();
    expect(res.statusCode).toBe(200);
    expect(body.auth.usersActive).toBe(counted.rows[0]?.count ?? 0);
  });
});
