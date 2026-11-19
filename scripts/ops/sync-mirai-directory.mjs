#!/usr/bin/env node
/**
 * Mirai-Info（社員名簿・組織）に、SF の部署・社員名・道具カタログを合わせる。
 *
 *   node scripts/ops/with-env.mjs node scripts/ops/sync-mirai-directory.mjs
 *   MIRAI_INFO_DATABASE_URL=postgresql:///mirai_info DATABASE_URL=postgresql:///mirai_sf_dev \
 *     node scripts/ops/sync-mirai-directory.mjs
 *
 * - 部署: Mirai-Info の division（16。グループ会社の青木マリーンは除く）を selectable にし、
 *   旧・機能別の部署は selectable=false にして履歴の参照用に残す。
 * - 道具: 部署→道具の対応（department_tool）を db/seed/mirai-divisions.json の sources から作り直す。
 * - 社員名: mirai_info.employee_directory の有効者だけを取り込む（氏名・ヨミ・部署・課のみ）。
 * - 既存データ: 旧部署コードの依頼・利用者を新しい部署へ移し、見本の起票者名を実在の社員名に置き換える。
 *
 * 何度実行しても同じ結果になる（冪等）。実名（PII）は標準出力に出さない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const MIRAI_URL =
  process.env.MIRAI_INFO_DATABASE_URL || 'postgresql:///mirai_info?host=/var/run/postgresql';
const SF_URL = process.env.DATABASE_URL;
if (!SF_URL) {
  console.error('DATABASE_URL がありません（SF の DB を指定してください）');
  process.exit(2);
}

const divisions = JSON.parse(readFileSync(resolve('db/seed/mirai-divisions.json'), 'utf8'));
const legacyTools = JSON.parse(readFileSync(resolve('db/seed/catalog.json'), 'utf8'));

/** 旧・機能別部署 → Mirai-Info の部署。履歴の参照を切らさないための対応。 */
const LEGACY_MAP = {
  sekkei: 'gijutsu',
  ict: 'gijutsu',
  iji: 'gijutsu',
  kaijo: 'tokyo',
  rikujo: 'osaka',
  kobai: 'sekou',
  hinshitsu: 'anzen',
  shiten: 'tokyo',
  somu: 'kanri',
  jinji: 'kanri',
  keiri: 'kanri',
  dx: 'kanri',
  kansa: 'keiei',
  koho: 'keiei',
};

const divisionByName = new Map(divisions.map((d) => [d.name, d]));

const sf = new Client({ connectionString: SF_URL });
const mirai = new Client({ connectionString: MIRAI_URL });
await sf.connect();
await mirai.connect();

try {
  // ── 1. Mirai-Info から有効な社員を読む
  const { rows: people } = await mirai.query(
    `select employee_no, name, name_kana, division, section
       from mirai_info.employee_directory
      where status = '有効' and coalesce(division,'') <> '' and coalesce(employee_no,'') <> ''`,
  );
  const mapped = [];
  let skipped = 0;
  for (const p of people) {
    const div = divisionByName.get(p.division);
    if (!div) {
      skipped += 1;
      continue;
    }
    mapped.push({ no: p.employee_no, name: p.name, kana: p.name_kana || '', dept: div.code, section: p.section || '' });
  }

  // ── 2. 部署（16）を upsert し、旧部署を選択不可にする
  for (const d of divisions) {
    await sf.query(
      `insert into department (code, name, short_name, role_desc, sort_order, selectable, source)
       values ($1,$2,$3,$4,$5,true,'mirai_info')
       on conflict (code) do update set name=$2, short_name=$3, role_desc=$4, sort_order=$5,
         selectable=true, source='mirai_info'`,
      [d.code, d.name, d.short_name, d.role_desc, d.sort_order],
    );
  }
  await sf.query(`update department set selectable=false where code <> all($1::text[])`, [divisions.map((d) => d.code)]);

  // ── 3. 部署→道具（対応表を作り直す）
  const toolsByDept = new Map();
  for (const t of legacyTools) {
    const list = toolsByDept.get(t.dept_code) ?? [];
    list.push(t);
    toolsByDept.set(t.dept_code, list);
  }
  for (const list of toolsByDept.values()) list.sort((a, b) => a.sort_order - b.sort_order);

  await sf.query(`delete from department_tool where dept_code = any($1::text[])`, [divisions.map((d) => d.code)]);
  let mappings = 0;
  for (const d of divisions) {
    const seen = new Set();
    const rows = [];
    for (const source of d.sources) {
      for (const t of toolsByDept.get(source) ?? []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        rows.push([d.code, t.id, rows.length + 1]);
      }
    }
    for (const [dept, toolId, order] of rows) {
      await sf.query(`insert into department_tool (dept_code, tool_id, sort_order) values ($1,$2,$3)`, [dept, toolId, order]);
    }
    mappings += rows.length;
  }

  // ── 4. 社員名簿を upsert（居なくなった人は is_active=false）
  const seenNo = new Set();
  for (const p of mapped) {
    seenNo.add(p.no);
    await sf.query(
      `insert into mirai_employee (employee_no, name, name_kana, division_code, section, is_active, synced_at)
       values ($1,$2,$3,$4,$5,true,now())
       on conflict (employee_no) do update set name=$2, name_kana=$3, division_code=$4, section=$5,
         is_active=true, synced_at=now()`,
      [p.no, p.name, p.kana, p.dept, p.section],
    );
  }
  const { rows: existing } = await sf.query(`select employee_no from mirai_employee where is_active`);
  const gone = existing.map((r) => r.employee_no).filter((no) => !seenNo.has(no));
  if (gone.length) {
    await sf.query(`update mirai_employee set is_active=false, synced_at=now() where employee_no = any($1::text[])`, [gone]);
  }

  // ── 5. 旧部署の依頼・利用者を新しい部署へ移す
  let movedRequests = 0;
  let movedUsers = 0;
  for (const [from, to] of Object.entries(LEGACY_MAP)) {
    const r = await sf.query(`update request set dept_code=$2 where dept_code=$1`, [from, to]);
    movedRequests += r.rowCount ?? 0;
    const u = await sf.query(`update app_user set dept_code=$2 where dept_code=$1`, [from, to]);
    movedUsers += u.rowCount ?? 0;
  }

  // ── 6. 見本の起票者名を、その部署の実在の社員名に置き換える
  const { rows: employees } = await sf.query(
    `select division_code, name from mirai_employee where is_active order by division_code, employee_no`,
  );
  const firstByDept = new Map();
  for (const e of employees) if (!firstByDept.has(e.division_code)) firstByDept.set(e.division_code, e.name);
  const roster = new Set(employees.map((e) => e.name));
  const { rows: requests } = await sf.query(`select id, dept_code, applicant from request`);
  let renamed = 0;
  for (const r of requests) {
    if (roster.has(r.applicant)) continue;
    const name = firstByDept.get(r.dept_code);
    if (!name) continue;
    await sf.query(`update request set applicant=$2 where id=$1`, [r.id, name]);
    renamed += 1;
  }

  const active = mapped.length;
  console.log(
    JSON.stringify({
      divisions: divisions.length,
      mappings,
      employees: active,
      skipped_divisions: skipped,
      moved_requests: movedRequests,
      moved_users: movedUsers,
      renamed_applicants: renamed,
      deactivated_employees: gone.length,
    }),
  );
} finally {
  await sf.end();
  await mirai.end();
}
