/**
 * 自動マージ（DEVLINE_AUTO_MERGE）の結合試験。DB と stub の merge 口だけを使う。実 GitHub へは送らない。
 * 判定条件・監査（actor=system）・失敗時の停止・worker の契機を確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { query } from '../../src/api/db.js';
import { autoMergeAfterPrReady, defaultAutoMergeDeps, type AutoMergeDeps } from '../../src/api/devline-auto-merge.js';
import { recordVerification } from '../../src/api/devline-service.js';
import type { MergeSendOutcome, PrMergeAdapter, PullMergeFacts } from '../../src/api/pr-adapter.js';
import {
  AUTO_MERGE_POLICY_VERSION,
  buildPrMarker,
  type RepoAllowEntry,
  type RepoDiffPolicy,
} from '../../src/shared/devline.js';
import { runOnce } from '../../src/worker/loop.js';
import { FAKE_REPO, FAKE_REPO_ID } from './fake-github-server.js';
import { useHarness } from './devline-qa-harness.js';

const h = useHarness();

/** 試験用の差分 policy（fake runner の変更 path を通す）。実在のリポジトリには使わない。 */
const POLICY: RepoDiffPolicy = {
  version: 'diff-policy/qa-auto-merge-v1',
  allowedPrefixes: ['src/', 'test/', 'tests/'],
  allowedExactPaths: [],
  forbidden: [],
  protectedTestPrefixes: [],
  maxFiles: 200,
};
const LEDGER: readonly RepoAllowEntry[] = [
  { name: FAKE_REPO, repoId: FAKE_REPO_ID, purpose: '自動マージの試験（作り物）', private: true },
];
const LOGIN = 'msf-auto-merge-bot';
const MERGE_SHA = 'e'.repeat(40);

interface StubMerge extends PrMergeAdapter {
  pull: PullMergeFacts;
  calls: { sha: string }[];
  trees: Record<string, string>;
  next: MergeSendOutcome;
  getBehind: number | null;
}

function stubMerge(jobId: string, headSha: string): StubMerge {
  const stub: StubMerge = {
    pull: {
      number: 777,
      url: `http://127.0.0.1:1/${FAKE_REPO}/pull/777`,
      state: 'open',
      merged: false,
      mergeSha: null,
      headSha,
      baseRef: 'main',
      authorLogin: LOGIN,
      body: `${buildPrMarker({ jobId, attemptNo: 2, headSha })}\n\n本文`,
    },
    calls: [],
    trees: { [headSha]: 'a'.repeat(40), [MERGE_SHA]: 'a'.repeat(40) },
    next: { outcome: 'merged', mergeSha: MERGE_SHA },
    getBehind: 0,
    getActorLogin: async () => ({ ok: true, value: LOGIN }),
    getDefaultBranch: async () => ({ ok: true, value: 'main' }),
    getPull: async () => ({ ok: true, value: { ...stub.pull } }),
    getCommitTree: async ({ sha }) => ({ ok: true, value: stub.trees[sha] ?? null }),
    getBehindBy: async () => (stub.getBehind === null ? { ok: false, reason: 'network' } : { ok: true, value: stub.getBehind }),
    mergePull: async ({ sha }) => {
      stub.calls.push({ sha });
      if (stub.next.outcome === 'merged') {
        stub.pull = { ...stub.pull, merged: true, state: 'closed', mergeSha: stub.next.mergeSha };
      }
      return stub.next;
    },
  };
  return stub;
}

function depsOf(stub: StubMerge, over: Partial<AutoMergeDeps> = {}): AutoMergeDeps {
  return {
    merge: stub,
    allowedRepos: [{ name: FAKE_REPO, repoId: FAKE_REPO_ID }],
    ledger: LEDGER,
    policyOf: () => POLICY,
    policy: { enabled: true, configuredValue: '1', policyVersion: AUTO_MERGE_POLICY_VERSION },
    now: h.clock,
    httpTimeoutMs: 2000,
    ...over,
  };
}

/** pr_ready まで進め、PR の記録と差分検査の証跡（diffPolicy）を載せる。 */
async function prReadyForAutoMerge(
  n = 1,
): Promise<{ id: string; jobId: string; headSha: string; stub: StubMerge }> {
  const id = await h.approvedRequest({ title: `自動マージ ${n}` });
  const { jobId, headSha } = await h.untilPrReady(id);
  const stub = stubMerge(jobId, headSha);
  await query(
    `update job set work_state = work_state || jsonb_build_object('pr', $2::jsonb, 'diffPolicy', $3::text) where id=$1`,
    [jobId, JSON.stringify({ number: stub.pull.number, url: stub.pull.url }), POLICY.version],
  );
  return { id, jobId, headSha, stub };
}

const jobRow = async (jobId: string): Promise<any> => (await query('select * from job where id=$1', [jobId])).rows[0];
const releaseRow = async (jobId: string): Promise<any> => (await query('select * from release where job_id=$1', [jobId])).rows[0];
const events = async (jobId: string): Promise<any[]> =>
  (await query('select * from job_event where job_id=$1 order by id', [jobId])).rows;
const audits = async (jobId: string, action = 'job.auto_merge'): Promise<any[]> =>
  (await query(`select * from audit_log where action=$2 and target_id=$1 order by id`, [jobId, action])).rows;

describe('既定（無効）ではマージしない', () => {
  it('DEVLINE_AUTO_MERGE 未設定なら依存を作らず、呼んでも何もしない', async () => {
    const c = await prReadyForAutoMerge();
    expect(defaultAutoMergeDeps({})).toBeNull();
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub, {
      policy: { enabled: false, configuredValue: '', policyVersion: AUTO_MERGE_POLICY_VERSION },
    }));
    expect(outcome).toEqual({ status: 'disabled' });
    expect(c.stub.calls).toEqual([]);
    expect((await jobRow(c.jobId)).state).toBe('pr_ready');
    expect(await releaseRow(c.jobId)).toBeUndefined();
    expect(await audits(c.jobId)).toEqual([]);
  });
});

describe('有効かつ条件充足で squash merge する', () => {
  it('system 主体で merge し、release と監査に根拠を残す。人の承認の行は作らない', async () => {
    const c = await prReadyForAutoMerge();
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'auto-1' }, depsOf(c.stub));
    expect(outcome).toEqual({ status: 'merged', mergeSha: MERGE_SHA, prNumber: 777 });

    expect(c.stub.calls).toEqual([{ sha: c.headSha }]);
    expect((await jobRow(c.jobId)).state).toBe('merged');

    const release = await releaseRow(c.jobId);
    expect(release).toMatchObject({
      merge_state: 'merged',
      merge_sha: MERGE_SHA,
      repo: FAKE_REPO,
      pr_number: 777,
      auto_merge: true,
      auto_merge_policy_version: AUTO_MERGE_POLICY_VERSION,
      auto_merge_verdict: 'passed',
      tree_match: true,
      merge_approver_user_id: null,
    });
    expect(release.auto_merge_ac_ids).toEqual(['AC-1', 'AC-2']);
    expect(release.auto_merge_run_id).toBeTruthy();
    // AI・自動処理は承認しない（release_approval の行を作らない）
    expect(await h.count(`from release_approval where job_id=$1`, [c.jobId])).toBe(0);

    const auto = await audits(c.jobId);
    const send = auto.find((a) => a.result === 'success');
    expect(send).toMatchObject({ role: 'system', actor_name: 'system:auto-merge' });
    expect(send.actor_user_id).toBeNull();
    expect(send.diff).toMatchObject({
      mode: 'send',
      verdict: 'passed',
      acIds: ['AC-1', 'AC-2'],
      headSha: c.headSha,
      policyVersion: AUTO_MERGE_POLICY_VERSION,
      policyValue: '1',
    });
    expect(send.diff.runId).toBeTruthy();
    const merged = (await audits(c.jobId, 'job.merged'))[0];
    expect(merged).toMatchObject({ role: 'system', actor_name: 'system:auto-merge', result: 'success' });
    expect(merged.diff).toMatchObject({ autoMerge: true, from: 'pr_ready', to: 'merged', mergeSha: MERGE_SHA });

    const transitions = (await events(c.jobId)).filter((e) => e.kind === 'transition').slice(-2);
    expect(transitions.map((e) => [e.from_state, e.to_state, e.actor_type])).toEqual([
      ['pr_ready', 'approved', 'system'],
      ['approved', 'merged', 'system'],
    ]);
    expect((await events(c.jobId)).some((e) => e.kind === 'auto_merge_started')).toBe(true);
    // merge 後の成果物の作成は従来どおり worker の工程（自動マージは配備を承認しない）
    expect((await query('select kind, state from release_attempt where job_id=$1', [c.jobId])).rows).toEqual([
      { kind: 'build', state: 'pending' },
    ]);
  });
});

describe('条件不足はマージしない（job は pr_ready のまま）', () => {
  it('PR の head が job と違えば止める（stop_detail に理由）', async () => {
    const c = await prReadyForAutoMerge();
    c.stub.pull = { ...c.stub.pull, headSha: 'f'.repeat(40) };
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub));
    expect(outcome).toMatchObject({ status: 'failed', reason: 'head_changed', stopped: true });
    expect(c.stub.calls).toEqual([]);
    const job = await jobRow(c.jobId);
    expect(job.state).toBe('stopped');
    expect(job.stop_reason).toBe('auto_merge_failed');
    expect(job.stop_detail.autoMerge).toMatchObject({ reason: 'head_changed', policyVersion: AUTO_MERGE_POLICY_VERSION });
    expect(job.resume_to).toBe('pr_ready');
    expect((await releaseRow(c.jobId)).merge_state).toBe('rejected');
  });

  it('注文書が古い（版が上がった）なら拒否し、監査に理由を残す', async () => {
    const c = await prReadyForAutoMerge();
    await h.reapprove(c.id, '自動マージ試験の版上げ');
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub));
    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status === 'refused') expect(outcome.reasons).toContain('order_not_current');
    expect(c.stub.calls).toEqual([]);
    expect((await jobRow(c.jobId)).state).toBe('pr_ready');
    const denied = (await audits(c.jobId)).find((a) => a.result === 'denied');
    expect(denied).toMatchObject({ role: 'system', actor_name: 'system:auto-merge' });
    expect(denied.diff.reasons).toContain('order_not_current');
  });

  it('受入条件が未確認なら拒否する（後から届いた未確認の記録を見る）', async () => {
    const c = await prReadyForAutoMerge();
    await recordVerification(
      h.delivery(c.jobId, c.headSha, {
        runSequence: 9,
        acResults: [],
      }),
    );
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub));
    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status === 'refused') {
      expect(outcome.reasons).toContain('verification');
      expect(outcome.reasons).toContain('ac_unconfirmed');
    }
    expect(c.stub.calls).toEqual([]);
    expect((await jobRow(c.jobId)).state).toBe('pr_ready');
  });

  it('許可台帳に無い repo は拒否する（DEVLINE_TARGET_REPOS だけでは足りない）', async () => {
    const c = await prReadyForAutoMerge();
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub, { ledger: [] }));
    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status === 'refused') expect(outcome.reasons).toContain('repo_not_in_ledger');
    expect(c.stub.calls).toEqual([]);
  });

  it('差分検査の証跡が無ければ拒否する', async () => {
    const c = await prReadyForAutoMerge();
    await query(`update job set work_state = work_state - 'diffPolicy' where id=$1`, [c.jobId]);
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub));
    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status === 'refused') expect(outcome.reasons).toContain('diff_policy_missing');
    expect(c.stub.calls).toEqual([]);
  });
});

describe('merge の実行に失敗したら job を止める', () => {
  it('GitHub が merge を拒否（競合・保護）したら auto_merge_failed で止める', async () => {
    const c = await prReadyForAutoMerge();
    c.stub.next = { outcome: 'rejected', cause: 'not_mergeable', httpStatus: 405 };
    const outcome = await autoMergeAfterPrReady({ jobId: c.jobId, correlationId: 'c' }, depsOf(c.stub));
    expect(outcome).toMatchObject({ status: 'failed', reason: 'not_mergeable', stopped: true });
    const job = await jobRow(c.jobId);
    expect(job.state).toBe('stopped');
    expect(job.stop_reason).toBe('auto_merge_failed');
    expect(job.stop_detail.autoMerge.reason).toBe('not_mergeable');
    const release = await releaseRow(c.jobId);
    expect(release.merge_state).toBe('rejected');
    expect(release.merge_detail).toBe('not_mergeable');
    const audit = (await audits(c.jobId)).find((a) => a.result === 'error');
    expect(audit).toMatchObject({ role: 'system', actor_name: 'system:auto-merge' });
    expect(audit.diff).toMatchObject({ mode: 'stopped', reason: 'not_mergeable' });
  });
});

describe('worker の契機', () => {
  it('verifying → pr_ready の直後に autoMerge を呼ぶ（無効なら渡さない）', async () => {
    const id = await h.approvedRequest({ title: '契機の試験' });
    const { jobId } = await h.untilVerifying(id);
    const autoMerge = vi.fn(async () => undefined);
    const outcome = await runOnce(h.worker('success', { autoMerge }));
    expect(outcome).toMatchObject({ kind: 'stepped', from: 'verifying', to: 'pr_ready' });
    expect(autoMerge).toHaveBeenCalledTimes(1);
    expect(autoMerge).toHaveBeenCalledWith(jobId);
  });

  it('autoMerge を渡さなければ何もしない（既定の人の承認のまま）', async () => {
    const { jobId } = await h.untilPrReady(await h.approvedRequest({ title: '契機なし' }));
    expect((await jobRow(jobId)).state).toBe('pr_ready');
    expect(await audits(jobId)).toEqual([]);
  });
});
