#!/usr/bin/env node
/**
 * ワークスペース外の設定（~/.config/mirai-sf/local.json）を環境変数として注入し、
 * 指定したコマンドを実行する。秘密情報をリポジトリ・シェル履歴・ログに残さない。
 *
 * 使い方: node scripts/local-run.mjs <command> [args...]
 *   例: node scripts/local-run.mjs tsx scripts/db.ts migrate
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const configPath = process.env.MIRAI_SF_CONFIG_FILE ?? resolve(homedir(), '.config/mirai-sf/local.json');
if (!existsSync(configPath)) {
  console.error(`設定が見つかりません: ${configPath}`);
  console.error('先に `node scripts/bootstrap-local.mjs` を実行してください。');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const [rawCommand, ...args] = process.argv.slice(2);
if (!rawCommand) {
  console.error('コマンドを指定してください。');
  process.exit(1);
}

// node_modules/.bin を優先して解決する（PATH に依存しない）
const localBin = resolve(import.meta.dirname, '..', 'node_modules', '.bin', rawCommand);
const command = rawCommand.includes('/') || !existsSync(localBin) ? rawCommand : localBin;

const env = { ...process.env, ...config, MIRAI_SF_CONFIG_FILE: configPath };
const child = spawn(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
