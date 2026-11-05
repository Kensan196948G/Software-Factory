/**
 * offsite-recover.mjs の純粋ロジック（解析・選択・照合・引数）。ネットワーク・ファイル・子プロセスに触らない。
 * 実行部は scripts/ops/offsite-recover.mjs。単体テストは tests/unit/offsite-recover.test.ts。
 */

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
export const NAME_RE = /^[A-Za-z0-9_]+$/;
export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** 既定値と上限（巨大な値で上限が実質無効にならないよう、明示の上限を持つ）。 */
export const DEFAULT_MAX_AGE_HOURS = 24;
export const MAX_AGE_HOURS_LIMIT = 24 * 90; // R2 に残る世代の想定（90 日）を超える指定は誤り
export const DEFAULT_MAX_PROBES = 3601; // 1 時間（1 秒刻み）
export const MAX_PROBES_LIMIT = 86_401; // 24 時間
export const DEFAULT_SKEW_SECONDS = 600; // 未来の時刻として許す時計のずれ（10 分）

// ───────── 時刻とキー ─────────

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

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * `prefix` の前後の `/` を落とす（offsite-r2.mjs と同じ正規化）。
 * 中の各セグメントは英数字・`_` で始まる `[A-Za-z0-9._-]` に限り、空・`.`・`..` は拒否する（パスの付け替えを防ぐ）。
 */
export function normalizePrefix(prefix) {
  const p = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
  if (p === '') return '';
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !SEGMENT_RE.test(segment)) {
      throw new Error('MIRAI_SF_R2_PREFIX が不正です（空・. ・.. のセグメントや使えない文字がある）');
    }
  }
  return p;
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
  const m = /^(\d{8}T\d{6}Z)\.(dump|manifest\.tsv)$/.exec(key.slice(head.length));
  if (!m) return null;
  const date = parseStamp(m[1]);
  if (!date) return null;
  return { key, stamp: m[1], date, kind: m[2] === 'dump' ? 'dump' : 'manifest' };
}

/**
 * 選んだバックアップの時刻を現在と比べる（list と guess で同じ規則）。
 * - now + skewSeconds より後 → future（時計のずれ・偽装）
 * - maxAgeHours > 0 で、それより古い → stale
 */
export function assessFreshness(
  date,
  { now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS, skewSeconds = DEFAULT_SKEW_SECONDS } = {},
) {
  const ageHours = (now.getTime() - date.getTime()) / 3_600_000;
  if (date.getTime() > now.getTime() + skewSeconds * 1000) return { ok: false, why: 'future', ageHours };
  if (maxAgeHours > 0 && ageHours > maxAgeHours) return { ok: false, why: 'stale', ageHours };
  return { ok: true, why: null, ageHours };
}

/** assessFreshness が ok でなければ例外。 */
export function assertFresh(stamp, date, options) {
  const r = assessFreshness(date, options);
  if (r.why === 'future')
    throw new Error(`選んだバックアップの時刻が未来です: ${stamp}（時計のずれ ${DEFAULT_SKEW_SECONDS} 秒を超える）`);
  if (r.why === 'stale') {
    throw new Error(
      `最新の組が古すぎます: ${stamp}（${r.ageHours.toFixed(1)} 時間前 > ${options?.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS} 時間）`,
    );
  }
  return r.ageHours;
}

// ───────── 一覧（Cloudflare REST API） ─────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 一覧の 1 ページを検査して正規化する。形が違えば例外（黙って空・最終ページにしない）。
 * - `result_info` がある: `is_truncated` は boolean 必須。true なら空でない `cursor` 必須、false なら `cursor` があってはいけない
 * - `result_info` が無い: 最終ページ（2026-11-05 の実測で、R2 は最後のページに result_info を付けない）。
 *   ただし件数が `perPage` に達していれば「本当に最後か」を確かめる必要がある（needsConfirm。実行部が start_after で 0 件を確認）
 * 返り値: { objects: [{ key, size, etag }], cursor: string | null, needsConfirm: boolean }
 */
export function parseListingPage(body, { perPage = 1000 } = {}) {
  if (!isPlainObject(body)) throw new Error('一覧の応答が JSON オブジェクトではありません');
  if (body.success !== true) {
    const codes = Array.isArray(body.errors)
      ? body.errors
          .map((e) => e?.code)
          .filter(Number.isInteger)
          .join(',')
      : '';
    throw new Error(`一覧の応答が success ではありません${codes ? `（code=${codes}）` : ''}`);
  }
  if (!Array.isArray(body.result)) throw new Error('一覧の応答に result 配列がありません');
  const objects = body.result.map((o, i) => {
    if (!isPlainObject(o) || typeof o.key !== 'string' || o.key === '') throw new Error(`一覧の ${i} 件目に key がありません`);
    if (!Number.isSafeInteger(o.size) || o.size < 0) throw new Error(`一覧の size が不正です: ${o.key}`);
    return { key: o.key, size: o.size, etag: typeof o.etag === 'string' ? o.etag.replace(/"/g, '') : null };
  });
  if (body.result_info === undefined || body.result_info === null) {
    return { objects, cursor: null, needsConfirm: objects.length >= perPage };
  }
  const info = body.result_info;
  if (!isPlainObject(info)) throw new Error('一覧の result_info がオブジェクトではありません');
  if (typeof info.is_truncated !== 'boolean') throw new Error('一覧の result_info.is_truncated が boolean ではありません');
  const hasCursor = info.cursor !== undefined && info.cursor !== null && info.cursor !== '';
  if (hasCursor && typeof info.cursor !== 'string') throw new Error('一覧の cursor が文字列ではありません');
  if (info.is_truncated && !hasCursor) throw new Error('一覧が途中なのに cursor がありません');
  if (!info.is_truncated && hasCursor) throw new Error('一覧が終わりなのに cursor があります（応答が矛盾）');
  return { objects, cursor: info.is_truncated ? info.cursor : null, needsConfirm: false };
}

/**
 * 一覧から、dump と同名の manifest が**両方ある**最新の組を選ぶ。
 * - manifest の無い新しい dump（送信途中・失敗）は飛ばし、skipped に残す
 * - サイズ 0 の dump / manifest は不完全として飛ばす
 * - 未来の時刻（now + skewSeconds より後）は飛ばす
 * - 選んだ組が古すぎれば例外（fail-closed）
 */
export function selectLatestPair(
  objects,
  { prefix, db, now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS, skewSeconds = DEFAULT_SKEW_SECONDS },
) {
  const byStamp = new Map();
  for (const o of objects) {
    const parsed = parseBackupKey(o.key, { prefix, db });
    if (!parsed) continue;
    const slot = byStamp.get(parsed.stamp) ?? { stamp: parsed.stamp, date: parsed.date };
    if (slot[parsed.kind]) throw new Error(`一覧に同じキーが重複しています: ${o.key}`);
    slot[parsed.kind] = { key: o.key, size: o.size, etag: o.etag ?? null };
    byStamp.set(parsed.stamp, slot);
  }
  const skipped = [];
  for (const stamp of [...byStamp.keys()].sort().reverse()) {
    const slot = byStamp.get(stamp);
    if (assessFreshness(slot.date, { now, maxAgeHours: 0, skewSeconds }).why === 'future') {
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
    const ageHours = assertFresh(stamp, slot.date, { now, maxAgeHours, skewSeconds });
    return { stamp, date: slot.date, dump: slot.dump, manifest: slot.manifest, ageHours, skipped, considered: byStamp.size };
  }
  throw new Error(`dump と manifest の揃った組がありません（候補 ${byStamp.size} 件）`);
}

/**
 * R2 の etag を分類する。欠落・不明な形は例外（照合を黙って飛ばさない）。
 * - 32 桁 hex: 単一パートの MD5 → { kind: 'md5', md5 }
 * - `<32 桁 hex>-<N>`（N≥1）: マルチパート。MD5 ではないので内容の照合には使えない → { kind: 'multipart', parts }
 */
export function classifyEtag(etag) {
  if (typeof etag !== 'string' || etag === '') throw new Error('etag がありません（取得物を照合できない）');
  const e = etag.replace(/"/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(e)) return { kind: 'md5', md5: e };
  const m = /^[0-9a-f]{32}-([1-9][0-9]{0,4})$/.exec(e);
  if (m) return { kind: 'multipart', parts: Number(m[1]) };
  throw new Error('etag の形が不明です（32 桁 hex でもマルチパート形式でもない）');
}

// ───────── キー推定（一覧が使えないとき） ─────────

/**
 * 探索窓 [from, to] の manifest キーを**新しい順**に 1 秒刻みで作る。
 * 件数が maxProbes を超える窓は例外（無制限に探さない）。
 */
export function candidateManifestKeys({ prefix, db, from, to, maxProbes = DEFAULT_MAX_PROBES }) {
  if (!NAME_RE.test(db)) throw new Error('DB 名が不正です');
  if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('探索窓の日時が不正です');
  }
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > MAX_PROBES_LIMIT)
    throw new Error('maxProbes が範囲外です');
  const start = Math.floor(from.getTime() / 1000);
  const end = Math.floor(to.getTime() / 1000);
  if (end < start) throw new Error('探索窓が逆順です（--from は --to より前）');
  const count = end - start + 1;
  if (count > maxProbes) throw new Error(`探索窓が広すぎます: ${count} 件 > --max-probes ${maxProbes}`);
  const p = normalizePrefix(prefix);
  const keys = [];
  for (let t = end; t >= start; t -= 1) keys.push(`${p ? `${p}/` : ''}${db}-${formatStamp(new Date(t * 1000))}.manifest.tsv`);
  return keys;
}

/**
 * wrangler の失敗を**固定の分類**に落とす。stderr の文面は出力に使わない
 * （API のパスにアカウント ID が入る・トークン様の文字列が混ざる可能性があるため）。
 * 返り値: { kind: 'not_found'|'bucket_not_found'|'auth'|'rate_limited'|'network'|'signal'|'unknown', exit, signal, http, cfCode }
 * 注意: wrangler の `r2 object get` は**バケットが無いときも** "The specified key does not exist" を返す（2026-11-05 実測）。
 * そのため推定の前にバケットの存在を `r2 bucket info` で確かめる（実行部）。
 */
export function classifyWranglerFailure({ status, signal, stderr }) {
  const text = String(stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  // 例: "Failed to fetch /accounts/<id>/... - 400: Bad Request" / "(status: 400)" / "[code: 6003]" / {"code":9106}
  const httpMatch = /(?:\s-\s|\bstatus(?: code)?[ :]+|\bHTTP[ /]?)([1-5]\d\d)\b/i.exec(text);
  const codeMatch = /\[code: (\d{1,6})\]/.exec(text) ?? /"code":\s?(\d{1,6})/.exec(text);
  const http = httpMatch ? Number(httpMatch[1]) : null;
  const cfCode = codeMatch ? Number(codeMatch[1]) : null;
  const AUTH_CODES = new Set([6003, 6111, 9106, 9109, 10000, 10001]);
  let kind = 'unknown';
  if (signal) kind = 'signal';
  else if (/The specified bucket does not exist/i.test(text) || cfCode === 10006) kind = 'bucket_not_found';
  else if (/The specified key does not exist|NoSuchKey/i.test(text) || cfCode === 10007 || http === 404) kind = 'not_found';
  else if (
    http === 401 ||
    http === 403 ||
    AUTH_CODES.has(cfCode) ||
    /not authenticated|authentication (error|failed)|wrangler login/i.test(text)
  )
    kind = 'auth';
  else if (http === 429 || /rate limit/i.test(text)) kind = 'rate_limited';
  else if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network/i.test(text)) kind = 'network';
  return { kind, exit: Number.isInteger(status) ? status : null, signal: signal ?? null, http, cfCode };
}

/** classifyWranglerFailure の結果を、秘密を含まない 1 行にする。 */
export function describeFailure(f) {
  return `kind=${f.kind} exit=${f.exit ?? '-'} signal=${f.signal ?? '-'} http=${f.http ?? '-'} cf_code=${f.cfCode ?? '-'}`;
}

// ───────── manifest と dump の整合 ─────────

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
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\t(0|[1-9][0-9]{0,15})$/.exec(row);
    if (!m) throw new Error(`manifest の ${i + 2} 行目が <テーブル名><TAB><件数> ではありません`);
    if (tables.has(m[1])) throw new Error(`manifest にテーブルが重複しています: ${m[1]}`);
    if (prev !== null && !(prev < m[1])) throw new Error('manifest のテーブル名が昇順（C 照合）ではありません');
    prev = m[1];
    const count = Number(m[2]);
    if (!Number.isSafeInteger(count)) throw new Error(`manifest の ${i + 2} 行目の件数が安全な整数の範囲を超えています`);
    tables.set(m[1], count);
  }
  return { auditTip: hm[1] ?? '', tables };
}

/** `pg_restore --list` の TOC から `TABLE DATA public <name>` を**出現回数つき**で集める（重複を検出するため）。 */
export function tocTableCounts(tocText) {
  const counts = new Map();
  for (const line of String(tocText).split('\n')) {
    if (line.startsWith(';')) continue;
    const m = /^\d+;\s+\d+\s+\d+\s+TABLE DATA public (\S+) /.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/** TOC（出現回数つき）と manifest のテーブル集合を比べる。重複・欠落・余分のどれかがあれば ok=false。 */
export function compareTocWithManifest(tocCounts, manifestTables) {
  const want = new Set(manifestTables.keys());
  const duplicate = [...tocCounts]
    .filter(([, n]) => n > 1)
    .map(([name]) => name)
    .sort();
  const missing = [...want].filter((n) => !tocCounts.has(n)).sort();
  const extra = [...tocCounts.keys()].filter((n) => !want.has(n)).sort();
  return { ok: duplicate.length === 0 && missing.length === 0 && extra.length === 0, missing, extra, duplicate };
}

// ───────── 外部入力の検査（トークン・URL・日時・fetch の失敗） ─────────

/**
 * API トークンを HTTP ヘッダに載せてよい形か確かめる（RFC 7230 の可視 ASCII のみ。空白・改行・制御文字は拒否）。
 * 不正なトークンを fetch に渡すと、例外の文面にヘッダ値が載ることがあるため、送る前に止める。値は返さない・出さない。
 */
export function isHeaderSafeToken(token) {
  return typeof token === 'string' && /^[\x21-\x7E]{20,512}$/.test(token);
}

/** オブジェクトのキーを URL のパスへ。空・`.`・`..` のセグメントは拒否。 */
export function encodeObjectKey(key) {
  if (typeof key !== 'string' || key === '') throw new Error('オブジェクトのキーが不正です');
  return key
    .split('/')
    .map((segment) => {
      if (segment === '' || segment === '.' || segment === '..')
        throw new Error('オブジェクトのキーに空・. ・.. のセグメントがあります');
      return encodeURIComponent(segment);
    })
    .join('/');
}

/**
 * Cloudflare REST API の URL を組み立て、パスが期待どおり
 * `/client/v4/accounts/<id>/r2/buckets/<bucket>/objects`（一覧）または その直下のキー（取得）であることを確かめる。
 * WHATWG URL は `%2e%2e` も `..` として畳むため、組み立て後の pathname で判定する。
 */
export function buildR2Url({ apiBase = 'https://api.cloudflare.com/client/v4', accountId, bucket, key = null, query = null }) {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('アカウント ID の形が不正です');
  if (!BUCKET_RE.test(bucket)) throw new Error('バケット名が不正です');
  const base = new URL(apiBase);
  const listPath = `${base.pathname.replace(/\/+$/, '')}/accounts/${accountId}/r2/buckets/${bucket}/objects`;
  const path = key === null ? listPath : `${listPath}/${encodeObjectKey(key)}`;
  const url = new URL(base.origin + path);
  if (query) url.search = new URLSearchParams(query).toString();
  if (url.origin !== base.origin) throw new Error('API の接続先が想定と違います');
  if (
    key === null
      ? url.pathname !== listPath
      : !url.pathname.startsWith(`${listPath}/`) || url.pathname.length <= listPath.length + 1
  ) {
    throw new Error('組み立てた URL のパスが想定の範囲外です');
  }
  if (key !== null && decodeURIComponent(url.pathname.slice(listPath.length + 1)) !== key) {
    throw new Error('組み立てた URL のキーが元のキーと一致しません');
  }
  return url;
}

/**
 * fetch の例外を**固定の種別**にする。例外の文面（URL・ヘッダ値が載りうる）は使わない。
 * 返り値: 'aborted' | 'timeout' | 'network' | 'unknown'
 */
export function classifyFetchError(error) {
  const name = error?.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  // Node の fetch は不正なヘッダ値でも通信失敗でも TypeError を投げる（文面にヘッダ値が載ることがある）。
  // 文面で見分けず、送る前の検査（isHeaderSafeToken）で前者を止め、ここでは種別だけを返す。
  if (name === 'TypeError') return 'network';
  return 'unknown';
}

/**
 * タイムゾーン明示（`Z` か `±HH:MM`、±14:00 まで）の ISO 8601 日時だけを受ける。
 * 実在しない日時（2026-02-30、25 時など）は、オフセットを当てる前の各欄の往復で拒否する。秒の小数は 3 桁まで。
 */
export function parseIsoWithZone(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(String(value));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (
    local.getUTCFullYear() !== y ||
    local.getUTCMonth() !== mo - 1 ||
    local.getUTCDate() !== d ||
    local.getUTCHours() !== h ||
    local.getUTCMinutes() !== mi ||
    local.getUTCSeconds() !== s
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (om > 59 || oh * 60 + om > 14 * 60) return null;
    offsetMinutes = (m[9] === '+' ? 1 : -1) * (oh * 60 + om);
  }
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  // オフセットを当てた後の UTC も 4 桁の年（0000〜9999）に収める。
  // 例: 9999-12-31T23:59:59-14:00 は UTC で 10000 年になり、toISOString が +010000-… の拡張形式になる。
  const utcYear = utc.getUTCFullYear();
  if (!Number.isFinite(utc.getTime()) || utcYear < 0 || utcYear > 9999) return null;
  return utc;
}

/**
 * 中断シグナルの扱い（状態遷移だけ。実際の kill は実行部）。
 * 1 回目: 受けたシグナルを子のプロセスグループへ 1 回だけ転送。2 回目以降: SIGKILL へ格上げ。
 */
export function nextSignalAction(state, signal) {
  if (!state.first) return { state: { first: signal, escalated: false }, action: { kind: 'forward', signal } };
  if (!state.escalated) return { state: { ...state, escalated: true }, action: { kind: 'kill', signal: 'SIGKILL' } };
  return { state, action: { kind: 'none' } };
}

// ───────── 引数 ─────────

function boundedInt(value, name, { min, max }) {
  if (!/^\d{1,9}$/.test(value)) throw new Error(`${name} は ${min}〜${max} の整数です`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} は ${min}〜${max} の整数です`);
  return n;
}

/** 引数を解釈する。誤りは例外。 */
export function parseArgs(argv) {
  const opts = {
    source: 'list',
    verifyOnly: false,
    out: null,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    from: null,
    to: null,
    maxProbes: DEFAULT_MAX_PROBES,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} に値がありません`);
    return argv[i + 1];
  };
  const isoDate = (value, name) => {
    const d = parseIsoWithZone(value);
    if (!d) throw new Error(`${name} はタイムゾーン付きの実在する ISO 8601 日時です（例 2026-11-05T07:00:00Z / +09:00）`);
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
      opts.maxAgeHours = boundedInt(need(i, a), a, { min: 0, max: MAX_AGE_HOURS_LIMIT });
      i += 1;
    } else if (a === '--from') {
      opts.from = isoDate(need(i, a), a);
      i += 1;
    } else if (a === '--to') {
      opts.to = isoDate(need(i, a), a);
      i += 1;
    } else if (a === '--max-probes') {
      opts.maxProbes = boundedInt(need(i, a), a, { min: 1, max: MAX_PROBES_LIMIT });
      i += 1;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  if (opts.source === 'list' && (opts.from || opts.to)) throw new Error('--from / --to は --source guess のときだけ使えます');
  return opts;
}
