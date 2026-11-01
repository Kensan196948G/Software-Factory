/**
 * worker の1工程（ADR D-07/D-08、契約 1章「worker の手順」）。
 * - 工程ごとに取得し、終わったら lease を外す。request.status は書きかえない。
 * - Runner の結果で合否を決めない。pr_ready へ進めるのは recordVerification だけ。
 * - 時刻は clock から受け、判定に壁時計を直接使わない。sleep しない。
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../api/config.js';
import { pool, query } from '../api/db.js';
import {
  acIdsOf,
  appendJobEvent,
  claimNextJob,
  closeAttempt,
  finishAttempt,
  haltJob,
  heartbeat,
  isRedOrder,
  listPrFollowupCandidates,
  recordPrFollowup,
  recordVerification,
  releaseLease,
  remainingWorkFor,
  renderDraftPrBody,
  settleOrphanAttempts,
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
  checkBudget,
  checkChangedPaths,
  pathsRequiringHumanApproval,
  checkTimeLimits,
  haltTarget,
  isOrderCurrent,
  isRepoAllowed,
  maxBudgetUsd,
  prFollowupOf,
  usdToJpyCeil,
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
import type { Status } from '../shared/domain.js';
import { buildFakeVerification } from './fake-ci.js';
import type { CiCollectResult } from './github-ci-collector.js';
import type { RealLine } from './real-line.js';
import { parseRunnerResult } from './runner-result.js';

export interface WorkerOptions {
  owner: string;
  runner: RunnerAdapter;
  scenario: FakeScenario;
  clock: () => Date;
  /** 許可リストから外れたリポジトリの job は進めない。既定は DEVLINE_TARGET_REPOS。 */
  allowedRepos?: readonly AllowedRepo[];
  /** heartbeat の間隔の待ち。試験では手で進める。 */
  tick?: (signal: AbortSignal) => Promise<void>;
  /** verifying で CI の結果を作る。null は「まだ結果が無い」。既定は fake CI、実 runner は実 CI。 */
  ci?: (
    job: JobRow,
    ctx: { now: Date; correlationId: string; acIds: string[] },
  ) => RecordVerificationInput | null | Promise<CiCollectResult>;
  leaseSeconds?: number;
  /** 実 runner のとき: 予算・push・PR・実 CI。無ければ fake の経路のまま。 */
  line?: Pick<
    RealLine,
    'budget' | 'preflight' | 'publish' | 'updatePrBody' | 'closeSupersededPr' | 'followUpPr' | 'isLockHeld'
  > & {
    ci: Pick<RealLine['ci'], 'collect'>;
  };
  /** この job だけを取る（1件実走の入口）。 */
  onlyJobId?: string;
  /** 終了の合図（SIGINT / SIGTERM）。動いている AI を止め、試行を閉じ、lease を外して工程を終える。 */
  shutdown?: AbortSignal;
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
  const realAllowedHere = runner.capability.kind === 'docker-claude' && config.appEnv === 'staging';
  if (
    config.isProduction &&
    (runner.capability.kind === 'fake' || runner.capability.kind === 'docker-claude') &&
    !realAllowedHere
  ) {
    throw new Error(`production では ${runner.capability.kind} runner を動かしません`);
  }
}

interface RequestFacts {
  status: Status;
  deleted: boolean;
  order_version: number;
  criteria: string[];
}

async function requestFacts(requestId: string): Promise<RequestFacts | null> {
  const { rows } = await query<RequestFacts>('select status, deleted, order_version, criteria from request where id = $1', [
    requestId,
  ]);
  return rows[0] ?? null;
}

function agentActor(runner: RunnerAdapter): JobActor {
  return { type: 'agent', name: `agent:${runner.capability.kind}` };
}

type RunOutcome =
  | { kind: 'result'; result: RunnerResult }
  | { kind: 'error' }
  | { kind: 'lost'; late: RunnerResult | null }
  | { kind: 'limit'; reason: 'session_limit' | 'continuous_limit'; late: RunnerResult | null }
  /** heartbeat や待ちが例外で失敗した。見張れない AI は動かし続けない。 */
  | { kind: 'watch_failed'; cause: string; late: RunnerResult | null }
  /** worker の終了の合図で止めた。job は動かさない（次の起動で同じ工程からやり直す）。 */
  | { kind: 'shutdown'; late: RunnerResult | null };

/** 実費がかかる runner は止めた後の結果も待つ。遅れた結果の費用を数え落とさないため。 */
async function settleLate(runner: RunnerAdapter, run: Promise<RunOutcome>): Promise<RunnerResult | null> {
  if (runner.capability.costAccounting !== 'metered') return null;
  const settled = await run;
  return settled.kind === 'result' ? settled.result : null;
}

/** 読めない結果からでも費用だけは拾う。 */
function costOf(raw: unknown): number {
  const cost = (raw as { usage?: { costJpy?: unknown } } | null)?.usage?.costJpy;
  return typeof cost === 'number' && Number.isInteger(cost) && cost > 0 ? cost : 0;
}

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
  const watchFailed = async (cause: string): Promise<RunOutcome> => {
    await cancelRun();
    return { kind: 'watch_failed', cause, late: await settleLate(options.runner, run) };
  };
  const shutdown = options.shutdown;
  const shutdownRequested: Promise<'shutdown'> = !shutdown
    ? new Promise<never>(() => undefined)
    : shutdown.aborted
      ? Promise.resolve('shutdown')
      : new Promise((resolve) => shutdown.addEventListener('abort', () => resolve('shutdown'), { once: true }));
  for (;;) {
    const waiter = new AbortController();
    const ticked = tick(waiter.signal).then(
      () => 'tick' as const,
      () => (waiter.signal.aborted ? ('never' as const) : ('tick_failed' as const)),
    );
    const winner = await Promise.race([
      run,
      shutdownRequested,
      ticked.then((v) => (v === 'never' ? new Promise<never>(() => undefined) : v)),
    ]);
    waiter.abort();
    if (winner === 'shutdown') {
      await cancelRun();
      return { kind: 'shutdown', late: await settleLate(options.runner, run) };
    }
    if (winner === 'tick_failed') return watchFailed('tick_failed');
    if (winner !== 'tick') return winner;

    const now = options.clock();
    if (options.line?.isLockHeld?.() === false) return watchFailed('worker_lock_lost');
    let beat: Awaited<ReturnType<typeof heartbeat>>;
    try {
      beat = await heartbeat(lease, now, options.leaseSeconds);
    } catch {
      return watchFailed('heartbeat_failed');
    }
    if (!beat.applied) {
      await cancelRun();
      return { kind: 'lost', late: await settleLate(options.runner, run) };
    }
    const limit = checkTimeLimits({ now, sessionStartedAt: job.session_started_at, continuousSeconds: job.continuous_seconds });
    if (limit) {
      await cancelRun();
      return { kind: 'limit', reason: limit.stopReason, late: await settleLate(options.runner, run) };
    }
  }
}

/** 成果物の hash と大きさは申告を信じず実物から計算し直す。合わなければ runner の失敗として扱う。 */
function artifactsMatch(result: RunnerResult): boolean {
  return result.artifacts.every(
    (a) =>
      a.content === null ||
      a.content === undefined ||
      (sha256Hex(a.content) === a.sha256 && Buffer.byteLength(a.content, 'utf8') === a.byteSize),
  );
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

  // 実 runner: 動かす前に対象を確かめる（public・別の repo へは送らない）
  if (options.line) {
    const pre = await options.line.preflight(job.target_repo_id);
    if (!pre.ok) return stopped(pre.stop === 'policy' ? 'policy_violation' : 'runner_failure', { rule: pre.rule });
  }

  // 結果を受け取れなかったときに計上する割り当て。runner の --max-budget-usd と同じ計算
  const budgetNow = options.line?.budget ?? null;
  const allotmentJpy = budgetNow ? usdToJpyCeil(maxBudgetUsd(budgetNow, job.cost_jpy) ?? 0, budgetNow.jpyPerUsd) : 0;
  const started = await startAttempt(lease, {
    step,
    runnerKind: options.runner.capability.kind,
    now: options.clock(),
    allotmentJpy,
  });
  if (!started.applied) return { kind: 'lost', jobId: job.id, from };
  const { attemptId, attemptNo } = started.value;

  try {
    const facts = await requestFacts(job.request_id);
    const order = await loadOrder(job);
    const controller = new AbortController();
    const previous = job.work_state.previousFailure as
      { causeKey: string; failedStages: string[]; failedTestIds: string[] } | undefined;
    const previousBranch = typeof job.work_state.branch === 'string' ? job.work_state.branch : null;
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
        costJpySoFar: job.cost_jpy,
        previousHead: step === 'revise' && previousBranch && job.head_sha ? { sha: job.head_sha, branch: previousBranch } : null,
      },
      controller,
    );

    const now = options.clock();
    if (outcome.kind === 'lost') {
      // 取消や取り直しで fence が切れた。attempt を閉じるだけで job は動かさない
      await closeAttempt(attemptId, 'discarded', now, {
        jobId: job.id,
        costJpy: costOf(outcome.late),
        detail: { cause: 'lost', estimated: outcome.late?.costEstimated },
      });
      return { kind: 'lost', jobId: job.id, from };
    }
    if (outcome.kind === 'limit') {
      await closeAttempt(attemptId, 'timed_out', now, {
        jobId: job.id,
        costJpy: costOf(outcome.late),
        detail: { cause: 'limit', estimated: outcome.late?.costEstimated },
      });
      return stopped(outcome.reason, { step });
    }
    if (outcome.kind === 'shutdown') {
      await closeAttempt(attemptId, 'cancelled', now, {
        jobId: job.id,
        costJpy: costOf(outcome.late),
        detail: { cause: 'shutdown', estimated: outcome.late?.costEstimated },
      });
      await releaseLease(lease, options.clock());
      return { kind: 'stepped', jobId: job.id, from, to: 'unchanged' };
    }
    if (outcome.kind === 'watch_failed') {
      // DB が戻っていなければここで例外になる。試行は開いたままで、次の取得で割り当てが計上される
      await closeAttempt(attemptId, 'failed', now, {
        jobId: job.id,
        costJpy: costOf(outcome.late),
        detail: { cause: outcome.cause, estimated: outcome.late?.costEstimated },
      });
      return stopped('runner_failure', { step, cause: outcome.cause });
    }
    if (outcome.kind === 'error') {
      await closeAttempt(attemptId, 'failed', now);
      return stopped('runner_failure', { step, cause: 'runner_threw' }, agentActor(options.runner));
    }

    // 型は申告にすぎないので実行時に確かめる。読めない結果は記録も信用もしない（費用だけは数える）
    const result = parseRunnerResult(outcome.result);
    if (!result) {
      await closeAttempt(attemptId, 'rejected', now, {
        jobId: job.id,
        costJpy: costOf(outcome.result),
        detail: { cause: 'invalid_result' },
      });
      return stopped('runner_failure', { step, cause: 'invalid_result' }, agentActor(options.runner));
    }
    // 記録より先に検査する。通らない結果は成果物を追記のみの表へ入れず、rejected で閉じる（費用は数える）
    const agent = agentActor(options.runner);
    const hostChecked = options.runner.capability.diffCheckedByHost === true;
    // policy の検査を最初に行う。注文書の本文や runner の申告では変わらない
    const violations = hostChecked ? (result.serverDiff?.violations ?? []) : checkChangedPaths(result.changedPaths);
    const touched = hostChecked
      ? (result.serverDiff?.humanApproval ?? [])
      : [...(result.humanApprovalTouched ?? []), ...pathsRequiringHumanApproval(result.changedPaths)];
    const artifactsOk = artifactsMatch(result);
    const finished = await finishAttempt(lease, attemptId, result, now, {
      chargeLate: options.runner.capability.costAccounting === 'metered',
      rejected: violations.length > 0 || touched.length > 0 || !artifactsOk,
    });
    if (!finished.applied) return { kind: 'lost', jobId: job.id, from };

    if (violations.length > 0) {
      return stopped(
        'policy_violation',
        { violations: violations.slice(0, 50), ...(result.serverDiff ? { diffPolicy: result.serverDiff.policyVersion } : {}) },
        agent,
      );
    }
    if (touched.length > 0) {
      return stopped('human_approval_required', { items: touched.slice(0, 50) }, agent);
    }
    if (!artifactsOk) {
      return stopped('runner_failure', { step, exitCode: result.exitCode, cause: 'artifact_mismatch' }, agent);
    }
    const budget = options.line?.budget ?? null;
    if (budget) {
      const after = job.cost_jpy + result.usage.costJpy;
      const check = checkBudget(budget, job.cost_jpy, after);
      if (check.kind === 'warn') {
        await appendJobEvent(job.id, {
          at: now,
          kind: 'budget_warning',
          correlationId,
          detail: { costJpy: after, limitJpy: budget.limitJpy, ratio: after / budget.limitJpy },
        });
      }
      if (check.kind === 'exceeded' || result.budgetExceeded === true) {
        return stopped(
          'budget_limit',
          {
            costJpy: after,
            limitJpy: budget.limitJpy,
            estimated: result.costEstimated === true,
            cause: result.summary.slice(0, 300),
          },
          agent,
        );
      }
    } else if (result.usage.costJpy > 0 && DEVLINE_POLICY.budgetJpy === null) {
      return stopped('budget_limit', { costJpy: result.usage.costJpy }, agent);
    }
    if (result.status === 'needs_human') {
      return stopped(step === 'plan' ? 'planning_question' : 'human_approval_required', { step }, agent);
    }
    const headOk = step === 'plan' || (typeof result.headSha === 'string' && /^[0-9a-f]{40}$/.test(result.headSha));
    const diffOk = !hostChecked || result.serverDiff !== undefined;
    if (result.status === 'failed' || result.exitCode !== 0 || !headOk || !diffOk) {
      // 原因を残す（summary は runner が redact 済み）。CLI が動かなかった失敗は費用なしで再開できる
      return stopped(
        'runner_failure',
        {
          step,
          exitCode: result.exitCode,
          cause: result.summary.slice(0, 300),
          ...(result.notStarted ? { notStarted: true } : {}),
        },
        agent,
      );
    }

    const workState: Record<string, unknown> = {
      ...job.work_state,
      changedPaths: [...result.changedPaths],
      ...(result.serverDiff ? { diffPolicy: result.serverDiff.policyVersion } : {}),
    };
    // 実 runner: 差分検査を通ったものだけをホストで push して PR にする。AI は merge しない
    if (step !== 'plan' && options.line) {
      const beat = await heartbeat(lease, options.clock(), options.leaseSeconds);
      if (!beat.applied) return { kind: 'lost', jobId: job.id, from };
      const body = await renderDraftPrBody({ ...job, work_state: workState, head_sha: result.headSha });
      const published = await options.line.publish({
        jobId: job.id,
        requestId: job.request_id,
        orderVersion: job.order_version,
        attemptNo,
        repo: job.target_repo_id,
        headSha: result.headSha as string,
        body,
      });
      if (!published.ok) {
        return stopped(
          'runner_failure',
          { step, cause: published.cause, httpStatus: published.httpStatus ?? null },
          WORKER_ACTOR,
        );
      }
      const previousPr = job.work_state.pr as { number?: unknown } | undefined;
      if (typeof previousPr?.number === 'number' && previousPr.number !== published.pr.number) {
        const closed = await options.line
          .closeSupersededPr({ repo: job.target_repo_id, number: previousPr.number, jobId: job.id })
          .catch(() => false);
        await appendJobEvent(job.id, {
          at: options.clock(),
          kind: 'pr_superseded',
          correlationId,
          detail: { number: previousPr.number, closed },
        });
      }
      workState.branch = published.branch;
      workState.pr = published.pr;
      workState.attemptNo = attemptNo;
    }

    const to: JobState = step === 'plan' ? 'implementing' : 'verifying';
    const written = await transitionJob(lease, {
      to,
      now: options.clock(),
      correlationId,
      actor: agent,
      detail: { attemptId },
      patch: step === 'plan' ? { plan: result.plan ?? null } : { headSha: result.headSha, ciRerunCount: 0, workState },
    });
    if (!written.applied) {
      // push の直後に取消や新しい版で fence が切れた。この PR はどこにも記録されないので、ここで閉じる
      const stranded = workState.pr as { number: number } | undefined;
      if (stranded && options.line) {
        const closed = await options.line
          .closeSupersededPr({ repo: job.target_repo_id, number: stranded.number, jobId: job.id })
          .catch(() => false);
        await appendJobEvent(job.id, {
          at: options.clock(),
          kind: 'pr_stranded',
          correlationId,
          detail: { number: stranded.number, closed },
        });
      }
      return { kind: 'lost', jobId: job.id, from };
    }
    await releaseLease(written.value as JobLease, options.clock());
    return { kind: 'stepped', jobId: job.id, from, to };
  } finally {
    await options.runner.release?.({ jobId: job.id, attemptNo }).catch(() => undefined);
  }
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

async function collectCi(
  options: WorkerOptions,
  job: JobRow,
  ctx: { now: Date; correlationId: string; acIds: string[] },
): Promise<CiCollectResult> {
  if (options.ci) return options.ci(job, ctx);
  if (options.line) {
    const { baseSha } = await loadOrder(job);
    return options.line.ci.collect({ ...job, base_sha: baseSha }, ctx);
  }
  return buildFakeVerification(
    {
      jobId: job.id,
      headSha: job.head_sha as string,
      repairCountTotal: job.repair_count_total,
      ciRerunCount: job.ci_rerun_count,
      resumeEpoch: Number(job.work_state.resumeEpoch ?? 0),
    },
    options.scenario,
    ctx.acIds,
    { now: ctx.now, correlationId: ctx.correlationId },
  );
}

/** pr_ready に入った PR の本文を、CI の結果を載せた候補へ更新する。失敗しても job は戻さず記録だけ残す。 */
async function finalizePr(options: WorkerOptions, job: JobRow, correlationId: string): Promise<void> {
  const line = options.line;
  const pr = job.work_state.pr as { number?: unknown } | undefined;
  const attemptNo = job.work_state.attemptNo;
  if (!line || typeof pr?.number !== 'number' || typeof attemptNo !== 'number' || !job.head_sha) return;
  const { rows } = await query<{ content: string }>(
    `select content from job_artifact where job_id=$1 and kind='pr_body_draft' order by created_at desc, id desc limit 1`,
    [job.id],
  );
  const body = rows[0]?.content;
  const updated = body
    ? await line
        .updatePrBody({
          repo: job.target_repo_id,
          number: pr.number,
          jobId: job.id,
          attemptNo,
          headSha: job.head_sha,
          body,
        })
        .catch(() => false)
    : false;
  if (!updated) {
    await appendJobEvent(job.id, {
      at: options.clock(),
      kind: 'pr_body_update_failed',
      correlationId,
      detail: { number: pr.number },
    });
  }
}

async function verifyStep(options: WorkerOptions, job: JobRow, lease: JobLease, correlationId: string): Promise<StepOutcome> {
  const facts = await requestFacts(job.request_id);
  const now = options.clock();
  const acIds = acIdsOf(facts?.criteria ?? []);
  const delivery = await collectCi(options, job, { now, correlationId, acIds });
  if (!delivery) {
    await releaseLease(lease, options.clock(), { keepSession: true });
    return { kind: 'stepped', jobId: job.id, from: 'verifying', to: 'unchanged' };
  }
  if ('halt' in delivery) return haltStep(options, lease, delivery.halt.reason, delivery.halt.detail, correlationId);
  const recorded = await recordVerification(delivery);
  // 動かしたときは recordVerification が lease を外している
  // 進まなかったときは session を閉じない。結果を待ち続ける job は session_limit で止まる
  if (!recorded.advanced) await releaseLease(lease, options.clock(), { keepSession: true });
  if (recorded.advanced && recorded.jobState === 'pr_ready') await finalizePr(options, job, correlationId);
  return { kind: 'stepped', jobId: job.id, from: 'verifying', to: recorded.advanced ? recorded.jobState : 'unchanged' };
}

const PR_FOLLOWUP_MAX_TRIES = 10;
const PR_FOLLOWUP_RETRY_MS = 60_000;

/**
 * 止まった job・古い版の job の実 PR の後始末（prFollowupOf）。外部呼び出しなのでトランザクションの外で行う。
 * 失敗しても工程を止めない。結果は job の印と event に残し、間隔を空けて上限まで試す。
 */
async function followUpPrs(options: WorkerOptions): Promise<void> {
  const line = options.line;
  if (!line) return;
  for (const row of await listPrFollowupCandidates()) {
    // 1件実走の入口は自分の job だけを扱う。以前の実走の PR には触らない
    if (options.onlyJobId && row.id !== options.onlyJobId) continue;
    const pr = row.work_state.pr as { number?: unknown } | undefined;
    if (typeof pr?.number !== 'number') continue;
    const action = prFollowupOf({
      state: row.state,
      stopReason: row.stop_reason,
      superseded: row.superseded_at !== null,
      orderCurrent: isOrderCurrent({
        requestStatus: row.request_status,
        requestDeleted: row.request_deleted,
        requestOrderVersion: row.request_order_version,
        jobOrderVersion: row.order_version,
      }),
    });
    if (action === 'none') continue;
    const now = options.clock();
    const key = `${pr.number}:${action}:${(row.stopped_at ?? row.superseded_at)?.toISOString() ?? 'order'}`;
    const prior = row.work_state.prFollowup as { key?: unknown; done?: unknown; tries?: unknown; nextAt?: unknown } | undefined;
    const sameKey = prior?.key === key;
    const tries = sameKey && typeof prior?.tries === 'number' ? prior.tries : 0;
    if (sameKey && prior?.done === true) continue;
    if (tries >= PR_FOLLOWUP_MAX_TRIES) continue;
    if (sameKey && typeof prior?.nextAt === 'string' && now.getTime() < Date.parse(prior.nextAt)) continue;

    const outcome = await line
      .followUpPr({ action, repo: row.target_repo_id, number: pr.number, jobId: row.id, stopReason: row.stop_reason })
      .catch(() => 'retry' as const);
    const closed = action === 'close' && outcome === 'done';
    await recordPrFollowup(
      row,
      {
        key,
        number: pr.number,
        action,
        outcome,
        done: outcome !== 'retry',
        tries: tries + 1,
        ...(outcome === 'retry' ? { nextAt: new Date(now.getTime() + PR_FOLLOWUP_RETRY_MS).toISOString() } : {}),
        // 自分のものではないと分かった PR も、これ以上は触らない
        ...(closed || outcome === 'not_own' ? { closedNumber: String(pr.number) } : {}),
        // 閉じていない。画面で「閉じました」と見せない
        ...(outcome === 'not_own' ? { notOwn: true } : {}),
      },
      now,
      `worker-${randomUUID()}`,
    );
  }
}

/** 1つ取って1工程だけ進める。何も取れなければ idle。 */
export async function runOnce(options: WorkerOptions): Promise<StepOutcome> {
  assertRunnerAllowed(options.runner);
  // 排他を失った worker は新しい AI を動かさない（呼び出し側で止める）
  if (options.line?.isLockHeld?.() === false) throw new Error('worker の排他を失いました');
  if (options.shutdown?.aborted) return { kind: 'idle' };
  if (options.line) await followUpPrs(options).catch(() => undefined);
  const realWorker = options.runner.capability.kind === 'docker-claude';
  const claimed = await claimNextJob({
    owner: options.owner,
    now: options.clock(),
    leaseSeconds: options.leaseSeconds,
    // 実 runner の job と fake の job は互いに取らない（取ると runner_rejected で止めてしまう）
    ...(realWorker ? { runnerKind: 'docker-claude' as const } : { excludeRunnerKind: 'docker-claude' as const }),
    ...(options.onlyJobId ? { jobId: options.onlyJobId } : {}),
  });
  if (!claimed) return { kind: 'idle' };
  let lease = claimed.lease;
  const correlationId = `worker-${randomUUID()}`;
  const halt = (reason: StopReason, detail: unknown) => haltStep(options, lease, reason, detail, correlationId);
  // 落ちた worker の試行を閉じて費用を数える。どの工程へ進むか・止まるかより先に行う
  const settled = await settleOrphanAttempts(lease, options.clock());
  if (!settled.applied) return { kind: 'lost', jobId: claimed.job.id, from: claimed.job.state };
  const job: JobRow = { ...claimed.job, cost_jpy: claimed.job.cost_jpy + settled.value.chargedJpy };

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

  // 赤信号は版固定のときの色で判定する。queued には stopped への遷移が無いので planning を経て止める（T-70）
  const red = await isRedOrder(pool, job.snapshot_id);
  if (red && job.state !== 'queued') return halt('red_signal_human_required', { signal: 'r' });

  if (job.state === 'queued') {
    const moved = await transitionJob(lease, { to: 'planning', now: options.clock(), correlationId });
    if (!moved.applied) return { kind: 'lost', jobId: job.id, from: 'queued' };
    lease = moved.value as JobLease;
    if (red) return halt('red_signal_human_required', { signal: 'r' });
    await releaseLease(lease, options.clock());
    return { kind: 'stepped', jobId: job.id, from: 'queued', to: 'planning' };
  }
  if (job.state === 'verifying') return verifyStep(options, job, lease, correlationId);
  // 予算を使い切った job は AI を動かさない（延長しない）
  if (options.line && job.cost_jpy >= options.line.budget.limitJpy) {
    return halt('budget_limit', { costJpy: job.cost_jpy, limitJpy: options.line.budget.limitJpy, at: 'claim' });
  }
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
