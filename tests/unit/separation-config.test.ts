import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/api/config.js';

/** loadConfig は process.env を優先するので、環境変数で条件を作る。 */
function stub(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const BASE_ENV = {
  MIRAI_SF_CONFIG_FILE: undefined,
  COOKIE_SECURE: undefined,
  REQUIRE_ORIGIN_SECRET: undefined,
  MAIL_MODE: undefined,
  DATABASE_URL: 'postgresql:///unit_test?host=/var/run/postgresql',
};

describe('自己承認の既定（職務分離）', () => {
  beforeEach(() => {
    stub({ ...BASE_ENV, NODE_ENV: 'test', APP_ENV: undefined, ALLOW_SELF_APPROVAL: undefined });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('APP_ENV=production では既定で拒否する（ALLOW_SELF_APPROVAL 未指定 = 0）', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'production' });
    const cfg = loadConfig();
    expect(cfg.allowSelfApproval).toBe(false);
    expect(cfg.selfApprovalForcedInProduction).toBe(false);
  });

  it('APP_ENV=production でも明示の 1 は許可するが、警告フラグを立てる', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'production', ALLOW_SELF_APPROVAL: '1' });
    const cfg = loadConfig();
    expect(cfg.allowSelfApproval).toBe(true);
    expect(cfg.selfApprovalForcedInProduction).toBe(true);
  });

  it('APP_ENV=production の明示 0 は拒否（警告フラグなし）', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'production', ALLOW_SELF_APPROVAL: '0' });
    const cfg = loadConfig();
    expect(cfg.allowSelfApproval).toBe(false);
    expect(cfg.selfApprovalForcedInProduction).toBe(false);
  });

  it('開発・テスト・staging の既定は従来どおり許可する（1）', () => {
    for (const appEnv of ['development', 'test', 'staging']) {
      stub({ NODE_ENV: appEnv === 'test' ? 'test' : 'development', APP_ENV: appEnv, ALLOW_SELF_APPROVAL: undefined });
      const cfg = loadConfig();
      expect(cfg.allowSelfApproval, appEnv).toBe(true);
      expect(cfg.selfApprovalForcedInProduction, appEnv).toBe(false);
    }
  });

  it('APP_ENV=production 以外で明示 0 は拒否する（警告フラグは立てない）', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'development', ALLOW_SELF_APPROVAL: '0' });
    const cfg = loadConfig();
    expect(cfg.allowSelfApproval).toBe(false);
    expect(cfg.selfApprovalForcedInProduction).toBe(false);
  });

  it('APP_ENV が production なら NODE_ENV が development でも既定は拒否（本番判定は APP_ENV）', () => {
    stub({ NODE_ENV: 'development', APP_ENV: 'production', ALLOW_SELF_APPROVAL: undefined });
    const cfg = loadConfig();
    expect(cfg.isProduction).toBe(false);
    expect(cfg.appEnv).toBe('production');
    expect(cfg.allowSelfApproval).toBe(false);
  });

  it('空文字の ALLOW_SELF_APPROVAL は未指定として扱う（EnvironmentFile の `ALLOW_SELF_APPROVAL=`）', () => {
    stub({ NODE_ENV: 'production', APP_ENV: 'production', ALLOW_SELF_APPROVAL: '' });
    const cfg = loadConfig();
    expect(cfg.allowSelfApproval).toBe(false);
    expect(cfg.selfApprovalForcedInProduction).toBe(false);
  });
});
