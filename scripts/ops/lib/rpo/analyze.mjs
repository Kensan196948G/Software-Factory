/**
 * rpo-report の集計と判定（純粋関数。ファイルに触れない）。
 *
 * 判定の優先順位:
 *   1. 検証不能（errors あり／保存先の致命的エラー）→ 'unverifiable'（終了コード 2）
 *      検証できない記録が間隔を埋める可能性があるため、閾値超があっても「超過」とは断定しない。
 *   2. 閾値超（閉じた間隔、または until 時点の未完了の間隔）が 1 件でもある → 'gap'（1）
 *      時刻が 1 点しかない系列でも、その時刻から until までが閾値超なら gap（データ不足より優先）。
 *   3. どちらかの系列で判定に使える時刻が 2 つ未満 → 'insufficient'（2）
 *   4. それ以外 → 'ok'（0）
 * 比較はすべてミリ秒（丸めは表示だけ）。
 */
import { MAX_LISTED_GAPS, clock, iso, minutes, safeName } from './common.mjs';

function percentileMs(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank))];
}

/**
 * 1 系列（ローカル dump か R2 送信記録）の間隔を評価する。
 * 閉じた間隔: 期間内の連続する時刻どうし＋開始をまたぐ間隔（開始前の最後の時刻 → 期間内の最初）。
 * 未完了の間隔: 判定に使う最新の時刻 → until。
 */
export function analyzeSeries(events, start, until, thresholdMs) {
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
    sufficient: points.length >= 2,
  };
}

/** until 時点で最新の R2 送信成功記録（R2 上の実体の存在・復元可否は確認していない）。 */
function latestOffsiteRecorded(records, until) {
  const candidates = records.filter((record) => record.at <= until);
  const latest = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  if (!latest) return null;
  return {
    name: safeName(latest.name),
    snapshotAt: iso(latest.snapshotAt),
    uploadedAt: iso(latest.at),
    minutesSinceSnapshot: minutes(Math.max(0, until - latest.snapshotAt)),
    minutesSinceUpload: minutes(Math.max(0, until - latest.at)),
  };
}

/**
 * スキャン結果から判定つきのレポート本体を作る。
 * @param scan scanBackupDir の戻り値
 * @param window { start, until, thresholdMs }
 */
export function evaluate(scan, { start, until, thresholdMs }) {
  if (scan.fatal) {
    return {
      verdict: 'unverifiable',
      reasons: [scan.fatal],
      errors: [],
      counts: null,
      local: null,
      offsite: null,
      latestOffsiteRecorded: null,
    };
  }
  const local = analyzeSeries(scan.dumps, start, until, thresholdMs);
  const offsite = analyzeSeries(scan.records, start, until, thresholdMs);
  const result = {
    verdict: 'ok',
    reasons: [],
    errors: scan.errors,
    counts: {
      dumps: scan.dumps.length,
      dumpsWithoutManifest: scan.dumpsWithoutManifest,
      ignoredDumps: scan.ignoredDumps,
      offsiteRecords: scan.records.length,
    },
    local,
    offsite,
    latestOffsiteRecorded: latestOffsiteRecorded(scan.records, until),
  };

  if (scan.errors.length > 0) {
    result.verdict = 'unverifiable';
    result.reasons.push(`検証できない記録・ファイルがあります（${scan.errors.length} 件）。黙って除外せず検証不能とします`);
    return result;
  }
  const over = local.overThresholdCount + offsite.overThresholdCount;
  if (over > 0) {
    result.verdict = 'gap';
    result.reasons.push(`閾値 ${thresholdMs / 60_000} 分を超える間隔が ${over} 件あります（未完了の間隔を含む）`);
  }
  if (!local.sufficient) result.reasons.push('ローカル dump の時刻が 2 つ未満です（データ不足）');
  if (!offsite.sufficient) result.reasons.push('R2 送信記録の時刻が 2 つ未満です（データ不足）');
  if (result.verdict === 'ok' && (!local.sufficient || !offsite.sufficient)) result.verdict = 'insufficient';
  return result;
}

export function exitCodeOf(verdict) {
  if (verdict === 'ok') return 0;
  if (verdict === 'gap') return 1;
  return 2;
}
