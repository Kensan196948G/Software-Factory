/**
 * テスト用の環境変数を、config の読み込みより前に設定する。
 * 実際の値は scripts/local-run.mjs が注入する。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.ALLOW_SELF_APPROVAL = '1';
process.env.ALLOW_IMPORT = '1';
process.env.REQUIRE_ORIGIN_SECRET = '0';
process.env.COOKIE_SECURE = '0';
process.env.TRUST_PROXY = '0';
process.env.APP_BASE_URL = 'http://127.0.0.1:8781';
