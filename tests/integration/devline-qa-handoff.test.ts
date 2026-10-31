/**
 * QA: 冪等 handoff（T-20〜T-42, T-93）。
 * 同時実行は Promise で実際に並行させる。応答喪失は fake サーバが作成してから接続を切る本物の切断で作る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/api/audit.js';
import { query } from '../../src/api/db.js';
import { handoffOrder, type DevlineDeps } from '../../src/api/devline-service.js';
import { createFakeIssueAdapter } from '../../src/api/issue-adapter-fake.js';
import { handoffToGithub } from '../../src/api/service.js';
import { HANDOFF_POLICY, parseHandoffMarker } from '../../src/shared/devline.js';
import { FAKE_LOGIN, FAKE_REPO, FAKE_REPO_ID, type FakeResponder } from './fake-github-server.js';
import { loginWithRoles, useHarness, withDbFault } from './devline-qa-harness.js';

const h = useHarness();

/** 結果不明を作るときの1回を除いた POST の数。 */
let basePosts = 0;
const newPosts = (): number => h.posts() - basePosts;
beforeEach(() => {
  basePosts = 0;
});

/** 作成してから応答を失う（本物の接続断）。 */
const createThenCut: FakeResponder = ({ body }) => {
  h.github.addForeignIssue({ title: body.title, body: body.body, login: FAKE_LOGIN });
  return { status: 0, destroy: true };
};
const cutOnly: FakeResponder = () => ({ status: 0, destroy: true });
const never: FakeResponder = () => new Promise(() => undefined);

async function run(id: string, version: number, deps: DevlineDeps, role: 'desk' | 'approver' = 'desk', confirm?: string) {
  return handoffOrder(
    { requestId: id, orderVersion: version, ...(confirm === undefined ? {} : { confirmAbsent: { reason: confirm } }) },
    h.actor(role),
    `qa-${Math.random()}`,
    deps,
  );
}

/** 応答を失って unknown にして、そのときのマーカーを返す。 */
async function makeUnknown(id: string, reply: FakeResponder = cutOnly): Promise<{ version: number; marker: string }> {
  const version = await h.orderVersion(id);
  let marker = '';
  const real = h.armedAdapter([reply]);
  const deps = h.deps({
    issueAdapter: {
      ...real,
      createIssue: (input) => {
        marker = input.body.split('\n')[0] as string;
        return real.createIssue(input);
      },
    },
  });
  await expect(run(id, version, deps)).rejects.toMatchObject({ code: 'ERR-304', details: { handoffState: 'unknown' } });
  expect((await h.intents(id))[0].state).toBe('unknown');
  basePosts = h.posts();
  return { version, marker };
}

describe('T-20・T-21: 通常の投入と再投入', () => {
  it('T-20: Issue 1つ、intent succeeded、issue_no、job queued、本文1行目がマーカー。監査が順に残る', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['contentSha256', 'created', 'issueNo', 'issueUrl', 'jobId', 'jobState', 'op', 'orderVersion', 'requestId'].sort(),
    );
    expect(body).toMatchObject({ requestId: id, orderVersion: version, created: true, op: 'create_issue', jobState: 'queued' });
    expect(h.github.issues).toHaveLength(1);
    const issue = h.github.issues[0]!;
    expect(issue.title).toContain(id);
    expect(issue.number).toBe(body.issueNo);
    expect(parseHandoffMarker(issue.body)).toMatchObject({
      requestId: id,
      orderVersion: version,
      op: 'create_issue',
      repo: FAKE_REPO,
    });
    const [intent] = await h.intents(id);
    expect(intent).toMatchObject({ state: 'succeeded', issue_no: body.issueNo, op_kind: 'create_issue', attempts: 1 });
    expect((await h.detail(id)).issueNo).toBe(body.issueNo);
    const actions = (
      await query<any>(`select action from audit_log where target_id in ($1,$2) order by id`, [id, body.jobId])
    ).rows.map((r) => r.action);
    const seq = ['order.snapshot', 'handoff.intent', 'handoff.sent', 'handoff.succeeded', 'job.create'];
    expect(actions.filter((a) => seq.includes(a))).toEqual(seq);
  });

  it('T-21: 同じ版の再投入で Issue が増えず created=false、同じ jobId。旧ルートでも増えない', async () => {
    const id = await h.approvedRequest();
    const first = (await h.handoff(id)).json();
    for (let i = 0; i < 3; i += 1) {
      const again = await h.handoff(id);
      expect(again.json()).toMatchObject({
        created: false,
        jobId: first.jobId,
        issueNo: first.issueNo,
        contentSha256: first.contentSha256,
      });
    }
    const legacy = await h.api('POST', `/api/requests/${id}/handoff`);
    expect(legacy.json()).toMatchObject({ created: false, issueNo: first.issueNo });
    expect(h.posts()).toBe(1);
    expect(await h.count('from job where request_id=$1', [id])).toBe(1);
    expect(await h.count('from order_snapshot where request_id=$1', [id])).toBe(1);
  });

  it('T-93: 同じ POST の再実行で監査・履歴が増えない。照合で回収した後も増えない', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, createThenCut);
    await run(id, version, h.deps());
    const audits = await h.count('from audit_log');
    const history = await h.count('from request_history where request_id=$1', [id]);
    const events = await h.count('from job_event');
    for (let i = 0; i < 3; i += 1) await run(id, version, h.deps());
    expect(await h.count('from audit_log')).toBe(audits);
    expect(await h.count('from request_history where request_id=$1', [id])).toBe(history);
    expect(await h.count('from job_event')).toBe(events);
  });
});

describe('T-22・T-23: 並行と順序', () => {
  it('T-22: 5並列の投入で Issue は1つ。外部の応答を待たせても他は ERR-301 で待たずに返る', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    let settled = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    h.github.onWrite = async () => {
      if (settled < 4) await Promise.race([gate, new Promise((r) => setTimeout(r, 5000))]);
    };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        run(id, version, h.deps()).finally(() => {
          settled += 1;
          if (settled >= 4) release();
          return i;
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason.code).toBe('ERR-301');
    }
    expect(ok.filter((r) => (r as PromiseFulfilledResult<any>).value.created)).toHaveLength(1);
    expect(h.github.issues).toHaveLength(1);
    expect(h.posts()).toBe(1);
    expect(await h.count('from job where request_id=$1', [id])).toBe(1);
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('T-22: API-06 と旧ルートの同時投入でも Issue は1つ（扉が2つでも重複しない）', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const [a, b] = await Promise.all([
      h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version }),
      h.api('POST', `/api/requests/${id}/handoff`),
    ]);
    expect([a.statusCode, b.statusCode]).toContain(200);
    for (const res of [a, b]) if (res.statusCode !== 200) expect(res.json().error.code).toBe('ERR-301');
    expect(h.github.issues).toHaveLength(1);
    expect(h.posts()).toBe(1);
  });

  it('T-23: 作成・PATCH の受信時点で intent は別接続から sent に見え、snapshot と監査 handoff.sent も commit 済み', async () => {
    const id = await h.approvedRequest();
    const seen: any[] = [];
    h.github.onWrite = async () => {
      const intents = await h.intents(id);
      seen.push({
        state: intents.at(-1).state,
        sentAt: intents.at(-1).sent_at,
        snapshots: await h.count('from order_snapshot where request_id=$1', [id]),
        audits: await h.count(`from audit_log where action='handoff.sent' and target_id=$1`, [id]),
      });
    };
    expect((await h.handoff(id)).statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ state: 'sent', snapshots: 1, audits: 1 });
    expect(seen[0].sentAt).toBeTruthy();
    await h.reapprove(id, '二つ目');
    expect((await h.handoff(id)).statusCode).toBe(200);
    expect(seen[1]).toMatchObject({ state: 'sent', snapshots: 2, audits: 2 });
  });
});

describe('T-24〜T-26: 結果不明', () => {
  it('T-24: 作成後に切断 → unknown・ERR-304。再投入で回収して Issue は1つ、POST は1回、created=false', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, createThenCut);
    expect(h.github.issues).toHaveLength(1);
    expect((await h.detail(id)).issueNo).toBeNull();
    expect(await h.count('from job where request_id=$1', [id])).toBe(0);

    const recovered = await run(id, version, h.deps());
    expect(recovered).toMatchObject({ created: false, issueNo: h.github.issues[0]!.number, jobState: 'queued' });
    expect(h.posts()).toBe(1);
    const [intent] = await h.intents(id);
    expect(intent.state).toBe('succeeded');
    expect(intent.reconciled_at).toBeTruthy();
    expect(intent.last_outcome).toBe('recovered_by_reconcile');
    expect((await h.detail(id)).issueNo).toBe(h.github.issues[0]!.number);
  });

  it('T-25: 外部成功の後に DB が失敗 → 500 で sent のまま。期限前は ERR-301、期限後は照合で回収し、再送しない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    // claim の commit が失敗したら外部へ送らない
    const res = await withDbFault({ table: 'handoff_intent', when: 'update of state' }, async () =>
      h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version }),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('qa_injected_fault');
    expect(newPosts()).toBe(0);
    const [before] = await h.intents(id);
    expect(before.state).toBe('intent');

    const outcome = await withDbFault({ table: 'request', when: 'update of issue_no' }, async () =>
      h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version }),
    );
    expect(outcome.statusCode).toBe(500);
    expect(outcome.body).not.toContain('qa_injected_fault');
    expect(h.posts()).toBe(1);
    expect(h.github.issues).toHaveLength(1);
    const [sent] = await h.intents(id);
    expect(sent.state).toBe('sent'); // 確定は丸ごと戻る
    expect((await h.detail(id)).issueNo).toBeNull();
    expect(await h.count('from job where request_id=$1', [id])).toBe(0);

    // 期限前は別の処理の最中とみなす（境界の1ms前も）
    h.advance(HANDOFF_POLICY.sentStaleMs - 1);
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-301' });
    expect(h.posts()).toBe(1);

    h.advance(1);
    const recovered = await run(id, version, h.deps());
    expect(recovered).toMatchObject({ created: false, issueNo: h.github.issues[0]!.number });
    expect(h.posts()).toBe(1);
    expect(h.github.issues).toHaveLength(1);
    expect(await h.count('from job where request_id=$1', [id])).toBe(1);
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('T-25: sent のまま落ちて Issue が無いときは unknown へ倒れ、再送しない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const crashing = h.deps({
      issueAdapter: {
        ...h.adapter(),
        createIssue: async () => {
          // 外部へ届く前にプロセスが落ちた場面。例外で「送ったかもしれない」へ倒れた後、sent に戻す
          throw new Error('crash');
        },
      },
    });
    await expect(run(id, version, crashing)).rejects.toMatchObject({ code: 'ERR-304' });
    expect((await h.intents(id))[0].state).toBe('unknown');
    await query(`update handoff_intent set state='sent', sent_at=$2 where request_id=$1`, [id, h.clock()]);
    h.advance(HANDOFF_POLICY.sentStaleMs);
    await expect(run(id, version, h.deps())).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown', scanComplete: true },
    });
    expect((await h.intents(id))[0].state).toBe('unknown');
    expect(newPosts()).toBe(0);
  });

  it('intent を commit した直後に落ちた（claim の前）: 外部へは未送信で、再投入で1回だけ送る', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const real = h.adapter();
    let repoReads = 0;
    const flaky = h.deps({
      issueAdapter: {
        ...real,
        getRepoId: async (repo, signal) => {
          repoReads += 1;
          return repoReads === 2 ? { ok: false, reason: 'network' } : real.getRepoId(repo, signal);
        },
      },
    });
    await expect(run(id, version, flaky)).rejects.toMatchObject({ code: 'ERR-304' });
    expect((await h.intents(id))[0].state).toBe('intent');
    expect(newPosts()).toBe(0);
    const done = await run(id, version, h.deps());
    expect(done.created).toBe(true);
    expect(h.posts()).toBe(1);
  });

  it('T-26: 本物の時間切れは API-06 で ERR-303 / 504、unknown に倒れ、応答後に作成されていれば回収できる', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const deps = h.deps({ issueAdapter: h.armedAdapter([never]), httpTimeoutMs: 100 });
    await expect(run(id, version, deps)).rejects.toMatchObject({
      code: 'ERR-303',
      statusCode: 504,
      details: { handoffState: 'unknown' },
    });
    expect((await h.intents(id))[0].state).toBe('unknown');
    // タイムアウト後の照合: 実は作られていた
    const marker = (await h.intents(id))[0].marker as string;
    h.github.addForeignIssue({ body: `${marker}\n本文`, login: FAKE_LOGIN });
    const recovered = await run(id, version, h.deps());
    expect(recovered).toMatchObject({ created: false, issueNo: h.github.issues[0]!.number });
    expect(h.posts()).toBe(1);
  });

  it('T-26: 旧ルートの時間切れは ERR-304 / 502（HTTP と同じ応答の形）', async () => {
    const id = await h.approvedRequest();
    await expect(
      handoffToGithub(id, h.actor('desk'), 'c', h.deps({ issueAdapter: h.armedAdapter([never]), httpTimeoutMs: 100 })),
    ).rejects.toMatchObject({ code: 'ERR-304', statusCode: 502 });
    expect((await h.intents(id))[0].state).toBe('unknown');
  });

  it.each([
    ['500', { status: 500, body: { message: 'boom' } }],
    ['502', { status: 502, rawBody: '<html>bad gateway</html>' }],
    ['503', { status: 503, body: {} }],
    ['408', { status: 408, body: {} }],
    ['301', { status: 301, headers: { location: 'http://127.0.0.1:9/evil' }, body: {} }],
    ['2xx で壊れた本文', { status: 201, rawBody: 'not json' }],
    ['2xx で number なし', { status: 201, body: { html_url: 'x' } }],
    ['200 で number が0', { status: 200, body: { number: 0, html_url: 'x' } }],
  ])('T-26: %s は unknown で ERR-304。盲目的に再送しない', async (_label, reply) => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, (() => reply) as FakeResponder);
    const posts = h.posts();
    await expect(run(id, version, h.deps())).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown', scanComplete: true },
    });
    expect(h.posts()).toBe(posts);
    expect((await h.intents(id))[0].state).toBe('unknown');
    // 3xx の Location へ token を付けて行かない
    expect(h.github.access.every((a) => a.path.startsWith('/repos/') || a.path === '/user')).toBe(true);
  });

  it('5xx を返しつつ実は作成されていた場合も、照合で回収して重複しない', async () => {
    const id = await h.approvedRequest();
    const created: FakeResponder = ({ body }) => {
      h.github.addForeignIssue({ title: body.title, body: body.body, login: FAKE_LOGIN });
      return { status: 502, rawBody: 'bad gateway' };
    };
    const { version } = await makeUnknown(id, created);
    const done = await run(id, version, h.deps());
    expect(done.created).toBe(false);
    expect(h.github.issues).toHaveLength(1);
    expect(h.posts()).toBe(1);
  });
});

describe('T-27・T-28: 確定した失敗と混雑', () => {
  it.each([400, 401, 403, 404, 410, 422])(
    'T-27: %i は failed で ERR-304。再投入で同じ intent を再送でき、本文は同じ',
    async (status) => {
      const id = await h.approvedRequest();
      const version = await h.orderVersion(id);
      const sentBodies: string[] = [];
      const reject: FakeResponder = ({ body }) => {
        sentBodies.push(body.body);
        return { status, body: { message: 'no' } };
      };
      await expect(run(id, version, h.deps({ issueAdapter: h.armedAdapter([reject]) }))).rejects.toMatchObject({
        code: 'ERR-304',
        statusCode: 502,
        details: { handoffState: 'failed', httpStatus: status },
      });
      const [failed] = await h.intents(id);
      expect(failed).toMatchObject({ state: 'failed', attempts: 1, last_http_status: status });
      const done = await run(id, version, h.deps());
      expect(done.created).toBe(true);
      expect(h.github.issues).toHaveLength(1);
      expect(h.github.issues[0]!.body).toBe(sentBodies[0]);
      expect((await h.intents(id))[0]).toMatchObject({ state: 'succeeded', attempts: 2 });
    },
  );

  it.each([
    ['429', { status: 429, body: {} }],
    ['429 Retry-After', { status: 429, headers: { 'retry-after': '60' }, body: {} }],
    ['403 Retry-After', { status: 403, headers: { 'retry-after': '60' }, body: {} }],
  ])('T-28: %s は failed と next_attempt_at。その前の再投入は ERR-302 で fake サーバに1回も届かない', async (_label, reply) => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const first = run(id, version, h.deps({ issueAdapter: h.armedAdapter([(() => reply) as FakeResponder]) }));
    await expect(first).rejects.toMatchObject({ code: 'ERR-302', statusCode: 429 });
    const [intent] = await h.intents(id);
    expect(intent.state).toBe('failed');
    expect(intent.next_attempt_at.getTime()).toBe(h.clock().getTime() + 60_000);

    const access = h.github.access.length;
    await expect(run(id, version, h.deps())).rejects.toMatchObject({
      code: 'ERR-302',
      details: { nextAttemptAt: intent.next_attempt_at.toISOString() },
    });
    h.advance(59_999);
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-302' });
    expect(h.github.access.length).toBe(access);

    h.advance(1);
    expect((await run(id, version, h.deps())).created).toBe(true);
    expect(h.github.issues).toHaveLength(1);
  });

  it('T-28: HTTP の API-06 は 429 で返す', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await expect(
      run(id, version, h.deps({ issueAdapter: h.armedAdapter([() => ({ status: 429, body: {} })]) })),
    ).rejects.toBeTruthy();
    const res = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('ERR-302');
  });
});

describe('T-29・T-30: 見つからない unknown と confirm_absent', () => {
  it('T-29: confirm_absent なしでは何度投入しても再送せず unknown のまま', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    for (let i = 0; i < 3; i += 1) {
      await expect(run(id, version, h.deps())).rejects.toMatchObject({
        code: 'ERR-304',
        details: { handoffState: 'unknown', scanComplete: true },
      });
    }
    expect(newPosts()).toBe(0);
    expect(h.github.issues).toHaveLength(0);
    expect((await h.intents(id))[0].state).toBe('unknown');
  });

  it('T-30: HTTP: 理由なしは ERR-102、desk は ERR-101、approver で再作成。監査と記録が残る', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    const post = (payload: object) => h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version, ...payload });

    await h.setRole('approver');
    for (const payload of [
      { confirmAbsent: true },
      { confirmAbsent: true, reason: '' },
      { confirmAbsent: true, reason: '   ' },
    ]) {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ERR-102');
    }
    const deskOnly = await loginWithRoles(h.app, 'qa-desk-only@example.com', ['desk']);
    const desk = await h.api(
      'POST',
      `/api/orders/${id}/handoff`,
      { orderVersion: version, confirmAbsent: true, reason: '確認した' },
      deskOnly,
    );
    expect(desk.statusCode).toBe(403);
    expect(desk.json().error.code).toBe('ERR-101');
    expect(await h.count(`from audit_log where result='denied' and target_id=$1`, [id])).toBe(1);
    expect(newPosts()).toBe(0);

    const ok = await post({ confirmAbsent: true, reason: '画面で無いことを確認した' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ created: true });
    expect(h.github.issues).toHaveLength(1);
    const [intent] = await h.intents(id);
    expect(intent.confirmed_absent_by).toBe(h.auth.user.id);
    expect(intent.confirmed_absent_reason).toBe('画面で無いことを確認した');
    expect(intent.attempts).toBe(2);
    const audit = (
      await query<any>(`select diff, actor_user_id, role from audit_log where action='handoff.confirm_absent' and target_id=$1`, [
        id,
      ])
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ role: 'approver', actor_user_id: h.auth.user.id });
    expect(audit[0].diff.reason).toBe('画面で無いことを確認した');
  });

  it('T-30: confirm_absent を付けても Issue が見つかれば回収し、作らない', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, createThenCut);
    const done = await run(id, version, h.deps(), 'approver', '無いと思う');
    expect(done.created).toBe(false);
    expect(h.posts()).toBe(1);
    expect(h.github.issues).toHaveLength(1);
    expect(await h.count(`from audit_log where action='handoff.confirm_absent'`)).toBe(0);
  });

  it('confirm_absent で再作成の応答も失われたら unknown に戻り、もう一度の確認なしには作らない', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    await expect(
      run(id, version, h.deps({ issueAdapter: h.armedAdapter([cutOnly]) }), 'approver', '確認した'),
    ).rejects.toMatchObject({
      code: 'ERR-304',
    });
    expect((await h.intents(id))[0].state).toBe('unknown');
    const posts = h.posts();
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-304' });
    expect(h.posts()).toBe(posts);
  });

  it('成功済みの版に confirm_absent を付けても何も作らない', async () => {
    const id = await h.approvedRequest();
    const first = (await h.handoff(id)).json();
    const done = await run(id, first.orderVersion, h.deps(), 'approver', '念のため');
    expect(done).toMatchObject({ created: false, jobId: first.jobId });
    expect(h.posts()).toBe(1);
    expect(await h.count(`from audit_log where action='handoff.confirm_absent'`)).toBe(0);
  });
});

describe('T-31〜T-34: 照合', () => {
  it('T-31: 2ページ目で見つける。state=all と since（intent の5分前）で問い合わせ、PR は除外する', async () => {
    const id = await h.approvedRequest();
    const { version, marker } = await makeUnknown(id);
    const created = (await h.intents(id))[0].created_at as Date;
    for (let i = 0; i < HANDOFF_POLICY.reconcilePerPage; i += 1) h.github.addForeignIssue({ body: 'noise', login: 'someone' });
    h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN, pull_request: {} });
    const mine = h.github.addForeignIssue({ body: `${marker}\r\n本文`, login: FAKE_LOGIN, title: 'closed issue' });
    const done = await run(id, version, h.deps());
    expect(done).toMatchObject({ created: false, issueNo: mine.number });
    const lists = h.github.access.filter((a) => a.method === 'GET' && a.path.endsWith('/issues'));
    expect(lists.length).toBe(2);
    for (const list of lists) {
      const q = new URLSearchParams(list.query);
      expect(q.get('state')).toBe('all'); // closed も見る（既定の open だけでは見つからない）
      expect(q.get('since')).toBe(new Date(created.getTime() - 5 * 60_000).toISOString());
    }
    expect(new URLSearchParams(lists[1]!.query).get('page')).toBe('2');
  });

  it('T-32: reconcileMaxPages で切れたら confirm_absent があっても再送しない', async () => {
    const id = await h.approvedRequest();
    const { version, marker } = await makeUnknown(id);
    const pages = HANDOFF_POLICY.reconcileMaxPages * HANDOFF_POLICY.reconcilePerPage;
    for (let i = 0; i < pages; i += 1) h.github.addForeignIssue({ body: 'noise', login: 'someone' });
    const beyond = h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN });
    await expect(run(id, version, h.deps(), 'approver', '確認した')).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown', scanComplete: false },
    });
    expect(newPosts()).toBe(0);
    expect((await h.intents(id))[0].state).toBe('unknown');
    expect(await h.count('from handoff_intent where issue_no=$1', [beyond.number])).toBe(0);
    expect(h.github.access.filter((a) => a.method === 'GET' && a.path.endsWith('/issues')).length).toBe(
      HANDOFF_POLICY.reconcileMaxPages,
    );
  });

  it.each([
    ['途中のページで 500', [null, null, () => ({ status: 500, body: {} })]],
    ['1ページ目で切断', [null, () => ({ status: 0, destroy: true })]],
    ['/user が 401', [() => ({ status: 401, body: {} })]],
    ['配列でない応答', [null, () => ({ status: 200, body: { oops: true } })]],
    ['読めない行が混ざる', [null, () => ({ status: 200, body: [{ number: 'x' }] })]],
  ])('T-32: %s は走査が不完全で、confirm_absent があっても再送しない', async (_label, script) => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    for (let i = 0; i < HANDOFF_POLICY.reconcilePerPage + 1; i += 1)
      h.github.addForeignIssue({ body: 'noise', login: 'someone' });
    for (const step of script) h.github.overrides.push((step ?? (() => null)) as FakeResponder);
    await expect(run(id, version, h.deps(), 'approver', '確認した')).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown', scanComplete: false },
    });
    expect(newPosts()).toBe(0);
    h.github.overrides.length = 0;
  });

  it('T-33: 第三者が作った同じマーカーの Issue を一致させない。自分のものがあれば第三者の番号が小さくても自分を選ぶ', async () => {
    const id = await h.approvedRequest();
    const { version, marker } = await makeUnknown(id);
    const mallory = h.github.addForeignIssue({ body: marker, login: 'mallory' });
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-304', details: { handoffState: 'unknown' } });
    expect((await h.detail(id)).issueNo).toBeNull();
    const mine = h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN });
    expect(mallory.number).toBeLessThan(mine.number);
    expect((await run(id, version, h.deps())).issueNo).toBe(mine.number);
  });

  it('T-33: 第三者のマーカーだけなら、権限者の confirm_absent で自分の Issue を作り、第三者の Issue を PATCH しない', async () => {
    const id = await h.approvedRequest();
    const { version, marker } = await makeUnknown(id);
    const mallory = h.github.addForeignIssue({ body: marker, login: 'mallory' });
    const done = await run(id, version, h.deps(), 'approver', '第三者の Issue だった');
    expect(done.issueNo).not.toBe(mallory.number);
    expect(h.github.issues.find((i) => i.number === mallory.number)?.body).toBe(marker);
  });

  it('同じマーカーの自分の Issue が2件あれば小さい番号を正とし、残りを監査に残す', async () => {
    const id = await h.approvedRequest();
    const { version, marker } = await makeUnknown(id);
    const a = h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN });
    const b = h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN });
    expect((await run(id, version, h.deps())).issueNo).toBe(a.number);
    const audit = (await query<any>(`select diff from audit_log where action='handoff.succeeded' and target_id=$1`, [id])).rows;
    expect(audit[0].diff.duplicates).toEqual([b.number]);
  });
});

describe('T-35〜T-39: 版が上がったとき', () => {
  it('T-35: 再承認した版の投入は同じ Issue を PATCH。Issue は増えず、issue_no は同じ、intent は版ごと', async () => {
    const id = await h.approvedRequest();
    const first = (await h.handoff(id)).json();
    const requestVersion = (await h.detail(id)).version;
    const v2 = await h.reapprove(id, '二つ目の目的');
    expect((await h.detail(id)).version).toBeGreaterThan(requestVersion);
    const second = (await h.handoff(id)).json();
    expect(second).toMatchObject({ op: 'update_issue', issueNo: first.issueNo, created: true, orderVersion: v2 });
    expect(h.github.issues).toHaveLength(1);
    expect(h.posts()).toBe(1);
    expect(h.github.access.filter((a) => a.method === 'PATCH')).toHaveLength(1);
    expect(parseHandoffMarker(h.github.issues[0]!.body)).toMatchObject({ orderVersion: v2, op: 'update_issue' });
    expect(h.github.issues[0]!.body).toContain('二つ目の目的');
    expect((await h.detail(id)).issueNo).toBe(first.issueNo);
    const intents = await h.intents(id);
    expect(intents.map((i) => [i.op_kind, i.state, i.target_issue_no])).toEqual([
      ['create_issue', 'succeeded', null],
      ['update_issue', 'succeeded', first.issueNo],
    ]);
  });

  it('T-35: 既存データのように issue_no だけある依頼は、作らず PATCH する', async () => {
    const id = await h.approvedRequest();
    const existing = h.github.addForeignIssue({ body: '旧版で作った Issue', login: FAKE_LOGIN });
    await query('update request set issue_no=$2 where id=$1', [id, existing.number]);
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ op: 'update_issue', issueNo: existing.number });
    expect(newPosts()).toBe(0);
    expect(h.github.issues).toHaveLength(1);
  });

  it('update の応答喪失: PATCH が届いていれば回収、届いていなければ同じ本文を再送、Issue は増えない', async () => {
    const id = await h.approvedRequest();
    await h.handoff(id);
    const v2 = await h.reapprove(id, '二つ目');
    const patchThenCut: FakeResponder = ({ body }) => {
      h.github.issues[0]!.body = body.body;
      return { status: 0, destroy: true };
    };
    await expect(run(id, v2, h.deps({ issueAdapter: h.armedAdapter([patchThenCut]) }))).rejects.toMatchObject({
      code: 'ERR-304',
    });
    expect((await h.intents(id)).at(-1).state).toBe('unknown');
    const patches = h.github.access.filter((a) => a.method === 'PATCH').length;
    const recovered = await run(id, v2, h.deps());
    expect(recovered).toMatchObject({ created: false, op: 'update_issue' });
    expect(h.github.access.filter((a) => a.method === 'PATCH').length).toBe(patches);

    const v3 = await h.reapprove(id, '三つ目');
    await expect(run(id, v3, h.deps({ issueAdapter: h.armedAdapter([cutOnly]) }))).rejects.toMatchObject({ code: 'ERR-304' });
    const resent = await run(id, v3, h.deps());
    expect(resent).toMatchObject({ op: 'update_issue', created: true });
    expect(parseHandoffMarker(h.github.issues[0]!.body)?.orderVersion).toBe(v3);
    expect(h.github.issues).toHaveLength(1);
    expect(h.posts()).toBe(1);
  });

  it('T-36: v1 create が unknown のあいだ v2 は作らない（照合はする）。回収すると v2 は update_issue', async () => {
    const id = await h.approvedRequest();
    const { marker } = await makeUnknown(id);
    const v2 = await h.reapprove(id, '二つ目');
    await expect(run(id, v2, h.deps())).rejects.toMatchObject({ code: 'ERR-304', details: { scanComplete: true } });
    expect(newPosts()).toBe(0);
    expect(await h.count('from handoff_intent where request_id=$1 and order_version=$2', [id, v2])).toBe(0);
    const mine = h.github.addForeignIssue({ body: marker, login: FAKE_LOGIN });
    const done = await run(id, v2, h.deps());
    expect(done).toMatchObject({ op: 'update_issue', issueNo: mine.number, created: true });
    expect(h.github.issues).toHaveLength(1);
  });

  it('T-36: v1 create が sent（期限前）のあいだ v2 は ERR-301', async () => {
    const id = await h.approvedRequest();
    await makeUnknown(id);
    await query(`update handoff_intent set state='sent', sent_at=$2 where request_id=$1`, [id, h.clock()]);
    const v2 = await h.reapprove(id, '二つ目');
    await expect(run(id, v2, h.deps())).rejects.toMatchObject({ code: 'ERR-301' });
    expect(newPosts()).toBe(0);
  });

  it('T-37: v2 の後に v1 を指定: v1 が failed でも ERR-202 で外部へ送らず、v2 の本文が上書きされない', async () => {
    const id = await h.approvedRequest();
    const v1 = await h.orderVersion(id);
    await expect(
      run(id, v1, h.deps({ issueAdapter: h.armedAdapter([() => ({ status: 422, body: {} })]) })),
    ).rejects.toMatchObject({ code: 'ERR-304' });
    expect((await h.intents(id))[0].state).toBe('failed');
    const v2 = await h.reapprove(id, '二つ目');
    const second = await run(id, v2, h.deps());
    expect(second.op).toBe('create_issue');
    const body = h.github.issues[0]!.body;
    const access = h.github.access.length;

    const stale = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: v1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ERR-202');
    expect(h.github.access.length).toBe(access);
    expect(h.github.issues[0]!.body).toBe(body);
  });

  it('T-37: v1 の intent が intent のままでも ERR-202 で送らず、v2 の投入で failed に閉じる', async () => {
    const id = await h.approvedRequest();
    const v1 = await h.orderVersion(id);
    const real = h.adapter();
    let reads = 0;
    const flaky = h.deps({
      issueAdapter: {
        ...real,
        getRepoId: async (repo, signal) => {
          reads += 1;
          return reads === 2 ? { ok: false, reason: 'network' } : real.getRepoId(repo, signal);
        },
      },
    });
    await expect(run(id, v1, flaky)).rejects.toMatchObject({ code: 'ERR-304' });
    expect((await h.intents(id))[0].state).toBe('intent');
    const v2 = await h.reapprove(id, '二つ目');
    await expect(run(id, v1, h.deps())).rejects.toMatchObject({ code: 'ERR-202' });
    expect(newPosts()).toBe(0);
    const done = await run(id, v2, h.deps());
    expect(done.op).toBe('create_issue');
    expect((await h.intents(id)).map((i) => i.state)).toEqual(['failed', 'succeeded']);
    expect(h.github.issues).toHaveLength(1);
  });

  it('T-38: 外部呼び出しのあいだに取り消された: intent succeeded、issue_no は入る、job は作らず ERR-202。再投入でも作らない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    h.github.onWrite = async () => {
      await h.transition(id, { to: 'cancel', reason: '取り消す' });
    };
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-202' });
    h.github.onWrite = null;
    expect((await h.intents(id))[0].state).toBe('succeeded');
    const row = (await query<any>('select issue_no, status from request where id=$1', [id])).rows[0];
    expect(row).toMatchObject({ issue_no: h.github.issues[0]!.number, status: 'cancel' });
    expect(await h.count('from job where request_id=$1', [id])).toBe(0);
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-202' });
    expect(await h.count('from job where request_id=$1', [id])).toBe(0);
    expect(h.posts()).toBe(1);
  });

  it('T-39: 再承認で古い job が queued → cancelled、実行中 → stopped、pr_ready は superseded_at だけ', async () => {
    const { runOnce } = await import('../../src/worker/loop.js');
    // queued
    const q = await h.approvedRequest();
    const qJob = (await h.handoff(q)).json().jobId;
    await h.reapprove(q, '版を上げる');
    await h.handoff(q);
    expect(await h.view(qJob)).toMatchObject({ state: 'cancelled', stopReason: 'order_superseded' });
    expect((await h.view(qJob)).supersededAt).toBeTruthy();

    // 実行中。遅れた worker の書き込みは捨てられる
    await query(
      `update job set state='cancelled', stop_reason='human_stop', remaining_work='{}', stopped_at=now(), resume_to='queued' where state='queued'`,
    );
    const r = await h.approvedRequest();
    const rJob = (await h.handoff(r)).json().jobId;
    const options = h.worker('success');
    await runOnce(options); // planning
    await h.reapprove(r, '版を上げる');
    await h.handoff(r);
    expect(await h.view(rJob)).toMatchObject({ state: 'stopped', stopReason: 'order_superseded', orderCurrent: false });
    await query(
      `update job set state='cancelled', stop_reason='human_stop', remaining_work='{}', stopped_at=now(), resume_to='queued' where state='queued'`,
    );

    // pr_ready
    const p = await h.approvedRequest();
    const { jobId: pJob } = await h.untilPrReady(p);
    await h.reapprove(p, '版を上げる');
    const newer = (await h.handoff(p)).json();
    const view = await h.view(pJob);
    expect(view).toMatchObject({ state: 'pr_ready', orderCurrent: false, stopReason: null });
    expect(view.supersededAt).toBeTruthy();
    expect(newer.jobId).not.toBe(pJob);
    expect((await verifyAuditChain()).ok).toBe(true);
  });
});

describe('T-40: 旧ルートの互換', () => {
  it('応答の形・issue_no 済みは外部へ行かない・権限（依頼者は 403 で監査 denied）', async () => {
    const id = await h.approvedRequest();
    const res = await h.api('POST', `/api/requests/${id}/handoff`);
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['created', 'detail', 'issueNo', 'issueUrl']);
    expect(res.json().detail.issueNo).toBe(res.json().issueNo);

    const access = h.github.access.length;
    const again = await h.api('POST', `/api/requests/${id}/handoff`);
    expect(again.json()).toMatchObject({ created: false, issueNo: res.json().issueNo });
    expect(h.github.access.length).toBe(access);

    const other = await h.approvedRequest();
    await h.setRole('requester');
    const denied = await h.api('POST', `/api/requests/${other}/handoff`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ERR-101');
    expect(await h.count(`from audit_log where action='handoff.intent' and result='denied' and target_id=$1`, [other])).toBe(1);
    await h.setRole('desk');
  });

  it('接続できないは ERR-304 / 502。狭まる2点（dev の未投入・user id なし）は ERR-205', async () => {
    const down = await h.approvedRequest();
    await expect(
      handoffToGithub(down, h.actor('desk'), 'c', h.deps({ issueAdapter: h.armedAdapter([cutOnly]) })),
    ).rejects.toMatchObject({
      code: 'ERR-304',
      statusCode: 502,
    });
    const dev = await h.approvedRequest();
    await h.transition(dev, { to: 'dev' });
    expect((await h.api('POST', `/api/requests/${dev}/handoff`)).json().error.code).toBe('ERR-205');
    const noUser = await h.approvedRequest();
    await query('update approval set approver_user_id=null where request_id=$1', [noUser]);
    expect((await h.api('POST', `/api/requests/${noUser}/handoff`)).json().error.code).toBe('ERR-205');
  });
});

describe('T-41: 対象リポジトリと空の許可リスト', () => {
  it('許可リストの外・空は ERR-405 で外部へ1通も届かない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    for (const allowedRepos of [
      [],
      [{ name: 'other/repo', repoId: '1' }],
      [{ name: FAKE_REPO.toUpperCase(), repoId: FAKE_REPO_ID }],
    ]) {
      await expect(run(id, version, h.deps({ allowedRepos }))).rejects.toMatchObject({ code: 'ERR-405', statusCode: 409 });
    }
    expect(h.github.access).toHaveLength(0);
    expect(await h.intents(id)).toHaveLength(0);
    expect(await h.count('from order_snapshot where request_id=$1', [id])).toBe(0);
  });

  it('数値 ID の不一致（名前の付け替え）は ERR-405 で書き込まない。読めないときも書き込まない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await expect(run(id, version, h.deps({ allowedRepos: [{ name: FAKE_REPO, repoId: '999' }] }))).rejects.toMatchObject({
      code: 'ERR-405',
    });
    expect(h.writes()).toBe(0);
    h.github.overrides.push(() => ({ status: 500, body: {} }));
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-304' });
    expect(h.writes()).toBe(0);
  });

  it('再送の前にも数値 ID を確かめる（unknown の確認後にリポジトリが変わった）', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    await expect(
      run(id, version, h.deps({ allowedRepos: [{ name: FAKE_REPO, repoId: '999' }] }), 'approver', '確認した'),
    ).rejects.toMatchObject({ code: 'ERR-405' });
    expect(newPosts()).toBe(0);
  });

  it('本文で repo を指定できない（無視され、許可された対象にだけ届く）', async () => {
    const id = await h.approvedRequest();
    const res = await h.handoff(id, {
      repo: 'evil/repo',
      targetRepo: 'evil/repo',
      targetRepoId: 'evil/repo',
      allowedRepos: ['evil/repo'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.intents(id))[0].target_repo_id).toBe(FAKE_REPO);
    expect(h.github.access.every((a) => !a.path.includes('evil'))).toBe(true);
  });

  it('別のリポジトリへ成功済みの依頼は ERR-405 で、無関係な Issue を上書きしない', async () => {
    const id = await h.approvedRequest();
    await h.handoff(id);
    const v2 = await h.reapprove(id, '二つ目');
    const fake = createFakeIssueAdapter({ repoIds: { 'other/repo': '77' } });
    await expect(
      run(id, v2, h.deps({ issueAdapter: fake, targetRepo: 'other/repo', allowedRepos: [{ name: 'other/repo', repoId: '77' }] })),
    ).rejects.toMatchObject({ code: 'ERR-405' });
    expect(fake.calls.filter((c) => c.method === 'updateIssue' || c.method === 'createIssue')).toHaveLength(0);
  });

  it('別のリポジトリの create が unknown の依頼は、対象を変えても作らない（作成済みかもしれない）', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, createThenCut);
    const fake = createFakeIssueAdapter({ repoIds: { 'other/repo': '77' } });
    await expect(
      run(
        id,
        version,
        h.deps({ issueAdapter: fake, targetRepo: 'other/repo', allowedRepos: [{ name: 'other/repo', repoId: '77' }] }),
      ),
    ).rejects.toMatchObject({ code: 'ERR-405' });
    expect(fake.issues).toHaveLength(0);
  });
});

describe('T-42: 版はそのままで依頼が無効になった', () => {
  it('failed の intent があるまま取消: 再投入は ERR-205 で外部へ送らない（読み取りも）', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await expect(
      run(id, version, h.deps({ issueAdapter: h.armedAdapter([() => ({ status: 422, body: {} })]) })),
    ).rejects.toMatchObject({
      code: 'ERR-304',
    });
    await h.transition(id, { to: 'cancel', reason: '取り消す' });
    const access = h.github.access.length;
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-205' });
    expect(h.github.access.length).toBe(access);
  });

  it('failed の intent があるまま差戻し: 再投入は ERR-205', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await expect(
      run(id, version, h.deps({ issueAdapter: h.armedAdapter([() => ({ status: 422, body: {} })]) })),
    ).rejects.toMatchObject({
      code: 'ERR-304',
    });
    await h.transition(id, { to: 'dev' });
    await h.transition(id, { to: 'wait', reason: '戻す' });
    await h.setRole('approver');
    await h.transition(id, { to: 'back', reason: '差し戻す' });
    await h.setRole('desk');
    expect(await h.orderVersion(id)).toBe(version);
    basePosts = h.posts();
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-205' });
    expect(newPosts()).toBe(0);
  });

  it('unknown のまま取消: 照合だけ行い、見つかれば記録して job は作らず ERR-202', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id, createThenCut);
    await h.transition(id, { to: 'cancel', reason: '取り消す' });
    await expect(run(id, version, h.deps())).rejects.toMatchObject({ code: 'ERR-202' });
    expect((await h.intents(id))[0].state).toBe('succeeded');
    expect((await query<any>('select issue_no from request where id=$1', [id])).rows[0].issue_no).toBe(
      h.github.issues[0]!.number,
    );
    expect(await h.count('from job where request_id=$1', [id])).toBe(0);
    expect(h.posts()).toBe(1);
  });

  it('unknown のまま取消で見つからない: confirm_absent があっても送らず unknown のまま', async () => {
    const id = await h.approvedRequest();
    const { version } = await makeUnknown(id);
    await h.transition(id, { to: 'cancel', reason: '取り消す' });
    await expect(run(id, version, h.deps(), 'approver', '確認した')).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown' },
    });
    expect(newPosts()).toBe(0);
    expect((await h.intents(id))[0].state).toBe('unknown');
  });

  it('claim の直前に無効になった: sent にせず送らない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const real = h.adapter();
    const racing = h.deps({
      issueAdapter: {
        ...real,
        // claim の直前の読み取りのあいだに取り消す
        getRepoId: async (repo, signal) => {
          const got = await real.getRepoId(repo, signal);
          if ((await h.intents(id)).length > 0) await query(`update request set status='cancel', deleted=true where id=$1`, [id]);
          return got;
        },
      },
    });
    await expect(run(id, version, racing)).rejects.toMatchObject({ code: 'ERR-205' });
    expect(newPosts()).toBe(0);
    expect((await h.intents(id))[0].state).toBe('intent');
  });
});
