#!/usr/bin/env node
/**
 * ローカル開発用の .env を生成する（既存があれば上書きしない）。
 * 秘密値はこのスクリプト内で生成し、標準出力には出さない。
 * 使い方: node scripts/setup-env.mjs [--force]
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(envPath) && !force) {
  console.log('.env は既に存在します（--force で再生成）');
  process.exit(0);
}

function token(bytes) {
  return randomBytes(bytes).toString('base64url');
}

let dbPassword = '';
try {
  dbPassword = readFileSync('/tmp/mirai_sf_pw.txt', 'utf8').trim();
} catch {
  dbPassword = process.env.DB_PASSWORD ?? '';
}
if (!dbPassword) {
  console.error('DB パスワードが見つかりません。/tmp/mirai_sf_pw.txt か DB_PASSWORD を用意してください。');
  process.exit(1);
}

const adminPassword = `MiraiSF-${token(9)}`;
const lines = [
  '# みらいSF 受付ステーション MVP — ローカル開発用（このファイルは commit しない）',
  'NODE_ENV=development',
  'PORT=8781',
  'APP_BASE_URL=http://127.0.0.1:5178',
  `DATABASE_URL=postgresql://mirai_sf_app:${encodeURIComponent(dbPassword)}@127.0.0.1:5432/mirai_sf_dev`,
  `TEST_DATABASE_URL=postgresql://mirai_sf_app:${encodeURIComponent(dbPassword)}@127.0.0.1:5432/mirai_sf_test`,
  'MIGRATION_DATABASE_URL=postgresql:///mirai_sf_dev?host=/var/run/postgresql',
  'TEST_MIGRATION_DATABASE_URL=postgresql:///mirai_sf_test?host=/var/run/postgresql',
  `SESSION_SECRET=${token(32)}`,
  `ORIGIN_SHARED_SECRET=${token(32)}`,
  'REQUIRE_ORIGIN_SECRET=0',
  'TRUST_PROXY=1',
  'SEED_ADMIN_EMAIL=kensan1969@gmail.com',
  `SEED_ADMIN_PASSWORD=${adminPassword}`,
  'SEED_ADMIN_NAME=管理者',
  'SEED_ADMIN_DEPT=dx',
  'APP_VERSION=0.1.0',
  'COMMIT_SHA=dev',
  '',
];
writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`.env を生成しました: ${envPath}`);
console.log(`初期管理者: kensan1969@gmail.com / パスワードは .env の SEED_ADMIN_PASSWORD（ローカル保管）`);
