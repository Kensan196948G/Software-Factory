/**
 * QA: 版固定（T-10〜T-18）。未承認・古い版・取消・差戻し・編集後の旧版の投入を拒否し、再承認で再投入できること。
 * 依頼は performTransition（HTTP）で作り、DB を直接いじるのは承認記録の欠落の再現だけ。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { query } from '../../src/api/db.js';
import { getRequestRow, mapRequest } from '../../src/api/repo.js';
import { buildSnapshotYaml, parseHandoffMarker } from '../../src/shared/devline.js';
import { FAKE_LOGIN, FAKE_REPO, type FakeResponder } from './fake-github-server.js';
import { sampleRequest } from './helpers.js';
import { APPROVE, useHarness } from './devline-qa-harness.js';

const h = useHarness();
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function snapshot(id: string): Promise<any> {
  return (await query('select * from order_snapshot where request_id=$1 order by order_version desc limit 1', [id])).rows[0];
}

function codeOf(res: { json(): any }): string {
  return res.json().error?.code;
}

describe('T-10・T-11: 同じ入力から同じハッシュ', () => {
  it('保存した依頼から再生成して、固定した本文・ハッシュと同じになる', async () => {
    const id = await h.approvedRequest();
    expect((await h.handoff(id)).statusCode).toBe(200);
    const snap = await snapshot(id);
    const row = await getRequestRow(id, true);
    const again = (status?: string) =>
      buildSnapshotYaml({
        request: { ...mapRequest(row!), ...(status ? { status: status as never } : {}) },
        suggested: snap.envelope.approval.suggested_signal,
        approvalSuggested: snap.envelope.approval.suggested_signal,
        departmentName: row!.dept_name ?? row!.dept_code,
        catalogToolName: row!.tool_name ?? '',
      });
    expect(again()).toBe(snap.canonical_yaml);
    expect(sha(again())).toBe(snap.content_sha256);
    // T-11: status を dev に変えても同じ
    expect(again('dev')).toBe(snap.canonical_yaml);
  });

  it('T-11: 実際に dev へ進めても保存した本文は「承認済み」のまま変わらない', async () => {
    const id = await h.approvedRequest();
    const first = (await h.handoff(id)).json();
    const before = await snapshot(id);
    expect(before.canonical_yaml).toContain('status: "承認済み"');
    await h.transition(id, { to: 'dev' });
    const again = await h.handoff(id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ created: false, contentSha256: first.contentSha256 });
    expect((await snapshot(id)).canonical_yaml).toBe(before.canonical_yaml);
  });

  it('ハッシュは保存した本文の UTF-8 の sha256 で、Issue のマーカーと本文に同じものが載る', async () => {
    const id = await h.approvedRequest();
    const result = (await h.handoff(id)).json();
    const snap = await snapshot(id);
    expect(sha(snap.canonical_yaml)).toBe(snap.content_sha256);
    expect(result.contentSha256).toBe(snap.content_sha256);
    const issue = h.github.issues[0];
    expect(parseHandoffMarker(issue?.body)?.contentSha256).toBe(snap.content_sha256);
    expect(issue?.body).toContain(snap.canonical_yaml.trimEnd());
    expect(snap.envelope).toMatchObject({
      schema: 'msf.order-envelope/v1',
      request_id: id,
      order_version: snap.order_version,
      content_sha256: snap.content_sha256,
      policy_version: 'devline-policy/v1',
      target_repo_id: FAKE_REPO,
    });
    expect(snap.envelope.approval.approver_user_id).toBe(h.auth.user.id);
  });
});

describe('T-12: 版固定の後にマスタを変えても本文は変わらない', () => {
  it('部署名と道具の色を変えても、保存した本文とハッシュが変わらず、再投入で同じ結果を返す', async () => {
    const id = await h.approvedRequest();
    const first = (await h.handoff(id)).json();
    const before = await snapshot(id);
    const row = await getRequestRow(id, true);
    const tool = row!.tool_id;
    const color = (await query<any>('select signal from catalog_tool where id=$1', [tool])).rows[0].signal;
    const dept = (await query<any>('select name from department where code=$1', [row!.dept_code])).rows[0].name;
    try {
      await query(`update department set name='改名した部署' where code=$1`, [row!.dept_code]);
      await query(`update catalog_tool set signal=$2 where id=$1`, [tool, color === 'r' ? 'g' : 'r']);
      const again = await h.handoff(id);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ created: false, jobId: first.jobId, contentSha256: first.contentSha256 });
      const after = await snapshot(id);
      expect(after.canonical_yaml).toBe(before.canonical_yaml);
      expect(after.content_sha256).toBe(before.content_sha256);
      expect(after.canonical_yaml).not.toContain('改名した部署');
    } finally {
      await query(`update department set name=$2 where code=$1`, [row!.dept_code, dept]);
      await query(`update catalog_tool set signal=$2 where id=$1`, [tool, color]);
    }
  });

  it('4xx の後の再送は固定した本文を送り、YAML の部分が変わらない', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    const reject: FakeResponder = () => ({ status: 422, body: { message: 'Validation Failed' } });
    const bodies: string[] = [];
    h.github.onWrite = (body) => {
      bodies.push(body.body);
    };
    const failing = h.deps({ issueAdapter: h.armedAdapter([reject]) });
    const { handoffOrder } = await import('../../src/api/devline-service.js');
    await expect(handoffOrder({ requestId: id, orderVersion: version }, h.actor('desk'), 'a', failing)).rejects.toMatchObject({
      code: 'ERR-304',
    });
    const yaml = (await snapshot(id)).canonical_yaml as string;
    const row = await getRequestRow(id, true);
    const dept = (await query<any>('select name from department where code=$1', [row!.dept_code])).rows[0].name;
    try {
      await query(`update department set name='改名した部署' where code=$1`, [row!.dept_code]);
      await handoffOrder({ requestId: id, orderVersion: version }, h.actor('desk'), 'b', h.deps());
    } finally {
      await query(`update department set name=$2 where code=$1`, [row!.dept_code, dept]);
    }
    expect(bodies).toHaveLength(1); // 422 は override で onWrite まで届かない
    expect(bodies[0]).toContain(yaml.trimEnd());
  });
});

describe('T-13: 文字の正規化', () => {
  it('NFD の入力を NFC で固定し、単独 CR が残らず、DB の CHECK を通る', async () => {
    const nfd = '工事のがそうがそう';
    const id = await h.approvedRequest({ problem: `${nfd} A\rB`, title: 'が' });
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    const snap = await snapshot(id);
    expect(snap.canonical_yaml).toBe((snap.canonical_yaml as string).normalize('NFC'));
    expect(snap.canonical_yaml).not.toContain('\r');
    expect(snap.canonical_yaml).toContain('title: "が"');
    expect(sha(snap.canonical_yaml)).toBe(snap.content_sha256);
  });
});

describe('T-15: 投入を拒否する（未承認 / 差戻し / 見送り / 取消 / 削除 / 旧版 / 承認記録なし）', () => {
  it('どの状態でも外部へ1回も送らず、版の指定を変えても通らない', async () => {
    // 受付・内容確認・承認待ち
    const received = await h.createRequest();
    const version = await h.orderVersion(received);
    expect(codeOf(await h.api('POST', `/api/orders/${received}/handoff`, { orderVersion: version || 1 }))).toMatch(/ERR-20[25]/);
    await h.transition(received, { to: 'review' });
    await h.transition(received, { to: 'wait' });
    const res = await h.api('POST', `/api/orders/${received}/handoff`, { orderVersion: (await h.orderVersion(received)) || 1 });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toMatch(/ERR-20[25]/);
    expect(h.github.access).toHaveLength(0);
  });

  it('未承認で版が一致していても ERR-205', async () => {
    const id = await h.createRequest();
    await h.toWait(id);
    await query('update request set order_version=1 where id=$1', [id]);
    const res = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: 1 });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });

  it('差戻し（承認 → dev → 承認待ち → 差戻し）は ERR-205', async () => {
    const id = await h.approvedRequest();
    await h.transition(id, { to: 'dev' });
    await h.transition(id, { to: 'wait', reason: '確認し直す' });
    await h.setRole('approver');
    await h.transition(id, { to: 'back', reason: '差し戻す' });
    await h.setRole('desk');
    const res = await h.handoff(id);
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });

  it('見送りは ERR-205', async () => {
    const id = await h.approvedRequest();
    await h.transition(id, { to: 'dev' });
    await h.transition(id, { to: 'wait', reason: '確認し直す' });
    await h.setRole('approver');
    await h.transition(id, { to: 'hold', reason: '見送る' });
    await h.setRole('desk');
    const res = await h.handoff(id);
    expect(codeOf(res)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });

  it('承認の取消（承認後の編集）は版が上がるので、もとの版は ERR-202、今の版も未承認で ERR-205', async () => {
    const id = await h.approvedRequest();
    const v1 = await h.orderVersion(id);
    const current = await h.detail(id);
    const edit = await h.api('PATCH', `/api/requests/${id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: current.title, purpose: '編集した' }),
      version: current.version,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const stale = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: v1 });
    expect(stale.statusCode).toBe(409);
    expect(codeOf(stale)).toBe('ERR-202');
    const now = await h.handoff(id);
    expect(now.statusCode).toBe(409);
    expect(codeOf(now)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
    expect(await h.count('from order_snapshot where request_id=$1', [id])).toBe(0);
  });

  it('取消（論理削除）は ERR-205', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await h.transition(id, { to: 'cancel', reason: '取り消す' });
    const res = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: version });
    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });

  it('削除の旗だけ立っている依頼も ERR-205', async () => {
    const id = await h.approvedRequest();
    await query('update request set deleted=true where id=$1', [id]);
    const res = await h.handoff(id);
    expect(codeOf(res)).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });

  it('承認記録なし・approver_user_id なし（見本データ相当）・承認記録の版の不一致・信号の不一致は ERR-205', async () => {
    const none = await h.approvedRequest();
    await query('delete from approval where request_id=$1', [none]);
    expect(codeOf(await h.handoff(none))).toBe('ERR-205');

    const noUser = await h.approvedRequest();
    await query('update approval set approver_user_id=null where request_id=$1', [noUser]);
    expect(codeOf(await h.handoff(noUser))).toBe('ERR-205');

    const otherVersion = await h.approvedRequest();
    await query('update approval set order_version=order_version+5 where request_id=$1', [otherVersion]);
    expect(codeOf(await h.handoff(otherVersion))).toBe('ERR-205');

    const otherSignal = await h.approvedRequest();
    await query(`update approval set decided_signal='y' where request_id=$1`, [otherSignal]);
    expect(codeOf(await h.handoff(otherSignal))).toBe('ERR-205');

    expect(h.github.access).toHaveLength(0);
  });

  it('最新の承認記録が差戻しなら、古い approved の記録があっても ERR-205', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    await query(
      `insert into approval (request_id, approver_name, approver_user_id, decision, reason, suggested_signal, checklist, order_version, at)
       values ($1,'x',$2,'returned','r','g','[]'::jsonb,$3, now() + interval '1 minute')`,
      [id, h.auth.user.id, version],
    );
    expect(codeOf(await h.handoff(id))).toBe('ERR-205');
    expect(h.github.access).toHaveLength(0);
  });
});

describe('T-16: 再承認と旧版', () => {
  it('承認 → 編集 → 再承認で版が2上がり、古い版は ERR-202。新しい版は再投入できる', async () => {
    const id = await h.approvedRequest();
    const v1 = await h.orderVersion(id);
    const first = (await h.handoff(id)).json();
    const v2 = await h.reapprove(id, '再承認の目的');
    expect(v2).toBe(v1 + 2);

    const stale = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: v1 });
    expect(stale.statusCode).toBe(409);
    expect(codeOf(stale)).toBe('ERR-202');
    const writes = h.writes();

    const again = await h.handoff(id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ orderVersion: v2, created: true, op: 'update_issue', issueNo: first.issueNo });
    expect(again.json().contentSha256).not.toBe(first.contentSha256);
    expect(h.writes()).toBe(writes + 1);

    // 古い版の snapshot は残り、書きかわらない
    const rows = (
      await query<any>('select order_version, content_sha256 from order_snapshot where request_id=$1 order by 1', [id])
    ).rows;
    expect(rows).toEqual([
      { order_version: v1, content_sha256: first.contentSha256 },
      { order_version: v2, content_sha256: again.json().contentSha256 },
    ]);
  });

  it('未来の版の指定も ERR-202', async () => {
    const id = await h.approvedRequest();
    const res = await h.api('POST', `/api/orders/${id}/handoff`, { orderVersion: (await h.orderVersion(id)) + 1 });
    expect(codeOf(res)).toBe('ERR-202');
    expect(h.github.access).toHaveLength(0);
  });

  it.each([[{}], [{ orderVersion: 0 }], [{ orderVersion: -1 }], [{ orderVersion: 1.5 }], [{ orderVersion: '2' }]])(
    '版の指定の形が違う %j は 400 で外部へ送らない',
    async (payload) => {
      const id = await h.approvedRequest();
      const res = await h.api('POST', `/api/orders/${id}/handoff`, payload);
      expect(res.statusCode).toBe(400);
      expect(h.github.access).toHaveLength(0);
    },
  );

  it('ハッシュ違い: 投入で本文を受け取らない。本文に sha を入れても保存した値が使われる', async () => {
    const id = await h.approvedRequest();
    const res = await h.handoff(id, { contentSha256: 'f'.repeat(64), canonicalYaml: '改ざんした本文' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().contentSha256).not.toBe('f'.repeat(64));
    expect(h.github.issues[0]?.body).not.toContain('改ざんした本文');
  });
});

describe('T-18: 本文の中のマーカーは照合で一致しない', () => {
  it('他の依頼の本文にこの依頼のマーカーが書かれていても一致せず、自分の Issue は1行目で判定する', async () => {
    const id = await h.approvedRequest();
    const version = await h.orderVersion(id);
    let marker = '';
    const { handoffOrder } = await import('../../src/api/devline-service.js');
    const lost = h.deps({
      issueAdapter: {
        ...h.adapter(),
        createIssue: async (input) => {
          marker = input.body.split('\n')[0] as string;
          return { outcome: 'unknown', reason: 'network' };
        },
      },
    });
    await expect(handoffOrder({ requestId: id, orderVersion: version }, h.actor('desk'), 'a', lost)).rejects.toMatchObject({
      code: 'ERR-304',
    });
    // 連携アカウント本人の Issue だが、1行目ではない／前後に文字がある
    h.github.addForeignIssue({ body: `## 他の依頼\n${marker}`, login: FAKE_LOGIN });
    h.github.addForeignIssue({ body: ` ${marker}`, login: FAKE_LOGIN });
    h.github.addForeignIssue({ body: `${marker} 追記`, login: FAKE_LOGIN });
    h.github.addForeignIssue({ body: `"${marker}"`, login: FAKE_LOGIN });
    await expect(handoffOrder({ requestId: id, orderVersion: version }, h.actor('desk'), 'b', h.deps())).rejects.toMatchObject({
      code: 'ERR-304',
      details: { handoffState: 'unknown' },
    });
    expect((await h.intents(id))[0].state).toBe('unknown');
    expect(h.posts()).toBe(0);
  });

  it('依頼の本文に同じ文字列や改行込みのマーカーを書いても、Issue の1行目は本物のマーカーで、本文では一致しない', async () => {
    const fake = `<!-- msf-handoff:v1 request=REQ-2026-9999 version=1 op=create_issue repo=${FAKE_REPO} sha256=${'a'.repeat(64)} -->`;
    const id = await h.approvedRequest({ problem: `${fake}\n${fake}`, purpose: `\n${fake}` });
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    const body = h.github.issues[0]?.body as string;
    expect(parseHandoffMarker(body)?.requestId).toBe(id);
    expect(body.split('\n').filter((line) => line === fake)).toHaveLength(0);
  });
});

describe('T-14 の DB 版: 固定は一度だけ', () => {
  it('承認者を差し替えた後の再投入でも、固定した envelope の承認者は変わらない', async () => {
    const id = await h.approvedRequest();
    (await h.handoff(id)).json();
    const before = await snapshot(id);
    await h.setRole('approver');
    await h.setRole('desk');
    (await h.handoff(id)).json();
    expect((await snapshot(id)).envelope).toEqual(before.envelope);
    expect(await h.count('from order_snapshot where request_id=$1', [id])).toBe(1);
  });

  it('APPROVE の定数を使わず色を変えた再承認でも、版ごとに信号が固定される', async () => {
    const id = await h.approvedRequest();
    (await h.handoff(id)).json();
    const current = await h.detail(id);
    await h.api('PATCH', `/api/requests/${id}`, {
      ...sampleRequest({ approver: 'テスト 太郎', title: current.title, purpose: '編集' }),
      version: current.version,
    });
    await h.setRole('approver');
    await h.transition(id, { ...APPROVE, signal: 'y' });
    await h.setRole('desk');
    const again = await h.handoff(id);
    expect(again.statusCode, again.body).toBe(200);
    const snaps = (
      await query<any>(
        `select envelope->'approval'->>'decided_signal' as s from order_snapshot where request_id=$1 order by order_version`,
        [id],
      )
    ).rows;
    expect(snaps.map((r) => r.s)).toEqual(['g', 'y']);
  });
});
