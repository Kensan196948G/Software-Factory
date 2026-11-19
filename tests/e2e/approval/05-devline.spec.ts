import { expect, test } from './fixtures/roles';
import { currentUser, serverRequest, transitionViaApi, uniqueTitle, createRequestViaApi } from './fixtures/station';
import { recordRequest } from './fixtures/run-state';
import {
  DIGEST_D0,
  DIGEST_D1,
  DIGEST_D2,
  advanceJobTo,
  approvedRequestWithJob,
  countAttempts,
  errorCode,
  errorDetails,
  insertMergedRelease,
  insertSucceededDeployAttempt,
  jobRow,
  jobView,
  prepareJobPrReady,
  pullBody,
  sha40,
} from './fixtures/devline';

/**
 * 開発ライン（ステップ4・7・8・9）の E2E。層①（使い捨て DB・別ポート API・偽 GitHub）だけ。
 *
 * B4: 未承認・赤・承認済み最新版の 3 区分で「投入できるもの／できないもの」を偽 GitHub の Issue で確かめる。
 * B5: 一般利用者は merge を承認できず、管理者でも head SHA が違えば拒否され、正しい SHA でのみ merged になる。
 * B6: digest 不一致の配備は拒否され（release_attempt が増えない）、承認者の戻しだけが記録を残す。
 *
 * 実 GitHub へは送らない（偽サーバの制御 API だけ）。実データ・秘密は使わない。
 * 5xx と pageerror は共通フィクスチャが 0 件であることを検査する（無効化しない）。
 */

/** 偽 GitHub の Issue 番号から、差し込んだ Issue を引く。 */
function issueByNumber(issues: any[], number: unknown): any {
  return issues.find((issue) => issue?.number === number) ?? null;
}

/* ───────────────────────────── B4: 投入の境界 ───────────────────────────── */

test(
  'B4 未承認の注文書は投入できない（承認者 409 ERR-205・一般利用者は役割で 403・Issue が増えない）',
  { tag: ['@iso'] },
  async ({ user, admin, fake, evidence, db }) => {
    expect(fake, '層①では偽 GitHub の制御 API が必要です').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    const request = await createRequestViaApi(user.api, {
      title: uniqueTitle('B4 未承認'),
      decides: 'g',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
      criteria: ['未承認の投入が拒否されること'],
    });
    recordRequest(request.id, 'B4');
    const issuesBefore = await fake!.issues();

    // 依頼は受付（received）のまま。承認記録も注文書の版も無い。
    expect(request.status).toBe('received');

    // (1) 一般利用者は投入の役割を持たない。実装は役割を先に見るため 409 ではなく 403 ERR-101 になる
    //     （作業指示は 409 ERR-205 を想定していたが、実測はより強い拒否。実測値をそのまま残す）。
    const asRequester = await user.api.post(`/api/requests/${encodeURIComponent(request.id)}/handoff`);
    // (2) 投入できる承認者でも、依頼が承認済みでないため 409 ERR-205 で拒否される（本命の境界）。
    const asAdmin = await admin.api.post(`/api/requests/${encodeURIComponent(request.id)}/handoff`);
    const issuesAfter = await fake!.issues();

    evidence.note('B4-unapproved', {
      requestId: request.id,
      requester: {
        status: asRequester.status,
        code: errorCode(asRequester.body),
        message: asRequester.body?.error?.message ?? '',
      },
      approver: { status: asAdmin.status, code: errorCode(asAdmin.body), message: asAdmin.body?.error?.message ?? '' },
      issuesBefore: issuesBefore.length,
      issuesAfter: issuesAfter.length,
    });

    expect(
      asRequester.status,
      `一般利用者の投入は役割で拒否されるべき（実測 ${asRequester.status} ${errorCode(asRequester.body)}）`,
    ).toBe(403);
    expect(errorCode(asRequester.body)).toBe('ERR-101');
    expect(asAdmin.status, `未承認の注文書は投入できないはず（実測 ${asAdmin.status} ${errorCode(asAdmin.body)}）`).toBe(409);
    expect(errorCode(asAdmin.body), '未承認の投入は ERR-205 で拒否されるべき').toBe('ERR-205');
    expect(issuesAfter.length, '未承認の注文書なのに偽 GitHub に Issue が増えた').toBe(issuesBefore.length);

    // 依頼の状態と Issue 番号も変わっていない。
    const after = await serverRequest(admin.api, request.id);
    expect(after.status).toBe('received');
    if (db) {
      const rows = (await db.query('select issue_no, signal_decided from request where id = $1', [request.id])) as {
        issue_no: number | null;
        signal_decided: string | null;
      }[];
      expect(rows[0]?.issue_no, '未承認の依頼に Issue 番号が記録された').toBeNull();
      expect(rows[0]?.signal_decided).toBeNull();
    }
  },
);

test(
  'B4 赤の注文書は投入できない（承認済みでも Issue を作らない）',
  { tag: ['@iso'] },
  async ({ user, admin, fake, evidence, db }) => {
    expect(fake, '層①では偽 GitHub の制御 API が必要です').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    // 候補が赤（decides='r'）の依頼を承認者に承認してもらう。
    const request = await createRequestViaApi(user.api, {
      title: uniqueTitle('B4 赤'),
      decides: 'r',
      approverUserId: approver.id,
      approverName: approver.displayName,
      applicant: requester.displayName,
      criteria: ['赤の注文書は人が範囲を変えるまで投入されないこと'],
    });
    recordRequest(request.id, 'B4');
    await transitionViaApi(admin.api, request.id, 'review');
    await transitionViaApi(admin.api, request.id, 'wait');
    await transitionViaApi(admin.api, request.id, 'approved', { signal: 'r', redAck: true });
    // transitionViaApi の戻り値は当てにせず、サーバから読み直して確かめる。
    const approved = await serverRequest(admin.api, request.id);
    expect(approved.signalDecided, '赤（r）で承認されていない').toBe('r');
    expect(approved.status, '承認済みになっていない').toBe('approved');

    const issuesBefore = await fake!.issues();
    const res = await admin.api.post(`/api/requests/${encodeURIComponent(request.id)}/handoff`);
    const issuesAfter = await fake!.issues();
    const createdNumber = res.body?.issueNo ?? null;
    const createdIssue = createdNumber === null ? null : issueByNumber(issuesAfter, createdNumber);

    evidence.note('B4-red', {
      requestId: request.id,
      signalDecided: approved.signalDecided,
      handoff: { status: res.status, code: errorCode(res.body), issueNo: createdNumber, message: res.body?.error?.message ?? '' },
      issuesBefore: issuesBefore.length,
      issuesAfter: issuesAfter.length,
      createdIssue: createdIssue ? { number: createdIssue.number, title: createdIssue.title } : null,
    });

    // 期待: 赤の注文書は投入できない（Issue が増えない）。
    // 実装が Issue を作るなら、このテストは期待どおり FAIL する（期待を緩めない）。
    expect(issuesAfter.length, '赤の注文書（signal=r）なのに偽 GitHub に Issue が増えた（実装が赤を投入している）').toBe(
      issuesBefore.length,
    );
    expect(res.status, `赤の注文書の投入は拒否されるべき（実測 ${res.status} ${errorCode(res.body)}）`).not.toBe(200);

    if (db) {
      const rows = (await db.query('select issue_no from request where id = $1', [request.id])) as { issue_no: number | null }[];
      expect(rows[0]?.issue_no, '赤の依頼に Issue 番号が記録された').toBeNull();
    }
  },
);

test(
  'B4 承認済みの最新版だけが偽 GitHub の Issue になる（本文に受付番号と注文書ハッシュ）',
  { tag: ['@iso'] },
  async ({ user, admin, fake, evidence, db }) => {
    expect(fake, '層①では偽 GitHub の制御 API が必要です').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    const issuesBefore = await fake!.issues();
    const job = await approvedRequestWithJob({
      user: user.api,
      admin: admin.api,
      approver: { id: approver.id, displayName: approver.displayName },
      applicant: requester.displayName,
      title: uniqueTitle('B4 承認済み'),
      signal: 'g',
      criteria: ['受理された注文書が Issue になること', '受付番号と注文書ハッシュが一致すること'],
    });
    recordRequest(job.request.id, 'B4');
    const issuesAfter = await fake!.issues();

    expect(job.handoff.status).toBe(200);
    expect(job.handoff.body?.created, '新規の Issue として作られていない').toBe(true);
    const issueNo = job.handoff.body?.issueNo;
    const created = issueByNumber(issuesAfter, issueNo);
    const marker = /sha256=([0-9a-f]{64})/.exec(String(created?.body ?? ''));

    evidence.note('B4-approved', {
      requestId: job.request.id,
      jobId: job.jobId,
      issueNo,
      issueUrl: created?.html_url ?? null,
      issuesBefore: issuesBefore.length,
      issuesAfter: issuesAfter.length,
      orderHashInBody: marker?.[1] ?? null,
    });

    expect(issuesAfter.length, '承認済みの投入で Issue が 1 件だけ増えていない').toBe(issuesBefore.length + 1);
    expect(created, `投入した Issue #${String(issueNo)} が偽 GitHub に無い`).not.toBeNull();
    expect(String(created.title), 'Issue のタイトルに受付番号が無い').toContain(job.request.id);
    expect(String(created.body), 'Issue の本文に受付番号（見出し）が無い').toContain(job.request.id);
    expect(marker?.[1], 'Issue 本文の照合マーカーに注文書ハッシュ（sha256=）が無い').toBeTruthy();

    if (db) {
      const rows = (await db.query('select content_sha256 from order_snapshot where request_id = $1 and order_version = $2', [
        job.request.id,
        job.request.orderVersion,
      ])) as { content_sha256: string }[];
      expect(rows, '版固定した注文書（order_snapshot）が 1 行ではない').toHaveLength(1);
      expect(marker?.[1], 'Issue 本文の注文書ハッシュが版固定した本文と一致しない').toBe(rows[0]?.content_sha256);
    }

    // 承認済みの最新版は job が 1 件作られる。
    expect(job.jobId, 'job の ID が UUID の形ではない').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const view = await jobView(admin.api, job.jobId);
    expect(['queued', 'planning']).toContain(view.state);
  },
);

/* ───────────────────────────── B5: merge の承認 ───────────────────────────── */

test(
  'B5 一般利用者は merge できず、承認者でも SHA 違いは 409、正しい SHA で merged になる',
  { tag: ['@iso'] },
  async ({ user, admin, fake, db, evidence }) => {
    expect(fake, '層①では偽 GitHub の制御 API が必要です').not.toBeNull();
    expect(db, '層①では DB へ接続できる必要があります').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    const job = await approvedRequestWithJob({
      user: user.api,
      admin: admin.api,
      approver: { id: approver.id, displayName: approver.displayName },
      applicant: requester.displayName,
      title: uniqueTitle('B5 merge'),
      signal: 'g',
      criteria: ['承認した SHA だけが merge されること'],
    });
    recordRequest(job.request.id, 'B5');

    // pr_ready の job を用意し、偽 GitHub に buildPrMarker 付きの PR を差し込む。
    const headSha = sha40('a1b2c3d4e5f6a7b8');
    const treeSha = sha40('9a8b7c6d5e4f3021');
    const prNumber = 700 + (Number.parseInt(job.jobId.replace(/-/g, '').slice(0, 6), 16) % 200);
    const prUrl = `http://127.0.0.1:1/msf-test/fake-repo/pull/${prNumber}`;
    await prepareJobPrReady(db!, { jobId: job.jobId, headSha, prNumber, prUrl });
    await fake!.addPull({ number: prNumber, head: headSha, body: pullBody(job.jobId, headSha), trees: { [headSha]: treeSha } });

    const ready = await jobView(admin.api, job.jobId);
    expect(ready.state, 'job が pr_ready になっていない').toBe('pr_ready');
    expect(ready.headSha).toBe(headSha);

    // (1) 一般利用者は merge を承認できない。
    const asUser = await user.api.post(`/api/jobs/${job.jobId}/approve-merge`, { headSha });
    expect(asUser.status, `一般利用者が merge を承認できてしまう（実測 ${asUser.status}）`).toBe(403);
    expect(errorCode(asUser.body)).toBe('ERR-101');

    // (2) 承認者でも、表示していた SHA と違えば拒否される（job は pr_ready のまま）。
    const wrongSha = sha40('ffeeddccbbaa9988');
    const stale = await admin.api.post(`/api/jobs/${job.jobId}/approve-merge`, { headSha: wrongSha });
    const staleRefusal = String(errorDetails(stale.body).refusal ?? '');
    const releasesAfterStale = await db!.query('select count(*)::int as n from release where job_id = $1', [job.jobId]);
    const stillReady = await jobView(admin.api, job.jobId);
    evidence.note('B5-sha-mismatch', {
      status: stale.status,
      code: errorCode(stale.body),
      refusal: staleRefusal,
      requestedSha: wrongSha,
      jobHeadSha: stillReady.headSha,
      jobState: stillReady.state,
      releaseRows: releasesAfterStale[0]?.n ?? null,
    });
    expect(stale.status, `SHA 違いの merge が拒否されない（実測 ${stale.status} ${errorCode(stale.body)}）`).toBe(409);
    expect(errorCode(stale.body)).toBe('ERR-202');
    expect(staleRefusal, '拒否の理由（refusal）が head_changed ではない').toBe('head_changed');
    expect(stillReady.state, 'SHA 違いの拒否で job の状態が動いた').toBe('pr_ready');

    // (3) 正しい SHA なら merge される。
    const merged = await admin.api.post(`/api/jobs/${job.jobId}/approve-merge`, { headSha });
    evidence.note('B5-merge', {
      status: merged.status,
      code: errorCode(merged.body),
      jobState: merged.body?.job?.state ?? null,
      mergeState: merged.body?.mergeState ?? null,
      alreadyDone: merged.body?.alreadyDone ?? null,
      prNumber,
    });
    expect(merged.status, `正しい SHA の merge が通らない: ${merged.text.slice(0, 400)}`).toBe(200);
    expect(merged.body?.job?.state, 'merge 後に job が merged になっていない').toBe('merged');
    expect(merged.body?.mergeState).toBe('merged');

    const row = await jobRow(db!, job.jobId);
    expect(row.state, 'DB の job が merged になっていない').toBe('merged');
    const release = (await db!.query('select * from release where job_id = $1', [job.jobId]))[0];
    const approvals = await db!.query(
      `select decision, sha from release_approval where job_id = $1 and kind = 'merge' order by seq`,
      [job.jobId],
    );
    evidence.note('B5-db', {
      jobState: row.state,
      release: release
        ? { mergeState: release.merge_state, mergeSha: release.merge_sha, approvedHeadSha: release.approved_head_sha }
        : null,
      mergeApprovals: approvals.map((a: { decision: string; sha: string }) => ({ decision: a.decision, sha: a.sha })),
    });
    expect(release, 'release の行が無い').toBeTruthy();
    expect(release.merge_state).toBe('merged');
    expect(release.merge_sha, 'merge の SHA が 40 桁の 16 進ではない').toMatch(/^[0-9a-f]{40}$/);
    expect(release.approved_head_sha).toBe(headSha);
    expect(
      approvals.some((a: { decision: string; sha: string }) => a.decision === 'approved' && a.sha === headSha),
      '承認者の merge 承認（release_approval）が残っていない',
    ).toBe(true);
  },
);

/* ───────────────────────────── B6: 配備と戻し ───────────────────────────── */

test(
  'B6 digest 不一致の配備は拒否され、承認者の戻しだけが release_attempt と監査を残す',
  { tag: ['@iso'] },
  async ({ user, admin, db, evidence }) => {
    expect(db, '層①では DB へ接続できる必要があります').not.toBeNull();
    const requester = await currentUser(user.api);
    const approver = await currentUser(admin.api);

    const job = await approvedRequestWithJob({
      user: user.api,
      admin: admin.api,
      approver: { id: approver.id, displayName: approver.displayName },
      applicant: requester.displayName,
      title: uniqueTitle('B6 deploy'),
      signal: 'g',
      criteria: ['承認した digest の成果物だけが配備されること'],
    });
    recordRequest(job.request.id, 'B6');

    // merged の job と、検査済みの成果物を持つ release を DB で用意する（worker は起動しない）。
    const headSha = sha40('c1d2e3f4a5b6c7d8');
    const mergeSha = sha40('9182736455463728');
    const previousSha = sha40('1122334455667788');
    await prepareJobPrReady(db!, { jobId: job.jobId, headSha, prNumber: 4242, prUrl: 'http://127.0.0.1:1/e2e/pull/4242' });
    await advanceJobTo(db!, job.jobId, 'merged');
    await insertMergedRelease(db!, {
      jobId: job.jobId,
      headSha,
      mergeSha,
      imageDigest: DIGEST_D1,
      previousDigest: DIGEST_D0,
      previousSha,
      prNumber: 4242,
    });

    // (1) 成果物の digest（d1）と違う digest（d2）の配備承認は拒否され、配備の試行は増えない。
    const attemptsBefore = await countAttempts(db!, job.jobId);
    const mismatch = await admin.api.post(`/api/jobs/${job.jobId}/approve-deploy`, {
      sha: mergeSha,
      digest: DIGEST_D2,
      environment: 'local-verify',
    });
    const attemptsAfter = await countAttempts(db!, job.jobId);
    evidence.note('B6-deploy-digest-mismatch', {
      status: mismatch.status,
      code: errorCode(mismatch.body),
      refusal: String(errorDetails(mismatch.body).refusal ?? ''),
      requestedDigest: DIGEST_D2,
      artifactDigest: DIGEST_D1,
      attemptsBefore,
      attemptsAfter,
    });
    expect(mismatch.status, `digest 違いの配備が拒否されない（実測 ${mismatch.status} ${errorCode(mismatch.body)}）`).toBe(409);
    expect(errorCode(mismatch.body)).toBe('ERR-202');
    expect(String(errorDetails(mismatch.body).refusal ?? ''), '拒否の理由が digest_mismatch ではない').toBe('digest_mismatch');
    expect(attemptsAfter, '拒否された配備で release_attempt が増えた').toBe(attemptsBefore);

    // (2) 環境に d1 が載った状態を作り、承認者の戻しだけが通ることを確かめる。
    await advanceJobTo(db!, job.jobId, 'staged');
    await insertSucceededDeployAttempt(db!, {
      jobId: job.jobId,
      sha: mergeSha,
      digest: DIGEST_D1,
      previousDigest: DIGEST_D0,
      previousSha,
    });

    const asUser = await user.api.post(`/api/jobs/${job.jobId}/rollback`, { reason: 'E2E: 一般利用者の戻しは拒否されるべき' });
    expect(asUser.status, `一般利用者が戻しを承認できてしまう（実測 ${asUser.status}）`).toBe(403);
    expect(errorCode(asUser.body)).toBe('ERR-101');

    const reason = 'E2E: 検証環境の作り物の版を戻す（実データは使わない）';
    const rolled = await admin.api.post(`/api/jobs/${job.jobId}/rollback`, { reason });
    const rollbackAttempts = await db!.query(
      `select kind, state, reason, digest, previous_digest, environment from release_attempt
      where job_id = $1 and kind = 'rollback' order by seq`,
      [job.jobId],
    );
    const rollbackAudit = await db!.query(
      `select action, result from audit_log where target_id = $1 and action = 'job.rollback' order by id`,
      [job.jobId],
    );
    const after = await jobRow(db!, job.jobId);
    evidence.note('B6-rollback', {
      status: rolled.status,
      code: errorCode(rolled.body),
      reason,
      jobState: after.state,
      rollbackAttempts: rollbackAttempts.map((a: Record<string, unknown>) => ({
        kind: a.kind,
        state: a.state,
        reason: a.reason,
        digest: a.digest,
        previousDigest: a.previous_digest,
        environment: a.environment,
      })),
      audit: rollbackAudit,
    });
    try {
      expect(rolled.status, `承認者の戻しが通らない: ${rolled.text.slice(0, 400)}`).toBe(200);
      expect(rollbackAttempts, '戻しの release_attempt が 1 行だけ残っていない').toHaveLength(1);
      expect(rollbackAttempts[0]?.reason, '戻しの理由が記録されていない').toBe(reason);
      expect(rollbackAttempts[0]?.previous_digest, '戻し元（環境に載っていた版）が記録されていない').toBe(DIGEST_D1);
      expect(rollbackAttempts[0]?.digest, '戻し先の digest が記録されていない').toBe(DIGEST_D0);
      expect(
        rollbackAudit.some((a: { action: string; result: string }) => a.action === 'job.rollback' && a.result === 'success'),
        '監査に job.rollback（success）が残っていない',
      ).toBe(true);
    } finally {
      // worker が戻しを実行して終わった状態にする。実際の構成では worker が release_attempt を確定させ、
      // 環境（local-verify）を使える状態へ戻す。層①は worker を起動しないため、ここで同じ後始末をする。
      // これをしないと、同じ環境のまま次のラウンドの戻しが ERR-301（別の配備か戻しが進行中）で止まる。
      await db!.query(
        `update release_attempt set state = 'succeeded', deployed_digest = $2, deployed_sha = $3, health = true, smoke = true, finished_at = now()
        where job_id = $1 and kind = 'rollback' and state = 'pending'`,
        [job.jobId, DIGEST_D0, previousSha],
      );
    }
  },
);
