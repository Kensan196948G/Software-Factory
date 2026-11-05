#!/usr/bin/env node
/**
 * RPO の実測レポート（読取り専用・依存なし）。
 *
 * 目的: 「RPO 60 分」を timer の設定値ではなく、残っているバックアップの実績から評価する。
 * これは**実測**であって RPO の保証ではない（docs/production/07-slo-and-measurement.md §3-7）。
 *
 * 何を見るか（--dir のバックアップ保存先だけ。DB・R2・systemd には触れない）:
 *   (a) ローカル dump 間隔: `<name>-YYYYMMDDTHHMMSSZ.dump` で同名の `.manifest.tsv` があるもの（完成した世代）の
 *       完成時刻（dump の mtime）の間隔。最大・p95・閾値超の回数と区間。
 *   (b) R2 送信記録の間隔: `<dump>.r2.json` の uploadedAt（offsite-r2.mjs が送信と読み戻し検証の成功後に書く）の間隔。
 *       最大・p95・閾値超の区間。
 *   (c) 現時点（--until。既定は実行時刻）で最新の「復元可能（R2 記録あり）」snapshot からの経過。
 *   (d) healthcheck の状態ファイルの totalFailures / consecutiveFailures / lastFailureAt（補足。判定には使わない）。
 *
 * 期間: 既定は直近 7 日（--days）。--since で開始を指定できる（オフサイト設定前など対象外の期間を除くため）。
 *   - 期間内の時刻どうしの間隔に加え、期間の開始をまたぐ間隔（開始前の最後の時刻 → 期間内の最初の時刻）も数える。
 *   - 期間の終わり（--until）時点で最新の時刻からの経過（未完了の間隔）も閾値と比べる（(c) と同じ考え方）。
 *   - 開始前に時刻が 1 つも無い場合、開始から最初の時刻までは「不明」として leadingMinutes に出すだけで判定に使わない。
 *
 * fail-closed（検証できないものを黙って成功にしない）。次はすべて「検証不能」として終了コード 2:
 *   - 記録名に一致するエントリが通常ファイルでない（シンボリックリンクは追跡しない）・lstat できない
 *   - 送信記録が読めない・壊れた JSON・JSON オブジェクトでない・サイズ 0 または 64KiB 超・uploadedAt が無い／解釈できない
 *   - 時刻（dump の mtime / uploadedAt）が実行時刻より 5 分（時計ずれの許容）を超えて未来
 *   - dump の mtime・uploadedAt が dump 名の snapshot 時刻より 5 分を超えて前（記録と世代が矛盾）
 *   - 保存先が無い・ディレクトリでない・読めない
 *
 * 比較はすべてミリ秒で行う（60 分 0 秒は閾値内、60 分 1 秒は超過）。分への丸めは表示だけ。
 *
 * 出力しないもの: 送信記録の中身（bucket / key / sha256）、healthcheck の失敗理由の本文、例外の文言。
 * ファイル名は形を検証してから出す。保存先はホームを ~ に縮めて出す。
 *
 * 使い方:
 *   node scripts/ops/rpo-report.mjs [--dir DIR] [--since ISO | --days N] [--until ISO] [--rpo-min N]
 *                                   [--health-state FILE] [--json]
 *   既定: --dir ~/.local/state/mirai-sf-prod/backups --days 7 --rpo-min 60
 *         --health-state ~/.local/state/mirai-sf-prod/healthcheck.json
 *
 * 終了コード:
 *   0 = 期間内にローカル・R2 とも閾値超の間隔なし（未完了の間隔を含む）
 *   1 = 閾値超の間隔あり
 *   2 = データ不足（どちらかの系列で判定に使える時刻が 2 つ未満）または検証不能（上の fail-closed）
 *   3 = 引数不正
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MINUTE_MS = 60_000;
const FUTURE_SKEW_MS = 5 * MINUTE_MS;
const RECORD_MAX_BYTES = 64 * 1024;
const MAX_DAYS = 90;
const MAX_LISTED_GAPS = 50;
const DUMP_PATTERN = /^([A-Za-z0-9_]{1,64})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const EXIT_OK = 0;
const EXIT_GAP = 1;
const EXIT_INSUFFICIENT = 2;
const EXIT_USAGE = 3;

const USAGE = `使い方: node scripts/ops/rpo-report.mjs [--dir DIR] [--since ISO | --days N] [--until ISO] [--rpo-min N] [--health-state FILE] [--json]
  --dir           バックアップ保存先（既定 ~/.local/state/mirai-sf-prod/backups）
  --since         期間の開始（ISO 8601。タイムゾーン必須。例 2026-11-03T09:00:00Z）。--days と同時指定不可
  --days          期間の開始を「--until の N 日前」にする（既定 7、1〜${MAX_DAYS}）
  --until         期間の終わり（ISO 8601。既定は実行時刻。実行時刻より未来は不可）
  --rpo-min       閾値（分、既定 60）
  --health-state  healthcheck の状態ファイル（既定 ~/.local/state/mirai-sf-prod/healthcheck.json）
  --json          JSON だけを出す
終了コード: 0=閾値超なし / 1=閾値超あり / 2=データ不足・検証不能 / 3=引数不正`;

function shortenPath(path) {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function safeName(name) {
  return SAFE_NAME_PATTERN.test(name) ? name : '(想定外の名前)';
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function minutes(ms) {
  return Math.round((ms / MINUTE_MS) * 10) / 10;
}

/** 表示用の「分:秒.ミリ秒」（例 60:00.097）。閾値超の判定はミリ秒で行うので、表示もミリ秒まで出す。 */
function clock(ms) {
  const total = Math.floor(Math.max(0, ms));
  const totalSeconds = Math.floor(total / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${Math.floor(totalSeconds / 60)}:${seconds}.${String(total % 1000).padStart(3, '0')}`;
}

function parseIso(value) {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function parseArgs(argv) {
  const options = {
    dir: resolve(homedir(), '.local/state/mirai-sf-prod/backups'),
    since: null,
    days: null,
    until: null,
    rpoMin: 60,
    healthState: resolve(homedir(), '.local/state/mirai-sf-prod/healthcheck.json'),
    json: false,
  };
  const takesValue = new Set(['--dir', '--since', '--days', '--until', '--rpo-min', '--health-state']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!takesValue.has(arg)) return { error: '不明なオプションがあります（値は出しません）' };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} に値がありません` };
    index += 1;
    if (arg === '--dir') options.dir = resolve(value);
    else if (arg === '--health-state') options.healthState = resolve(value);
    else if (arg === '--since' || arg === '--until') {
      const at = parseIso(value);
      if (at === null) return { error: `${arg} は ISO 8601（タイムゾーン付き）で指定してください` };
      options[arg === '--since' ? 'since' : 'until'] = at;
    } else if (arg === '--days') {
      if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_DAYS) {
        return { error: `--days は 1〜${MAX_DAYS} の整数で指定してください` };
      }
      options.days = Number(value);
    } else if (arg === '--rpo-min') {
      if (!/^[1-9][0-9]{0,4}$/.test(value)) return { error: '--rpo-min は正の整数（分）で指定してください' };
      options.rpoMin = Number(value);
    }
  }
  if (options.since !== null && options.days !== null) return { error: '--since と --days は同時に指定できません' };
  return { options };
}

/** dump 名の snapshot 時刻（UTC）。 */
function stampOf(matched) {
  const [, , year, month, day, hour, minute, second] = matched;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(at) ? at : null;
}

/** 送信記録 1 件を検証して uploadedAt を返す。中身（bucket / key / sha256）は返さない。 */
function readRecord(path, stat, snapshotAt, now) {
  if (stat.size <= 0 || stat.size > RECORD_MAX_BYTES) {
    return { error: `サイズが想定外です（0 バイト、または ${RECORD_MAX_BYTES} バイト超）` };
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
  const at = typeof parsed.uploadedAt === 'string' ? Date.parse(parsed.uploadedAt) : Number.NaN;
  if (!Number.isFinite(at)) return { error: 'uploadedAt を時刻として解釈できません' };
  if (at > now + FUTURE_SKEW_MS) return { error: 'uploadedAt が未来です（時計ずれの許容 5 分を超過）' };
  if (snapshotAt !== null && at < snapshotAt - FUTURE_SKEW_MS) {
    return { error: 'uploadedAt が dump 名の snapshot 時刻より前です（記録と世代が矛盾）' };
  }
  return { at };
}

/** 保存先を走査する。検証できないものは errors に入れる（黙って捨てない）。 */
function scanBackupDir(dir, now) {
  const errors = [];
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
  let ignoredDumps = 0;
  let dumpsWithoutManifest = 0;
  for (const name of names) {
    const isRecord = name.endsWith('.dump.r2.json');
    const isDump = name.endsWith('.dump');
    if (!isRecord && !isDump) continue;
    const dumpName = isRecord ? name.slice(0, -'.r2.json'.length) : name;
    const matched = DUMP_PATTERN.exec(dumpName);
    if (!matched) {
      // 手動の dump など、backup.sh の命名でないものは数に入れない（件数だけ出す）
      if (isDump) ignoredDumps += 1;
      else errors.push({ file: safeName(name), reason: '送信記録の名前が backup.sh の命名と一致しません' });
      continue;
    }
    const snapshotAt = stampOf(matched);
    let stat;
    try {
      stat = lstatSync(join(dir, name));
    } catch {
      errors.push({ file: safeName(name), reason: '状態を取得できません' });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ file: safeName(name), reason: '通常ファイルではありません（シンボリックリンク等は不可）' });
      continue;
    }
    if (isDump) {
      if (stat.mtimeMs > now + FUTURE_SKEW_MS) {
        errors.push({ file: safeName(name), reason: 'dump の更新時刻が未来です（時計ずれの許容 5 分を超過）' });
        continue;
      }
      if (snapshotAt !== null && stat.mtimeMs < snapshotAt - FUTURE_SKEW_MS) {
        errors.push({ file: safeName(name), reason: 'dump の更新時刻が名前の snapshot 時刻より前です（世代と矛盾）' });
        continue;
      }
      const manifest = `${dumpName.slice(0, -'.dump'.length)}.manifest.tsv`;
      if (!nameSet.has(manifest)) {
        // backup.sh は manifest → dump の順に置く。manifest の無い dump は完成した世代として数えない
        dumpsWithoutManifest += 1;
        continue;
      }
      dumps.push({ name: dumpName, at: stat.mtimeMs, snapshotAt });
    } else {
      const record = readRecord(join(dir, name), stat, snapshotAt, now);
      if (record.error) {
        errors.push({ file: safeName(name), reason: record.error });
        continue;
      }
      records.push({ name: dumpName, at: record.at, snapshotAt });
    }
  }
  dumps.sort((a, b) => a.at - b.at);
  records.sort((a, b) => a.at - b.at);
  return { dumps, records, errors, ignoredDumps, dumpsWithoutManifest };
}

function percentileMs(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank))];
}

/**
 * 1 系列（ローカル dump か R2 送信記録）の間隔を評価する。
 * 閉じた間隔: 期間内の連続する時刻どうし＋開始をまたぐ間隔。未完了の間隔: 最新の時刻 → until。
 */
function analyzeSeries(events, start, until, thresholdMs) {
  const before = events.filter((event) => event.at < start);
  const inWindow = events.filter((event) => event.at >= start && event.at <= until);
  const anchor = before.length > 0 ? before[before.length - 1] : null;
  const points = anchor ? [anchor, ...inWindow] : inWindow;

  const gaps = [];
  for (let index = 1; index < points.length; index += 1) {
    gaps.push({
      fromMs: points[index - 1].at,
      toMs: points[index].at,
      ms: points[index].at - points[index - 1].at,
      crossesStart: points[index - 1].at < start,
    });
  }
  const sortedMs = gaps.map((gap) => gap.ms).sort((a, b) => a - b);
  const maxGap = gaps.reduce((worst, gap) => (worst === null || gap.ms > worst.ms ? gap : worst), null);
  const over = gaps.filter((gap) => gap.ms > thresholdMs);
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const openMs = latest ? until - latest.at : null;
  const openOver = openMs !== null && openMs > thresholdMs;

  return {
    countInWindow: inWindow.length,
    hasAnchorBeforeStart: anchor !== null,
    leadingMinutes: anchor === null && inWindow.length > 0 ? minutes(inWindow[0].at - start) : null,
    intervals: gaps.length,
    maxGapMinutes: maxGap ? minutes(maxGap.ms) : null,
    maxGapClock: maxGap ? clock(maxGap.ms) : null,
    maxGapFrom: maxGap ? iso(maxGap.fromMs) : null,
    maxGapTo: maxGap ? iso(maxGap.toMs) : null,
    p95GapMinutes: sortedMs.length > 0 ? minutes(percentileMs(sortedMs, 95)) : null,
    overThresholdCount: over.length + (openOver ? 1 : 0),
    overThreshold: over.slice(0, MAX_LISTED_GAPS).map((gap) => ({
      from: iso(gap.fromMs),
      to: iso(gap.toMs),
      minutes: minutes(gap.ms),
      clock: clock(gap.ms),
      crossesStart: gap.crossesStart,
    })),
    overThresholdTruncated: over.length > MAX_LISTED_GAPS,
    latestAt: latest ? iso(latest.at) : null,
    latestName: latest ? safeName(latest.name) : null,
    openGapMinutes: openMs === null ? null : minutes(Math.max(0, openMs)),
    openGapClock: openMs === null ? null : clock(openMs),
    openGapOverThreshold: openOver,
    // 判定に使える時刻（期間内＋開始前の最後）が 2 つ未満ならデータ不足
    sufficient: points.length >= 2,
  };
}

/** healthcheck の状態ファイルから、決めた項目だけを読む（失敗理由の本文は出さない）。判定には使わない。 */
function readHealthState(path) {
  const where = shortenPath(path);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { available: false, file: where, reason: 'ありません（または状態を取得できません）' };
  }
  if (!stat.isFile()) return { available: false, file: where, reason: '通常ファイルではありません' };
  if (stat.size <= 0 || stat.size > RECORD_MAX_BYTES) return { available: false, file: where, reason: 'サイズが想定外です' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { available: false, file: where, reason: '読めない、または JSON として解釈できません' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { available: false, file: where, reason: 'JSON オブジェクトではありません' };
  }
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const time = (value) => {
    const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? iso(at) : null;
  };
  return {
    available: true,
    file: where,
    checkedAt: time(parsed.checkedAt),
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    consecutiveFailures: count(parsed.consecutiveFailures),
    totalFailures: count(parsed.totalFailures),
    lastFailureAt: time(parsed.lastFailureAt),
    recoveredAt: time(parsed.recoveredAt),
  };
}

function buildReport(options, now) {
  const until = options.until ?? now;
  const start = options.since ?? until - (options.days ?? 7) * 24 * 60 * MINUTE_MS;
  const thresholdMs = options.rpoMin * MINUTE_MS;
  const report = {
    version: 1,
    tool: 'rpo-report',
    generatedAt: iso(now),
    note: '実測であって RPO の保証ではない。ホスト停止中・保存先から消えた世代は計測できない',
    dir: shortenPath(options.dir),
    window: { start: iso(start), until: iso(until), source: options.since !== null ? 'since' : 'days' },
    thresholdMinutes: options.rpoMin,
    verdict: 'insufficient',
    reasons: [],
    errors: [],
    local: null,
    offsite: null,
    restorable: null,
    counts: null,
    healthcheck: readHealthState(options.healthState),
  };

  if (until > now) {
    report.reasons.push('--until が実行時刻より未来です');
    return report;
  }
  if (start >= until) {
    report.reasons.push('期間の開始が終わり以降です');
    return report;
  }

  const scan = scanBackupDir(options.dir, now);
  if (scan.fatal) {
    report.reasons.push(scan.fatal);
    return report;
  }
  report.errors = scan.errors;
  report.counts = {
    dumps: scan.dumps.length,
    dumpsWithoutManifest: scan.dumpsWithoutManifest,
    ignoredDumps: scan.ignoredDumps,
    offsiteRecords: scan.records.length,
  };
  report.local = analyzeSeries(scan.dumps, start, until, thresholdMs);
  report.offsite = analyzeSeries(scan.records, start, until, thresholdMs);

  // (c) until 時点で最新の「復元可能（R2 記録あり）」snapshot
  const restorable = scan.records.filter((record) => record.at <= until);
  const latest = restorable.length > 0 ? restorable[restorable.length - 1] : null;
  report.restorable = latest
    ? {
        name: safeName(latest.name),
        snapshotAt: latest.snapshotAt === null ? null : iso(latest.snapshotAt),
        uploadedAt: iso(latest.at),
        // 復元できる内容は snapshot 時点のもの。経過は snapshot 時刻と送信完了時刻の両方から出す
        minutesSinceSnapshot: latest.snapshotAt === null ? null : minutes(Math.max(0, until - latest.snapshotAt)),
        minutesSinceUpload: minutes(Math.max(0, until - latest.at)),
      }
    : null;

  if (scan.errors.length > 0) {
    report.reasons.push(`検証できない記録・ファイルがあります（${scan.errors.length} 件）。黙って除外せず検証不能とします`);
    return report;
  }
  if (!report.local.sufficient) report.reasons.push('ローカル dump の時刻が 2 つ未満です（データ不足）');
  if (!report.offsite.sufficient) report.reasons.push('R2 送信記録の時刻が 2 つ未満です（データ不足）');
  if (report.reasons.length > 0) return report;

  const over = report.local.overThresholdCount + report.offsite.overThresholdCount;
  if (over > 0) {
    report.verdict = 'gap';
    report.reasons.push(`閾値 ${options.rpoMin} 分を超える間隔が ${over} 件あります（未完了の間隔を含む）`);
  } else {
    report.verdict = 'ok';
  }
  return report;
}

function exitCodeOf(report) {
  if (report.verdict === 'ok') return EXIT_OK;
  if (report.verdict === 'gap') return EXIT_GAP;
  return EXIT_INSUFFICIENT;
}

function show(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function printSeries(label, series, thresholdMinutes) {
  console.log(`\n## ${label}`);
  if (!series) {
    console.log('（集計なし）');
    return;
  }
  console.log(`期間内の件数        : ${series.countInWindow}（開始前の基点 ${series.hasAnchorBeforeStart ? 'あり' : 'なし'}）`);
  if (series.leadingMinutes !== null) console.log(`開始→最初（判定外） : ${series.leadingMinutes} 分`);
  console.log(`間隔の数            : ${series.intervals}`);
  console.log(
    `最大間隔            : ${show(series.maxGapMinutes)} 分 = ${show(series.maxGapClock)}（${show(series.maxGapFrom)} → ${show(series.maxGapTo)}）`,
  );
  console.log(`p95 間隔            : ${show(series.p95GapMinutes)} 分`);
  console.log(`最新                : ${show(series.latestAt)}（${show(series.latestName)}）`);
  console.log(
    `最新からの経過      : ${show(series.openGapMinutes)} 分 = ${show(series.openGapClock)}${series.openGapOverThreshold ? `（${thresholdMinutes} 分超）` : ''}`,
  );
  console.log(`${thresholdMinutes} 分超の間隔        : ${series.overThresholdCount} 件（未完了の間隔を含む）`);
  for (const gap of series.overThreshold) {
    console.log(`  - ${gap.from} → ${gap.to}  ${gap.clock}（${gap.minutes} 分）${gap.crossesStart ? '（開始をまたぐ）' : ''}`);
  }
  if (series.overThresholdTruncated) console.log(`  …（先頭 ${MAX_LISTED_GAPS} 件のみ表示）`);
}

function printText(report) {
  console.log('# RPO 実測レポート（読取り専用。RPO の保証ではない）');
  console.log(`生成       : ${report.generatedAt}`);
  console.log(`保存先     : ${report.dir}`);
  console.log(`期間       : ${report.window.start} → ${report.window.until}（${report.window.source}）`);
  console.log(`閾値       : ${report.thresholdMinutes} 分`);
  console.log(`判定       : ${report.verdict}（終了コード ${exitCodeOf(report)}）`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  if (report.counts) {
    const c = report.counts;
    console.log(
      `件数       : dump ${c.dumps}（manifest 無し ${c.dumpsWithoutManifest}・命名外 ${c.ignoredDumps}）/ R2 送信記録 ${c.offsiteRecords}`,
    );
  }
  if (report.errors.length > 0) {
    console.log('\n## 検証できないもの');
    for (const error of report.errors) console.log(`  - ${error.file}: ${error.reason}`);
  }
  printSeries('(a) ローカル dump の間隔（manifest のある世代の完成時刻）', report.local, report.thresholdMinutes);
  printSeries('(b) R2 送信記録の間隔（uploadedAt）', report.offsite, report.thresholdMinutes);
  console.log('\n## (c) 最新の復元可能（R2 記録あり）snapshot');
  if (report.restorable) {
    const r = report.restorable;
    console.log(
      `  ${r.name}: snapshot ${show(r.snapshotAt)}（${show(r.minutesSinceSnapshot)} 分前）/ 送信 ${r.uploadedAt}（${r.minutesSinceUpload} 分前）`,
    );
  } else {
    console.log('  なし');
  }
  console.log('\n## (d) healthcheck の状態（補足。判定には使わない）');
  const h = report.healthcheck;
  if (h.available) {
    console.log(
      `  ${h.file}: ok=${show(h.ok)} totalFailures=${show(h.totalFailures)} consecutiveFailures=${show(h.consecutiveFailures)} lastFailureAt=${show(h.lastFailureAt)} checkedAt=${show(h.checkedAt)}`,
    );
  } else {
    console.log(`  ${h.file}: 読めません（${h.reason}）`);
  }
  console.log(`\n注記: ${report.note}`);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (parsed.error) {
    console.error(`rpo-report: ${parsed.error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const report = buildReport(parsed.options, Date.now());
  if (parsed.options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  return exitCodeOf(report);
}

process.exitCode = main();
