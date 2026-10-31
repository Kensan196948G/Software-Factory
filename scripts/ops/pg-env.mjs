#!/usr/bin/env node
/**
 * DATABASE_URL を libpq の環境変数へ分解する（接続文字列を argv / ログに出さないため）。
 *
 *   node pg-env.mjs                  → shell へ eval する export 文を標準出力へ
 *   node pg-env.mjs --url-for-db X   → DB名だけを X に差し替えた URL を標準出力へ
 *
 * 標準出力は必ず変数へ受け取ること。エラーには値を含めない。
 */
function fail(message) {
  console.error(`pg-env: ${message}`);
  process.exit(2);
}

const DB_NAME = /^[A-Za-z0-9_]{1,63}$/;
const raw = process.env.DATABASE_URL;
if (!raw) fail('DATABASE_URL が未設定です');

let url;
try {
  url = new URL(raw);
} catch {
  fail('DATABASE_URL を URL として解釈できません');
}
if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') fail('DATABASE_URL の形式が postgresql:// ではありません');

const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!DB_NAME.test(dbName)) fail('DATABASE_URL のDB名は英数字と _ のみ対応しています');

if (process.argv[2] === '--url-for-db') {
  const target = process.argv[3] ?? '';
  if (!DB_NAME.test(target)) fail('--url-for-db のDB名が不正です');
  url.pathname = `/${target}`;
  process.stdout.write(url.toString());
  process.exit(0);
}

const out = {
  PGDATABASE: dbName,
  PGHOST: decodeURIComponent(url.hostname),
  PGPORT: url.port,
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
const PARAMS = new Map([
  ['host', 'PGHOST'],
  ['port', 'PGPORT'],
  ['user', 'PGUSER'],
  ['password', 'PGPASSWORD'],
  ['sslmode', 'PGSSLMODE'],
]);
for (const [key, value] of url.searchParams) {
  const name = PARAMS.get(key);
  if (!name) fail(`DATABASE_URL の未対応パラメータ: ${key}`);
  out[name] = value;
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const lines = ['unset PGHOST PGPORT PGUSER PGPASSWORD PGSSLMODE PGDATABASE PGSERVICE PGSERVICEFILE'];
for (const [name, value] of Object.entries(out)) {
  if (value) lines.push(`export ${name}=${quote(value)}`);
}
process.stdout.write(`${lines.join('\n')}\n`);
