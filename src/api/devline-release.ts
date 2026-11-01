/**
 * 人の承認の経路（仕様 4-9、FR-39〜41、BR-07、BR-08、TC-N09）。
 *
 * - 起点は必ず人の画面操作。worker と runner はこのファイルを import しない（試験で固定している）。
 * - job の遷移表に approved からの戻りが無いので、merge が確定するまで job は pr_ready のまま置く。
 *   承認と送信の途中経過は release と release_approval に残し、確定したら同じトランザクションで
 *   pr_ready → approved → merged と進める（行き止まりの approved を作らない）。
 * - merge の結果不明は作り直さない。押し直しは PR を読んで照合し、merge 済みならそれを記録する。
 * - 外部呼び出しをトランザクションの中で行わない（appendAuditTx が advisory lock を取るため）。
 */
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { appendAudit, appendAuditTx } from './audit.js';
import { ApiError, Errors } from './http.js';
import { getJobView, insertJobEvent, type JobRow } from './devline-jobs.js';
import { acIdsOf } from './devline-verification.js';
import { createGithubPrMergeAdapter, type PrMergeAdapter, type PullMergeFacts } from './pr-adapter.js';
import type { Actor } from './service.js';
import { evaluateVerification, isOrderCurrent, parsePrMarker } from '../shared/devline.js';
import type { AllowedRepo, JobView, VerificationRecord, VerificationVerdict } from '../shared/devline.js';
import {
  DEPLOY_ENVIRONMENT,
  decideDeploy,
  decideMerge,
  decideRollback,
  type MergeState,
  type Refusal,
  type ReleaseEvidence,
  type DevlineSummary,
} from '../shared/devline-release.js';
import type { Status } from '../shared/domain.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 送信中の印がこれより古ければ、落ちた処理の残りとして照合へ進む。 */
const MERGE_SENDING_FRESH_MS = 120_000;

export interface ReleaseDeps {
  merge: PrMergeAdapter;
  allowedRepos: readonly AllowedRepo[];
  now: () => Date;
  httpTimeoutMs?: number;
}

/**
 * 既定の依存。資格情報は呼ばれたときに読む。無ければ未接続（fake の成功へ置きかえない）。
 * GITHUB_TOKEN は使わない。DEVLINE_SECRETS_FILE か DEVLINE_GITHUB_TOKEN だけ。
 */
export async function defaultReleaseDeps(): Promise<ReleaseDeps> {
  let token = process.env.DEVLINE_GITHUB_TOKEN ?? '';
  const file = process.env.DEVLINE_SECRETS_FILE;
  if (file) {
    const { loadDevlineSecrets } = await import('../worker/real-line.js');
    try {
      token = loadDevlineSecrets(file, config.nodeEnv).githubToken;
    } catch {
      throw new ApiError('ERR-405', '開発ライン未接続：merge に使う資格情報を読めません（管理者に確認してください）', 409);
    }
  }
  if (!token)
    throw new ApiError('ERR-405', '開発ライン未接続：merge に使う資格情報がありません（管理者に確認してください）', 409);
  return {
    merge: createGithubPrMergeAdapter({ token, apiUrl: config.githubApiUrl, nodeEnv: config.nodeEnv }),
    allowedRepos: config.devlineTargetRepos,
    now: () => new Date(),
  };
}

export interface ReleaseRow {
  id: string;
  job_id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  merge_state: MergeState;
  merge_detail: string | null;
  merge_sending_at: Date | null;
  merge_approver_user_id: string | null;
  merge_approved_at: Date | null;
  approved_head_sha: string | null;
  merge_sha: string | null;
  head_tree_sha: string | null;
  merge_tree_sha: string | null;
  tree_match: boolean | null;
  image_digest: string | null;
  artifact_built_at: Date | null;
  artifact_health: boolean | null;
  artifact_smoke: boolean | null;
  deploy_approved_at: Date | null;
  environment: string | null;
  deployed_at: Date | null;
  health: boolean | null;
  smoke: boolean | null;
  url: string | null;
  previous_digest: string | null;
  previous_sha: string | null;
  current_digest: string | null;
  rolled_back_at: Date | null;
  fencing_token: number;
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

interface OrderFacts {
  current: boolean;
  acIds: string[];
}

async function orderFacts(client: PoolClient, job: JobRow): Promise<OrderFacts> {
  const { rows } = await client.query<{ status: Status; deleted: boolean; order_version: number; criteria: string[] }>(
    'select status, deleted, order_version, criteria from request where id = $1',
    [job.request_id],
  );
  const req = rows[0];
  return {
    current:
      req !== undefined &&
      isOrderCurrent({
        requestStatus: req.status,
        requestDeleted: req.deleted,
        requestOrderVersion: req.order_version,
        jobOrderVersion: job.order_version,
      }),
    acIds: acIdsOf(req?.criteria ?? []),
  };
}

async function verdictOf(client: PoolClient, job: JobRow, acIds: readonly string[]): Promise<VerificationVerdict> {
  const rows = await client.query<VerificationRow>('select * from verification where job_id = $1', [job.id]);
  return evaluateVerification(rows.rows.map(toRecord), job.head_sha ?? '', acIds);
}

function allAcConfirmed(verdict: VerificationVerdict, acIds: readonly string[]): boolean {
  if (verdict.verdict !== 'passed') return false;
  return acIds.every((id) => verdict.acEvidence.some((e) => e.acId === id && e.mark === '○'));
}

async function isAgentUser(client: PoolClient, userId: string): Promise<boolean> {
  const { rows } = await client.query<{ is_agent: boolean }>('select is_agent from app_user where id = $1', [userId]);
  // 記録の無い利用者は人として扱わない
  return rows[0]?.is_agent !== false;
}

function prOf(job: JobRow): { number: number } | null {
  const pr = (job.work_state as { pr?: { number?: unknown } } | null)?.pr;
  return pr && typeof pr.number === 'number' && Number.isInteger(pr.number) && pr.number > 0 ? { number: pr.number } : null;
}

const REFUSAL_STATUS: Record<Refusal['refusal'], () => ApiError> = {
  role: () => Errors.noPermission(),
  agent_actor: () => Errors.noPermission(),
  state: () => Errors.invalidTransition('いまの状態の job にはこの操作ができません'),
  head_changed: () => Errors.approvalRequired('表示していた SHA が古くなりました（承認は失効しました）'),
  superseded: () => Errors.approvalRequired('新しい版に置きかえられた job です'),
  order_not_current: () => Errors.approvalRequired('注文書が無効になっています'),
  verification: () => Errors.approvalRequired('この SHA の検査が合格していません'),
  no_pr: () => Errors.approvalRequired('実 PR の記録がありません'),
  in_progress: () => Errors.conflict('別の操作が進めています。少し待って結果を確かめてください'),
  expired: () => Errors.approvalRequired('承認は失効しました。注文書の版を上げて作り直してください'),
  sha_mismatch: () => Errors.approvalRequired('SHA が記録と違います'),
  digest_mismatch: () => Errors.approvalRequired('digest が記録と違います'),
  environment_mismatch: () => Errors.approvalRequired('環境が配備先と違います'),
  tree_mismatch: () => Errors.approvalRequired('merge 後の内容が検査した内容と一致していません'),
  no_artifact: () => Errors.approvalRequired('検査済みの成果物がまだありません'),
  nothing_to_restore: () => Errors.invalidTransition('戻す先の版がありません'),
  not_current: () => Errors.invalidTransition('この job の版は環境に載っていません'),
};

/** 拒否を監査に残してから例外にする（トランザクションの外で書く）。 */
async function deny(action: string, jobId: string, refusal: Refusal, actor: Actor, correlationId: string): Promise<never> {
  await appendAudit({
    action,
    targetType: 'job',
    targetId: jobId,
    result: 'denied',
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    correlationId,
    diff: { refusal: refusal.refusal },
  });
  const base = REFUSAL_STATUS[refusal.refusal]();
  throw new ApiError(base.code, refusal.message, base.statusCode, { refusal: refusal.refusal });
}

export interface ReleaseActionResult {
  job: JobView;
  alreadyDone: boolean;
  mergeState?: MergeState;
}

const MERGE_ACTION = 'job.merge_approve';

/* ───────────────────────────── merge ───────────────────────────── */

export async function approveMerge(
  input: { jobId: string; headSha: string },
  actor: Actor,
  correlationId: string,
  depsIn?: ReleaseDeps,
): Promise<ReleaseActionResult> {
  if (!UUID_RE.test(input.jobId)) throw Errors.notFound('ジョブ');
  // 権限の無い人には資格情報の有無も見せない。役割は先に確かめる
  if (actor.role !== 'approver') {
    return deny(
      MERGE_ACTION,
      input.jobId,
      { ok: false, refusal: 'role', message: '承認できるのは承認者だけです' },
      actor,
      correlationId,
    );
  }
  const deps = depsIn ?? (await defaultReleaseDeps());
  const now = deps.now();

  const step = await withTransaction(async (client) => {
    const locked = await client.query<JobRow>('select * from job where id = $1 for update', [input.jobId]);
    const job = locked.rows[0];
    if (!job) throw Errors.notFound('ジョブ');
    const facts = await orderFacts(client, job);
    const verdict = await verdictOf(client, job, facts.acIds);
    const existing = await client.query<ReleaseRow>('select * from release where job_id = $1 for update', [job.id]);
    const release = existing.rows[0];
    const pr = prOf(job);
    const decision = decideMerge({
      approver: { role: actor.role, isAgent: await isAgentUser(client, actor.userId) },
      jobState: job.state,
      jobHeadSha: job.head_sha,
      requestedHeadSha: input.headSha,
      superseded: job.superseded_at !== null,
      orderCurrent: facts.current,
      verdict: verdict.verdict,
      acAllConfirmed: allAcConfirmed(verdict, facts.acIds),
      hasPr: pr !== null,
      mergeState: release?.merge_state ?? 'none',
      mergeDetail: release?.merge_detail ?? null,
      sendingFresh:
        release?.merge_sending_at !== null &&
        release?.merge_sending_at !== undefined &&
        now.getTime() - release.merge_sending_at.getTime() < MERGE_SENDING_FRESH_MS,
      approvedHeadSha: release?.approved_head_sha ?? null,
    });
    if (!decision.ok) return { kind: 'refused' as const, refusal: decision };
    if (decision.mode === 'already_merged') {
      return { kind: 'already' as const, needsTree: release?.tree_match === null, release: release as ReleaseRow };
    }
    const row = await upsertRelease(client, job, release, pr as { number: number }, input.headSha, actor.userId, now);
    const inserted = await client.query(
      `insert into release_approval (release_id, job_id, kind, approver_user_id, approver_name, role, sha, correlation_id, decided_at)
       values ($1,$2,'merge',$3,$4,$5,$6,$7,$8)
       on conflict (job_id, sha) where kind = 'merge' do nothing`,
      [row.id, job.id, actor.userId, actor.displayName, actor.role, input.headSha, correlationId, now],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      await insertJobEvent(client, {
        jobId: job.id,
        at: now,
        kind: 'merge_approved',
        fencingToken: job.fencing_token,
        actorType: 'human',
        actorUserId: actor.userId,
        correlationId,
        detail: { headSha: input.headSha, prNumber: row.pr_number },
      });
    }
    await appendAuditTx(client, {
      action: MERGE_ACTION,
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { headSha: input.headSha, mode: decision.mode, prNumber: row.pr_number },
    });
    return { kind: 'proceed' as const, mode: decision.mode, release: row };
  });

  if (step.kind === 'refused') return deny(MERGE_ACTION, input.jobId, step.refusal, actor, correlationId);
  if (step.kind === 'already') {
    if (step.needsTree && step.release.merge_sha) {
      await settleTree(step.release, deps, correlationId);
    }
    return { job: (await getJobView(input.jobId)) as JobView, alreadyDone: true, mergeState: 'merged' };
  }
  return sendMerge(step.release, step.mode, input.headSha, actor, correlationId, deps);
}

async function upsertRelease(
  client: PoolClient,
  job: JobRow,
  release: ReleaseRow | undefined,
  pr: { number: number },
  headSha: string,
  userId: string,
  now: Date,
): Promise<ReleaseRow> {
  if (release) {
    const { rows } = await client.query<ReleaseRow>(
      `update release set merge_state='sending', merge_sending_at=$2, merge_detail=null, fencing_token=fencing_token+1, updated_at=$2,
              merge_approver_user_id=$3, merge_approved_at=$2, approved_head_sha=$4
        where id=$1 returning *`,
      [release.id, now, userId, headSha],
    );
    return rows[0] as ReleaseRow;
  }
  const { rows } = await client.query<ReleaseRow>(
    `insert into release (job_id, repo, pr_number, head_sha, merge_state, merge_sending_at, merge_approver_user_id, merge_approved_at,
                          approved_head_sha, created_at, updated_at)
     values ($1,$2,$3,$4,'sending',$5,$6,$5,$4,$5,$5) returning *`,
    [job.id, job.target_repo_id, pr.number, headSha, now, userId],
  );
  return rows[0] as ReleaseRow;
}

function signalOf(deps: ReleaseDeps): AbortSignal {
  return AbortSignal.timeout(deps.httpTimeoutMs ?? 30_000);
}

async function markMerge(
  release: ReleaseRow,
  state: 'unknown' | 'rejected',
  detail: string,
  actor: Actor,
  correlationId: string,
  now: Date,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `update release set merge_state=$2, merge_detail=$3, merge_sending_at=null, updated_at=$4 where id=$1 and merge_state='sending'`,
      [release.id, state, detail, now],
    );
    await insertJobEvent(client, {
      jobId: release.job_id,
      at: now,
      kind: state === 'unknown' ? 'merge_unknown' : 'merge_rejected',
      actorType: 'system',
      correlationId,
      detail: { detail, approvedBy: actor.userId },
    });
    await appendAuditTx(client, {
      action: 'job.merge_result',
      targetType: 'job',
      targetId: release.job_id,
      result: 'error',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { mergeState: state, detail },
    });
  });
}

/** 送信前に分かる拒否の言い方。内部の応答の本文は出さない。 */
const REJECT_MESSAGE: Record<string, string> = {
  head_changed: 'PR の head が承認した SHA から変わりました（承認は失効しました）',
  pr_closed: 'PR が閉じられています（承認は失効しました）',
  not_own: 'この job が作った PR ではありません（承認は失効しました）',
  base_changed: 'PR の merge 先が既定のブランチではありません（承認は失効しました）',
  not_mergeable: 'GitHub が merge を受け付けませんでした（必須検査・競合・保護を確かめてください）',
  refused: 'GitHub が merge を拒否しました（権限と保護を確かめてください）',
  rate_limited: 'GitHub が混み合っています。少し待ってもう一度押してください',
  pr_unreadable: 'PR を読めませんでした。merge は送っていません。もう一度押してください',
  repo_refused: '対象リポジトリが許可されていません',
};

async function reject(
  release: ReleaseRow,
  detail: string,
  actor: Actor,
  correlationId: string,
  deps: ReleaseDeps,
): Promise<never> {
  await markMerge(release, 'rejected', detail, actor, correlationId, deps.now());
  const message = REJECT_MESSAGE[detail] ?? 'merge できませんでした';
  throw new ApiError('ERR-202', message, 409, { mergeState: 'rejected', detail });
}

async function sendMerge(
  release: ReleaseRow,
  mode: 'send' | 'reconcile',
  headSha: string,
  actor: Actor,
  correlationId: string,
  deps: ReleaseDeps,
): Promise<ReleaseActionResult> {
  const unknown = async (detail: string): Promise<never> => {
    await markMerge(release, 'unknown', detail, actor, correlationId, deps.now());
    throw new ApiError(
      'ERR-304',
      'merge の結果を確認できませんでした。もう一度押すと PR を読んで照合します（作り直しません）',
      502,
      {
        mergeState: 'unknown',
      },
    );
  };

  if (!deps.allowedRepos.some((r) => r.name === release.repo)) return reject(release, 'repo_refused', actor, correlationId, deps);
  const read = await deps.merge.getPull({ repo: release.repo, number: release.pr_number }, signalOf(deps));
  // 照合の途中なら merge 済みかもしれない。初回は送っていないので、未送信と言える
  if (!read.ok) return mode === 'send' ? reject(release, 'pr_unreadable', actor, correlationId, deps) : unknown('pr_unreadable');
  const pull = read.value;
  if (!pull) return reject(release, 'pr_closed', actor, correlationId, deps);
  if (pull.merged) return confirmMerged(release, pull, actor, correlationId, deps);
  if (pull.state !== 'open') return reject(release, 'pr_closed', actor, correlationId, deps);
  if (pull.headSha !== headSha) return reject(release, 'head_changed', actor, correlationId, deps);
  const own = await isOwnPull(pull, release, deps);
  if (own === 'unknown')
    return mode === 'send' ? reject(release, 'pr_unreadable', actor, correlationId, deps) : unknown('pr_unreadable');
  if (own !== 'own') return reject(release, own, actor, correlationId, deps);

  const sent = await deps.merge.mergePull(
    {
      repo: release.repo,
      number: release.pr_number,
      sha: headSha,
      title: `merge PR #${release.pr_number} (approved ${headSha.slice(0, 12)})`,
    },
    signalOf(deps),
  );
  if (sent.outcome === 'merged') {
    return confirmMerged(release, { ...pull, merged: true, mergeSha: sent.mergeSha }, actor, correlationId, deps);
  }
  if (sent.outcome === 'rejected') return reject(release, sent.cause, actor, correlationId, deps);
  // 応答を失った。送り直さず読む
  const again = await deps.merge.getPull({ repo: release.repo, number: release.pr_number }, signalOf(deps));
  if (again.ok && again.value?.merged) return confirmMerged(release, again.value, actor, correlationId, deps);
  return unknown(sent.reason);
}

async function isOwnPull(
  pull: PullMergeFacts,
  release: ReleaseRow,
  deps: ReleaseDeps,
): Promise<'own' | 'not_own' | 'base_changed' | 'unknown'> {
  const actor = await deps.merge.getActorLogin(signalOf(deps));
  if (!actor.ok) return 'unknown';
  if (pull.authorLogin !== actor.value || parsePrMarker(pull.body ?? '')?.jobId !== release.job_id) return 'not_own';
  const branch = await deps.merge.getDefaultBranch(release.repo, signalOf(deps));
  if (!branch.ok) return 'unknown';
  return pull.baseRef === branch.value ? 'own' : 'base_changed';
}

async function treesOf(
  release: ReleaseRow,
  mergeSha: string,
  deps: ReleaseDeps,
): Promise<{ head: string | null; merge: string | null; match: boolean | null }> {
  const head = await deps.merge.getCommitTree({ repo: release.repo, sha: release.head_sha }, signalOf(deps));
  const merge = await deps.merge.getCommitTree({ repo: release.repo, sha: mergeSha }, signalOf(deps));
  const headTree = head.ok ? head.value : null;
  const mergeTree = merge.ok ? merge.value : null;
  // 読めなければ判定しない（null）。配備へは進めず、押し直しで読み直す
  return { head: headTree, merge: mergeTree, match: headTree && mergeTree ? headTree === mergeTree : null };
}

async function confirmMerged(
  release: ReleaseRow,
  pull: PullMergeFacts,
  actor: Actor,
  correlationId: string,
  deps: ReleaseDeps,
): Promise<ReleaseActionResult> {
  if (!pull.mergeSha) {
    await markMerge(release, 'unknown', 'no_merge_sha', actor, correlationId, deps.now());
    throw new ApiError('ERR-304', 'merge の記録を読めませんでした。もう一度押すと照合します', 502, { mergeState: 'unknown' });
  }
  if (pull.headSha !== release.head_sha) {
    // 検査していない head が merge されていた。job を進めず、人へ知らせる
    return reject(release, 'head_changed', actor, correlationId, deps);
  }
  const mergeSha = pull.mergeSha;
  const trees = await treesOf(release, mergeSha, deps);
  const now = deps.now();
  await withTransaction(async (client) => {
    const moved = await client.query(
      `update job set state='approved', fencing_token=fencing_token+1, updated_at=$3 where id=$1 and state='pr_ready' and head_sha=$2`,
      [release.job_id, release.head_sha, now],
    );
    if ((moved.rowCount ?? 0) === 0) throw Errors.conflict();
    await client.query(`update job set state='merged', updated_at=$2 where id=$1 and state='approved'`, [release.job_id, now]);
    const human = { actorType: 'human' as const, actorUserId: actor.userId, correlationId };
    await insertJobEvent(client, {
      jobId: release.job_id,
      at: now,
      kind: 'transition',
      from: 'pr_ready',
      to: 'approved',
      ...human,
      detail: { headSha: release.head_sha },
    });
    await insertJobEvent(client, {
      jobId: release.job_id,
      at: now,
      kind: 'transition',
      from: 'approved',
      to: 'merged',
      ...human,
      detail: { mergeSha, treeMatch: trees.match },
    });
    await client.query(
      `update release set merge_state='merged', merge_detail=null, merge_sending_at=null, merge_sha=$2, head_tree_sha=$3, merge_tree_sha=$4,
              tree_match=$5, fencing_token=fencing_token+1, updated_at=$6
        where id=$1`,
      [release.id, mergeSha, trees.head, trees.merge, trees.match, now],
    );
    if (trees.match === true) await enqueueBuild(client, release, mergeSha, correlationId, now);
    await appendAuditTx(client, {
      action: 'job.merged',
      targetType: 'job',
      targetId: release.job_id,
      result: 'success',
      actorUserId: actor.userId,
      actorName: actor.displayName,
      role: actor.role,
      correlationId,
      diff: { from: 'pr_ready', to: 'merged', headSha: release.head_sha, mergeSha, treeMatch: trees.match },
    });
  });
  return { job: (await getJobView(release.job_id)) as JobView, alreadyDone: false, mergeState: 'merged' };
}

async function enqueueBuild(
  client: PoolClient,
  release: ReleaseRow,
  mergeSha: string,
  correlationId: string,
  now: Date,
): Promise<void> {
  await client.query(
    `insert into release_attempt (release_id, job_id, kind, environment, sha, correlation_id, created_at)
     values ($1,$2,'build',$3,$4,$5,$6)`,
    [release.id, release.job_id, DEPLOY_ENVIRONMENT, mergeSha, correlationId, now],
  );
}

/** merge 後に tree を読めなかったものを読み直す。一致したときだけ成果物の作成へ進む。 */
async function settleTree(release: ReleaseRow, deps: ReleaseDeps, correlationId: string): Promise<void> {
  const trees = await treesOf(release, release.merge_sha as string, deps);
  if (trees.match === null) return;
  const now = deps.now();
  await withTransaction(async (client) => {
    const updated = await client.query(
      `update release set head_tree_sha=$2, merge_tree_sha=$3, tree_match=$4, updated_at=$5 where id=$1 and tree_match is null`,
      [release.id, trees.head, trees.merge, trees.match, now],
    );
    if ((updated.rowCount ?? 0) > 0 && trees.match === true) {
      await enqueueBuild(client, release, release.merge_sha as string, correlationId, now);
    }
  });
}

/* ───────────────────────────── 配備の承認 ───────────────────────────── */

async function environmentNow(
  client: PoolClient | null,
  environment: string,
): Promise<{ digest: string | null; sha: string | null }> {
  const sql = `select deployed_digest, deployed_sha from release_attempt
                where environment=$1 and kind in ('deploy','rollback') and state in ('succeeded','failed')
                order by seq desc limit 1`;
  const { rows } = client
    ? await client.query<{ deployed_digest: string | null; deployed_sha: string | null }>(sql, [environment])
    : await query<{ deployed_digest: string | null; deployed_sha: string | null }>(sql, [environment]);
  return { digest: rows[0]?.deployed_digest ?? null, sha: rows[0]?.deployed_sha ?? null };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export async function approveDeploy(
  input: { jobId: string; sha: string; digest: string; environment: string },
  actor: Actor,
  correlationId: string,
  now: Date,
): Promise<ReleaseActionResult> {
  const action = 'job.deploy_approve';
  if (!UUID_RE.test(input.jobId)) throw Errors.notFound('ジョブ');
  let refused: Refusal | null = null;
  let alreadyDone = false;
  try {
    await withTransaction(async (client) => {
      const locked = await client.query<JobRow>('select * from job where id = $1 for update', [input.jobId]);
      const job = locked.rows[0];
      if (!job) throw Errors.notFound('ジョブ');
      const existing = await client.query<ReleaseRow>('select * from release where job_id = $1 for update', [job.id]);
      const release = existing.rows[0];
      const facts = await orderFacts(client, job);
      const isAgent = await isAgentUser(client, actor.userId);
      // 押し直し。同じ3つで配備済みなら同じ結果を返す
      if (
        job.state === 'staged' &&
        !isAgent &&
        actor.role === 'approver' &&
        release?.merge_sha === input.sha &&
        release.image_digest === input.digest &&
        release.environment === input.environment
      ) {
        alreadyDone = true;
        return;
      }
      const decision = decideDeploy({
        approver: { role: actor.role, isAgent },
        jobState: job.state,
        superseded: job.superseded_at !== null,
        orderCurrent: facts.current,
        mergeSha: release?.merge_sha ?? null,
        treeMatch: release?.tree_match ?? null,
        imageDigest: release?.image_digest ?? null,
        artifactHealth: release?.artifact_health ?? null,
        artifactSmoke: release?.artifact_smoke ?? null,
        environment: DEPLOY_ENVIRONMENT,
        requested: { sha: input.sha, digest: input.digest, environment: input.environment },
      });
      if (!decision.ok || !release) {
        refused = decision.ok ? { ok: false, refusal: 'no_artifact', message: '検査済みの成果物がまだありません' } : decision;
        return;
      }
      const env = await environmentNow(client, DEPLOY_ENVIRONMENT);
      await client.query(
        `insert into release_approval (release_id, job_id, kind, approver_user_id, approver_name, role, sha, digest, environment, correlation_id, decided_at)
         values ($1,$2,'deploy',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          release.id,
          job.id,
          actor.userId,
          actor.displayName,
          actor.role,
          input.sha,
          input.digest,
          input.environment,
          correlationId,
          now,
        ],
      );
      await client.query(
        `update release set deploy_approver_user_id=$2, deploy_approved_at=$3, deploy_approved_sha=$4, deploy_approved_digest=$5,
                environment=$6, fencing_token=fencing_token+1, updated_at=$3
          where id=$1`,
        [release.id, actor.userId, now, input.sha, input.digest, input.environment],
      );
      await client.query(
        `insert into release_attempt (release_id, job_id, kind, environment, sha, digest, previous_digest, previous_sha, requested_by, correlation_id, created_at)
         values ($1,$2,'deploy',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [release.id, job.id, input.environment, input.sha, input.digest, env.digest, env.sha, actor.userId, correlationId, now],
      );
      await insertJobEvent(client, {
        jobId: job.id,
        at: now,
        kind: 'deploy_approved',
        actorType: 'human',
        actorUserId: actor.userId,
        correlationId,
        detail: { sha: input.sha, digest: input.digest, environment: input.environment },
      });
      await appendAuditTx(client, {
        action,
        targetType: 'job',
        targetId: job.id,
        result: 'success',
        actorUserId: actor.userId,
        actorName: actor.displayName,
        role: actor.role,
        correlationId,
        diff: { sha: input.sha, digest: input.digest, environment: input.environment },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict('この環境で別の配備か戻しが進んでいます。結果を待ってください');
    throw err;
  }
  if (refused) return deny(action, input.jobId, refused, actor, correlationId);
  return { job: (await getJobView(input.jobId)) as JobView, alreadyDone };
}

/* ───────────────────────────── 戻し ───────────────────────────── */

export async function rollbackRelease(
  input: { jobId: string; reason: string },
  actor: Actor,
  correlationId: string,
  now: Date,
): Promise<ReleaseActionResult> {
  const action = 'job.rollback';
  if (!UUID_RE.test(input.jobId)) throw Errors.notFound('ジョブ');
  const reason = input.reason.trim();
  let refused: Refusal | null = null;
  try {
    await withTransaction(async (client) => {
      const locked = await client.query<JobRow>('select * from job where id = $1 for update', [input.jobId]);
      const job = locked.rows[0];
      if (!job) throw Errors.notFound('ジョブ');
      const existing = await client.query<ReleaseRow>('select * from release where job_id = $1 for update', [job.id]);
      const release = existing.rows[0];
      const env = await environmentNow(client, DEPLOY_ENVIRONMENT);
      const decision = decideRollback({
        approver: { role: actor.role, isAgent: await isAgentUser(client, actor.userId) },
        jobState: job.state,
        imageDigest: release?.image_digest ?? null,
        previousDigest: release?.previous_digest ?? null,
        environmentDigest: env.digest,
      });
      if (!decision.ok || !release) {
        refused = decision.ok ? { ok: false, refusal: 'not_current', message: '配備の記録がありません' } : decision;
        return;
      }
      if (reason === '') throw Errors.reasonRequired();
      await client.query(
        `insert into release_approval (release_id, job_id, kind, approver_user_id, approver_name, role, sha, digest, environment, reason, correlation_id, decided_at)
         values ($1,$2,'rollback',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          release.id,
          job.id,
          actor.userId,
          actor.displayName,
          actor.role,
          release.previous_sha,
          release.previous_digest,
          DEPLOY_ENVIRONMENT,
          reason,
          correlationId,
          now,
        ],
      );
      await client.query(
        `insert into release_attempt (release_id, job_id, kind, environment, sha, digest, previous_digest, previous_sha, requested_by, reason, correlation_id, created_at)
         values ($1,$2,'rollback',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          release.id,
          job.id,
          DEPLOY_ENVIRONMENT,
          release.previous_sha,
          release.previous_digest,
          env.digest,
          env.sha,
          actor.userId,
          reason,
          correlationId,
          now,
        ],
      );
      await insertJobEvent(client, {
        jobId: job.id,
        at: now,
        kind: 'rollback_requested',
        actorType: 'human',
        actorUserId: actor.userId,
        correlationId,
        detail: { toDigest: release.previous_digest, reason },
      });
      await appendAuditTx(client, {
        action,
        targetType: 'job',
        targetId: job.id,
        result: 'success',
        actorUserId: actor.userId,
        actorName: actor.displayName,
        role: actor.role,
        correlationId,
        diff: { toDigest: release.previous_digest, reason },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict('この環境で別の配備か戻しが進んでいます。結果を待ってください');
    throw err;
  }
  if (refused) return deny(action, input.jobId, refused, actor, correlationId);
  return { job: (await getJobView(input.jobId)) as JobView, alreadyDone: false };
}

/* ───────────────────────────── 読み取り ───────────────────────────── */

/** merge の結果の語。決まった語のほかは出さない（内部エラーの本文を返さない）。 */
const PUBLIC_DETAILS = new Set([
  'head_changed',
  'pr_closed',
  'not_own',
  'base_changed',
  'not_mergeable',
  'refused',
  'rate_limited',
  'pr_unreadable',
  'repo_refused',
  'timeout',
  'network',
  'http',
  'bad_response',
  'no_merge_sha',
]);

/** 証跡（job ごと）。トークンも応答の本文も持たない。release が無い job も AC だけは返す。 */
export async function listReleaseEvidence(requestId: string): Promise<Record<string, ReleaseEvidence>> {
  const jobs = await query<JobRow>('select * from job where request_id = $1', [requestId]);
  if (jobs.rows.length === 0) return {};
  const ids = jobs.rows.map((j) => j.id);
  const [releases, approvals, attempts, verifications, request, env] = await Promise.all([
    query<ReleaseRow>('select * from release where job_id = any($1::uuid[])', [ids]),
    query<{
      job_id: string;
      kind: 'merge' | 'deploy' | 'rollback';
      approver_name: string;
      sha: string;
      digest: string | null;
      environment: string | null;
      reason: string | null;
      decided_at: Date;
    }>('select * from release_approval where job_id = any($1::uuid[]) order by decided_at, id', [ids]),
    query<{
      job_id: string;
      kind: 'build' | 'deploy' | 'rollback';
      state: 'pending' | 'running' | 'succeeded' | 'failed';
      sha: string;
      digest: string | null;
      previous_digest: string | null;
      health: boolean | null;
      smoke: boolean | null;
      url: string | null;
      error_code: string | null;
      auto_rollback: 'restored' | 'nothing_to_restore' | 'failed' | null;
      created_at: Date;
      finished_at: Date | null;
    }>('select * from release_attempt where job_id = any($1::uuid[]) order by seq', [ids]),
    query<VerificationRow & { job_id: string }>('select * from verification where job_id = any($1::uuid[])', [ids]),
    query<{ criteria: string[] }>('select criteria from request where id = $1', [requestId]),
    environmentNow(null, DEPLOY_ENVIRONMENT),
  ]);
  const acIds = acIdsOf(request.rows[0]?.criteria ?? []);
  const out: Record<string, ReleaseEvidence> = {};
  for (const job of jobs.rows) {
    const r = releases.rows.find((x) => x.job_id === job.id);
    const records = verifications.rows.filter((v) => v.job_id === job.id).map(toRecord);
    const verdict = records.length && job.head_sha ? evaluateVerification(records, job.head_sha, acIds) : null;
    out[job.id] = {
      repo: r?.repo ?? null,
      prNumber: r?.pr_number ?? null,
      headSha: r?.head_sha ?? job.head_sha,
      mergeState: r?.merge_state ?? 'none',
      mergeDetail: r?.merge_detail && PUBLIC_DETAILS.has(r.merge_detail) ? r.merge_detail : null,
      mergeSha: r?.merge_sha ?? null,
      treeMatch: r?.tree_match ?? null,
      imageDigest: r?.image_digest ?? null,
      artifactBuiltAt: r?.artifact_built_at?.toISOString() ?? null,
      artifactHealth: r?.artifact_health ?? null,
      artifactSmoke: r?.artifact_smoke ?? null,
      environment: DEPLOY_ENVIRONMENT,
      deployedAt: r?.deployed_at?.toISOString() ?? null,
      health: r?.health ?? null,
      smoke: r?.smoke ?? null,
      url: r?.url ?? null,
      previousDigest: r?.previous_digest ?? null,
      currentDigest: r?.current_digest ?? null,
      rolledBackAt: r?.rolled_back_at?.toISOString() ?? null,
      environmentDigest: env.digest,
      ac: verdict
        ? ((verdict as { acEvidence?: { acId: string; mark: string; ciRunId: string | null }[] }).acEvidence?.map((e) => ({
            acId: e.acId,
            mark: e.mark,
            ciRunId: e.ciRunId,
          })) ?? [])
        : [],
      acVerdict: verdict?.verdict ?? null,
      approvals: approvals.rows
        .filter((a) => a.job_id === job.id)
        .map((a) => ({
          kind: a.kind,
          approverName: a.approver_name,
          sha: a.sha,
          digest: a.digest,
          environment: a.environment,
          reason: a.reason,
          decidedAt: a.decided_at.toISOString(),
        })),
      attempts: attempts.rows
        .filter((a) => a.job_id === job.id)
        .map((a) => ({
          kind: a.kind,
          state: a.state,
          sha: a.sha,
          digest: a.digest,
          previousDigest: a.previous_digest,
          health: a.health,
          smoke: a.smoke,
          url: a.url,
          errorCode: a.error_code,
          autoRollback: a.auto_rollback,
          createdAt: a.created_at.toISOString(),
          finishedAt: a.finished_at?.toISOString() ?? null,
        })),
    };
  }
  return out;
}

/** DevOps の KPI（W-09）。カードごとに jobs を読まず、1回で集計する。 */
export async function devlineSummary(): Promise<DevlineSummary> {
  const { rows } = await query<{ stopped: number; merge_waiting: number }>(
    `select
       (select count(*)::int from job j
         where j.superseded_at is null
           and (j.state in ('stopped','failed')
                or exists (select 1 from release_attempt a
                            where a.job_id = j.id and a.kind in ('deploy','rollback') and a.state = 'failed'
                              and a.seq = (select max(b.seq) from release_attempt b where b.job_id = j.id and b.kind in ('deploy','rollback')))
                or exists (select 1 from release_attempt a
                            where a.job_id = j.id and a.kind = 'build' and a.state = 'failed' and j.state = 'merged'
                              and a.seq = (select max(b.seq) from release_attempt b where b.job_id = j.id and b.kind = 'build'))
                or exists (select 1 from release r where r.job_id = j.id and j.state = 'pr_ready' and r.merge_state = 'rejected')
                or exists (select 1 from release r where r.job_id = j.id and j.state = 'merged' and r.tree_match = false))
       ) as stopped,
       (select count(*)::int from job j join request r on r.id = j.request_id
         where j.state = 'pr_ready' and j.superseded_at is null and j.work_state ? 'pr'
           and r.deleted = false and r.order_version = j.order_version
           and not exists (select 1 from release x where x.job_id = j.id and x.merge_state in ('rejected','merged'))
       ) as merge_waiting`,
  );
  return { stopped: rows[0]?.stopped ?? 0, mergeWaiting: rows[0]?.merge_waiting ?? 0 };
}
