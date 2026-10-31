/**
 * QA: 検証証跡（T-71〜T-80, T-94）。到着順と run_sequence を入れ替え、1件の in-process 配信で判定する。
 */
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/api/audit.js';
import { config } from '../../src/api/config.js';
import { query } from '../../src/api/db.js';
import { cancelJob, recordVerification, resumeJob } from '../../src/api/devline-service.js';
import { buildFakeVerification } from '../../src/worker/fake-ci.js';
import { runOnce, runUntilIdle } from '../../src/worker/loop.js';
import { stages, scriptedRunner, useHarness, withDbFault } from './devline-qa-harness.js';

const h = useHarness();
const OTHER_SHA = 'e'.repeat(40);
const actor = () => h.actor('desk');

async function verifying() {
  const id = await h.approvedRequest();
  return { id, ...(await h.untilVerifying(id)) };
}

async function prBody(jobId: string): Promise<string> {
  return (await query<any>(`select content from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).rows[0]
    ?.content;
}

describe('T-71: 合格', () => {
  it('全段階 passed の最新 run で pr_ready、fence +1、lease を外し、PR 候補が同じトランザクションで1件できる', async () => {
    const { jobId, headSha } = await verifying();
    const before = await h.jobRow(jobId);
    const result = await recordVerification(h.delivery(jobId, headSha));
    expect(result).toMatchObject({ status: 'recorded', advanced: true, jobState: 'pr_ready', verdict: { verdict: 'passed' } });
    const row = await h.jobRow(jobId);
    expect(row).toMatchObject({ state: 'pr_ready', lease_owner: null, fencing_token: before.fencing_token + 1 });
    expect(await h.count(`from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).toBe(1);
  });

  it('記録と状態の変更は1つのトランザクション: PR 候補の作成が失敗したら記録も状態も残らない', async () => {
    const { jobId, headSha } = await verifying();
    await withDbFault({ table: 'job_artifact', when: 'insert' }, async () => {
      await expect(recordVerification(h.delivery(jobId, headSha))).rejects.toThrow();
    });
    expect((await h.view(jobId)).state).toBe('verifying');
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
    expect((await verifyAuditChain()).ok).toBe(true);
    // 同じ配信をやり直せる
    expect((await recordVerification(h.delivery(jobId, headSha))).jobState).toBe('pr_ready');
  });
});

describe('T-72: 走り切っていない結果', () => {
  it.each([
    ['missing', { e2e: 'missing' }],
    ['skipped', { security: 'skipped' }],
    ['cancelled', { unit: 'cancelled' }],
    [
      '全部 missing',
      { static: 'missing', build: 'missing', unit: 'missing', integration: 'missing', e2e: 'missing', security: 'missing' },
    ],
  ] as const)('%s は incomplete で pr_ready にならず、修正回数を使わない', async (_label, over) => {
    const { jobId, headSha } = await verifying();
    const result = await recordVerification(h.delivery(jobId, headSha, { stages: stages(over as never) }));
    expect(result.verdict.verdict).toBe('incomplete');
    expect(result.jobState).toBe('verifying');
    expect(await h.view(jobId)).toMatchObject({ state: 'verifying', repairCountTotal: 0, ciRerunCount: 1 });
    expect(await h.count(`from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).toBe(0);
  });

  it('未知の status や空の段階を passed に数えない', async () => {
    const { jobId, headSha } = await verifying();
    const weird = stages().map((s) => (s.stage === 'unit' ? { ...s, status: 'PASSED' as never } : s));
    expect((await recordVerification(h.delivery(jobId, headSha, { stages: weird }))).verdict.verdict).toBe('incomplete');
    const empty = await recordVerification(h.delivery(jobId, headSha, { runSequence: 2, stages: [] }));
    expect(empty.verdict.verdict).toBe('incomplete');
    expect((await h.view(jobId)).state).toBe('verifying');
  });

  it('同じ段階が passed と skipped の両方なら悪い方（合格にしない）', async () => {
    const { jobId, headSha } = await verifying();
    const dup = [...stages(), { stage: 'e2e', status: 'skipped' as const }];
    expect((await recordVerification(h.delivery(jobId, headSha, { stages: dup }))).verdict.verdict).toBe('incomplete');
  });

  it('再実行2回の後の3回目で ci_rerun_limit（worker 経由で決定的な配信 ID のまま）', async () => {
    const id = await h.approvedRequest();
    const { jobId } = await h.untilVerifying(id);
    const options = h.worker('success', {
      ci: (job, ctx) => ({
        ...buildFakeVerification(
          {
            jobId: job.id,
            headSha: job.head_sha as string,
            repairCountTotal: job.repair_count_total,
            ciRerunCount: job.ci_rerun_count,
          },
          'success',
          ctx.acIds,
          ctx,
        ),
        stages: stages({ e2e: 'skipped' }),
      }),
    });
    await runUntilIdle(options);
    expect(await h.view(jobId)).toMatchObject({
      state: 'stopped',
      stopReason: 'ci_rerun_limit',
      ciRerunCount: 2,
      repairCountTotal: 0,
    });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(3);
    expect((await h.jobRow(jobId)).lease_reclaim_count).toBe(0);
  });

  it('CI 再実行の上限はコミットごと: 修正で新しい SHA になると 0 に戻る', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { stages: stages({ e2e: 'skipped' }) }));
    expect((await h.view(jobId)).ciRerunCount).toBe(1);
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 2, stages: stages({ unit: 'failed' }, ['t1']) }));
    expect((await h.view(jobId)).state).toBe('revising');
    await runOnce(h.worker('success', { ci: () => null }));
    const job = await h.view(jobId);
    expect(job).toMatchObject({ state: 'verifying', ciRerunCount: 0 });
    expect(job.headSha).not.toBe(headSha);
  });
});

describe('T-73: 別 SHA と stale', () => {
  it('別 SHA の成功は記録されるが pr_ready にならず、別 SHA の失敗は修正回数を使わない', async () => {
    const { jobId, headSha } = await verifying();
    const pass = await recordVerification(h.delivery(jobId, OTHER_SHA, { runSequence: 99 }));
    expect(pass).toMatchObject({ status: 'recorded', advanced: false, jobState: 'verifying', verdict: { verdict: 'stale' } });
    const fail = await recordVerification(
      h.delivery(jobId, OTHER_SHA, { runSequence: 100, stages: stages({ unit: 'failed' }, ['t']) }),
    );
    expect(fail).toMatchObject({ advanced: false, jobState: 'verifying' });
    expect(await h.view(jobId)).toMatchObject({ state: 'verifying', repairCountTotal: 0, ciRerunCount: 0, headSha });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(2);
    // 本物の SHA の結果が来れば、大きな run_sequence の別 SHA に関係なく決まる
    expect((await recordVerification(h.delivery(jobId, headSha, { runSequence: 1 }))).jobState).toBe('pr_ready');
  });

  it('修正後は前の SHA の成功が届いても合格にならない', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 1, stages: stages({ unit: 'failed' }, ['t']) }));
    await runOnce(h.worker('success', { ci: () => null }));
    const late = await recordVerification(h.delivery(jobId, headSha, { runSequence: 50 }));
    expect(late).toMatchObject({ status: 'recorded', advanced: false, jobState: 'verifying' });
    expect(late.verdict.verdict).toBe('stale');
  });

  it('形の違う SHA は DB に入れない', async () => {
    const { jobId } = await verifying();
    await expect(recordVerification(h.delivery(jobId, 'ABC'))).rejects.toMatchObject({ statusCode: 400 });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
  });
});

describe('T-74・T-94: 配信の重複', () => {
  it('T-74: delivery_id の重複は無視。内容が違っても上書きせず、監査も増えない', async () => {
    const { jobId, headSha } = await verifying();
    const fail = h.delivery(jobId, headSha, { deliveryId: 'dup-1', ciRunId: 'run-a', stages: stages({ unit: 'failed' }, ['t']) });
    expect((await recordVerification(fail)).jobState).toBe('revising');
    const audits = await h.count('from audit_log');
    const row = (await query<any>(`select * from verification where delivery_id='dup-1'`)).rows[0];
    const second = await recordVerification(h.delivery(jobId, headSha, { deliveryId: 'dup-1', ciRunId: 'run-b' }));
    expect(second).toMatchObject({ status: 'duplicate', advanced: false, jobState: 'revising' });
    expect((await query<any>(`select * from verification where delivery_id='dup-1'`)).rows[0]).toEqual(row);
    expect(await h.count('from audit_log')).toBe(audits);
    expect((await h.view(jobId)).repairCountTotal).toBe(1);
  });

  it('T-74: delivery_id が違っても同じ run と attempt は重複。attempt が違えば別の記録', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(
      h.delivery(jobId, headSha, { deliveryId: 'x1', ciRunId: 'run', stages: stages({ e2e: 'skipped' }) }),
    );
    const dup = await recordVerification(h.delivery(jobId, headSha, { deliveryId: 'x2', ciRunId: 'run' }));
    expect(dup.status).toBe('duplicate');
    expect((await h.view(jobId)).state).toBe('verifying');
    const retry = await recordVerification(h.delivery(jobId, headSha, { deliveryId: 'x3', ciRunId: 'run', runAttempt: 2 }));
    expect(retry).toMatchObject({ status: 'recorded', jobState: 'pr_ready' });
  });

  it('T-74: 同じ配信を並行で5回送っても記録は1件、修正回数は1', async () => {
    const { jobId, headSha } = await verifying();
    const delivery = h.delivery(jobId, headSha, { stages: stages({ unit: 'failed' }, ['t']) });
    const results = await Promise.all(Array.from({ length: 5 }, () => recordVerification(delivery)));
    expect(results.filter((r) => r.status === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(4);
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(1);
    expect(await h.view(jobId)).toMatchObject({ state: 'revising', repairCountTotal: 1 });
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('T-94: worker が verifying で落ちて取り直しても検証結果は1件で、修正回数も増えない', async () => {
    const id = await h.approvedRequest();
    const { jobId } = await h.untilVerifying(id);
    await expect(
      runOnce(
        h.worker('same_cause_fail', {
          leaseSeconds: 60,
          ci: () => {
            throw new Error('worker が落ちた');
          },
        }),
      ),
    ).rejects.toThrow();
    expect((await h.view(jobId)).leaseHeld).toBe(true);
    expect((await runOnce(h.worker('same_cause_fail'))).kind).toBe('idle');
    h.advance(61_000);
    await runOnce(h.worker('same_cause_fail'));
    expect(await h.view(jobId)).toMatchObject({ state: 'revising', repairCountTotal: 1 });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(1);
  });

  it('T-94: 記録の後に落ちて同じ配信がもう一度来ても、状態も回数も動かない', async () => {
    const { jobId, headSha } = await verifying();
    const job = await h.jobRow(jobId);
    const delivery = buildFakeVerification(
      { jobId, headSha, repairCountTotal: job.repair_count_total, ciRerunCount: job.ci_rerun_count },
      'same_cause_fail',
      ['AC-1', 'AC-2'],
      { now: h.clock(), correlationId: 'c' },
    );
    expect((await recordVerification(delivery)).status).toBe('recorded');
    expect((await recordVerification(delivery)).status).toBe('duplicate');
    expect(await h.view(jobId)).toMatchObject({ state: 'revising', repairCountTotal: 1 });
  });
});

describe('T-75・T-76: 順不同と寄せ集め', () => {
  it('T-75: 新しい失敗の後に古い成功が届いても上書きしない', async () => {
    const { jobId, headSha } = await verifying();
    const fail = await recordVerification(
      h.delivery(jobId, headSha, { runSequence: 5, stages: stages({ unit: 'failed' }, ['t']) }),
    );
    expect(fail.jobState).toBe('revising');
    const old = await recordVerification(h.delivery(jobId, headSha, { runSequence: 4 }));
    expect(old).toMatchObject({ status: 'recorded', advanced: false, jobState: 'revising', verdict: { verdict: 'failed' } });
    expect(await h.view(jobId)).toMatchObject({ state: 'revising', repairCountTotal: 1 });
  });

  it('T-75: 新しい未完了の後に古い成功が届いても合格にならない', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 5, stages: stages({ e2e: 'cancelled' }) }));
    const old = await recordVerification(h.delivery(jobId, headSha, { runSequence: 3 }));
    expect(old.verdict.verdict).toBe('incomplete');
    expect((await h.view(jobId)).state).toBe('verifying');
  });

  it('T-75: 順不同で届いた古い配信は CI の再実行に数えない（新しい配信だけが回数を使う）', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 5, stages: stages({ e2e: 'cancelled' }) }));
    expect((await h.view(jobId)).ciRerunCount).toBe(1);
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 3 }));
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 2 }));
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 1 }));
    const job = await h.view(jobId);
    expect(job.state).toBe('verifying');
    expect(job.ciRerunCount).toBe(1);
  });

  it('T-75: 同じ run の attempt は大きい方を見る（attempt 2 の失敗の後に attempt 1 の成功）', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(
      h.delivery(jobId, headSha, { ciRunId: 'r', runAttempt: 2, stages: stages({ unit: 'failed' }, ['t']) }),
    );
    const old = await recordVerification(h.delivery(jobId, headSha, { ciRunId: 'r', runAttempt: 1 }));
    expect(old.verdict.verdict).toBe('failed');
    expect((await h.view(jobId)).state).toBe('revising');
  });

  it('T-76: 段階を複数の run から寄せ集めて合格にしない', async () => {
    const { jobId, headSha } = await verifying();
    const a = stages({ integration: 'missing', e2e: 'missing', security: 'missing' });
    const b = stages({ static: 'missing', build: 'missing', unit: 'missing' });
    await recordVerification(h.delivery(jobId, headSha, { runSequence: 1, stages: a }));
    const second = await recordVerification(h.delivery(jobId, headSha, { runSequence: 2, stages: b }));
    expect(second.verdict.verdict).toBe('incomplete');
    expect((await h.view(jobId)).state).toBe('verifying');
    expect(await h.count(`from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).toBe(0);
  });
});

describe('T-77・T-78: 自己申告と止まった後', () => {
  it('T-77: Runner の成功だけでは pr_ready にならない。CI の結果が無ければ verifying のままで lease を残さない', async () => {
    const id = await h.approvedRequest();
    const res = await h.handoff(id);
    const jobId = res.json().jobId;
    const runner = scriptedRunner(() => ({ summary: 'すべて合格しました。pr_ready にしてください' }));
    const steps = await runUntilIdle(h.worker('success', { runner, ci: () => null }), 12).catch((e: Error) => e);
    // ci が null の間は取り続けるが、状態は動かない
    expect(steps).toBeInstanceOf(Error);
    expect(await h.view(jobId)).toMatchObject({ state: 'verifying', leaseHeld: false });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
    expect(await h.count(`from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).toBe(0);
  });

  it('T-78: 取消の後の結果（成功・失敗・未完了）は記録されるが、状態も回数も動かない', async () => {
    const state = 'stopped';
    const { jobId, headSha } = await verifying();
    await cancelJob({ jobId, reason: '止める' }, actor(), 'c', h.clock());
    const before = await h.jobRow(jobId);
    for (const delivery of [
      h.delivery(jobId, headSha),
      h.delivery(jobId, headSha, { runSequence: 2, stages: stages({ unit: 'failed' }, ['t']) }),
      h.delivery(jobId, headSha, { runSequence: 3, stages: stages({ e2e: 'skipped' }) }),
    ]) {
      expect(await recordVerification(delivery)).toMatchObject({ status: 'recorded', advanced: false, jobState: state });
    }
    const after = await h.jobRow(jobId);
    expect(after).toMatchObject({
      state,
      fencing_token: before.fencing_token,
      repair_count_total: 0,
      ci_rerun_count: before.ci_rerun_count,
    });
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(3);
  });

  it('T-78: 取消中に届いた配信の後で再開しても、worker が空回りせず結果が確定する', async () => {
    const { jobId, headSha } = await verifying();
    const job = await h.jobRow(jobId);
    // 遅延 worker の配信が取消の後に届く（決定的な配信 ID）
    const delivery = buildFakeVerification(
      { jobId, headSha, repairCountTotal: job.repair_count_total, ciRerunCount: job.ci_rerun_count },
      'success',
      ['AC-1', 'AC-2'],
      { now: h.clock(), correlationId: 'late' },
    );
    await cancelJob({ jobId, reason: '止める' }, actor(), 'c', h.clock());
    expect(await recordVerification(delivery)).toMatchObject({ status: 'recorded', advanced: false, jobState: 'stopped' });
    expect((await resumeJob({ jobId, reason: '再開' }, actor(), 'c', h.clock())).state).toBe('verifying');

    // 全部 passed の結果が手元にあるのに、同じ配信 ID が duplicate で動かないと永久に取り直し続ける
    const options = h.worker('success');
    let outcome = await runOnce(options);
    for (let i = 0; i < 5 && outcome.kind !== 'idle'; i += 1) outcome = await runOnce(options);
    expect((await h.view(jobId)).state).toBe('pr_ready');
    expect(outcome.kind).toBe('idle');
  });

  it('T-78: pr_ready の後の失敗で戻らない', async () => {
    const b = await verifying();
    await recordVerification(h.delivery(b.jobId, b.headSha, { runSequence: 1 }));
    const late = await recordVerification(
      h.delivery(b.jobId, b.headSha, { runSequence: 2, stages: stages({ unit: 'failed' }, ['t']) }),
    );
    expect(late).toMatchObject({ status: 'recorded', advanced: false, jobState: 'pr_ready' });
    expect(await h.view(b.jobId)).toMatchObject({ state: 'pr_ready', repairCountTotal: 0 });
  });

  it('T-78: 依頼が無効になった後の結果は記録されるが状態が動かない', async () => {
    const a = await verifying();
    await h.transition(a.id, { to: 'cancel', reason: '取り消す' });
    expect(await recordVerification(h.delivery(a.jobId, a.headSha))).toMatchObject({
      status: 'recorded',
      advanced: false,
      jobState: 'verifying',
    });
    expect(await h.count(`from job_artifact where job_id=$1 and kind='pr_body_draft'`, [a.jobId])).toBe(0);
  });

  it('存在しない job は ERR-104 で記録しない', async () => {
    await expect(recordVerification(h.delivery('00000000-0000-4000-8000-000000000000', 'a'.repeat(40)))).rejects.toMatchObject({
      code: 'ERR-104',
    });
  });
});

describe('T-79: AC の証跡', () => {
  it('AC → test ID → run → SHA → digest を PR 候補と行からたどれる', async () => {
    const { jobId, headSha } = await verifying();
    const digest = 'd'.repeat(64);
    await recordVerification(
      h.delivery(jobId, headSha, {
        ciRunId: 'run-trace',
        reportDigest: digest,
        logRef: 'logs/run-trace',
        acResults: [
          { acId: 'AC-1', testIds: ['tc.one'], status: 'passed' },
          { acId: 'AC-2', testIds: ['tc.two'], status: 'passed' },
        ],
      }),
    );
    const row = (await query<any>('select * from verification where job_id=$1', [jobId])).rows[0];
    expect(row).toMatchObject({ ci_run_id: 'run-trace', head_sha: headSha, report_digest: digest, log_ref: 'logs/run-trace' });
    expect(row.ac_results).toEqual([
      { acId: 'AC-1', testIds: ['tc.one'], status: 'passed' },
      { acId: 'AC-2', testIds: ['tc.two'], status: 'passed' },
    ]);
    const body = await prBody(jobId);
    const line = body.split('\n').find((l) => l.startsWith('| AC-1 ')) as string;
    expect(line).toContain('○');
    expect(line).toContain('tc.one');
    expect(line).toContain('run-trace');
    expect(line).toContain(headSha);
    expect(line).toContain(digest);
  });

  it('test ID の無い passed と報告の無い AC は「未確認」で PR 候補に残り、○ にしない', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { acResults: [{ acId: 'AC-1', testIds: [], status: 'passed' }] }));
    const body = await prBody(jobId);
    const ac1 = body.split('\n').find((l) => l.startsWith('| AC-1 ')) as string;
    const ac2 = body.split('\n').find((l) => l.startsWith('| AC-2 ')) as string;
    expect(ac1).toContain('未確認');
    expect(ac1).not.toContain('○');
    expect(ac2).toContain('未確認');
  });

  it('全段階 passed でも failed の AC は不合格で、修正へ回る', async () => {
    const { jobId, headSha } = await verifying();
    const result = await recordVerification(
      h.delivery(jobId, headSha, {
        acResults: [
          { acId: 'AC-1', testIds: ['tc.one'], status: 'failed' },
          { acId: 'AC-2', testIds: ['tc.two'], status: 'passed' },
        ],
      }),
    );
    expect(result).toMatchObject({ jobState: 'revising', verdict: { verdict: 'failed', failedTestIds: ['tc.one'] } });
    expect((await h.view(jobId)).repairCountTotal).toBe(1);
    expect((await h.jobRow(jobId)).work_state.previousFailure.failedTestIds).toEqual(['tc.one']);
  });

  it('原因のキーは CI の結果から作り、順序に左右されない（同因の判定）', async () => {
    const { jobId, headSha } = await verifying();
    await recordVerification(h.delivery(jobId, headSha, { stages: stages({ unit: 'failed' }, ['b', 'a']) }));
    const key = Object.keys((await h.view(jobId)).repairCountByCause)[0];
    await runOnce(h.worker('success', { ci: () => null }));
    const head = (await h.view(jobId)).headSha as string;
    await recordVerification(h.delivery(jobId, head, { runSequence: 2, stages: stages({ unit: 'failed' }, ['a', 'b']) }));
    expect((await h.view(jobId)).repairCountByCause).toEqual({ [key as string]: 2 });
  });
});

describe('T-80: 取り込みの入口', () => {
  it('production では fake_ci の結果を拒否し、ci は通す（設定を一時的に切り替える）', async () => {
    const { jobId, headSha } = await verifying();
    const mutable = config as { isProduction: boolean };
    mutable.isProduction = true;
    try {
      await expect(recordVerification(h.delivery(jobId, headSha))).rejects.toMatchObject({ code: 'ERR-405' });
      expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
      expect((await recordVerification(h.delivery(jobId, headSha, { source: 'ci' }))).jobState).toBe('pr_ready');
    } finally {
      mutable.isProduction = false;
    }
  });

  it('production では fake runner を動かさない（assertRunnerAllowed）', async () => {
    const mutable = config as { isProduction: boolean };
    mutable.isProduction = true;
    try {
      await expect(runOnce(h.worker('success'))).rejects.toThrow(/production/);
    } finally {
      mutable.isProduction = false;
    }
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createFakeRunner } = await import('../../src/worker/fake-runner.js');
      const { createFakeIssueAdapter } = await import('../../src/api/issue-adapter-fake.js');
      expect(() => createFakeRunner('success')).toThrow();
      expect(() => createFakeIssueAdapter()).toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('source=agent は DB で拒否される（自己申告を入れない）', async () => {
    const { jobId, headSha } = await verifying();
    await expect(recordVerification(h.delivery(jobId, headSha, { source: 'agent' as never }))).rejects.toMatchObject({
      code: '23514',
    });
    expect((await h.view(jobId)).state).toBe('verifying');
    expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
  });

  it.each(['POST', 'PUT', 'PATCH', 'GET', 'DELETE'] as const)(
    'API-07 の HTTP が無い: %s /api/jobs/:id/verifications は 404 で記録されない',
    async (method) => {
      const { jobId, headSha } = await verifying();
      const res = await h.api(
        method,
        `/api/jobs/${jobId}/verifications`,
        method === 'GET' || method === 'DELETE' ? undefined : h.delivery(jobId, headSha),
      );
      expect(res.statusCode).toBe(404);
      expect(await h.count('from verification where job_id=$1', [jobId])).toBe(0);
      expect((await h.view(jobId)).state).toBe('verifying');
    },
  );

  it('API-07 の HTTP が無い: 未ログインでも 404 で、ルートの一覧にも無い', async () => {
    const id = await h.approvedRequest();
    const { jobId } = (await h.handoff(id)).json();
    const res = await h.app.inject({ method: 'POST', url: `/api/jobs/${jobId}/verifications`, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(h.app.printRoutes()).not.toContain('verifications');
  });
});
