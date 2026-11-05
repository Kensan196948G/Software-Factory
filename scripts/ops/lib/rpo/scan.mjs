/**
 * rpo-report のスキャン（読取り専用）。バックアップ保存先と healthcheck の状態ファイルを読む。
 *
 * fail-closed: 検証できないものは黙って捨てず errors に入れる。シンボリックリンクは追跡しない（lstat）。
 * 返す値に記録の中身（bucket / key / sha256）・失敗理由の本文・パス・例外の文言は含めない。
 */
import { closeSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSON_MAX_BYTES, SKEW_MS, iso, parseStrictIso, safeName } from './common.mjs';

const DUMP_PATTERN = /^([A-Za-z0-9_]{1,64})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

/** dump 名の snapshot 時刻（UTC）。実在しない日時（20261231T246000Z など）は null。 */
function snapshotTimeOf(dumpName) {
  const matched = DUMP_PATTERN.exec(dumpName);
  if (!matched) return { matched: false, at: null };
  const [, , year, month, day, hour, minute, second] = matched;
  const at = parseStrictIso(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return { matched: true, at };
}

/** 通常ファイルとして開けるか（lstat で通常ファイルと確かめた後に、読取りで開けることを確かめる）。 */
function canOpenForRead(path) {
  try {
    closeSync(openSync(path, 'r'));
    return true;
  } catch {
    return false;
  }
}

/** 送信記録 1 件を検証して uploadedAt（ミリ秒）を返す。 */
function readOffsiteRecord(path, stat, snapshotAt, now) {
  if (stat.size <= 0 || stat.size > JSON_MAX_BYTES) {
    return { error: `サイズが想定外です（0 バイト、または ${JSON_MAX_BYTES} バイト超）` };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { error: '読めません' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'JSON として解釈できません' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'JSON オブジェクトではありません' };
  if (!Object.hasOwn(parsed, 'uploadedAt')) return { error: 'uploadedAt がありません' };
  const at = parseStrictIso(parsed.uploadedAt);
  if (at === null) return { error: 'uploadedAt が実在する日時の ISO 8601（タイムゾーン付き）ではありません' };
  if (at > now + SKEW_MS) return { error: 'uploadedAt が未来です（時計ずれの許容 5 分を超過）' };
  if (at < snapshotAt - SKEW_MS) return { error: 'uploadedAt が dump 名の snapshot 時刻より前です（記録と世代が矛盾）' };
  return { at };
}

/**
 * dump の完成を示す manifest を検証する。無ければ「未完成」（errors ではない）。
 * あるのに通常ファイルでない（symlink 等）・lstat できない・空・読めない場合は検証不能。
 */
function checkManifest(dir, manifestName, nameSet) {
  if (!nameSet.has(manifestName)) return { missing: true };
  let stat;
  try {
    stat = lstatSync(join(dir, manifestName));
  } catch {
    return { error: 'manifest の状態を取得できません' };
  }
  if (!stat.isFile()) return { error: 'manifest が通常ファイルではありません（シンボリックリンク等は不可）' };
  if (stat.size <= 0) return { error: 'manifest が空です' };
  if (!canOpenForRead(join(dir, manifestName))) return { error: 'manifest を読めません' };
  return { ok: true };
}

/**
 * 保存先を走査する。
 * @returns {{ fatal: string } | { dumps, records, errors, ignoredDumps, dumpsWithoutManifest }}
 *   dumps / records: { name, at, snapshotAt } を at の昇順で
 */
export function scanBackupDir(dir, now) {
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    return { fatal: '保存先がありません（または状態を取得できません）' };
  }
  if (!dirStat.isDirectory()) return { fatal: '保存先がディレクトリではありません（シンボリックリンクは追跡しない）' };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { fatal: '保存先を読めません' };
  }
  const nameSet = new Set(names);
  const dumps = [];
  const records = [];
  const errors = [];
  let ignoredDumps = 0;
  let dumpsWithoutManifest = 0;
  const fail = (name, reason) => errors.push({ file: safeName(name), reason });

  for (const name of names) {
    const isRecord = name.endsWith('.dump.r2.json');
    const isDump = !isRecord && name.endsWith('.dump');
    if (!isRecord && !isDump) continue;
    const dumpName = isRecord ? name.slice(0, -'.r2.json'.length) : name;
    const snapshot = snapshotTimeOf(dumpName);
    if (!snapshot.matched) {
      // 手動の dump など backup.sh の命名でないものは数に入れない（件数だけ出す）。送信記録は命名外なら検証不能
      if (isDump) ignoredDumps += 1;
      else fail(name, '送信記録の名前が backup.sh の命名と一致しません');
      continue;
    }
    if (snapshot.at === null) {
      fail(name, '名前の snapshot 時刻が実在する日時ではありません');
      continue;
    }
    let stat;
    try {
      stat = lstatSync(join(dir, name));
    } catch {
      fail(name, '状態を取得できません');
      continue;
    }
    if (!stat.isFile()) {
      fail(name, '通常ファイルではありません（シンボリックリンク等は不可）');
      continue;
    }

    if (isRecord) {
      const record = readOffsiteRecord(join(dir, name), stat, snapshot.at, now);
      if (record.error) fail(name, record.error);
      else records.push({ name: dumpName, at: record.at, snapshotAt: snapshot.at });
      continue;
    }

    if (stat.mtimeMs > now + SKEW_MS) {
      fail(name, 'dump の更新時刻が未来です（時計ずれの許容 5 分を超過）');
      continue;
    }
    if (stat.mtimeMs < snapshot.at - SKEW_MS) {
      fail(name, 'dump の更新時刻が名前の snapshot 時刻より前です（世代と矛盾）');
      continue;
    }
    // backup.sh は manifest → dump の順に置く。manifest の無い dump は完成した世代として数えない
    const manifest = checkManifest(dir, `${dumpName.slice(0, -'.dump'.length)}.manifest.tsv`, nameSet);
    if (manifest.missing) {
      dumpsWithoutManifest += 1;
      continue;
    }
    if (manifest.error) {
      fail(name, manifest.error);
      continue;
    }
    dumps.push({ name: dumpName, at: stat.mtimeMs, snapshotAt: snapshot.at });
  }
  dumps.sort((a, b) => a.at - b.at);
  records.sort((a, b) => a.at - b.at);
  return { dumps, records, errors, ignoredDumps, dumpsWithoutManifest };
}

/**
 * healthcheck の状態ファイルから決めた項目だけを読む（失敗理由の本文は読まない・出さない）。判定には使わない。
 * パスは返さない（出力では HEALTH_STATE と表記する）。
 */
export function readHealthState(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { available: false, reason: 'ありません（または状態を取得できません）' };
  }
  if (!stat.isFile()) return { available: false, reason: '通常ファイルではありません（シンボリックリンク等は不可）' };
  if (stat.size <= 0 || stat.size > JSON_MAX_BYTES) return { available: false, reason: 'サイズが想定外です' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { available: false, reason: '読めない、または JSON として解釈できません' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { available: false, reason: 'JSON オブジェクトではありません' };
  }
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const time = (value) => {
    const at = parseStrictIso(value);
    return at === null ? null : iso(at);
  };
  return {
    available: true,
    checkedAt: time(parsed.checkedAt),
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    consecutiveFailures: count(parsed.consecutiveFailures),
    totalFailures: count(parsed.totalFailures),
    lastFailureAt: time(parsed.lastFailureAt),
    recoveredAt: time(parsed.recoveredAt),
  };
}
