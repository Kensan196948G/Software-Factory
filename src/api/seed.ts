import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { hashPassword } from './password.js';
import { config } from './config.js';
import { NEXT_STATUS, SIGNAL_LABEL, STATUS_LABEL } from '../shared/domain.js';
import type { Signal, Status } from '../shared/domain.js';

export interface DepartmentSeed {
  code: string;
  name: string;
  short_name: string;
  role_desc: string;
  sort_order: number;
}

export interface ToolSeed {
  id: string;
  dept_code: string;
  name: string;
  description: string;
  signal: Signal;
  seed_candidate: boolean;
  sort_order: number;
}

export interface DemoRequestSeed {
  id: string;
  title: string;
  dept_code: string;
  kind: string;
  tool_id: string | null;
  applicant: string;
  contact: string;
  problem: string;
  purpose: string;
  users: string[];
  people: number;
  places: string[];
  scope: string[];
  out_of_scope: string[];
  criteria: string[];
  decides: string;
  data_handling: string[];
  parties: string;
  constraints: string[];
  constraints_other: string[];
  approvals: string[];
  frequency: string;
  minutes_per_time: number;
  data_ready: number;
  spread: number;
  approver: string;
  status: string;
  signal_decided: Signal | null;
  tailoring: string | null;
  order_version: number;
  created_days_ago: number;
  status_since_days: number;
  comments: { days_ago: number; by: string; text: string }[];
}

const seedDir = resolve(process.cwd(), 'db/seed');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(seedDir, name), 'utf8')) as T;
}

export function loadSeedData() {
  return {
    departments: readJson<DepartmentSeed[]>('departments.json'),
    tools: readJson<ToolSeed[]>('catalog.json'),
    demo: readJson<DemoRequestSeed[]>('demo-requests.json'),
  };
}

/** 部署・道具カタログ（19部署・118件）を投入する。冪等。 */
export async function seedMaster(client: PoolClient): Promise<{ departments: number; tools: number }> {
  const { departments, tools } = loadSeedData();
  for (const d of departments) {
    await client.query(
      `insert into department (code, name, short_name, role_desc, sort_order)
       values ($1,$2,$3,$4,$5)
       on conflict (code) do update set name=$2, short_name=$3, role_desc=$4, sort_order=$5`,
      [d.code, d.name, d.short_name, d.role_desc, d.sort_order],
    );
  }
  for (const t of tools) {
    await client.query(
      `insert into catalog_tool (id, dept_code, name, description, signal, seed_candidate, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set dept_code=$2, name=$3, description=$4, signal=$5, seed_candidate=$6, sort_order=$7`,
      [t.id, t.dept_code, t.name, t.description, t.signal, t.seed_candidate, t.sort_order],
    );
  }
  return { departments: departments.length, tools: tools.length };
}

/** 初期管理者（個人利用MVP）。既存なら何もしない。 */
export async function seedAdmin(client: PoolClient): Promise<{ created: boolean; email: string }> {
  const email = config.seedAdminEmail.trim().toLowerCase();
  const existing = await client.query('select id from app_user where email = $1', [email]);
  if (existing.rowCount && existing.rowCount > 0) {
    const id = existing.rows[0].id as string;
    for (const role of ['requester', 'desk', 'approver']) {
      await client.query('insert into user_role (user_id, role) values ($1,$2) on conflict do nothing', [id, role]);
    }
    return { created: false, email };
  }
  if (!config.seedAdminPassword) {
    throw new Error('SEED_ADMIN_PASSWORD が未設定のため初期管理者を作成できません');
  }
  const hash = await hashPassword(config.seedAdminPassword);
  const inserted = await client.query<{ id: string }>(
    `insert into app_user (email, display_name, dept_code, password_hash, is_admin)
     values ($1,$2,$3,$4,true) returning id`,
    [email, config.seedAdminName, config.seedAdminDept, hash],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('初期管理者の作成に失敗しました');
  for (const role of ['requester', 'desk', 'approver']) {
    await client.query('insert into user_role (user_id, role) values ($1,$2)', [id, role]);
  }
  return { created: true, email };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** 現在の状態までの履歴を作る（状態変更の起点＝滞留日数に使う）。 */
function buildHistory(seed: DemoRequestSeed): { at: Date; actor: string; role: string; action: string; note: string | null }[] {
  const current = seed.status as Status;
  const path: Status[] = [];
  let cursor: Status | undefined = 'received';
  path.push('received');
  while (cursor && cursor !== current) {
    cursor = NEXT_STATUS[cursor];
    if (!cursor) break;
    path.push(cursor);
  }
  if (current === 'back') path.push('back');
  if (current === 'hold') path.push('hold');
  if (current === 'cancel') path.push('cancel');
  if (path[path.length - 1] !== current) path.push(current);

  const startDays = seed.created_days_ago;
  const endDays = seed.status_since_days;
  const steps = Math.max(path.length - 1, 1);
  const history: { at: Date; actor: string; role: string; action: string; note: string | null }[] = [];
  path.forEach((status, idx) => {
    const day = startDays - ((startDays - endDays) * idx) / steps;
    const isFirst = idx === 0;
    const isPrevApproval = path[idx - 1] === 'wait' && status === 'approved';
    const actor = isFirst ? seed.applicant : isPrevApproval ? seed.approver : '佐藤 花子';
    const role = isFirst ? 'requester' : isPrevApproval ? 'approver' : 'desk';
    history.push({
      at: daysAgo(Math.max(day, 0)),
      actor,
      role,
      action: isFirst ? '受付' : `状態を「${STATUS_LABEL[status]}」に変更`,
      note: null,
    });
  });
  return history;
}

/** 見本データ9件を投入する。呼び出し側が空であることを保証する（reset/seed 内）。 */
export async function seedDemo(client: PoolClient): Promise<number> {
  const { demo } = loadSeedData();
  for (const seed of demo) {
    const year = Number(seed.id.slice(4, 8));
    const seq = Number(seed.id.slice(9));
    const createdAt = daysAgo(seed.created_days_ago);
    await client.query(
      `insert into request (
        id, seq, year, created_at, updated_at, applicant, dept_code, contact, title, kind, tool_id,
        problem, purpose, users, people, places, scope, out_of_scope, criteria, decides, data_handling,
        parties, constraints, constraints_other, requires_human_approval, frequency, minutes_per_time,
        data_ready, spread, approver, status, signal_decided, tailoring, order_version, version, created_by, updated_by
      ) values (
        $1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,1,null,null
      )`,
      [
        seed.id,
        seq,
        year,
        createdAt,
        seed.applicant,
        seed.dept_code,
        seed.contact,
        seed.title,
        seed.kind,
        seed.tool_id,
        seed.problem,
        seed.purpose,
        seed.users,
        seed.people,
        seed.places,
        seed.scope,
        seed.out_of_scope,
        seed.criteria,
        seed.decides,
        seed.data_handling,
        seed.parties,
        seed.constraints,
        seed.constraints_other,
        seed.approvals,
        seed.frequency,
        seed.minutes_per_time,
        seed.data_ready,
        seed.spread,
        seed.approver,
        seed.status,
        seed.signal_decided,
        seed.tailoring,
        seed.order_version,
      ],
    );

    for (const h of buildHistory(seed)) {
      await client.query(
        `insert into request_history (request_id, at, actor_name, role, action, note) values ($1,$2,$3,$4,$5,$6)`,
        [seed.id, h.at, h.actor, h.role, h.action, h.note],
      );
    }

    if (seed.signal_decided && seed.order_version > 0) {
      const suggested = seed.signal_decided;
      const isLower = seed.id === 'REQ-2026-0002';
      await client.query(
        `insert into approval (request_id, at, approver_name, decision, reason, decided_signal, suggested_signal, checklist, order_version)
         values ($1,$2,$3,'approved',$4,$5,$6,'[]'::jsonb,$7)`,
        [
          seed.id,
          daysAgo(seed.status_since_days + 1),
          seed.approver,
          isLower ? '予定の表示と二重予約の防止だけで、船を出すかの判断は道具に含めないため' : null,
          seed.signal_decided,
          isLower ? 'y' : suggested,
          seed.order_version,
        ],
      );
      await client.query(
        `insert into request_history (request_id, at, actor_name, role, action, note)
         values ($1,$2,$3,'approver',$4,$5)`,
        [
          seed.id,
          daysAgo(seed.status_since_days + 1),
          seed.approver,
          '状態を「承認済み」に変更',
          `信号の色を「${SIGNAL_LABEL[seed.signal_decided]}」に決定${isLower ? '（候補は「黄」）' : ''}`,
        ],
      );
    }

    for (const c of seed.comments) {
      await client.query(`insert into comment (request_id, at, by_name, body) values ($1,$2,$3,$4)`, [
        seed.id,
        daysAgo(c.days_ago),
        c.by,
        c.text,
      ]);
    }
  }
  // 採番カウンタを既存データの最大値に合わせる（新規登録で衝突させない）
  const maxRows = await client.query<{ year: number; max_seq: number }>(
    'select year, max(seq)::int as max_seq from request group by year',
  );
  for (const row of maxRows.rows) {
    await client.query(
      `insert into request_counter (year, last_seq) values ($1,$2)
       on conflict (year) do update set last_seq = greatest(request_counter.last_seq, $2)`,
      [row.year, row.max_seq],
    );
  }
  return demo.length;
}

/** 開発用の一括初期化（部署→道具→管理者→見本データ）。 */
async function reconcileCounters(client: PoolClient): Promise<void> {
  const rows = await client.query<{ year: number; max_seq: number }>(
    'select year, max(seq)::int as max_seq from request group by year',
  );
  for (const row of rows.rows) {
    await client.query(
      `insert into request_counter (year, last_seq) values ($1,$2)
       on conflict (year) do update set last_seq = greatest(request_counter.last_seq, $2)`,
      [row.year, row.max_seq],
    );
  }
}

export async function seedAll(client: PoolClient): Promise<{ departments: number; tools: number; demo: number; admin: string }> {
  const master = await seedMaster(client);
  const admin = await seedAdmin(client);
  const hasRequests = await client.query('select 1 from request limit 1');
  let demo = 0;
  if (!hasRequests.rowCount) demo = await seedDemo(client);
  await reconcileCounters(client);
  return { ...master, demo, admin: admin.email };
}

export function demoRequestCount(): number {
  return loadSeedData().demo.length;
}
