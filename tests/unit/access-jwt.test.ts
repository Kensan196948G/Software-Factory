import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createAccessJwtVerifier } from '../../src/api/access-jwt.js';
import { resolveAccessIdentity } from '../../src/api/auth.js';
import {
  accessJwtStartupWarning,
  config,
  isAccessHeaderTrustEnabled,
  isAccessJwtEnabled,
  loadConfig,
} from '../../src/api/config.js';

const TEAM = 'https://unit-team.cloudflareaccess.example';
const AUD = 'unit-test-aud';
const CERTS_URL = `${TEAM}/cdn-cgi/access/certs`;
const NOW_MS = Date.UTC(2026, 9, 31, 3, 0, 0);
const NOW = NOW_MS / 1000;

// 鍵はテストの実行時に生成する（リポジトリへ置かない）
const main = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwkOf(publicKey: KeyObject, kid: string): Record<string, unknown> {
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function claimsOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: TEAM, aud: [AUD], iat: NOW - 10, nbf: NOW - 10, exp: NOW + 600, email: 'user@example.com', ...overrides };
}

function signed(
  claims: Record<string, unknown> = claimsOf(),
  { kid = 'main', key = main.privateKey }: { kid?: string; key?: KeyObject } = {},
): string {
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(body).sign(key).toString('base64url');
  return `${body}.${signature}`;
}

/** JWKS 取得のモックと、差し替え可能な時計を持つ検証器。 */
function setup(keys: Record<string, unknown>[] = [jwkOf(main.publicKey, 'main')]) {
  const state = { keys, nowMs: NOW_MS };
  const fetchJwks = vi.fn(async (_url: string): Promise<unknown> => ({ keys: state.keys }));
  const onJwksError = vi.fn();
  const verifier = createAccessJwtVerifier({
    teamDomain: TEAM,
    aud: AUD,
    fetchJwks,
    onJwksError,
    now: () => state.nowMs,
  });
  return { state, fetchJwks, onJwksError, verifier };
}

// 実ネットワークへ出ていないことの保険。どの経路でも global fetch を呼べば失敗する
beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('テストから実ネットワークへ出ようとしました');
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('createAccessJwtVerifier: 署名と claim', () => {
  it('正しい署名を受け入れ、claim を返す', async () => {
    const { verifier, fetchJwks } = setup();
    const result = await verifier.verify(signed());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.email).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledWith(CERTS_URL);
  });

  it('aud は文字列でも受け入れる', async () => {
    const { verifier } = setup();
    expect((await verifier.verify(signed(claimsOf({ aud: AUD })))).ok).toBe(true);
  });

  it('nbf がなくても受け入れる', async () => {
    const { verifier } = setup();
    expect((await verifier.verify(signed(claimsOf({ nbf: undefined })))).ok).toBe(true);
  });

  it('本文を改ざんすると bad_signature', async () => {
    const { verifier } = setup();
    const [header, , signature] = signed().split('.');
    const tampered = `${header}.${b64(claimsOf({ email: 'attacker@example.com' }))}.${signature}`;
    expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('署名を改ざんすると bad_signature', async () => {
    const { verifier } = setup();
    const [header, payload, signature] = signed().split('.');
    const flipped = Buffer.from(signature!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(await verifier.verify(`${header}.${payload}.${flipped.toString('base64url')}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('別の鍵で同じ kid を名乗っても bad_signature', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(signed(claimsOf(), { key: other.privateKey }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('期限切れは expired（許容差の境界を含む）', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(signed(claimsOf({ exp: NOW - 3600 })))).toEqual({ ok: false, reason: 'expired' });
    expect(await verifier.verify(signed(claimsOf({ exp: NOW - 30 })))).toEqual({ ok: false, reason: 'expired' });
    expect((await verifier.verify(signed(claimsOf({ exp: NOW - 29 })))).ok).toBe(true);
  });

  it('exp がない・数値でないと expired', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(signed(claimsOf({ exp: undefined })))).toEqual({ ok: false, reason: 'expired' });
    expect(await verifier.verify(signed(claimsOf({ exp: String(NOW + 600) })))).toEqual({ ok: false, reason: 'expired' });
  });

  it('nbf が未来なら not_yet_valid（許容差の境界を含む）', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(signed(claimsOf({ nbf: NOW + 31 })))).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect((await verifier.verify(signed(claimsOf({ nbf: NOW + 30 })))).ok).toBe(true);
  });

  it('aud 違いは bad_audience', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(signed(claimsOf({ aud: ['other-aud'] })))).toEqual({ ok: false, reason: 'bad_audience' });
    expect(await verifier.verify(signed(claimsOf({ aud: 'other-aud' })))).toEqual({ ok: false, reason: 'bad_audience' });
    expect(await verifier.verify(signed(claimsOf({ aud: undefined })))).toEqual({ ok: false, reason: 'bad_audience' });
  });

  it('iss 違いは bad_issuer', async () => {
    const { verifier } = setup();
    const result = await verifier.verify(signed(claimsOf({ iss: 'https://evil.cloudflareaccess.example' })));
    expect(result).toEqual({ ok: false, reason: 'bad_issuer' });
  });

  it('alg=none は鍵を取りに行かず拒否する', async () => {
    const { verifier, fetchJwks } = setup();
    const body = `${b64({ alg: 'none', kid: 'main' })}.${b64(claimsOf())}`;
    expect(await verifier.verify(`${body}.`)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifier.verify(`${body}.AAAA`)).toEqual({ ok: false, reason: 'unsupported_alg' });
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it('公開鍵を HMAC の鍵にした HS256 は拒否する（鍵の取り違え攻撃）', async () => {
    const { verifier } = setup();
    const body = `${b64({ alg: 'HS256', kid: 'main' })}.${b64(claimsOf())}`;
    const pem = main.publicKey.export({ type: 'spki', format: 'pem' });
    const signature = createHmac('sha256', pem).update(body).digest('base64url');
    expect(await verifier.verify(`${body}.${signature}`)).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('crit ヘッダ付きは拒否する', async () => {
    const { verifier } = setup();
    const body = `${b64({ alg: 'RS256', kid: 'main', crit: ['x'] })}.${b64(claimsOf())}`;
    expect(await verifier.verify(`${body}.AAAA`)).toEqual({ ok: false, reason: 'unsupported_alg' });
  });

  it('kid がなければ missing_kid', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(`${b64({ alg: 'RS256' })}.${b64(claimsOf())}.AAAA`)).toEqual({
      ok: false,
      reason: 'missing_kid',
    });
  });

  it.each(['', 'a.b', 'a.b.c.d', '!!!.@@@.###', 'e30.e30.', 'bm90LWpzb24.e30.AAAA', 'W10.e30.AAAA'])(
    '形が壊れたトークンは例外を投げず malformed: %s',
    async (token) => {
      const { verifier, fetchJwks } = setup();
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'malformed' });
      expect(fetchJwks).not.toHaveBeenCalled();
    },
  );
});

describe('createAccessJwtVerifier: 公開鍵の取得とキャッシュ', () => {
  it('2回目以降はキャッシュを使う', async () => {
    const { verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    await verifier.verify(signed());
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('同時のリクエストでも取得は1本', async () => {
    const { verifier, fetchJwks } = setup();
    const results = await Promise.all([verifier.verify(signed()), verifier.verify(signed()), verifier.verify(signed())]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('未知の kid は再取得してから拒否する', async () => {
    const { state, verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    state.nowMs += 31_000;
    expect(await verifier.verify(signed(claimsOf(), { kid: 'unknown', key: other.privateKey }))).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('未知の kid を連打されても最小間隔の間は取りに行かない', async () => {
    const { state, verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    state.nowMs += 31_000;
    for (let i = 0; i < 5; i += 1) {
      await verifier.verify(signed(claimsOf(), { kid: `unknown-${i}` }));
    }
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('鍵のローテーション: kid 不一致で再取得し、新しい鍵で検証できる', async () => {
    const { state, verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    state.keys = [jwkOf(main.publicKey, 'main'), jwkOf(other.publicKey, 'next')];
    state.nowMs += 31_000;
    const result = await verifier.verify(signed(claimsOf(), { kid: 'next', key: other.privateKey }));
    expect(result.ok).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('有効期間が過ぎたら取り直し、消えた鍵は使えなくなる', async () => {
    const { state, verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    state.keys = [jwkOf(other.publicKey, 'next')];
    state.nowMs += 60 * 60_000;
    const claims = claimsOf({ exp: state.nowMs / 1000 + 600 });
    expect(await verifier.verify(signed(claims))).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('初回の取得に失敗すると拒否し（例外にしない）、最小間隔の後に回復する', async () => {
    const { state, verifier, fetchJwks, onJwksError } = setup();
    fetchJwks.mockRejectedValueOnce(new Error('network down'));
    expect(await verifier.verify(signed())).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(onJwksError).toHaveBeenCalledWith('network down');
    state.nowMs += 31_000;
    expect((await verifier.verify(signed())).ok).toBe(true);
  });

  it('更新に失敗しても期限内の鍵は使い続け、上限を過ぎたら拒否する', async () => {
    const { state, verifier, fetchJwks } = setup();
    await verifier.verify(signed());
    fetchJwks.mockRejectedValue(new Error('network down'));

    state.nowMs += 2 * 60 * 60_000;
    expect((await verifier.verify(signed(claimsOf({ exp: state.nowMs / 1000 + 600 })))).ok).toBe(true);

    state.nowMs += 24 * 60 * 60_000;
    expect(await verifier.verify(signed(claimsOf({ exp: state.nowMs / 1000 + 600 })))).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });

  it('使える鍵のない応答では以前のキャッシュを捨てない', async () => {
    const { state, verifier, onJwksError } = setup();
    await verifier.verify(signed());
    state.keys = [];
    state.nowMs += 60 * 60_000;
    expect((await verifier.verify(signed(claimsOf({ exp: state.nowMs / 1000 + 600 })))).ok).toBe(true);
    expect(onJwksError).toHaveBeenCalledTimes(1);
  });

  it('RSA 以外・用途違い・2048bit 未満の鍵は使わない', async () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { verifier } = setup([
      { ...jwkOf(main.publicKey, 'enc'), use: 'enc' },
      { ...jwkOf(main.publicKey, 'rs512'), alg: 'RS512' },
      { ...jwkOf(small.publicKey, 'small') },
      { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec' },
    ]);
    for (const kid of ['enc', 'rs512']) {
      expect(await verifier.verify(signed(claimsOf(), { kid }))).toEqual({ ok: false, reason: 'unknown_kid' });
    }
    expect(await verifier.verify(signed(claimsOf(), { kid: 'small', key: small.privateKey }))).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });
});

describe('resolveAccessIdentity', () => {
  const restore = {
    authMode: config.authMode,
    team: config.accessTeamDomain,
    aud: config.accessAud,
    emails: config.accessAllowedEmails,
    domain: config.accessAllowedDomain,
    tokens: config.accessServiceTokenIds,
    trustEmailHeader: config.accessTrustEmailHeader,
    appEnv: config.appEnv,
    isProduction: config.isProduction,
  };
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify({ keys: [jwkOf(main.publicKey, 'main')] }), { status: 200 });
  });

  function realClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Date.now() / 1000;
    return { iss: TEAM, aud: [AUD], nbf: now - 10, exp: now + 600, ...overrides };
  }

  beforeEach(() => {
    config.authMode = 'access';
    config.accessAllowedEmails = ['admin@example.com'];
    config.accessAllowedDomain = 'example.com';
    config.accessServiceTokenIds = ['allowed-client.access'];
    config.accessTeamDomain = TEAM;
    config.accessAud = AUD;
    // ヘッダ信頼の opt-in は既定で無効。本番相当でない開発環境として扱う。
    config.accessTrustEmailHeader = false;
    config.appEnv = 'development';
    config.isProduction = false;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
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
    config.isProduction = restore.isProduction;
  });

  it('JWT のメールを使い、ヘッダのメールは使わない', async () => {
    const identity = await resolveAccessIdentity({
      'cf-access-jwt-assertion': signed(realClaims({ email: 'Jwt.User@Example.com' })),
      'cf-access-authenticated-user-email': 'header.user@example.com',
    });
    expect(identity).toBe('jwt.user@example.com');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CERTS_URL);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('JWT のヘッダがなければ、メール・クライアントIDのヘッダがあっても拒否する', async () => {
    const identity = await resolveAccessIdentity({
      'cf-access-authenticated-user-email': 'admin@example.com',
      'cf-access-client-id': 'allowed-client.access',
    });
    expect(identity).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不正な JWT は理由だけをログに残して拒否する（トークンを出さない）', async () => {
    const warn = vi.fn();
    const token = signed(realClaims({ email: 'user@example.com', aud: ['other-aud'] }));
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': token }, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('bad_audience');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it('許可されていないメールは署名が正しくても拒否する', async () => {
    const token = signed(realClaims({ email: 'someone@other.example' }));
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': token })).toBeNull();
  });

  it('サービストークンは common_name が許可リストにあるときだけ通す', async () => {
    const allowed = signed(realClaims({ common_name: 'allowed-client.access' }));
    const denied = signed(realClaims({ common_name: 'other-client.access' }));
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': allowed })).toBe('admin@example.com');
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': denied })).toBeNull();
  });

  it('email も common_name もない JWT は拒否する', async () => {
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': signed(realClaims()) })).toBeNull();
  });

  it('許可外のメールと許可済み common_name が両方あっても、サービストークンとして通さない', async () => {
    const token = signed(realClaims({ email: 'someone@other.example', common_name: 'allowed-client.access' }));
    expect(await resolveAccessIdentity({ 'cf-access-jwt-assertion': token })).toBeNull();
  });

  describe('JWT 未設定は fail-closed（opt-in がない限りヘッダを信頼しない）', () => {
    beforeEach(() => {
      config.accessTeamDomain = '';
      config.accessAud = '';
    });

    it('許可メールのヘッダがあっても拒否する（公開鍵も取りに行かない）', async () => {
      expect(await resolveAccessIdentity({ 'cf-access-authenticated-user-email': 'User@Example.com' })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('クライアントIDのヘッダがあっても拒否する', async () => {
      expect(await resolveAccessIdentity({ 'cf-access-client-id': 'allowed-client.access' })).toBeNull();
      expect(await resolveAccessIdentity({ 'cf-access-client-id': 'other' })).toBeNull();
    });

    it('JWT があっても見ない', async () => {
      expect(
        await resolveAccessIdentity({ 'cf-access-jwt-assertion': signed(realClaims({ email: 'a@example.com' })) }),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('既定ではヘッダ信頼の判定が false（fail-closed）', () => {
      expect(isAccessHeaderTrustEnabled(config)).toBe(false);
    });

    describe('明示 opt-in（ACCESS_TRUST_EMAIL_HEADER=1）があるときだけ従来動作', () => {
      beforeEach(() => {
        config.accessTrustEmailHeader = true;
      });

      it('ヘッダのメールを使い、正規化する', async () => {
        expect(await resolveAccessIdentity({ 'cf-access-authenticated-user-email': 'User@Example.com' })).toBe(
          'user@example.com',
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('クライアントIDのヘッダでサービストークンとして通る', async () => {
        expect(await resolveAccessIdentity({ 'cf-access-client-id': 'allowed-client.access' })).toBe('admin@example.com');
        expect(await resolveAccessIdentity({ 'cf-access-client-id': 'other' })).toBeNull();
      });

      it.each(['staging', 'production'] as const)('APP_ENV=%s では opt-in を無視して拒否する', async (appEnv) => {
        config.appEnv = appEnv;
        expect(await resolveAccessIdentity({ 'cf-access-authenticated-user-email': 'admin@example.com' })).toBeNull();
        expect(await resolveAccessIdentity({ 'cf-access-client-id': 'allowed-client.access' })).toBeNull();
      });

      it('NODE_ENV=production 相当（isProduction）でも opt-in を無視して拒否する', async () => {
        config.isProduction = true;
        expect(await resolveAccessIdentity({ 'cf-access-authenticated-user-email': 'admin@example.com' })).toBeNull();
      });
    });
  });
});

describe('ACCESS_TEAM_DOMAIN / ACCESS_AUD の設定', () => {
  function stub(env: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  beforeEach(() => {
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      NODE_ENV: 'production',
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
      ACCESS_TRUST_EMAIL_HEADER: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('両方設定すると有効になり、末尾スラッシュを除いて持つ', () => {
    stub({ ACCESS_TEAM_DOMAIN: `${TEAM}/`, ACCESS_AUD: ` ${AUD} ` });
    const cfg = loadConfig();
    expect(cfg.accessTeamDomain).toBe(TEAM);
    expect(cfg.accessAud).toBe(AUD);
    expect(isAccessJwtEnabled(cfg)).toBe(true);
    expect(accessJwtStartupWarning(cfg)).toBeNull();
  });

  it('未設定・空文字なら無効で、本番モードでは警告する', () => {
    for (const value of [undefined, '', '  ']) {
      stub({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: value });
      const cfg = loadConfig();
      expect(isAccessJwtEnabled(cfg)).toBe(false);
      expect(accessJwtStartupWarning(cfg)).toMatch(/ACCESS_TEAM_DOMAIN/);
      expect(accessJwtStartupWarning(cfg)).toMatch(/信頼しません/);
    }
  });

  it('本番モード以外、または password モードでは警告しない', () => {
    stub({ NODE_ENV: 'development' });
    expect(accessJwtStartupWarning(loadConfig())).toBeNull();
    stub({ NODE_ENV: 'production', AUTH_MODE: 'password' });
    expect(accessJwtStartupWarning(loadConfig())).toBeNull();
  });

  it('片方だけの設定は起動エラーにする', () => {
    stub({ ACCESS_TEAM_DOMAIN: TEAM });
    expect(() => loadConfig()).toThrow(/両方設定/);
    stub({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD });
    expect(() => loadConfig()).toThrow(/両方設定/);
  });

  it.each(['unit-team.cloudflareaccess.example', 'http://t.example', 'https://t.example/path', 'https://u:p@t.example'])(
    '不正なドメインは起動エラーにする: %s',
    (domain) => {
      stub({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD });
      expect(() => loadConfig()).toThrow(/ACCESS_TEAM_DOMAIN が不正/);
    },
  );

  it('password モードでは設定を見ない（片方だけでも起動できる）', () => {
    stub({ AUTH_MODE: 'password', ACCESS_TEAM_DOMAIN: TEAM });
    const cfg = loadConfig();
    expect(cfg.accessTeamDomain).toBe('');
    expect(isAccessJwtEnabled(cfg)).toBe(false);
  });
});

describe('ACCESS_TRUST_EMAIL_HEADER（ヘッダ信頼の明示 opt-in・Issue #102）', () => {
  function stub(env: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  beforeEach(() => {
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      NODE_ENV: 'test',
      APP_ENV: undefined,
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
      ACCESS_TRUST_EMAIL_HEADER: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('既定は無効（未設定）', () => {
    const cfg = loadConfig();
    expect(cfg.accessTrustEmailHeader).toBe(false);
    expect(isAccessHeaderTrustEnabled(cfg)).toBe(false);
  });

  it('0 は無効として扱う', () => {
    stub({ ACCESS_TRUST_EMAIL_HEADER: '0' });
    const cfg = loadConfig();
    expect(cfg.accessTrustEmailHeader).toBe(false);
    expect(isAccessHeaderTrustEnabled(cfg)).toBe(false);
  });

  it('開発・テストでは 1 で有効になる', () => {
    stub({ NODE_ENV: 'development', ACCESS_TRUST_EMAIL_HEADER: '1' });
    const cfg = loadConfig();
    expect(cfg.accessTrustEmailHeader).toBe(true);
    expect(isAccessHeaderTrustEnabled(cfg)).toBe(true);
  });

  it.each(['staging', 'production'] as const)('APP_ENV=%s では 1 を起動エラーにする', (appEnv) => {
    stub({ APP_ENV: appEnv, ACCESS_TRUST_EMAIL_HEADER: '1' });
    expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER/);
  });

  it('NODE_ENV=production では 1 を起動エラーにする（APP_ENV 省略時）', () => {
    stub({ NODE_ENV: 'production', ACCESS_TRUST_EMAIL_HEADER: '1' });
    expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER/);
  });

  it('0 / 1 以外は起動エラーにする', () => {
    stub({ ACCESS_TRUST_EMAIL_HEADER: 'true' });
    expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER/);
  });

  it('AUTH_MODE=password では opt-in が立っていてもヘッダ信頼は無効', () => {
    stub({ AUTH_MODE: 'password', ACCESS_TRUST_EMAIL_HEADER: '1' });
    const cfg = loadConfig();
    expect(isAccessJwtEnabled(cfg)).toBe(false);
    expect(isAccessHeaderTrustEnabled(cfg)).toBe(false);
  });
});
