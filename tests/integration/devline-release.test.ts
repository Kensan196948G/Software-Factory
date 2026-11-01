/**
 * 人の承認 → merge → 検証環境への配備 → 戻し（仕様 4-9、TC-N09）。
 * GitHub は stub の口、docker は stub。実 GitHub・実 Docker・実 AI へは送らない。fake runner で pr_ready まで進める。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../src/api/db.js';
import { recordVerification } from '../../src/api/devline-service.js';
import {
  approveDeploy,
  approveMerge,
  devlineSummary,
  listReleaseEvidence,
  rollbackRelease,
  type ReleaseDeps,
} from '../../src/api/devline-release.js';
import type { MergeSendOutcome, PrMergeAdapter, PullMergeFacts } from '../../src/api/pr-adapter.js';
import { buildPrMarker } from '../../src/shared/devline.js';
import { DEPLOY_ENVIRONMENT } from '../../src/shared/devline-release.js';
import type { DeployDocker, DeployProbe, DeployRunSpec } from '../../src/worker/deploy-docker.js';
import { runDeployOnce, type DeployWorkerOptions } from '../../src/worker/deploy-worker.js';
import { createDeploySource } from '../../src/worker/deploy-source.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DUMMY_GH_TOKEN, REAL_REPO, startRealGithub } from './devline-real-harness.js';
import { FAKE_REPO, FAKE_REPO_ID } from './fake-github-server.js';
import { stages, useHarness } from './devline-qa-harness.js';

const h = useHarness();

// AI の利用者の試験が印を残さないように戻す（利用者の行は試験をまたいで残る）
afterEach(async () => {
  await query('update app_user set is_agent=false where is_agent');
});
const LOGIN = 'msf-release-bot';
const MERGE_SHA = (n: number): string => String(n).padStart(40, 'c');
const digestOf = (n: number): string => `sha256:${String(n).padStart(64, 'd')}`;

interface StubGithub extends PrMergeAdapter {
  pull: PullMergeFacts;
  calls: { sha: string }[];
  trees: Record<string, string>;
  next: MergeSendOutcome | 'lost' | 'ok';
  mergeSha: string;
  gate: Promise<void> | null;
}

function stubGithub(jobId: string, headSha: string, n = 1): StubGithub {
  const stub: StubGithub = {
    pull: {
      number: 500 + n,
      url: `http://127.0.0.1:1/${FAKE_REPO}/pull/${500 + n}`,
      state: 'open',
      merged: false,
      mergeSha: null,
      headSha,
      baseRef: 'main',
      authorLogin: LOGIN,
      body: `${buildPrMarker({ jobId, attemptNo: 1, headSha })}\n\n本文`,
    },
    calls: [],
    trees: { [headSha]: 'a'.repeat(40), [MERGE_SHA(n)]: 'a'.repeat(40) },
    next: 'ok',
    mergeSha: MERGE_SHA(n),
    gate: null,
    getActorLogin: async () => ({ ok: true, value: LOGIN }),
    getDefaultBranch: async () => ({ ok: true, value: 'main' }),
    getPull: async () => ({ ok: true, value: { ...stub.pull } }),
    getCommitTree: async ({ sha }) => ({ ok: true, value: stub.trees[sha] ?? null }),
    mergePull: async ({ sha }) => {
      stub.calls.push({ sha });
      if (stub.gate) await stub.gate;
      const land = (): void => {
        stub.pull = { ...stub.pull, merged: true, state: 'closed', mergeSha: stub.mergeSha };
      };
      if (stub.next === 'ok') {
        land();
        return { outcome: 'merged', mergeSha: stub.mergeSha };
      }
      if (stub.next === 'lost') {
        land();
        return { outcome: 'unknown', reason: 'network' };
      }
      return stub.next;
    },
  };
  return stub;
}

function depsOf(github: StubGithub): ReleaseDeps {
  return { merge: github, allowedRepos: [{ name: FAKE_REPO, repoId: FAKE_REPO_ID }], now: h.clock, httpTimeoutMs: 2000 };
}

interface StubDocker extends DeployDocker {
  containers: Map<string, DeployRunSpec>;
  builds: number;
  runs: DeployRunSpec[];
  removed: string[];
  images: Set<string>;
  nextDigest: string;
  buildFails: boolean;
  portBusy: boolean;
}

function stubDocker(): StubDocker {
  const stub: StubDocker = {
    containers: new Map(),
    builds: 0,
    runs: [],
    removed: [],
    images: new Set(),
    nextDigest: digestOf(1),
    buildFails: false,
    portBusy: false,
    build: async () => {
      if (stub.buildFails) throw new Error('build');
      stub.builds += 1;
      stub.images.add(stub.nextDigest);
      return stub.nextDigest;
    },
    hasImage: async (d) => stub.images.has(d),
    containerState: async (name) => (stub.containers.has(name) ? 'own' : 'none'),
    run: async (spec) => {
      stub.runs.push(spec);
      stub.containers.set(spec.name, spec);
    },
    remove: async (name) => {
      stub.removed.push(name);
      stub.containers.delete(name);
    },
    portFree: async () => !stub.portBusy,
  };
  return stub;
}

function workerOf(docker: StubDocker, probe: DeployProbe): DeployWorkerOptions {
  return {
    owner: 'release-test',
    docker,
    probe,
    source: { fetch: async () => ({ dir: '/nonexistent', cleanup: () => undefined }) },
    port: 40001,
    smokePort: 40002,
    clock: h.clock,
  };
}

const okProbe: DeployProbe = { check: async () => ({ health: true, smoke: true }) };
const badProbe: DeployProbe = { check: async () => ({ health: false, smoke: false }) };

/** pr_ready まで進め、実 PR の記録を載せる（URL はローカル。画面では fake 扱い）。 */
async function prReady(n = 1): Promise<{ id: string; jobId: string; headSha: string; github: StubGithub; deps: ReleaseDeps }> {
  const id = await h.approvedRequest({ title: `作り物 ${n}` });
  const { jobId, headSha } = await h.untilPrReady(id);
  const github = stubGithub(jobId, headSha, n);
  await query(`update job set work_state = work_state || jsonb_build_object('pr', $2::jsonb) where id=$1`, [
    jobId,
    JSON.stringify({ number: github.pull.number, url: github.pull.url }),
  ]);
  return { id, jobId, headSha, github, deps: depsOf(github) };
}

const release = async (jobId: string): Promise<any> => (await query('select * from release where job_id=$1', [jobId])).rows[0];
const attempts = async (jobId: string): Promise<any[]> =>
  (await query('select * from release_attempt where job_id=$1 order by seq', [jobId])).rows;
const approver = () => h.actor('approver');

async function toMerged(n = 1): Promise<Awaited<ReturnType<typeof prReady>>> {
  const c = await prReady(n);
  await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
  return c;
}

/** merge → 成果物 → 配備まで進める。 */
async function toStaged(n: number, docker: StubDocker): Promise<Awaited<ReturnType<typeof prReady>>> {
  docker.nextDigest = digestOf(n);
  const c = await toMerged(n);
  expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'build', state: 'succeeded' });
  await approveDeploy(
    { jobId: c.jobId, sha: MERGE_SHA(n), digest: digestOf(n), environment: DEPLOY_ENVIRONMENT },
    approver(),
    'c',
    h.clock(),
  );
  expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'deploy', state: 'succeeded' });
  expect((await h.view(c.jobId)).state).toBe('staged');
  return c;
}

describe('merge の承認（FR-39、BR-07）', () => {
  it('承認で sha を渡して merge し、pr_ready → approved → merged の順に記録する', async () => {
    const c = await prReady();
    const res = await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c1', c.deps);
    expect(res).toMatchObject({ alreadyDone: false, mergeState: 'merged' });
    expect(c.github.calls).toEqual([{ sha: c.headSha }]);
    expect((await h.view(c.jobId)).state).toBe('merged');
    const hops = (await h.events(c.jobId)).filter((e) => e.kind === 'transition').slice(-2);
    expect(hops.map((e) => [e.from_state, e.to_state, e.actor_type])).toEqual([
      ['pr_ready', 'approved', 'human'],
      ['approved', 'merged', 'human'],
    ]);
    expect(await release(c.jobId)).toMatchObject({
      merge_state: 'merged',
      merge_sha: MERGE_SHA(1),
      approved_head_sha: c.headSha,
      merge_approver_user_id: h.auth.user.id,
      tree_match: true,
    });
    expect((await attempts(c.jobId)).map((a) => [a.kind, a.state])).toEqual([['build', 'pending']]);
    expect(
      await h.count(`from audit_log where action='job.merge_approve' and result='success' and target_id=$1`, [c.jobId]),
    ).toBe(1);
  });

  it('役割が違えば拒否し、監査に残す。送らない', async () => {
    const c = await prReady();
    for (const role of ['requester', 'desk'] as const) {
      await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, h.actor(role, true), 'c', c.deps)).rejects.toMatchObject({
        code: 'ERR-101',
      });
    }
    expect(c.github.calls).toEqual([]);
    expect(await h.count(`from audit_log where action='job.merge_approve' and result='denied' and target_id=$1`, [c.jobId])).toBe(
      2,
    );
    expect(await release(c.jobId)).toBeUndefined();
  });

  it('AI・自動処理の利用者は承認者の役割でも拒否する', async () => {
    const c = await prReady();
    await query('update app_user set is_agent=true where id=$1', [h.auth.user.id]);
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-101',
      details: { refusal: 'agent_actor' },
    });
    expect(c.github.calls).toEqual([]);
  });

  it('古い SHA の承認は失効する（送らない）', async () => {
    const c = await prReady();
    await expect(approveMerge({ jobId: c.jobId, headSha: 'e'.repeat(40) }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-202',
      details: { refusal: 'head_changed' },
    });
    expect(c.github.calls).toEqual([]);
  });

  it('版が上がると承認できない', async () => {
    const c = await prReady();
    await h.reapprove(c.id, '目的を変えた（作り物）');
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-202',
    });
    expect(c.github.calls).toEqual([]);
  });

  it('同じ SHA の最新の検査が失敗なら承認できない', async () => {
    const c = await prReady();
    await recordVerification(h.delivery(c.jobId, c.headSha, { runSequence: 900, stages: stages({ unit: 'failed' }) }));
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { refusal: 'verification' },
    });
    expect(c.github.calls).toEqual([]);
  });

  it('実 PR の記録がなければ承認できない', async () => {
    const id = await h.approvedRequest();
    const { jobId, headSha } = await h.untilPrReady(id);
    const github = stubGithub(jobId, headSha);
    await expect(approveMerge({ jobId, headSha }, approver(), 'c', depsOf(github))).rejects.toMatchObject({
      details: { refusal: 'no_pr' },
    });
  });

  it('PR の head が変わっていれば送らず失効。押し直しても送らない', async () => {
    const c = await prReady();
    c.github.pull.headSha = 'f'.repeat(40);
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-202',
      details: { detail: 'head_changed' },
    });
    expect(c.github.calls).toEqual([]);
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { refusal: 'expired' },
    });
    expect((await h.view(c.jobId)).state).toBe('pr_ready');
  });

  it('GitHub が 409（sha 違い）を返すと失効。job は pr_ready のまま', async () => {
    const c = await prReady();
    c.github.next = { outcome: 'rejected', cause: 'head_changed', httpStatus: 409 };
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { mergeState: 'rejected', detail: 'head_changed' },
    });
    expect((await h.view(c.jobId)).state).toBe('pr_ready');
    expect(await release(c.jobId)).toMatchObject({ merge_state: 'rejected', merge_sha: null });
    expect(await attempts(c.jobId)).toEqual([]);
  });

  it('405（必須検査・競合）は失効させず、押し直せる', async () => {
    const c = await prReady();
    c.github.next = { outcome: 'rejected', cause: 'not_mergeable', httpStatus: 405 };
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { detail: 'not_mergeable' },
    });
    c.github.next = 'ok';
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect((await h.view(c.jobId)).state).toBe('merged');
    expect(await h.count(`from release_approval where job_id=$1 and kind='merge'`, [c.jobId])).toBe(1);
  });

  it('作成者かマーカーが違う PR は merge しない', async () => {
    const c = await prReady();
    c.github.pull.authorLogin = 'someone-else';
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { detail: 'not_own' },
    });
    expect(c.github.calls).toEqual([]);
  });

  it('応答を失っても送り直さない。読んで merge 済みなら確定する', async () => {
    const c = await prReady();
    c.github.next = 'lost';
    // 応答の直後の読み直しも失敗させて、結果不明で止まるところを確かめる
    const getPull = c.github.getPull;
    let reads = 0;
    c.github.getPull = async (input, signal) => {
      reads += 1;
      return reads === 2 ? { ok: false, reason: 'network' } : getPull(input, signal);
    };
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-304',
      details: { mergeState: 'unknown' },
    });
    expect((await h.view(c.jobId)).state).toBe('pr_ready');
    expect(await release(c.jobId)).toMatchObject({ merge_state: 'unknown' });
    expect(c.github.calls).toHaveLength(1);

    const res = await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(res).toMatchObject({ mergeState: 'merged' });
    expect(c.github.calls).toHaveLength(1);
    expect((await h.view(c.jobId)).state).toBe('merged');
    expect(await release(c.jobId)).toMatchObject({ merge_state: 'merged', merge_sha: MERGE_SHA(1) });
  });

  it('結果不明のあと PR が別の head で merge されていたら進めない', async () => {
    const c = await prReady();
    c.github.next = { outcome: 'unknown', reason: 'timeout' };
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-304',
    });
    c.github.pull = { ...c.github.pull, merged: true, state: 'closed', mergeSha: MERGE_SHA(1), headSha: 'f'.repeat(40) };
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      details: { detail: 'head_changed' },
    });
    expect((await h.view(c.jobId)).state).toBe('pr_ready');
  });

  it('merge の結果を読んだ PR が結果不明でも、落ちた送信（sending）も照合へ進む', async () => {
    const c = await prReady();
    await query(
      `insert into release (job_id, repo, pr_number, head_sha, merge_state, merge_sending_at, created_at, updated_at)
       values ($1,$2,$3,$4,'sending',$5,$5,$5)`,
      [c.jobId, FAKE_REPO, c.github.pull.number, c.headSha, h.clock()],
    );
    // 新しい sending は別の押下が動いている
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps)).rejects.toMatchObject({
      code: 'ERR-301',
    });
    h.advance(180_000);
    c.github.pull = { ...c.github.pull, merged: true, state: 'closed', mergeSha: MERGE_SHA(1) };
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(c.github.calls).toEqual([]);
    expect((await h.view(c.jobId)).state).toBe('merged');
  });

  it('二重押下（同時）でも merge は1回。押し直しは同じ結果を返す', async () => {
    const c = await prReady();
    let open = (): void => undefined;
    c.github.gate = new Promise((r) => {
      open = r;
    });
    const first = approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'a', c.deps);
    await vi.waitFor(() => expect(c.github.calls).toHaveLength(1));
    await expect(approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'b', c.deps)).rejects.toMatchObject({
      code: 'ERR-301',
    });
    open();
    await first;
    const again = await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(again).toMatchObject({ alreadyDone: true, mergeState: 'merged' });
    expect(c.github.calls).toHaveLength(1);
    expect(await h.count(`from release_approval where job_id=$1 and kind='merge'`, [c.jobId])).toBe(1);
  });

  it('merge 後の tree が検査した head と違えば配備へ進めない', async () => {
    const c = await prReady();
    c.github.trees[MERGE_SHA(1)] = 'b'.repeat(40);
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(await release(c.jobId)).toMatchObject({ tree_match: false });
    expect(await attempts(c.jobId)).toEqual([]);
    await expect(
      approveDeploy(
        { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
        approver(),
        'c',
        h.clock(),
      ),
    ).rejects.toMatchObject({ details: { refusal: 'tree_mismatch' } });
    expect(await devlineSummary()).toMatchObject({ stopped: 1 });
  });

  it('tree を読めなければ判定を保留し、押し直しで読み直す', async () => {
    const c = await prReady();
    const trees = c.github.trees;
    c.github.trees = {};
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(await release(c.jobId)).toMatchObject({ tree_match: null });
    expect(await attempts(c.jobId)).toEqual([]);
    c.github.trees = trees;
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(await release(c.jobId)).toMatchObject({ tree_match: true });
    expect(await attempts(c.jobId)).toHaveLength(1);
  });
});

describe('承認前は動かない（TC-N09）', () => {
  it('merge だけでは配備されない。成果物の作成だけが動き、配備の承認があるまで配備先に触らない', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'build', state: 'succeeded' });
    // 一時コンテナは配備先の名前を使わず、終わったら消す
    expect(docker.runs).toHaveLength(1);
    expect(docker.runs[0]).toMatchObject({ port: 40002, version: MERGE_SHA(1), digest: digestOf(1) });
    expect(docker.runs[0]?.name).not.toBe('msf-sandbox-verify');
    expect(docker.containers.size).toBe(0);
    expect(await runDeployOnce(workerOf(docker, okProbe))).toEqual({ kind: 'idle' });
    expect((await h.view(c.jobId)).state).toBe('merged');
  });

  it('pr_ready では配備も戻しも拒否する', async () => {
    const c = await prReady();
    await expect(
      approveDeploy(
        { jobId: c.jobId, sha: c.headSha, digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
        approver(),
        'c',
        h.clock(),
      ),
    ).rejects.toMatchObject({ code: 'ERR-201', details: { refusal: 'state' } });
    await expect(rollbackRelease({ jobId: c.jobId, reason: '戻す' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'state' },
    });
    expect(
      await h.count(`from audit_log where action='job.deploy_approve' and result='denied' and target_id=$1`, [c.jobId]),
    ).toBe(1);
  });

  it('digest・SHA・環境・役割が違えば配備を拒否する（試行を作らない）', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    await runDeployOnce(workerOf(docker, okProbe));
    const good = { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT };
    const before = (await attempts(c.jobId)).length;
    await expect(approveDeploy({ ...good, digest: digestOf(2) }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'digest_mismatch' },
    });
    await expect(approveDeploy({ ...good, sha: c.headSha }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'sha_mismatch' },
    });
    await expect(approveDeploy({ ...good, environment: 'other' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'environment_mismatch' },
    });
    await expect(approveDeploy(good, h.actor('desk', true), 'c', h.clock())).rejects.toMatchObject({ code: 'ERR-101' });
    await query('update app_user set is_agent=true where id=$1', [h.auth.user.id]);
    await expect(approveDeploy(good, approver(), 'c', h.clock())).rejects.toMatchObject({ details: { refusal: 'agent_actor' } });
    await query('update app_user set is_agent=false where id=$1', [h.auth.user.id]);
    expect((await attempts(c.jobId)).length).toBe(before);
    await h.reapprove(c.id, '版を上げた（作り物）');
    await expect(approveDeploy(good, approver(), 'c', h.clock())).rejects.toMatchObject({ code: 'ERR-202' });
  });

  it('配備の承認の後で版が上がると、worker は配備しない', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    await runDeployOnce(workerOf(docker, okProbe));
    await approveDeploy(
      { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
      approver(),
      'c',
      h.clock(),
    );
    await h.reapprove(c.id, '版を上げた（作り物）');
    const runs = docker.runs.length;
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ state: 'failed', errorCode: 'approval_expired' });
    expect(docker.runs.length).toBe(runs);
    expect((await h.view(c.jobId)).state).toBe('merged');
  });
});

describe('成果物と配備', () => {
  it('承認された digest をそのまま起動する（作り直さない）。staged へ進み、二重押下は同じ結果', async () => {
    const docker = stubDocker();
    const c = await toStaged(1, docker);
    expect(docker.builds).toBe(1);
    expect(docker.containers.get('msf-sandbox-verify')).toMatchObject({
      digest: digestOf(1),
      port: 40001,
      version: MERGE_SHA(1),
    });
    expect(await release(c.jobId)).toMatchObject({
      image_digest: digestOf(1),
      deploy_approved_sha: MERGE_SHA(1),
      deploy_approved_digest: digestOf(1),
      environment: DEPLOY_ENVIRONMENT,
      health: true,
      smoke: true,
      url: 'http://127.0.0.1:40001',
      current_digest: digestOf(1),
      previous_digest: null,
    });
    const again = await approveDeploy(
      { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
      approver(),
      'c',
      h.clock(),
    );
    expect(again.alreadyDone).toBe(true);
    expect(await runDeployOnce(workerOf(docker, okProbe))).toEqual({ kind: 'idle' });
    // released と closed へは進まない
    expect((await h.view(c.jobId)).state).toBe('staged');
  });

  it('配備待ちの間の二度目の承認は拒否する', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    await runDeployOnce(workerOf(docker, okProbe));
    const body = { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT };
    await approveDeploy(body, approver(), 'c', h.clock());
    await expect(approveDeploy(body, approver(), 'c', h.clock())).rejects.toMatchObject({ code: 'ERR-301' });
    expect(await h.count(`from release_approval where job_id=$1 and kind='deploy'`, [c.jobId])).toBe(1);
  });

  it('一時コンテナの確認に落ちた成果物は配備の承認の対象にならない', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    expect(await runDeployOnce(workerOf(docker, badProbe))).toMatchObject({
      state: 'failed',
      errorCode: 'artifact_check_failed',
    });
    expect(docker.containers.size).toBe(0);
    expect(await release(c.jobId)).toMatchObject({ image_digest: null });
    await expect(
      approveDeploy(
        { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
        approver(),
        'c',
        h.clock(),
      ),
    ).rejects.toMatchObject({ details: { refusal: 'no_artifact' } });
    expect(await devlineSummary()).toMatchObject({ stopped: 1 });
  });

  it('build の失敗を記録する。承認者の押し直しで作り直す（merge は送らない）', async () => {
    const docker = stubDocker();
    docker.buildFails = true;
    const c = await toMerged();
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ state: 'failed', errorCode: 'build_failed' });
    expect(await runDeployOnce(workerOf(docker, okProbe))).toEqual({ kind: 'idle' });
    docker.buildFails = false;
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(c.github.calls).toHaveLength(1);
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'build', state: 'succeeded' });
    expect(await release(c.jobId)).toMatchObject({ image_digest: digestOf(1) });
    // digest が決まった後は作らない
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(await runDeployOnce(workerOf(docker, okProbe))).toEqual({ kind: 'idle' });
  });

  it('ポートが使用中なら失敗し、何も動かさない', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    await runDeployOnce(workerOf(docker, okProbe));
    await approveDeploy(
      { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
      approver(),
      'c',
      h.clock(),
    );
    docker.portBusy = true;
    const runs = docker.runs.length;
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ state: 'failed', errorCode: 'port_in_use' });
    expect(docker.runs.length).toBe(runs);
    expect((await h.view(c.jobId)).state).toBe('merged');
  });

  it('配備の health が落ちると前の digest へ自動で戻し、失敗として記録する。job は merged のまま', async () => {
    const docker = stubDocker();
    await toStaged(1, docker);
    docker.nextDigest = digestOf(2);
    const c = await toMerged(2);
    await runDeployOnce(workerOf(docker, okProbe));
    await approveDeploy(
      { jobId: c.jobId, sha: MERGE_SHA(2), digest: digestOf(2), environment: DEPLOY_ENVIRONMENT },
      approver(),
      'c',
      h.clock(),
    );
    const failFirst: DeployProbe = { check: async (_p, sha) => ({ health: sha !== MERGE_SHA(2), smoke: sha !== MERGE_SHA(2) }) };
    expect(await runDeployOnce(workerOf(docker, failFirst))).toMatchObject({ state: 'failed', errorCode: 'health_failed' });
    expect((await h.view(c.jobId)).state).toBe('merged');
    expect(docker.containers.get('msf-sandbox-verify')).toMatchObject({ digest: digestOf(1), version: MERGE_SHA(1) });
    const last = (await attempts(c.jobId)).at(-1);
    expect(last).toMatchObject({
      state: 'failed',
      auto_rollback: 'restored',
      deployed_digest: digestOf(1),
      previous_digest: digestOf(1),
    });
    const ev = await listReleaseEvidence(c.id);
    expect(ev[c.jobId]).toMatchObject({ environmentDigest: digestOf(1) });
    expect(await devlineSummary()).toMatchObject({ stopped: 1 });
  });

  it('前の版がないときの失敗は、失敗したコンテナを消すだけ', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    await runDeployOnce(workerOf(docker, okProbe));
    await approveDeploy(
      { jobId: c.jobId, sha: MERGE_SHA(1), digest: digestOf(1), environment: DEPLOY_ENVIRONMENT },
      approver(),
      'c',
      h.clock(),
    );
    expect(await runDeployOnce(workerOf(docker, badProbe))).toMatchObject({ state: 'failed' });
    expect(docker.containers.size).toBe(0);
    expect((await attempts(c.jobId)).at(-1)).toMatchObject({ auto_rollback: 'nothing_to_restore', deployed_digest: null });
  });

  it('worker が落ちて lease が切れた試行は取り直す', async () => {
    const docker = stubDocker();
    const c = await toMerged();
    const row = (await attempts(c.jobId))[0];
    await query(`update release_attempt set state='running', lease_owner='dead', lease_expires_at=$2, attempts=1 where id=$1`, [
      row.id,
      new Date(h.clock().getTime() - 1000),
    ]);
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'build', state: 'succeeded' });
    await query(
      `insert into release_attempt (release_id, job_id, kind, environment, sha, state, lease_owner, lease_expires_at, attempts, created_at, started_at)
       values ($1,$2,'build',$3,$4,'running','dead',$5,3,$5,$5)`,
      [row.release_id, c.jobId, DEPLOY_ENVIRONMENT, MERGE_SHA(1), new Date(h.clock().getTime() - 1000)],
    );
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ state: 'failed', errorCode: 'too_many_attempts' });
  });
});

describe('戻し（FR-41）', () => {
  it('人の操作で前の digest へ戻す。job は staged のまま。理由が必須で、二度は戻せない', async () => {
    const docker = stubDocker();
    await toStaged(1, docker);
    const c = await toStaged(2, docker);
    expect(await release(c.jobId)).toMatchObject({ previous_digest: digestOf(1), previous_sha: MERGE_SHA(1) });

    await expect(rollbackRelease({ jobId: c.jobId, reason: '  ' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      code: 'ERR-102',
    });
    await expect(
      rollbackRelease({ jobId: c.jobId, reason: '戻す' }, h.actor('desk', true), 'c', h.clock()),
    ).rejects.toMatchObject({
      code: 'ERR-101',
    });
    await rollbackRelease({ jobId: c.jobId, reason: '不具合を見つけた（作り物）' }, approver(), 'c', h.clock());
    await expect(rollbackRelease({ jobId: c.jobId, reason: '再度' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      code: 'ERR-301',
    });
    expect(await runDeployOnce(workerOf(docker, okProbe))).toMatchObject({ attemptKind: 'rollback', state: 'succeeded' });
    expect(docker.containers.get('msf-sandbox-verify')).toMatchObject({ digest: digestOf(1), version: MERGE_SHA(1) });
    expect((await h.view(c.jobId)).state).toBe('staged');
    expect(await release(c.jobId)).toMatchObject({ current_digest: digestOf(1) });
    expect((await release(c.jobId)).rolled_back_at).not.toBeNull();
    await expect(rollbackRelease({ jobId: c.jobId, reason: '再度' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'not_current' },
    });
    expect(await h.count(`from audit_log where action='job.rollback' and result='success' and target_id=$1`, [c.jobId])).toBe(1);
  });

  it('戻す先がなければ拒否する', async () => {
    const docker = stubDocker();
    const c = await toStaged(1, docker);
    await expect(rollbackRelease({ jobId: c.jobId, reason: '戻す' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'nothing_to_restore' },
    });
  });

  it('別の job の版が載っていれば古い job からは戻せない', async () => {
    const docker = stubDocker();
    const first = await toStaged(1, docker);
    await toStaged(2, docker);
    await expect(rollbackRelease({ jobId: first.jobId, reason: '戻す' }, approver(), 'c', h.clock())).rejects.toMatchObject({
      details: { refusal: 'not_current' },
    });
  });

  it('戻し先が動かなければ戻す前の版へ戻し、失敗として記録する', async () => {
    const docker = stubDocker();
    await toStaged(1, docker);
    const c = await toStaged(2, docker);
    await rollbackRelease({ jobId: c.jobId, reason: '戻す（作り物）' }, approver(), 'c', h.clock());
    const failOld: DeployProbe = { check: async (_p, sha) => ({ health: sha !== MERGE_SHA(1), smoke: sha !== MERGE_SHA(1) }) };
    expect(await runDeployOnce(workerOf(docker, failOld))).toMatchObject({ state: 'failed', errorCode: 'rollback_failed' });
    expect(docker.containers.get('msf-sandbox-verify')).toMatchObject({ digest: digestOf(2) });
    expect((await attempts(c.jobId)).at(-1)).toMatchObject({ auto_rollback: 'restored', deployed_digest: digestOf(2) });
  });
});

describe('ソースの取り出し（ローカルの git）', () => {
  it('merge の SHA だけを取り出し、.git を残さない。無い SHA は失敗する。トークンはエラーに載らない', async () => {
    const gh = await startRealGithub();
    try {
      const source = createDeploySource({ gitBaseUrl: gh.gitBaseUrl, token: DUMMY_GH_TOKEN, nodeEnv: 'test' });
      const got = await source.fetch({ repo: REAL_REPO, sha: gh.baseSha });
      expect(existsSync(join(got.dir, '.git'))).toBe(false);
      expect(readdirSync(got.dir)).toContain('package.json');
      got.cleanup();
      expect(existsSync(got.dir)).toBe(false);
      const err = await source.fetch({ repo: REAL_REPO, sha: 'f'.repeat(40) }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(String(err?.message)).not.toContain(DUMMY_GH_TOKEN);
      await expect(source.fetch({ repo: '../evil', sha: gh.baseSha })).rejects.toThrow();
      expect(() => createDeploySource({ gitBaseUrl: 'https://github.com', token: 'x', nodeEnv: 'test' })).toThrow();
    } finally {
      await gh.close();
    }
  });
});

describe('API', () => {
  it('CSRF を通し、ブラウザから repo・ポートを受けない。資格情報が無ければ未接続（fake 成功にしない）', async () => {
    const c = await prReady();
    await h.setRole('approver');
    const noCsrf = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${c.jobId}/approve-merge`,
      headers: { cookie: h.auth.cookie, 'content-type': 'application/json' },
      payload: { headSha: c.headSha },
    });
    expect(noCsrf.statusCode).toBe(403);
    const extra = await h.api('POST', `/api/jobs/${c.jobId}/approve-merge`, { headSha: c.headSha, repo: 'evil/repo' });
    expect(extra.statusCode).toBe(400);
    const deployExtra = await h.api('POST', `/api/jobs/${c.jobId}/approve-deploy`, {
      sha: c.headSha,
      digest: digestOf(1),
      environment: DEPLOY_ENVIRONMENT,
      port: 1234,
    });
    expect(deployExtra.statusCode).toBe(400);
    const missing = await h.api('POST', `/api/jobs/${c.jobId}/approve-merge`, { headSha: c.headSha });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe('ERR-405');
    expect(await release(c.jobId)).toBeUndefined();
    await h.setRole('desk');
    const denied = await h.api('POST', `/api/jobs/${c.jobId}/approve-merge`, { headSha: c.headSha });
    expect(denied.statusCode).toBe(403);
  });

  it('証跡と集計。トークンも内部の語も返さない', async () => {
    const docker = stubDocker();
    const c = await prReady();
    expect(await devlineSummary()).toEqual({ stopped: 0, mergeWaiting: 1 });
    await approveMerge({ jobId: c.jobId, headSha: c.headSha }, approver(), 'c', c.deps);
    expect(await devlineSummary()).toEqual({ stopped: 0, mergeWaiting: 0 });
    await runDeployOnce(workerOf(docker, okProbe));
    const res = await h.api('GET', `/api/requests/${c.id}/jobs`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ev = body.release[c.jobId];
    expect(ev).toMatchObject({
      prNumber: c.github.pull.number,
      mergeState: 'merged',
      mergeSha: MERGE_SHA(1),
      imageDigest: digestOf(1),
      environment: DEPLOY_ENVIRONMENT,
      acVerdict: 'passed',
    });
    expect(ev.approvals[0]).toMatchObject({ kind: 'merge', sha: c.headSha });
    expect(ev.ac.length).toBeGreaterThan(0);
    expect(res.body).not.toMatch(/authorization|Bearer|token/i);
    const summary = await h.api('GET', '/api/devline/summary');
    expect(summary.json()).toEqual({ stopped: 0, mergeWaiting: 0 });
  });

  it('承認の記録は追記のみ。試行の行は消せない', async () => {
    const c = await toMerged();
    await expect(query(`update release_approval set sha=$1 where job_id=$2`, ['0'.repeat(40), c.jobId])).rejects.toThrow(
      /append only/,
    );
    await expect(query(`delete from release_approval where job_id=$1`, [c.jobId])).rejects.toThrow(/append only/);
    await expect(query(`delete from release_attempt where job_id=$1`, [c.jobId])).rejects.toThrow(/never deleted/);
  });
});
