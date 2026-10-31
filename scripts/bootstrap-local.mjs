#!/usr/bin/env node
/**
 * ローカル開発用の設定をワークスペース外（~/.config/mirai-sf/local.json）に生成する。
 * リポジトリやログに秘密情報を残さないための分離。
 *
 * 使い方: node scripts/bootstrap-local.mjs
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const dir = resolve(homedir(), '.config/mirai-sf');
const file = resolve(dir, 'local.json');
const force = process.argv.includes('--force');

mkdirSync(dir, { recursive: true, mode: 0o700 });

let current = {};
if (existsSync(file)) {
  if (!force) {
    console.log(`設定は既にあります: ${file}（--force で再生成）`);
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
      console.log(`初期管理者: ${current.SEED_ADMIN_EMAIL}`);
    } catch {
      /* 壊れていれば作り直す */
    }
    process.exit(0);
  }
  current = JSON.parse(readFileSync(file, 'utf8'));
}

const token = (bytes) => randomBytes(bytes).toString('base64url');
const peer = (db) => `postgresql:///${db}?host=/var/run/postgresql`;

const config = {
  NODE_ENV: 'development',
  PORT: 8781,
  HOST: '127.0.0.1',
  APP_BASE_URL: 'http://127.0.0.1:5178',
  DATABASE_URL: peer('mirai_sf_dev'),
  MIGRATION_DATABASE_URL: peer('mirai_sf_dev'),
  TEST_DATABASE_URL: peer('mirai_sf_test'),
  TEST_MIGRATION_DATABASE_URL: peer('mirai_sf_test'),
  SESSION_SECRET: current.SESSION_SECRET ?? token(32),
  ORIGIN_SHARED_SECRET: current.ORIGIN_SHARED_SECRET ?? token(32),
  REQUIRE_ORIGIN_SECRET: '0',
  TRUST_PROXY: '1',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL ?? current.SEED_ADMIN_EMAIL ?? 'admin@example.com',
  SEED_ADMIN_PASSWORD:
    process.argv.includes('--new-password') || !current.SEED_ADMIN_PASSWORD ? `MiraiSF-${token(9)}` : current.SEED_ADMIN_PASSWORD,
  SEED_ADMIN_NAME: '管理者',
  SEED_ADMIN_DEPT: 'dx',
  ALLOW_SELF_APPROVAL: '1',
  ALLOW_IMPORT: '1',
  APP_VERSION: '0.1.0',
  COMMIT_SHA: 'local',
};

writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
chmodSync(file, 0o600);

console.log(`設定を生成しました: ${file} (0600)`);
console.log(`初期管理者: ${config.SEED_ADMIN_EMAIL}`);
console.log(`初期パスワード: ${config.SEED_ADMIN_PASSWORD}`);
console.log('※ このパスワードは初回ログイン後に変更してください（README の手順）。');
