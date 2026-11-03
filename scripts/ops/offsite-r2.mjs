#!/usr/bin/env node
/**
 * バックアップ（dump と manifest）を Cloudflare R2 へ送るオフサイト送信。
 *
 *   node scripts/ops/offsite-r2.mjs <dump> <manifest>
 *
 * `scripts/ops/backup.sh` の `MIRAI_SF_OFFSITE_CMD` から呼ばれる。失敗したら非 0 で終わる
 * （backup.sh はローカルの成功を保ちつつ終了コード 4 で unit を failed にする）。
 *
 * 環境変数:
 *   MIRAI_SF_R2_BUCKET  送り先バケット（既定 mirai-sf-prod-backups。非公開）
 *   MIRAI_SF_R2_PREFIX  オブジェクトの接頭辞（既定 mirai_sf_prod）
 *   MIRAI_SF_WRANGLER   wrangler のパス（既定: PATH → ~/.nvm/versions/node/<ver>/bin/wrangler）
 *
 * 認証は wrangler のログイン（OAuth。人間のアカウント）に依存する。R2 の S3 資格情報
 * （アクセスキー）が用意できたら、rclone 等へ差し替える（docs/production/02-runbook.md §5）。
 * 秘密・バケットの資格情報は出力しない。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const [dump, manifest] = process.argv.slice(2);
if (!dump || !manifest) {
  console.error('使い方: offsite-r2.mjs <dump> <manifest>');
  process.exit(2);
}
for (const path of [dump, manifest]) {
  if (!existsSync(path)) {
    console.error(`offsite-r2: ファイルがありません: ${path}`);
    process.exit(2);
  }
}

const bucket = process.env.MIRAI_SF_R2_BUCKET || 'mirai-sf-prod-backups';
const prefix = (process.env.MIRAI_SF_R2_PREFIX || 'mirai_sf_prod').replace(/^\/+|\/+$/g, '');

/** wrangler を探す。systemd の PATH には nvm の bin が入っていないことがある。 */
function resolveWrangler() {
  if (process.env.MIRAI_SF_WRANGLER) return process.env.MIRAI_SF_WRANGLER;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'wrangler');
    if (existsSync(candidate)) return candidate;
  }
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmRoot)) {
    const versions = readdirSync(nvmRoot).sort().reverse();
    for (const version of versions) {
      const candidate = join(nvmRoot, version, 'bin', 'wrangler');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const wrangler = resolveWrangler();
if (!wrangler) {
  console.error('offsite-r2: wrangler が見つかりません（MIRAI_SF_WRANGLER でパスを指定してください）');
  process.exit(2);
}

function lastLine(text) {
  return text.trim().split('\n').filter(Boolean).pop() ?? '';
}

/**
 * wrangler に渡す環境。systemd ユーザー環境には別用途の CLOUDFLARE_API_TOKEN が入っていることがあり、
 * 期限切れだと OAuth（wrangler login）より優先されて 401 になる。明示許可があるとき以外は外す。
 */
function wranglerEnv() {
  const env = { ...process.env };
  if (!process.env.MIRAI_SF_R2_API_TOKEN) delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

function run(args, maxBuffer) {
  const result = spawnSync(wrangler, args, { env: wranglerEnv(), maxBuffer: maxBuffer ?? 16 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr?.toString('utf8') ?? '' };
}

/** 1 ファイルを送り、実サイズを読み戻して一致を確かめる。 */
function upload(file) {
  const key = `${prefix}/${basename(file)}`;
  const size = statSync(file).size;

  const put = run(['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--remote']);
  if (put.code !== 0) return { ok: false, key, why: `put: ${lastLine(put.stderr)}` };

  // R2 に置いた実体を読み戻し、バイト数が一致することを確かめる（読み戻しは小さい dump を前提にしている）
  const get = run(['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'], size * 2 + 1024 * 1024);
  if (get.code !== 0) return { ok: false, key, why: `get: ${lastLine(get.stderr)}` };
  const got = Buffer.isBuffer(get.stdout) ? get.stdout.length : Buffer.byteLength(String(get.stdout ?? ''));
  if (got !== size) return { ok: false, key, why: `サイズ不一致 got=${got} want=${size}` };

  return { ok: true, key, size };
}

const results = [dump, manifest].map(upload);
for (const result of results) {
  if (!result.ok) {
    console.error(`offsite-r2: 失敗 key=${result.key} (${result.why})`);
    process.exit(1);
  }
}
console.log(
  `offsite-r2 OK bucket=${bucket} keys=${results.map((r) => r.key).join(',')} bytes=${results.map((r) => r.size).join(',')}`,
);
