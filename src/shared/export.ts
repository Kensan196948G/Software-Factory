import { KIND_LABEL, SIGNAL_LABEL, STATUS_LABEL, computeMeasure } from './domain.js';
import type { Kind, Signal, Status } from './domain.js';
import type { RequestRecord } from './types.js';

/** CSV の1セル（すべて二重引用符で囲む。中の " は2つ重ねる）。詳細仕様書 6-2。 */
function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export interface CsvRowInput {
  request: RequestRecord;
  suggested: Signal;
  deptName: string;
  measure: number;
}

export const CSV_HEADERS = [
  '受付番号',
  '件名',
  '部署',
  '依頼区分',
  '起票者',
  '信号（候補）',
  '信号（決定）',
  '状態',
  '月あたり削減見込み(h)',
  '受付日時',
  '更新日時',
] as const;

/** 一覧 CSV（11列・UTF-8 BOM・CRLF）。 */
export function buildCsv(rows: CsvRowInput[]): string {
  const lines: string[] = [];
  lines.push(CSV_HEADERS.map(cell).join(','));
  for (const row of rows) {
    const r = row.request;
    lines.push(
      [
        cell(r.id),
        cell(r.title),
        cell(row.deptName),
        cell(KIND_LABEL[r.kind as Kind] ?? r.kind),
        cell(r.applicant),
        cell(SIGNAL_LABEL[row.suggested]),
        cell(r.signalDecided ? SIGNAL_LABEL[r.signalDecided] : ''),
        cell(STATUS_LABEL[r.status as Status] ?? r.status),
        cell(String(row.measure)),
        cell(r.createdAt),
        cell(r.updatedAt),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export interface ExportJson {
  seq: number;
  items: RequestRecord[];
}

/** 全データ JSON（{seq, items}、字下げ2）。詳細仕様書 6-3。 */
export function buildExportJson(items: RequestRecord[], seq: number): string {
  return `${JSON.stringify({ seq, items }, null, 2)}\n`;
}

/** 一覧の削減見込みをまとめて計算する。 */
export function measureOf(r: RequestRecord): number {
  return computeMeasure({ people: r.people, frequency: r.frequency, minutesPerTime: r.minutesPerTime });
}
