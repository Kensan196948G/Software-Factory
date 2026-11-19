import { expect } from './roles';
import type { Api } from './roles';
import { createRequestViaApi, serverRequest, transitionViaApi, type ServerRequest, type Signal } from './station';
import { acIdsOf, buildPrMarker, REQUIRED_STAGES } from '../../../../src/shared/devline';

/**
 * 開発ライン（ステップ4・7・8・9）E2E の準備ヘルパー。層①（使い捨て DB）だけが使う。
 *
 * - 依頼の作成・承認・投入（handoff）は API（人の画面と同じ正規経路）で行う。
 * - worker を起動しないので、job を pr_ready / merged / staged に整える行だけを SQL で作る。
 *   0009 の job_guard（verifying → pr_ready には合格の verification と pr_body_draft が要る）と
 *   0008 の遷移表を、DB が受け付ける順に進める。
 * - 実 GitHub へは送らない。PR は偽 GitHub の制御 API（fixtures/roles.ts の fake）へ差し込む。
 * - 実データ・個人情報・実メール・秘密は使わない。値はすべて作り物。
 */

/** 層①の DB（fixtures/roles.ts の db フィクスチャと同じ口）。 */
export interface Db {
  query: (sql: string, params?: unknown[]) => Promise<any>;
}

/** 40 桁の 16 進（commit SHA の形）。実在の commit ではない決め打ちの作り物。 */
export function sha40(seed: string): string {
  const hex = seed.replace(/[^0-9a-f]/g, '');
  if (hex === '') throw new Error(`sha40: 16 進の種ではありません: ${seed}`);
  return hex.repeat(40).slice(0, 40);
}

/**
 * `sha256:` + 64 桁の 16 進。release.image_digest の CHECK と approve-deploy の入力の形。
 * （作業指示の 'sha256:d1' は DB の CHECK に合わないため、同じ意図のまま 64 桁へ展開している）
 */
export function sha256Of(seed: string): string {
  const hex = seed.replace(/[^0-9a-f]/g, '');
  if (hex === '') throw new Error(`sha256Of: 16 進の種ではありません: ${seed}`);
  return `sha256:${hex.repeat(64).slice(0, 64)}`;
}

/** 配備の比較に使う作り物の digest（sha256:d0 / d1 / d2 相当）。 */
export const DIGEST_D0 = sha256Of('d0');
export const DIGEST_D1 = sha256Of('d1');
export const DIGEST_D2 = sha256Of('d2');

/** 必須 6 段階がすべて passed の verification.stages。 */
export function passedStages(): { stage: string; status: 'passed' }[] {
  return REQUIRED_STAGES.map((stage) => ({ stage, status: 'passed' as const }));
}

/** 依頼の合格条件の数だけ AC-1.. を作り、すべて passed + testIds 付きにする（source='fake_ci' は範囲情報を要求しない）。 */
export function acResults(criteria: readonly string[]): { acId: string; testIds: string[]; status: 'passed' }[] {
  const ids = acIdsOf(criteria);
  return ids.map((acId) => ({ acId, testIds: [`tests/ac/${acId.toLowerCase()}.spec.ts`], status: 'passed' as const }));
}

/** API の本文から `error.code` を取る（本文が JSON でないときは空）。 */
export function errorCode(body: unknown): string {
  return String((body as { error?: { code?: unknown } } | null)?.error?.code ?? '');
}

/** API の本文から `error.details` を取る（refusal の実測用）。 */
export function errorDetails(body: unknown): Record<string, unknown> {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
}

/** 偽 GitHub へ差し込む PR 本文。1 行目が buildPrMarker（実装と同じ関数で作る）。 */
export function pullBody(jobId: string, headSha: string): string {
  return `${buildPrMarker({ jobId, attemptNo: 1, headSha })}\n\nE2E の作り物の PR 本文（実データは使わない）`;
}

/** 依頼を作り、承認待ち・承認済みを経て投入する。投入は承認者（desk/approver だけが投入できる）。 */
export interface ApprovedJob {
  request: ServerRequest;
  jobId: string;
  handoff: { status: number; body: any; text: string };
}

export async function approvedRequestWithJob(opts: {
  user: Api;
  admin: Api;
  approver: { id: string; displayName: string };
  applicant: string;
  title: string;
  signal?: Signal;
  criteria?: string[];
}): Promise<ApprovedJob> {
  const signal: Signal = opts.signal ?? 'g';
  const request = await createRequestViaApi(opts.user, {
    title: opts.title,
    decides: signal,
    approverUserId: opts.approver.id,
    approverName: opts.approver.displayName,
    applicant: opts.applicant,
    criteria: opts.criteria ?? ['E2E の合格条件が満たされること'],
  });
  await transitionViaApi(opts.admin, request.id, 'review');
  await transitionViaApi(opts.admin, request.id, 'wait');
  await transitionViaApi(opts.admin, request.id, 'approved', { signal, redAck: signal === 'r' });

  const handoff = await opts.admin.post(`/api/requests/${encodeURIComponent(request.id)}/handoff`);
  expect(handoff.status, `投入できませんでした: ${handoff.text.slice(0, 400)}`).toBe(200);
  const detail = await serverRequest(opts.admin, request.id);
  return { request: detail, jobId: await firstJobId(opts.admin, request.id), handoff };
}

/** 依頼に紐づく job の先頭（投入で作られた 1 件）。 */
export async function firstJobId(api: Api, requestId: string): Promise<string> {
  const res = await api.get(`/api/requests/${encodeURIComponent(requestId)}/jobs`);
  expect(res.status, `job 一覧を取得できません: ${res.text.slice(0, 300)}`).toBe(200);
  const items = (res.body?.items ?? []) as { id?: string }[];
  const id = items[0]?.id;
  expect(id, '投入したのに job が作られていない').toBeTruthy();
  return id as string;
}

/** job の見え方（API）。 */
export async function jobView(api: Api, jobId: string): Promise<{ id: string; state: string; headSha: string | null }> {
  const res = await api.get(`/api/jobs/${encodeURIComponent(jobId)}`);
  expect(res.status, `job を取得できません: ${res.text.slice(0, 300)}`).toBe(200);
  return res.body.job as { id: string; state: string; headSha: string | null };
}

/** job の行（DB 直読）。 */
export async function jobRow(db: Db, jobId: string): Promise<any> {
  const rows = await db.query('select * from job where id = $1', [jobId]);
  expect(rows, `job ${jobId} が DB にありません`).toHaveLength(1);
  return rows[0];
}

/**
 * job を pr_ready まで整える（worker は起動しない）。
 * 順序は 0008 の遷移表どおり。verifying → pr_ready は 0009 の guard が合格の verification と
 * pr_body_draft を要求するので、先にその 2 行を作る。lease は持たない（pr_ready は lease 禁止）。
 */
export async function prepareJobPrReady(
  db: Db,
  opts: { jobId: string; headSha: string; prNumber: number; prUrl: string },
): Promise<void> {
  const { jobId, headSha, prNumber, prUrl } = opts;
  expect(headSha, 'head SHA が 40 桁の 16 進ではありません').toMatch(/^[0-9a-f]{40}$/);

  const jobRows = await db.query('select request_id from job where id = $1', [jobId]);
  expect(jobRows, `job ${jobId} が DB にありません`).toHaveLength(1);
  const requestId = String(jobRows[0].request_id);
  const requestRows = await db.query('select criteria from request where id = $1', [requestId]);
  expect(requestRows, `依頼 ${requestId} が DB にありません`).toHaveLength(1);
  const criteria = (requestRows[0].criteria ?? []) as string[];
  expect(criteria.length, `依頼 ${requestId} に合格条件がありません（AC を合格にできない）`).toBeGreaterThan(0);

  await db.query(
    `insert into verification (job_id, delivery_id, source, ci_run_id, run_sequence, run_attempt, head_sha, stages, ac_results, received_at)
     values ($1, $2, 'fake_ci', $3, 1, 1, $4, $5::jsonb, $6::jsonb, now())`,
    [
      jobId,
      `e2e-${jobId}`,
      `e2e-run-${jobId.slice(0, 8)}`,
      headSha,
      JSON.stringify(passedStages()),
      JSON.stringify(acResults(criteria)),
    ],
  );

  await db.query(
    `insert into job_artifact (job_id, kind, name, sha256, byte_size, content, created_at)
     values ($1, 'pr_body_draft', 'pr-body.md', $2, $3, $4, now())`,
    [jobId, 'e'.repeat(64), 64, 'E2E の作り物の PR 本文（実データは使わない）'],
  );

  const steps: readonly (readonly [string, string])[] = [
    ['queued', 'planning'],
    ['planning', 'implementing'],
    ['implementing', 'verifying'],
  ];
  for (const [from, to] of steps) {
    const rows = await db.query(`update job set state = $2, updated_at = now() where id = $1 and state = $3 returning id`, [
      jobId,
      to,
      from,
    ]);
    expect(rows, `job を ${from} から ${to} へ進めませんでした`).toHaveLength(1);
  }

  const headed = await db.query(
    `update job set head_sha = $2, updated_at = now() where id = $1 and state = 'verifying' returning id`,
    [jobId, headSha],
  );
  expect(headed, 'job の head SHA を記録できませんでした').toHaveLength(1);

  const ready = await db.query(
    `update job set state = 'pr_ready', updated_at = now() where id = $1 and state = 'verifying' returning id`,
    [jobId],
  );
  expect(ready, 'job を pr_ready にできませんでした（verification か pr_body_draft が不足）').toHaveLength(1);

  const work = await db.query(
    `update job set work_state = work_state || jsonb_build_object('pr', $2::jsonb), updated_at = now() where id = $1 returning id`,
    [jobId, JSON.stringify({ number: prNumber, url: prUrl })],
  );
  expect(work, 'job の work_state に PR を記録できませんでした').toHaveLength(1);
}

/**
 * pr_ready から merged（必要なら staged）まで、DB の遷移表どおりに進める。
 * いまの状態から数えて、まだ通っていない段だけを進める（merged の job を staged へ進める場合も同じ口で使える）。
 */
export async function advanceJobTo(db: Db, jobId: string, to: 'approved' | 'merged' | 'staged'): Promise<void> {
  const chain = ['pr_ready', 'approved', 'merged', 'staged'];
  const target = chain.indexOf(to);
  expect(target, `進め先の状態が不正です: ${to}`).toBeGreaterThan(0);
  const row = await jobRow(db, jobId);
  const current = chain.indexOf(String(row.state));
  expect(current, `job のいまの状態（${String(row.state)}）から ${to} へは進められません`).toBeGreaterThanOrEqual(0);
  for (let i = current + 1; i <= target; i += 1) {
    const from = chain[i - 1] as string;
    const next = chain[i] as string;
    const rows = await db.query(`update job set state = $2, updated_at = now() where id = $1 and state = $3 returning id`, [
      jobId,
      next,
      from,
    ]);
    expect(rows, `job を ${from} から ${next} へ進めませんでした`).toHaveLength(1);
  }
}

/**
 * merge 済みの release 行を作る（成果物の検査まで終わった状態）。
 * repo は job の投入先（偽 GitHub のリポジトリ）を使う。
 */
export async function insertMergedRelease(
  db: Db,
  opts: {
    jobId: string;
    headSha: string;
    mergeSha: string;
    imageDigest: string;
    previousDigest: string;
    previousSha: string;
    prNumber?: number;
  },
): Promise<void> {
  const rows = await db.query('select target_repo_id from job where id = $1', [opts.jobId]);
  expect(rows, `job ${opts.jobId} が DB にありません`).toHaveLength(1);
  const repo = String(rows[0].target_repo_id);
  await db.query(
    `insert into release (job_id, repo, pr_number, head_sha, merge_state, merge_sha, tree_match, image_digest,
                          artifact_health, artifact_smoke, artifact_built_at, previous_digest, previous_sha, created_at, updated_at)
     values ($1, $2, $3, $4, 'merged', $5, true, $6, true, true, now(), $7, $8, now(), now())`,
    [
      opts.jobId,
      repo,
      opts.prNumber ?? 4242,
      opts.headSha,
      opts.mergeSha,
      opts.imageDigest,
      opts.previousDigest,
      opts.previousSha,
    ],
  );
}

/** 環境に版が載った（配備が成功した）release_attempt 行を作る。 */
export async function insertSucceededDeployAttempt(
  db: Db,
  opts: { jobId: string; sha: string; digest: string; previousDigest: string; previousSha: string },
): Promise<void> {
  const rows = await db.query('select id from release where job_id = $1', [opts.jobId]);
  expect(rows, `job ${opts.jobId} の release がありません`).toHaveLength(1);
  const releaseId = String(rows[0].id);
  await db.query(
    `insert into release_attempt (release_id, job_id, kind, state, environment, sha, digest, previous_digest, previous_sha,
                                  deployed_digest, deployed_sha, health, smoke, url, correlation_id, created_at, started_at, finished_at)
     values ($1, $2, 'deploy', 'succeeded', 'local-verify', $3, $4, $5, $6, $4, $3, true, true,
             'http://127.0.0.1:1/e2e-fake', 'e2e', now(), now(), now())`,
    [releaseId, opts.jobId, opts.sha, opts.digest, opts.previousDigest, opts.previousSha],
  );
}

/** その job の release_attempt の件数（「増えていない」ことの確認用）。 */
export async function countAttempts(db: Db, jobId: string): Promise<number> {
  const rows = await db.query('select count(*)::int as n from release_attempt where job_id = $1', [jobId]);
  return Number(rows[0]?.n ?? -1);
}
