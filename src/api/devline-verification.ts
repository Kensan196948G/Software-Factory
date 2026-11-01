/**
 * 検証証跡（ENT-09・仕様 4-5）と PR 候補（仕様 4-8・6-4）。
 *
 * HTTP にしない（API-07 とサービス間トークンは別の Approval PR）。Agent の自己申告を合格の正本にしない:
 * 合否は CI の結果（evaluateVerification）だけで決め、記録と状態の変更を同じトランザクションで行う。
 */
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { appendAuditTx } from './audit.js';
import { ApiError, Errors } from './http.js';
import { haltLockedJob, insertJobEvent, isRedOrder, rollSessionSql, sha256Hex, type JobRow } from './devline-jobs.js';
import {
  PR_AGENTS_HEADINGS,
  PR_DECISION_ITEMS,
  REQUIRED_STAGES,
  acIdsOf,
  decideRepair,
  evaluateVerification,
  isCiRerunAllowed,
  isOrderCurrent,
  summarizeAc,
} from '../shared/devline.js';
import type {
  JobState,
  RecordVerificationInput,
  RecordVerificationResult,
  StopReason,
  VerificationRecord,
  VerificationVerdict,
} from '../shared/devline.js';
import { SIGNAL_LABEL, STATUS_LABEL } from '../shared/domain.js';
import type { Signal, Status } from '../shared/domain.js';

export { acIdsOf };

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

const CI_ACTOR = (source: string): { actorUserId: null; actorName: string; role: string } => ({
  actorUserId: null,
  actorName: `ci:${source}`,
  role: 'system',
});

export async function recordVerification(input: RecordVerificationInput): Promise<RecordVerificationResult> {
  if (config.isProduction && input.source === 'fake_ci') {
    throw new ApiError('ERR-405', 'production では fake の検証結果を受け付けません', 409);
  }
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw Errors.shape('headSha');

  return withTransaction(async (client) => {
    // 先に job を握る。挿入の外部キーのロックから昇格するとデッドロックしうる
    const locked = await client.query<JobRow>('select * from job where id = $1 for update', [input.jobId]);
    const job = locked.rows[0];
    if (!job) throw Errors.notFound('ジョブ');

    const inserted = await client.query(
      `insert into verification (job_id, delivery_id, source, ci_run_id, run_sequence, run_attempt, head_sha, stages, ac_results,
         log_ref, report_digest, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       on conflict do nothing`,
      [
        input.jobId,
        input.deliveryId,
        input.source,
        input.ciRunId,
        input.runSequence,
        input.runAttempt,
        input.headSha,
        JSON.stringify(input.stages),
        JSON.stringify(input.acResults),
        input.logRef ?? null,
        input.reportDigest ?? null,
        input.now,
      ],
    );
    const recorded = (inserted.rowCount ?? 0) > 0;

    const req = await client.query<{ status: Status; deleted: boolean; order_version: number; criteria: string[] }>(
      'select status, deleted, order_version, criteria from request where id = $1',
      [job.request_id],
    );
    const request = req.rows[0];
    const rows = await client.query<VerificationRow>('select * from verification where job_id = $1', [input.jobId]);
    const verdict = evaluateVerification(rows.rows.map(toRecord), job.head_sha ?? '', acIdsOf(request?.criteria ?? []));

    const current =
      request !== undefined &&
      isOrderCurrent({
        requestStatus: request.status,
        requestDeleted: request.deleted,
        requestOrderVersion: request.order_version,
        jobOrderVersion: job.order_version,
      });
    // 順不同で届いた古い配信では動かさない。合否も再実行の回数も、その SHA の最新の記録だけが決める
    const newest = rows.rows
      .filter((r) => r.head_sha === input.headSha)
      .some(
        (r) => r.run_sequence > input.runSequence || (r.run_sequence === input.runSequence && r.run_attempt > input.runAttempt),
      );
    const applicable = job.state === 'verifying' && input.headSha === job.head_sha && current && !newest;

    if (!recorded) {
      // 実 CI は再実行を要求できない。再開の後に同じ run しか無ければ、待たずにもう一度止める
      if (applicable && input.source === 'github' && verdict.verdict === 'incomplete') {
        // 記録済みの結果と今回の読み取りは別物なので、この読み取りでは AI の修正（費用がかかる）へ進めない
        const moved = await applyVerdict(client, job, verdict, {
          ...input,
          diagnostics: { ...input.diagnostics, acArtifact: 'already_recorded' },
        });
        return { status: 'duplicate', verdict, jobState: moved.state, advanced: moved.advanced };
      }
      return { status: 'duplicate', verdict, jobState: job.state, advanced: false };
    }

    await appendAuditTx(client, {
      action: 'verification.record',
      targetType: 'job',
      targetId: job.id,
      result: 'success',
      ...CI_ACTOR(input.source),
      correlationId: input.correlationId,
      // 届いた配信の SHA での判定と、job の今の head での判定（次の遷移を決める方）を分けて残す
      diff: {
        deliveryId: input.deliveryId,
        ciRunId: input.ciRunId,
        headSha: input.headSha,
        verdict: evaluateVerification(rows.rows.map(toRecord), input.headSha, acIdsOf(request?.criteria ?? [])).verdict,
        jobHeadSha: job.head_sha,
        jobHeadVerdict: verdict.verdict,
      },
    });

    if (!applicable) return { status: 'recorded', verdict, jobState: job.state, advanced: false };
    // 赤信号は worker の前でも合格へ進めない
    if (await isRedOrder(client, job.snapshot_id)) {
      await haltLockedJob(client, job, {
        to: 'stopped',
        reason: 'red_signal_human_required',
        detail: { signal: 'r' },
        now: input.now,
      });
      await logTransition(client, job, 'stopped', { reason: 'red_signal_human_required' }, input);
      return { status: 'recorded', verdict, jobState: 'stopped', advanced: true };
    }
    const moved = await applyVerdict(client, job, verdict, input);
    return { status: 'recorded', verdict, jobState: moved.state, advanced: moved.advanced };
  });
}

/** artifact 自体は読めて、AC の試験の不足や書き方が原因のもの（AI の修正で直る）。 */
const AI_FIXABLE_AC_PROBLEMS: readonly string[] = ['ok', 'missing_ac_id', 'unknown_ac_id', 'duplicate_ac_id'];

/** CI は lease の持ち主ではないので fencing を +1 して lease を外す。動いている worker の書き込みは捨てられる。 */
async function applyVerdict(
  client: PoolClient,
  job: JobRow,
  verdict: VerificationVerdict,
  input: RecordVerificationInput,
): Promise<{ state: JobState; advanced: boolean }> {
  const { now, correlationId } = input;
  const stop = async (reason: StopReason, detail: Record<string, unknown>): Promise<{ state: JobState; advanced: boolean }> => {
    await haltLockedJob(client, job, { to: 'stopped', reason, detail, now });
    await logTransition(client, job, 'stopped', { reason, ...detail }, input);
    return { state: 'stopped', advanced: true };
  };

  /** AI の修正へ戻す（同因と合計の上限の中で）。CI 自体は読めていて、直せるのは AI のとき。 */
  const repair = async (
    causeKey: string,
    ciRunId: string,
    failure: { failedStages: string[]; failedAcs: string[]; failedTestIds: string[]; note?: string },
  ): Promise<{ state: JobState; advanced: boolean }> => {
    const decision = decideRepair({ total: job.repair_count_total, byCause: job.repair_count_by_cause }, causeKey);
    if (!decision.allow) return stop(decision.stopReason, { causeKey, ciRunId });
    const byCause = {
      ...job.repair_count_by_cause,
      [causeKey]: (job.repair_count_by_cause[causeKey] ?? 0) + 1,
    };
    const workState = { ...job.work_state, previousFailure: { causeKey, ...failure, ciRunId } };
    await client.query(
      `update job set state='revising', repair_count_total=repair_count_total+1, repair_count_by_cause=$2::jsonb,
              work_state=$3::jsonb, fencing_token=fencing_token+1, lease_owner=null, lease_expires_at=null, updated_at=$4::timestamptz,
              ${rollSessionSql('$4')}
        where id=$1`,
      [job.id, JSON.stringify(byCause), JSON.stringify(workState), now],
    );
    await logTransition(client, job, 'revising', { causeKey, ciRunId }, input);
    return { state: 'revising', advanced: true };
  };

  switch (verdict.verdict) {
    case 'passed': {
      // DB のトリガは合格の記録と PR 候補の両方を要求するので、先に PR 候補を作る（0009）
      await buildPrCandidate(client, job.id, verdict, now);
      await client.query(
        `update job set state='pr_ready', fencing_token=fencing_token+1, lease_owner=null, lease_expires_at=null, updated_at=$2::timestamptz,
                ${rollSessionSql('$2')}
          where id=$1`,
        [job.id, now],
      );
      await logTransition(client, job, 'pr_ready', { ciRunId: verdict.ciRunId }, input);
      return { state: 'pr_ready', advanced: true };
    }
    case 'failed':
      return repair(verdict.causeKey, verdict.ciRunId, {
        failedStages: verdict.failedStages,
        failedAcs: verdict.failedAcs,
        failedTestIds: verdict.failedTestIds,
      });
    case 'incomplete': {
      // 実 CI の再実行は人が行う（worker は要求しない）。待っても結果は変わらないので、理由を付けてすぐ止める
      // 段階は揃い artifact も読めたのに AC の試験が足りない。CI の再実行では直らない（AI が試験を足す）
      if (
        input.source === 'github' &&
        verdict.incompleteStages.length === 0 &&
        !verdict.acMissing &&
        verdict.unconfirmedAcs.length > 0 &&
        AI_FIXABLE_AC_PROBLEMS.includes(input.diagnostics?.acArtifact ?? '')
      ) {
        const acs = [...verdict.unconfirmedAcs].sort();
        return repair(`ac-unconfirmed|${acs.join(',')}`, verdict.ciRunId, {
          failedStages: [],
          failedAcs: acs,
          failedTestIds: [],
          note: '試験名の先頭を AC 番号にした試験が無いか、結果を確認できません。`test/unit/` の試験名を `AC-n:` で始めてください',
        });
      }
      if (input.source === 'github') {
        const statusOf = (stage: string): string =>
          input.stages.filter((s) => s.stage === stage).find((s) => s.status !== 'passed')?.status ?? 'missing';
        const acOpen = verdict.unconfirmedAcs.length > 0 || verdict.acMissing;
        return stop('ci_incomplete', {
          ...(acOpen
            ? {
                cause: 'AC 未確認',
                unconfirmedAcs: verdict.unconfirmedAcs,
                acMissing: verdict.acMissing,
                ...(verdict.unknownAcs.length > 0 ? { unknownAcs: verdict.unknownAcs } : {}),
                ...(verdict.duplicateAcs.length > 0 ? { duplicateAcs: verdict.duplicateAcs } : {}),
                acArtifact: input.diagnostics?.acArtifact ?? null,
              }
            : {}),
          ciRunId: verdict.ciRunId,
          logRef: input.logRef ?? null,
          runConclusion: input.diagnostics?.runConclusion ?? null,
          stages: verdict.incompleteStages.map((stage) => ({ stage, status: statusOf(stage) })),
          unmatchedJobs: input.diagnostics?.unmatchedJobs ?? [],
          nextStep: acOpen
            ? 'CI の ac-results を確かめ、GitHub Actions で CI を再実行してから再開する'
            : 'GitHub Actions で CI を再実行してから再開する',
        });
      }
      if (!isCiRerunAllowed(job.ci_rerun_count)) {
        return stop('ci_rerun_limit', {
          incompleteStages: verdict.incompleteStages,
          unconfirmedAcs: verdict.unconfirmedAcs,
          ciRunId: verdict.ciRunId,
        });
      }
      await client.query(
        `update job set ci_rerun_count=ci_rerun_count+1, fencing_token=fencing_token+1, lease_owner=null, lease_expires_at=null,
                updated_at=$2::timestamptz,
                ${rollSessionSql('$2')}
          where id=$1`,
        [job.id, now],
      );
      await insertJobEvent(client, {
        jobId: job.id,
        at: now,
        kind: 'ci_rerun',
        fencingToken: job.fencing_token + 1,
        actorType: 'system',
        correlationId,
        detail: {
          incompleteStages: verdict.incompleteStages,
          unconfirmedAcs: verdict.unconfirmedAcs,
          ciRunId: verdict.ciRunId,
          rerun: job.ci_rerun_count + 1,
        },
      });
      return { state: 'verifying', advanced: true };
    }
    case 'stale':
    case 'no_result':
      return { state: job.state, advanced: false };
  }
}

async function logTransition(
  client: PoolClient,
  job: JobRow,
  to: JobState,
  detail: Record<string, unknown>,
  input: RecordVerificationInput,
): Promise<void> {
  await insertJobEvent(client, {
    jobId: job.id,
    at: input.now,
    kind: 'transition',
    from: job.state,
    to,
    fencingToken: job.fencing_token + 1,
    actorType: 'system',
    correlationId: input.correlationId,
    detail,
  });
  await appendAuditTx(client, {
    action: 'job.transition',
    targetType: 'job',
    targetId: job.id,
    result: 'success',
    ...CI_ACTOR(input.source),
    correlationId: input.correlationId,
    diff: { from: job.state, to, ...detail },
  });
}

/* ───────────────────────────── PR 候補 ───────────────────────────── */

const FIELD_USERS = ['現場の担当者', '現場所長', '現場事務', '作業船の船長・船員', '潜水士'];
const NOT_RUN_FAKE = '未実施（fake PoC）';
const NOT_RUN_REAL = '未確認（人が確認する）';
/** job_artifact の CHECK。超えると pr_ready の記録全体が rollback されるので、ここで必ず収める。 */
const MAX_PR_BODY_BYTES = 262_144;
const MAX_LISTED_PATHS = 100;
const MAX_PATH_CHARS = 300;

/** 依頼の文章は Markdown の命令にも HTML にもさせない。1行にして表示用にエスケープする。 */
function inline(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|#@])/g, '\\$1');
}

interface PrFacts {
  job: JobRow;
  request: {
    id: string;
    title: string;
    kind: string;
    status: Status;
    scope: string[];
    out_of_scope: string[];
    criteria: string[];
    users: string[];
    data_handling: string[];
    signal_decided: Signal | null;
    issue_no: number | null;
  };
  snapshotSha: string;
  verdict: VerificationVerdict;
  stages: VerificationRecord['stages'];
  /** 検査の出どころ。無いときはまだ記録が無い。実行者が実 runner かは job.runner_kind で決める。 */
  ci?: { source: VerificationRecord['source']; runUrl: string | null } | null;
}

/** 大きすぎる本文を UTF-8 の境界で切る。末尾の見出しは残らないが、記録を失うよりよい。 */
function capBody(body: string): string {
  if (Buffer.byteLength(body, 'utf8') <= MAX_PR_BODY_BYTES) return body;
  const note = '\n\n（長すぎるので以降を省略しました）\n';
  const room = MAX_PR_BODY_BYTES - Buffer.byteLength(note, 'utf8');
  const head = new TextDecoder().decode(Buffer.from(body, 'utf8').subarray(0, room)).replace(/\uFFFD$/, '');
  return `${head}${note}`;
}

/** 純関数。10項目と12見出しを必ず含む。無いものは未実施と書き、成功のように書かない。 */
export function renderPrBody(facts: PrFacts): string {
  const { job, request, snapshotSha, verdict, stages } = facts;
  const real = job.runner_kind === 'docker-claude';
  const NOT_RUN = real ? NOT_RUN_REAL : NOT_RUN_FAKE;
  const ciLabel =
    facts.ci?.source === 'github' ? 'GitHub Actions' : facts.ci?.source === 'ci' ? '実 CI' : real ? '検査の記録なし' : 'fake CI';
  const texts = request.criteria.filter((c) => c.trim() !== '');
  const list = (items: readonly string[]): string => (items.length ? items.map((s) => `- ${inline(s)}`).join('\n') : '- なし');
  const isField = request.users.some((u) => FIELD_USERS.includes(u));
  const handlesOriginals = request.data_handling.includes('photo');
  const allPaths = Array.isArray(job.work_state.changedPaths) ? (job.work_state.changedPaths as string[]) : [];
  // 一覧は切り詰める（全件は git の差分にある）
  const changedPaths = [
    ...allPaths.slice(0, MAX_LISTED_PATHS).map((p) => String(p).slice(0, MAX_PATH_CHARS)),
    ...(allPaths.length > MAX_LISTED_PATHS ? [`ほか ${allPaths.length - MAX_LISTED_PATHS} 件（一覧を省略）`] : []),
  ];
  const acRows = verdict.acEvidence.map((ac) => {
    const index = Number(ac.acId.replace('AC-', '')) - 1;
    const tests = ac.testIds.length ? ac.testIds.map(inline).join(', ') : '－';
    return `| ${ac.acId} | ${inline(texts[index] ?? '')} | ${ac.mark} | ${tests} | ${inline(ac.ciRunId ?? '－')} | ${ac.headSha ?? '－'} | ${ac.reportDigest ?? '－'} |`;
  });
  const stageRows = REQUIRED_STAGES.map((stage) => {
    const row = stages.find((s) => s.stage === stage);
    return `| ${stage} | ${row?.status ?? '未実行'} |`;
  });
  const ciRun = 'ciRunId' in verdict ? verdict.ciRunId : '－';
  const acSummary = summarizeAc(verdict.acEvidence);
  const acLine = `${acSummary.label}（確認 ${acSummary.confirmed} / ${acSummary.total}）`;

  const decision: Record<(typeof PR_DECISION_ITEMS)[number], string> = {
    要望との対応: [
      `- Issue: ${request.issue_no ? `#${request.issue_no}` : '未確定'}`,
      `- 受付番号: ${inline(request.id)}（${inline(request.title)}）`,
      `- 注文書の版: ${job.order_version}（sha256: ${snapshotSha}）`,
      `- 信号の色: ${request.signal_decided ? SIGNAL_LABEL[request.signal_decided] : '未決定'}`,
    ].join('\n'),
    変更範囲: [
      '作るもの:',
      list(request.scope),
      '',
      real ? '変更された path（ホストの差分検査で算出）:' : '変更された path（CI ではなく runner の結果）:',
      list(changedPaths),
    ].join('\n'),
    受入条件の検証: [
      `判定: ${acLine}（CI の ac-results だけを根拠にする。AI の申告は使わない）`,
      '',
      '| AC | 内容 | 結果 | test ID | CI 実行ID | SHA | digest |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...acRows,
    ].join('\n'),
    自動検査: [
      `CI 実行ID: ${inline(ciRun)}（${ciLabel}）`,
      ...(facts.ci?.runUrl ? [`実行の記録: ${inline(facts.ci.runUrl)}`] : []),
      '',
      '| 段階 | 結果 |',
      '| --- | --- |',
      ...stageRows,
    ].join('\n'),
    業務確認: `- プレビューURL: ${NOT_RUN}\n- 操作手順: ${NOT_RUN}`,
    モデル現場の結果: isField ? NOT_RUN : '対象外',
    原本の保護: handlesOriginals ? NOT_RUN : '対象外',
    運用への影響: `- 設定: ${NOT_RUN}\n- 移行: ${NOT_RUN}\n- 監視: ${NOT_RUN}\n- 手順書: ${NOT_RUN}`,
    復旧方法: `- 戻し方: ${NOT_RUN}\n- DB 変更時の制約: ${NOT_RUN}`,
    残存リスク: real
      ? [
          '- AI が作成した変更。PR 候補の準備完了は受入の合格ではない。試験の中身（AC を本当に確かめているか）は人が確かめる',
          `- 対象外:\n${list(request.out_of_scope)}`,
          '- 追加判断: 人の承認が必要（AI は merge も Approve もしない）',
        ].join('\n')
      : [
          '- fake runner と fake CI の結果であり、実際の実装・検査ではない',
          `- 対象外:\n${list(request.out_of_scope)}`,
          '- 追加判断: 人の承認が必要（この PR は作成していない）',
        ].join('\n'),
  };
  const agents: Record<(typeof PR_AGENTS_HEADINGS)[number], string> = {
    目的: inline(request.title),
    MVP範囲: real ? '開発ライン 実 runner の1件実走（pr_ready まで）' : '開発ライン Phase 1 の fake PoC（pr_ready まで）',
    変更: changedPaths.length ? list(changedPaths) : NOT_RUN,
    UI影響: NOT_RUN,
    API影響: NOT_RUN,
    DB影響: NOT_RUN,
    Security影響: NOT_RUN,
    テスト結果:
      verdict.verdict === 'passed'
        ? `${ciLabel} の全段階 passed（実行ID ${inline(ciRun)}）。${acLine}`
        : `未合格（${verdict.verdict}）。${acLine}`,
    CI結果: real ? ciLabel : `fake CI（実 CI は${NOT_RUN}）`,
    Deployment結果: NOT_RUN,
    既知の制限: real
      ? 'AI の変更は人の承認待ち。配備は行っていない。AC の結果は CI の ac-results が無ければ未確認で、PR 候補にならない'
      : 'fake PoC。実 PR・実 AI・実 GitHub・配備は行っていない',
    Rollback: NOT_RUN,
  };

  const lines = [
    `# [${real ? 'AI候補' : '下書き'}] ${inline(request.id)} ${inline(request.title)}`,
    '',
    real
      ? '> 開発ラインの AI が作成した PR 候補です。AI は merge も Approve もしません。人の承認待ちです。'
      : '> 開発ライン fake PoC の PR 候補です。実 PR は作成していません。人の承認待ちです。',
    '',
    `受付の状態: ${STATUS_LABEL[request.status] ?? request.status} / job: ${job.id}`,
    '',
    '## 判断材料（仕様 4-8）',
    '',
  ];
  PR_DECISION_ITEMS.forEach((item, i) => lines.push(`### ${i + 1}. ${item}`, '', decision[item], ''));
  lines.push('## PR 本文（AGENTS.md）', '');
  for (const heading of PR_AGENTS_HEADINGS) lines.push(`### ${heading}`, '', agents[heading], '');
  return capBody(`${lines.join('\n').trimEnd()}\n`);
}

/** CI の前に PR を作るときの本文。検査の結果はまだ無いので未確認として書く（pr_ready で更新する）。 */
export async function renderDraftPrBody(job: JobRow): Promise<string> {
  const requests = await query<PrFacts['request']>(
    `select id, title, kind, status, scope, out_of_scope, criteria, users, data_handling, signal_decided, issue_no
       from request where id = $1`,
    [job.request_id],
  );
  const request = requests.rows[0];
  if (!request) throw Errors.notFound('依頼');
  const snapshots = await query<{ content_sha256: string }>('select content_sha256 from order_snapshot where id = $1', [
    job.snapshot_id,
  ]);
  const verdict = evaluateVerification([], job.head_sha ?? '', acIdsOf(request.criteria));
  return renderPrBody({
    job,
    request,
    snapshotSha: (snapshots.rows[0] as { content_sha256: string }).content_sha256,
    verdict,
    stages: [],
    ci: null,
  });
}

/** pr_ready に入るトランザクションの中で呼ぶ。 */
export async function buildPrCandidate(
  client: PoolClient,
  jobId: string,
  verdict: VerificationVerdict,
  now: Date,
): Promise<{ artifactId: string; sha256: string }> {
  const jobs = await client.query<JobRow>('select * from job where id = $1', [jobId]);
  const job = jobs.rows[0];
  if (!job) throw Errors.notFound('ジョブ');
  const requests = await client.query<PrFacts['request']>(
    `select id, title, kind, status, scope, out_of_scope, criteria, users, data_handling, signal_decided, issue_no
       from request where id = $1`,
    [job.request_id],
  );
  const snapshots = await client.query<{ content_sha256: string }>('select content_sha256 from order_snapshot where id = $1', [
    job.snapshot_id,
  ]);
  const latest = await client.query<{
    stages: VerificationRecord['stages'];
    source: VerificationRecord['source'];
    log_ref: string | null;
  }>('select stages, source, log_ref from verification where job_id=$1 and ci_run_id=$2 order by run_attempt desc limit 1', [
    jobId,
    'ciRunId' in verdict ? verdict.ciRunId : '',
  ]);
  const body = renderPrBody({
    job,
    request: requests.rows[0] as PrFacts['request'],
    snapshotSha: (snapshots.rows[0] as { content_sha256: string }).content_sha256,
    verdict,
    stages: latest.rows[0]?.stages ?? [],
    ci: latest.rows[0] ? { source: latest.rows[0].source, runUrl: latest.rows[0].log_ref } : null,
  });
  const sha256 = sha256Hex(body);
  const inserted = await client.query<{ id: string }>(
    `insert into job_artifact (job_id, kind, name, sha256, byte_size, content, created_at)
     values ($1,'pr_body_draft','pr-body-draft.md',$2,$3,$4,$5)
     returning id`,
    [jobId, sha256, Buffer.byteLength(body, 'utf8'), body, now],
  );
  return { artifactId: (inserted.rows[0] as { id: string }).id, sha256 };
}
