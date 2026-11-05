#!/usr/bin/env node
/**
 * RPO の実測レポート（読取り専用・依存なし）。
 *
 * 目的: 「RPO 60 分」を timer の設定値ではなく、残っているバックアップの実績から評価する。
 * これは**実測**であって RPO の保証ではない（docs/production/07-slo-and-measurement.md §3-7）。
 *
 * 何を見るか（--dir のバックアップ保存先だけ。DB・R2・systemd には触れない）:
 *   (a) ローカル dump 間隔: `<name>-YYYYMMDDTHHMMSSZ.dump` で同名の `.manifest.tsv`（通常ファイル・空でない・読める）が
 *       あるもの（完成した世代）の完成時刻（dump の mtime）の間隔。最大・p95・閾値超の回数と区間。
 *   (b) R2 送信成功記録の間隔: `<dump>.r2.json` の uploadedAt（offsite-r2.mjs が送信と読み戻し検証の成功後に書く）の間隔。
 *   (c) 期間の終わり（--until。既定は実行時刻）で最新の「R2 送信成功記録あり」snapshot からの経過。
 *       **R2 上の実体の存在・復元できるかは確認していない**（prod-offsite-drill の範囲）。
 *   (d) healthcheck の状態ファイルの totalFailures / consecutiveFailures / lastFailureAt（補足。判定には使わない）。
 *
 * 期間: 既定は直近 7 日（--days）。--since で開始を指定できる（オフサイト設定前など対象外の期間を除くため）。
 *   - 期間内の時刻どうしの間隔に加え、期間の開始をまたぐ間隔（開始前の最後の時刻 → 期間内の最初の時刻）も数える。
 *   - 期間の終わり時点で最新の時刻からの経過（未完了の間隔）も閾値と比べる。時刻が 1 点しかなくても、
 *     その経過が閾値を超えていれば「閾値超」（データ不足より優先）。
 *   - 開始前に時刻が 1 つも無い場合、開始から最初の時刻までは leadingMinutes に出すだけで判定に使わない。
 *
 * fail-closed（検証できないものを黙って成功にしない）。次はすべて「検証不能」として終了コード 2:
 *   - 記録名・dump 名・manifest 名に一致するエントリが通常ファイルでない（シンボリックリンクは追跡しない）・lstat できない
 *   - manifest が空・読めない
 *   - 送信記録が読めない・壊れた JSON・JSON オブジェクトでない・サイズ 0 または 64KiB 超・uploadedAt が無い
 *   - 時刻が実在しない（2026-02-31 など。Date.parse の正規化は使わず往復検証する）・タイムゾーンが無い
 *   - 時刻（dump の mtime / uploadedAt）が実行時刻より 5 分（時計ずれの許容）を超えて未来
 *   - dump の mtime・uploadedAt が dump 名の snapshot 時刻より 5 分を超えて前（記録と世代が矛盾）
 *   - 保存先が無い・ディレクトリでない・読めない
 *
 * 比較はすべてミリ秒で行う（60:00.000 は閾値内、60:00.001 以上は超過）。分への丸めは表示だけ。
 *
 * 出力しないもの: 送信記録の中身（bucket / key / sha256）、healthcheck の失敗理由の本文、例外の文言、
 * 保存先・状態ファイルのパス（BACKUP_DIR / HEALTH_STATE の固定表現で示す）、不正な引数の値。
 *
 * 構成（scripts/ops/lib/rpo/）: args.mjs（入力解析）/ scan.mjs（読取り）/ analyze.mjs（集計・判定）/
 *   output.mjs（表形式）/ common.mjs（定数・厳密な時刻解析・整形）。
 *
 * 使い方:
 *   node scripts/ops/rpo-report.mjs [--dir DIR] [--since ISO | --days N] [--until ISO] [--rpo-min N]
 *                                   [--health-state FILE] [--json]
 *
 * 終了コード:
 *   0 = 期間内にローカル・R2 とも閾値超の間隔なし（未完了の間隔を含む）
 *   1 = 閾値超の間隔あり
 *   2 = データ不足（どちらかの系列で判定に使える時刻が 2 つ未満）または検証不能（上の fail-closed）
 *   3 = 引数不正
 */
import { USAGE, parseArgs } from './lib/rpo/args.mjs';
import { evaluate, exitCodeOf } from './lib/rpo/analyze.mjs';
import { BACKUP_DIR_LABEL, HEALTH_STATE_LABEL, MINUTE_MS, iso } from './lib/rpo/common.mjs';
import { printText } from './lib/rpo/output.mjs';
import { readHealthState, scanBackupDir } from './lib/rpo/scan.mjs';

const EXIT_USAGE = 3;

function buildReport(options, now) {
  const scan = scanBackupDir(options.dir, now);
  const result = evaluate(scan, { start: options.start, until: options.until, thresholdMs: options.rpoMin * MINUTE_MS });
  return {
    version: 2,
    tool: 'rpo-report',
    generatedAt: iso(now),
    note: '実測であって RPO の保証ではない。R2 上の実体の存在・復元可否は確認していない。ホスト停止中・保存先から消えた世代は計測できない',
    backupDir: { label: BACKUP_DIR_LABEL, source: options.dirSource },
    window: { start: iso(options.start), until: iso(options.until), source: options.windowSource },
    thresholdMinutes: options.rpoMin,
    ...result,
    healthcheck: { label: HEALTH_STATE_LABEL, source: options.healthStateSource, ...readHealthState(options.healthState) },
  };
}

function main() {
  const now = Date.now();
  const parsed = parseArgs(process.argv.slice(2), now);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(`rpo-report: ${parsed.error}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const report = buildReport(parsed.options, now);
  if (parsed.options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  return exitCodeOf(report.verdict);
}

process.exitCode = main();
