import { expect, test } from './fixtures/roles';
import { roleCanTransition } from '../../../src/shared/domain';
import { SANDBOX_REPO, autoMergeRepoFacts, decideAutoMerge, type AutoMergeFacts } from '../../../src/shared/devline';
import { createRequestViaApi, currentUser, serverRequest, transitionViaApi, uniqueTitle } from './fixtures/station';
import { recordRequest } from './fixtures/run-state';
import { errorCode } from './fixtures/devline';

/**
 * 既知の穴（望ましい契約と実装が違う点）を `test.fail()` で残す。層①（使い捨て DB）だけ。
 *
 * `test.fail()` は「この期待は現状の実装では満たされない」という記録であり、期待を緩めるものではない。
 * 実装が直れば「Expected to fail, but passed」でこのテストは失敗する（穴が塞がれたことが分かる）。
 *
 * C1: `decideAutoMerge` は注文書の信号の色を見ていない。黄（signal='y'）でも他の条件が揃えば ok:true になる。
 * C2: `roleCanTransition` は release_wait → done で「指名された承認者か」を見ない。成果物の紐付けも見ない。
 */

/* ───────────────────────────── C1: 自動マージが信号の色を見ていない ───────────────────────────── */

test('C1 黄の注文書（signal=y）は自動マージの対象外であるべき（既知の穴）', { tag: ['@iso'] }, async ({ evidence }) => {
  test.fail();

  // 黄だけが理由になるように、自動マージの他の条件はすべて満たす（許可台帳の private repo・合格・AC 全件・PR あり）。
  const base: AutoMergeFacts = {
    enabled: true,
    jobState: 'pr_ready',
    jobHeadSha: 'a'.repeat(40),
    superseded: false,
    orderCurrent: true,
    verdict: 'passed',
    acAllConfirmed: true,
    diff: { ok: true, policyVersion: 'devline-diff/v1', changedPaths: ['src/index.ts'] },
    repo: autoMergeRepoFacts(SANDBOX_REPO.name, [SANDBOX_REPO]),
    hasPr: true,
    mergeState: 'none',
  };
  // 注文書の信号は AutoMergeFacts に無い。望ましい契約では黄（y）を対象外にするため、signal を渡す。
  const facts = { ...base, orderSignal: 'y' } as AutoMergeFacts & { orderSignal: string };

  const neutral = decideAutoMerge(base);
  const decision = decideAutoMerge(facts);

  evidence.note('C1-auto-merge-yellow', {
    // 条件が揃った注文書（信号は渡していない）は現状 ok:true。ここは契約として変わらない。
    withoutSignal: neutral,
    // 黄の注文書でも、signal を見ていないので現状 ok:true になる（穴）。
    withYellowSignal: decision,
    orderSignal: facts.orderSignal,
  });

  // 前提: 他の条件が揃っていれば、信号を渡さない場合は通る（差は黄の信号だけ）。
  expect(neutral.ok, '自動マージの前提条件が揃っていない（この試験の前提が崩れている）').toBe(true);

  // 望ましい契約: 黄の注文書は「人が承認する」対象で、自動マージの対象外。
  // 現状は signal を見ていないため ok:true のまま（decideAutoMerge の引数に signal が無い）。
  expect(decision.ok, '黄の注文書（signal=y）が自動マージの対象になっている（decideAutoMerge が信号の色を見ていない）').toBe(
    false,
  );
});

/* ───────────────────────────── C2-1: release_wait → done の指名 ───────────────────────────── */

test('C2-1 release_wait→done は指名された承認者だけができるべき（既知の穴）', { tag: ['@iso'] }, async ({ evidence }) => {
  test.fail();

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

  // 望ましい契約: wait → approved と同じく、指名された承認者だけが公開承認（done）にできる。
  // 現状は wait のときだけ approverUserId を見ており、release_wait では誰でも通る（穴）。
  expect(byB.allowed, '指名されていない承認者（B）が release_wait→done に進めている').toBe(false);
});

/* ───────────────────────────── C2-2: 成果物の紐付け無しで done ───────────────────────────── */

test(
  'C2-2 release_wait の依頼は成果物の紐付け無しに done にできないべき（既知の穴）',
  { tag: ['@iso'] },
  async ({ user, admin, db, evidence }) => {
    test.fail();
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

    // 望ましい契約: 公開の承認（done）は、配備済みの成果物（release / release_attempt）と紐付いていなければ通さない。
    // 現状は成果物を見ずに 200 で done にできる（穴）。
    expect(
      res.status,
      `成果物の紐付けが無いのに release_wait→done が通った（実測 ${res.status} ${errorCode(res.body)}）`,
    ).not.toBe(200);
    expect(String(after.status), '成果物の紐付けが無いのに依頼が done になった').toBe('release_wait');
  },
);
