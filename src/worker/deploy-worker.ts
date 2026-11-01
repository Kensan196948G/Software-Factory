/**
 * 成果物の取得・検証環境への配備・戻し（release_attempt の行を1件ずつ処理する）。
 * attempt の kind='build' は「CI が作った成果物の取得と照合」を指す。このホストではイメージを作らない。
 *
 * - job には lease を置けない（job_no_lease_when_waiting）ので、書き込みは attempt の lease と fence で守る。
 * - merge の口を持たない。PR も承認も扱わない（src/api/devline-release.ts を import しない）。
 * - 配備は承認された digest のイメージをそのまま起動する。作り直さない（仕様 4-9）。
 * - 成果物は merge の承認で固定した run のものだけ。無ければ止まる（fallback で作らない）。
 * - 失敗したら前の digest へ自動で戻し、失敗として記録する。job は merged のまま。
 */
import { query, withTransaction } from '../api/db.js';
import { appendAuditTx } from '../api/audit.js';
import { insertJobEvent } from '../api/devline-jobs.js';
import { isOrderCurrent } from '../shared/devline.js';
import type { JobState } from '../shared/devline.js';
import { DEPLOY_ARTIFACT_TAG, DEPLOY_CONTAINER_NAME } from '../shared/devline-release.js';
import type { Status } from '../shared/domain.js';
import type { ImageArtifactProblem, ImageArtifactSource } from './deploy-artifact.js';
import { DEPLOY_IMAGE_REPO, type DeployDocker, type DeployProbe } from './deploy-docker.js';

// 取得（最大 10 分）と読み込み（最大 10 分）より長くする
const LEASE_SECONDS = 1800;
const MAX_ATTEMPTS = 3;
const WORKER_AUDIT = { actorUserId: null, actorName: 'deploy-worker', role: 'system' } as const;

export interface DeployWorkerOptions {
  owner: string;
  docker: DeployDocker;
  probe: DeployProbe;
  artifacts: ImageArtifactSource;
  containerName?: string;
  /** 一時コンテナの名前の頭。試験で分ける。 */
  smokeNamePrefix?: string;
  clock: () => Date;
}

interface AttemptRow {
  seq: string;
  id: string;
  release_id: string;
  job_id: string;
  kind: 'build' | 'deploy' | 'rollback';
  environment: string;
  sha: string;
  digest: string | null;
  previous_digest: string | null;
  previous_sha: string | null;
  attempts: number;
  fencing_token: number;
  correlation_id: string | null;
}

interface JobFacts {
  state: JobState;
  superseded_at: Date | null;
  order_version: number;
  request_status: Status;
  request_deleted: boolean;
  request_order_version: number;
  repo: string;
  head_sha: string;
  verified_run_id: string | null;
  verified_run_attempt: number | null;
  merge_sha: string | null;
  tree_match: boolean | null;
  image_digest: string | null;
  deploy_approved_sha: string | null;
  deploy_approved_digest: string | null;
  environment: string | null;
}

async function jobFacts(a: AttemptRow): Promise<JobFacts | null> {
  const { rows } = await query<JobFacts>(
    `select j.state, j.superseded_at, j.order_version, q.status as request_status, q.deleted as request_deleted,
            q.order_version as request_order_version, r.repo, r.head_sha, r.verified_run_id, r.verified_run_attempt, r.merge_sha, r.tree_match, r.image_digest,
            r.deploy_approved_sha, r.deploy_approved_digest, r.environment
       from release r join job j on j.id = r.job_id join request q on q.id = j.request_id
      where r.id = $1`,
    [a.release_id],
  );
  return rows[0] ?? null;
}

/** 1件取る。lease の切れた running は回数の上限まで取り直し、超えたら失敗で閉じる。 */
async function claim(owner: string, now: Date): Promise<AttemptRow | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<AttemptRow>(
      `with c as (
         select seq from release_attempt
          where state = 'pending' or (state = 'running' and lease_expires_at <= $2::timestamptz)
          order by seq limit 1 for update skip locked
       )
       update release_attempt a set state='running', lease_owner=$1, lease_expires_at=$2::timestamptz + make_interval(secs => $3::double precision),
              started_at=coalesce(a.started_at,$2::timestamptz), attempts=a.attempts+1, fencing_token=a.fencing_token+1
         from c where a.seq=c.seq
       returning a.*`,
      [owner, now, LEASE_SECONDS],
    );
    return rows[0] ?? null;
  });
}

interface Finish {
  state: 'succeeded' | 'failed';
  digest?: string | null;
  deployedDigest?: string | null;
  deployedSha?: string | null;
  health?: boolean | null;
  smoke?: boolean | null;
  url?: string | null;
  errorCode?: string | null;
  autoRollback?: 'restored' | 'nothing_to_restore' | 'failed' | null;
  /** 取得元。成果物の取得が成功したときだけ。 */
  source?: { runId: string; runAttempt: number; artifactId: number; tarSha256: string };
}

export type DeployOutcome =
  { kind: 'idle' } | { kind: 'done'; attemptKind: AttemptRow['kind']; state: 'succeeded' | 'failed'; errorCode: string | null };

/** fence が合うときだけ閉じる。遅れた書き込みは捨てる。 */
async function finishAttempt(
  a: AttemptRow,
  finish: Finish,
  now: Date,
  apply: (client: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<void>,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `update release_attempt set state=$3, finished_at=$4, digest=coalesce($5,digest), deployed_digest=$6, deployed_sha=$7,
              health=$8, smoke=$9, url=$10, error_code=$11, auto_rollback=$12, lease_owner=null, lease_expires_at=null
        where id=$1 and fencing_token=$2 and state='running'`,
      [
        a.id,
        a.fencing_token,
        finish.state,
        now,
        finish.digest ?? null,
        finish.deployedDigest ?? null,
        finish.deployedSha ?? null,
        finish.health ?? null,
        finish.smoke ?? null,
        finish.url ?? null,
        finish.errorCode ?? null,
        finish.autoRollback ?? null,
      ],
    );
    if ((res.rowCount ?? 0) === 0) return false;
    await apply(client);
    await appendAuditTx(client, {
      action: `job.${a.kind}_result`,
      targetType: 'job',
      targetId: a.job_id,
      result: finish.state === 'succeeded' ? 'success' : 'error',
      ...WORKER_AUDIT,
      correlationId: a.correlation_id,
      diff: {
        sha: a.sha,
        digest: finish.digest ?? a.digest,
        errorCode: finish.errorCode ?? null,
        autoRollback: finish.autoRollback ?? null,
        ...(finish.source ? { source: finish.source } : {}),
      },
    });
    return true;
  });
}

const ARTIFACT_ERROR: Record<ImageArtifactProblem, string> = {
  missing: 'artifact_missing',
  expired: 'artifact_expired',
  too_large: 'artifact_too_large',
  mismatch: 'artifact_mismatch',
  unavailable: 'artifact_unavailable',
};

/** merge の承認で固定した run の成果物を取得し、照合して読み込む。合わなければ配備の承認へ進めない。 */
async function runBuild(a: AttemptRow, facts: JobFacts, o: DeployWorkerOptions): Promise<Finish> {
  if (facts.state !== 'merged' || facts.merge_sha !== a.sha || facts.tree_match !== true) {
    return { state: 'failed', errorCode: 'not_buildable' };
  }
  if (facts.verified_run_id === null || facts.verified_run_attempt === null) {
    return { state: 'failed', errorCode: 'artifact_missing' };
  }
  // 成果物は PR の head に結びつく（merge の SHA ではない）。merge との対応は tree の一致で確かめ済み
  const fetched = await o.artifacts
    .fetch({ repo: facts.repo, runId: facts.verified_run_id, runAttempt: facts.verified_run_attempt, headSha: facts.head_sha })
    .catch(() => ({ ok: false as const, problem: 'unavailable' as const }));
  if (!fetched.ok) return { state: 'failed', errorCode: ARTIFACT_ERROR[fetched.problem] };
  const digest = fetched.imageId;
  const source = {
    runId: fetched.runId,
    runAttempt: fetched.runAttempt,
    artifactId: fetched.artifactId,
    tarSha256: fetched.tarSha256,
  };
  try {
    let loaded: { ref: string; id: string };
    try {
      loaded = await o.docker.loadImage(fetched.tarPath);
    } catch {
      return { state: 'failed', errorCode: 'artifact_load_failed' };
    }
    // 検査した tar に入っていたタグか。読み込まれたものの ID を見る（同じ ID が手元にあるだけでは通さない）
    if (loaded.ref !== DEPLOY_ARTIFACT_TAG) return { state: 'failed', errorCode: 'artifact_mismatch' };
    if (loaded.id !== digest) {
      await o.docker.discardImage(loaded.ref).catch(() => undefined);
      return { state: 'failed', errorCode: 'artifact_mismatch' };
    }
    await o.docker.adoptImage({ ref: loaded.ref, id: loaded.id, tag: `${DEPLOY_IMAGE_REPO}:${a.sha}` });
  } catch {
    return { state: 'failed', errorCode: 'artifact_load_failed' };
  } finally {
    fetched.cleanup();
  }
  // 配備先ではなく一時コンテナで確かめる
  // 名前は固定。worker が落ちて残ったコンテナがネットワークに残り続けないよう、先に片付ける
  const name = o.smokeNamePrefix ?? 'msf-sandbox-smoke';
  try {
    await o.docker.remove(name).catch(() => undefined);
    const { baseUrl } = await o.docker.run({ name, digest, version: a.sha });
    const result = await o.probe.check(baseUrl, a.sha);
    const passed = result.health && result.smoke;
    return {
      state: passed ? 'succeeded' : 'failed',
      digest,
      health: result.health,
      smoke: result.smoke,
      errorCode: passed ? null : 'artifact_check_failed',
      ...(passed ? { source } : {}),
    };
  } catch {
    return { state: 'failed', digest, errorCode: 'artifact_run_failed' };
  } finally {
    await o.docker.remove(name).catch(() => undefined);
  }
}

/** 前の版を起動して確かめる。前の版が無ければ、失敗したコンテナを消すだけ。 */
async function restore(
  a: AttemptRow,
  o: DeployWorkerOptions,
  name: string,
): Promise<{ result: NonNullable<Finish['autoRollback']>; url: string | null }> {
  await o.docker.remove(name).catch(() => undefined);
  if (!a.previous_digest || !a.previous_sha) return { result: 'nothing_to_restore', url: null };
  try {
    if (!(await o.docker.hasImage(a.previous_digest))) return { result: 'failed', url: null };
    const { baseUrl } = await o.docker.run({ name, digest: a.previous_digest, version: a.previous_sha });
    const again = await o.probe.check(baseUrl, a.previous_sha);
    if (again.health && again.smoke) return { result: 'restored', url: baseUrl };
  } catch {
    /* 下で failed にする */
  }
  await o.docker.remove(name).catch(() => undefined);
  return { result: 'failed', url: null };
}

function afterRestore(
  a: AttemptRow,
  restored: Awaited<ReturnType<typeof restore>>,
): { deployedDigest: string | null; deployedSha: string | null; autoRollback: Finish['autoRollback']; url: string | null } {
  return restored.result === 'restored'
    ? { deployedDigest: a.previous_digest, deployedSha: a.previous_sha, autoRollback: restored.result, url: restored.url }
    : { deployedDigest: null, deployedSha: null, autoRollback: restored.result, url: null };
}

async function runDeploy(a: AttemptRow, facts: JobFacts, o: DeployWorkerOptions): Promise<Finish> {
  const name = o.containerName ?? DEPLOY_CONTAINER_NAME;
  // 何も動かさずに失敗する場合は、環境の版は前のまま
  const untouched = { deployedDigest: a.previous_digest, deployedSha: a.previous_sha };
  const current = isOrderCurrent({
    requestStatus: facts.request_status,
    requestDeleted: facts.request_deleted,
    requestOrderVersion: facts.request_order_version,
    jobOrderVersion: facts.order_version,
  });
  // 承認の後で版が上がったら配備しない。承認の3つも読み直す
  if (
    facts.state !== 'merged' ||
    facts.superseded_at !== null ||
    !current ||
    facts.merge_sha !== a.sha ||
    facts.image_digest !== a.digest ||
    facts.deploy_approved_sha !== a.sha ||
    facts.deploy_approved_digest !== a.digest ||
    facts.environment !== a.environment
  ) {
    return { state: 'failed', errorCode: 'approval_expired', ...untouched };
  }
  const digest = a.digest as string;
  if (!(await o.docker.hasImage(digest))) return { state: 'failed', errorCode: 'image_missing', ...untouched };
  const existing = await o.docker.containerState(name);
  if (existing === 'foreign') return { state: 'failed', errorCode: 'name_in_use', ...untouched };
  await o.docker.remove(name);
  let baseUrl: string;
  try {
    ({ baseUrl } = await o.docker.run({ name, digest, version: a.sha }));
  } catch {
    const restored = await restore(a, o, name);
    return { state: 'failed', errorCode: 'run_failed', ...afterRestore(a, restored) };
  }
  const result = await o.probe.check(baseUrl, a.sha);
  if (result.health && result.smoke) {
    return { state: 'succeeded', deployedDigest: digest, deployedSha: a.sha, health: true, smoke: true, url: baseUrl };
  }
  const restored = await restore(a, o, name);
  return {
    state: 'failed',
    errorCode: result.health ? 'smoke_failed' : 'health_failed',
    health: result.health,
    smoke: result.smoke,
    ...afterRestore(a, restored),
  };
}

async function runRollback(a: AttemptRow, o: DeployWorkerOptions): Promise<Finish> {
  const name = o.containerName ?? DEPLOY_CONTAINER_NAME;
  const untouched = { deployedDigest: a.previous_digest, deployedSha: a.previous_sha };
  const digest = a.digest as string;
  if (!(await o.docker.hasImage(digest))) return { state: 'failed', errorCode: 'image_missing', ...untouched };
  const existing = await o.docker.containerState(name);
  if (existing === 'foreign') return { state: 'failed', errorCode: 'name_in_use', ...untouched };
  await o.docker.remove(name);
  let result = { health: false, smoke: false };
  let baseUrl: string | null = null;
  try {
    ({ baseUrl } = await o.docker.run({ name, digest, version: a.sha }));
    result = await o.probe.check(baseUrl, a.sha);
  } catch {
    /* 下で元の版へ戻す */
  }
  if (result.health && result.smoke) {
    return { state: 'succeeded', deployedDigest: digest, deployedSha: a.sha, health: true, smoke: true, url: baseUrl };
  }
  // 戻し先が動かない。戻す前の版（previous に入っている）へ戻す
  const restored = await restore(a, o, name);
  return {
    state: 'failed',
    errorCode: 'rollback_failed',
    health: result.health,
    smoke: result.smoke,
    ...afterRestore(a, restored),
  };
}

async function applyResult(
  a: AttemptRow,
  finish: Finish,
  now: Date,
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
): Promise<void> {
  const system = { actorType: 'system' as const, correlationId: a.correlation_id };
  const detail = {
    sha: a.sha,
    digest: finish.digest ?? a.digest,
    errorCode: finish.errorCode ?? null,
    autoRollback: finish.autoRollback ?? null,
    ...(finish.source ? { source: finish.source } : {}),
  };
  if (a.kind === 'build') {
    if (finish.state === 'succeeded') {
      await client.query(
        `update release set image_digest=$2, artifact_built_at=$3, artifact_health=$4, artifact_smoke=$5,
                artifact_run_id=$6, artifact_run_attempt=$7, artifact_id=$8, artifact_tar_sha256=$9,
                fencing_token=fencing_token+1, updated_at=$3
          where id=$1 and image_digest is null`,
        [
          a.release_id,
          finish.digest,
          now,
          finish.health,
          finish.smoke,
          finish.source?.runId ?? null,
          finish.source?.runAttempt ?? null,
          finish.source?.artifactId ?? null,
          finish.source?.tarSha256 ?? null,
        ],
      );
    }
    await insertJobEvent(client, { jobId: a.job_id, at: now, kind: `artifact_${finish.state}`, ...system, detail });
    return;
  }
  if (a.kind === 'deploy') {
    if (finish.state === 'succeeded') {
      const moved = await client.query(`update job set state='staged', updated_at=$2 where id=$1 and state='merged'`, [
        a.job_id,
        now,
      ]);
      if ((moved.rowCount ?? 0) > 0) {
        await insertJobEvent(client, {
          jobId: a.job_id,
          at: now,
          kind: 'transition',
          from: 'merged',
          to: 'staged',
          ...system,
          detail,
        });
      }
      await client.query(
        `update release set deployed_at=$2, health=true, smoke=true, url=$3, previous_digest=$4, previous_sha=$5, current_digest=$6,
                rolled_back_at=null, fencing_token=fencing_token+1, updated_at=$2
          where id=$1`,
        [a.release_id, now, finish.url, a.previous_digest, a.previous_sha, a.digest],
      );
      return;
    }
    await client.query(`update release set health=$2, smoke=$3, updated_at=$4 where id=$1`, [
      a.release_id,
      finish.health ?? null,
      finish.smoke ?? null,
      now,
    ]);
    await insertJobEvent(client, { jobId: a.job_id, at: now, kind: 'deploy_failed', ...system, detail });
    return;
  }
  if (finish.state === 'succeeded') {
    await client.query(
      `update release set current_digest=$2, rolled_back_at=$3, fencing_token=fencing_token+1, updated_at=$3 where id=$1`,
      [a.release_id, a.digest, now],
    );
  }
  await insertJobEvent(client, { jobId: a.job_id, at: now, kind: `rollback_${finish.state}`, ...system, detail });
}

/** 1件だけ処理する。なければ idle。例外は失敗の記録に変える（次の取得で詰まらせない）。 */
export async function runDeployOnce(o: DeployWorkerOptions): Promise<DeployOutcome> {
  const attempt = await claim(o.owner, o.clock());
  if (!attempt) return { kind: 'idle' };
  let finish: Finish;
  if (attempt.attempts > MAX_ATTEMPTS) {
    finish = {
      state: 'failed',
      errorCode: 'too_many_attempts',
      // 途中で落ちた試行の後なので、いま何が動いているかは分からない
      deployedDigest: null,
      deployedSha: null,
    };
  } else {
    try {
      const facts = await jobFacts(attempt);
      if (!facts) finish = { state: 'failed', errorCode: 'no_release' };
      else if (attempt.kind === 'build') finish = await runBuild(attempt, facts, o);
      else if (attempt.kind === 'deploy') finish = await runDeploy(attempt, facts, o);
      else finish = await runRollback(attempt, o);
    } catch {
      // 内部エラーの本文は記録しない。環境の版は分からないので、前の版のままとは言わない
      finish = { state: 'failed', errorCode: 'internal_error' };
    }
  }
  const now = o.clock();
  await finishAttempt(attempt, finish, now, (client) => applyResult(attempt, finish, now, client));
  return { kind: 'done', attemptKind: attempt.kind, state: finish.state, errorCode: finish.errorCode ?? null };
}
