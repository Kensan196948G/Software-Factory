import type { PoolClient } from 'pg';
import { many, one, query } from './db.js';
import { DATA_HANDLING, SAFETY_APPROVALS } from '../shared/domain.js';
import type { CommentEntry, DepartmentRow, HistoryEntry, RequestRecord } from '../shared/types.js';
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
  /** 依頼ごとの開発ラインの投入先（L-12）。NULL は未指定（既定＝DEVLINE_TARGET_REPOS の先頭）。 */
  target_repo_id: string | null;
}

const SELECT_BASE = `
  select r.*, d.name as dept_name, t.name as tool_name,
         (select max(h.at) from request_history h
           where h.request_id = r.id
             and (h.action like '状態を%' or h.action = '受付')) as status_since
    from request r
    join department d on d.code = r.dept_code
    left join catalog_tool t on t.id = r.tool_id`;

/** pg の date はローカル時刻の深夜の Date で返る。UTC へ変換すると JST で 1 日ずれるので、ローカルの年月日を使う。 */
export function dateOnly(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

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
    wishDate: row.wish_date ? dateOnly(row.wish_date) : null,
    approver: row.approver,
    approverUserId: row.approver_user_id,
    status: row.status,
    signalDecided: row.signal_decided,
    tailoring: row.tailoring,
    orderVersion: row.order_version,
    version: row.version,
    deleted: row.deleted,
    issueNo: row.issue_no,
    targetRepoId: row.target_repo_id ?? null,
  };
}

export function statusSince(row: RequestRow): Date {
  return row.status_since ?? row.created_at;
}

export interface ListFilters {
  q?: string;
  dept?: string;
  status?: string;
  /** 画面の「信号の色」の絞り込み。承認者の決定（signal_decided）→候補色の順で1つに決まる。 */
  signal?: string;
  includeDeleted?: boolean;
  applicantUserId?: string;
  approverUserId?: string;
  order?: 'newest' | 'oldest';
  limit?: number;
  /** ページの先頭から読み飛ばす行数（SQL の OFFSET）。一覧のページ取得に使う。 */
  offset?: number;
}

/**
 * 信号の色（`signalDecided ?? suggested`）を SQL で表した式。
 *
 * 候補色の正本は `shared/domain.ts` の `evaluateSignal`（詳細仕様書 3-4、R1〜R6）。
 * 赤まで上げるのは R1（`decides = 'r'`）と R2（カタログの色が赤）の 2 つ。
 * R2 が黄・赤のとき、および R3〜R6（データ・社外・安全）は黄まで。
 * 「引き上げるだけ（下げない）」なので、最大値を取る CASE と等しくなる。
 *
 * `decides` / `catalog_tool.signal` は CHECK 制約で g/y/r に限られ、`parties` は NOT NULL で
 * 'internal' が既定なので、JS の `?? 'internal'` と同じ結果になる。データと承認の配列は
 * `DATA_HANDLING` / `SAFETY_APPROVALS` をパラメータで渡し、条件の二重定義を作らない
 * （未知の値は JS と同じく「該当なし」）。`catalog_tool` は別名 `t` で結合済みであること。
 *
 * @param dataIdx `$n` に置く DATA_HANDLING のキー配列（text[]）の位置
 * @param safetyIdx `$n` に置く SAFETY_APPROVALS の配列（text[]）の位置
 */
export function suggestedSignalCaseSql(dataIdx: number, safetyIdx: number): string {
  return `case
      when r.decides = 'r' or t.signal = 'r' then 'r'
      when r.decides = 'y' or t.signal = 'y'
        or r.data_handling && $${dataIdx}::text[]
        or r.parties <> 'internal'
        or r.requires_human_approval && $${safetyIdx}::text[]
      then 'y'
      else 'g'
    end`;
}

/** 候補色の判定に使う配列パラメータ。SQL 式とセットで使う（順序は suggestedSignalCaseSql に合わせる）。 */
export function suggestedSignalParams(): [string[], string[]] {
  return [DATA_HANDLING.map((d) => d.key), [...SAFETY_APPROVALS]];
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
  if (filters.signal) {
    // 画面の色の絞り込み（L-08）。取得後に JS で全件を濾さず、候補色の計算ごと SQL に寄せる。
    // 未知の値（'x' や 'g,r'）は今までどおり「該当なし」になる（比較は等値だけ）。
    const [dataKeys, safety] = suggestedSignalParams();
    params.push(dataKeys);
    const dataIdx = params.length;
    params.push(safety);
    const safetyIdx = params.length;
    params.push(filters.signal);
    where.push(`coalesce(r.signal_decided, ${suggestedSignalCaseSql(dataIdx, safetyIdx)}) = $${params.length}`);
  }

  // 件数は LIMIT/OFFSET を付ける前の条件だけで数える（ページングの整合）。
  const countParams = params.slice();
  const countJoin = filters.signal ? ' left join catalog_tool t on t.id = r.tool_id' : '';
  const countRow = await one<{ count: number }>(
    `select count(*)::int as count from request r${countJoin} where ${where.map((w) => w.replace(/\br\./g, 'r.')).join(' and ')}`,
    countParams,
  );

  const order = filters.order === 'oldest' ? 'asc' : 'desc';
  const limit = filters.limit ?? 5000;
  const offset = Math.max(0, filters.offset ?? 0);
  params.push(limit);
  let paging = `limit $${params.length}`;
  if (offset > 0) {
    params.push(offset);
    paging += ` offset $${params.length}`;
  }
  const rows = await many<RequestRow>(
    // created_at だけでは同じ時刻の行の順序が不定になり、ページの継ぎ目で行が重複・欠落する。
    // id を第2キーにして安定させる（第1キーの並びは変えない）。
    `${SELECT_BASE} where ${where.join(' and ')} order by r.created_at ${order}, r.id ${order} ${paging}`,
    params,
  );
  return { rows, total: countRow?.count ?? rows.length };
}

export async function getRequestRow(id: string, includeDeleted = true): Promise<RequestRow | null> {
  const result = await query<RequestRow>(`${SELECT_BASE} where r.id = $1 ${includeDeleted ? '' : 'and r.deleted = false'}`, [id]);
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
