import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/api/config.js';

/** loadConfig は process.env を優先するので、環境変数で条件を作る。 */
function stub(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

describe('APP_ENV', () => {
  beforeEach(() => {
    // 開発者の設定（COOKIE_SECURE など）に結果を左右されないようにする
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      APP_ENV: undefined,
      COOKIE_SECURE: undefined,
      REQUIRE_ORIGIN_SECRET: undefined,
      MAIL_MODE: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['development', 'test', 'production'])('未指定なら NODE_ENV=%s と同じ名前になる', (nodeEnv) => {
    stub({ NODE_ENV: nodeEnv });
    expect(loadConfig().appEnv).toBe(nodeEnv);
  });

  it('空文字は未指定として扱う（EnvironmentFile の `APP_ENV=`）', () => {
    stub({ NODE_ENV: 'production', APP_ENV: '' });
    expect(loadConfig().appEnv).toBe('production');
  });

  it('設定ファイル相当の値からも読める', () => {
    stub({ NODE_ENV: 'production' });
    expect(loadConfig({ APP_ENV: 'staging' }).appEnv).toBe('staging');
  });

  it('staging でも NODE_ENV=production のセキュリティ挙動を保つ', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'staging' });
    const cfg = loadConfig();
    expect(cfg.appEnv).toBe('staging');
    expect(cfg.nodeEnv).toBe('production');
    expect(cfg.isProduction).toBe(true);
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.requireOriginSecret).toBe(true);
    expect(cfg.mailMode).toBe('off');
  });

  it('APP_ENV=production でも NODE_ENV が production でなければ本番挙動にしない', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'production' });
    const cfg = loadConfig();
    expect(cfg.appEnv).toBe('production');
    expect(cfg.isProduction).toBe(false);
    expect(cfg.cookieSecure).toBe(false);
    expect(cfg.requireOriginSecret).toBe(false);
  });

  it('不正な値は起動エラーにする', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'prod' });
    expect(() => loadConfig()).toThrow(/APP_ENV が不正/);
  });
});

/**
 * Issue #102: ACCESS_TRUST_EMAIL_HEADER の起動時判定。
 * staging / production 経路だけでなく、NODE_ENV=production と APP_ENV 明示の組合せも起動時に拒否することを固定する。
 */
describe('ACCESS_TRUST_EMAIL_HEADER', () => {
  beforeEach(() => {
    stub({
      MIRAI_SF_CONFIG_FILE: undefined,
      COOKIE_SECURE: undefined,
      REQUIRE_ORIGIN_SECRET: undefined,
      MAIL_MODE: undefined,
      AUTH_MODE: 'access',
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('既定は無効（未設定なら false）', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'development', ACCESS_TRUST_EMAIL_HEADER: undefined });
    expect(loadConfig().accessTrustEmailHeader).toBe(false);
  });

  it('APP_ENV を明示した development / test では 1 を許可する', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'test', ACCESS_TRUST_EMAIL_HEADER: '1' });
    expect(loadConfig().accessTrustEmailHeader).toBe(true);
  });

  it('NODE_ENV=production なら APP_ENV が test / development でも 1 は起動エラー', () => {
    for (const appEnv of ['test', 'development']) {
      stub({ NODE_ENV: 'production', APP_ENV: appEnv, ACCESS_TRUST_EMAIL_HEADER: '1' });
      expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER=1 は本番・staging では使えません/);
    }
  });

  it('APP_ENV=staging / production、APP_ENV 未設定では 1 は起動エラー', () => {
    for (const appEnv of ['staging', 'production', undefined]) {
      stub({ NODE_ENV: 'development', APP_ENV: appEnv, ACCESS_TRUST_EMAIL_HEADER: '1' });
      expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER=1/);
    }
  });

  it('AUTH_MODE=password では 1 があっても無言で無効（起動エラーにしない）', () => {
    stub({
      NODE_ENV: 'development',
      APP_ENV: 'development',
      AUTH_MODE: 'password',
      ACCESS_TRUST_EMAIL_HEADER: '1',
    });
    expect(loadConfig().accessTrustEmailHeader).toBe(false);
  });

  it('0 と 1 以外は起動エラー', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'development', ACCESS_TRUST_EMAIL_HEADER: 'true' });
    expect(() => loadConfig()).toThrow(/ACCESS_TRUST_EMAIL_HEADER が不正/);
  });
});
