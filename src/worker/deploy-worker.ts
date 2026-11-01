/**
 * 成果物の作成・検証環境への配備・戻し（release_attempt の行を1件ずつ処理する）。
 *
 * - job には lease を置けない（job_no_lease_when_waiting）ので、書き込みは attempt の lease と fence で守る。
 * - merge の口を持たない。PR も承認も扱わない（src/api/devline-release.ts を import しない）。
 * - 配備は承認された digest のイメージをそのまま起動する。ここで作り直さない（仕様 4-9）。
 * - 失敗したら前の digest へ自動で戻し、失敗として記録する。job は merged のまま。
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../api/db.js';
import { appendAuditTx } from '../api/audit.js';
import { insertJobEvent } from '../api/devline-jobs.js';
import { isOrderCurrent } from '../shared/devline.js';
import type { JobState } from '../shared/devline.js';
import { DEPLOY_CONTAINER_NAME, DEPLOY_DEFAULT_PORT, DEPLOY_SMOKE_DEFAULT_PORT } from '../shared/devline-release.js';
import type { Status } from '../shared/domain.js';
import type { DeployDocker, DeployProbe } from './deploy-docker.js';
import type { DeploySource } from './deploy-source.js';

const LEASE_SECONDS = 900;
const MAX_ATTEMPTS = 3;
const WORKER_AUDIT = { actorUserId: null, actorName: 'deploy-worker', role: 'system' } as const;

export interface DeployWorkerOptions {
  owner: string;
  docker: DeployDocker;
  probe: DeployProbe;
  source: DeploySource;
  port: number;
  smokePort: number;
  containerName?: string;
  /** 一時コンテナの名前の頭。試験で分ける。 */
  smokeNamePrefix?: string;
  imageTagPrefix?: string;
  clock: () => Date;
}

/** 環境変数の既定値。使用中のときは配備の時点で失敗にする。 */
export function deployPortsFromEnv(env: Record<string, string | undefined>): { port: number; smokePort: number } {
  const parse = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} が正しくありません`);
    return value;
  };
  const port = parse(env.DEVLINE_DEPLOY_PORT, DEPLOY_DEFAULT_PORT, 'DEVLINE_DEPLOY_PORT');
  const smokePort = parse(env.DEVLINE_DEPLOY_SMOKE_PORT, DEPLOY_SMOKE_DEFAULT_PORT, 'DEVLINE_DEPLOY_SMOKE_PORT');
  if (port === smokePort) throw new Error('DEVLINE_DEPLOY_PORT と DEVLINE_DEPLOY_SMOKE_PORT は別の値にしてください');
  return { port, smokePort };
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
            q.order_version as request_order_version, r.repo, r.merge_sha, r.tree_match, r.image_digest,
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
      },
    });
    return true;
  });
}

function url(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function runBuild(a: AttemptRow, facts: JobFacts, o: DeployWorkerOptions): Promise<Finish> {
  if (facts.state !== 'merged' || facts.merge_sha !== a.sha || facts.tree_match !== true) {
    return { state: 'failed', errorCode: 'not_buildable' };
  }
  if (!(await o.docker.portFree(o.smokePort))) return { state: 'failed', errorCode: 'smoke_port_in_use' };
  let digest: string | undefined;
  const fetched = await o.source.fetch({ repo: facts.repo, sha: a.sha }).catch(() => null);
  if (!fetched) return { state: 'failed', errorCode: 'source_fetch_failed' };
  try {
    digest = await o.docker.build({
      contextDir: fetched.dir,
      tag: `${o.imageTagPrefix ?? 'msf-sandbox-verify'}:${a.sha}`,
      sha: a.sha,
    });
  } catch {
    return { state: 'failed', errorCode: 'build_failed' };
  } finally {
    fetched.cleanup();
  }
  // 配備先ではなく一時コンテナで確かめる
  const name = `${o.smokeNamePrefix ?? 'msf-sandbox-smoke'}-${randomUUID().slice(0, 8)}`;
  try {
    await o.docker.run({ name, digest, port: o.smokePort, version: a.sha });
    const result = await o.probe.check(o.smokePort, a.sha);
    return {
      state: result.health && result.smoke ? 'succeeded' : 'failed',
      digest,
      health: result.health,
      smoke: result.smoke,
      errorCode: result.health && result.smoke ? null : 'artifact_check_failed',
    };
  } catch {
    return { state: 'failed', digest, errorCode: 'artifact_run_failed' };
  } finally {
    await o.docker.remove(name).catch(() => undefined);
  }
}

/** 前の版を起動して確かめる。前の版が無ければ、失敗したコンテナを消すだけ。 */
async function restore(a: AttemptRow, o: DeployWorkerOptions, name: string): Promise<Finish['autoRollback']> {
  await o.docker.remove(name).catch(() => undefined);
  if (!a.previous_digest || !a.previous_sha) return 'nothing_to_restore';
  try {
    if (!(await o.docker.hasImage(a.previous_digest))) return 'failed';
    await o.docker.run({ name, digest: a.previous_digest, port: o.port, version: a.previous_sha });
    const again = await o.probe.check(o.port, a.previous_sha);
    if (again.health && again.smoke) return 'restored';
  } catch {
    /* 下で failed にする */
  }
  await o.docker.remove(name).catch(() => undefined);
  return 'failed';
}

function afterRestore(
  a: AttemptRow,
  restored: Finish['autoRollback'],
): { deployedDigest: string | null; deployedSha: string | null } {
  return restored === 'restored'
    ? { deployedDigest: a.previous_digest, deployedSha: a.previous_sha }
    : { deployedDigest: null, deployedSha: null };
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
  if (existing === 'none' && !(await o.docker.portFree(o.port))) {
    return { state: 'failed', errorCode: 'port_in_use', ...untouched };
  }
  await o.docker.remove(name);
  try {
    await o.docker.run({ name, digest, port: o.port, version: a.sha });
  } catch {
    const restored = await restore(a, o, name);
    return { state: 'failed', errorCode: 'run_failed', autoRollback: restored, ...afterRestore(a, restored) };
  }
  const result = await o.probe.check(o.port, a.sha);
  if (result.health && result.smoke) {
    return { state: 'succeeded', deployedDigest: digest, deployedSha: a.sha, health: true, smoke: true, url: url(o.port) };
  }
  const restored = await restore(a, o, name);
  return {
    state: 'failed',
    errorCode: result.health ? 'smoke_failed' : 'health_failed',
    health: result.health,
    smoke: result.smoke,
    autoRollback: restored,
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
  if (existing === 'none' && !(await o.docker.portFree(o.port))) {
    return { state: 'failed', errorCode: 'port_in_use', ...untouched };
  }
  await o.docker.remove(name);
  let result = { health: false, smoke: false };
  try {
    await o.docker.run({ name, digest, port: o.port, version: a.sha });
    result = await o.probe.check(o.port, a.sha);
  } catch {
    /* 下で元の版へ戻す */
  }
  if (result.health && result.smoke) {
    return { state: 'succeeded', deployedDigest: digest, deployedSha: a.sha, health: true, smoke: true, url: url(o.port) };
  }
  // 戻し先が動かない。戻す前の版（previous に入っている）へ戻す
  const restored = await restore(a, o, name);
  return {
    state: 'failed',
    errorCode: 'rollback_failed',
    health: result.health,
    smoke: result.smoke,
    autoRollback: restored,
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
  };
  if (a.kind === 'build') {
    if (finish.state === 'succeeded') {
      await client.query(
        `update release set image_digest=$2, artifact_built_at=$3, artifact_health=$4, artifact_smoke=$5, fencing_token=fencing_token+1, updated_at=$3
          where id=$1 and image_digest is null`,
        [a.release_id, finish.digest, now, finish.health, finish.smoke],
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
      deployedDigest: attempt.previous_digest,
      deployedSha: attempt.previous_sha,
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
