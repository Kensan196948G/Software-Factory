import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Mirai-Info の部署・社員名に合わせるための種データの整合を固定する。
// 実データは同期スクリプト（scripts/ops/sync-mirai-directory.mjs）が入れる。
const read = <T>(name: string): T => JSON.parse(readFileSync(resolve('db/seed', name), 'utf8')) as T;

interface Division {
  code: string;
  name: string;
  short_name: string;
  role_desc: string;
  sort_order: number;
  sources: string[];
}
interface Dept {
  code: string;
  sort_order: number;
}
interface Tool {
  id: string;
  dept_code: string;
}
interface Employee {
  employee_no: string;
  name: string;
  division: string;
  section?: string;
}

describe('Mirai-Info に合わせた部署・社員名の種データ', () => {
  const divisions = read<Division[]>('mirai-divisions.json');
  const departments = read<Dept[]>('departments.json');
  const tools = read<Tool[]>('catalog.json');
  const employees = read<Employee[]>('mirai-employees.sample.json');

  it('部署は16で、コードが重複しない', () => {
    expect(divisions).toHaveLength(16);
    const codes = divisions.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(divisions.map((d) => d.name)).toEqual(
      expect.arrayContaining(['東京支店', '大阪支店', '管理本部', '技術本部', 'みらい建設工業']),
    );
  });

  it('道具の出どころは、旧・機能別部署のコードである', () => {
    const known = new Set(departments.map((d) => d.code));
    for (const d of divisions) {
      expect(d.sources.length).toBeGreaterThan(0);
      for (const source of d.sources) expect(known.has(source)).toBe(true);
    }
  });

  it('どの部署にも道具が1件以上ある', () => {
    const byDept = new Map<string, number>();
    for (const t of tools) byDept.set(t.dept_code, (byDept.get(t.dept_code) ?? 0) + 1);
    for (const d of divisions) {
      const count = d.sources.reduce((sum, s) => sum + (byDept.get(s) ?? 0), 0);
      expect(count, `${d.name} の道具`).toBeGreaterThan(0);
    }
  });

  it('見本の社員名簿は、全部署に1人以上いて、部署コードが正しい', () => {
    const codes = new Set(divisions.map((d) => d.code));
    expect(new Set(employees.map((e) => e.employee_no)).size).toBe(employees.length);
    for (const e of employees) expect(codes.has(e.division)).toBe(true);
    for (const d of divisions) {
      expect(
        employees.some((e) => e.division === d.code),
        `${d.name} の社員`,
      ).toBe(true);
    }
  });

  it('「操作する人」に出す社員（依頼者・受付・承認者）の部署と課が名簿にある', () => {
    const has = (division: string, section: string) => employees.some((e) => e.division === division && e.section === section);
    expect(has('tokyo', '工事部')).toBe(true);
    expect(has('kanri', 'DX推進部')).toBe(true);
    expect(has('gijutsu', '技術部')).toBe(true);
  });
});
