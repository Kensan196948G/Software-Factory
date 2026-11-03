#!/usr/bin/env node
/**
 * オフサイト（Cloudflare R2）に置いた最新のバックアップを取り寄せ、復元訓練を実行する。
 *
 *   node scripts/ops/with-env.mjs scripts/ops/offsite-drill.mjs   # または pnpm ops:prod:offsite-drill
 *
 * - `MIRAI_SF_BACKUP_DIR` の `*.dump.r2.json`（offsite-r2.mjs が残す送信記録）から最新を選ぶ。
 * - R2 から dump と manifest を取得し、記録した SHA-256 と一致することを確かめる。
 * - 取得したファイルを `restore-drill.sh`（一時DBへ復元→件数・監査ハッシュ照合→削除）に渡す。
 *
 * 認証は wrangler の OAuth（人間のアカウント）。秘密は出力しない。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const backupDir = process.env.MIRAI_SF_BACKUP_DIR || join(homedir(), '.local/state/mirai-sf-prod/backups');

function fail(message) {
  console.error(`offsite-drill: ${message}`);
  process.exit(1);
}

/** wrangler を探す（systemd の PATH には nvm の bin が入っていないことがある）。 */
function resolveWrangler() {
  if (process.env.MIRAI_SF_WRANGLER) return process.env.MIRAI_SF_WRANGLER;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'wrangler');
    if (existsSync(candidate)) return candidate;
  }
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot).sort().reverse()) {
      const candidate = join(nvmRoot, version, 'bin', 'wrangler');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * wrangler に渡す環境。systemd ユーザー環境の期限切れ CLOUDFLARE_API_TOKEN を継承すると 401 になるため、
 * 明示許可（MIRAI_SF_R2_API_TOKEN）が無いときは外す。
 */
function wranglerEnv() {
  const env = { ...process.env };
  if (!process.env.MIRAI_SF_R2_API_TOKEN) delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

const wrangler = resolveWrangler();
if (!wrangler) fail('wrangler が見つかりません（MIRAI_SF_WRANGLER でパスを指定してください）');
if (!existsSync(backupDir)) fail(`バックアップの保存先がありません: ${backupDir}`);

const markers = readdirSync(backupDir)
  .filter((name) => name.endsWith('.dump.r2.json'))
  .map((name) => join(backupDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
if (markers.length === 0) {
  fail('R2 へ送った記録（*.dump.r2.json）がありません。先にバックアップを実行してください');
}

const markerPath = markers[0];
let marker;
try {
  marker = JSON.parse(readFileSync(markerPath, 'utf8'));
} catch (error) {
  fail(`送信記録を読めません: ${basename(markerPath)} (${error.message})`);
}
if (!marker?.dump?.key || !marker?.manifest?.key) fail(`送信記録の形が不正です: ${basename(markerPath)}`);

const bucket = marker.bucket || process.env.MIRAI_SF_R2_BUCKET || 'mirai-sf-prod-backups';
const work = mkdtempSync(join(tmpdir(), 'mirai-sf-offsite-drill-'));

function fetchObject(entry) {
  const dest = join(work, basename(entry.key));
  const result = spawnSync(wrangler, ['r2', 'object', 'get', `${bucket}/${entry.key}`, '--remote', '--file', dest], {
    env: wranglerEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const last = (result.stderr?.toString('utf8') ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    fail(`取得に失敗: ${entry.key} (${last})`);
  }
  const bytes = readFileSync(dest);
  if (typeof entry.size === 'number' && bytes.length !== entry.size) {
    fail(`サイズ不一致: ${entry.key} got=${bytes.length} want=${entry.size}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (entry.sha256 && digest !== entry.sha256) fail(`SHA-256 不一致: ${entry.key}`);
  return { path: dest, sha256: digest };
}

const fetchedDump = fetchObject(marker.dump);
const fetchedManifest = fetchObject(marker.manifest);
console.log(
  `offsite-drill: R2 から取得 OK bucket=${bucket} dump=${basename(marker.dump.key)} sha256=${fetchedDump.sha256.slice(0, 12)}`,
);

const child = spawnSync(process.execPath === undefined ? 'bash' : 'bash', [join(SCRIPT_DIR, 'restore-drill.sh')], {
  stdio: 'inherit',
  env: { ...process.env, MIRAI_SF_DRILL_DUMP: fetchedDump.path, MIRAI_SF_DRILL_MANIFEST: fetchedManifest.path },
});

rmSync(work, { recursive: true, force: true });
process.exit(child.status ?? 1);
