import { describe, expect, it } from 'vitest';
import { childEnv } from '../../scripts/local-run-env.mjs';

/**
 * 本番の安全スイッチ（DEVLINE_ALLOW_PRODUCTION）は、local.json ではなく
 * 呼び出し元の明示環境だけで有効にする。docs/devline/production-automation.md
 */
describe('local-run が子プロセスへ渡す環境', () => {
  it('local.json の DEVLINE_ALLOW_PRODUCTION では有効にならない', () => {
    const env = childEnv({
      processEnv: {},
      fileConfig: { DEVLINE_ALLOW_PRODUCTION: '1' },
      configPath: '/tmp/local.json',
    });
    expect(env.DEVLINE_ALLOW_PRODUCTION).toBeUndefined();
  });

  it('呼び出し元の環境変数があれば、local.json より優先する', () => {
    expect(
      childEnv({
        processEnv: { DEVLINE_ALLOW_PRODUCTION: '0' },
        fileConfig: { DEVLINE_ALLOW_PRODUCTION: '1' },
        configPath: '/x',
      }).DEVLINE_ALLOW_PRODUCTION,
    ).toBe('0');
    expect(
      childEnv({
        processEnv: { DEVLINE_ALLOW_PRODUCTION: '1' },
        fileConfig: { DEVLINE_ALLOW_PRODUCTION: '0' },
        configPath: '/x',
      }).DEVLINE_ALLOW_PRODUCTION,
    ).toBe('1');
  });

  it('他の設定は従来どおり local.json を優先し、MIRAI_SF_CONFIG_FILE を渡す', () => {
    const env = childEnv({
      processEnv: { DATABASE_URL: 'env-db', KEEP: 'yes' },
      fileConfig: { DATABASE_URL: 'file-db' },
      configPath: '/cfg.json',
    });
    expect(env).toMatchObject({ DATABASE_URL: 'file-db', KEEP: 'yes', MIRAI_SF_CONFIG_FILE: '/cfg.json' });
  });
});
