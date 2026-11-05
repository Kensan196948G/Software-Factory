#!/usr/bin/env node
/**
 * ホスト喪失を想定した、オフサイト（Cloudflare R2）**だけ**からの独立復旧。
 * ローカルの送信記録（`*.dump.r2.json`）を使わずに、R2 の中身から最新の dump と同名の manifest を選び、
 * 取得して整合を確かめてから `restore-drill.sh`（一時DBへ復元 → 件数・監査ハッシュ照合 → 削除）へ渡す。
 *
 *   node scripts/ops/with-env.mjs scripts/ops/offsite-recover.mjs [options]
 *
 * 選び方（--source）:
 *   list   （既定）Cloudflare REST API の一覧 `GET /accounts/{id}/r2/buckets/{bucket}/objects` を使う。
 *          wrangler 4.x の `r2 object` には list が無いため。認証は**読取り専用の API トークン**
 *          （`MIRAI_SF_R2_READ_TOKEN`。権限 Workers R2 Storage Bucket Item Read）と `CLOUDFLARE_ACCOUNT_ID`。
 *          取得も同じ API の GET で行い、wrangler のログイン（OAuth）に依存しない。
 *   guess  一覧が使えないときの代替。キー `<prefix>/<db>-YYYYMMDDTHHMMSSZ.manifest.tsv` を 1 秒刻みで
 *          新しい順に推定し、wrangler の `r2 object get` で存在を確かめる（OAuth 依存）。探索窓（--from/--to）と
 *          試行上限（--max-probes）を超えたら失敗する。「無い」以外のエラー（認証・通信）は即座に止める（fail-closed）。
 *
 * 確認（ローカルのハッシュ記録が無いので、次で代える。保証の弱さは docs/production/14-independent-dr.md）:
 *   1) 取得サイズが一覧のサイズと一致（list のみ）、MD5 が一覧の etag と一致（単一パートのとき。list のみ）
 *   2) manifest の形（先頭が `#audit_tip`、テーブル名と件数、重複なし、1 件以上）
 *   3) `pg_restore --list` が通り、TOC の `TABLE DATA public <name>` の集合が manifest のテーブル集合と一致
 *   4) restore-drill.sh で、復元後の件数・監査ログ末尾ハッシュが manifest と完全一致し、db:verify が通る
 *
 * オプション:
 *   --source list|guess    選び方（既定 list）
 *   --verify-only          取得と 1)〜3) だけ行い、restore-drill.sh は実行しない
 *   --out <dir>            確認済みの dump と manifest をこのディレクトリへ残す（本番の復元に使う。0700）
 *   --max-age-hours <n>    最新が n 時間より古ければ失敗（既定 24。0 で無効）
 *   --from <ISO> --to <ISO>  guess の探索窓（既定: --to は現在、--from は --to の 1 時間前）
 *   --max-probes <n>       guess の試行上限（既定 3601＝1 時間。1 件およそ 3.5 秒）
 *
 * 環境変数: MIRAI_SF_R2_BUCKET（既定 mirai-sf-prod-backups）/ MIRAI_SF_R2_PREFIX（既定 mirai_sf_prod）/
 *   MIRAI_SF_R2_DB（dump 名の DB 部分。既定は prefix と同じ）/ CLOUDFLARE_ACCOUNT_ID / MIRAI_SF_R2_READ_TOKEN /
 *   MIRAI_SF_WRANGLER / MIRAI_SF_PG_BIN_DIR。トークン・接続文字列は出力しない。書込み・削除の API は呼ばない。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.cloudflare.com/client/v4';
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const NAME_RE = /^[A-Za-z0-9_]+$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// ───────── 純粋関数（tests/unit/offsite-recover.test.ts が直接呼ぶ。ネットワーク・ファイルに触らない） ─────────

/** `YYYYMMDDTHHMMSSZ` を Date にする。実在しない日時・形の違いは null。 */
export function parseStamp(stamp) {
  const m = STAMP_RE.exec(stamp);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date;
}

/** Date を `YYYYMMDDTHHMMSSZ` にする（ミリ秒は切り捨て）。 */
export function formatStamp(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** `prefix` の前後の `/` を落とす（offsite-r2.mjs と同じ正規化）。 */
export function normalizePrefix(prefix) {
  return String(prefix ?? '').replace(/^\/+|\/+$/g, '');
}

/**
 * オブジェクトのキーを解釈する。`<prefix>/<db>-<stamp>.dump` か `.manifest.tsv` だけを受け、それ以外は null。
 * 手動の dump や別 DB の dump は対象にしない（backup.sh の世代管理と同じ名前規則）。
 */
export function parseBackupKey(key, { prefix, db }) {
  if (typeof key !== 'string' || !NAME_RE.test(db)) return null;
  const p = normalizePrefix(prefix);
  const head = p ? `${p}/${db}-` : `${db}-`;
  if (!key.startsWith(head)) return null;
  const rest = key.slice(head.length);
  const m = /^(\d{8}T\d{6}Z)\.(dump|manifest\.tsv)$/.exec(rest);
  if (!m) return null;
  const date = parseStamp(m[1]);
  if (!date) return null;
  return { key, stamp: m[1], date, kind: m[2] === 'dump' ? 'dump' : 'manifest' };
}

/**
 * Cloudflare REST API の一覧の 1 ページを検査して正規化する。形が違えば例外（黙って空にしない）。
 * 返り値: { objects: [{ key, size, etag }], cursor: string | null }
 */
export function parseListingPage(body) {
  if (!body || typeof body !== 'object') throw new Error('一覧の応答が JSON オブジェクトではありません');
  if (body.success !== true) {
    const codes = Array.isArray(body.errors)
      ? body.errors
          .map((e) => e?.code)
          .filter(Boolean)
          .join(',')
      : '';
    throw new Error(`一覧の応答が success ではありません${codes ? `（code=${codes}）` : ''}`);
  }
  if (!Array.isArray(body.result)) throw new Error('一覧の応答に result 配列がありません');
  const objects = body.result.map((o, i) => {
    if (!o || typeof o.key !== 'string' || o.key === '') throw new Error(`一覧の ${i} 件目に key がありません`);
    if (!Number.isSafeInteger(o.size) || o.size < 0) throw new Error(`一覧の size が不正です: ${o.key}`);
    return { key: o.key, size: o.size, etag: typeof o.etag === 'string' ? o.etag.replace(/"/g, '') : null };
  });
  const info = body.result_info ?? {};
  const truncated = info.is_truncated === true;
  if (truncated && (typeof info.cursor !== 'string' || info.cursor === '')) {
    throw new Error('一覧が途中なのに cursor がありません');
  }
  return { objects, cursor: truncated ? info.cursor : null };
}

/**
 * 一覧から、dump と同名の manifest が**両方ある**最新の組を選ぶ。
 * - manifest の無い新しい dump（送信途中・失敗）は飛ばし、skipped に残す
 * - サイズ 0 の dump / manifest は不完全として飛ばす
 * - 未来の時刻（now + skewSeconds より後）は時計のずれ・偽装として飛ばす
 * - maxAgeHours > 0 で、選んだ組が古すぎれば例外（fail-closed）
 */
export function selectLatestPair(objects, { prefix, db, now = new Date(), maxAgeHours = 24, skewSeconds = 600 }) {
  const byStamp = new Map();
  for (const o of objects) {
    const parsed = parseBackupKey(o.key, { prefix, db });
    if (!parsed) continue;
    const slot = byStamp.get(parsed.stamp) ?? { stamp: parsed.stamp, date: parsed.date };
    slot[parsed.kind] = { key: o.key, size: o.size, etag: o.etag ?? null };
    byStamp.set(parsed.stamp, slot);
  }
  const limit = now.getTime() + skewSeconds * 1000;
  const skipped = [];
  const stamps = [...byStamp.keys()].sort().reverse();
  for (const stamp of stamps) {
    const slot = byStamp.get(stamp);
    if (slot.date.getTime() > limit) {
      skipped.push({ stamp, why: 'future' });
      continue;
    }
    if (!slot.dump || !slot.manifest) {
      skipped.push({ stamp, why: slot.dump ? 'no-manifest' : 'no-dump' });
      continue;
    }
    if (slot.dump.size === 0 || slot.manifest.size === 0) {
      skipped.push({ stamp, why: 'empty' });
      continue;
    }
    const ageHours = (now.getTime() - slot.date.getTime()) / 3_600_000;
    if (maxAgeHours > 0 && ageHours > maxAgeHours) {
      throw new Error(`最新の組が古すぎます: ${stamp}（${ageHours.toFixed(1)} 時間前 > ${maxAgeHours} 時間）`);
    }
    return { stamp, date: slot.date, dump: slot.dump, manifest: slot.manifest, ageHours, skipped, considered: byStamp.size };
  }
  throw new Error(`dump と manifest の揃った組がありません（候補 ${byStamp.size} 件）`);
}

/**
 * guess 用: 探索窓 [from, to] の manifest キーを**新しい順**に 1 秒刻みで作る。
 * 件数が maxProbes を超える窓は例外（無制限に探さない）。
 */
export function candidateManifestKeys({ prefix, db, from, to, maxProbes = 3601 }) {
  if (!NAME_RE.test(db)) throw new Error('DB 名が不正です');
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('探索窓の日時が不正です');
  }
  const start = Math.floor(from.getTime() / 1000);
  const end = Math.floor(to.getTime() / 1000);
  if (end < start) throw new Error('探索窓が逆順です（--from は --to より前）');
  const count = end - start + 1;
  if (count > maxProbes) throw new Error(`探索窓が広すぎます: ${count} 件 > --max-probes ${maxProbes}`);
  const p = normalizePrefix(prefix);
  const keys = [];
  for (let t = end; t >= start; t -= 1) {
    const stamp = formatStamp(new Date(t * 1000));
    keys.push(`${p ? `${p}/` : ''}${db}-${stamp}.manifest.tsv`);
  }
  return keys;
}

/** manifest を検査する（restore-drill.sh が比べる `ops_table_counts` の出力形）。 */
export function parseManifest(text) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new Error('manifest が短すぎます（監査ハッシュと 1 件以上のテーブルが要る）');
  const [head, ...rows] = lines;
  const hm = /^#audit_tip\t([0-9a-f]{64})?$/.exec(head);
  if (!hm) throw new Error('manifest の先頭が `#audit_tip<TAB><64桁hex|空>` ではありません');
  const tables = new Map();
  let prev = null;
  for (const [i, row] of rows.entries()) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\t(0|[1-9][0-9]*)$/.exec(row);
    if (!m) throw new Error(`manifest の ${i + 2} 行目が <テーブル名><TAB><件数> ではありません`);
    if (tables.has(m[1])) throw new Error(`manifest にテーブルが重複しています: ${m[1]}`);
    if (prev !== null && !(prev < m[1])) throw new Error('manifest のテーブル名が昇順（C 照合）ではありません');
    prev = m[1];
    tables.set(m[1], Number(m[2]));
  }
  return { auditTip: hm[1] ?? '', tables };
}

/** `pg_restore --list` の TOC から `TABLE DATA public <name>` の名前を集める。 */
export function tocTableNames(tocText) {
  const names = new Set();
  for (const line of String(tocText).split('\n')) {
    if (line.startsWith(';')) continue;
    const m = /^\d+;\s+\d+\s+\d+\s+TABLE DATA public (\S+) /.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** TOC と manifest のテーブル集合を比べる。 */
export function compareTocWithManifest(tocNames, manifestTables) {
  const want = new Set(manifestTables.keys());
  const missing = [...want].filter((n) => !tocNames.has(n)).sort();
  const extra = [...tocNames].filter((n) => !want.has(n)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** R2 の etag が単一パートの MD5（32 桁 hex）なら、その値。マルチパート（`-` 付き）等は null。 */
export function md5FromEtag(etag) {
  return typeof etag === 'string' && /^[0-9a-f]{32}$/.test(etag) ? etag : null;
}

/** 引数を解釈する。誤りは例外。 */
export function parseArgs(argv) {
  const opts = { source: 'list', verifyOnly: false, out: null, maxAgeHours: 24, from: null, to: null, maxProbes: 3601 };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} に値がありません`);
    return argv[i + 1];
  };
  const num = (value, name) => {
    if (!/^\d+$/.test(value)) throw new Error(`${name} は 0 以上の整数です`);
    return Number(value);
  };
  const isoDate = (value, name) => {
    const d = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(d.getTime())) throw new Error(`${name} は ISO 8601 の日時です`);
    return d;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') {
      const v = need(i, a);
      if (v !== 'list' && v !== 'guess') throw new Error('--source は list か guess です');
      opts.source = v;
      i += 1;
    } else if (a === '--verify-only') opts.verifyOnly = true;
    else if (a === '--out') {
      opts.out = need(i, a);
      i += 1;
    } else if (a === '--max-age-hours') {
      opts.maxAgeHours = num(need(i, a), a);
      i += 1;
    } else if (a === '--from') {
      opts.from = isoDate(need(i, a), a);
      i += 1;
    } else if (a === '--to') {
      opts.to = isoDate(need(i, a), a);
      i += 1;
    } else if (a === '--max-probes') {
      opts.maxProbes = num(need(i, a), a);
      i += 1;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (opts.source === 'list' && (opts.from || opts.to)) throw new Error('--from / --to は --source guess のときだけ使えます');
  return opts;
}

// ───────── 実行部（ネットワーク・ファイル・子プロセス） ─────────

function fail(message, code = 1) {
  console.error(`offsite-recover: ${message}`);
  process.exit(code);
}

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

/** REST API の GET（読取りのみ）。リダイレクトは追わない。トークンは出力しない。 */
async function apiGet(path, token, { asBytes = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let codes = '';
    try {
      const body = await res.json();
      codes = Array.isArray(body?.errors)
        ? body.errors
            .map((e) => e?.code)
            .filter(Boolean)
            .join(',')
        : '';
    } catch {}
    throw new Error(`HTTP ${res.status}${codes ? ` code=${codes}` : ''}`);
  }
  return asBytes ? Buffer.from(await res.arrayBuffer()) : res.json();
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

async function listAll({ accountId, bucket, prefix, token }) {
  const objects = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const q = new URLSearchParams({ prefix: prefix ? `${prefix}/` : '', per_page: '1000' });
    if (cursor) q.set('cursor', cursor);
    const parsed = parseListingPage(await apiGet(`/accounts/${accountId}/r2/buckets/${bucket}/objects?${q}`, token));
    objects.push(...parsed.objects);
    cursor = parsed.cursor;
    if (!cursor) return objects;
  }
  throw new Error('一覧が 50 ページを超えました（打ち切り。prefix を確認してください）');
}

function wranglerEnv() {
  const env = { ...process.env };
  if (!process.env.MIRAI_SF_R2_API_TOKEN) delete env.CLOUDFLARE_API_TOKEN;
  return env;
}

/** wrangler で 1 件取得。存在しなければ null、それ以外の失敗は例外（推定を続けない）。 */
function wranglerGet(wrangler, bucket, key) {
  const r = spawnSync(wrangler, ['r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'], {
    env: wranglerEnv(),
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status === 0) return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ''));
  const err = r.stderr?.toString('utf8') ?? '';
  if (/The specified key does not exist/i.test(err)) return null;
  const last =
    err
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
      .split('\n')
      .filter((l) => l && !/proxy/i.test(l))
      .pop() ?? '';
  throw new Error(`wrangler get が失敗しました: ${key} (${last.slice(0, 200)})`);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (b) => createHash('md5').update(b).digest('hex');

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message, 64);
  }
  if (opts.help) {
    console.log(
      '使い方: offsite-recover.mjs [--source list|guess] [--verify-only] [--out <dir>] [--max-age-hours n] [--from ISO --to ISO] [--max-probes n]',
    );
    return 0;
  }

  const bucket = process.env.MIRAI_SF_R2_BUCKET || 'mirai-sf-prod-backups';
  const prefix = normalizePrefix(process.env.MIRAI_SF_R2_PREFIX || 'mirai_sf_prod');
  const db = process.env.MIRAI_SF_R2_DB || prefix.split('/').pop() || '';
  if (!BUCKET_RE.test(bucket)) fail('MIRAI_SF_R2_BUCKET が不正です');
  if (!NAME_RE.test(db)) fail('dump 名の DB 部分が不正です（MIRAI_SF_R2_DB で指定してください）');

  const work = mkdtempSync(join(tmpdir(), 'mirai-sf-offsite-recover-'));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    let dumpBytes;
    let manifestBytes;
    let stamp;

    if (opts.source === 'list') {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
      const token = process.env.MIRAI_SF_R2_READ_TOKEN || '';
      if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID が無いか形が不正です');
      if (!token)
        throw new Error('MIRAI_SF_R2_READ_TOKEN がありません（読取り専用の R2 トークン）。一覧を使えないなら --source guess');
      const objects = await listAll({ accountId, bucket, prefix, token });
      const pick = selectLatestPair(objects, { prefix, db, maxAgeHours: opts.maxAgeHours });
      stamp = pick.stamp;
      info(
        `一覧 OK bucket=${bucket} objects=${objects.length} candidates=${pick.considered} selected=${stamp} age_h=${pick.ageHours.toFixed(1)} skipped=${pick.skipped.length}`,
      );
      const base = `/accounts/${accountId}/r2/buckets/${bucket}/objects/`;
      dumpBytes = await apiGet(base + encodeKey(pick.dump.key), token, { asBytes: true });
      manifestBytes = await apiGet(base + encodeKey(pick.manifest.key), token, { asBytes: true });
      for (const [label, bytes, meta] of [
        ['dump', dumpBytes, pick.dump],
        ['manifest', manifestBytes, pick.manifest],
      ]) {
        if (bytes.length !== meta.size) throw new Error(`サイズ不一致 ${label} got=${bytes.length} want=${meta.size}`);
        const want = md5FromEtag(meta.etag);
        if (want && md5(bytes) !== want) throw new Error(`MD5 が etag と一致しません: ${label}`);
        info(`${label} 取得 OK size=${bytes.length} etag_check=${want ? 'md5-ok' : 'skipped(multipart)'}`);
      }
    } else {
      const wrangler = resolveWrangler();
      if (!wrangler) throw new Error('wrangler が見つかりません（MIRAI_SF_WRANGLER）');
      const to = opts.to ?? new Date();
      const from = opts.from ?? new Date(to.getTime() - 3_600_000);
      const keys = candidateManifestKeys({ prefix, db, from, to, maxProbes: opts.maxProbes });
      info(`推定で探索 bucket=${bucket} window=${formatStamp(from)}..${formatStamp(to)} probes<=${keys.length}`);
      let hit = null;
      for (const [i, key] of keys.entries()) {
        const bytes = wranglerGet(wrangler, bucket, key);
        if (bytes) {
          hit = { key, bytes, probes: i + 1 };
          break;
        }
      }
      if (!hit) throw new Error(`探索窓に manifest がありません（${keys.length} 件を試行）。窓を広げるか一覧を使う`);
      stamp = parseBackupKey(hit.key, { prefix, db }).stamp;
      manifestBytes = hit.bytes;
      const dumpKey = hit.key.replace(/\.manifest\.tsv$/, '.dump');
      dumpBytes = wranglerGet(wrangler, bucket, dumpKey);
      if (!dumpBytes) throw new Error(`manifest はあるが同名の dump がありません: ${basename(dumpKey)}`);
      info(`推定 OK selected=${stamp} probes=${hit.probes}（サイズ・etag の照合は一覧が無いので行えない）`);
    }

    const manifest = parseManifest(manifestBytes.toString('utf8'));
    const dumpPath = join(work, `${db}-${stamp}.dump`);
    const manifestPath = join(work, `${db}-${stamp}.manifest.tsv`);
    writeFileSync(dumpPath, dumpBytes, { mode: 0o600 });
    writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });

    const toc = spawnSync(pgBin('pg_restore'), ['--list', dumpPath], { maxBuffer: 64 * 1024 * 1024 });
    if (toc.status !== 0) throw new Error('pg_restore --list に失敗しました（dump が壊れているか形式が違う）');
    const cmp = compareTocWithManifest(tocTableNames(toc.stdout.toString('utf8')), manifest.tables);
    if (!cmp.ok)
      throw new Error(`TOC と manifest のテーブルが一致しません missing=${cmp.missing.join(',')} extra=${cmp.extra.join(',')}`);
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
    const child = spawnSync('bash', [join(SCRIPT_DIR, 'restore-drill.sh')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MIRAI_SF_BACKUP_DIR: backupDir,
        MIRAI_SF_DRILL_DUMP: dumpPath,
        MIRAI_SF_DRILL_MANIFEST: manifestPath,
      },
    });
    return child.status ?? 1;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => fail(error instanceof Error ? error.message : String(error)),
  );
}
