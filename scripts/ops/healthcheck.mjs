#!/usr/bin/env node
/**
 * 外形監視（Staging: `mirai-sf-healthcheck.timer` / 本番: `mirai-sf-prod-healthcheck.timer` から5分ごとに実行）。
 *
 * 確認項目:
 *   1. 127.0.0.1 の /healthz が HTTP 200 を返す
 *   2. status=ok かつ db.ok=true
 *   3. environment が期待どおり（既定 staging。本番は MIRAI_SF_HEALTH_ENV=production）
 *   4. /healthz の commit が current/release.env の COMMIT_SHA と一致する
 *   5. auth.status が ready（misconfigured は認証不能。HTTP 200 でも失敗にする。Issue #102 の残リスク）
 *   6. （任意）git rev-parse origin/main と一致しない場合は warning（失敗にはしない）
 *   7. （任意）最新 dump の鮮度（MIRAI_SF_HEALTH_BACKUP_DIR 設定時）
 *   8. （任意）最新世代のオフサイト送信記録の存在・鮮度（MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN 設定時）。
 *      最新のローカル dump に対応する `<dump名>.r2.json` が無いまま猶予（既定 10 分）を超えていないかも見る。
 *
 * 7・8 はどちらも「検知範囲の拡大」であって RPO の保証ではない（docs/production/07-slo-and-measurement.md）。
 *
 * 失敗時は exit 1（oneshot unit が failed になり `systemctl --user --failed` で見える）。
 * 連続失敗と最終状態は ~/.local/state/mirai-sf/healthcheck.json に残し、復旧時に1行ログを出す。
 *
 * 秘密情報は出力しない:
 *   - preview.conf（DATABASE_URL などの設定値）は読まない。DB も触らない。
 *   - /healthz の本文はログへ出さない。出すのは確認済みの項目（status / environment / db.ok / commit）だけ。
 *   - auth は mode / 真偽値 / status だけを出し、team domain・AUD・メールアドレスは出さない（/healthz も返さない）。
 *   - URL は scheme://host:port/path までに落として出し、資格情報・クエリは出さない。
 *   - with-env.mjs と同じく、設定値は表示せず、失敗理由も内部で組み立てた文言だけを出す。
 *
 * 環境変数:
 *   MIRAI_SF_HEALTH_URL          確認する URL（既定 http://127.0.0.1:8782/healthz）
 *   MIRAI_SF_HOME                current/release.env を置く場所（既定 ~/.local/share/mirai-sf）
 *   MIRAI_SF_REPO                ⑤ の git リポジトリ（既定: カレント → このスクリプトの2階層上）
 *   MIRAI_SF_HEALTH_STATE_FILE   状態ファイル（既定 ~/.local/state/mirai-sf/healthcheck.json。検証用）
 *   MIRAI_SF_HEALTH_BACKUP_DIR   （任意）最新 dump の鮮度を見るディレクトリ
 *   MIRAI_SF_HEALTH_BACKUP_MAX_AGE_MIN   dump 鮮度の閾値（分、既定 90）
 *   MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN  （任意）最新の `*.dump.r2.json`（R2 送信記録）の鮮度の閾値（分）。
 *                                未設定なら確認しない。記録の時刻は JSON の uploadedAt（キーが無いときだけ mtime）。
 *                                最新記録が読めない・壊れている・未来時刻・シンボリックリンクなら NG（fail-closed）。
 *                                記録の中身（バケット・キー・ハッシュ）と保存先のパスは出力しない。
 *                                あわせて、最新のローカル dump（`*.dump`）に対応する `<dump名>.r2.json` の存在を見る。
 *   MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN  （任意）最新 dump に送信記録がまだ無いときの猶予（分、既定 10）。
 *                                上記の MAX_AGE 設定時だけ使う。dump 作成直後は送信中のため、dump の経過が
 *                                猶予以内なら OK、超えていれば NG（送信失敗の検知遅れを縮める）。
 *
 * 終了コード: 0=正常（warning を含む）/ 1=異常
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8782/healthz';
/** 期待する environment。Staging は既定のまま。本番は MIRAI_SF_HEALTH_ENV=production を渡す。 */
const EXPECTED_ENVIRONMENT = process.env.MIRAI_SF_HEALTH_ENV || 'staging';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HTTP_TIMEOUT_MS = 5000;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

const healthUrl = process.env.MIRAI_SF_HEALTH_URL || DEFAULT_HEALTH_URL;
const miraiHome = process.env.MIRAI_SF_HOME || resolve(homedir(), '.local/share/mirai-sf');
const stateFile = process.env.MIRAI_SF_HEALTH_STATE_FILE || resolve(homedir(), '.local/state/mirai-sf/healthcheck.json');
/** 任意: バックアップの鮮度確認（RPO 1 時間に対して既定 90 分）。未設定なら確認しない。 */
const backupDir = process.env.MIRAI_SF_HEALTH_BACKUP_DIR || '';
const backupMaxAgeMin = Number.parseInt(process.env.MIRAI_SF_HEALTH_BACKUP_MAX_AGE_MIN ?? '90', 10) || 90;
/**
 * 任意: オフサイト（R2）送信記録 `<dump>.r2.json` の鮮度確認（分）。未設定・空なら確認しない（従来どおり）。
 * 設定時は MIRAI_SF_HEALTH_BACKUP_DIR 内の最新の `*.dump.r2.json` を見る。ローカル dump が新しくても
 * R2 送信が止まっていれば失敗にするため。値の書式が不正なときは設定ミスとして失敗にする（値は出さない）。
 */
const offsiteMaxAgeRaw = (process.env.MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN ?? '').trim();
/**
 * 最新 dump に対応する送信記録がまだ無いときの猶予（分）。backup.sh は dump を置いた後に R2 へ送るため、
 * 直後は記録が無いのが正常である。dump の経過がこの猶予を超えても記録が無ければ NG にする。
 * 未設定・空なら既定 10 分。MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN 設定時だけ使う。
 */
const DEFAULT_OFFSITE_GENERATION_GRACE_MIN = 10;
const offsiteGenerationGraceRaw = (process.env.MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN ?? '').trim();
/** 送信記録の uploadedAt・mtime の未来方向の許容幅（時計ずれ）。超えたら NG（負の経過分を正常扱いしない）。 */
const OFFSITE_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** 送信記録として読む最大サイズ。超えたら NG。 */
const OFFSITE_RECORD_MAX_BYTES = 64 * 1024;
/** 障害時の案内に出す unit 名（本番は mirai-sf-prod-healthcheck）。 */
const unitName = process.env.MIRAI_SF_HEALTH_UNIT || 'mirai-sf-healthcheck';
const repoHint = process.env.MIRAI_SF_REPO || '';

const timestamp = () => new Date().toISOString();
const log = (message) => console.log(`[${timestamp()}] ${message}`);
const warn = (message) => console.warn(`[${timestamp()}] 警告: ${message}`);
const ng = (message) => console.error(`[${timestamp()}] NG: ${message}`);

// URL は scheme://host:port/path だけにする（資格情報・クエリ・フラグメントを出さない）
function describeUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '(URL を解釈できません)';
  }
}

// 応答の値をログへ出す前に形を検証する（改行などで journal を汚さない）
function safeValue(value) {
  return typeof value === 'string' && SAFE_VALUE_PATTERN.test(value) ? value : '(想定外の値)';
}

// ネットワーク例外の文言は URL を含むことがあるので、errno など安全な断片だけを出す
function describeFetchError(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return `タイムアウト（${HTTP_TIMEOUT_MS}ms）`;
  const cause = error && typeof error === 'object' ? error.cause : undefined;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(cause.code)) return cause.code;
    if (typeof cause.errno === 'string' && /^[A-Z0-9_]{2,40}$/.test(cause.errno)) return cause.errno;
    if (cause.message === 'bad port') return 'bad port';
  }
  return error instanceof Error ? error.name : '不明なエラー';
}

function loadState() {
  if (!existsSync(stateFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    log('状態ファイルを読めないため、今回を新規の状態として扱います');
    return {};
  }
}

function saveState(state) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, stateFile);
}

function resolveGitRepo() {
  const candidates = [];
  if (repoHint) candidates.push(repoHint);
  candidates.push(process.cwd(), resolve(SCRIPT_DIR, '../..'));
  for (const candidate of candidates) {
    try {
      const toplevel = execFileSync('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim();
      if (toplevel) return toplevel;
    } catch {
      // 次の候補へ（git 管理外・パス不在など）
    }
  }
  return null;
}

function readGitRef(repo, ref) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

// release.env は KEY=VALUE。COMMIT_SHA 以外は読まない・出さない
function readDeployedCommit() {
  const releaseEnv = resolve(miraiHome, 'current', 'release.env');
  if (!existsSync(releaseEnv)) {
    return { ok: false, failure: `release.env が見つかりません（${releaseEnv}）` };
  }
  let text;
  try {
    text = readFileSync(releaseEnv, 'utf8');
  } catch {
    return { ok: false, failure: 'release.env を読めません' };
  }
  const matched = /^COMMIT_SHA=([0-9a-f]{40})[ \t]*$/m.exec(text);
  if (!matched) return { ok: false, failure: 'release.env に 40 桁の COMMIT_SHA がありません' };
  return { ok: true, value: matched[1] };
}

async function fetchHealth() {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(healthUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return {
      ok: false,
      failure: `healthz へ接続できません（${describeFetchError(error)}）`,
      durationMs: Date.now() - startedAt,
    };
  }

  if (response.status !== 200) {
    return {
      ok: false,
      failure: `healthz が HTTP ${response.status} を返しました（200 を期待）`,
      durationMs: Date.now() - startedAt,
    };
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      failure: `healthz の本文を読めません（${describeFetchError(error)}）`,
      durationMs: Date.now() - startedAt,
    };
  }

  let health;
  try {
    health = JSON.parse(text);
  } catch {
    return { ok: false, failure: 'healthz の本文が JSON ではありません', durationMs: Date.now() - startedAt };
  }
  if (!health || typeof health !== 'object') {
    return { ok: false, failure: 'healthz の本文が JSON オブジェクトではありません', durationMs: Date.now() - startedAt };
  }

  return { ok: true, health, durationMs: Date.now() - startedAt };
}

/** 最新の dump の経過時間を調べる（RPO が黙って破れていないかの確認）。 */
function checkBackupFreshness(dir, maxAgeMin) {
  if (!existsSync(dir)) return { failure: `バックアップの保存先がありません: ${dir}` };
  let newest = 0;
  let name = '';
  // 保存先が読めない・ディレクトリでない・dump の stat に失敗した場合に例外で落ちると、構造化された NG にならず
  // stack にパスが出る。例外は捕捉して固定文言の失敗へ変える（例外の文言・パスは出さない）
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { failure: 'バックアップの保存先を読めません（MIRAI_SF_HEALTH_BACKUP_DIR。ディレクトリでない・権限不足など）' };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.dump')) continue;
    let at;
    try {
      at = statSync(join(dir, entry)).mtimeMs;
    } catch {
      return { failure: `バックアップ（dump）の状態を取得できません: ${safeValue(entry)}` };
    }
    if (at > newest) {
      newest = at;
      name = entry;
    }
  }
  if (newest === 0) return { failure: `バックアップ（dump）がありません: ${dir}` };
  const ageMinutes = Math.round((Date.now() - newest) / 60000);
  if (ageMinutes > maxAgeMin) {
    return { failure: `最新のバックアップが古すぎます（${ageMinutes} 分前 > ${maxAgeMin} 分）: ${name}` };
  }
  return { info: `最新バックアップ: ${name}（${ageMinutes} 分前）` };
}

/**
 * 送信記録 1 件を検証して時刻を返す（fail-closed）。記録の中身（バケット・キー・ハッシュ）は返さない・出さない。
 *   - サイズが 0 または上限超過、読めない、JSON オブジェクトでない → 失敗
 *   - uploadedAt があるのに文字列でない・時刻として解釈できない → 失敗
 *   - uploadedAt が無いオブジェクトだけ mtime を使う
 *   - 採用した時刻・mtime のどちらかが現在より許容幅（5 分）を超えて未来 → 失敗
 * 失敗理由は内部で組み立てた固定文言だけ（例外の文言・パス・値は出さない）。
 */
function readOffsiteRecordTime(path, stat, now) {
  if (stat.mtimeMs > now + OFFSITE_FUTURE_SKEW_MS) {
    return { failure: '更新時刻が未来です（時計ずれの許容 5 分を超過）' };
  }
  if (stat.size <= 0 || stat.size > OFFSITE_RECORD_MAX_BYTES) {
    return { failure: `サイズが想定外です（0 バイト、または ${OFFSITE_RECORD_MAX_BYTES} バイト超）` };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { failure: '読めません' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { failure: 'JSON として解釈できません' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { failure: 'JSON オブジェクトではありません' };
  }
  if (!Object.hasOwn(parsed, 'uploadedAt')) return { at: stat.mtimeMs, source: 'mtime' };
  const at = typeof parsed.uploadedAt === 'string' ? Date.parse(parsed.uploadedAt) : Number.NaN;
  if (!Number.isFinite(at)) return { failure: 'uploadedAt を時刻として解釈できません' };
  if (at > now + OFFSITE_FUTURE_SKEW_MS) return { failure: 'uploadedAt が未来です（時計ずれの許容 5 分を超過）' };
  return { at, source: 'uploadedAt' };
}

/**
 * 最新のローカル dump（`*.dump`、通常ファイル）を特定する（fail-closed）。
 * dot 始まりのエントリは backup.sh の一時ファイル等なので世代として数えない。
 * lstat できない・通常ファイルでないエントリは、どれが最新か決められないため NG（固定文言・名前以外は出さない）。
 */
function findLatestLocalDump(dir, entries) {
  let newest = null;
  for (const entry of entries) {
    if (entry.startsWith('.') || !entry.endsWith('.dump')) continue;
    let stat;
    try {
      stat = lstatSync(join(dir, entry));
    } catch {
      return { failure: `ローカル dump の状態を取得できません: ${safeValue(entry)}` };
    }
    if (!stat.isFile()) {
      return { failure: `ローカル dump が通常ファイルではありません（シンボリックリンク等は不可）: ${safeValue(entry)}` };
    }
    if (!newest || stat.mtimeMs > newest.stat.mtimeMs) newest = { name: entry, stat };
  }
  if (!newest) {
    return { failure: '最新のローカル dump（*.dump）を特定できません（オフサイト送信記録との世代対応を確認できません）' };
  }
  return { newest };
}

/**
 * 最新のローカル dump とオフサイト送信記録の「世代対応」を調べる（fail-closed）。
 * 既定の確認（最新の記録の鮮度）だけでは、最新 dump の送信だけが失敗して 1 つ前の記録が閾値内の間、
 * 検知できない。ここでは最新 dump に対応する `<dump名>.r2.json` の存在を見る。
 *   - 対応する記録が無い: dump の経過が猶予（既定 10 分）以内なら OK（送信中）、超えていれば NG
 *   - 対応する記録がある: 通常ファイルであること・検証できること・鮮度（maxAgeMin）を確認する
 *   - 最新 dump を特定できない（1 件も無い）・通常ファイルでない・lstat できない・更新時刻が未来: NG
 * 記録の中身（バケット・キー・ハッシュ）と保存先のフルパスは出さない。
 */
function checkOffsiteGeneration(dir, entries, maxAgeMin, graceMin, now) {
  const latest = findLatestLocalDump(dir, entries);
  if (latest.failure) return { failure: latest.failure };
  const { name, stat } = latest.newest;
  const safeDumpName = safeValue(name);
  if (stat.mtimeMs > now + OFFSITE_FUTURE_SKEW_MS) {
    return { failure: `最新 dump の更新時刻が未来です（時計ずれの許容 5 分を超過）: ${safeDumpName}` };
  }
  const recordName = `${name}.r2.json`;
  const recordPath = join(dir, recordName);
  let recordStat;
  try {
    recordStat = lstatSync(recordPath);
  } catch (error) {
    // 記録が無い（ENOENT）だけを「未送信」として扱う。状態を取得できない場合は判定不能なので NG
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) {
      return { failure: `最新世代のオフサイト送信記録の状態を取得できません: ${safeValue(recordName)}` };
    }
  }
  const dumpAgeMs = Math.max(0, now - stat.mtimeMs);
  if (!recordStat) {
    if (dumpAgeMs > graceMin * 60000) {
      const ageSeconds = Math.floor(dumpAgeMs / 1000);
      const shown = `${Math.floor(ageSeconds / 60)} 分 ${ageSeconds % 60} 秒前`;
      return {
        failure: `最新世代のオフサイト送信記録がありません（dump の経過 ${shown} > 猶予 ${graceMin} 分）: ${safeDumpName}`,
      };
    }
    return {
      info: `最新世代のオフサイト送信記録: まだありません（dump の経過 ${Math.round(dumpAgeMs / 60000)} 分 ≤ 猶予 ${graceMin} 分）: ${safeDumpName}`,
    };
  }
  if (!recordStat.isFile()) {
    return {
      failure: `最新世代のオフサイト送信記録が通常ファイルではありません（シンボリックリンク等は不可）: ${safeValue(recordName)}`,
    };
  }
  const time = readOffsiteRecordTime(recordPath, recordStat, now);
  if (time.failure) {
    return { failure: `最新世代のオフサイト送信記録を検証できません（${time.failure}）: ${safeValue(recordName)}` };
  }
  // 許容幅内の未来（時計ずれ）は 0 として扱う。閾値との比較はミリ秒で行い、丸めるのは表示だけ
  const ageMs = Math.max(0, now - time.at);
  if (ageMs > maxAgeMin * 60000) {
    const ageSeconds = Math.floor(ageMs / 1000);
    const shown = `${Math.floor(ageSeconds / 60)} 分 ${ageSeconds % 60} 秒前`;
    return {
      failure: `最新世代のオフサイト送信記録が古すぎます（${shown} > ${maxAgeMin} 分、${time.source} 基準）: ${safeValue(recordName)}`,
    };
  }
  return {
    info: `最新世代のオフサイト送信記録: ${safeValue(recordName)}（${Math.round(ageMs / 60000)} 分前、${time.source} 基準）`,
  };
}

/**
 * オフサイト（R2）の送信状況を調べる。R2 送信が黙って止まっていないかの確認。
 *   1) 最新の送信記録（`*.dump.r2.json`）の鮮度。「最新」は lstat の mtime が最も新しい記録。
 *   2) 最新のローカル dump に対応する送信記録の存在（世代相関）と鮮度。
 * どちらも fail-closed: 読めない・通常ファイルでない・壊れている・未来時刻は NG。
 * 1) で NG になった場合は 2) を重ねて出さない（同じ障害でログを埋めない）。保存先のパスはログへ出さない。
 * @returns {{ failures: string[], infos: string[] }}
 */
function checkOffsiteFreshness(dir, maxAgeMin, generationGraceMin) {
  const where = 'MIRAI_SF_HEALTH_BACKUP_DIR';
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    return { failures: [`オフサイト送信記録の保存先がありません（${where}）`], infos: [] };
  }
  if (!dirStat.isDirectory()) {
    return { failures: [`オフサイト送信記録の保存先がディレクトリではありません（${where}）`], infos: [] };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { failures: [`オフサイト送信記録の保存先を読めません（${where}）`], infos: [] };
  }
  const now = Date.now();
  let newest = null;
  for (const entry of entries) {
    if (!entry.endsWith('.dump.r2.json')) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return { failures: [`オフサイト送信記録の状態を取得できません: ${safeValue(entry)}`], infos: [] };
    }
    if (!stat.isFile()) {
      return {
        failures: [`オフサイト送信記録が通常ファイルではありません（シンボリックリンク等は不可）: ${safeValue(entry)}`],
        infos: [],
      };
    }
    if (!newest || stat.mtimeMs > newest.stat.mtimeMs) newest = { name: entry, path, stat };
  }
  if (!newest) return { failures: [`オフサイト送信記録（*.dump.r2.json）がありません（${where}）`], infos: [] };
  const name = safeValue(newest.name);
  const time = readOffsiteRecordTime(newest.path, newest.stat, now);
  if (time.failure) {
    return { failures: [`最新のオフサイト送信記録を検証できません（${time.failure}）: ${name}`], infos: [] };
  }
  // 許容幅内の未来（時計ずれ）は 0 として扱う。許容幅を超える未来は上で NG にしている。
  // 閾値との比較はミリ秒で行う（丸めた分で比べると 90 分 29 秒が通ってしまう）。丸めるのは表示だけ
  const ageMs = Math.max(0, now - time.at);
  const ageMinutes = Math.round(ageMs / 60000);
  if (ageMs > maxAgeMin * 60000) {
    const ageSeconds = Math.floor(ageMs / 1000);
    const shown = `${Math.floor(ageSeconds / 60)} 分 ${ageSeconds % 60} 秒前`;
    return {
      failures: [`最新のオフサイト送信記録が古すぎます（${shown} > ${maxAgeMin} 分、${time.source} 基準）: ${name}`],
      infos: [],
    };
  }
  const infos = [`最新オフサイト送信記録: ${name}（${ageMinutes} 分前、${time.source} 基準）`];
  const generation = checkOffsiteGeneration(dir, entries, maxAgeMin, generationGraceMin, now);
  if (generation.failure) return { failures: [generation.failure], infos };
  if (generation.info) infos.push(generation.info);
  return { failures: [], infos };
}

async function main() {
  try {
    new URL(healthUrl);
  } catch {
    ng('MIRAI_SF_HEALTH_URL を URL として解釈できません（値をログへは出しません）');
    return 1;
  }

  const checkedAt = timestamp();
  const previous = loadState();
  const previousFailures = Math.max(0, Number.parseInt(previous.consecutiveFailures, 10) || 0);
  const totalFailures = Math.max(0, Number.parseInt(previous.totalFailures, 10) || 0);
  const warnings = [];
  const failures = [];

  log(`healthcheck 開始: url=${describeUrl(healthUrl)}`);

  const probe = await fetchHealth();
  let health = null;
  if (!probe.ok) {
    failures.push(probe.failure);
  } else {
    health = probe.health;

    // 2. status=ok かつ db.ok=true
    if (health.status !== 'ok') failures.push(`status=${safeValue(health.status)}（ok を期待）`);
    const dbOk = health.db && typeof health.db === 'object' ? health.db.ok === true : false;
    if (!dbOk) failures.push('db.ok=true ではありません（DB 接続に失敗している可能性）');

    // 3. environment が期待どおりか
    if (health.environment !== EXPECTED_ENVIRONMENT) {
      failures.push(`environment=${safeValue(health.environment)}（${EXPECTED_ENVIRONMENT} を期待）`);
    }

    // 4. healthz の commit と current/release.env の COMMIT_SHA が一致
    const deployed = readDeployedCommit();
    if (!deployed.ok) {
      failures.push(deployed.failure);
    } else if (!SHA_PATTERN.test(String(health.commit))) {
      failures.push('healthz の commit が 40 桁の 16 進ではありません');
    } else if (health.commit !== deployed.value) {
      failures.push(`commit が一致しません（healthz=${health.commit}, release.env=${deployed.value}）`);
    }

    // 5. 認証状態。HTTP 200 / status=ok でも、認証できる経路が無ければ失敗にする
    //    （Issue #102 の残リスク: JWT 未設定 + ヘッダ信頼無効で /healthz が 200 のまま認証全断になる）
    const auth = health.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      // 版ずれの過渡期（監視の更新が API の配備より先）を許容する。misconfigured は失敗にする。
      const message = 'auth が healthz にありません（API と監視の版ずれ。認証状態を確認できません）';
      warnings.push(message);
      warn(message);
    } else if (auth.status === 'misconfigured') {
      failures.push(
        `auth.status=misconfigured（認証不能。mode=${safeValue(auth.mode)}, jwtConfigured=${auth.jwtConfigured === true}, headerTrustEnabled=${auth.headerTrustEnabled === true}, allowlistConfigured=${auth.allowlistConfigured === true}）`,
      );
    } else if (auth.status !== 'ready') {
      failures.push(`auth.status=${safeValue(auth.status)}（ready を期待）`);
    } else {
      log(`auth.status=ready（mode=${safeValue(auth.mode)}）`);
    }

    // 6. （任意）origin/main との比較。取得できるときだけ warning を出す
    if (SHA_PATTERN.test(String(health.commit))) {
      const repo = resolveGitRepo();
      const originMain = repo ? readGitRef(repo, 'refs/remotes/origin/main') : null;
      if (!repo) {
        log('git リポジトリを特定できないため origin/main の比較はスキップします（任意チェック）');
      } else if (!originMain) {
        log('origin/main を取得できないため比較はスキップします（任意チェック。git fetch は行いません）');
      } else if (health.commit !== originMain) {
        const message = `デプロイ commit ${health.commit} は origin/main ${originMain} と一致しません（release 反映漏れの可能性）`;
        warnings.push(message);
        warn(message);
      } else {
        log(`origin/main と一致: ${originMain}`);
      }
    }
  }

  // 7. （任意）バックアップの鮮度（RPO の確認）。環境変数があるときだけ
  if (backupDir) {
    const backup = checkBackupFreshness(backupDir, backupMaxAgeMin);
    if (backup.failure) {
      failures.push(backup.failure);
    } else if (backup.info) {
      log(backup.info);
    }
  }

  // 8. （任意）オフサイト（R2）送信記録の鮮度と、最新 dump との世代対応。
  //    MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN があるときだけ
  if (offsiteMaxAgeRaw) {
    const offsiteMaxAgeMin = /^[1-9][0-9]{0,5}$/.test(offsiteMaxAgeRaw) ? Number(offsiteMaxAgeRaw) : null;
    if (offsiteMaxAgeMin === null) {
      failures.push('MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN が正の整数（分）ではありません（値はログへ出しません）');
    } else if (!backupDir) {
      failures.push('MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN の確認には MIRAI_SF_HEALTH_BACKUP_DIR が必要です');
    } else {
      const offsiteGenerationGraceMin =
        offsiteGenerationGraceRaw === ''
          ? DEFAULT_OFFSITE_GENERATION_GRACE_MIN
          : /^[1-9][0-9]{0,5}$/.test(offsiteGenerationGraceRaw)
            ? Number(offsiteGenerationGraceRaw)
            : null;
      if (offsiteGenerationGraceMin === null) {
        failures.push('MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN が正の整数（分）ではありません（値はログへ出しません）');
      } else {
        const offsite = checkOffsiteFreshness(backupDir, offsiteMaxAgeMin, offsiteGenerationGraceMin);
        for (const info of offsite.infos) log(info);
        failures.push(...offsite.failures);
      }
    }
  }

  const baseState = {
    version: 1,
    checkedAt,
    url: describeUrl(healthUrl),
    healthCommit: health && SHA_PATTERN.test(String(health.commit)) ? health.commit : null,
    environment: health ? safeValue(health.environment) : null,
    dbOk: health && health.db && typeof health.db === 'object' ? health.db.ok === true : null,
    authStatus: health && health.auth && typeof health.auth === 'object' ? safeValue(health.auth.status) : null,
    authMode: health && health.auth && typeof health.auth === 'object' ? safeValue(health.auth.mode) : null,
    previousConsecutiveFailures: previousFailures,
    totalFailures,
    lastFailureAt: previous.lastFailureAt ?? null,
    lastFailureReason: previous.lastFailureReason ?? null,
    lastIncidentFailures: previous.lastIncidentFailures ?? null,
    recoveredAt: previous.recoveredAt ?? null,
    warnings,
  };

  if (failures.length === 0) {
    const recovered = previousFailures > 0;
    const state = { ...baseState, ok: true, consecutiveFailures: 0, durationMs: probe.durationMs };
    if (recovered) {
      state.lastIncidentFailures = previousFailures;
      state.recoveredAt = checkedAt;
    }
    try {
      saveState(state);
    } catch {
      ng('状態ファイルを書き込めません（~/.local/state/mirai-sf の権限を確認してください）');
      return 1;
    }
    if (recovered) {
      log(`復旧: 連続 ${previousFailures} 回の失敗から回復しました（最終失敗 ${previous.lastFailureAt ?? '不明'}）`);
    }
    log(
      `healthcheck OK（commit=${health.commit}, environment=${safeValue(health.environment)}, db.ok=true, auth.status=${safeValue(health.auth?.status)}, ${probe.durationMs}ms）`,
    );
    return 0;
  }

  const consecutiveFailures = previousFailures + 1;
  const reason = failures.join(' / ');
  const state = {
    ...baseState,
    ok: false,
    consecutiveFailures,
    totalFailures: totalFailures + 1,
    lastFailureAt: checkedAt,
    lastFailureReason: reason,
    durationMs: probe.durationMs,
  };
  try {
    saveState(state);
  } catch {
    ng('状態ファイルを書き込めません（~/.local/state/mirai-sf の権限を確認してください）');
  }

  for (const failure of failures) ng(failure);
  ng(`healthcheck NG（連続 ${consecutiveFailures} 回目）`);
  ng(`確認: journalctl --user -u ${unitName} / systemctl --user --failed`);
  return 1;
}

process.exitCode = await main();
