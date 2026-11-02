/**
 * QA: 権限と PR 候補（T-85〜T-89）。
 *
 * TEST_MEMBER（loginAsMember）の注記は「依頼者のみ」だが、実際は requester と approver の両方を持つ。
 * 否定の試験には足りないので、ここでは requester だけの利用者（loginWithRoles）で確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/api/audit.js';
import { query } from '../../src/api/db.js';
import { handoffOrder, recordVerification } from '../../src/api/devline-service.js';
import { renderDraftPrBody } from '../../src/api/devline-verification.js';
import { PR_AGENTS_HEADINGS, PR_DECISION_ITEMS } from '../../src/shared/devline.js';
import { runUntilIdle } from '../../src/worker/loop.js';
import type { FakeResponder } from './fake-github-server.js';
import { authHeaders, loginAsMember, TEST_MEMBER, TEST_USER, type Authed } from './helpers.js';
import { loginWithRoles, QA_TOKEN, stages, useHarness } from './devline-qa-harness.js';

const h = useHarness();
let requester: Authed;

beforeEach(async () => {
  requester = await loginWithRoles(h.app, 'qa-requester@example.com', ['requester']);
});

async function queuedJob(): Promise<{ id: string; jobId: string }> {
  const id = await h.approvedRequest();
  const res = await h.handoff(id);
  expect(res.statusCode, res.body).toBe(200);
  return { id, jobId: res.json().jobId };
}

describe('T-85: cancel / resume の権限', () => {
  it('TEST_MEMBER の役割を確認する: requester と approver を持ち、admin ではない（注記の「依頼者のみ」とは違う）', async () => {
    const member = await loginAsMember(h.app);
    const me = (await h.api('GET', '/api/auth/me', undefined, member)).json().user;
    expect([...me.roles].sort()).toEqual(['approver', 'requester']);
    expect(me.isAdmin).toBe(false);
  });

  it('requester は cancel / resume で 403 ERR-101、監査に denied が残り、job は動かない', async () => {
    const { jobId } = await queuedJob();
    for (const op of ['cancel', 'resume'] as const) {
      const res = await h.api('POST', `/api/jobs/${jobId}/${op}`, { reason: '権限なし' }, requester);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ERR-101');
      expect(
        await h.count(`from audit_log where action=$1 and target_id=$2 and result='denied' and actor_user_id=$3`, [
          `job.${op}`,
          jobId,
          requester.user.id,
        ]),
      ).toBe(1);
    }
    expect((await h.view(jobId)).state).toBe('queued');
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('TEST_MEMBER は requester の役割のままなら 403、approver へ切り替えれば cancel できる', async () => {
    const { jobId } = await queuedJob();
    const member = await loginAsMember(h.app);
    const me = (await h.api('GET', '/api/auth/me', undefined, member)).json().user;
    expect(me.actingRole).toBe('requester');
    const denied = await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x' }, member);
    expect(denied.statusCode).toBe(403);
    await h.setRole('approver', member);
    const ok = await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x' }, member);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('持っていない役割へは切り替えられない（requester が desk を名乗れない）', async () => {
    const { jobId } = await queuedJob();
    for (const role of ['desk', 'approver']) {
      const res = await h.api('POST', '/api/auth/role', { role }, requester);
      expect(res.statusCode).toBe(403);
    }
    expect((await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x' }, requester)).statusCode).toBe(403);
    // クライアントの本文やヘッダで役割を上書きできない
    const spoof = await h.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/cancel`,
      headers: { ...authHeaders(requester), 'x-acting-role': 'desk', 'x-role': 'admin' },
      payload: { reason: 'x', role: 'desk', actor: 'admin', isAdmin: true },
    });
    expect(spoof.statusCode).toBe(403);
  });

  it('desk / approver / admin は cancel と resume ができる。admin は role が requester でも判定は isAdmin', async () => {
    const { jobId } = await queuedJob();
    const desk = await loginWithRoles(h.app, 'qa-desk@example.com', ['desk']);
    const approver = await loginWithRoles(h.app, 'qa-approver@example.com', ['approver']);
    const admin = await loginWithRoles(h.app, 'qa-admin@example.com', ['requester'], true);
    let state = 'queued';
    for (const who of [desk, approver, admin]) {
      const c = await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: '止める' }, who);
      expect(c.statusCode, c.body).toBe(200);
      state = c.json().job.state;
      expect(state).toBe('cancelled');
      const r = await h.api('POST', `/api/jobs/${jobId}/resume`, { reason: '再開' }, who);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().job.state).toBe('queued');
    }
  });

  it('cancel / resume: 理由なしは 400 ERR-102、expectedState の不一致は 409 ERR-301、不正な値は 400', async () => {
    const { jobId } = await queuedJob();
    const empty = await h.api('POST', `/api/jobs/${jobId}/cancel`, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('ERR-102');
    const conflict = await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x', expectedState: 'planning' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('ERR-301');
    const bad = await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x', expectedState: 'nope' });
    expect(bad.statusCode).toBe(400);
    const missing = await h.api('POST', '/api/jobs/00000000-0000-4000-8000-000000000000/cancel', { reason: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ERR-104');
    const shape = await h.api('POST', `/api/jobs/not-uuid/resume`, { reason: 'x' });
    expect(shape.statusCode).toBe(404);
  });

  it('API-06: requester は 403（admin でも role が requester なら 403。旧ルートと同じ）。confirm_absent は approver / admin のみ', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const denied = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version }, requester);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ERR-101');
    expect(h.github.access).toHaveLength(0);
    const adminRequester = await loginWithRoles(h.app, 'qa-admin2@example.com', ['requester'], true);
    expect((await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version }, adminRequester)).statusCode).toBe(403);
    const deskConfirm = await loginWithRoles(h.app, 'qa-desk2@example.com', ['desk']);
    const res = await h.api(
      'POST',
      `/api/orders/${id}/handoff`,
      { orderVersion: version, confirmAbsent: true, reason: 'x' },
      deskConfirm,
    );
    expect(res.statusCode).toBe(403);
    expect(
      await h.count(`from audit_log where action='handoff.intent' and result='denied' and target_id=$1`, [id]),
    ).toBeGreaterThanOrEqual(3);
    expect(h.github.access).toHaveLength(0);
  });

  it('API-06: confirmAbsent を付けても投入の権限は広がらない。admin は desk の役割のときに confirm_absent を使える', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const body = { orderVersion: version, confirmAbsent: true, reason: '確かめた' };
    const adminRequester = await loginWithRoles(h.app, 'qa-admin3@example.com', ['requester'], true);
    const denied = await h.api('POST', `/api/orders/${id}/handoff`, body, adminRequester);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ERR-101');
    expect(await h.count(`from audit_log where action='handoff.intent' and result='denied' and target_id=$1`, [id])).toBe(1);
    expect(h.github.access).toHaveLength(0);
    expect(await h.count(`from job where request_id=$1`, [id])).toBe(0);

    const adminDesk = await loginWithRoles(h.app, 'qa-admin4@example.com', ['desk'], true);
    await h.setRole('desk', adminDesk);
    const res = await h.api('POST', `/api/orders/${id}/handoff`, body, adminDesk);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('T-86: 未ログイン・CSRF・JobView', () => {
  it('未ログインの GET は ERR-106（401）。POST も通らず、job は動かない', async () => {
    const { id, jobId } = await queuedJob();
    for (const url of [`/api/jobs/${jobId}`, `/api/requests/${id}/jobs`]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('ERR-106');
    }
    for (const [url, payload] of [
      [`/api/jobs/${jobId}/cancel`, { reason: 'x' }],
      [`/api/jobs/${jobId}/resume`, { reason: 'x' }],
      [`/api/orders/${id}/handoff`, { orderVersion: 1, confirmAbsent: true, reason: 'x' }],
      [`/api/requests/${id}/handoff`, {}],
    ] as const) {
      const res = await h.app.inject({ method: 'POST', url, payload });
      expect(res.statusCode, url).toBe(401);
    }
    expect((await h.view(jobId)).state).toBe('queued');
    expect(h.posts()).toBe(1);
  });

  it('mutate の CSRF が効く: トークンなし・違うトークンの POST は 403', async () => {
    const { id, jobId } = await queuedJob();
    for (const url of [
      `/api/jobs/${jobId}/cancel`,
      `/api/jobs/${jobId}/resume`,
      `/api/orders/${id}/handoff`,
      `/api/requests/${id}/handoff`,
    ]) {
      const none = await h.app.inject({
        method: 'POST',
        url,
        headers: { cookie: h.auth.cookie },
        payload: { reason: 'x', orderVersion: 1 },
      });
      expect(none.statusCode, url).toBe(403);
      const wrong = await h.app.inject({
        method: 'POST',
        url,
        headers: { cookie: h.auth.cookie, 'x-csrf-token': 'wrong', origin: 'http://127.0.0.1:8781' },
        payload: { reason: 'x', orderVersion: 1 },
      });
      expect(wrong.statusCode, url).toBe(403);
    }
    expect((await h.view(jobId)).state).toBe('queued');
  });

  it('JobView は決めた項目だけで、canonical_yaml・lease の所有者名を含まない（lease 中でも）', async () => {
    const id = await h.approvedRequest({ problem: '本文にしか無い合言葉-ZQX' });
    const { jobId } = await h.untilVerifying(id);
    await query(`update job set lease_owner='worker-host-secret-name', lease_expires_at=now() where id=$1`, [jobId]);
    const res = await h.api('GET', `/api/jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain('本文にしか無い合言葉');
    expect(text).not.toContain('schema_version');
    expect(text).not.toContain('worker-host-secret-name');
    expect(text).not.toContain('leaseOwner');
    expect(text).not.toContain('fencing');
    const job = res.json().job;
    expect(Object.keys(job).sort()).toEqual(
      [
        'id',
        'requestId',
        'orderVersion',
        'state',
        'targetRepoId',
        'policyVersion',
        'runnerKind',
        'contentSha256',
        'headSha',
        'plan',
        'workState',
        'repairCountTotal',
        'repairCountByCause',
        'ciRerunCount',
        'continuousSeconds',
        'costJpy',
        'stopReason',
        'stopDetail',
        'remainingWork',
        'stoppedAt',
        'cancelRequestedAt',
        'supersededAt',
        'orderCurrent',
        'leaseHeld',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(job.leaseHeld).toBe(true);
    const list = await h.api('GET', `/api/requests/${id}/jobs`);
    expect(list.body).not.toContain('worker-host-secret-name');
    expect(list.body).not.toContain('本文にしか無い合言葉');
  });

  it('他人のジョブの参照範囲: ログイン済みなら依頼者でも読める（getDetail と同じ・D-14）。版の新しい順で返る', async () => {
    const { id, jobId } = await queuedJob();
    await h.reapprove(id, '二つ目');
    const second = (await h.handoff(id)).json().jobId;
    const one = await h.api('GET', `/api/jobs/${jobId}`, undefined, requester);
    expect(one.statusCode).toBe(200);
    const detail = await h.api('GET', `/api/requests/${id}`, undefined, requester);
    expect(detail.statusCode).toBe(200);
    const list = await h.api('GET', `/api/requests/${id}/jobs`, undefined, requester);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((j: any) => j.id)).toEqual([second, jobId]);
    // 取り消した依頼の job も getDetail と同じく読める
    await h.transition(id, { to: 'cancel', reason: '取り消す' });
    expect((await h.api('GET', `/api/requests/${id}`, undefined, requester)).statusCode).toBe(200);
    const after = await h.api('GET', `/api/jobs/${second}`, undefined, requester);
    expect(after.statusCode).toBe(200);
    expect(after.json().job.orderCurrent).toBe(false);
  });

  it('無い依頼・job・形の違う ID は 404 ERR-104', async () => {
    for (const url of [
      '/api/jobs/not-a-uuid',
      '/api/jobs/00000000-0000-4000-8000-000000000000',
      '/api/requests/REQ-0000-0000/jobs',
    ]) {
      const res = await h.api('GET', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('ERR-104');
    }
    const res = await h.api('POST', '/api/orders/REQ-0000-0000/handoff', { orderVersion: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ERR-104');
  });
});

describe('T-87: 監査', () => {
  it('人・system・agent・ci が残り、actor_user_id は人だけ。devline の全操作の後も連鎖が OK', async () => {
    const { jobId } = await queuedJob();
    await runUntilIdle(h.worker('test_fail_then_fix'));
    const rows = (
      await query<any>(`select role, actor_name, actor_user_id, action from audit_log where target_id=$1 and target_type='job'`, [
        jobId,
      ])
    ).rows;
    const roles = new Set(rows.map((r) => r.role));
    expect(roles).toEqual(new Set(['desk', 'system', 'agent']));
    for (const r of rows) {
      if (r.role === 'desk') expect(r.actor_user_id).toBe(h.auth.user.id);
      else expect(r.actor_user_id).toBeNull();
    }
    expect(rows.some((r) => r.role === 'agent' && r.actor_name === 'agent:fake')).toBe(true);
    expect(rows.some((r) => r.actor_name === 'worker')).toBe(true);
    expect(rows.some((r) => r.actor_name === 'ci:fake_ci' && r.action === 'verification.record')).toBe(true);
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('契約の監査 action がそろう（再開・取消・遅延・版固定）', async () => {
    const { jobId } = await queuedJob();
    await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: '止める' });
    await h.api('POST', `/api/jobs/${jobId}/resume`, { reason: '再開' });
    await runUntilIdle(h.worker('success'));
    const actions = new Set((await query<any>('select distinct action from audit_log')).rows.map((r) => r.action));
    for (const action of [
      'order.snapshot',
      'handoff.intent',
      'handoff.sent',
      'handoff.succeeded',
      'job.create',
      'job.transition',
      'job.cancel',
      'job.resume',
      'verification.record',
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});

describe('T-88: PR 候補', () => {
  it('10項目と12見出しが全部あり、AC 別に ○／未確認。無いものは未実施と書き、成功のように書かない。実 PR を呼ばない', async () => {
    const id = await h.approvedRequest();
    const { jobId, headSha } = await h.untilVerifying(id);
    // 検査の前の本文は全件が未確認
    const draft = await renderDraftPrBody(await h.jobRow(jobId));
    expect(draft.split('\n').find((l) => l.startsWith('| AC-2 '))).toContain('未確認');
    expect(draft).toContain('受入条件 未確認あり');
    expect(draft).not.toContain('受入条件 全件確認');
    await recordVerification(h.delivery(jobId, headSha));
    const body = (await query<any>(`select content from job_artifact where job_id=$1 and kind='pr_body_draft'`, [jobId])).rows[0]
      .content as string;
    expect(PR_DECISION_ITEMS).toHaveLength(10);
    expect(PR_AGENTS_HEADINGS).toHaveLength(12);
    for (const item of PR_DECISION_ITEMS) expect(body).toMatch(new RegExp(`### \\d+\\. ${item}\\n`));
    for (const heading of PR_AGENTS_HEADINGS) expect(body).toMatch(new RegExp(`### ${heading}\\n`));
    expect(body.split('\n').find((l) => l.startsWith('| AC-1 '))).toContain('○');
    expect(body.split('\n').find((l) => l.startsWith('| AC-2 '))).toContain('○');
    expect(body).toContain('受入条件 全件確認（確認 2 / 2）');
    expect(body).toContain('未実施（fake PoC）');
    expect(body).toContain('実 PR は作成していません');
    expect(body).not.toMatch(/デプロイ(に)?成功|本番.*成功/);
    expect(h.github.access.filter((a) => a.path.includes('pull'))).toHaveLength(0);
    expect(h.posts()).toBe(1); // Issue の1回だけ
  });

  it('依頼の文章で PR 候補の見出しや HTML やメンションを作らせない', async () => {
    const id = await h.approvedRequest({
      title: '<!-- x --> @everyone <script>',
      scope: ['### 目的\n# 上書き', '<img src=x onerror=1>'],
      criteria: ['| 表 | 崩し |', '@mention'],
    });
    await h.untilPrReady(id);
    const body = (
      await query<any>(
        `select content from job_artifact where kind='pr_body_draft' and job_id in (select id from job where request_id=$1)`,
        [id],
      )
    ).rows[0].content as string;
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('<img');
    expect(body).not.toMatch(/(^|[^\\])@everyone/);
    expect(body).not.toMatch(/(^|[^\\])@mention/);
    expect(body).not.toMatch(/^#+ 上書き/m);
    expect(body.split('\n').filter((l) => /^### 目的$/.test(l))).toHaveLength(1);
  });
});

describe('T-89: 秘密が出ない', () => {
  it('応答・Issue・event・artifact・監査・intent に token、接続文字列、利用者のメールが出ない', async () => {
    const leak = [
      QA_TOKEN,
      process.env.DATABASE_URL ?? '<none>',
      process.env.TEST_MIGRATION_DATABASE_URL ?? '<none>',
      TEST_USER.email,
      TEST_MEMBER.email,
      TEST_USER.password,
    ];
    const contact = 'qa.person@example.com';
    const id = await h.approvedRequest({ contact });
    const version = await h.orderVersion(id);

    // 外部の応答に token が混ざっても、API の応答へ出さない
    const echoed: FakeResponder = () => ({ status: 422, body: { message: `bad credentials ${QA_TOKEN}` } });
    const failure = await handoffOrder(
      { requestId: id, orderVersion: version },
      h.actor('desk'),
      'c',
      h.deps({ issueAdapter: h.armedAdapter([echoed]) }),
    ).catch((err) => err);
    expect(failure.code).toBe('ERR-304');
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(QA_TOKEN);

    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    const jobId = res.json().jobId;
    await runUntilIdle(h.worker('success'));
    const responses = [
      res.body,
      (await h.api('GET', `/api/jobs/${jobId}`)).body,
      (await h.api('GET', `/api/requests/${id}/jobs`)).body,
      (await h.api('POST', `/api/jobs/${jobId}/cancel`, { reason: 'x' })).body,
    ];
    const stored = [
      JSON.stringify((await query('select * from job_event where job_id=$1', [jobId])).rows),
      JSON.stringify((await query('select * from job_attempt where job_id=$1', [jobId])).rows),
      JSON.stringify((await query('select * from job_artifact where job_id=$1', [jobId])).rows),
      JSON.stringify((await query('select * from verification where job_id=$1', [jobId])).rows),
      JSON.stringify((await query('select * from order_snapshot where request_id=$1', [id])).rows),
      JSON.stringify((await query(`select * from audit_log where action ~ '^(job|handoff|order|verification)'`)).rows),
    ];
    const issueText = h.github.issues.map((i) => `${i.title}\n${i.body}`).join('\n');
    for (const text of [...responses, ...stored, issueText]) {
      for (const secret of leak) expect(text.includes(secret), secret === QA_TOKEN ? 'token' : 'secret').toBe(false);
      expect(text.includes(contact), 'contact').toBe(false);
    }
    // 依頼に保存する連絡先以外の接続情報も無い
    for (const text of [...responses, ...stored]) expect(text).not.toMatch(/postgres(ql)?:\/\//);
    const access = h.github.access.map((a) => `${a.path}${a.query}`).join('\n');
    expect(access).not.toContain(QA_TOKEN);
    // 外部応答は last_error に500文字までで、intent の外へ出ていない
    const [intent] = await h.intents(id);
    expect((intent.last_error ?? '').length).toBeLessThanOrEqual(500);
  });

  it('外部の長い応答は last_error で切られ、DB の CHECK に当たらず unknown / failed を記録する', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const long: FakeResponder = () => ({ status: 422, body: { message: 'x'.repeat(5000) } });
    await expect(
      handoffOrder(
        { requestId: id, orderVersion: version },
        h.actor('desk'),
        'c',
        h.deps({ issueAdapter: h.armedAdapter([long]) }),
      ),
    ).rejects.toMatchObject({ code: 'ERR-304' });
    const [intent] = await h.intents(id);
    expect(intent.state).toBe('failed');
    expect(intent.last_error.length).toBeLessThanOrEqual(500);
  });

  it('検証の段階の未知の内容で PR 候補を壊さない', async () => {
    const id = await h.approvedRequest();
    const { jobId, headSha } = await h.untilVerifying(id);
    const result = await recordVerification(
      h.delivery(jobId, headSha, { stages: [...stages(), { stage: 'extra', status: 'passed' }] }),
    );
    expect(result.jobState).toBe('pr_ready');
  });
});
