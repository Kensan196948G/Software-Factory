import { expect, test } from './fixtures/roles';
import { roleCanTransition } from '../../../src/shared/domain';
import { SANDBOX_REPO, autoMergeRepoFacts, decideAutoMerge, type AutoMergeFacts } from '../../../src/shared/devline';
import { createRequestViaApi, currentUser, serverRequest, transitionViaApi, uniqueTitle } from './fixtures/station';
import { recordRequest } from './fixtures/run-state';
import { errorCode } from './fixtures/devline';

/**
 * C1/C2 の回帰（修正済み）。層①（使い捨て DB）だけ。
 *
 * C1: 自動マージは青の注文書だけを対象にし、黄は人が承認する（`order_signal_not_blue`）。
 * C2: 公開承認（release_wait → done）は、指名された承認者だけができ、配備済みで健康・スモーク確認済みの
 *     成果物との紐付けを必須にする。
 */

/* ───────────────────────────── C1: 自動マージが信号の色を見ていない ───────────────────────────── */

test('C1 黄の注文書（signal=y）は自動マージの対象外', { tag: ['@iso'] }, async ({ evidence }) => {
  // 黄だけが理由になるように、自動マージの他の条件はすべて満たす（許可台帳の private repo・合格・AC 全件・PR あり）。
  const base: AutoMergeFacts = {
    enabled: true,
    jobState: 'pr_ready',
    jobHeadSha: 'a'.repeat(40),
    superseded: false,
    orderCurrent: true,
    orderSignal: 'g',
    verdict: 'passed',
    acAllConfirmed: true,
    diff: { ok: true, policyVersion: 'devline-diff/v1', changedPaths: ['src/index.ts'] },
    repo: autoMergeRepoFacts(SANDBOX_REPO.name, [SANDBOX_REPO]),
    hasPr: true,
    mergeState: 'none',
  };

  const blue = decideAutoMerge(base);
  const yellow = decideAutoMerge({ ...base, orderSignal: 'y' });
  const red = decideAutoMerge({ ...base, orderSignal: 'r' });

  evidence.note('C1-auto-merge-signal', {
    blue,
    yellow,
    red,
    orderSignal: base.orderSignal,
  });

  // 青だけが自動マージの対象。
  expect(blue.ok, '青の注文書が自動マージの対象になっていない').toBe(true);
  expect(yellow.ok, '黄の注文書が自動マージの対象になっている').toBe(false);
  if (!yellow.ok) expect(yellow.reasons, '黄の拒否理由が残っていない').toContain('order_signal_not_blue');
  expect(red.ok, '赤の注文書が自動マージの対象になっている').toBe(false);
});

/* ───────────────────────────── C2-1: release_wait → done の指名 ───────────────────────────── */

test('C2-1 release_wait→done は指名された承認者だけができる', { tag: ['@iso'] }, async ({ evidence }) => {
  const approverA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const approverB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const request = {
    requestId: 'REQ-2026-9001',
    applicantUserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    approverUserId: approverA,
    approverName: '承認者A',
  };

  const byB = roleCanTransition(
    'release_wait',
    'done',
    { role: 'approver', userId: approverB, displayName: '承認者B' },
    request,
    false,
  );
  const byA = roleCanTransition(
    'release_wait',
    'done',
    { role: 'approver', userId: approverA, displayName: '承認者A' },
    request,
    false,
  );

  evidence.note('C2-1-release-wait-done', {
    designated: approverA,
    nonDesignated: approverB,
    byDesignated: byA,
    byNonDesignated: byB,
  });

  // 指名された承認者（A）は done にできる（現状も、望ましい契約でも true）。
  expect(byA.allowed, '指名された承認者が release_wait→done に進めない').toBe(true);

  // wait → approved と同じく、指名された承認者だけが公開承認（done）にできる。
  expect(byB.allowed, '指名されていない承認者（B）が release_wait→done に進めている').toBe(false);
});

/* ───────────────────────────── C2-2: 成果物の紐付け無しで done ───────────────────────────── */

test(
  'C2-2 release_wait の依頼は成果物の紐付け無しに done にできない',
  { tag: ['@iso'] },
  async ({ user, admin, db, evidence }) => {
    expect(db, '層①では DB へ接続できる必要があります').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    const request = await createRequestViaApi(user.api, {
      title: uniqueTitle('C2 done'),
      decides: 'g',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
      criteria: ['公開の承認は成果物の紐付けを確かめて行うこと'],
    });
    recordRequest(request.id, 'C2');

    // 承認済みから release_wait まで進める（API の正規経路）。
    await transitionViaApi(admin.api, request.id, 'review');
    await transitionViaApi(admin.api, request.id, 'wait');
    await transitionViaApi(admin.api, request.id, 'approved', { signal: 'g' });
    await transitionViaApi(admin.api, request.id, 'dev');
    await transitionViaApi(admin.api, request.id, 'verify');
    await transitionViaApi(admin.api, request.id, 'field');
    const reached = await transitionViaApi(admin.api, request.id, 'release_wait');
    expect(String(reached.status), 'release_wait まで進めていない').toBe('release_wait');

    // この依頼には job（開発ライン）も配備の記録も無い＝成果物の紐付けが無い。
    const linkedJobs = await db!.query('select count(*)::int as n from job where request_id = $1', [request.id]);
    const linkedReleases = await db!.query(
      `select count(*)::int as n from release r join job j on j.id = r.job_id where j.request_id = $1`,
      [request.id],
    );
    expect(linkedJobs[0]?.n, 'この試験の前提（job が無い）が崩れている').toBe(0);
    expect(linkedReleases[0]?.n, 'この試験の前提（release が無い）が崩れている').toBe(0);

    const before = await serverRequest(admin.api, request.id);
    const res = await admin.api.post(`/api/requests/${encodeURIComponent(request.id)}/transitions`, {
      to: 'done',
      version: before.version,
      reason: '',
      checklistAcknowledged: true,
      redAcknowledged: true,
    });
    const after = await serverRequest(admin.api, request.id);

    evidence.note('C2-2-release-wait-done-without-artifact', {
      requestId: request.id,
      status: res.status,
      code: errorCode(res.body),
      beforeStatus: before.status,
      beforeVersion: before.version,
      afterStatus: after.status,
      afterVersion: after.version,
      linkedJobs: linkedJobs[0]?.n ?? null,
      linkedReleases: linkedReleases[0]?.n ?? null,
    });

    // 公開の承認（done）は、配備済みで健康・スモーク確認済みの成果物と紐付いていなければ通さない。
    expect(res.status, `成果物の紐付けが無いのに release_wait→done が通った（実測 ${res.status}）`).toBe(409);
    expect(errorCode(res.body), `拒否コードが ERR-202 ではない（実測 ${errorCode(res.body)}）`).toBe('ERR-202');
    expect(String(after.status), '成果物の紐付けが無いのに依頼が done になった').toBe('release_wait');
    const audits = await db!.query(
      `select action, result, diff from audit_log where target_id = $1 and action = 'request.transition_denied' order by id`,
      [request.id],
    );
    expect(
      audits.some((a: { diff?: { reason?: string } }) => a.diff?.reason === 'artifact_unlinked'),
      '成果物の紐付け拒否が監査に残っていない',
    ).toBe(true);
  },
);
