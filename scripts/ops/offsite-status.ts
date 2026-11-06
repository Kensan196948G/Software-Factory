#!/usr/bin/env node
/**
 * 本番バックアップのオフサイト（R2）状態を読み取り専用で検証する。
 *
 * 背景: 2026-11-06 13:00 の本番バックアップで、ローカルの dump は成功したが R2 送信だけが
 * 失敗した（wrangler の一時的な認証エラー）。healthcheck は「最新のオフサイト記録の鮮度」
 * だけを見るため、どの世代が欠けたかは分からない。このツールは直近 N 世代を突き合わせ、
 * 世代ごとの欠落・サイズ/SHA-256 の不一致・鮮度を 1 コマンドで示す。
 *
 * 使い方:
 *   tsx scripts/ops/offsite-status.ts [--count 3] [--max-age-min 90] [--json]
 *
 * 終了コード: 0=すべて OK / 1=欠落・不一致・鮮度超過あり / 2=引数不正
 *
 * 秘密: 接続文字列・トークン・バケットの認証情報は読まない・出さない。出力は世代名・サイズ・
 * SHA-256 の先頭 12 桁・時刻だけ。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface OffsiteGeneration {
  /** dump のファイル名（拡張子なしのベース名）。 */
  name: string;
  dumpBytes: number | null;
  manifestBytes: number | null;
  dumpSha256: string | null;
  manifestSha256: string | null;
  r2: {
    present: boolean;
    uploadedAt: string | null;
    dumpSize: number | null;
    dumpSha256: string | null;
    manifestSize: number | null;
    manifestSha256: string | null;
  };
  /** この世代で見つかった問題（空なら OK）。 */
  problems: string[];
}

export interface OffsiteStatusReport {
  ok: boolean;
  backupDir: string;
  count: number;
  maxAgeMinutes: number;
  checkedAt: string;
  /** 最新世代の r2 記録の経過分（記録が無ければ null）。 */
  newestOffsiteAgeMinutes: number | null;
  generations: OffsiteGeneration[];
  problems: string[];
}

export class OffsiteStatusUsageError extends Error {}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listDumpNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => f.slice(0, -'.dump'.length))
    .sort() // 世代名は UTC の ISO 基本形なので辞書順＝時系列
    .reverse();
}

interface R2Marker {
  uploadedAt?: unknown;
  dump?: { size?: unknown; sha256?: unknown };
  manifest?: { size?: unknown; sha256?: unknown };
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 1 世代を検証する（純関数に近い。ファイルの読み取りのみ）。 */
export function inspectGeneration(dir: string, name: string): OffsiteGeneration {
  const dumpPath = join(dir, `${name}.dump`);
  const manifestPath = join(dir, `${name}.manifest.tsv`);
  const markerPath = join(dir, `${name}.dump.r2.json`);
  const problems: string[] = [];

  let dumpBytes: number | null = null;
  let dumpSha256: string | null = null;
  if (existsSync(dumpPath)) {
    dumpBytes = statSync(dumpPath).size;
    dumpSha256 = sha256Of(dumpPath);
  } else {
    problems.push('dump が無い');
  }

  let manifestBytes: number | null = null;
  let manifestSha256: string | null = null;
  if (existsSync(manifestPath)) {
    manifestBytes = statSync(manifestPath).size;
    manifestSha256 = sha256Of(manifestPath);
  } else {
    problems.push('manifest が無い');
  }

  const r2 = {
    present: existsSync(markerPath),
    uploadedAt: null as string | null,
    dumpSize: null as number | null,
    dumpSha256: null as string | null,
    manifestSize: null as number | null,
    manifestSha256: null as string | null,
  };

  if (r2.present) {
    let marker: R2Marker | null = null;
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8')) as R2Marker;
    } catch {
      problems.push('r2.json が JSON として読めない');
    }
    if (marker) {
      r2.uploadedAt = strOrNull(marker.uploadedAt);
      r2.dumpSize = numOrNull(marker.dump?.size);
      r2.dumpSha256 = strOrNull(marker.dump?.sha256);
      r2.manifestSize = numOrNull(marker.manifest?.size);
      r2.manifestSha256 = strOrNull(marker.manifest?.sha256);
      if (!r2.uploadedAt) problems.push('r2.json に uploadedAt が無い');
      if (r2.dumpSize === null) problems.push('r2.json に dump.size が無い');
      if (r2.dumpSha256 === null) problems.push('r2.json に dump.sha256 が無い');
    }
  } else {
    problems.push('r2.json（オフサイト送信記録）が無い');
  }

  if (r2.present && dumpBytes !== null && r2.dumpSize !== null && r2.dumpSize !== dumpBytes) {
    problems.push(`dump のサイズ不一致（local=${dumpBytes} / r2=${r2.dumpSize}）`);
  }
  if (r2.present && dumpSha256 && r2.dumpSha256 && r2.dumpSha256 !== dumpSha256) {
    problems.push('dump の SHA-256 不一致');
  }
  if (r2.present && manifestBytes !== null && r2.manifestSize !== null && r2.manifestSize !== manifestBytes) {
    problems.push(`manifest のサイズ不一致（local=${manifestBytes} / r2=${r2.manifestSize}）`);
  }
  if (r2.present && manifestSha256 && r2.manifestSha256 && r2.manifestSha256 !== manifestSha256) {
    problems.push('manifest の SHA-256 不一致');
  }

  return { name, dumpBytes, manifestBytes, dumpSha256, manifestSha256, r2, problems };
}

export interface CheckOptions {
  backupDir?: string;
  count?: number;
  maxAgeMinutes?: number;
  now?: number;
}

/** 直近 count 世代を検証し、レポートを返す。 */
export function checkOffsiteStatus(options: CheckOptions = {}): OffsiteStatusReport {
  const backupDir = resolve(
    options.backupDir ?? process.env.MIRAI_SF_BACKUP_DIR ?? join(homedir(), '.local/state/mirai-sf-prod/backups'),
  );
  const count = options.count ?? 3;
  const maxAgeMinutes = options.maxAgeMinutes ?? 90;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new OffsiteStatusUsageError('--count は 1〜50 の整数で指定してください');
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
    throw new OffsiteStatusUsageError('--max-age-min は正の数で指定してください');
  }

  const names = listDumpNames(backupDir).slice(0, count);
  const generations = names.map((name) => inspectGeneration(backupDir, name));
  const problems: string[] = [];

  if (generations.length === 0) {
    problems.push(`対象の dump がありません（${backupDir}）`);
  } else if (generations.length < count) {
    problems.push(`世代数が ${generations.length} 件で、要求の ${count} 件に足りません`);
  }

  const now = options.now ?? Date.now();
  let newestOffsiteAgeMinutes: number | null = null;
  for (const gen of generations) {
    for (const p of gen.problems) problems.push(`${gen.name}: ${p}`);
    if (gen.r2.uploadedAt && newestOffsiteAgeMinutes === null) {
      const at = Date.parse(gen.r2.uploadedAt);
      if (Number.isNaN(at)) {
        problems.push(`${gen.name}: uploadedAt が日時として読めない`);
      } else {
        newestOffsiteAgeMinutes = Math.round(((now - at) / 60000) * 10) / 10;
      }
    }
  }
  if (newestOffsiteAgeMinutes !== null && newestOffsiteAgeMinutes > maxAgeMinutes) {
    problems.push(
      `最新のオフサイト記録が古すぎます（${newestOffsiteAgeMinutes} 分前 > ${maxAgeMinutes} 分）`,
    );
  }

  return {
    ok: problems.length === 0,
    backupDir,
    count,
    maxAgeMinutes,
    checkedAt: new Date(now).toISOString(),
    newestOffsiteAgeMinutes,
    generations,
    problems,
  };
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : '-';
}

export function formatReport(report: OffsiteStatusReport): string[] {
  const lines: string[] = [];
  lines.push(
    `オフサイト状態: ${report.ok ? 'OK' : 'NG'}（${report.backupDir}、直近 ${report.count} 世代、鮮度上限 ${report.maxAgeMinutes} 分）`,
  );
  for (const gen of report.generations) {
    const age = gen.r2.uploadedAt ? ` uploadedAt=${gen.r2.uploadedAt}` : '';
    lines.push(
      `- ${gen.name}: dump=${gen.dumpBytes ?? '-'}B sha=${shortSha(gen.dumpSha256)} / r2=${gen.r2.present ? 'あり' : 'なし'}${age}`,
    );
    for (const p of gen.problems) lines.push(`    NG: ${p}`);
  }
  if (report.newestOffsiteAgeMinutes !== null) {
    lines.push(`最新のオフサイト記録: ${report.newestOffsiteAgeMinutes} 分前`);
  }
  for (const p of report.problems) lines.push(`NG: ${p}`);
  return lines;
}

function parseArgs(argv: string[]): { count: number; maxAgeMinutes: number; json: boolean } {
  let count = 3;
  let maxAgeMinutes = 90;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--count') {
      const value = argv[i + 1];
      if (!value) throw new OffsiteStatusUsageError('--count に値がありません');
      count = Number(value);
      i += 1;
    } else if (arg === '--max-age-min') {
      const value = argv[i + 1];
      if (!value) throw new OffsiteStatusUsageError('--max-age-min に値がありません');
      maxAgeMinutes = Number(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new OffsiteStatusUsageError(
        '使い方: tsx scripts/ops/offsite-status.ts [--count N] [--max-age-min MIN] [--json]',
      );
    } else {
      throw new OffsiteStatusUsageError(`不明な引数です: ${arg}`);
    }
  }
  return { count, maxAgeMinutes, json };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = checkOffsiteStatus({ count: args.count, maxAgeMinutes: args.maxAgeMinutes });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatReport(report).join('\n')}\n`);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    if (err instanceof OffsiteStatusUsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`想定外の失敗: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
