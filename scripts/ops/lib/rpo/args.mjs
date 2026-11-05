/**
 * rpo-report の入力解析。値の検証だけを行い、ファイルには触れない。
 * エラー文言には指定値を含めない（オプション名と期待する形だけ）。
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { MAX_DAYS, MINUTE_MS, parseStrictIso } from './common.mjs';

export const USAGE = `使い方: node scripts/ops/rpo-report.mjs [--dir DIR] [--since ISO | --days N] [--until ISO] [--rpo-min N] [--health-state FILE] [--json]
  --dir           バックアップ保存先（既定 ~/.local/state/mirai-sf-prod/backups。出力では BACKUP_DIR と表記）
  --since         期間の開始（ISO 8601。タイムゾーン必須。例 2026-11-03T09:00:00Z）。--days と同時指定不可
  --days          期間の開始を「--until の N 日前」にする（既定 7、1〜${MAX_DAYS}）
  --until         期間の終わり（ISO 8601。既定は実行時刻。実行時刻より未来は不可）
  --rpo-min       閾値（分、既定 60）
  --health-state  healthcheck の状態ファイル（既定 ~/.local/state/mirai-sf-prod/healthcheck.json。出力では HEALTH_STATE と表記）
  --json          JSON だけを出す
終了コード: 0=閾値超なし / 1=閾値超あり / 2=データ不足・検証不能 / 3=引数不正`;

const VALUE_OPTIONS = new Set(['--dir', '--since', '--days', '--until', '--rpo-min', '--health-state']);

/**
 * @returns {{ help: true } | { error: string } | { options: object }}
 * options: dir / healthState（絶対パス）、dirSource / healthStateSource（'default' | 'argument'）、
 *          start / until（ミリ秒）、windowSource（'since' | 'days'）、rpoMin、json
 */
export function parseArgs(argv, now) {
  const raw = { dir: null, healthState: null, since: null, days: null, until: null, rpoMin: 60, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      raw.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!VALUE_OPTIONS.has(arg)) return { error: '不明なオプションがあります（値は出しません）' };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} に値がありません` };
    index += 1;
    switch (arg) {
      case '--dir':
        raw.dir = resolve(value);
        break;
      case '--health-state':
        raw.healthState = resolve(value);
        break;
      case '--since':
      case '--until': {
        const at = parseStrictIso(value);
        if (at === null) return { error: `${arg} は実在する日時の ISO 8601（タイムゾーン付き）で指定してください` };
        raw[arg === '--since' ? 'since' : 'until'] = at;
        break;
      }
      case '--days':
        if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_DAYS) {
          return { error: `--days は 1〜${MAX_DAYS} の整数で指定してください` };
        }
        raw.days = Number(value);
        break;
      case '--rpo-min':
        if (!/^[1-9][0-9]{0,4}$/.test(value)) return { error: '--rpo-min は正の整数（分）で指定してください' };
        raw.rpoMin = Number(value);
        break;
    }
  }
  if (raw.since !== null && raw.days !== null) return { error: '--since と --days は同時に指定できません' };
  const until = raw.until ?? now;
  if (until > now) return { error: '--until が実行時刻より未来です' };
  const start = raw.since ?? until - (raw.days ?? 7) * 24 * 60 * MINUTE_MS;
  if (start >= until) return { error: '期間の開始が終わり以降です' };
  return {
    options: {
      dir: raw.dir ?? resolve(homedir(), '.local/state/mirai-sf-prod/backups'),
      dirSource: raw.dir === null ? 'default' : 'argument',
      healthState: raw.healthState ?? resolve(homedir(), '.local/state/mirai-sf-prod/healthcheck.json'),
      healthStateSource: raw.healthState === null ? 'default' : 'argument',
      start,
      until,
      windowSource: raw.since !== null ? 'since' : 'days',
      rpoMin: raw.rpoMin,
      json: raw.json,
    },
  };
}
