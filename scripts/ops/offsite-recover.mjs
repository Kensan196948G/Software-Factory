#!/usr/bin/env node
/**
 * ホスト喪失を想定した、オフサイト（Cloudflare R2）**だけ**からの独立復旧（実行部）。
 * ローカルの送信記録（`*.dump.r2.json`）を使わずに、R2 の中身から最新の dump と同名の manifest を選び、
 * 取得して整合を確かめてから `restore-drill.sh`（一時DBへ復元 → 件数・監査ハッシュ照合 → 削除）へ渡す。
 * 解析・選択・照合の純粋ロジックは scripts/ops/lib/offsite-recover-core.mjs。
 *
 *   node scripts/ops/with-env.mjs scripts/ops/offsite-recover.mjs [options]
 *
 * 選び方（--source）:
 *   list   （既定）Cloudflare REST API の一覧 `GET /accounts/{id}/r2/buckets/{bucket}/objects` を使う。
 *          wrangler 4.x の `r2 object` には list が無いため。認証は**読取り専用の API トークン**
 *          （`MIRAI_SF_R2_READ_TOKEN`。権限 Workers R2 Storage Bucket Item Read）と `CLOUDFLARE_ACCOUNT_ID`。
 *          取得も同じ API の GET で行い、wrangler のログイン（OAuth）に依存しない。
 *   guess  一覧が使えないときの代替。キー `<prefix>/<db>-YYYYMMDDTHHMMSSZ.manifest.tsv` を 1 秒刻みで
 *          新しい順に推定し、wrangler の `r2 object get` で存在を確かめる（OAuth 依存）。先にバケットの存在を確かめ、
 *          探索窓（--from/--to）と試行上限（--max-probes）を超えたら失敗する。「無い」以外の失敗は即座に止める（fail-closed）。
 *          見つけた組にも list と同じ鮮度の規則（未来 10 分超・--max-age-hours 超は失敗）をかける。
 *
 * 確認（ローカルのハッシュ記録が無いので、次で代える。保証の弱さは docs/production/14-independent-dr.md）:
 *   1) list のみ: 取得サイズ＝一覧の size。etag が単一パート（32 桁 hex）なら MD5 と一致、
 *      マルチパート（`<hex>-<N>`）なら MD5 照合は不能と明示。etag の欠落・不明な形は失敗
 *   2) manifest の形（先頭が `#audit_tip`、テーブル名の昇順・重複なし・件数）
 *   3) `pg_restore --list` が通り、TOC の `TABLE DATA public <name>` が重複なしで manifest のテーブル集合と一致
 *   4) restore-drill.sh で、復元後の件数・監査ログ末尾ハッシュが manifest と完全一致し、db:verify が通る
 *
 * オプション:
 *   --source list|guess    選び方（既定 list）
 *   --verify-only          取得と 1)〜3) だけ行い、restore-drill.sh は実行しない
 *   --out <dir>            確認済みの dump と manifest をこのディレクトリへ残す（本番の復元に使う。0700）
 *   --max-age-hours <n>    最新が n 時間より古ければ失敗（既定 24。0 で無効。上限 2160）
 *   --from <ISO> --to <ISO>  guess の探索窓（既定: --to は現在、--from は --to の 1 時間前）
 *   --max-probes <n>       guess の試行上限（既定 3601＝1 時間。上限 86401。1 件およそ 3.5 秒）
 *
 * 環境変数: MIRAI_SF_R2_BUCKET（既定 mirai-sf-prod-backups）/ MIRAI_SF_R2_PREFIX（既定 mirai_sf_prod）/
 *   MIRAI_SF_R2_DB（dump 名の DB 部分。既定は prefix の最後の要素）/ CLOUDFLARE_ACCOUNT_ID / MIRAI_SF_R2_READ_TOKEN /
 *   MIRAI_SF_WRANGLER / MIRAI_SF_PG_BIN_DIR。トークン・アカウント ID・接続文字列・wrangler の stderr 本文は出力しない。
 *   書込み・削除の API は呼ばない。SIGINT / SIGTERM では子プロセスへ転送し、一時領域を消してから終わる。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUCKET_RE,
  NAME_RE,
  assertFresh,
  candidateManifestKeys,
  classifyEtag,
  classifyWranglerFailure,
  compareTocWithManifest,
  describeFailure,
  formatStamp,
  normalizePrefix,
  parseArgs,
  parseBackupKey,
  parseListingPage,
  parseManifest,
  selectLatestPair,
  tocTableCounts,
} from './lib/offsite-recover-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.cloudflare.com/client/v4';
const PER_PAGE = 1000;
const MAX_PAGES = 50;

class Interrupted extends Error {
  constructor(signal) {
    super(`中断されました（${signal}）`);
    this.signal = signal;
  }
}

// ───────── 中断（SIGINT / SIGTERM）: 子プロセスへ転送し、後始末を確実に走らせる ─────────

const running = new Set();
const abort = new AbortController();
let interruptedBy = null;

function onSignal(signal) {
  if (interruptedBy) return;
  interruptedBy = signal;
  for (const child of running) child.kill(signal);
  abort.abort(new Interrupted(signal));
}

function checkInterrupted() {
  if (interruptedBy) throw new Interrupted(interruptedBy);
}

/** 子プロセスを非同期で実行する。stdout は Buffer で集める（上限つき）。 */
function run(cmd, args, { env = process.env, inherit = false, maxBytes = 512 * 1024 * 1024 } = {}) {
  checkInterrupted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    const out = [];
    const err = [];
    let outBytes = 0;
    let overflow = false;
    child.stdout?.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        overflow = true;
        child.kill('SIGTERM');
      } else out.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (err.length < 256) err.push(chunk);
    });
    child.on('error', (error) => {
      running.delete(child);
      reject(new Error(`${basename(cmd)} を起動できません（${error.code ?? 'error'}）`));
    });
    child.on('close', (status, signal) => {
      running.delete(child);
      if (overflow) return reject(new Error(`${basename(cmd)} の出力が上限を超えました`));
      resolvePromise({ status, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

// ───────── 周辺 ─────────

function info(message) {
  console.log(`offsite-recover: ${message}`);
}

function resolveWrangler() {
  if (process.env.MIRAI_SF_WRANGLER) return process.env.MIRAI_SF_WRANGLER;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, 'wrangler'))) return join(dir, 'wrangler');
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

function pgBin(name) {
  const dir = process.env.MIRAI_SF_PG_BIN_DIR || '/usr/lib/postgresql/16/bin';
  return existsSync(join(dir, name)) ? join(dir, name) : name;
}

function wranglerEnv() {
  const env = { ...process.env };
  if (!process.env.MIRAI_SF_R2_API_TOKEN) delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');

// ───────── list: Cloudflare REST API（GET のみ） ─────────

/** REST API の GET。リダイレクトは追わない。失敗時は HTTP 状態と数値のエラーコードだけを返す（本文・パスは出さない）。 */
async function apiGet(path, token, { asBytes = false } = {}) {
  checkInterrupted();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
  });
  if (!res.ok) {
    let codes = '';
    try {
      const body = await res.json();
      codes = Array.isArray(body?.errors)
        ? body.errors
            .map((e) => e?.code)
            .filter(Number.isInteger)
            .join(',')
        : '';
    } catch {}
    throw new Error(`Cloudflare API が失敗しました http=${res.status}${codes ? ` cf_code=${codes}` : ''}`);
  }
  return asBytes ? Buffer.from(await res.arrayBuffer()) : res.json();
}

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

async function listAll({ accountId, bucket, prefix, token }) {
  const base = `/accounts/${accountId}/r2/buckets/${bucket}/objects`;
  const objects = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ prefix: prefix ? `${prefix}/` : '', per_page: String(PER_PAGE) });
    if (cursor) q.set('cursor', cursor);
    const parsed = parseListingPage(await apiGet(`${base}?${q}`, token), { perPage: PER_PAGE });
    objects.push(...parsed.objects);
    if (parsed.cursor) {
      cursor = parsed.cursor;
      continue;
    }
    if (parsed.needsConfirm) {
      // result_info が無く満杯のページ: 最後のキーの後ろが 0 件であることを確かめる（黙って打ち切らない）
      const after = new URLSearchParams({ prefix: prefix ? `${prefix}/` : '', per_page: '1', start_after: objects.at(-1).key });
      const rest = parseListingPage(await apiGet(`${base}?${after}`, token), { perPage: 1 });
      if (rest.objects.length > 0) throw new Error('一覧が途中なのに続きの cursor がありません（応答が矛盾）');
    }
    return objects;
  }
  throw new Error(`一覧が ${MAX_PAGES} ページを超えました（打ち切り。prefix を確認してください）`);
}

async function fetchByList({ bucket, prefix, db, opts }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.MIRAI_SF_R2_READ_TOKEN || '';
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID が無いか形が不正です');
  if (!token)
    throw new Error('MIRAI_SF_R2_READ_TOKEN がありません（読取り専用の R2 トークン）。一覧を使えないなら --source guess');
  const objects = await listAll({ accountId, bucket, prefix, token });
  const pick = selectLatestPair(objects, { prefix, db, maxAgeHours: opts.maxAgeHours });
  info(
    `一覧 OK bucket=${bucket} objects=${objects.length} candidates=${pick.considered} selected=${pick.stamp} age_h=${pick.ageHours.toFixed(1)} skipped=${pick.skipped.length}`,
  );
  const base = `/accounts/${accountId}/r2/buckets/${bucket}/objects/`;
  const fetched = {};
  for (const label of ['dump', 'manifest']) {
    const meta = pick[label];
    const etag = classifyEtag(meta.etag); // 欠落・不明な形は例外
    const bytes = await apiGet(base + encodeKey(meta.key), token, { asBytes: true });
    if (bytes.length !== meta.size) throw new Error(`サイズ不一致 ${label} got=${bytes.length} want=${meta.size}`);
    if (etag.kind === 'md5' && md5(bytes) !== etag.md5) throw new Error(`MD5 が etag と一致しません: ${label}`);
    info(
      `${label} 取得 OK size=${bytes.length} etag_check=${etag.kind === 'md5' ? 'md5-ok' : `not-md5(multipart parts=${etag.parts})`}`,
    );
    fetched[label] = bytes;
  }
  return { stamp: pick.stamp, dumpBytes: fetched.dump, manifestBytes: fetched.manifest };
}

// ───────── guess: キー推定 + wrangler get ─────────

/** wrangler で 1 件取得。存在しなければ null、それ以外の失敗は固定の分類だけを載せた例外。 */
async function wranglerGet(wrangler, bucket, key) {
  const r = await run(wrangler, ['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'], { env: wranglerEnv() });
  checkInterrupted();
  if (r.status === 0) return r.stdout;
  const f = classifyWranglerFailure(r);
  if (f.kind === 'not_found') return null;
  throw new Error(`wrangler get が失敗しました（${describeFailure(f)}）`);
}

/** バケットの存在と読取り権限を先に確かめる（object get は「バケットが無い」も「キーが無い」と返すため）。 */
async function wranglerBucketCheck(wrangler, bucket) {
  const r = await run(wrangler, ['r2', 'bucket', 'info', bucket, '--json'], { env: wranglerEnv(), maxBytes: 1024 * 1024 });
  checkInterrupted();
  if (r.status !== 0) throw new Error(`バケットを確認できません（${describeFailure(classifyWranglerFailure(r))}）`);
}

async function fetchByGuess({ bucket, prefix, db, opts }) {
  const wrangler = resolveWrangler();
  if (!wrangler) throw new Error('wrangler が見つかりません（MIRAI_SF_WRANGLER）');
  const now = new Date();
  const to = opts.to ?? now;
  const from = opts.from ?? new Date(to.getTime() - 3_600_000);
  const keys = candidateManifestKeys({ prefix, db, from, to, maxProbes: opts.maxProbes });
  await wranglerBucketCheck(wrangler, bucket);
  info(`推定で探索 bucket=${bucket} window=${formatStamp(from)}..${formatStamp(to)} probes<=${keys.length}`);
  for (const [i, key] of keys.entries()) {
    const manifestBytes = await wranglerGet(wrangler, bucket, key);
    if (!manifestBytes) continue;
    const parsed = parseBackupKey(key, { prefix, db });
    // list と同じ鮮度の規則（未来の時刻・古すぎる組は失敗。推定では「次に古いもの」へ黙って進まない）
    const ageHours = assertFresh(parsed.stamp, parsed.date, { now, maxAgeHours: opts.maxAgeHours });
    const dumpKey = key.replace(/\.manifest\.tsv$/, '.dump');
    const dumpBytes = await wranglerGet(wrangler, bucket, dumpKey);
    if (!dumpBytes) throw new Error(`manifest はあるが同名の dump がありません: ${basename(dumpKey)}`);
    if (dumpBytes.length === 0 || manifestBytes.length === 0) throw new Error(`取得物が空です: ${parsed.stamp}`);
    info(
      `推定 OK selected=${parsed.stamp} age_h=${ageHours.toFixed(1)} probes=${i + 1}（サイズ・etag の照合は一覧が無いので行えない）`,
    );
    return { stamp: parsed.stamp, dumpBytes, manifestBytes };
  }
  throw new Error(`探索窓に manifest がありません（${keys.length} 件を試行）。窓を広げるか一覧を使う`);
}

// ───────── 本体 ─────────

async function main(opts, work) {
  const bucket = process.env.MIRAI_SF_R2_BUCKET || 'mirai-sf-prod-backups';
  const prefix = normalizePrefix(process.env.MIRAI_SF_R2_PREFIX || 'mirai_sf_prod');
  const db = process.env.MIRAI_SF_R2_DB || prefix.split('/').pop() || '';
  if (!BUCKET_RE.test(bucket)) throw new Error('MIRAI_SF_R2_BUCKET が不正です');
  if (!NAME_RE.test(db)) throw new Error('dump 名の DB 部分が不正です（MIRAI_SF_R2_DB で指定してください）');

  const { stamp, dumpBytes, manifestBytes } =
    opts.source === 'list' ? await fetchByList({ bucket, prefix, db, opts }) : await fetchByGuess({ bucket, prefix, db, opts });

  const manifest = parseManifest(manifestBytes.toString('utf8'));
  const dumpPath = join(work, `${db}-${stamp}.dump`);
  const manifestPath = join(work, `${db}-${stamp}.manifest.tsv`);
  writeFileSync(dumpPath, dumpBytes, { mode: 0o600 });
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });

  const toc = await run(pgBin('pg_restore'), ['--list', dumpPath], { maxBytes: 64 * 1024 * 1024 });
  checkInterrupted();
  if (toc.status !== 0) throw new Error('pg_restore --list に失敗しました（dump が壊れているか形式が違う）');
  const cmp = compareTocWithManifest(tocTableCounts(toc.stdout.toString('utf8')), manifest.tables);
  if (!cmp.ok) {
    throw new Error(
      `TOC と manifest のテーブルが一致しません missing=${cmp.missing.join(',')} extra=${cmp.extra.join(',')} duplicate=${cmp.duplicate.join(',')}`,
    );
  }
  info(
    `整合 OK tables=${manifest.tables.size} audit_tip=${manifest.auditTip ? 'present' : 'empty'} dump_sha256=${sha256(dumpBytes).slice(0, 12)} manifest_sha256=${sha256(manifestBytes).slice(0, 12)}`,
  );

  if (opts.out) {
    const outDir = resolve(opts.out);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    chmodSync(outDir, 0o700);
    writeFileSync(join(outDir, basename(dumpPath)), dumpBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(outDir, basename(manifestPath)), manifestBytes, { mode: 0o600, flag: 'wx' });
    info(`確認済みのファイルを残しました: ${join(outDir, basename(dumpPath))}`);
  }
  if (opts.verifyOnly) {
    info('verify-only: restore-drill.sh は実行しません');
    return 0;
  }

  // 新しいホストでは MIRAI_SF_BACKUP_DIR が無いことがある。restore-drill.sh は存在だけを見るので作業領域を渡す
  const backupDir =
    process.env.MIRAI_SF_BACKUP_DIR && existsSync(process.env.MIRAI_SF_BACKUP_DIR) ? process.env.MIRAI_SF_BACKUP_DIR : work;
  const child = await run('bash', [join(SCRIPT_DIR, 'restore-drill.sh')], {
    inherit: true,
    env: { ...process.env, MIRAI_SF_BACKUP_DIR: backupDir, MIRAI_SF_DRILL_DUMP: dumpPath, MIRAI_SF_DRILL_MANIFEST: manifestPath },
  });
  checkInterrupted();
  return child.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`offsite-recover: ${error.message}`);
    process.exit(64);
  }
  if (opts.help) {
    console.log(
      '使い方: offsite-recover.mjs [--source list|guess] [--verify-only] [--out <dir>] [--max-age-hours n] [--from ISO --to ISO] [--max-probes n]',
    );
    process.exit(0);
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const work = mkdtempSync(join(tmpdir(), 'mirai-sf-offsite-recover-'));
  let code = 1;
  try {
    code = await main(opts, work);
  } catch (error) {
    const interrupted = error instanceof Interrupted || interruptedBy;
    console.error(
      `offsite-recover: ${interrupted ? `中断されました（${interruptedBy ?? error.signal}）` : error instanceof Error ? error.message : String(error)}`,
    );
    code = interrupted ? (interruptedBy === 'SIGINT' ? 130 : 143) : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exit(code);
}
