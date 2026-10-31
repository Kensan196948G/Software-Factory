/**
 * worker の1工程（ADR D-07/D-08、契約 1章「worker の手順」）。
 * - 工程ごとに取得し、終わったら lease を外す。request.status は書きかえない。
 * - Runner の結果で合否を決めない。pr_ready へ進めるのは recordVerification だけ。
 * - 時刻は clock から受け、判定に壁時計を直接使わない。sleep しない。
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../api/config.js';
import { query } from '../api/db.js';
import {
  acIdsOf,
  claimNextJob,
  closeAttempt,
  finishAttempt,
  haltJob,
  heartbeat,
  recordVerification,
  releaseLease,
  remainingWorkFor,
  sha256Hex,
  startAttempt,
  transitionJob,
  WORKER_ACTOR,
  type JobActor,
  type JobRow,
} from '../api/devline-service.js';
import {
  DEVLINE_POLICY,
  IMPLEMENTED_RUNNER_KINDS,
  checkChangedPaths,
  checkTimeLimits,
  haltTarget,
  isOrderCurrent,
  isRepoAllowed,
} from '../shared/devline.js';
import type {
  AllowedRepo,
  FakeScenario,
  JobLease,
  JobState,
  OrderEnvelopeV1,
  RecordVerificationInput,
  RunnerAdapter,
  RunnerResult,
  RunnerStep,
  StopReason,
} from '../shared/devline.js';
import type { Signal, Status } from '../shared/domain.js';
import { buildFakeVerification } from './fake-ci.js';

export interface WorkerOptions {
  owner: string;
  runner: RunnerAdapter;
  scenario: FakeScenario;
  clock: () => Date;
  /** 許可リストから外れたリポジトリの job は進めない。既定は DEVLINE_TARGET_REPOS。 */
  allowedRepos?: readonly AllowedRepo[];
  /** heartbeat の間隔の待ち。試験では手で進める。 */
  tick?: (signal: AbortSignal) => Promise<void>;
  /** verifying で CI の結果を作る。null は「まだ結果が無い」。既定は fake CI。 */
  ci?: (job: JobRow, ctx: { now: Date; correlationId: string; acIds: string[] }) => RecordVerificationInput | null;
  leaseSeconds?: number;
}

export type StepOutcome =
  | { kind: 'idle' }
  | { kind: 'stepped'; jobId: string; from: JobState; to: JobState | 'unchanged' }
  | { kind: 'lost'; jobId: string; from: JobState };

const HEARTBEAT_MS = 60_000;

const defaultTick = async (signal: AbortSignal): Promise<void> => {
  await delay(HEARTBEAT_MS, undefined, { signal });
};

/** runner がその環境で動かしてよいか。fake は production で動かさない（T-69）。 */
export function assertRunnerAllowed(runner: RunnerAdapter): void {
  if (!IMPLEMENTED_RUNNER_KINDS.includes(runner.capability.kind)) {
    throw new Error(`runner ${runner.capability.kind} は未実装です`);
  }
  if (config.isProduction && runner.capability.kind === 'fake') {
    throw new Error('production では fake runner を動かしません');
  }
}

interface RequestFacts {
  status: Status;
  deleted: boolean;
  order_version: number;
  signal_decided: Signal | null;
  criteria: string[];
}

async function requestFacts(requestId: string): Promise<RequestFacts | null> {
  const { rows } = await query<RequestFacts>(
    'select status, deleted, order_version, signal_decided, criteria from request where id = $1',
    [requestId],
  );
  return rows[0] ?? null;
}

function agentActor(runner: RunnerAdapter): JobActor {
  return { type: 'agent', name: `agent:${runner.capability.kind}` };
}

type RunOutcome =
  | { kind: 'result'; result: RunnerResult }
  | { kind: 'error' }
  | { kind: 'lost' }
  | { kind: 'limit'; reason: 'session_limit' | 'continuous_limit' };

/** runner を動かしながら heartbeat を打ち、上限と取消（fence の失効）を見る。 */
async function runWatched(
  options: WorkerOptions,
  job: JobRow,
  lease: JobLease,
  input: Parameters<RunnerAdapter['run']>[0],
  controller: AbortController,
): Promise<RunOutcome> {
  const tick = options.tick ?? defaultTick;
  const run: Promise<RunOutcome> = options.runner.run(input).then(
    (result): RunOutcome => ({ kind: 'result', result }),
    (): RunOutcome => ({ kind: 'error' }),
  );
  const cancelRun = async (): Promise<void> => {
    controller.abort();
    await options.runner.cancel({ jobId: job.id, attemptNo: input.attemptNo }).catch(() => undefined);
  };
  for (;;) {
    const waiter = new AbortController();
    const ticked = tick(waiter.signal).then(
      () => 'tick' as const,
      () => 'never' as const,
    );
    const winner = await Promise.race([run, ticked.then((v) => (v === 'tick' ? v : new Promise<never>(() => undefined)))]);
    waiter.abort();
    if (winner !== 'tick') return winner;

    const now = options.clock();
    const beat = await heartbeat(lease, now, options.leaseSeconds);
    if (!beat.applied) {
      await cancelRun();
      return { kind: 'lost' };
    }
    const limit = checkTimeLimits({ now, sessionStartedAt: job.session_started_at, continuousSeconds: job.continuous_seconds });
    if (limit) {
      await cancelRun();
      return { kind: 'limit', reason: limit.stopReason };
    }
  }
}

/** 成果物の hash は申告を信じず実物から計算し直す。合わなければ runner の失敗として扱う。 */
function artifactsMatch(result: RunnerResult): boolean {
  return result.artifacts.every((a) => a.content === null || a.content === undefined || sha256Hex(a.content) === a.sha256);
}

const STEP_OF: Partial<Record<JobState, RunnerStep>> = { planning: 'plan', implementing: 'implement', revising: 'revise' };

async function loadOrder(job: JobRow): Promise<{ envelope: OrderEnvelopeV1; canonicalYaml: string; baseSha: string }> {
  const { rows } = await query<{ envelope: OrderEnvelopeV1; canonical_yaml: string; base_sha: string }>(
    'select envelope, canonical_yaml, base_sha from order_snapshot where id = $1',
    [job.snapshot_id],
  );
  const row = rows[0] as { envelope: OrderEnvelopeV1; canonical_yaml: string; base_sha: string };
  return { envelope: row.envelope, canonicalYaml: row.canonical_yaml, baseSha: row.base_sha };
}

/** planning / implementing / revising の1工程。 */
async function runStep(options: WorkerOptions, job: JobRow, lease: JobLease, correlationId: string): Promise<StepOutcome> {
  const from = lease.expectedState;
  const step = STEP_OF[from] as RunnerStep;
  const stopped = (reason: StopReason, detail: unknown, actor?: JobActor) =>
    haltStep(options, lease, reason, detail, correlationId, actor);

  const started = await startAttempt(lease, { step, runnerKind: options.runner.capability.kind, now: options.clock() });
  if (!started.applied) return { kind: 'lost', jobId: job.id, from };
  const { attemptId, attemptNo } = started.value;

  const facts = await requestFacts(job.request_id);
  const order = await loadOrder(job);
  const controller = new AbortController();
  const previous = job.work_state.previousFailure as
    { causeKey: string; failedStages: string[]; failedTestIds: string[] } | undefined;
  const outcome = await runWatched(
    options,
    job,
    lease,
    {
      jobId: job.id,
      attemptNo,
      step,
      order: { envelope: order.envelope, canonicalYaml: order.canonicalYaml },
      acceptanceCriteriaIds: acIdsOf(facts?.criteria ?? []),
      policyVersion: job.policy_version,
      baseSha: order.baseSha,
      previousFailure: step === 'revise' ? (previous ?? null) : null,
      deadlineAt: new Date(options.clock().getTime() + DEVLINE_POLICY.maxSessionMinutes * 60_000).toISOString(),
      signal: controller.signal,
    },
    controller,
  );

  const now = options.clock();
  if (outcome.kind === 'lost') {
    // 取消や取り直しで fence が切れた。attempt を閉じるだけで job は動かさない
    await closeAttempt(attemptId, 'discarded', now);
    return { kind: 'lost', jobId: job.id, from };
  }
  if (outcome.kind === 'limit') {
    await closeAttempt(attemptId, 'timed_out', now);
    return stopped(outcome.reason, { step });
  }
  if (outcome.kind === 'error') {
    await closeAttempt(attemptId, 'failed', now);
    return stopped('runner_failure', { step, cause: 'runner_threw' }, agentActor(options.runner));
  }

  const result = outcome.result;
  const finished = await finishAttempt(lease, attemptId, result, now);
  if (!finished.applied) return { kind: 'lost', jobId: job.id, from };

  const agent = agentActor(options.runner);
  // policy の検査を最初に行う。注文書の本文や runner の申告では変わらない
  const violations = checkChangedPaths(result.changedPaths);
  if (violations.length > 0) {
    return stopped('policy_violation', { violations: violations.slice(0, 50) }, agent);
  }
  if (result.humanApprovalTouched && result.humanApprovalTouched.length > 0) {
    return stopped('human_approval_required', { items: result.humanApprovalTouched.slice(0, 50) }, agent);
  }
  if (result.usage.costJpy > 0 && DEVLINE_POLICY.budgetJpy === null) {
    return stopped('budget_limit', { costJpy: result.usage.costJpy }, agent);
  }
  if (result.status === 'needs_human') {
    return stopped(step === 'plan' ? 'planning_question' : 'human_approval_required', { step }, agent);
  }
  const headOk = step === 'plan' || (typeof result.headSha === 'string' && /^[0-9a-f]{40}$/.test(result.headSha));
  if (result.status === 'failed' || result.exitCode !== 0 || !headOk || !artifactsMatch(result)) {
    return stopped('runner_failure', { step, exitCode: result.exitCode }, agent);
  }

  const to: JobState = step === 'plan' ? 'implementing' : 'verifying';
  const written = await transitionJob(lease, {
    to,
    now: options.clock(),
    correlationId,
    actor: agent,
    detail: { attemptId },
    patch:
      step === 'plan'
        ? { plan: result.plan ?? null }
        : {
            headSha: result.headSha,
            ciRerunCount: 0,
            workState: { ...job.work_state, changedPaths: [...result.changedPaths] },
          },
  });
  if (!written.applied) return { kind: 'lost', jobId: job.id, from };
  await releaseLease(written.value as JobLease, options.clock());
  return { kind: 'stepped', jobId: job.id, from, to };
}

async function haltStep(
  options: WorkerOptions,
  lease: JobLease,
  reason: StopReason,
  detail: unknown,
  correlationId: string,
  actor: JobActor = WORKER_ACTOR,
): Promise<StepOutcome> {
  const from = lease.expectedState;
  const written = await haltJob(lease, {
    reason,
    detail,
    remainingWork: remainingWorkFor(from),
    now: options.clock(),
    correlationId,
    actor,
  });
  if (!written.applied) return { kind: 'lost', jobId: lease.jobId, from };
  return { kind: 'stepped', jobId: lease.jobId, from, to: haltTarget(from, reason) ?? 'unchanged' };
}

async function verifyStep(options: WorkerOptions, job: JobRow, lease: JobLease, correlationId: string): Promise<StepOutcome> {
  const facts = await requestFacts(job.request_id);
  const now = options.clock();
  const acIds = acIdsOf(facts?.criteria ?? []);
  const delivery = options.ci
    ? options.ci(job, { now, correlationId, acIds })
    : buildFakeVerification(
        {
          jobId: job.id,
          headSha: job.head_sha as string,
          repairCountTotal: job.repair_count_total,
          ciRerunCount: job.ci_rerun_count,
        },
        options.scenario,
        acIds,
        { now, correlationId },
      );
  if (!delivery) {
    await releaseLease(lease, options.clock());
    return { kind: 'stepped', jobId: job.id, from: 'verifying', to: 'unchanged' };
  }
  const recorded = await recordVerification(delivery);
  // 動かしたときは recordVerification が lease を外している
  if (!recorded.advanced) await releaseLease(lease, options.clock());
  return { kind: 'stepped', jobId: job.id, from: 'verifying', to: recorded.advanced ? recorded.jobState : 'unchanged' };
}

/** 1つ取って1工程だけ進める。何も取れなければ idle。 */
export async function runOnce(options: WorkerOptions): Promise<StepOutcome> {
  assertRunnerAllowed(options.runner);
  const claimed = await claimNextJob({ owner: options.owner, now: options.clock(), leaseSeconds: options.leaseSeconds });
  if (!claimed) return { kind: 'idle' };
  const { job } = claimed;
  let lease = claimed.lease;
  const correlationId = `worker-${randomUUID()}`;
  const halt = (reason: StopReason, detail: unknown) => haltStep(options, lease, reason, detail, correlationId);

  if (job.lease_reclaim_count > DEVLINE_POLICY.maxLeaseReclaims) {
    return halt('lease_lost_repeatedly', { reclaimCount: job.lease_reclaim_count });
  }
  const facts = await requestFacts(job.request_id);
  const current =
    facts !== null &&
    isOrderCurrent({
      requestStatus: facts.status,
      requestDeleted: facts.deleted,
      requestOrderVersion: facts.order_version,
      jobOrderVersion: job.order_version,
    });
  if (!current) return halt('order_invalidated', { requestStatus: facts?.status ?? null });

  const allowed = options.allowedRepos ?? config.devlineTargetRepos;
  if (
    !isRepoAllowed(
      job.target_repo_id,
      allowed.map((r) => r.name),
    )
  ) {
    return halt('policy_violation', { rule: 'target_repo_not_allowed' });
  }
  if (job.runner_kind !== options.runner.capability.kind) {
    return halt('runner_rejected', { jobRunner: job.runner_kind, workerRunner: options.runner.capability.kind });
  }
  const limit = checkTimeLimits({
    now: options.clock(),
    sessionStartedAt: job.session_started_at,
    continuousSeconds: job.continuous_seconds,
  });
  if (limit) return halt(limit.stopReason, { at: 'claim' });

  if (job.state === 'queued') {
    const moved = await transitionJob(lease, { to: 'planning', now: options.clock(), correlationId });
    if (!moved.applied) return { kind: 'lost', jobId: job.id, from: 'queued' };
    lease = moved.value as JobLease;
    if (facts?.signal_decided === 'r') return halt('red_signal_human_required', { signal: 'r' });
    await releaseLease(lease, options.clock());
    return { kind: 'stepped', jobId: job.id, from: 'queued', to: 'planning' };
  }
  if (job.state === 'verifying') return verifyStep(options, job, lease, correlationId);
  return runStep(options, job, lease, correlationId);
}

/** 取れるものが無くなるまで進める（確認と試験用）。上限つき。 */
export async function runUntilIdle(options: WorkerOptions, maxSteps = 200): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const outcome = await runOnce(options);
    if (outcome.kind === 'idle') return outcomes;
    outcomes.push(outcome);
  }
  throw new Error(`runUntilIdle: ${maxSteps} 工程で終わりませんでした`);
}
