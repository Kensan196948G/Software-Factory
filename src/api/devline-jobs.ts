/**
 * 実行ジョブ（ENT-08）の永続層。claim / lease / heartbeat / fencing、人の取消・再開、読み取り。
 *
 * 規則（docs/devline/api-contract.md）:
 * - lease の持ち主の書き込みは必ず `where id=$ and fencing_token=$ and state=$expected`。
 *   rowCount 0 は例外にせず applied:false で返し、別トランザクションで event と監査に残す。
 * - lease の持ち主でない処理（人の取消・再開、検証結果の取込、新しい版の確定）が状態を動かすときは、
 *   fencing_token を +1 して lease を外す。動いている worker の書き込みはそこで無効になる。
 * - 時刻は引数で受ける。判断に壁時計や SQL の now() を使わない。
 * - 外部呼び出しをトランザクションの中で行わない（appendAuditTx が advisory lock を取るため）。
 */
import type { PoolClient, QueryResult } from 'pg';
import { query, withTransaction } from './db.js';
import { appendAudit, appendAuditTx } from './audit.js';
import { Errors } from './http.js';
import type { Actor } from './service.js';
import {
  DEVLINE_POLICY,
  JOB_HALTED_STATES,
  JOB_RUNNABLE_STATES,
  cancelDecision,
  canOperateJob,
  haltTarget,
  isOrderCurrent,
  isPhase1Transition,
  resumeDecision,
} from '../shared/devline.js';
import type {
  FencedWrite,
  JobLease,
  JobState,
  JobView,
  RunnerKind,
  RunnerResult,
  RunnerStep,
  StopReason,
} from '../shared/devline.js';
import { createHash } from 'node:crypto';
import type { Status } from '../shared/domain.js';

export interface JobRow {
  id: string;
  snapshot_id: string;
  request_id: string;
  order_version: number;
  target_repo_id: string;
  handoff_intent_id: string;
  state: JobState;
  policy_version: string;
  runner_kind: RunnerKind;
  plan: unknown;
  work_state: Record<string, unknown>;
  head_sha: string | null;
  repair_count_total: number;
  repair_count_by_cause: Record<string, number>;
  ci_rerun_count: number;
  session_started_at: Date | null;
  continuous_seconds: number;
  cost_jpy: number;
  usage: Record<string, unknown>;
  stop_reason: StopReason | null;
  stop_detail: unknown;
  remaining_work: unknown;
  resume_to: JobState | null;
  stopped_at: Date | null;
  cancel_requested_at: Date | null;
  cancel_requested_by: string | null;
  superseded_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  fencing_token: number;
  lease_reclaim_count: number;
  created_at: Date;
  updated_at: Date;
}

/** lease の持ち主が transitionJob で更新してよい列。ここに無い列は SQL に入らない。 */
export interface JobPatch {
  plan: unknown;
  workState: Record<string, unknown>;
  headSha: string | null;
  ciRerunCount: number;
}

/** 監査と event に残す主体。worker は system、runner の結果は agent。 */
export interface JobActor {
  type: 'system' | 'agent';
  name: string;
}

export const WORKER_ACTOR: JobActor = { type: 'system', name: 'worker' };

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** session の経過を continuous_seconds へ繰り入れて session を閉じる SQL（ADR 11章）。 */
export function rollSessionSql(nowParam: string): string {
  return `continuous_seconds = continuous_seconds + case when session_started_at is null then 0
            else greatest(0, floor(extract(epoch from (${nowParam}::timestamptz - session_started_at))))::int end,
          session_started_at = null`;
}

export async function insertJobEvent(
  client: PoolClient,
  event: {
    jobId: string;
    at: Date;
    kind: string;
    from?: JobState | null;
    to?: JobState | null;
    fencingToken?: number | null;
    actorType: 'human' | 'system' | 'agent';
    actorUserId?: string | null;
    correlationId?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await client.query(
    `insert into job_event (job_id, at, kind, from_state, to_state, fencing_token, actor_type, actor_user_id, correlation_id, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      event.jobId,
      event.at,
      event.kind,
      event.from ?? null,
      event.to ?? null,
      event.fencingToken ?? null,
      event.actorType,
      event.actorUserId ?? null,
      event.correlationId ?? null,
      event.detail === undefined ? null : JSON.stringify(event.detail),
    ],
  );
}

function auditActor(actor: JobActor): { actorUserId: null; actorName: string; role: string } {
  return { actorUserId: null, actorName: actor.name, role: actor.type };
}

/** 止まったときに残す回数・時間・費用（FR・ブリーフ「理由・残作業・回数・時間・費用」）。 */
function stopCounters(job: JobRow, now: Date): Record<string, unknown> {
  const session = job.session_started_at ? Math.max(0, Math.floor((now.getTime() - job.session_started_at.getTime()) / 1000)) : 0;
  return {
    repairCountTotal: job.repair_count_total,
    repairCountByCause: job.repair_count_by_cause,
    ciRerunCount: job.ci_rerun_count,
    continuousSeconds: job.continuous_seconds + session,
    costJpy: job.cost_jpy,
  };
}

export function remainingWorkFor(state: JobState): { fromState: JobState; steps: string[] } {
  const order: JobState[] = ['planning', 'implementing', 'verifying', 'pr_ready'];
  if (state === 'queued') return { fromState: state, steps: order };
  if (state === 'revising') return { fromState: state, steps: ['revising', 'verifying', 'pr_ready'] };
  const index = order.indexOf(state);
  return { fromState: state, steps: index >= 0 ? order.slice(index) : [] };
}

/**
 * lease の持ち主でない処理が、行を for update で握ったまま止める。
 * fencing を +1 して lease を外すので、遅れて届く worker の書き込みは捨てられる。
 */
export async function haltLockedJob(
  client: PoolClient,
  job: JobRow,
  input: {
    to: 'stopped' | 'failed' | 'cancelled';
    reason: StopReason;
    detail?: Record<string, unknown>;
    now: Date;
    extraSet?: { cancelBy?: string | null; superseded?: boolean };
  },
): Promise<void> {
  const resumeTo: JobState = input.to === 'cancelled' ? 'queued' : job.state;
  await client.query(
    `update job set state=$2, stop_reason=$3, stop_detail=$4::jsonb, remaining_work=$5::jsonb, stopped_at=$6::timestamptz,
            resume_to=$7, fencing_token=fencing_token+1, lease_owner=null, lease_expires_at=null, updated_at=$6::timestamptz,
            cancel_requested_at = case when $8::boolean then $6::timestamptz else cancel_requested_at end,
            cancel_requested_by = case when $8::boolean then $9::uuid else cancel_requested_by end,
            superseded_at = case when $10::boolean then $6::timestamptz else superseded_at end,
            ${rollSessionSql('$6')}
      where id=$1`,
    [
      job.id,
      input.to,
      input.reason,
      JSON.stringify({ ...(input.detail ?? {}), ...stopCounters(job, input.now) }),
      JSON.stringify(remainingWorkFor(job.state)),
      input.now,
      resumeTo,
      input.extraSet?.cancelBy !== undefined,
      input.extraSet?.cancelBy ?? null,
      input.extraSet?.superseded ?? false,
    ],
  );
}

/* ───────────────────────────── 読み取り ───────────────────────────── */

const VIEW_SELECT = `select j.*, s.content_sha256, r.status as request_status, r.deleted as request_deleted,
       r.order_version as request_order_version
  from job j
  join order_snapshot s on s.id = j.snapshot_id
  join request r on r.id = j.request_id`;

type ViewRow = JobRow & {
  content_sha256: string;
  request_status: Status;
  request_deleted: boolean;
  request_order_version: number;
};

function toView(row: ViewRow): JobView {
  return {
    id: row.id,
    requestId: row.request_id,
    orderVersion: row.order_version,
    state: row.state,
    targetRepoId: row.target_repo_id,
    policyVersion: row.policy_version,
    runnerKind: row.runner_kind,
    contentSha256: row.content_sha256,
    headSha: row.head_sha,
    plan: row.plan,
    workState: row.work_state,
    repairCountTotal: row.repair_count_total,
    repairCountByCause: row.repair_count_by_cause,
    ciRerunCount: row.ci_rerun_count,
    continuousSeconds: row.continuous_seconds,
    costJpy: row.cost_jpy,
    stopReason: row.stop_reason,
    stopDetail: row.stop_detail,
    remainingWork: row.remaining_work,
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    orderCurrent: isOrderCurrent({
      requestStatus: row.request_status,
      requestDeleted: row.request_deleted,
      requestOrderVersion: row.request_order_version,
      jobOrderVersion: row.order_version,
    }),
    leaseHeld: row.lease_owner !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getJobView(jobId: string): Promise<JobView | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await query<ViewRow>(`${VIEW_SELECT} where j.id = $1`, [jobId]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function getJob(jobId: string, _actor: Actor): Promise<JobView> {
  const view = await getJobView(jobId);
  if (!view) throw Errors.notFound('ジョブ');
  return view;
}

export async function listJobsForRequest(requestId: string, _actor: Actor): Promise<JobView[]> {
  const exists = await query('select 1 from request where id = $1', [requestId]);
  if (!exists.rowCount) throw Errors.notFound('依頼');
  const { rows } = await query<ViewRow>(
    `${VIEW_SELECT} where j.request_id = $1 order by j.order_version desc, j.created_at desc`,
    [requestId],
  );
  return rows.map(toView);
}

/* ───────────────────────────── 人の操作 ───────────────────────────── */

async function denyJobOperation(action: string, jobId: string, actor: Actor, correlationId: string): Promise<never> {
  await appendAudit({
    action,
    targetType: 'job',
    targetId: jobId,
    result: 'denied',
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    correlationId,
  });
  throw Errors.noPermission();
}

async function lockJobForOperator(client: PoolClient, jobId: string, expectedState?: JobState): Promise<JobRow> {
  const { rows } = await client.query<JobRow>('select * from job where id = $1 for update', [jobId]);
  const job = rows[0];
  if (!job) throw Errors.notFound('ジョブ');
  if (expectedState !== undefined && job.state !== expectedState) throw Errors.conflict();
  return job;
}

export async function cancelJob(
  input: { jobId: string; reason: string; expectedState?: JobState },
  actor: Actor,
  correlationId: string,
  now: Date,
): Promise<JobView> {
  if (!UUID_RE.test(input.jobId)) throw Errors.notFound('ジョブ');
  if (!canOperateJob({ role: actor.role, isAdmin: actor.user.isAdmin })) {
    return denyJobOperation('job.cancel', input.jobId, actor, correlationId);
  }
  const reason = input.reason.trim();
  if (reason === '') throw Errors.reasonRequired();
  await withTransaction(async (client) => {
    const job = await lockJobForOperator(client, input.jobId, input.expectedState);
    const decision = cancelDecision(job.state);
    if (!decision.ok) throw Errors.invalidTransition(decision.reason);
    if (decision.alreadyDone) return;
    await haltLockedJob(client, job, {
      to: decision.to as 'stopped' | 'cancelled',
      reason: 'cancel_requested',
      detail: { reason },
      now,
      extraSet: { cancelBy: actor.userId },
    });
    await insertJobEvent(client, {
      jobId: job.id,
      at: now,
      kind: 'cancel',
      from: job.state,
      to: decision.to,
      fencingToken: job.fencing_token + 1,
      actorType: 'human',
      actorUserId: actor.userId,
      correlationId,
      detail: { reason },
    });
    await appendAuditTx(client, {
      action: 'job.cancel',
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { from: job.state, to: decision.to, reason },
    });
  });
  return (await getJobView(input.jobId)) as JobView;
}

export async function resumeJob(
  input: { jobId: string; reason: string; expectedState?: JobState },
  actor: Actor,
  correlationId: string,
  now: Date,
): Promise<JobView> {
  if (!UUID_RE.test(input.jobId)) throw Errors.notFound('ジョブ');
  if (!canOperateJob({ role: actor.role, isAdmin: actor.user.isAdmin })) {
    return denyJobOperation('job.resume', input.jobId, actor, correlationId);
  }
  const reason = input.reason.trim();
  if (reason === '') throw Errors.reasonRequired();
  await withTransaction(async (client) => {
    const job = await lockJobForOperator(client, input.jobId, input.expectedState);
    const decision = resumeDecision({ state: job.state, stopReason: job.stop_reason, resumeTo: job.resume_to });
    if (!decision.ok) throw Errors.invalidTransition(decision.reason);
    const { rows } = await client.query<{ status: Status; deleted: boolean; order_version: number }>(
      'select status, deleted, order_version from request where id = $1',
      [job.request_id],
    );
    const req = rows[0];
    if (
      !req ||
      !isOrderCurrent({
        requestStatus: req.status,
        requestDeleted: req.deleted,
        requestOrderVersion: req.order_version,
        jobOrderVersion: job.order_version,
      })
    ) {
      throw Errors.approvalRequired('注文書が無効になっているため再開できません（承認し直してください）');
    }
    await client.query(
      `update job set state=$2, stop_reason=null, stop_detail=null, remaining_work=null, resume_to=null, stopped_at=null,
              cancel_requested_at=null, cancel_requested_by=null, session_started_at=null, continuous_seconds=0,
              lease_reclaim_count=0, fencing_token=fencing_token+1, lease_owner=null, lease_expires_at=null, heartbeat_at=null,
              updated_at=$3
        where id=$1`,
      [job.id, decision.to, now],
    );
    await insertJobEvent(client, {
      jobId: job.id,
      at: now,
      kind: 'resume',
      from: job.state,
      to: decision.to,
      fencingToken: job.fencing_token + 1,
      actorType: 'human',
      actorUserId: actor.userId,
      correlationId,
      detail: { reason, stoppedBecause: job.stop_reason },
    });
    await appendAuditTx(client, {
      action: 'job.resume',
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { from: job.state, to: decision.to, reason },
    });
  });
  return (await getJobView(input.jobId)) as JobView;
}

/* ───────────────────────────── worker: claim / lease ───────────────────────────── */

export async function claimNextJob(input: {
  owner: string;
  now: Date;
  leaseSeconds?: number;
}): Promise<{ job: JobRow; lease: JobLease } | null> {
  const secs = input.leaseSeconds ?? DEVLINE_POLICY.leaseSeconds;
  return withTransaction(async (client) => {
    const { rows } = await client.query<JobRow & { prev_owner: string | null }>(
      `with c as (
         select id, lease_owner as prev_owner from job
          where state = any($1::text[])
            and (lease_expires_at is null or lease_expires_at <= $3::timestamptz)
          order by created_at
          limit 1
          for update skip locked
       )
       update job j set lease_owner=$2, lease_expires_at=$3::timestamptz + make_interval(secs => $4::double precision),
              heartbeat_at=$3::timestamptz, fencing_token=j.fencing_token+1,
              session_started_at=coalesce(j.session_started_at,$3::timestamptz), updated_at=$3::timestamptz,
              lease_reclaim_count=j.lease_reclaim_count + (case when j.lease_owner is null then 0 else 1 end)
         from c where j.id=c.id
       returning j.*, c.prev_owner`,
      [JOB_RUNNABLE_STATES, input.owner, input.now, secs],
    );
    const job = rows[0];
    if (!job) return null;
    if (job.prev_owner !== null) {
      await insertJobEvent(client, {
        jobId: job.id,
        at: input.now,
        kind: 'lease_reclaimed',
        fencingToken: job.fencing_token,
        actorType: 'system',
        detail: { reclaimCount: job.lease_reclaim_count },
      });
    }
    return {
      job,
      lease: { jobId: job.id, owner: input.owner, fencingToken: job.fencing_token, expectedState: job.state },
    };
  });
}

/** 遅れた書き込みを捨てた記録。呼び出し元とは別のトランザクションで残す。 */
async function recordLateWrite(lease: JobLease, op: string, now: Date, correlationId?: string | null): Promise<void> {
  await withTransaction(async (client) => {
    await insertJobEvent(client, {
      jobId: lease.jobId,
      at: now,
      kind: 'late_write_discarded',
      fencingToken: lease.fencingToken,
      actorType: 'system',
      correlationId: correlationId ?? null,
      detail: { op, expectedState: lease.expectedState },
    });
    await appendAuditTx(client, {
      action: 'job.late_write_discarded',
      targetType: 'job',
      targetId: lease.jobId,
      result: 'denied',
      ...auditActor(WORKER_ACTOR),
      correlationId: correlationId ?? null,
      diff: { op, expectedState: lease.expectedState, fencingToken: lease.fencingToken },
    });
  });
}

const STALE: FencedWrite<never> = { applied: false, reason: 'stale_lease' };

function rowsChanged(result: QueryResult): boolean {
  return (result.rowCount ?? 0) > 0;
}

export async function heartbeat(
  lease: JobLease,
  now: Date,
  leaseSeconds?: number,
): Promise<FencedWrite<{ leaseExpiresAt: Date }>> {
  const secs = leaseSeconds ?? DEVLINE_POLICY.leaseSeconds;
  const { rows, rowCount } = await query<{ lease_expires_at: Date }>(
    `update job set heartbeat_at=$4::timestamptz, lease_expires_at=$4::timestamptz + make_interval(secs => $5::double precision),
            updated_at=$4::timestamptz
      where id=$1 and fencing_token=$2 and state=$3
      returning lease_expires_at`,
    [lease.jobId, lease.fencingToken, lease.expectedState, now, secs],
  );
  if (!rowCount || !rows[0]) {
    await recordLateWrite(lease, 'heartbeat', now);
    return STALE;
  }
  return { applied: true, value: { leaseExpiresAt: rows[0].lease_expires_at } };
}

/** 工程の終わりに必ず呼ぶ。外し忘れると正常な job が lease_lost_repeatedly で止まる。 */
export async function releaseLease(lease: JobLease, now: Date): Promise<FencedWrite<null>> {
  const result = await query(
    `update job set lease_owner=null, lease_expires_at=null, updated_at=$4::timestamptz, ${rollSessionSql('$4')}
      where id=$1 and fencing_token=$2 and state=$3`,
    [lease.jobId, lease.fencingToken, lease.expectedState, now],
  );
  if (!rowsChanged(result)) {
    await recordLateWrite(lease, 'releaseLease', now);
    return STALE;
  }
  return { applied: true, value: null };
}

export async function transitionJob(
  lease: JobLease,
  input: {
    to: JobState;
    patch?: Partial<JobPatch>;
    detail?: unknown;
    now: Date;
    correlationId: string;
    actor?: JobActor;
  },
): Promise<FencedWrite<JobLease | null>> {
  if (!isPhase1Transition(lease.expectedState, input.to) || JOB_HALTED_STATES.includes(input.to)) {
    throw new Error(`transitionJob: ${lease.expectedState} -> ${input.to} は Phase 1 で実行できません`);
  }
  const actor = input.actor ?? WORKER_ACTOR;
  const endsLease = input.to === 'pr_ready';
  const applied = await withTransaction(async (client) => {
    const params: unknown[] = [lease.jobId, lease.fencingToken, lease.expectedState, input.to, input.now];
    const sets = ['state=$4', 'updated_at=$5::timestamptz'];
    const patch = input.patch ?? {};
    const add = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column}=$${params.length}${cast}`);
    };
    if (patch.plan !== undefined) add('plan', JSON.stringify(patch.plan), '::jsonb');
    if (patch.workState !== undefined) add('work_state', JSON.stringify(patch.workState), '::jsonb');
    if (patch.headSha !== undefined) add('head_sha', patch.headSha);
    if (patch.ciRerunCount !== undefined) add('ci_rerun_count', patch.ciRerunCount);
    if (endsLease) sets.push('lease_owner=null', 'lease_expires_at=null', rollSessionSql('$5'));
    const result = await client.query(
      `update job set ${sets.join(', ')} where id=$1 and fencing_token=$2 and state=$3`,
      params as never[],
    );
    if (!rowsChanged(result)) return false;
    await insertJobEvent(client, {
      jobId: lease.jobId,
      at: input.now,
      kind: 'transition',
      from: lease.expectedState,
      to: input.to,
      fencingToken: lease.fencingToken,
      actorType: actor.type,
      correlationId: input.correlationId,
      detail: input.detail,
    });
    await appendAuditTx(client, {
      action: 'job.transition',
      targetType: 'job',
      targetId: lease.jobId,
      result: 'success',
      ...auditActor(actor),
      correlationId: input.correlationId,
      diff: { from: lease.expectedState, to: input.to },
    });
    return true;
  });
  if (!applied) {
    await recordLateWrite(lease, `transition:${input.to}`, input.now, input.correlationId);
    return STALE;
  }
  return { applied: true, value: endsLease ? null : { ...lease, expectedState: input.to } };
}

/** lease の持ち主が止める。行き先は haltTarget。動かせない状態なら何もせず applied:true。 */
export async function haltJob(
  lease: JobLease,
  input: {
    reason: StopReason;
    detail: unknown;
    remainingWork: unknown;
    now: Date;
    correlationId: string;
    actor?: JobActor;
  },
): Promise<FencedWrite<null>> {
  const to = haltTarget(lease.expectedState, input.reason);
  if (to === null) return { applied: true, value: null };
  const actor = input.actor ?? WORKER_ACTOR;
  const resumeTo: JobState = to === 'cancelled' ? 'queued' : lease.expectedState;
  const applied = await withTransaction(async (client) => {
    const { rows } = await client.query<JobRow>('select * from job where id=$1 and fencing_token=$2 and state=$3 for update', [
      lease.jobId,
      lease.fencingToken,
      lease.expectedState,
    ]);
    const job = rows[0];
    if (!job) return false;
    await client.query(
      `update job set state=$2, stop_reason=$3, stop_detail=$4::jsonb, remaining_work=$5::jsonb, stopped_at=$6::timestamptz,
              resume_to=$7, lease_owner=null, lease_expires_at=null, updated_at=$6::timestamptz, ${rollSessionSql('$6')}
        where id=$1`,
      [
        lease.jobId,
        to,
        input.reason,
        JSON.stringify({ detail: input.detail ?? null, ...stopCounters(job, input.now) }),
        JSON.stringify(input.remainingWork ?? remainingWorkFor(lease.expectedState)),
        input.now,
        resumeTo,
      ],
    );
    await insertJobEvent(client, {
      jobId: lease.jobId,
      at: input.now,
      kind: 'halt',
      from: lease.expectedState,
      to,
      fencingToken: lease.fencingToken,
      actorType: actor.type,
      correlationId: input.correlationId,
      detail: { reason: input.reason, detail: input.detail ?? null },
    });
    await appendAuditTx(client, {
      action: 'job.transition',
      targetType: 'job',
      targetId: lease.jobId,
      result: 'success',
      ...auditActor(actor),
      correlationId: input.correlationId,
      diff: { from: lease.expectedState, to, reason: input.reason },
    });
    return true;
  });
  if (!applied) {
    await recordLateWrite(lease, `halt:${input.reason}`, input.now, input.correlationId);
    return STALE;
  }
  return { applied: true, value: null };
}

/* ───────────────────────────── worker: 試行 ───────────────────────────── */

type AttemptOutcome = 'succeeded' | 'failed' | 'needs_human' | 'timed_out' | 'cancelled' | 'rejected' | 'discarded';

async function closeAttemptUnfenced(
  client: PoolClient,
  attemptId: string,
  outcome: AttemptOutcome,
  now: Date,
  extra: { exitCode?: number | null; logRef?: string | null; usage?: unknown } = {},
): Promise<void> {
  await client.query(
    `update job_attempt set finished_at=$3, outcome=$2, exit_code=$4, log_ref=$5, usage=coalesce($6::jsonb, usage)
      where id=$1 and finished_at is null`,
    [
      attemptId,
      outcome,
      now,
      extra.exitCode ?? null,
      extra.logRef ?? null,
      extra.usage === undefined ? null : JSON.stringify(extra.usage),
    ],
  );
}

export async function startAttempt(
  lease: JobLease,
  input: { step: RunnerStep; runnerKind: RunnerKind; now: Date },
): Promise<FencedWrite<{ attemptId: string; attemptNo: number }>> {
  const value = await withTransaction(async (client) => {
    const { rows } = await client.query('select id from job where id=$1 and fencing_token=$2 and state=$3 for update', [
      lease.jobId,
      lease.fencingToken,
      lease.expectedState,
    ]);
    if (!rows[0]) return null;
    // 落ちた worker の試行が開いたまま残っていれば閉じる
    await client.query(`update job_attempt set finished_at=$2, outcome='discarded' where job_id=$1 and finished_at is null`, [
      lease.jobId,
      input.now,
    ]);
    const inserted = await client.query<{ id: string; attempt_no: number }>(
      `insert into job_attempt (job_id, attempt_no, state_at_start, fencing_token, runner_kind, started_at)
       values ($1, (select coalesce(max(attempt_no),0)+1 from job_attempt where job_id=$1), $2, $3, $4, $5)
       returning id, attempt_no`,
      [lease.jobId, lease.expectedState, lease.fencingToken, input.runnerKind, input.now],
    );
    const row = inserted.rows[0] as { id: string; attempt_no: number };
    return { attemptId: row.id, attemptNo: row.attempt_no };
  });
  if (!value) {
    await recordLateWrite(lease, 'startAttempt', input.now);
    return STALE;
  }
  return { applied: true, value };
}

function resultForStorage(result: RunnerResult): Record<string, unknown> {
  return {
    status: result.status,
    exitCode: result.exitCode,
    headSha: result.headSha,
    changedPaths: result.changedPaths.slice(0, 200).map((p) => String(p).slice(0, 300)),
    summary: result.summary.slice(0, 1000),
    artifacts: result.artifacts.map((a) => ({ kind: a.kind, name: a.name, sha256: a.sha256, byteSize: a.byteSize })),
  };
}

/** 試行の結果を記録する。遅れた結果は attempt を discarded で閉じ、成果物も費用も job に載せない。 */
export async function finishAttempt(
  lease: JobLease,
  attemptId: string,
  result: RunnerResult,
  now: Date,
): Promise<FencedWrite<null>> {
  const usage = result.usage;
  const applied = await withTransaction(async (client) => {
    const { rows } = await client.query<JobRow>('select * from job where id=$1 and fencing_token=$2 and state=$3 for update', [
      lease.jobId,
      lease.fencingToken,
      lease.expectedState,
    ]);
    const job = rows[0];
    if (!job) {
      await closeAttemptUnfenced(client, attemptId, 'discarded', now, { exitCode: result.exitCode, usage });
      return false;
    }
    const closed = await client.query(
      `update job_attempt set finished_at=$2, outcome=$3, exit_code=$4, log_ref=$5, result=$6::jsonb, usage=$7::jsonb,
              cost_jpy=$8, duration_seconds=$9
        where id=$1 and finished_at is null`,
      [
        attemptId,
        now,
        result.status,
        result.exitCode,
        result.logRef,
        JSON.stringify(resultForStorage(result)),
        JSON.stringify(usage),
        usage.costJpy,
        Math.max(0, Math.floor(usage.durationSeconds)),
      ],
    );
    if (!rowsChanged(closed)) return true;
    for (const artifact of result.artifacts) {
      await client.query(
        `insert into job_artifact (job_id, attempt_id, kind, name, sha256, byte_size, storage_ref, content, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict do nothing`,
        [
          lease.jobId,
          attemptId,
          artifact.kind,
          artifact.name,
          artifact.sha256,
          artifact.byteSize,
          artifact.storageRef ?? null,
          artifact.content ?? null,
          now,
        ],
      );
    }
    const prior = job.usage as { inputTokens?: number; outputTokens?: number; durationSeconds?: number };
    const total = {
      inputTokens: (prior.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prior.outputTokens ?? 0) + usage.outputTokens,
      durationSeconds: (prior.durationSeconds ?? 0) + usage.durationSeconds,
    };
    await client.query(`update job set cost_jpy=cost_jpy+$2, usage=$3::jsonb, updated_at=$4 where id=$1`, [
      lease.jobId,
      usage.costJpy,
      JSON.stringify(total),
      now,
    ]);
    await insertJobEvent(client, {
      jobId: lease.jobId,
      at: now,
      kind: 'runner_result',
      fencingToken: lease.fencingToken,
      actorType: 'agent',
      detail: { attemptId, status: result.status, exitCode: result.exitCode, headSha: result.headSha },
    });
    return true;
  });
  if (!applied) {
    await recordLateWrite(lease, 'finishAttempt', now);
    return STALE;
  }
  return { applied: true, value: null };
}

/** 結果が出なかった試行（時間切れ・取消・拒否）を閉じる。遅れていても attempt を閉じるだけで job を動かさない。 */
export async function closeAttempt(attemptId: string, outcome: AttemptOutcome, now: Date): Promise<void> {
  await withTransaction(async (client) => closeAttemptUnfenced(client, attemptId, outcome, now));
}
