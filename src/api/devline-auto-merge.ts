/**
 * 自動マージ（`DEVLINE_AUTO_MERGE=1`）。仕様 4-9 の人の承認の経路とは別の、明示設定されたポリシーによる機械判定。
 *
 * - 既定は無効（`DEVLINE_AUTO_MERGE` 未設定 / 0）。無効のときは何もしない。人の承認（`approve-merge`）だけが merge する。
 * - 有効でも、判定条件（検証・受入条件・差分証跡・許可台帳の private repo・注文書が最新・PR の head 一致）を
 *   すべて満たすときだけ squash merge する。外部へ送る前に DB を読み直す。
 * - **AI は承認しない**。自動マージは人の承認の代替ではなく、サーバの設定で明示されたポリシーの実行として扱い、
 *   actor=system（`app_user.is_agent` 相当のシステム主体）で監査に残す。人の承認の行（release_approval）は作らない。
 * - merge が拒否された（競合・権限不足・CI の再実行が必要）ときは job を止め、`stop_detail` に理由を残す。
 *   送ったか分からないときは盲目に再送せず、PR を読んで照合する。未 merge なら人の承認で照合できるよう pr_ready に残す。
 *
 * 実行の契機は worker の verifying → pr_ready の直後（`src/worker/loop.ts`）。判定と送信はこのファイルに閉じる。
 * merge の口を作るのは `devline-release.ts` だけで、ここはその既定の依存（`defaultReleaseDeps`）を受け取って使う。
 */
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { withTransaction } from './db.js';
import { appendAuditTx } from './audit.js';
import { defaultReleaseDeps } from './devline-release.js';
import { haltLockedJob, insertJobEvent, isRedOrder, type JobRow } from './devline-jobs.js';
import { parseAutoMergePolicy, type AutoMergePolicy } from './devline-real-config.js';
import type { PrMergeAdapter, PullMergeFacts } from './pr-adapter.js';
import {
  acIdsOf,
  autoMergeRepoFacts,
  checkAutoMergeDiffEvidence,
  decideAutoMerge,
  diffPolicyForRepo,
  evaluateVerification,
  isOrderCurrent,
  latestVerificationRecord,
  parsePrMarker,
  type AllowedRepo,
  type AutoMergeDiffEvidence,
  type AutoMergeFacts,
  type AutoMergeRefusal,
  type RepoAllowEntry,
  type RepoDiffPolicy,
  type VerificationRecord,
  type VerificationVerdict,
} from '../shared/devline.js';
import { DEPLOY_ENVIRONMENT } from '../shared/devline-release.js';
import type { Status } from '../shared/domain.js';

/** 監査と job_event に残す主体。人の承認の行（release_approval）は作らない。 */
const SYSTEM_ACTOR = { actorUserId: null, actorName: 'system:auto-merge', role: 'system' } as const;

export interface AutoMergeDeps {
  merge: PrMergeAdapter;
  /** DEVLINE_TARGET_REPOS。job の repo がここに無ければ自動マージしない。 */
  allowedRepos: readonly AllowedRepo[];
  /** 許可台帳。既定はコードの定数（DEVLINE_REPO_LEDGER）。 */
  ledger?: readonly RepoAllowEntry[];
  /** 差分 policy の解決。既定は diffPolicyForRepo（試験で差し替える）。 */
  policyOf?: (repo: string) => RepoDiffPolicy | null;
  policy: AutoMergePolicy;
  now: () => Date;
  httpTimeoutMs?: number;
}

/**
 * 設定から自動マージの依存を作る。無効なら null（呼び出し側は何もしない）。
 * 有効なのに資格情報が読めないときは例外にする（fake の成功へ落とさない）。
 */
export function defaultAutoMergeDeps(env: Record<string, string | undefined> = process.env): AutoMergeDeps | null {
  const policy = parseAutoMergePolicy({ ...env, NODE_ENV: config.nodeEnv, APP_ENV: config.appEnv });
  if (!policy.enabled) return null;
  const release = defaultReleaseDeps();
  return {
    merge: release.merge,
    allowedRepos: config.devlineTargetRepos,
    policy,
    now: () => new Date(),
    ...(release.httpTimeoutMs === undefined ? {} : { httpTimeoutMs: release.httpTimeoutMs }),
  };
}

export type AutoMergeOutcome =
  /** 設定が無効。何もしていない。 */
  | { status: 'disabled' }
  /** すでに merge 済み（再実行）。 */
  | { status: 'already_merged'; mergeSha: string | null }
  /** 条件不足。merge は送っていない。job は pr_ready のまま（人が承認できる）。 */
  | { status: 'refused'; reasons: AutoMergeRefusal[]; detail: string | null }
  /** 判定の途中で状態が変わった（人の承認が入った等）。何も送っていない。 */
  | { status: 'skipped'; reason: string }
  /** merge した。 */
  | { status: 'merged'; mergeSha: string; prNumber: number }
  /** merge に失敗して job を止めた。 */
  | { status: 'failed'; reason: string; stopped: boolean }
  /** 送ったか分からない・読めない。送り直さず、PR を読んで照合する（job は pr_ready）。 */
  | { status: 'unknown'; reason: string };

interface ReleaseRecord {
  id: string;
  job_id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  merge_state: 'none' | 'sending' | 'unknown' | 'rejected' | 'merged';
  merge_detail: string | null;
  merge_sending_at: Date | null;
  merge_approver_user_id: string | null;
  merge_sha: string | null;
}

interface VerificationRow {
  delivery_id: string;
  source: VerificationRecord['source'];
  ci_run_id: string;
  run_sequence: number;
  run_attempt: number;
  head_sha: string;
  stages: VerificationRecord['stages'];
  ac_results: VerificationRecord['acResults'];
  report_digest: string | null;
}

function toRecord(row: VerificationRow): VerificationRecord {
  return {
    deliveryId: row.delivery_id,
    source: row.source,
    ciRunId: row.ci_run_id,
    runSequence: row.run_sequence,
    runAttempt: row.run_attempt,
    headSha: row.head_sha,
    stages: row.stages,
    acResults: row.ac_results,
    reportDigest: row.report_digest,
  };
}

interface JobFacts {
  facts: AutoMergeFacts;
  verdict: VerificationVerdict;
  run: { id: string; attempt: number } | null;
  acIds: string[];
  diff: AutoMergeDiffEvidence;
  pr: { number: number } | null;
}

/** job の記録から自動マージの事実を組み立てる（DB の記録だけを見る。AI の申告は使わない）。 */
async function jobFactsOf(
  client: PoolClient,
  job: JobRow,
  release: ReleaseRecord | undefined,
  deps: AutoMergeDeps,
  mergeStateOverride?: ReleaseRecord['merge_state'],
): Promise<JobFacts> {
  const req = await client.query<{ status: string; deleted: boolean; order_version: number; criteria: string[] }>(
    'select status, deleted, order_version, criteria from request where id = $1',
    [job.request_id],
  );
  const request = req.rows[0];
  const red = await isRedOrder(client, job.snapshot_id);
  const orderCurrent =
    !red &&
    request !== undefined &&
    isOrderCurrent({
      requestStatus: request.status as Status,
      requestDeleted: request.deleted,
      requestOrderVersion: request.order_version,
      jobOrderVersion: job.order_version,
    });
  const acIds = acIdsOf(request?.criteria ?? []);
  const rows = await client.query<VerificationRow>('select * from verification where job_id = $1', [job.id]);
  const records = rows.rows.map(toRecord);
  const verdict = evaluateVerification(records, job.head_sha ?? '', acIds);
  const latest = latestVerificationRecord(records, job.head_sha ?? '');
  const diff = checkAutoMergeDiffEvidence(job.target_repo_id, job.work_state, deps.policyOf ?? diffPolicyForRepo);
  const repo = autoMergeRepoFacts(job.target_repo_id, deps.allowedRepos, deps.ledger);
  const pr = prOf(job);
  const acAllConfirmed =
    verdict.verdict === 'passed' && acIds.every((id) => verdict.acEvidence.some((e) => e.acId === id && e.mark === '○'));
  return {
    facts: {
      enabled: deps.policy.enabled,
      jobState: job.state,
      jobHeadSha: job.head_sha,
      superseded: job.superseded_at !== null,
      orderCurrent,
      verdict: verdict.verdict,
      acAllConfirmed,
      diff,
      repo,
      hasPr: pr !== null,
      mergeState: mergeStateOverride ?? release?.merge_state ?? 'none',
    },
    verdict,
    run: latest ? { id: latest.ciRunId, attempt: latest.runAttempt } : null,
    acIds,
    diff,
    pr,
  };
}

function prOf(job: JobRow): { number: number } | null {
  const pr = (job.work_state as { pr?: { number?: unknown } } | null)?.pr;
  return pr && typeof pr.number === 'number' && Number.isInteger(pr.number) && pr.number > 0 ? { number: pr.number } : null;
}

function evidenceOf(job: JobRow, facts: JobFacts, deps: AutoMergeDeps): Record<string, unknown> {
  return {
    policyVersion: deps.policy.policyVersion,
    policyValue: deps.policy.configuredValue,
    verdict: facts.verdict.verdict,
    acIds: facts.acIds,
    headSha: job.head_sha,
    runId: facts.run?.id ?? null,
    runAttempt: facts.run?.attempt ?? null,
    prNumber: facts.pr?.number ?? null,
    repo: job.target_repo_id,
    diffPolicyVersion: facts.diff.ok ? facts.diff.policyVersion : null,
  };
}

interface Prepared {
  jobId: string;
  releaseId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  run: { id: string; attempt: number } | null;
  acIds: string[];
  verdict: VerificationVerdict;
}

type TxDecision =
  | { kind: 'refused'; reasons: AutoMergeRefusal[]; detail: string | null }
  | { kind: 'already'; mergeSha: string | null }
  | { kind: 'send'; prepared: Prepared };

/** 判定して、送る準備（release を sending にする）までを1つのトランザクションで行う。 */
async function prepareInTx(
  client: PoolClient,
  jobId: string,
  deps: AutoMergeDeps,
  correlationId: string,
  now: Date,
): Promise<TxDecision> {
  const jobs = await client.query<JobRow>('select * from job where id = $1 for update', [jobId]);
  const job = jobs.rows[0];
  if (!job) return { kind: 'refused', reasons: ['state'], detail: 'job がありません' };
  const rel = await client.query<ReleaseRecord>('select * from release where job_id = $1 for update', [jobId]);
  const release = rel.rows[0];
  const facts = await jobFactsOf(client, job, release, deps);
  const decision = decideAutoMerge(facts.facts);
  if (!decision.ok) {
    const evidence = evidenceOf(job, facts, deps);
    await insertJobEvent(client, {
      jobId: job.id,
      at: now,
      kind: 'auto_merge_refused',
      fencingToken: job.fencing_token,
      actorType: 'system',
      correlationId,
      detail: { reasons: decision.reasons, ...evidence },
    });
    await appendAuditTx(client, {
      action: 'job.auto_merge',
      targetType: 'job',
      targetId: job.id,
      result: 'denied',
      ...SYSTEM_ACTOR,
      correlationId,
      diff: { mode: 'refused', reasons: decision.reasons, ...evidence },
    });
    return { kind: 'refused', reasons: decision.reasons, detail: decision.reasons.join(',') };
  }
  if (decision.alreadyMerged) return { kind: 'already', mergeSha: release?.merge_sha ?? null };
  const pr = facts.pr as { number: number };
  const headSha = job.head_sha as string;
  const evidence = evidenceOf(job, facts, deps);

  let releaseId: string;
  if (release) {
    const updated = await client.query<ReleaseRecord>(
      `update release set repo=$2, pr_number=$3, head_sha=$4, merge_state='sending', merge_sending_at=$5, merge_detail=null,
              verified_run_id=$6, verified_run_attempt=$7, auto_merge=true, auto_merge_policy_version=$8,
              auto_merge_verdict=$9, auto_merge_ac_ids=$10::text[], auto_merge_run_id=$6, auto_merge_decided_at=$5,
              auto_merge_detail=$11::jsonb, fencing_token=fencing_token+1, updated_at=$5
        where id=$1 returning *`,
      [
        release.id,
        job.target_repo_id,
        pr.number,
        headSha,
        now,
        facts.run?.id ?? null,
        facts.run?.attempt ?? null,
        deps.policy.policyVersion,
        facts.verdict.verdict,
        facts.acIds,
        JSON.stringify(evidence),
      ],
    );
    releaseId = (updated.rows[0] as ReleaseRecord).id;
  } else {
    const inserted = await client.query<ReleaseRecord>(
      `insert into release (job_id, repo, pr_number, head_sha, merge_state, merge_sending_at, verified_run_id, verified_run_attempt,
                            auto_merge, auto_merge_policy_version, auto_merge_verdict, auto_merge_ac_ids, auto_merge_run_id,
                            auto_merge_decided_at, auto_merge_detail, created_at, updated_at)
       values ($1,$2,$3,$4,'sending',$5,$6,$7,true,$8,$9,$10::text[],$6,$5,$11::jsonb,$5,$5) returning *`,
      [
        job.id,
        job.target_repo_id,
        pr.number,
        headSha,
        now,
        facts.run?.id ?? null,
        facts.run?.attempt ?? null,
        deps.policy.policyVersion,
        facts.verdict.verdict,
        facts.acIds,
        JSON.stringify(evidence),
      ],
    );
    releaseId = (inserted.rows[0] as ReleaseRecord).id;
  }
  await insertJobEvent(client, {
    jobId: job.id,
    at: now,
    kind: 'auto_merge_started',
    fencingToken: job.fencing_token,
    actorType: 'system',
    correlationId,
    detail: evidence,
  });
  await appendAuditTx(client, {
    action: 'job.auto_merge',
    targetType: 'job',
    targetId: job.id,
    result: 'success',
    ...SYSTEM_ACTOR,
    correlationId,
    diff: { mode: 'send', ...evidence },
  });
  return {
    kind: 'send',
    prepared: {
      jobId: job.id,
      releaseId,
      repo: job.target_repo_id,
      prNumber: pr.number,
      headSha,
      run: facts.run,
      acIds: facts.acIds,
      verdict: facts.verdict,
    },
  };
}

/** 送る直前の再確認。条件が変わっていたら merge を送らない（人の承認が入っていたら触らない）。 */
async function recheck(
  prepared: Prepared,
  deps: AutoMergeDeps,
  correlationId: string,
): Promise<string | null> {
  return withTransaction(async (client) => {
    const jobs = await client.query<JobRow>('select * from job where id = $1 for update', [prepared.jobId]);
    const job = jobs.rows[0];
    if (!job) return 'job_missing';
    if (job.state !== 'pr_ready' || job.head_sha !== prepared.headSha) return 'head_changed';
    const rel = await client.query<ReleaseRecord>('select * from release where job_id = $1 for update', [prepared.jobId]);
    const release = rel.rows[0];
    if (!release || release.id !== prepared.releaseId) return 'release_missing';
    if (release.merge_state !== 'sending') return 'merge_state_changed';
    if (release.head_sha !== prepared.headSha) return 'head_changed';
    // 人が同時に承認した・送信している。機械判定で上書きしない
    const approvals = await client.query<{ decision: string; sha: string }>(
      `select decision, sha from release_approval where job_id=$1 and kind='merge' order by seq`,
      [prepared.jobId],
    );
    const last = approvals.rows[approvals.rows.length - 1];
    if (release.merge_approver_user_id !== null || (last && last.decision === 'approved' && last.sha === prepared.headSha)) {
      return 'human_takeover';
    }
    // ここでの release は自分が送信前に 'sending' にした行。再判定では「まだ送っていない」状態として扱う
    const facts = await jobFactsOf(client, job, release, deps, 'none');
    const decision = decideAutoMerge(facts.facts);
    if (!decision.ok) {
      await writeRefusal(client, job, facts, deps, decision.reasons, prepared, 'recheck', correlationId, deps.now());
      return decision.reasons.join(',');
    }
    return null;
  });
}

async function writeRefusal(
  client: PoolClient,
  job: JobRow,
  facts: JobFacts,
  deps: AutoMergeDeps,
  reasons: AutoMergeRefusal[],
  prepared: Prepared,
  phase: string,
  correlationId: string,
  now: Date,
): Promise<void> {
  const evidence = evidenceOf(job, facts, deps);
  await insertJobEvent(client, {
    jobId: job.id,
    at: now,
    kind: 'auto_merge_refused',
    fencingToken: job.fencing_token,
    actorType: 'system',
    correlationId,
    detail: { reasons, phase, prNumber: prepared.prNumber, ...evidence },
  });
  await appendAuditTx(client, {
    action: 'job.auto_merge',
    targetType: 'job',
    targetId: job.id,
    result: 'denied',
    ...SYSTEM_ACTOR,
    correlationId,
    diff: { mode: 'refused', phase, reasons, ...evidence },
  });
}

/** merge を送らなかった（読めない・混雑）。job は pr_ready のまま、人が承認できる状態に戻す。 */
async function defer(prepared: Prepared, reason: string, deps: AutoMergeDeps, correlationId: string): Promise<AutoMergeOutcome> {
  const now = deps.now();
  return withTransaction(async (client) => {
    await client.query(
      `update release set merge_state='none', merge_detail=$2, merge_sending_at=null, updated_at=$3
        where id=$1 and merge_state='sending'`,
      [prepared.releaseId, reason, now],
    );
    await insertJobEvent(client, {
      jobId: prepared.jobId,
      at: now,
      kind: 'auto_merge_deferred',
      actorType: 'system',
      correlationId,
      detail: { reason, prNumber: prepared.prNumber, headSha: prepared.headSha },
    });
    await appendAuditTx(client, {
      action: 'job.auto_merge',
      targetType: 'job',
      targetId: prepared.jobId,
      result: 'error',
      ...SYSTEM_ACTOR,
      correlationId,
      diff: { mode: 'deferred', reason, prNumber: prepared.prNumber, headSha: prepared.headSha },
    });
    return { status: 'unknown' as const, reason };
  });
}

/** 送ったか分からない。送り直さず、人の照合（approve-merge の結果不明の扱い）に委ねる。 */
async function recordUnknown(
  prepared: Prepared,
  reason: string,
  deps: AutoMergeDeps,
  correlationId: string,
): Promise<AutoMergeOutcome> {
  const now = deps.now();
  return withTransaction(async (client) => {
    await client.query(
      `update release set merge_state='unknown', merge_detail=$2, merge_sending_at=null, updated_at=$3 where id=$1`,
      [prepared.releaseId, reason, now],
    );
    await insertJobEvent(client, {
      jobId: prepared.jobId,
      at: now,
      kind: 'auto_merge_unknown',
      actorType: 'system',
      correlationId,
      detail: { reason, prNumber: prepared.prNumber, headSha: prepared.headSha },
    });
    await appendAuditTx(client, {
      action: 'job.auto_merge',
      targetType: 'job',
      targetId: prepared.jobId,
      result: 'error',
      ...SYSTEM_ACTOR,
      correlationId,
      diff: { mode: 'unknown', reason, prNumber: prepared.prNumber, headSha: prepared.headSha },
    });
    return { status: 'unknown' as const, reason };
  });
}

/** merge の拒否（競合・権限不足・CI の再実行が必要）。job を止めて stop_detail に理由を残す。 */
async function failAndStop(
  prepared: Prepared,
  reason: string,
  deps: AutoMergeDeps,
  correlationId: string,
): Promise<AutoMergeOutcome> {
  const now = deps.now();
  return withTransaction(async (client) => {
    const jobs = await client.query<JobRow>('select * from job where id = $1 for update', [prepared.jobId]);
    const job = jobs.rows[0];
    // 同時に人が merge した（結果不明の照合など）。こちらは記録を触らない
    if (job?.state === 'merged') return { status: 'already_merged' as const, mergeSha: null };
    let stopped = false;
    if (job && job.state === 'pr_ready' && job.head_sha === prepared.headSha) {
      await haltLockedJob(client, job, {
        to: 'stopped',
        reason: 'auto_merge_failed',
        detail: {
          autoMerge: {
            reason,
            policyVersion: deps.policy.policyVersion,
            policyValue: deps.policy.configuredValue,
            repo: prepared.repo,
            prNumber: prepared.prNumber,
            headSha: prepared.headSha,
            runId: prepared.run?.id ?? null,
            verdict: prepared.verdict.verdict,
            acIds: prepared.acIds,
          },
        },
        now,
      });
      await insertJobEvent(client, {
        jobId: job.id,
        at: now,
        kind: 'transition',
        from: 'pr_ready',
        to: 'stopped',
        fencingToken: job.fencing_token + 1,
        actorType: 'system',
        correlationId,
        detail: { reason: 'auto_merge_failed', autoMergeReason: reason },
      });
      stopped = true;
    }
    await client.query(
      `update release set merge_state='rejected', merge_detail=$2, merge_sending_at=null,
              auto_merge_detail = coalesce(auto_merge_detail, '{}'::jsonb) || $3::jsonb, updated_at=$4
        where id=$1`,
      [prepared.releaseId, reason, JSON.stringify({ failure: reason, stopped }), now],
    );
    await appendAuditTx(client, {
      action: 'job.auto_merge',
      targetType: 'job',
      targetId: prepared.jobId,
      result: 'error',
      ...SYSTEM_ACTOR,
      correlationId,
      diff: {
        mode: stopped ? 'stopped' : 'failed',
        reason,
        policyVersion: deps.policy.policyVersion,
        policyValue: deps.policy.configuredValue,
        prNumber: prepared.prNumber,
        headSha: prepared.headSha,
        runId: prepared.run?.id ?? null,
      },
    });
    return { status: 'failed' as const, reason, stopped };
  });
}

async function treesOf(
  prepared: Prepared,
  mergeSha: string,
  deps: AutoMergeDeps,
): Promise<{ head: string | null; merge: string | null; match: boolean | null }> {
  const signal = AbortSignal.timeout(deps.httpTimeoutMs ?? 30_000);
  const head = await deps.merge.getCommitTree({ repo: prepared.repo, sha: prepared.headSha }, signal);
  const merge = await deps.merge.getCommitTree({ repo: prepared.repo, sha: mergeSha }, signal);
  const headTree = head.ok ? head.value : null;
  const mergeTree = merge.ok ? merge.value : null;
  return { head: headTree, merge: mergeTree, match: headTree && mergeTree ? headTree === mergeTree : null };
}

/** merge 済みを記録する。人の承認の行は作らず、system の遷移として残す。 */
async function confirmMerged(
  prepared: Prepared,
  pull: PullMergeFacts,
  deps: AutoMergeDeps,
  correlationId: string,
): Promise<AutoMergeOutcome> {
  if (!pull.mergeSha) return recordUnknown(prepared, 'no_merge_sha', deps, correlationId);
  if (pull.headSha !== prepared.headSha) return failAndStop(prepared, 'head_changed', deps, correlationId);
  const mergeSha = pull.mergeSha;
  const trees = await treesOf(prepared, mergeSha, deps);
  const now = deps.now();
  return withTransaction(async (client) => {
    const jobs = await client.query<JobRow>('select * from job where id = $1 for update', [prepared.jobId]);
    const job = jobs.rows[0];
    if (!job) return { status: 'failed' as const, reason: 'job_missing', stopped: false };
    if (job.state === 'merged') return { status: 'already_merged' as const, mergeSha: job.head_sha === prepared.headSha ? mergeSha : null };
    if (job.state !== 'pr_ready' || job.head_sha !== prepared.headSha) {
      await appendAuditTx(client, {
        action: 'job.auto_merge',
        targetType: 'job',
        targetId: prepared.jobId,
        result: 'error',
        ...SYSTEM_ACTOR,
        correlationId,
        diff: { mode: 'late_merge', mergeSha, jobState: job.state, headSha: job.head_sha },
      });
      return { status: 'failed' as const, reason: 'late_merge', stopped: false };
    }
    const moved = await client.query(
      `update job set state='approved', fencing_token=fencing_token+1, updated_at=$3
        where id=$1 and state='pr_ready' and head_sha=$2`,
      [job.id, prepared.headSha, now],
    );
    if ((moved.rowCount ?? 0) === 0) return { status: 'failed' as const, reason: 'state_changed', stopped: false };
    await client.query(`update job set state='merged', updated_at=$2 where id=$1 and state='approved'`, [job.id, now]);
    await insertJobEvent(client, {
      jobId: job.id,
      at: now,
      kind: 'transition',
      from: 'pr_ready',
      to: 'approved',
      fencingToken: job.fencing_token + 1,
      actorType: 'system',
      correlationId,
      detail: { headSha: prepared.headSha, autoMerge: true, policyVersion: deps.policy.policyVersion },
    });
    await insertJobEvent(client, {
      jobId: job.id,
      at: now,
      kind: 'transition',
      from: 'approved',
      to: 'merged',
      fencingToken: job.fencing_token + 1,
      actorType: 'system',
      correlationId,
      detail: { mergeSha, treeMatch: trees.match, autoMerge: true, policyVersion: deps.policy.policyVersion },
    });
    await client.query(
      `update release set merge_state='merged', merge_detail=null, merge_sending_at=null, merge_sha=$2, head_tree_sha=$3,
              merge_tree_sha=$4, tree_match=$5, auto_merge=true, auto_merge_policy_version=$6, auto_merge_verdict='passed',
              auto_merge_ac_ids=$7::text[], auto_merge_decided_at=$8,
              auto_merge_detail = coalesce(auto_merge_detail, '{}'::jsonb) || $9::jsonb,
              fencing_token=fencing_token+1, updated_at=$8
        where id=$1`,
      [
        prepared.releaseId,
        mergeSha,
        trees.head,
        trees.merge,
        trees.match,
        deps.policy.policyVersion,
        prepared.acIds,
        now,
        JSON.stringify({ merged: true, mergeSha, treeMatch: trees.match }),
      ],
    );
    if (trees.match === true) {
      await client.query(
        `insert into release_attempt (release_id, job_id, kind, environment, sha, correlation_id, created_at)
         values ($1,$2,'build',$3,$4,$5,$6)`,
        [prepared.releaseId, job.id, DEPLOY_ENVIRONMENT, mergeSha, correlationId, now],
      );
    }
    await appendAuditTx(client, {
      action: 'job.merged',
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      ...SYSTEM_ACTOR,
      correlationId,
      diff: {
        from: 'pr_ready',
        to: 'merged',
        headSha: prepared.headSha,
        mergeSha,
        treeMatch: trees.match,
        autoMerge: true,
        policyVersion: deps.policy.policyVersion,
        policyValue: deps.policy.configuredValue,
        verdict: prepared.verdict.verdict,
        acIds: prepared.acIds,
        runId: prepared.run?.id ?? null,
        prNumber: prepared.prNumber,
        note: '人の承認の代替ではなく、明示設定されたポリシー（DEVLINE_AUTO_MERGE）による機械判定',
      },
    });
    return { status: 'merged' as const, mergeSha, prNumber: prepared.prNumber };
  });
}

/**
 * pr_ready の job を自動マージする。呼び出しは worker の pr_ready 遷移直後（devline-auto-merge.js の契機）。
 * 無効なら何もしない。外へ送る前に条件を読み直し、人の承認が入っていたら触らない。
 */
export async function autoMergeAfterPrReady(
  input: { jobId: string; correlationId: string },
  depsIn?: AutoMergeDeps,
): Promise<AutoMergeOutcome> {
  const deps = depsIn ?? defaultAutoMergeDeps();
  if (!deps || !deps.policy.enabled) return { status: 'disabled' };
  const decision = await withTransaction((client) =>
    prepareInTx(client, input.jobId, deps, input.correlationId, deps.now()),
  );
  if (decision.kind === 'refused') return { status: 'refused', reasons: decision.reasons, detail: decision.detail };
  if (decision.kind === 'already') return { status: 'already_merged', mergeSha: decision.mergeSha };

  const prepared = decision.prepared;
  const signal = (): AbortSignal => AbortSignal.timeout(deps.httpTimeoutMs ?? 30_000);
  const read = await deps.merge.getPull({ repo: prepared.repo, number: prepared.prNumber }, signal());
  if (!read.ok) return defer(prepared, 'pr_unreadable', deps, input.correlationId);
  const pull = read.value;
  if (!pull) return failAndStop(prepared, 'pr_closed', deps, input.correlationId);
  if (pull.merged) return confirmMerged(prepared, pull, deps, input.correlationId);
  if (pull.state !== 'open') return failAndStop(prepared, 'pr_closed', deps, input.correlationId);
  if (pull.headSha !== prepared.headSha) return failAndStop(prepared, 'head_changed', deps, input.correlationId);
  const own = await ownPull(prepared, pull, deps, signal());
  if (own === 'unknown') return defer(prepared, 'pr_unreadable', deps, input.correlationId);
  if (own !== 'own') return failAndStop(prepared, own, deps, input.correlationId);
  const compared = await deps.merge.getBehindBy(
    { repo: prepared.repo, base: pull.baseRef as string, head: prepared.headSha },
    signal(),
  );
  if (!compared.ok || compared.value === null) return defer(prepared, 'pr_unreadable', deps, input.correlationId);
  if (compared.value > 0) return failAndStop(prepared, 'base_behind', deps, input.correlationId);

  const stale = await recheck(prepared, deps, input.correlationId);
  if (stale === 'human_takeover' || stale === 'merge_state_changed' || stale === 'release_missing') {
    // 人の承認・送信が入った。こちらは送らずに降りて、人の経路に任せる
    await withTransaction(async (client) => {
      await insertJobEvent(client, {
        jobId: prepared.jobId,
        at: deps.now(),
        kind: 'auto_merge_skipped',
        actorType: 'system',
        correlationId: input.correlationId,
        detail: { reason: stale, prNumber: prepared.prNumber, headSha: prepared.headSha },
      });
      await appendAuditTx(client, {
        action: 'job.auto_merge',
        targetType: 'job',
        targetId: prepared.jobId,
        result: 'denied',
        ...SYSTEM_ACTOR,
        correlationId: input.correlationId,
        diff: { mode: 'skipped', reason: stale, prNumber: prepared.prNumber, headSha: prepared.headSha },
      });
    });
    return { status: 'skipped', reason: stale };
  }
  if (stale) {
    await withTransaction(async (client) => {
      await client.query(
        `update release set merge_state='none', merge_detail=$2, merge_sending_at=null, updated_at=$3
          where id=$1 and merge_state='sending'`,
        [prepared.releaseId, stale, deps.now()],
      );
    });
    return { status: 'refused', reasons: stale.split(',') as AutoMergeRefusal[], detail: stale };
  }

  const sent = await deps.merge.mergePull(
    {
      repo: prepared.repo,
      number: prepared.prNumber,
      sha: prepared.headSha,
      title: `merge PR #${prepared.prNumber} (auto ${prepared.headSha.slice(0, 12)})`,
    },
    signal(),
  );
  if (sent.outcome === 'merged') {
    return confirmMerged(prepared, { ...pull, merged: true, mergeSha: sent.mergeSha }, deps, input.correlationId);
  }
  if (sent.outcome === 'rejected') {
    if (sent.cause === 'rate_limited') return defer(prepared, 'rate_limited', deps, input.correlationId);
    return failAndStop(prepared, sent.cause === 'head_changed' ? 'head_changed' : sent.cause, deps, input.correlationId);
  }
  // 応答を失った。送り直さず読む
  const again = await deps.merge.getPull({ repo: prepared.repo, number: prepared.prNumber }, signal());
  if (again.ok && again.value?.merged) return confirmMerged(prepared, again.value, deps, input.correlationId);
  return recordUnknown(prepared, sent.reason, deps, input.correlationId);
}

/** PR がこの job のものか（マーカー・作成者・base ブランチ）。読めないときは unknown。 */
async function ownPull(
  prepared: Prepared,
  pull: PullMergeFacts,
  deps: AutoMergeDeps,
  signal: AbortSignal,
): Promise<'own' | 'not_own' | 'base_changed' | 'unknown'> {
  const actor = await deps.merge.getActorLogin(signal);
  if (!actor.ok) return 'unknown';
  if (pull.authorLogin !== actor.value || parsePrMarker(pull.body ?? '')?.jobId !== prepared.jobId) return 'not_own';
  const branch = await deps.merge.getDefaultBranch(prepared.repo, signal);
  if (!branch.ok) return 'unknown';
  return pull.baseRef === branch.value ? 'own' : 'base_changed';
}
