/**
 * 版固定と冪等 handoff（API-06・IF-03・ADR D-02/D-03/D-04 と 4章）。
 *
 * 順序: intent を commit → claim して sent を commit → 外部呼び出し → 別トランザクションで確定。
 * 外部 API の冪等キーを仮定しない。応答不明は盲目的に再送せず、list API でマーカーを探す。
 * 外部呼び出しをトランザクションの中で行わない。
 */
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { pool, query, withTransaction, type Db } from './db.js';
import { appendAudit, appendAuditTx } from './audit.js';
import { ApiError, Errors } from './http.js';
import { getRequestRow, getRequestRowForUpdate, mapRequest, type RequestRow } from './repo.js';
import type { Actor } from './service.js';
import { buildIssueBody, safeIssueTitle } from './github.js';
import { createGithubIssueAdapter } from './issue-adapter.js';
import { DEFAULT_SECRETS_PATH, RealLineRefused, checkRealLineEnv, loadDevlineGithubToken } from './devline-real-config.js';
import { haltLockedJob, insertJobEvent, sha256Hex, type JobRow } from './devline-jobs.js';
import {
  DEVLINE_POLICY,
  HANDOFF_POLICY,
  ORDER_ENVELOPE_SCHEMA,
  POLICY_VERSION,
  afterReconcileNotFound,
  buildHandoffMarker,
  buildSnapshotYaml,
  canConfirmAbsent,
  canHandoff,
  canonicalJson,
  checkOrderForHandoff,
  parseHandoffMarker,
  haltTarget,
  isOrderCurrent,
  isRepoAllowed,
  matchIssueByMarker,
  nextHandoffAction,
  rateLimitedRetryAt,
} from '../shared/devline.js';
import type {
  AllowedRepo,
  ApprovalFacts,
  HandoffOp,
  HandoffResult,
  HandoffState,
  IssueAdapter,
  IssueSendOutcome,
  IssueSummary,
  JobState,
  OrderEnvelopeV1,
  RunnerKind,
} from '../shared/devline.js';
import { SIGNAL_LABEL } from '../shared/domain.js';
import type { Signal } from '../shared/domain.js';

export interface DevlineDeps {
  issueAdapter: IssueAdapter;
  /** 既定は config.githubRepo。クライアントから受けない。 */
  targetRepo: string;
  /** DEVLINE_TARGET_REPOS。既定は空で、投入はすべて拒否（ADR 11章）。 */
  allowedRepos: readonly AllowedRepo[];
  now: () => Date;
  /** 外部呼び出し1回の時間切れ。既定は HANDOFF_POLICY.httpTimeoutMs。 */
  httpTimeoutMs?: number;
  /** 作る job の runner。既定は fake。実 runner は1件実走の入口だけが指定する。 */
  runnerKind?: RunnerKind;
}

/**
 * 実 runner の依存。対象は DEVLINE_TARGET_REPOS の唯一の許可先、トークンは DEVLINE_GITHUB_TOKEN だけ。
 * GITHUB_REPO・GITHUB_TOKEN は見ない。読めない・足りないときは ERR-405 で、fake へ落とさない。
 */
function realDevlineDeps(): DevlineDeps {
  const allowed = config.devlineTargetRepos;
  const refused = checkRealLineEnv({ ...process.env, NODE_ENV: config.nodeEnv }, allowed);
  if (refused) throw new ApiError('ERR-405', `開発ラインの設定が正しくありません（${refused}）`, 409);
  const target = allowed[0] as AllowedRepo;
  if (allowed.some((r) => r.name !== target.name)) {
    throw new ApiError('ERR-405', '開発ラインの設定が正しくありません（DEVLINE_TARGET_REPOS は1件にしてください）', 409);
  }
  let token: string;
  try {
    token = loadDevlineGithubToken(config.devlineSecretsFile || DEFAULT_SECRETS_PATH, config.nodeEnv);
  } catch (err) {
    const why = err instanceof RealLineRefused ? err.message : '資格情報を読めません';
    throw new ApiError('ERR-405', `開発ラインの設定が正しくありません（${why}）`, 409);
  }
  return {
    issueAdapter: createGithubIssueAdapter({ token, apiUrl: config.githubApiUrl, nodeEnv: config.nodeEnv }),
    targetRepo: target.name,
    allowedRepos: allowed,
    now: () => new Date(),
    runnerKind: 'docker-claude',
  };
}

/**
 * 既定の依存。設定が足りなければ ERR-405。呼ぶたびに作る（試験の差し替えと設定の読み直しのため）。
 * runner の種別・対象・トークンはサーバの設定だけで決まる。ブラウザからは指定できない。
 */
export function defaultDevlineDeps(): DevlineDeps {
  if (config.devlineRunnerKind === 'docker-claude') return realDevlineDeps();
  // 綴りの誤りを fake として動かさない
  if (config.devlineRunnerKind !== 'fake') {
    throw new ApiError('ERR-405', '開発ラインの設定が正しくありません（DEVLINE_RUNNER_KIND）', 409);
  }
  if (!config.githubToken || !config.githubRepo) {
    throw new ApiError('ERR-405', 'GitHub連携が設定されていません（管理者に確認してください）', 409);
  }
  return {
    issueAdapter: createGithubIssueAdapter({
      token: config.githubToken,
      apiUrl: config.githubApiUrl,
      nodeEnv: config.nodeEnv,
    }),
    targetRepo: config.githubRepo,
    allowedRepos: config.devlineTargetRepos,
    now: () => new Date(),
  };
}

interface IntentRow {
  id: string;
  snapshot_id: string;
  request_id: string;
  order_version: number;
  target_repo_id: string;
  op_kind: HandoffOp;
  state: HandoffState;
  marker: string;
  target_issue_no: number | null;
  issue_no: number | null;
  issue_url: string | null;
  attempts: number;
  sent_at: Date | null;
  next_attempt_at: Date | null;
  created_at: Date;
}

interface SnapshotRow {
  id: string;
  order_version: number;
  content_sha256: string;
  canonical_yaml: string;
  envelope: OrderEnvelopeV1;
}

type AuditFields = { actorUserId: string; actorName: string; role: string };

function auditFields(actor: Actor): AuditFields {
  return { actorUserId: actor.userId, actorName: actor.displayName, role: actor.role };
}

function misconfigured(message: string): ApiError {
  return new ApiError('ERR-405', message, 409);
}

function timeoutSignal(deps: DevlineDeps): AbortSignal {
  return AbortSignal.timeout(deps.httpTimeoutMs ?? HANDOFF_POLICY.httpTimeoutMs);
}

async function loadLatestApproval(db: Db, requestId: string): Promise<ApprovalFacts | null> {
  const { rows } = await db.query<{
    id: string;
    decision: ApprovalFacts['decision'];
    order_version: number | null;
    approver_user_id: string | null;
    decided_signal: Signal | null;
    suggested_signal: Signal | null;
    at: Date;
  }>(
    `select id, decision, order_version, approver_user_id, decided_signal, suggested_signal, at
       from approval where request_id = $1 order by at desc, id desc limit 1`,
    [requestId],
  );
  const a = rows[0];
  if (!a) return null;
  return {
    id: a.id,
    decision: a.decision,
    orderVersion: a.order_version,
    approverUserId: a.approver_user_id,
    decidedSignal: a.decided_signal,
    suggestedSignal: a.suggested_signal,
    at: a.at.toISOString(),
  };
}

function checkFailure(code: 'ERR-202' | 'ERR-205', reason: string): ApiError {
  return new ApiError(code, reason, 409);
}

function orderCurrent(row: Pick<RequestRow, 'status' | 'deleted' | 'order_version'>, version: number): boolean {
  return isOrderCurrent({
    requestStatus: row.status,
    requestDeleted: row.deleted,
    requestOrderVersion: row.order_version,
    jobOrderVersion: version,
  });
}

/* ───────────────────────────── 版固定 ───────────────────────────── */

/**
 * 依頼の今の版を固定する。一度だけ作り、以後は保存した本文を読むだけ（再生成して比べない）。
 * 呼び出し側のトランザクションの中で呼ぶ。依頼の行をここでロックする。
 */
export async function freezeOrderSnapshot(
  client: PoolClient,
  input: { requestId: string; targetRepoId: string; baseSha: string; now: Date },
): Promise<{ snapshotId: string; orderVersion: number; contentSha256: string; created: boolean }> {
  const row = await getRequestRowForUpdate(client, input.requestId);
  if (!row) throw Errors.notFound('依頼');
  const existing = await client.query<SnapshotRow>(
    'select * from order_snapshot where request_id=$1 and order_version=$2 and target_repo_id=$3',
    [input.requestId, row.order_version, input.targetRepoId],
  );
  if (existing.rows[0]) {
    return {
      snapshotId: existing.rows[0].id,
      orderVersion: row.order_version,
      contentSha256: existing.rows[0].content_sha256,
      created: false,
    };
  }
  const check = checkOrderForHandoff({
    requestStatus: row.status,
    requestDeleted: row.deleted,
    requestOrderVersion: row.order_version,
    requestSignalDecided: row.signal_decided,
    latestApproval: await loadLatestApproval(client, input.requestId),
    requestedOrderVersion: null,
  });
  if (!check.ok) throw checkFailure(check.code, check.reason);

  const yaml = buildSnapshotYaml({
    request: mapRequest(row),
    suggested: check.suggested,
    approvalSuggested: check.suggested,
    departmentName: row.dept_name ?? row.dept_code,
    catalogToolName: row.tool_name ?? '',
  });
  const contentSha256 = sha256Hex(yaml);
  const approval = await client.query<{ at: Date }>('select at from approval where id = $1', [check.approvalId]);
  const envelope: OrderEnvelopeV1 = {
    schema: ORDER_ENVELOPE_SCHEMA,
    request_id: input.requestId,
    order_version: row.order_version,
    content_sha256: contentSha256,
    approval: {
      id: check.approvalId,
      approver_user_id: check.approverUserId,
      decided_signal: check.decided,
      suggested_signal: check.suggested,
      approved_at: (approval.rows[0] as { at: Date }).at.toISOString(),
    },
    target_repo_id: input.targetRepoId,
    base_sha: input.baseSha,
    policy_version: POLICY_VERSION,
    frozen_at: input.now.toISOString(),
  };
  const inserted = await client.query<{ id: string }>(
    `insert into order_snapshot (request_id, order_version, content_sha256, canonical_yaml, envelope, envelope_sha256,
       approval_id, approver_user_id, target_repo_id, base_sha, policy_version, frozen_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      input.requestId,
      row.order_version,
      contentSha256,
      yaml,
      JSON.stringify(envelope),
      sha256Hex(canonicalJson(envelope)),
      check.approvalId,
      check.approverUserId,
      input.targetRepoId,
      input.baseSha,
      POLICY_VERSION,
      input.now,
    ],
  );
  return {
    snapshotId: (inserted.rows[0] as { id: string }).id,
    orderVersion: row.order_version,
    contentSha256,
    created: true,
  };
}

/* ───────────────────────────── 投入 ───────────────────────────── */

async function denyHandoff(requestId: string, actor: Actor, correlationId: string, why: string): Promise<never> {
  await appendAudit({
    action: 'handoff.intent',
    targetType: 'request',
    targetId: requestId,
    result: 'denied',
    ...auditFields(actor),
    correlationId,
    diff: { why },
  });
  throw Errors.noPermission();
}

async function findIntent(requestId: string, version: number, repo: string): Promise<IntentRow | null> {
  const { rows } = await query<IntentRow>(
    `select * from handoff_intent where request_id=$1 and order_version=$2 and target_repo_id=$3
      order by created_at desc limit 1`,
    [requestId, version, repo],
  );
  return rows[0] ?? null;
}

async function reloadIntent(id: string): Promise<IntentRow> {
  const { rows } = await query<IntentRow>('select * from handoff_intent where id = $1', [id]);
  return rows[0] as IntentRow;
}

function unknownError(
  scanComplete: boolean | undefined,
  message = '連携先に接続できませんでした（結果を確認できていません）',
): ApiError {
  return new ApiError('ERR-304', message, 502, {
    handoffState: 'unknown',
    ...(scanComplete === undefined ? {} : { scanComplete }),
  });
}

function readFailure(): ApiError {
  return new ApiError('ERR-304', '連携先に接続できませんでした', 502);
}

/** 名前の付け替えや譲渡で別のリポジトリへ送らないよう、許可リストの数値 ID と照らす。 */
async function assertRepoIdentity(deps: DevlineDeps): Promise<void> {
  const allowed = deps.allowedRepos.find((r) => r.name === deps.targetRepo);
  if (!allowed) throw misconfigured('対象リポジトリが許可されていません（DEVLINE_TARGET_REPOS）');
  const got = await deps.issueAdapter.getRepoId(deps.targetRepo, timeoutSignal(deps));
  if (!got.ok) throw readFailure();
  if (got.value !== allowed.repoId) throw misconfigured('対象リポジトリの ID が許可リストと一致しません（DEVLINE_TARGET_REPOS）');
  // 注文書に依頼者欄・承認者欄が載るので、公開リポジトリへは常に投入しない（例外の設定を作らない）
  const isPrivate = await deps.issueAdapter.getRepoPrivate(deps.targetRepo, timeoutSignal(deps));
  if (!isPrivate.ok) throw readFailure();
  if (!isPrivate.value) throw misconfigured('公開リポジトリへは投入できません（非公開のリポジトリを設定してください）');
}

/**
 * PATCH の前に対象を確かめる。request.issue_no が指す番号が、PR・他人の Issue・別の依頼の Issue であれば上書きしない。
 * 読めないときは送らない（ERR-304）。不一致は ERR-405。
 */
async function assertUpdateTarget(intent: IntentRow, deps: DevlineDeps): Promise<void> {
  if (intent.op_kind !== 'update_issue') return;
  const reject = (): ApiError => misconfigured('更新先の Issue がこの依頼のものと確認できないため、送りませんでした');
  const login = await deps.issueAdapter.getActorLogin(timeoutSignal(deps));
  if (!login.ok) throw readFailure();
  const got = await deps.issueAdapter.getIssue(intent.target_repo_id, intent.target_issue_no as number, timeoutSignal(deps));
  if (!got.ok) throw readFailure();
  const issue = got.value;
  if (!issue || issue.isPullRequest || issue.authorLogin !== login.value) throw reject();
  const marker = parseHandoffMarker(issue.body);
  if (!marker || marker.requestId !== intent.request_id || marker.repo !== intent.target_repo_id) throw reject();
}

/** 別のリポジトリに結果の分からない投入が残っている依頼は、対象を変えても作らない（作成済みかもしれない）。 */
async function assertNoUnknownInOtherRepo(requestId: string, repo: string, db: Db = pool): Promise<void> {
  const { rows } = await query<{ target_repo_id: string }>(
    `select target_repo_id from handoff_intent where request_id=$1 and target_repo_id<>$2 and state in ('sent','unknown') limit 1`,
    [requestId, repo],
    db,
  );
  if (rows[0]) {
    throw new ApiError('ERR-405', '別のリポジトリへの投入の結果が確認できていないため、対象を変えて投入できません', 409, {
      handoffState: 'unknown',
      targetRepo: rows[0].target_repo_id,
    });
  }
}

export interface ReconcileOutcome {
  found: IssueSummary | null;
  scanComplete: boolean;
  duplicates: number[];
}

/** 照合（読み取りのみ）。読み取りの失敗や上限切れは「不完全」で、見つからなかったとは言わない。 */
async function reconcile(intent: IntentRow, deps: DevlineDeps): Promise<ReconcileOutcome> {
  if (intent.op_kind === 'update_issue') {
    const got = await deps.issueAdapter.getIssue(intent.target_repo_id, intent.target_issue_no as number, timeoutSignal(deps));
    if (!got.ok) return { found: null, scanComplete: false, duplicates: [] };
    const firstLine = (got.value?.body ?? '').split('\n', 1)[0]?.replace(/\r$/, '');
    return {
      found: got.value && firstLine === intent.marker ? got.value : null,
      scanComplete: true,
      duplicates: [],
    };
  }
  const login = await deps.issueAdapter.getActorLogin(timeoutSignal(deps));
  if (!login.ok) return { found: null, scanComplete: false, duplicates: [] };
  const since = new Date(intent.created_at.getTime() - HANDOFF_POLICY.reconcileSinceMarginMinutes * 60_000);
  const seen: IssueSummary[] = [];
  let page: number | null = 1;
  let pagesRead = 0;
  let complete = false;
  while (page !== null) {
    if (pagesRead >= HANDOFF_POLICY.reconcileMaxPages) break;
    const got = await deps.issueAdapter.listIssuesSince(
      { repo: intent.target_repo_id, since, page, perPage: HANDOFF_POLICY.reconcilePerPage },
      timeoutSignal(deps),
    );
    if (!got.ok) break;
    pagesRead += 1;
    seen.push(...got.value.issues);
    page = got.value.nextPage;
    if (page === null) complete = true;
  }
  const match = matchIssueByMarker(seen, intent.marker, login.value);
  return { found: match.found, scanComplete: complete, duplicates: match.duplicates };
}

/**
 * 古い版の job を、監査の advisory lock より先に握る。cancel や worker は job → advisory の順なので、
 * 逆順にするとデッドロックする（appendAuditTx の前に呼ぶ）。
 */
async function lockOlderJobs(client: PoolClient, intent: IntentRow): Promise<void> {
  await client.query(
    'select id from job where request_id=$1 and target_repo_id=$2 and order_version<$3 order by order_version for update',
    [intent.request_id, intent.target_repo_id, intent.order_version],
  );
}

/** 外部の Issue が存在する事実を記録する。job は依頼がまだ有効なときだけ作る。 */
async function finalizeIntent(
  intent: IntentRow,
  issue: { number: number; url: string },
  ctx: { actor: Actor; correlationId: string; now: Date; runnerKind?: RunnerKind; recovered: boolean; duplicates?: number[] },
): Promise<{ jobId: string | null; jobState: JobState | null }> {
  return withTransaction(async (client) => {
    const row = await getRequestRowForUpdate(client, intent.request_id);
    if (!row) throw Errors.notFound('依頼');
    await lockOlderJobs(client, intent);
    const updated = await client.query(
      `update handoff_intent set state='succeeded', issue_no=$2, issue_url=$3, last_outcome=$4, last_error=null,
              reconciled_at=case when $5::boolean then $6::timestamptz else reconciled_at end, updated_at=$6::timestamptz
        where id=$1 and state in ('sent','unknown')`,
      [intent.id, issue.number, issue.url, ctx.recovered ? 'recovered_by_reconcile' : 'succeeded', ctx.recovered, ctx.now],
    );
    if (updated.rowCount) {
      if (row.issue_no === null) {
        await client.query('update request set issue_no=$2, version=version+1, updated_at=$3, updated_by=$4 where id=$1', [
          intent.request_id,
          issue.number,
          ctx.now,
          ctx.actor.userId,
        ]);
      }
      const verb = intent.op_kind === 'create_issue' ? '作成' : '更新';
      await client.query(
        `insert into request_history (request_id, actor_name, actor_user_id, role, action, note, correlation_id)
         values ($1,$2,$3,$4,'開発ラインへ投入',$5,$6)`,
        [
          intent.request_id,
          ctx.actor.displayName,
          ctx.actor.userId,
          ctx.actor.role,
          `GitHub Issue #${issue.number} を${verb}しました（版 ${intent.order_version}）`,
          ctx.correlationId,
        ],
      );
      await appendAuditTx(client, {
        action: 'handoff.succeeded',
        targetType: 'request',
        targetId: intent.request_id,
        result: 'success',
        ...auditFields(ctx.actor),
        correlationId: ctx.correlationId,
        diff: {
          issue: issue.number,
          orderVersion: intent.order_version,
          op: intent.op_kind,
          recovered: ctx.recovered,
          ...(ctx.duplicates?.length ? { duplicates: ctx.duplicates } : {}),
        },
      });
    }
    return ensureJobInTx(client, intent, row, ctx);
  });
}

/** 依頼が有効なら job を作り、古い版の job を処理する（ADR 4章）。無効なら作らない。 */
async function ensureJobInTx(
  client: PoolClient,
  intent: IntentRow,
  row: RequestRow,
  ctx: { actor: Actor; correlationId: string; now: Date; runnerKind?: RunnerKind },
): Promise<{ jobId: string | null; jobState: JobState | null }> {
  const current = orderCurrent(row, intent.order_version);
  const existing = await client.query<{ id: string; state: JobState }>('select id, state from job where handoff_intent_id = $1', [
    intent.id,
  ]);
  if (existing.rows[0]) return { jobId: existing.rows[0].id, jobState: existing.rows[0].state };
  if (!current) return { jobId: null, jobState: null };
  const inserted = await client.query<{ id: string; state: JobState }>(
    `insert into job (snapshot_id, request_id, order_version, target_repo_id, handoff_intent_id, policy_version, created_at, updated_at, runner_kind)
     values ($1,$2,$3,$4,$5,$6,$7,$7,$8)
     on conflict do nothing
     returning id, state`,
    [
      intent.snapshot_id,
      intent.request_id,
      intent.order_version,
      intent.target_repo_id,
      intent.id,
      DEVLINE_POLICY.version,
      ctx.now,
      ctx.runnerKind ?? 'fake',
    ],
  );
  const job = inserted.rows[0];
  if (!job) return { jobId: null, jobState: null };
  await insertJobEvent(client, {
    jobId: job.id,
    at: ctx.now,
    kind: 'created',
    actorType: 'human',
    actorUserId: ctx.actor.userId,
    correlationId: ctx.correlationId,
    detail: { orderVersion: intent.order_version },
  });
  await appendAuditTx(client, {
    action: 'job.create',
    targetType: 'job',
    targetId: job.id,
    result: 'success',
    ...auditFields(ctx.actor),
    correlationId: ctx.correlationId,
    diff: { requestId: intent.request_id, orderVersion: intent.order_version },
  });
  await supersedeOlderJobs(client, intent, ctx);
  return { jobId: job.id, jobState: job.state };
}

async function supersedeOlderJobs(
  client: PoolClient,
  intent: IntentRow,
  ctx: { actor: Actor; correlationId: string; now: Date },
): Promise<void> {
  const { rows } = await client.query<JobRow>(
    `select * from job where request_id=$1 and target_repo_id=$2 and order_version<$3 and superseded_at is null
      order by order_version for update`,
    [intent.request_id, intent.target_repo_id, intent.order_version],
  );
  for (const job of rows) {
    const to = haltTarget(job.state, 'order_superseded');
    if (to) {
      await haltLockedJob(client, job, {
        to,
        reason: 'order_superseded',
        detail: { supersededByVersion: intent.order_version },
        now: ctx.now,
        extraSet: { superseded: true },
      });
    } else {
      await client.query('update job set superseded_at=$2, updated_at=$2 where id=$1', [job.id, ctx.now]);
    }
    await insertJobEvent(client, {
      jobId: job.id,
      at: ctx.now,
      kind: 'superseded',
      from: to ? job.state : null,
      to,
      fencingToken: job.fencing_token + (to ? 1 : 0),
      actorType: 'system',
      correlationId: ctx.correlationId,
      detail: { supersededByVersion: intent.order_version },
    });
    await appendAuditTx(client, {
      action: 'job.transition',
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      actorUserId: null,
      actorName: 'system',
      role: 'system',
      correlationId: ctx.correlationId,
      diff: { from: job.state, to: to ?? job.state, reason: 'order_superseded' },
    });
  }
}

async function markUnknown(
  intent: IntentRow,
  ctx: { actor: Actor; correlationId: string; now: Date },
  info: { reason?: string; httpStatus?: number; message?: string },
): Promise<void> {
  await withTransaction(async (client) => {
    const changed = await client.query(
      `update handoff_intent set state='unknown', last_outcome=$2, last_http_status=$3, last_error=$4, updated_at=$5
        where id=$1 and state='sent'`,
      [intent.id, info.reason ?? 'unknown', info.httpStatus ?? null, info.message?.slice(0, 500) ?? null, ctx.now],
    );
    if (!changed.rowCount) return;
    await appendAuditTx(client, {
      action: 'handoff.unknown',
      targetType: 'request',
      targetId: intent.request_id,
      result: 'error',
      ...auditFields(ctx.actor),
      correlationId: ctx.correlationId,
      diff: { orderVersion: intent.order_version, op: intent.op_kind, reason: info.reason ?? 'unknown' },
    });
  });
}

/** 前の版の未確定の作成を片付ける（ADR 4章）。残っているあいだは新しい版を作らない。 */
async function settlePriorCreates(row: RequestRow, version: number, ctx: HandoffContext): Promise<void> {
  const { rows } = await query<IntentRow>(
    `select * from handoff_intent
      where request_id=$1 and target_repo_id=$2 and op_kind='create_issue' and order_version<$3
        and state in ('intent','sent','unknown')
      order by order_version`,
    [row.id, ctx.deps.targetRepo, version],
  );
  for (const prior of rows) {
    if (prior.state === 'intent') {
      // 送っていないと確定できる。claim に負けたら次の再投入で見直す。
      const changed = await query(
        `update handoff_intent set state='failed', last_outcome='superseded_before_send', updated_at=$2 where id=$1 and state='intent'`,
        [prior.id, ctx.now()],
      );
      if (changed.rowCount) continue;
      throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    }
    const action = nextHandoffAction(
      { state: prior.state, sentAt: prior.sent_at, nextAttemptAt: prior.next_attempt_at },
      ctx.now(),
      { sendAllowed: false },
    );
    if (action === 'in_flight') throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    const result = await reconcile(prior, ctx.deps);
    if (result.found) {
      await finalizeIntent(
        prior,
        { number: result.found.number, url: result.found.url },
        { ...ctx.base(), recovered: true, duplicates: result.duplicates },
      );
      continue;
    }
    if (prior.state === 'sent') await markUnknown(prior, ctx.base(), { reason: 'reconcile_not_found' });
    // 走査が完全で、権限者が「作られていない」と明示したときだけ前の版を閉じる。外部へは送らない。
    if (result.scanComplete && ctx.confirmAbsent) {
      await closeAbsentPriorCreate(prior, ctx);
      continue;
    }
    throw unknownError(result.scanComplete, '前の版の投入結果を確認できません（照合してから再試行してください）');
  }
}

/**
 * 前の版の PATCH が sent のまま残ると、handoff_intent_one_inflight_idx で新しい版を送れなくなる。
 * 前の版は ERR-202 で再投入できないので、ここで片付ける。新しい版の PATCH が本文を上書きするので照合は要らない。
 */
async function settleStalePriorUpdates(requestId: string, version: number, ctx: HandoffContext): Promise<void> {
  const { rows } = await query<IntentRow>(
    `select * from handoff_intent
      where request_id=$1 and target_repo_id=$2 and op_kind='update_issue' and order_version<$3 and state='sent'`,
    [requestId, ctx.deps.targetRepo, version],
  );
  for (const prior of rows) {
    const action = nextHandoffAction({ state: 'sent', sentAt: prior.sent_at, nextAttemptAt: null }, ctx.now(), {
      sendAllowed: false,
    });
    if (action === 'in_flight') throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    await markUnknown(prior, ctx.base(), { reason: 'superseded_while_sent' });
  }
}

async function closeAbsentPriorCreate(prior: IntentRow, ctx: HandoffContext): Promise<void> {
  const now = ctx.now();
  await withTransaction(async (client) => {
    // unknown から failed への直接の遷移は無いので、遷移表どおり sent を経由する（外部には送らない）
    const claimed = await client.query(`update handoff_intent set state='sent', updated_at=$2 where id=$1 and state='unknown'`, [
      prior.id,
      now,
    ]);
    if (!claimed.rowCount) throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    await client.query(
      `update handoff_intent set state='failed', last_outcome='confirmed_absent', confirmed_absent_by=$2, confirmed_absent_at=$3,
              confirmed_absent_reason=$4, updated_at=$3
        where id=$1`,
      [prior.id, ctx.actor.userId, now, ctx.confirmAbsent],
    );
    await appendAuditTx(client, {
      action: 'handoff.confirm_absent',
      targetType: 'request',
      targetId: prior.request_id,
      result: 'success',
      ...auditFields(ctx.actor),
      correlationId: ctx.correlationId,
      diff: { orderVersion: prior.order_version, reason: ctx.confirmAbsent, resend: false },
    });
  });
}

interface HandoffContext {
  actor: Actor;
  correlationId: string;
  deps: DevlineDeps;
  now: () => Date;
  confirmAbsent: string | null;
  base(): { actor: Actor; correlationId: string; now: Date; runnerKind?: RunnerKind };
}

/** 新しい版の snapshot と intent を作る（外部呼び出しの前に commit する）。 */
async function createIntent(row: RequestRow, version: number, ctx: HandoffContext): Promise<IntentRow> {
  const check = checkOrderForHandoff({
    requestStatus: row.status,
    requestDeleted: row.deleted,
    requestOrderVersion: row.order_version,
    requestSignalDecided: row.signal_decided,
    latestApproval: await loadLatestApproval(pool, row.id),
    requestedOrderVersion: version,
  });
  if (!check.ok) throw checkFailure(check.code, check.reason);

  await assertNoUnknownInOtherRepo(row.id, ctx.deps.targetRepo);
  await settlePriorCreates(row, version, ctx);
  await assertRepoIdentity(ctx.deps);
  const base = await ctx.deps.issueAdapter.resolveBaseSha(ctx.deps.targetRepo, timeoutSignal(ctx.deps));
  if (!base.ok || !/^[0-9a-f]{40}$/.test(base.value)) throw readFailure();

  const now = ctx.now();
  return withTransaction(async (client) => {
    const frozen = await freezeOrderSnapshot(client, {
      requestId: row.id,
      targetRepoId: ctx.deps.targetRepo,
      baseSha: base.value,
      now,
    });
    if (frozen.orderVersion !== version) throw checkFailure('ERR-202', '指定された版は最新ではありません');
    await assertNoUnknownInOtherRepo(row.id, ctx.deps.targetRepo, client);

    const locked = await client.query<{ issue_no: number | null }>('select issue_no from request where id = $1', [row.id]);
    const succeeded = await client.query<{ issue_no: number; target_repo_id: string }>(
      `select issue_no, target_repo_id from handoff_intent where request_id=$1 and state='succeeded' order by order_version desc`,
      [row.id],
    );
    const inRepo = succeeded.rows.find((r) => r.target_repo_id === ctx.deps.targetRepo);
    if (!inRepo && succeeded.rows.length > 0) {
      // request.issue_no は別のリポジトリの番号。同じ番号の無関係な Issue を上書きしない。
      throw misconfigured('この依頼はすでに別のリポジトリへ投入されています');
    }
    const targetIssue = inRepo?.issue_no ?? locked.rows[0]?.issue_no ?? null;
    const op: HandoffOp = targetIssue !== null ? 'update_issue' : 'create_issue';
    const marker = buildHandoffMarker({
      requestId: row.id,
      orderVersion: version,
      op,
      repo: ctx.deps.targetRepo,
      contentSha256: frozen.contentSha256,
    });
    const inserted = await client.query<IntentRow>(
      `insert into handoff_intent (snapshot_id, request_id, order_version, target_repo_id, op_kind, marker, target_issue_no,
         created_by, correlation_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       on conflict do nothing
       returning *`,
      [
        frozen.snapshotId,
        row.id,
        version,
        ctx.deps.targetRepo,
        op,
        marker,
        targetIssue,
        ctx.actor.userId,
        ctx.correlationId,
        now,
      ],
    );
    const fresh = inserted.rows[0];
    if (!fresh) {
      const again = await client.query<IntentRow>(
        'select * from handoff_intent where request_id=$1 and order_version=$2 and target_repo_id=$3',
        [row.id, version, ctx.deps.targetRepo],
      );
      if (again.rows[0]) return again.rows[0];
      // 前の版の未確定の作成が残っている（handoff_intent_one_create_idx）
      throw Errors.conflict('前の版の投入が確定していません（少し待って再試行してください）');
    }
    if (frozen.created) {
      await appendAuditTx(client, {
        action: 'order.snapshot',
        targetType: 'request',
        targetId: row.id,
        result: 'success',
        ...auditFields(ctx.actor),
        correlationId: ctx.correlationId,
        diff: { orderVersion: version, contentSha256: frozen.contentSha256, baseSha: base.value, repo: ctx.deps.targetRepo },
      });
    }
    await appendAuditTx(client, {
      action: 'handoff.intent',
      targetType: 'request',
      targetId: row.id,
      result: 'success',
      ...auditFields(ctx.actor),
      correlationId: ctx.correlationId,
      diff: { orderVersion: version, op, targetIssue },
    });
    return fresh;
  });
}

function buildResult(
  intent: IntentRow,
  snapshotSha: string,
  job: { jobId: string; jobState: JobState },
  created: boolean,
): HandoffResult {
  return {
    requestId: intent.request_id,
    orderVersion: intent.order_version,
    issueNo: intent.issue_no as number,
    issueUrl: intent.issue_url as string,
    jobId: job.jobId,
    jobState: job.jobState,
    contentSha256: snapshotSha,
    created,
    op: intent.op_kind,
  };
}

async function loadSnapshot(id: string): Promise<SnapshotRow> {
  const { rows } = await query<SnapshotRow>('select * from order_snapshot where id = $1', [id]);
  return rows[0] as SnapshotRow;
}

/** 確定の結果を返す。job が無いのは依頼が無効になったとき（外部の Issue の記録は済んでいる）。 */
async function resultAfterFinalize(
  intentId: string,
  job: { jobId: string | null; jobState: JobState | null },
  created: boolean,
): Promise<HandoffResult> {
  if (!job.jobId || !job.jobState) {
    throw Errors.approvalRequired('投入中に依頼が変更されたため、ジョブを作りませんでした（Issue は記録しました）');
  }
  const intent = await reloadIntent(intentId);
  const snapshot = await loadSnapshot(intent.snapshot_id);
  return buildResult(intent, snapshot.content_sha256, { jobId: job.jobId, jobState: job.jobState }, created);
}

/** 外部へ送る（intent は sent で commit 済み）。外部呼び出しの結果を別トランザクションで記録する。 */
async function sendAndRecord(intent: IntentRow, row: RequestRow, ctx: HandoffContext): Promise<HandoffResult> {
  const snapshot = await loadSnapshot(intent.snapshot_id);
  const title = safeIssueTitle(row.id, row.title);
  // 承認者欄は依頼の指名ではなく、実際に承認した人
  const approval = await query<{ approver_name: string }>('select approver_name from approval where id = $1', [
    snapshot.envelope.approval.id,
  ]);
  const body = buildIssueBody({
    marker: intent.marker,
    requestId: row.id,
    orderYaml: snapshot.canonical_yaml,
    approver: approval.rows[0]?.approver_name ?? '',
    signalLabel: SIGNAL_LABEL[snapshot.envelope.approval.decided_signal],
    deptLabel: row.dept_name ?? row.dept_code,
    tailoring: row.tailoring,
    previewUrl: config.appBaseUrl,
  });
  const signal = timeoutSignal(ctx.deps);
  let outcome: IssueSendOutcome;
  try {
    outcome =
      intent.op_kind === 'create_issue'
        ? await ctx.deps.issueAdapter.createIssue({ repo: intent.target_repo_id, title, body, signal })
        : await ctx.deps.issueAdapter.updateIssue({
            repo: intent.target_repo_id,
            title,
            body,
            signal,
            issueNo: intent.target_issue_no as number,
          });
  } catch {
    // 送った後の例外かもしれないので「失敗」と決めつけない
    outcome = { outcome: 'unknown', reason: 'network' };
  }

  const now = ctx.now();
  if (outcome.outcome === 'succeeded') {
    const job = await finalizeIntent(intent, { number: outcome.number, url: outcome.url }, { ...ctx.base(), recovered: false });
    return resultAfterFinalize(intent.id, job, true);
  }
  if (outcome.outcome === 'unknown') {
    await markUnknown(intent, ctx.base(), outcome);
    if (outcome.reason === 'timeout') {
      throw new ApiError('ERR-303', '時間切れになりました（結果を確認してから再試行してください）', 504, {
        handoffState: 'unknown',
      });
    }
    throw unknownError(undefined);
  }
  const rateLimited = outcome.outcome === 'rate_limited';
  const nextAttemptAt =
    outcome.outcome === 'rate_limited' ? rateLimitedRetryAt(now, intent.attempts, outcome.retryAfterSeconds) : null;
  const message = outcome.outcome === 'failed' ? (outcome.message ?? null) : null;
  await withTransaction(async (client) => {
    await client.query(
      `update handoff_intent set state='failed', last_outcome=$2, last_http_status=$3, last_error=$4, next_attempt_at=$5, updated_at=$6
        where id=$1 and state='sent'`,
      [intent.id, outcome.outcome, outcome.httpStatus, message?.slice(0, 500) ?? null, nextAttemptAt, now],
    );
    await appendAuditTx(client, {
      action: 'handoff.failed',
      targetType: 'request',
      targetId: intent.request_id,
      result: 'error',
      ...auditFields(ctx.actor),
      correlationId: ctx.correlationId,
      diff: { orderVersion: intent.order_version, op: intent.op_kind, outcome: outcome.outcome, httpStatus: outcome.httpStatus },
    });
  });
  if (rateLimited) {
    throw new ApiError('ERR-302', '混み合っています（少し待って再試行）', 429, {
      handoffState: 'failed',
      nextAttemptAt: (nextAttemptAt as Date).toISOString(),
    });
  }
  throw new ApiError('ERR-304', '連携先に接続できませんでした', 502, { handoffState: 'failed', httpStatus: outcome.httpStatus });
}

/** sent へ進める。外部へ送る権利はここで1人だけが得る。依頼が無効になっていれば進めない。 */
async function claimForSend(
  intent: IntentRow,
  from: HandoffState,
  ctx: HandoffContext,
  confirm: { reason: string } | null,
): Promise<IntentRow> {
  const now = ctx.now();
  return withTransaction(async (client) => {
    const row = await getRequestRowForUpdate(client, intent.request_id);
    if (!row) throw Errors.notFound('依頼');
    if (!orderCurrent(row, intent.order_version)) throw Errors.orderNotApproved();
    let claimed;
    try {
      claimed = await client.query<IntentRow>(
        `update handoff_intent set state='sent', attempts=attempts+1, sent_at=$3, next_attempt_at=null, last_error=null, updated_at=$3,
                confirmed_absent_by=coalesce($4, confirmed_absent_by),
                confirmed_absent_at=case when $4::uuid is null then confirmed_absent_at else $3::timestamptz end,
                confirmed_absent_reason=coalesce($5, confirmed_absent_reason)
          where id=$1 and state=$2
          returning *`,
        [intent.id, from, now, confirm ? ctx.actor.userId : null, confirm?.reason ?? null],
      );
    } catch (err) {
      // handoff_intent_one_inflight_idx: 同じ依頼の別の版を送信中
      if ((err as { code?: string }).code === '23505') {
        throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
      }
      throw err;
    }
    const sent = claimed.rows[0];
    if (!sent) throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    if (confirm) {
      await appendAuditTx(client, {
        action: 'handoff.confirm_absent',
        targetType: 'request',
        targetId: intent.request_id,
        result: 'success',
        ...auditFields(ctx.actor),
        correlationId: ctx.correlationId,
        diff: { orderVersion: intent.order_version, reason: confirm.reason, resend: true },
      });
    }
    await appendAuditTx(client, {
      action: 'handoff.sent',
      targetType: 'request',
      targetId: intent.request_id,
      result: 'success',
      ...auditFields(ctx.actor),
      correlationId: ctx.correlationId,
      diff: { orderVersion: intent.order_version, op: intent.op_kind, attempts: sent.attempts },
    });
    return sent;
  });
}

async function reconcileAndContinue(
  intent: IntentRow,
  row: RequestRow,
  sendAllowed: boolean,
  ctx: HandoffContext,
): Promise<HandoffResult> {
  const result = await reconcile(intent, ctx.deps);
  if (result.found) {
    const job = await finalizeIntent(
      intent,
      { number: result.found.number, url: result.found.url },
      { ...ctx.base(), recovered: true, duplicates: result.duplicates },
    );
    return resultAfterFinalize(intent.id, job, false);
  }
  if (intent.state === 'sent') await markUnknown(intent, ctx.base(), { reason: 'reconcile_not_found' });
  const next = afterReconcileNotFound({
    op: intent.op_kind,
    scanComplete: result.scanComplete,
    confirmAbsent: ctx.confirmAbsent !== null,
    sendAllowed,
  });
  if (next === 'stay_unknown') throw unknownError(result.scanComplete);
  await settleStalePriorUpdates(row.id, intent.order_version, ctx);
  await assertRepoIdentity(ctx.deps);
  await assertUpdateTarget(intent, ctx.deps);
  const sent = await claimForSend(
    intent,
    'unknown',
    ctx,
    next === 'resend_create' ? { reason: ctx.confirmAbsent as string } : null,
  );
  return sendAndRecord(sent, row, ctx);
}

/**
 * 版固定と投入（API-06）。手順は docs/devline/api-contract.md 1章。
 * deps を省くと既定（GitHub と DEVLINE_TARGET_REPOS）を使う。
 */
export async function handoffOrder(
  input: { requestId: string; orderVersion: number | null; confirmAbsent?: { reason: string } },
  actor: Actor,
  correlationId: string,
  depsIn?: DevlineDeps,
): Promise<HandoffResult> {
  const facts = { role: actor.role, isAdmin: actor.user.isAdmin };
  // 投入は desk / approver。confirm_absent はそのうえで approver / admin（フラグで投入の権限を広げない）
  if (!canHandoff(facts)) return denyHandoff(input.requestId, actor, correlationId, 'role');
  let confirmAbsent: string | null = null;
  if (input.confirmAbsent) {
    if (!canConfirmAbsent(facts)) return denyHandoff(input.requestId, actor, correlationId, 'confirm_absent');
    confirmAbsent = input.confirmAbsent.reason.trim();
    if (confirmAbsent === '') throw Errors.reasonRequired();
  }
  const deps = depsIn ?? defaultDevlineDeps();
  if (
    !isRepoAllowed(
      deps.targetRepo,
      deps.allowedRepos.map((r) => r.name),
    )
  ) {
    throw misconfigured('対象リポジトリが許可されていません（DEVLINE_TARGET_REPOS）');
  }

  const row = await getRequestRow(input.requestId, true);
  if (!row) throw Errors.notFound('依頼');
  if (input.orderVersion !== null && input.orderVersion !== row.order_version) {
    throw checkFailure('ERR-202', '指定された版は最新ではありません');
  }
  const version = row.order_version;
  const ctx: HandoffContext = {
    actor,
    correlationId,
    deps,
    now: deps.now,
    confirmAbsent,
    base: () => ({ actor, correlationId, now: deps.now(), ...(deps.runnerKind ? { runnerKind: deps.runnerKind } : {}) }),
  };

  const intent = (await findIntent(row.id, version, deps.targetRepo)) ?? (await createIntent(row, version, ctx));
  const sendAllowed = orderCurrent(row, intent.order_version);
  const action = nextHandoffAction(
    { state: intent.state, sentAt: intent.sent_at, nextAttemptAt: intent.next_attempt_at },
    deps.now(),
    { sendAllowed },
  );

  switch (action) {
    case 'return_existing': {
      const job = await withTransaction(async (client) => {
        const locked = await getRequestRowForUpdate(client, intent.request_id);
        if (!locked) throw Errors.notFound('依頼');
        await lockOlderJobs(client, intent);
        return ensureJobInTx(client, intent, locked, ctx.base());
      });
      return resultAfterFinalize(intent.id, job, false);
    }
    case 'send_not_allowed':
      throw Errors.orderNotApproved();
    case 'in_flight':
      throw Errors.conflict('別の処理が進行中です（少し待って再試行してください）');
    case 'retry_later':
      throw new ApiError('ERR-302', '混み合っています（少し待って再試行）', 429, {
        handoffState: intent.state,
        nextAttemptAt: (intent.next_attempt_at as Date).toISOString(),
      });
    case 'claim_and_send': {
      await settleStalePriorUpdates(row.id, intent.order_version, ctx);
      await assertRepoIdentity(deps);
      await assertUpdateTarget(intent, deps);
      const sent = await claimForSend(intent, intent.state, ctx, null);
      return sendAndRecord(sent, row, ctx);
    }
    case 'reconcile':
      return reconcileAndContinue(intent, row, sendAllowed, ctx);
  }
}
