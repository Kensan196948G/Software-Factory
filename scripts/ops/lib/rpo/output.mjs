/**
 * rpo-report の出力（表形式）。JSON はレポート本体をそのまま出す。
 * パスは出さない（BACKUP_DIR / HEALTH_STATE の固定表現）。
 */
import { MAX_LISTED_GAPS } from './common.mjs';
import { exitCodeOf } from './analyze.mjs';

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

export function printText(report) {
  console.log('# RPO 実測レポート（読取り専用。RPO の保証ではない）');
  console.log(`生成       : ${report.generatedAt}`);
  console.log(`保存先     : ${report.backupDir.label}（${report.backupDir.source === 'default' ? '既定' : '--dir 指定'}）`);
  console.log(`期間       : ${report.window.start} → ${report.window.until}（${report.window.source}）`);
  console.log(`閾値       : ${report.thresholdMinutes} 分`);
  console.log(`判定       : ${report.verdict}（終了コード ${exitCodeOf(report.verdict)}）`);
  for (const reason of report.reasons) console.log(`  - ${reason}`);
  if (report.counts) {
    const c = report.counts;
    console.log(
      `件数       : dump ${c.dumps}（manifest 無し ${c.dumpsWithoutManifest}・命名外 ${c.ignoredDumps}）/ R2 送信成功記録 ${c.offsiteRecords}`,
    );
  }
  if (report.errors.length > 0) {
    console.log('\n## 検証できないもの');
    for (const error of report.errors) console.log(`  - ${error.file}: ${error.reason}`);
  }
  printSeries('(a) ローカル dump の間隔（manifest のある世代の完成時刻）', report.local, report.thresholdMinutes);
  printSeries('(b) R2 送信成功記録の間隔（uploadedAt）', report.offsite, report.thresholdMinutes);
  console.log('\n## (c) 最新の R2 送信成功記録あり snapshot（R2 実体の存在・復元可否は未確認）');
  const r = report.latestOffsiteRecorded;
  if (r) {
    console.log(
      `  ${r.name}: snapshot ${r.snapshotAt}（${show(r.minutesSinceSnapshot)} 分前）/ 送信 ${r.uploadedAt}（${r.minutesSinceUpload} 分前）`,
    );
  } else {
    console.log('  なし');
  }
  console.log('\n## (d) healthcheck の状態（補足。判定には使わない）');
  const h = report.healthcheck;
  if (h.available) {
    console.log(
      `  ${h.label}: ok=${show(h.ok)} totalFailures=${show(h.totalFailures)} consecutiveFailures=${show(h.consecutiveFailures)} lastFailureAt=${show(h.lastFailureAt)} checkedAt=${show(h.checkedAt)}`,
    );
  } else {
    console.log(`  ${h.label}: 読めません（${h.reason}）`);
  }
  console.log(`\n注記: ${report.note}`);
}
