import type { PoolClient } from 'pg';
import { many, one, query } from './db.js';
import type {
  CommentEntry,
  DepartmentRow,
  HistoryEntry,
  RequestRecord,
} from '../shared/types.js';
import type { FrequencyKey, Kind, Party, Role, Signal, Status, Tailoring } from '../shared/domain.js';

export interface RequestRow {
  id: string;
  seq: number;
  year: number;
  created_at: Date;
  updated_at: Date;
  applicant: string;
  applicant_user_id: string | null;
  dept_code: string;
  dept_name: string | null;
  contact: string | null;
  title: string;
  kind: Kind;
  tool_id: string | null;
  tool_name: string | null;
  problem: string;
  purpose: string;
  users: string[];
  people: number | null;
  places: string[];
  scope: string[];
  out_of_scope: string[];
  criteria: string[];
  decides: 'g' | 'y' | 'r';
  data_handling: string[];
  parties: Party;
  constraints: string[];
  constraints_other: string[];
  requires_human_approval: string[];
  frequency: FrequencyKey | null;
  minutes_per_time: number | null;
  data_ready: number | null;
  spread: number | null;
  wish_date: Date | null;
  approver: string;
  approver_user_id: string | null;
  status: Status;
  signal_decided: Signal | null;
  tailoring: Tailoring | null;
  order_version: number;
  version: number;
  deleted: boolean;
  issue_no: number | null;
  status_since: Date | null;
}

const SELECT_BASE = `
  select r.*, d.name as dept_name, t.name as tool_name,
         (select max(h.at) from request_history h
           where h.request_id = r.id
             and (h.action like '状態を%' or h.action = '受付')) as status_since
    from request r
    join department d on d.code = r.dept_code
    left join catalog_tool t on t.id = r.tool_id`;

export function mapRequest(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    seq: row.seq,
    year: row.year,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    applicant: row.applicant,
    applicantUserId: row.applicant_user_id,
    deptCode: row.dept_code,
    deptName: row.dept_name ?? undefined,
    contact: row.contact,
    title: row.title,
    kind: row.kind,
    toolId: row.tool_id,
    toolName: row.tool_name,
    problem: row.problem,
    purpose: row.purpose,
    users: row.users,
    people: row.people,
    places: row.places,
    scope: row.scope,
    outOfScope: row.out_of_scope,
    criteria: row.criteria,
    decides: row.decides,
    dataHandling: row.data_handling,
    parties: row.parties,
    constraints: row.constraints,
    constraintsOther: row.constraints_other,
    approvals: row.requires_human_approval,
    frequency: row.frequency,
    minutesPerTime: row.minutes_per_time,
    dataReady: row.data_ready,
    spread: row.spread,
    wishDate: row.wish_date ? row.wish_date.toISOString().slice(0, 10) : null,
    approver: row.approver,
    approverUserId: row.approver_user_id,
    status: row.status,
    signalDecided: row.signal_decided,
    tailoring: row.tailoring,
    orderVersion: row.order_version,
    version: row.version,
    deleted: row.deleted,
    issueNo: row.issue_no,
  };
}

export function statusSince(row: RequestRow): Date {
  return row.status_since ?? row.created_at;
}

export interface ListFilters {
  q?: string;
  dept?: string;
  status?: string;
  includeDeleted?: boolean;
  applicantUserId?: string;
  approverUserId?: string;
  order?: 'newest' | 'oldest';
  limit?: number;
}

export async function listRequests(filters: ListFilters): Promise<{ rows: RequestRow[]; total: number }> {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (!filters.includeDeleted) where.push('r.deleted = false');
  if (filters.dept) {
    params.push(filters.dept);
    where.push(`r.dept_code = $${params.length}`);
  }
  if (filters.status) {
    const statuses = filters.status.split(',').filter(Boolean);
    if (statuses.length > 0) {
      params.push(statuses);
      where.push(`r.status = any($${params.length})`);
    }
  }
  if (filters.applicantUserId) {
    params.push(filters.applicantUserId);
    where.push(`r.applicant_user_id = $${params.length}`);
  }
  if (filters.approverUserId) {
    params.push(filters.approverUserId);
    where.push(`(r.approver_user_id = $${params.length} or r.approver_user_id is null)`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    const idx = params.length;
    where.push(`(r.id ilike $${idx} or r.title ilike $${idx} or r.problem ilike $${idx} or r.purpose ilike $${idx})`);
  }

  const order = filters.order === 'oldest' ? 'asc' : 'desc';
  const limit = filters.limit ?? 5000;
  params.push(limit);
  const rows = await many<RequestRow>(
    `${SELECT_BASE} where ${where.join(' and ')} order by r.created_at ${order} limit $${params.length}`,
    params,
  );
  const countRow = await one<{ count: number }>(
    `select count(*)::int as count from request r where ${where.map((w) => w.replace(/\br\./g, 'r.')).join(' and ')}`,
    params.slice(0, -1),
  );
  return { rows, total: countRow?.count ?? rows.length };
}

export async function getRequestRow(id: string, includeDeleted = true): Promise<RequestRow | null> {
  const result = await query<RequestRow>(
    `${SELECT_BASE} where r.id = $1 ${includeDeleted ? '' : 'and r.deleted = false'}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getRequestRowForUpdate(client: PoolClient, id: string): Promise<RequestRow | null> {
  const result = await client.query<RequestRow>(`${SELECT_BASE} where r.id = $1 for update of r`, [id]);
  return result.rows[0] ?? null;
}

export async function listHistory(requestId: string): Promise<HistoryEntry[]> {
  const rows = await many<{
    id: number;
    at: Date;
    actor_name: string;
    actor_user_id: string | null;
    role: string;
    action: string;
    note: string | null;
    correlation_id: string | null;
  }>(
    `select id, at, actor_name, actor_user_id, role, action, note, correlation_id
       from request_history where request_id = $1 order by at asc, id asc`,
    [requestId],
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actorName: r.actor_name,
    actorUserId: r.actor_user_id,
    role: r.role as Role | 'system',
    action: r.action,
    note: r.note,
    correlationId: r.correlation_id,
  }));
}

export async function listComments(requestId: string): Promise<CommentEntry[]> {
  const rows = await many<{ id: number; at: Date; by_name: string; body: string }>(
    `select id, at, by_name, body from comment where request_id = $1 order by at asc, id asc`,
    [requestId],
  );
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), by: r.by_name, text: r.body }));
}

export async function listDepartments(): Promise<DepartmentRow[]> {
  return many<DepartmentRow>(
    `select d.code, d.name, d.short_name as "shortName", d.role_desc as "roleDesc", d.sort_order as "sortOrder",
            count(t.id)::int as "toolCount",
            count(*) filter (where t.signal = 'g')::int as g,
            count(*) filter (where t.signal = 'y')::int as y,
            count(*) filter (where t.signal = 'r')::int as r
       from department d left join catalog_tool t on t.dept_code = d.code
      group by d.code
      order by d.sort_order`,
  );
}

export async function getCatalogTools(filters: { dept?: string; signal?: string; q?: string }): Promise<
  {
    id: string;
    deptCode: string;
    deptName: string;
    name: string;
    description: string;
    signal: Signal;
    seedCandidate: boolean;
    sortOrder: number;
  }[]
> {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (filters.dept) {
    params.push(filters.dept);
    where.push(`t.dept_code = $${params.length}`);
  }
  if (filters.signal) {
    params.push(filters.signal);
    where.push(`t.signal = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(t.name ilike $${params.length} or t.description ilike $${params.length})`);
  }
  const rows = await many<{
    id: string;
    dept_code: string;
    dept_name: string;
    name: string;
    description: string;
    signal: Signal;
    seed_candidate: boolean;
    sort_order: number;
  }>(
    `select t.id, t.dept_code, d.name as dept_name, t.name, t.description, t.signal, t.seed_candidate, t.sort_order
       from catalog_tool t join department d on d.code = t.dept_code
      where ${where.join(' and ')}
      order by d.sort_order, t.sort_order`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    deptCode: r.dept_code,
    deptName: r.dept_name,
    name: r.name,
    description: r.description,
    signal: r.signal,
    seedCandidate: r.seed_candidate,
    sortOrder: r.sort_order,
  }));
}

export async function getCatalogSignals(ids: string[]): Promise<Map<string, Signal>> {
  const map = new Map<string, Signal>();
  if (ids.length === 0) return map;
  const rows = await many<{ id: string; signal: Signal }>(`select id, signal from catalog_tool where id = any($1)`, [ids]);
  for (const r of rows) map.set(r.id, r.signal);
  return map;
}

export async function getDepartmentName(code: string): Promise<string | null> {
  const row = await one<{ name: string }>('select name from department where code = $1', [code]);
  return row?.name ?? null;
}

export async function getRecentHistory(limit = 8): Promise<HistoryEntry[]> {
  const rows = await many<{
    id: number;
    at: Date;
    actor_name: string;
    actor_user_id: string | null;
    role: string;
    action: string;
    note: string | null;
    correlation_id: string | null;
    request_id: string;
  }>(
    `select id, at, actor_name, actor_user_id, role, action, note, correlation_id, request_id
       from request_history order by at desc, id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actorName: r.actor_name,
    actorUserId: r.actor_user_id,
    role: r.role as Role | 'system',
    action: r.action,
    note: r.note,
    correlationId: r.correlation_id,
  }));
}
