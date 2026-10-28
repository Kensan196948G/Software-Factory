import { describe, expect, it } from 'vitest';
import { buildOrderYaml, formatOrderDate } from '@shared/order.js';
import { buildCsv, buildExportJson, CSV_HEADERS, measureOf } from '@shared/export.js';
import type { RequestRecord } from '@shared/types.js';

const record: RequestRecord = {
  id: 'REQ-2026-0001',
  seq: 1,
  year: 2026,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-20T01:00:00.000Z',
  applicant: '山田 太郎',
  deptCode: 'kaijo',
  deptName: '支店工事部の現場（海の工事）',
  title: '工事写真の圏外保存',
  kind: 'improve_tool',
  toolId: 'kaijo-01',
  toolName: '工事写真の整理・写真台帳',
  problem: '作業船や台船の上では電波が弱く写真が送れず、事務所に戻ってから整理し直している',
  purpose: '海の上でも写真が消えずに残り、事務所での整理の手間をなくす',
  users: ['現場の担当者', '現場事務'],
  people: 40,
  places: ['海の上（作業船・台船）'],
  scope: ['圏外での一時保存'],
  outOfScope: ['発注者システムへの直接提出'],
  criteria: ['圏外で撮った写真がアプリを閉じても消えない', '電波が戻ると自動で送られ、二重に登録されない'],
  decides: 'g',
  dataHandling: ['photo'],
  parties: 'internal',
  constraints: ['写真・記録の原本は加工しない'],
  constraintsOther: [],
  approvals: ['提出様式の変更'],
  frequency: 'd',
  minutesPerTime: 15,
  dataReady: 5,
  spread: 5,
  approver: '鈴木 一郎',
  status: 'field',
  signalDecided: 'y',
  tailoring: 'T2',
  orderVersion: 1,
  version: 2,
  deleted: false,
};

describe('注文書 YAML', () => {
  const yaml = buildOrderYaml({
    request: record,
    suggested: 'y',
    departmentName: '支店工事部の現場（海の工事）',
    catalogToolName: '工事写真の整理・写真台帳',
  });

  it('先頭に schema_version と order_version を持つ', () => {
    expect(yaml.startsWith('schema_version: "1.0"\norder_version: 1\n')).toBe(true);
  });

  it('主要項目を二重引用符で出力する', () => {
    expect(yaml).toContain('id: "REQ-2026-0001"');
    expect(yaml).toContain('title: "工事写真の圏外保存"');
    expect(yaml).toContain('department: "支店工事部の現場（海の工事）"');
    expect(yaml).toContain('catalog_tool: "工事写真の整理・写真台帳"');
    expect(yaml).toContain('status: "現場試用"');
  });

  it('信号は候補と決定を分けて出す', () => {
    expect(yaml).toContain('signal:\n  suggested: "黄"\n  decided: "黄"');
  });

  it('扱う情報はキーではなく日本語ラベルで出す', () => {
    expect(yaml).toContain(' - "工事写真・検査記録の原本"');
    expect(yaml).not.toContain(' - "photo"');
  });

  it('削減見込みはものさしの式と同じ', () => {
    expect(yaml).toContain('  est_hours_per_month: 200');
    expect(yaml).toContain('  people: 40');
    expect(yaml).toContain('  frequency: "毎日"');
  });

  it('空のリストは [] で出す', () => {
    const empty = buildOrderYaml({
      request: { ...record, outOfScope: [], approvals: [] },
      suggested: 'y',
      departmentName: 'd',
      catalogToolName: '',
    });
    expect(empty).toContain('out_of_scope: []');
    expect(empty).toContain('requires_human_approval: []');
    expect(empty).toContain('catalog_tool: "カタログ外"');
  });

  it('改行は空白に置きかえ、引用符をエスケープする', () => {
    const one = buildOrderYaml({
      request: { ...record, problem: '1行目\n2行目 "引用"' },
      suggested: 'g',
      departmentName: 'd',
      catalogToolName: '',
    });
    expect(one).toContain(' - "1行目 2行目 \\"引用\\""');
  });

  it('日付は日本時間で出す', () => {
    expect(formatOrderDate('2026-10-01T01:00:00.000Z')).toBe('2026/10/01 10:00');
  });
});

describe('CSV / JSON 出力', () => {
  it('CSVはBOM・CRLF・全セル引用・11列', () => {
    const csv = buildCsv([
      { request: record, suggested: 'y', deptName: '現場（海）', measure: measureOf(record) },
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(CSV_HEADERS.map((h) => `"${h}"`).join(','));
    expect(lines[1]).toContain('"REQ-2026-0001"');
    expect(lines[1]).toContain('"200"');
  });

  it('CSVのセル内の二重引用符は2つ重ねる', () => {
    const csv = buildCsv([
      { request: { ...record, title: 'A "B" C' }, suggested: 'g', deptName: 'd', measure: 0 },
    ]);
    expect(csv).toContain('"A ""B"" C"');
  });

  it('JSONは {seq, items} で字下げ2', () => {
    const json = buildExportJson([record], 9);
    const parsed = JSON.parse(json) as { seq: number; items: RequestRecord[] };
    expect(parsed.seq).toBe(9);
    expect(parsed.items[0]?.id).toBe('REQ-2026-0001');
    expect(json).toContain('\n  "seq": 9');
  });
});
