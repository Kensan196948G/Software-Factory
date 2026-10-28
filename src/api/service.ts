import type { PoolClient } from 'pg';
import { one, query, withTransaction } from './db.js';
import { config, loadConfig } from './config.js';
import { ApiError, Errors } from './http.js';
import { appendAudit } from './audit.js';
import {
  getCatalogSignals,
  getDepartmentName,
  getRecentHistory,
  getRequestRow,
  getRequestRowForUpdate,
  listComments,
  listHistory,
  listRequests,
  mapRequest,
  statusSince,
  type RequestRow,
} from './repo.js';
import {
  CLOSED_STATUSES,
  DATA_HANDLING,
  NEXT_STATUS,
  SIGNAL_LABEL,
  STATUS_LABEL,
  checkCriteria,
  computeMeasure,
  computeScore,
  evaluateSignal,
  formatJstDateTime,
  isReasonRequired,
  preApprovalChecklist,
  rewriteGroupsFor,
  roleCanTransition,
  staleDays,
  staleLevel,
  transitionOptions,
  validateApproval,
  yourTurn,
} from '../shared/domain.js';
import type { Role, Signal, Status } from '../shared/domain.js';
import type { RequestDetail, RequestRecord, SessionUser } from '../shared/types.js';
import type { RequestInput, TransitionInput } from './schemas.js';
import { buildOrderYaml } from '../shared/order.js';
import { createIssue, isGithubConfigured } from './github.js';
import { buildCsv, buildExportJson, measureOf } from '../shared/export.js';
import { deliverOutboxMail, enqueueApprovalMailInTx, latestMailForRequest } from './mail-outbox.js';

export interface Actor {
  user: SessionUser;
  userId: string;
  role: Role;
  displayName: string;
}

export function actorOf(user: SessionUser): Actor {
  return { user, userId: user.id, role: user.actingRole, displayName: user.displayName };
}

/**
 * 積んだメールを送る（コミット後）。送信の失敗で業務（状態遷移・更新）を失敗させない。
 * 送れなかったときは警告だけ返し、再送は `POST /api/mail/outbox/{id}/retry` で行える。
 */
async function deliverQueuedMail(
  mailId: string,
  warnings: { code: string; message: string }[],
): Promise<void> {
  const delivered = await deliverOutboxMail(mailId).catch(() => null);
  if (delivered?.status === 'sent') return;
  warnings.push({
    code: 'INFO-002',
    message: `承認依頼メールを送れませんでした（あとで再送できます）: ${delivered?.error ?? '送信できませんでした'}`,
  });
}

const runtime = loadConfig();

async function catalogSignalFor(row: { tool_id: string | null }, cache?: Map<string, Signal>): Promise<Signal | null> {
  if (!row.tool_id) return null;
  if (cache?.has(row.tool_id)) return cache.get(row.tool_id) ?? null;
  const map = await getCatalogSignals([row.tool_id]);
  const signal = map.get(row.tool_id) ?? null;
  if (cache) cache.set(row.tool_id, signal as Signal);
  return signal;
}

function suggestedOf(row: RequestRow, catalogSignal: Signal | null) {
  return evaluateSignal({
    decides: row.decides,
    catalogSignal,
    dataHandling: row.data_handling,
    parties: row.parties,
    approvals: row.requires_human_approval,
  });
}

async function toDetail(row: RequestRow, actor: Actor): Promise<RequestDetail> {
  const catalogSignal = await catalogSignalFor(row);
  const suggested = suggestedOf(row, catalogSignal);
  const isOwner = Boolean(row.applicant_user_id && row.applicant_user_id === actor.userId);
  const t = yourTurn(row.status, { role: actor.role, userId: actor.userId, displayName: actor.displayName }, {
    applicantUserId: row.applicant_user_id,
    approverUserId: row.approver_user_id,
  });
  const record = mapRequest(row);
  const days = staleDays(statusSince(row));

  return {
    ...record,
    history: await listHistory(row.id),
    comments: await listComments(row.id),
    suggested: { color: suggested.color, reasons: suggested.reasons },
    measure: computeMeasure({ people: row.people, frequency: row.frequency, minutesPerTime: row.minutes_per_time }),
    score: computeScore({
      people: row.people,
      frequency: row.frequency,
      minutesPerTime: row.minutes_per_time,
      signal: suggested.color,
      dataReady: row.data_ready,
      spread: row.spread,
    }),
    staleDays: days,
    staleLevel: staleLevel(days),
    yourTurn: { target: t.target, action: t.action },
    transitions: transitionOptions(
      row.status,
      { role: actor.role, userId: actor.userId, displayName: actor.displayName },
      { requestId: row.id, applicantUserId: row.applicant_user_id, approverUserId: row.approver_user_id, approverName: row.approver },
      isOwner,
    ),
    criteriaChecks: row.criteria.map((text) => {
      const check = checkCriteria(text);
      return { text, kind: check.kind, message: check.message, vagueWords: check.vagueWords, rewrites: rewriteGroupsFor(text) };
    }),
    approverIsMe: !row.approver_user_id || row.approver_user_id === actor.userId,
    isOwner,
    mail: await latestMailForRequest(row.id),
  };
}

function summaryOf(row: RequestRow, catalogSignal: Signal | null, actor: Actor): RequestRecord & {
  suggested: Signal;
  measure: number;
  staleDays: number;
  staleLevel: string;
  yourTurn: { target: boolean; action: string };
  nextBy: Role | undefined;
  approverIsMe: boolean;
} {
  const suggested = suggestedOf(row, catalogSignal);
  const t = yourTurn(row.status, { role: actor.role, userId: actor.userId, displayName: actor.displayName }, {
    applicantUserId: row.applicant_user_id,
    approverUserId: row.approver_user_id,
  });
  const days = staleDays(statusSince(row));
  return {
    ...mapRequest(row),
    suggested: suggested.color,
    measure: computeMeasure({ people: row.people, frequency: row.frequency, minutesPerTime: row.minutes_per_time }),
    staleDays: days,
    staleLevel: staleLevel(days),
    yourTurn: { target: t.target, action: t.action },
    nextBy: NEXT_BY_SAFE(row.status),
    approverIsMe: !row.approver_user_id || row.approver_user_id === actor.userId,
  };
}

function NEXT_BY_SAFE(status: Status): Role | undefined {
  const map: Partial<Record<Status, Role>> = {
    received: 'desk',
    review: 'desk',
    wait: 'approver',
    approved: 'desk',
    dev: 'desk',
    verify: 'desk',
    field: 'desk',
    release_wait: 'approver',
    back: 'requester',
  };
  return map[status];
}

/* ─────────────────────────── 参照 ─────────────────────────── */

export async function getDetail(id: string, actor: Actor): Promise<RequestDetail> {
  const row = await getRequestRow(id, true);
  if (!row) throw Errors.notFound('依頼');
  return toDetail(row, actor);
}

export interface ListQuery {
  q?: string;
  dept?: string;
  status?: string;
  signal?: string;
  mine?: boolean;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listForActor(actor: Actor, filter: ListQuery) {
  const { rows } = await listRequests({
    q: filter.q,
    dept: filter.dept,
    status: filter.status,
    includeDeleted: filter.includeDeleted,
    applicantUserId: filter.mine ? actor.userId : undefined,
    limit: 5000,
  });
  const cache = new Map<string, Signal>();
  const signals = await getCatalogSignals(rows.map((r) => r.tool_id).filter((v): v is string => Boolean(v)));
  for (const [k, v] of signals) cache.set(k, v);

  let summaries = rows.map((r) => summaryOf(r, r.tool_id ? (cache.get(r.tool_id) ?? null) : null, actor));
  if (filter.signal) {
    summaries = summaries.filter((s) => (s.signalDecided ?? s.suggested) === filter.signal);
  }
  const total = summaries.length;
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 500);
  const page = Math.max(filter.page ?? 1, 1);
  const start = (page - 1) * pageSize;
  return { items: summaries.slice(start, start + pageSize), total, page, pageSize };
}

export async function homeFor(actor: Actor) {
  const { rows } = await listRequests({ limit: 5000 });
  const cache = new Map<string, Signal>();
  const signals = await getCatalogSignals(rows.map((r) => r.tool_id).filter((v): v is string => Boolean(v)));
  for (const [k, v] of signals) cache.set(k, v);

  const summaries = rows.map((r) => summaryOf(r, r.tool_id ? (cache.get(r.tool_id) ?? null) : null, actor));
  const active = summaries.filter((s) => !CLOSED_STATUSES.includes(s.status as Status));

  const turn = summaries
    .filter((s) => s.yourTurn.target)
    .sort((a, b) => b.staleDays - a.staleDays);

  const staleOthers = active
    .filter((s) => s.staleDays >= 3 && !s.yourTurn.target)
    .sort((a, b) => b.staleDays - a.staleDays)
    .slice(0, 6);

  const myRequests = summaries
    .filter((s) => s.applicantUserId === actor.userId && !s.yourTurn.target && !CLOSED_STATUSES.includes(s.status as Status))
    .slice(0, 6);

  const waitingApproval = active.filter((s) => s.status === 'wait' && s.approverIsMe).length;
  const draft = await one<{ user_id: string }>('select user_id from draft where user_id = $1', [actor.userId]);

  return {
    role: actor.role,
    counts: {
      yourTurn: turn.length,
      waitingApproval,
      stale3: active.filter((s) => s.staleDays >= 3).length,
      total: summaries.length,
      draft: Boolean(draft),
    },
    yourTurn: turn.slice(0, 20),
    staleOthers,
    myRequests,
    recent: await getRecentHistory(8),
  };
}

export async function getOrder(id: string, actor: Actor): Promise<{ yaml: string; version: number }> {
  const row = await getRequestRow(id);
  if (!row) throw Errors.notFound('依頼');
  if (!row.signal_decided || row.order_version < 1 || ['received', 'review', 'wait', 'back', 'hold', 'cancel'].includes(row.status)) {
    throw Errors.orderNotApproved();
  }
  const catalogSignal = await catalogSignalFor(row);
  const suggested = suggestedOf(row, catalogSignal);
  const departmentName = row.dept_name ?? (await getDepartmentName(row.dept_code)) ?? row.dept_code;
  const yaml = buildOrderYaml({
    request: mapRequest(row),
    suggested: suggested.color,
    departmentName,
    catalogToolName: row.tool_name ?? '',
  });
  void actor;
  return { yaml, version: row.order_version };
}

/* ─────────────────────────── 作成・更新 ─────────────────────────── */

function nextJstYear(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(new Date()));
}

async function allocateId(client: PoolClient): Promise<{ id: string; seq: number; year: number }> {
  const year = nextJstYear();
  // 既存データの最大値も考慮する（seed 済みDBや取込後の再開でも衝突させない）
  const result = await client.query<{ last_seq: number }>(
    `insert into request_counter (year, last_seq)
     values ($1, coalesce((select max(seq) from request where year = $1), 0) + 1)
     on conflict (year) do update
       set last_seq = greatest(request_counter.last_seq, coalesce((select max(seq) from request where year = $1), 0)) + 1
     returning last_seq`,
    [year],
  );
  const seq = result.rows[0]?.last_seq ?? 0;
  if (seq > 9999) throw Errors.numberingLimit();
  return { id: `REQ-${year}-${String(seq).padStart(4, '0')}`, seq, year };
}

export async function createRequest(
  input: RequestInput,
  actor: Actor,
  correlationId: string,
  idempotencyKey?: string,
): Promise<RequestDetail> {
  const deptName = await getDepartmentName(input.deptCode);
  if (!deptName) throw Errors.notAllowedValue('deptCode');
  if (input.toolId) {
    const tool = await one<{ id: string; dept_code: string }>('select id, dept_code from catalog_tool where id = $1', [input.toolId]);
    if (!tool) throw Errors.notAllowedValue('toolId');
    if (tool.dept_code !== input.deptCode) throw new Error('ERR-013');
  }
  const payloadHash = JSON.stringify(input);

  const result = await withTransaction(async (client) => {
    if (idempotencyKey) {
      const existing = await client.query<{ request_id: string | null; response: { hash?: string } | null }>(
        'select request_id, response from idempotency where key = $1',
        [idempotencyKey],
      );
      const hit = existing.rows[0];
      if (hit) {
        if (hit.response?.hash && hit.response.hash !== undefined && hit.response.hash !== hashString(payloadHash)) {
          throw Errors.idempotencyConflict();
        }
        if (hit.request_id) return { id: hit.request_id, created: false };
      }
    }

    let allocated: { id: string; seq: number; year: number };
    if (input.clientId) {
      const m = /^REQ-(\d{4})-(\d{4})$/.exec(input.clientId);
      if (m) {
        const year = Number(m[1]);
        const seq = Number(m[2]);
        const exists = await client.query('select 1 from request where id = $1', [input.clientId]);
        if (exists.rowCount === 0) {
          await client.query(
            `insert into request_counter (year, last_seq) values ($1,$2)
             on conflict (year) do update set last_seq = greatest(request_counter.last_seq, $2)`,
            [year, seq],
          );
          allocated = { id: input.clientId, seq, year };
        } else {
          allocated = await allocateId(client);
        }
      } else {
        allocated = await allocateId(client);
      }
    } else {
      allocated = await allocateId(client);
    }
    const { id, seq, year } = allocated;
    await client.query(
      `insert into request (
        id, seq, year, applicant, applicant_user_id, dept_code, contact, title, kind, tool_id,
        problem, purpose, users, people, places, scope, out_of_scope, criteria, decides, data_handling,
        parties, constraints, constraints_other, requires_human_approval, frequency, minutes_per_time,
        data_ready, spread, wish_date, approver, approver_user_id, status, created_by, updated_by
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31,'received',$32,$32
      )`,
      [
        id,
        seq,
        year,
        input.applicant,
        actor.userId,
        input.deptCode,
        input.contact ?? null,
        input.title,
        input.kind,
        input.toolId ?? null,
        input.problem,
        input.purpose,
        input.users,
        input.people ?? null,
        input.places,
        input.scope,
        input.outOfScope,
        input.criteria.map((c) => c.trim()).filter(Boolean),
        input.decides,
        input.dataHandling,
        input.parties,
        input.constraints,
        input.constraintsOther,
        input.approvals,
        input.frequency ?? null,
        input.minutesPerTime ?? null,
        input.dataReady ?? null,
        input.spread ?? null,
        input.wishDate ?? null,
        input.approver,
        null,
        actor.userId,
      ],
    );
    await client.query(
      `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.displayName, actor.userId, actor.role, '受付', '依頼を登録しました', correlationId],
    );
    if (idempotencyKey) {
      await client.query('insert into idempotency (key, scope, request_id, response) values ($1,$2,$3,$4)', [
        idempotencyKey,
        'create_request',
        id,
        JSON.stringify({ hash: hashString(payloadHash) }),
      ]);
    }
    await appendAuditInTx(client, actor, {
      action: 'request.create',
      targetType: 'request',
      targetId: id,
      result: 'success',
      correlationId,
      diff: { title: input.title, dept: input.deptCode },
    });
    return { id, created: true };
  });

  const detail = await getDetail(result.id, actor);
  if (!result.created) return detail;
  return detail;
}

function hashString(value: string): string {
  // 暗号強度は不要（同一キーの内容一致判定のみ）。監査ログとは別用途。
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function appendAuditInTx(
  client: PoolClient,
  actor: Actor,
  entry: { action: string; targetType: string; targetId?: string | null; result: 'success' | 'denied' | 'error'; diff?: unknown; correlationId?: string },
): Promise<void> {
  const { appendAuditTx } = await import('./audit.js');
  await appendAuditTx(client, {
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    result: entry.result,
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    diff: entry.diff,
    correlationId: entry.correlationId,
  });
}

export async function updateRequest(
  id: string,
  input: RequestInput,
  actor: Actor,
  version: number,
  correlationId: string,
): Promise<{ detail: RequestDetail; warnings: { code: string; message: string }[] }> {
  const warnings: { code: string; message: string }[] = [];
  let queuedMailId: string | null = null;
  await withTransaction(async (client) => {
    const row = await getRequestRowForUpdate(client, id);
    if (!row) throw Errors.notFound('依頼');
    if (row.version !== version) throw Errors.conflict();

    const isOwner = row.applicant_user_id === actor.userId;
    const editableByOwner = isOwner && ['received', 'back'].includes(row.status);
    const editableByStaff = ['desk', 'approver'].includes(actor.role) && ['received', 'review', 'wait'].includes(row.status);
    if (!editableByOwner && !editableByStaff) throw Errors.noPermission();
    if (['done', 'hold', 'cancel'].includes(row.status)) throw Errors.noPermission();

    const afterApproval = ['approved', 'dev', 'verify', 'field', 'release_wait'].includes(row.status);
    const nextStatus = afterApproval ? 'wait' : row.status;
    const signal = afterApproval ? null : row.signal_decided;
    if (afterApproval) warnings.push({ code: 'ERR-202', message: '承認後に内容を変えたため、承認をやり直す必要があります' });

    await client.query(
      `update request set
        applicant=$2, dept_code=$3, contact=$4, title=$5, kind=$6, tool_id=$7,
        problem=$8, purpose=$9, users=$10, people=$11, places=$12, scope=$13, out_of_scope=$14,
        criteria=$15, decides=$16, data_handling=$17, parties=$18, constraints=$19, constraints_other=$20,
        requires_human_approval=$21, frequency=$22, minutes_per_time=$23, data_ready=$24, spread=$25,
        wish_date=$26, approver=$27, status=$28, signal_decided=$29, order_version=order_version + $30,
        version=version+1, updated_at=now(), updated_by=$31
      where id=$1`,
      [
        id,
        input.applicant,
        input.deptCode,
        input.contact ?? null,
        input.title,
        input.kind,
        input.toolId ?? null,
        input.problem,
        input.purpose,
        input.users,
        input.people ?? null,
        input.places,
        input.scope,
        input.outOfScope,
        input.criteria.map((c) => c.trim()).filter(Boolean),
        input.decides,
        input.dataHandling,
        input.parties,
        input.constraints,
        input.constraintsOther,
        input.approvals,
        input.frequency ?? null,
        input.minutesPerTime ?? null,
        input.dataReady ?? null,
        input.spread ?? null,
        input.wishDate ?? null,
        input.approver,
        nextStatus,
        signal,
        afterApproval ? 1 : 0,
        actor.userId,
      ],
    );
    await client.query(
      `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.displayName, actor.userId, actor.role, '内容を編集', afterApproval ? '承認後に編集したため承認待ちへ戻しました' : null, correlationId],
    );
    if (afterApproval) {
      await client.query(
        `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, actor.displayName, actor.userId, actor.role, `状態を「承認待ち」に変更`, '内容の変更により承認を取り消しました', correlationId],
      );
      // 承認を取り消して「承認待ち」へ戻したときも、承認者へ依頼メールを送る
      queuedMailId = await enqueueApprovalMailInTx(
        client,
        {
          id,
          title: input.title,
          applicant: input.applicant,
          deptCode: input.deptCode,
          approver: input.approver,
          approverUserId: row.approver_user_id,
          signal,
          criteriaCount: input.criteria.filter((c) => c.trim()).length,
        },
        actor,
        correlationId,
      );
    }
    await appendAuditInTx(client, actor, {
      action: 'request.update',
      targetType: 'request',
      targetId: id,
      result: 'success',
      correlationId,
      diff: { version, afterApproval },
    });
  });
  if (queuedMailId) await deliverQueuedMail(queuedMailId, warnings);
  return { detail: await getDetail(id, actor), warnings };
}

/* ─────────────────────────── 状態遷移・承認 ─────────────────────────── */

export async function performTransition(
  id: string,
  input: TransitionInput,
  actor: Actor,
  correlationId: string,
): Promise<{ detail: RequestDetail; warnings: { code: string; message: string }[] }> {
  const warnings: { code: string; message: string }[] = [];
  let queuedMailId: string | null = null;
  await withTransaction(async (client) => {
    const row = await getRequestRowForUpdate(client, id);
    if (!row) throw Errors.notFound('依頼');
    if (row.version !== input.version) throw Errors.conflict();
    if (row.status === input.to) throw Errors.invalidTransition('いまの状態です');

    const isOwner = row.applicant_user_id === actor.userId;
    const verdict = roleCanTransition(
      row.status,
      input.to,
      { role: actor.role, userId: actor.userId, displayName: actor.displayName },
      { requestId: row.id, applicantUserId: row.applicant_user_id, approverUserId: row.approver_user_id, approverName: row.approver },
      isOwner,
    );
    if (!verdict.allowed) throw Errors.invalidTransition(verdict.reason ?? 'その状態へは変更できません');

    const reason = (input.reason ?? '').trim();
    if (isReasonRequired(row.status, input.to) && reason === '') throw Errors.reasonRequired();

    const nextStatus: Status = input.to;
    let noteParts: string[] = [];
    let decided: Signal | null = row.signal_decided;
    let tailoring = row.tailoring;
    let orderVersion = row.order_version;
    let deleted = row.deleted;

    if (input.to === 'approved') {
      const catalogSignal = await catalogSignalFor(row);
      const suggested = suggestedOf(row, catalogSignal).color;
      const decidedSignal = input.signal;
      if (!decidedSignal) throw Errors.signalIncomplete('信号の色を選んでください');

      if (!runtime.allowSelfApproval && row.applicant_user_id === actor.userId) throw Errors.selfApproval();

      const checklist = preApprovalChecklist({
        criteria: row.criteria,
        outOfScope: row.out_of_scope,
        dataHandling: row.data_handling,
        parties: row.parties,
        approvals: row.requires_human_approval,
        decides: row.decides,
        suggested,
      });
      const validation = validateApproval({
        criteria: row.criteria,
        outOfScope: row.out_of_scope,
        dataHandling: row.data_handling,
        parties: row.parties,
        approvals: row.requires_human_approval,
        decides: row.decides,
        suggested,
        decided: decidedSignal,
        checklistAcknowledged: input.checklistAcknowledged ?? false,
        redAcknowledged: input.redAcknowledged ?? false,
        reason,
      });
      if (!validation.ok) {
        const message = validation.errors[0] ?? '信号の色を選んでください';
        if (message.includes('理由')) throw Errors.reasonRequired();
        throw Errors.signalIncomplete(message);
      }

      decided = decidedSignal;
      tailoring = input.tailoring ?? row.tailoring ?? null;
      orderVersion = row.order_version + 1;
      const warns = checklist.filter((i) => i.visible && i.status === 'warn').length;
      noteParts = [
        `信号の色を「${SIGNAL_LABEL[decidedSignal]}」に決定`,
        ...(decidedSignal !== suggested ? [`（候補は「${SIGNAL_LABEL[suggested]}」）`] : []),
        ...(warns > 0 ? [`承認前チェック △${warns}件を確認`] : []),
        ...(reason ? [reason] : []),
      ];
      await client.query(
        `insert into approval (request_id, approver_name, approver_user_id, decision, reason, decided_signal, suggested_signal, checklist, order_version)
         values ($1,$2,$3,'approved',$4,$5,$6,$7,$8)`,
        [
          id,
          actor.displayName,
          actor.userId,
          reason || null,
          decidedSignal,
          suggested,
          JSON.stringify(checklist),
          orderVersion,
        ],
      );
    } else if (input.to === 'back') {
      await client.query(
        `insert into approval (request_id, approver_name, approver_user_id, decision, reason, suggested_signal, checklist, order_version)
         values ($1,$2,$3,'returned',$4,$5,'[]'::jsonb,$6)`,
        [id, actor.displayName, actor.userId, reason, row.signal_decided, row.order_version],
      );
    } else if (input.to === 'hold') {
      await client.query(
        `insert into approval (request_id, approver_name, approver_user_id, decision, reason, suggested_signal, checklist, order_version)
         values ($1,$2,$3,'held',$4,$5,'[]'::jsonb,$6)`,
        [id, actor.displayName, actor.userId, reason, row.signal_decided, row.order_version],
      );
    } else if (input.to === 'cancel') {
      deleted = true;
    }

    await client.query(
      `update request set status=$2, signal_decided=$3, tailoring=$4, order_version=$5, deleted=$6,
              version=version+1, updated_at=now(), updated_by=$7
        where id=$1`,
      [id, nextStatus, decided, tailoring, orderVersion, deleted, actor.userId],
    );

    const note = noteParts.join('／') || reason || null;
    await client.query(
      `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.displayName, actor.userId, actor.role, `状態を「${STATUS_LABEL[input.to]}」に変更`, note, correlationId],
    );
    if (reason) {
      await client.query(`insert into comment (request_id, by_name, by_user_id, body) values ($1,$2,$3,$4)`, [
        id,
        actor.displayName,
        actor.userId,
        reason,
      ]);
    }
    await appendAuditInTx(client, actor, {
      action: 'request.transition',
      targetType: 'request',
      targetId: id,
      result: 'success',
      correlationId,
      diff: { from: row.status, to: input.to, reason: reason || null, signal: decided },
    });
    // 承認待ちになったら、承認依頼メールを同じトランザクションで積む（送信はコミット後）。
    if (nextStatus === 'wait') {
      queuedMailId = await enqueueApprovalMailInTx(
        client,
        {
          id,
          title: row.title,
          applicant: row.applicant,
          deptCode: row.dept_code,
          approver: row.approver,
          approverUserId: row.approver_user_id,
          signal: decided,
          criteriaCount: row.criteria.length,
        },
        actor,
        correlationId,
      );
    }
    if (input.to === 'cancel') warnings.push({ code: 'INFO-001', message: '取消にしました。データは残り、一覧の表示切替で確認できます' });
  });

  if (queuedMailId) await deliverQueuedMail(queuedMailId, warnings);

  return { detail: await getDetail(id, actor), warnings };
}

export async function addComment(id: string, text: string, actor: Actor, correlationId: string) {
  const row = await getRequestRow(id);
  if (!row) throw Errors.notFound('依頼');
  await withTransaction(async (client) => {
    await client.query(`insert into comment (request_id, by_name, by_user_id, body) values ($1,$2,$3,$4)`, [
      id,
      actor.displayName,
      actor.userId,
      text,
    ]);
    await client.query('update request set updated_at = now() where id = $1', [id]);
    await appendAuditInTx(client, actor, {
      action: 'request.comment',
      targetType: 'request',
      targetId: id,
      result: 'success',
      correlationId,
    });
  });
  return { detail: await getDetail(id, actor) };
}

/* ─────────────────────────── 下書き ─────────────────────────── */

export async function getDraft(userId: string) {
  return one<{ payload: unknown; step: number; edit_id: string | null; saved_at: Date }>(
    'select payload, step, edit_id, saved_at from draft where user_id = $1',
    [userId],
  );
}

export async function putDraft(userId: string, payload: unknown, step: number, editId: string | null) {
  await query(
    `insert into draft (user_id, payload, step, edit_id, saved_at) values ($1,$2,$3,$4,now())
     on conflict (user_id) do update set payload=$2, step=$3, edit_id=$4, saved_at=now()`,
    [userId, JSON.stringify(payload), step, editId],
  );
  return { ok: true };
}

export async function deleteDraft(userId: string) {
  await query('delete from draft where user_id = $1', [userId]);
  return { ok: true };
}

/* ─────────────────────────── 入出力 ─────────────────────────── */

/** 運用・DevOps・SecOps の状態を取得する（無ければ null）。 */
export async function getOpsState(): Promise<{ data: unknown; version: number } | null> {
  const row = await one<{ data: unknown; version: number }>('select data, version from ops_state where id = 1');
  return row ? { data: row.data, version: row.version } : null;
}

/** 運用・DevOps・SecOps の状態を保存する（単一ドキュメント・バージョン付き）。 */
export async function saveOpsState(data: unknown, actor: Actor, correlationId: string): Promise<{ version: number }> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw Errors.shape('ops');
  }
  const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (size > 1_500_000) throw Errors.tooLong('ops');
  return withTransaction(async (client) => {
    const result = await client.query<{ version: number }>(
      `insert into ops_state (id, data, version, updated_at, updated_by)
       values (1, $1, 1, now(), $2)
       on conflict (id) do update set data = excluded.data, version = ops_state.version + 1, updated_at = now(), updated_by = excluded.updated_by
       returning version`,
      [JSON.stringify(data), actor.userId],
    );
    await appendAuditInTx(client, actor, {
      action: 'ops.save',
      targetType: 'ops_state',
      targetId: '1',
      result: 'success',
      correlationId,
      diff: { bytes: size },
    });
    return { version: result.rows[0]?.version ?? 1 };
  });
}

/** 画面起動用のデータ（履歴・コメントを含む）。監査ログには記録しない。 */
export async function getBootData(userId: string): Promise<{ seq: number; items: unknown[]; draft: unknown; ops: unknown }> {
  const { rows } = await listRequests({ limit: 5000 });
  const items = [];
  for (const row of rows) {
    items.push({
      ...mapRequest(row),
      suggested: suggestedOf(row, await catalogSignalFor(row)).color,
      history: await listHistory(row.id),
      comments: await listComments(row.id),
    });
  }
  const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0);
  const draftRow = await one<{ payload: unknown; step: number; edit_id: string | null; saved_at: Date }>(
    'select payload, step, edit_id, saved_at from draft where user_id = $1',
    [userId],
  );
  const ops = await getOpsState();
  return {
    seq,
    items,
    draft: draftRow
      ? { draft: draftRow.payload, step: draftRow.step, editId: draftRow.edit_id, at: draftRow.saved_at.toISOString() }
      : null,
    ops: ops ? { data: ops.data, version: ops.version } : null,
  };
}

export async function exportAll(actor: Actor) {
  const { rows } = await listRequests({ limit: 5000 });
  const signals = await getCatalogSignals(rows.map((r) => r.tool_id).filter((v): v is string => Boolean(v)));
  const records = rows.map((r) => mapRequest(r));
  const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0);
  const json = buildExportJson(records, seq);
  const csv = buildCsv(
    rows.map((r) => ({
      request: mapRequest(r),
      suggested: (r.tool_id ? signals.get(r.tool_id) : null) ?? suggestedOf(r, null).color,
      deptName: r.dept_name ?? r.dept_code,
      measure: measureOf(mapRequest(r)),
    })),
  );
  await appendAudit({
    action: 'data.export',
    targetType: 'request',
    result: 'success',
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    diff: { count: records.length },
  }).catch(() => undefined);
  return { json, csv, count: records.length };
}

export async function importAll(payload: { items: Record<string, unknown>[]; seq?: number }, actor: Actor, correlationId: string) {
  if (!runtime.allowImport) throw Errors.noPermission();
  return withTransaction(async (client) => {
    await client.query('delete from request');
    await client.query('delete from request_counter');
    let maxSeq = 0;
    for (const item of payload.items) {
      const record = item as unknown as RequestRecord;
      const id = String(record.id ?? '');
      const match = /^REQ-(\d{4})-(\d{4})$/.exec(id);
      if (!match) throw Errors.importInvalid();
      const year = Number(match[1]);
      const seq = Number(match[2]);
      maxSeq = Math.max(maxSeq, seq);
      const dept = await client.query('select code from department where code = $1', [String(record.deptCode ?? '')]);
      if (dept.rowCount === 0) throw Errors.importInvalid();
      await client.query(
        `insert into request (id, seq, year, applicant, dept_code, contact, title, kind, tool_id, problem, purpose,
          users, people, places, scope, out_of_scope, criteria, decides, data_handling, parties, constraints,
          constraints_other, requires_human_approval, frequency, minutes_per_time, data_ready, spread, wish_date,
          approver, status, signal_decided, tailoring, order_version, version, deleted, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)`,
        [
          id,
          seq,
          year,
          String(record.applicant ?? ''),
          String(record.deptCode ?? ''),
          record.contact ?? null,
          String(record.title ?? ''),
          String(record.kind ?? 'new_tool'),
          record.toolId ?? null,
          String(record.problem ?? ''),
          String(record.purpose ?? ''),
          Array.isArray(record.users) ? record.users : [],
          record.people ?? null,
          Array.isArray(record.places) ? record.places : [],
          Array.isArray(record.scope) ? record.scope : ['未設定'],
          Array.isArray(record.outOfScope) ? record.outOfScope : [],
          Array.isArray(record.criteria) ? record.criteria : ['未設定'],
          String(record.decides ?? 'g'),
          Array.isArray(record.dataHandling) ? record.dataHandling : [],
          String(record.parties ?? 'internal'),
          Array.isArray(record.constraints) ? record.constraints : [],
          Array.isArray(record.constraintsOther) ? record.constraintsOther : [],
          Array.isArray(record.approvals) ? record.approvals : [],
          record.frequency ?? null,
          record.minutesPerTime ?? null,
          record.dataReady ?? null,
          record.spread ?? null,
          record.wishDate ?? null,
          String(record.approver ?? ''),
          String(record.status ?? 'received'),
          record.signalDecided ?? null,
          record.tailoring ?? null,
          Number(record.orderVersion ?? 0),
          Number(record.version ?? 1),
          Boolean(record.deleted ?? false),
          record.createdAt ? new Date(String(record.createdAt)) : new Date(),
          record.updatedAt ? new Date(String(record.updatedAt)) : new Date(),
        ],
      );
      await client.query(
        `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
         values ($1,$2,$3,'system','受付','取込',$4)`,
        [id, actor.displayName, actor.userId, correlationId],
      );
    }
    const year = nextJstYear();
    const maxAll = Math.max(maxSeq, Number(payload.seq ?? 0));
    await client.query(
      `insert into request_counter (year, last_seq) values ($1,$2)
       on conflict (year) do update set last_seq = greatest(request_counter.last_seq, $2)`,
      [year, maxAll],
    );
    await appendAuditInTx(client, actor, {
      action: 'data.import',
      targetType: 'request',
      result: 'success',
      correlationId,
      diff: { count: payload.items.length },
    });
    return { ok: true, count: payload.items.length };
  });
}

/* ─────────────────────────── 開発ラインへの投入（Issue作成） ─────────────────────────── */

export async function handoffToGithub(
  id: string,
  actor: Actor,
  correlationId: string,
): Promise<{ issueNo: number; issueUrl: string; created: boolean; detail: RequestDetail }> {
  if (!isGithubConfigured()) {
    throw new ApiError('ERR-405', 'GitHub連携が設定されていません（管理者に確認してください）', 409);
  }
  if (!['desk', 'approver'].includes(actor.role)) throw Errors.noPermission();

  const row = await getRequestRow(id);
  if (!row) throw Errors.notFound('依頼');
  if (!row.signal_decided || row.order_version < 1 || ['received', 'review', 'wait', 'back', 'hold', 'cancel'].includes(row.status)) {
    throw Errors.orderNotApproved();
  }
  if (row.issue_no) {
    return { issueNo: row.issue_no, issueUrl: `https://github.com/${config.githubRepo}/issues/${row.issue_no}`, created: false, detail: await getDetail(id, actor) };
  }

  const catalogSignal = await catalogSignalFor(row);
  const suggested = suggestedOf(row, catalogSignal);
  const departmentName = row.dept_name ?? (await getDepartmentName(row.dept_code)) ?? row.dept_code;
  const yaml = buildOrderYaml({
    request: mapRequest(row),
    suggested: suggested.color,
    departmentName,
    catalogToolName: row.tool_name ?? '',
  });

  const issue = await createIssue({
    requestId: id,
    title: `[MSF] ${id} ${row.title}`,
    orderYaml: yaml,
    approver: row.approver,
    signalLabel: SIGNAL_LABEL[(row.signal_decided ?? suggested.color) as Signal],
    deptLabel: departmentName,
    tailoring: row.tailoring,
    previewUrl: config.appBaseUrl,
  });

  await withTransaction(async (client) => {
    const locked = await getRequestRowForUpdate(client, id);
    if (!locked) throw Errors.notFound('依頼');
    if (locked.issue_no) return; // 同時実行で先に作られた場合は何もしない
    await client.query('update request set issue_no = $2, version = version + 1, updated_at = now(), updated_by = $3 where id = $1', [
      id,
      issue.number,
      actor.userId,
    ]);
    await client.query(
      `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
       values ($1,$2,$3,$4,'開発ラインへ投入',$5,$6)`,
      [id, actor.displayName, actor.userId, actor.role, `GitHub Issue #${issue.number} を作成しました`, correlationId],
    );
    await appendAuditInTx(client, actor, {
      action: 'request.handoff',
      targetType: 'request',
      targetId: id,
      result: 'success',
      correlationId,
      diff: { issue: issue.number },
    });
  });

  return { issueNo: issue.number, issueUrl: issue.url, created: true, detail: await getDetail(id, actor) };
}

/* ─────────────────────────── デモ初期化（開発・検証用） ─────────────────────────── */

export async function resetDemo(actor: Actor, correlationId: string) {
  if (runtime.isProduction) throw Errors.noPermission();
  const { seedDemo } = await import('./seed.js');
  return withTransaction(async (client) => {
    await client.query('delete from request');
    await client.query('delete from request_counter');
    await seedDemo(client);
    await appendAuditInTx(client, actor, {
      action: 'data.reset_demo',
      targetType: 'request',
      result: 'success',
      correlationId,
    });
    return { ok: true };
  });
}

export const APPROVER_SEED = ['鈴木 一郎', '田中 誠司', '松本 綾'];
export const DATA_HANDLING_LABELS = DATA_HANDLING;
export const NEXT = NEXT_STATUS;
export const FORMAT_DATE = formatJstDateTime;
export const SELF_APPROVAL_ALLOWED = (): boolean => config.allowSelfApproval;
