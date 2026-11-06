import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHealthStatus, loadConfig } from '../../src/api/config.js';

/**
 * /healthz に出す認証状態（Issue #102 の残リスク）。
 * 「JWT 未設定 + ヘッダ信頼無効」で認証全断になる状態を misconfigured として固定する。
 */
const base = {
  authMode: 'access' as const,
  accessTeamDomain: 'https://unit-team.cloudflareaccess.example',
  accessAud: 'unit-aud',
  accessTrustEmailHeader: false,
  accessAllowedEmails: ['user@example.com'],
  accessAllowedDomain: '',
  appEnv: 'development' as const,
  isProduction: false,
};

describe('authHealthStatus', () => {
  it('password モードは常に ready（アプリのログインで認証できる）', () => {
    const status = authHealthStatus({
      ...base,
      authMode: 'password',
      accessTeamDomain: '',
      accessAud: '',
      accessAllowedEmails: [],
      accessAllowedDomain: '',
    });
    expect(status).toEqual({
      mode: 'password',
      jwtConfigured: false,
      headerTrustEnabled: false,
      allowlistConfigured: false,
      status: 'ready',
    });
  });

  it('access モードで JWT が設定済みなら ready', () => {
    const status = authHealthStatus(base);
    expect(status.mode).toBe('access');
    expect(status.jwtConfigured).toBe(true);
    expect(status.headerTrustEnabled).toBe(false);
    expect(status.allowlistConfigured).toBe(true);
    expect(status.status).toBe('ready');
  });

  it('access モードで JWT 未設定・ヘッダ信頼無効なら misconfigured（認証不能）', () => {
    const status = authHealthStatus({ ...base, accessTeamDomain: '', accessAud: '' });
    expect(status.jwtConfigured).toBe(false);
    expect(status.headerTrustEnabled).toBe(false);
    expect(status.status).toBe('misconfigured');
  });

  it('JWT 未設定でも、開発・テストでヘッダ信頼を明示 opt-in していれば ready', () => {
    const status = authHealthStatus({
      ...base,
      accessTeamDomain: '',
      accessAud: '',
      accessTrustEmailHeader: true,
    });
    expect(status.headerTrustEnabled).toBe(true);
    expect(status.status).toBe('ready');
  });

  it('ヘッダ信頼の opt-in が本番・staging で無効化される場合は misconfigured', () => {
    const staging = authHealthStatus({
      ...base,
      accessTeamDomain: '',
      accessAud: '',
      accessTrustEmailHeader: true,
      appEnv: 'staging',
    });
    expect(staging.headerTrustEnabled).toBe(false);
    expect(staging.status).toBe('misconfigured');

    const production = authHealthStatus({
      ...base,
      accessTeamDomain: '',
      accessAud: '',
      accessTrustEmailHeader: true,
      appEnv: 'production',
      isProduction: true,
    });
    expect(production.headerTrustEnabled).toBe(false);
    expect(production.status).toBe('misconfigured');
  });

  it('許可リストが空なら、JWT が設定済みでも全員拒否になるため misconfigured', () => {
    const status = authHealthStatus({ ...base, accessAllowedEmails: [], accessAllowedDomain: '' });
    expect(status.jwtConfigured).toBe(true);
    expect(status.allowlistConfigured).toBe(false);
    expect(status.status).toBe('misconfigured');
  });

  it('許可リストだけあっても認証経路が無ければ misconfigured（JWT 未設定・opt-in 無効）', () => {
    const status = authHealthStatus({
      ...base,
      accessTeamDomain: '',
      accessAud: '',
      accessAllowedDomain: 'example.com',
    });
    expect(status.allowlistConfigured).toBe(true);
    expect(status.status).toBe('misconfigured');
  });

  it('返すのは mode・真偽値・status だけで、team domain / AUD / メールを返さない', () => {
    const status = authHealthStatus(base);
    expect(Object.keys(status).sort()).toEqual(
      ['allowlistConfigured', 'headerTrustEnabled', 'jwtConfigured', 'mode', 'status'].sort(),
    );
    expect(JSON.stringify(status)).not.toContain('cloudflareaccess.example');
    expect(JSON.stringify(status)).not.toContain('unit-aud');
    expect(JSON.stringify(status)).not.toContain('user@example.com');
  });
});

describe('authHealthStatus: loadConfig との組み合わせ（本番相当）', () => {
  function stub(env: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('本番（NODE_ENV=production・JWT 未設定・ヘッダ信頼なし）は misconfigured', () => {
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
      ACCESS_TRUST_EMAIL_HEADER: undefined,
      ACCESS_ALLOWED_DOMAIN: 'example.com',
    });
    const cfg = loadConfig();
    const status = authHealthStatus(cfg);
    expect(status.jwtConfigured).toBe(false);
    expect(status.status).toBe('misconfigured');
  });

  it('JWT の 2 項目がそろえば ready', () => {
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: 'https://unit-team.cloudflareaccess.example',
      ACCESS_AUD: 'unit-aud',
      ACCESS_TRUST_EMAIL_HEADER: undefined,
      ACCESS_ALLOWED_DOMAIN: 'example.com',
    });
    const cfg = loadConfig();
    const status = authHealthStatus(cfg);
    expect(status.jwtConfigured).toBe(true);
    expect(status.status).toBe('ready');
  });
});
