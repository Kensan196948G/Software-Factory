/**
 * 単体テスト用の環境変数（config の読み込みより前に評価される）。
 * DB には接続しないが、config は DATABASE_URL の存在を要求するためダミーを置く。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://127.0.0.1:5432/mirai_sf_test';
process.env.MAIL_MODE = 'file';
process.env.MAIL_APPROVAL_TO = 'approver@example.com';
