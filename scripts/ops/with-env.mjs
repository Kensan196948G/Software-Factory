#!/usr/bin/env node
/**
 * KEY=VALUE 形式の設定（既定: ~/.config/mirai-sf/preview.conf）を環境変数にして、
 * 指定したコマンドを実行する。値は表示しない（エラーでも行番号だけを出す）。
 *
 * 使い方: node scripts/ops/with-env.mjs <command> [args...]
 *   例: node scripts/ops/with-env.mjs tsx scripts/reminders.ts
 *
 * - 設定ファイルは MIRAI_SF_ENV_FILE で差し替えられる（検証用）。
 * - 設定ファイルの値は、呼び出し元の環境変数より優先する。
 * - 開発用の設定が混ざらないよう、MIRAI_SF_CONFIG_FILE と別DBを指す変数は子へ渡さない。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const INHERIT_BLOCKLIST = ['MIRAI_SF_CONFIG_FILE', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'];

function fail(message, code = 2) {
  console.error(`with-env: ${message}`);
  process.exit(code);
}

function parseEnvFile(text, path) {
  const values = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${path}:${index + 1} は KEY=VALUE の形式ではありません`);
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    values[key] = value;
  });
  return values;
}

const [rawCommand, ...args] = process.argv.slice(2);
if (!rawCommand) fail('コマンドを指定してください。');

const envFile = process.env.MIRAI_SF_ENV_FILE || resolve(homedir(), '.config/mirai-sf/preview.conf');
if (!existsSync(envFile)) fail(`設定が見つかりません: ${envFile}`);
if ((statSync(envFile).mode & 0o077) !== 0) {
  console.error(`with-env: 警告: ${envFile} のパーミッションが 0600 より緩い状態です`);
}

const fileValues = parseEnvFile(readFileSync(envFile, 'utf8'), envFile);
const env = { ...process.env };
for (const key of INHERIT_BLOCKLIST) delete env[key];
Object.assign(env, fileValues);

// node_modules/.bin を優先する（実行時の作業ディレクトリ基準。release 配下でも同じように動く）
const localBin = resolve(process.cwd(), 'node_modules', '.bin', rawCommand);
const command = rawCommand.includes('/') || !existsSync(localBin) ? rawCommand : localBin;

const child = spawn(command, args, { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (err) => fail(`コマンドを起動できません: ${rawCommand}（${err.code ?? 'unknown'}）`, 127));
child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
  }
  process.exit(code ?? 1);
});
