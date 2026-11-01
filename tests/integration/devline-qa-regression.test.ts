/**
 * QA: 回帰（T-90）。devline の行がある状態で既存の F1/F2/F3、下書き、メール、CSV/YAML、監査が動くこと。
 * 既存の試験（T-92）は pnpm test 全体で実行する。
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/api/audit.js';
import { query } from '../../src/api/db.js';
import { deliverPendingMail } from '../../src/api/mail-outbox.js';
import { importAll, resetDemo } from '../../src/api/service.js';
import { runUntilIdle } from '../../src/worker/loop.js';
import { useHarness } from './devline-qa-harness.js';
import { sampleRequest } from './helpers.js';

const h = useHarness();
const DEVLINE_TABLES = ['verification', 'job_artifact', 'job_event', 'job_attempt', 'job', 'handoff_intent', 'order_snapshot'];

/** 正常・修正・停止・取消・再承認が混ざった状態を作る。 */
async function devlineActivity(): Promise<{ ids: string[] }> {
  const ok = await h.approvedRequest();
  await h.handoff(ok);
  await runUntilIdle(h.worker('success'));
  const fixed = await h.approvedRequest();
  await h.handoff(fixed);
  await runUntilIdle(h.worker('test_fail_then_fix'));
  const stopped = await h.approvedRequest();
  await h.handoff(stopped);
  await runUntilIdle(h.worker('same_cause_fail'));
  const cancelled = await h.approvedRequest();
  const job = (await h.handoff(cancelled)).json().jobId;
  await h.api('POST', `/api/jobs/${job}/cancel`, { reason: '止める' });
  const again = await h.approvedRequest();
  await h.handoff(again);
  await h.reapprove(again, '二つ目');
  await h.handoff(again);
  await runUntilIdle(h.worker('success'));
  return { ids: [ok, fixed, stopped, cancelled, again] };
}

describe('T-90: デモ初期化と取込', () => {
  it('devline の行があるとき resetDemo は成功して devline の表は空。その後また投入できる（非本番）', async () => {
    await devlineActivity();
    for (const t of DEVLINE_TABLES) expect(await h.count(`from ${t}`), t).toBeGreaterThan(0);
    await expect(resetDemo(h.actor('approver'), 'c')).resolves.toMatchObject({ ok: true });
    for (const t of DEVLINE_TABLES) expect(await h.count(`from ${t}`), t).toBe(0);
    expect(await h.count('from request')).toBeGreaterThan(0);
    expect((await verifyAuditChain()).ok).toBe(true);

    const id = await h.approvedRequest();
    expect((await h.handoff(id)).statusCode).toBe(200);
    await runUntilIdle(h.worker('success'));
    expect(await h.count(`from job where request_id=$1 and state='pr_ready'`, [id])).toBe(1);
  });

  it('HTTP の reset-demo も devline の行があって成功する（ERR-401 にならない）', async () => {
    await devlineActivity();
    const res = await h.api('POST', '/api/admin/reset-demo', {});
    expect(res.statusCode, res.body).toBe(200);
  });

  it('importAll は devline の行があると ERR-201 で理由を示し、既存データが残る（HTTP でも）', async () => {
    const { ids } = await devlineActivity();
    const requests = await h.count('from request');
    await expect(importAll({ items: [] }, h.actor('approver'), 'c')).rejects.toMatchObject({ code: 'ERR-201' });
    const res = await h.api('POST', '/api/import', { items: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ERR-201');
    expect(res.json().error.message).toContain('開発ライン');
    expect(await h.count('from request')).toBe(requests);
    for (const id of ids) expect((await h.api('GET', `/api/requests/${id}`)).statusCode).toBe(200);
    for (const t of DEVLINE_TABLES) expect(await h.count(`from ${t}`), t).toBeGreaterThan(0);
  });

  it('importAll は devline の行が無ければ従来どおり全置換できる', async () => {
    const id = await h.createRequest();
    const exported = (await h.api('GET', '/api/export.json')).json();
    const res = await h.api('POST', '/api/import', exported);
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.api('GET', `/api/requests/${id}`)).statusCode).toBe(200);
  });
});

describe('devline の後も既存の機能が動く', () => {
  it('F1: 依頼の登録と冪等キー、F2: 承認、F3: 進める・差し戻す・見る', async () => {
    await devlineActivity();
    await h.setRole('requester');
    const key = `qa-key-${Date.now()}`;
    const post = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { cookie: h.auth.cookie, 'x-csrf-token': h.auth.csrf, origin: 'http://127.0.0.1:8781', 'idempotency-key': key },
        payload: sampleRequest({ approver: 'テスト 太郎', title: '回帰の依頼' }),
      });
    const first = await post();
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().request.id as string;
    expect((await post()).json().request.id).toBe(id);

    await h.setRole('desk');
    await h.toWait(id);
    await h.setRole('approver');
    await h.transition(id, { to: 'back', reason: '差し戻す' });
    await h.setRole('requester');
    await h.transition(id, { to: 'received' });
    await h.setRole('desk');
    await h.toWait(id);
    await h.setRole('approver');
    await h.transition(id, { to: 'approved', signal: 'g', checklistAcknowledged: true, reason: '承認' });
    await h.setRole('desk');
    await h.transition(id, { to: 'dev' });
    await h.transition(id, { to: 'verify' });
    expect((await h.detail(id)).status).toBe('verify');

    const list = await h.api('GET', '/api/requests?q=回帰');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(id);
    expect((await h.api('GET', '/api/home')).statusCode).toBe(200);
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it('投入で version が上がっても、最新の version で人の遷移と編集ができる（古い version は ERR-301）', async () => {
    const id = await h.approvedRequest();
    const before = (await h.detail(id)).version;
    await h.handoff(id);
    expect((await h.detail(id)).version).toBe(before + 1);
    const stale = await h.api('POST', `/api/requests/${id}/transitions`, { version: before, to: 'dev' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ERR-301');
    await h.transition(id, { to: 'dev' });
    const detail = await h.detail(id);
    expect(detail.status).toBe('dev');
    expect(detail.history.some((row: any) => row.action === '開発ラインへ投入')).toBe(true);
  });

  it('worker が動いている間の人の遷移を楽観ロックで邪魔しない', async () => {
    const id = await h.approvedRequest();
    await h.handoff(id);
    const { version } = await h.detail(id);
    await runUntilIdle(h.worker('success'));
    const res = await h.api('POST', `/api/requests/${id}/transitions`, { version, to: 'dev' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('下書き: 作成・更新・削除が動く', async () => {
    await devlineActivity();
    const created = await h.api('POST', '/api/drafts', { draft: { title: '下書き' }, step: 1 });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const draftId = created.json().id ?? created.json().item?.id ?? created.json().draft?.id;
    expect(draftId).toBeTruthy();
    expect((await h.api('PUT', `/api/drafts/${draftId}`, { draft: { title: '更新' }, step: 2 })).statusCode).toBe(200);
    const list = await h.api('GET', '/api/drafts');
    expect(JSON.stringify(list.json())).toContain('更新');
    expect((await h.api('DELETE', `/api/drafts/${draftId}`)).statusCode).toBe(200);
  });

  it('メール: 承認依頼が積まれて送信BOXへ書き出され、再承認の分も別に積まれる', async () => {
    await devlineActivity();
    await query('delete from mail_outbox');
    const outbox = resolve(process.cwd(), '.mail/test-outbox');
    const id = await h.createRequest();
    await h.toWait(id);
    expect(await h.count('from mail_outbox where request_id=$1', [id])).toBe(1);
    await deliverPendingMail();
    expect(await h.count(`from mail_outbox where request_id=$1 and status='sent'`, [id])).toBe(1);
    await h.setRole('approver');
    await h.transition(id, { to: 'approved', signal: 'g', checklistAcknowledged: true, reason: '承認' });
    await h.setRole('desk');
    await h.handoff(id);
    await h.reapprove(id, '編集');
    expect(await h.count('from mail_outbox where request_id=$1', [id])).toBe(2);
    rmSync(outbox, { recursive: true, force: true });
  });

  it('CSV / JSON / 注文書 YAML が devline の後も同じ形で出る。投入後の YAML の形式も変わらない', async () => {
    const { ids } = await devlineActivity();
    const csv = await h.api('GET', '/api/export.csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body.split('\n')[0]?.split(',')).toHaveLength(11);
    const json = await h.api('GET', '/api/export.json');
    expect(json.statusCode).toBe(200);
    const items = json.json().items as any[];
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(ids));
    const handed = items.find((i) => i.id === ids[0]);
    expect(handed.issueNo).toBeTruthy();

    const order = await h.api('GET', `/api/requests/${ids[0]}/order`);
    expect(order.statusCode, order.body).toBe(200);
    const yaml = order.json().yaml as string;
    const snapshot = (await query<any>('select canonical_yaml from order_snapshot where request_id=$1', [ids[0]])).rows[0]
      .canonical_yaml;
    // 状態がまだ approved なら、注文書の取得と固定した本文は同じ文面になる
    expect(yaml).toBe(snapshot);
    const keys = yaml
      .split('\n')
      .filter((l) => /^[a-z_]+:/.test(l))
      .map((l) => l.split(':')[0]);
    expect(keys).toEqual([
      'schema_version',
      'order_version',
      'id',
      'title',
      'kind',
      'department',
      'catalog_tool',
      'requested_by',
      'approver',
      'status',
      'signal',
      'problem',
      'purpose',
      'users',
      'places',
      'scope',
      'out_of_scope',
      'acceptance_criteria',
      'constraints',
      'data_handling',
      'parties',
      'requires_human_approval',
      'measure',
      'requested_at',
      'wish_date',
    ]);
  });

  it('監査ログの API と CSV が devline の操作を含めて読め、ハッシュ連鎖が検証に通る', async () => {
    await devlineActivity();
    const logs = await h.api('GET', '/api/audit-logs?pageSize=200');
    expect(logs.statusCode, logs.body).toBe(200);
    expect(JSON.stringify(logs.json())).toContain('job.transition');
    const csv = await h.api('GET', '/api/audit-logs.csv');
    expect(csv.statusCode).toBe(200);
    const chain = await verifyAuditChain();
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBeGreaterThan(20);
    const stats = await h.api('GET', '/api/admin/stats');
    expect(stats.statusCode, stats.body).toBe(200);
  });

  it('監査の連鎖は並行の devline 操作でも切れない（handoff / cancel / worker / 検証を同時に）', async () => {
    const a = await h.approvedRequest();
    const b = await h.approvedRequest();
    const c = await h.approvedRequest();
    const first = (await h.handoff(a)).json();
    const second = (await h.handoff(b)).json();
    await Promise.all([
      h.handoff(c),
      h.api('POST', `/api/jobs/${first.jobId}/cancel`, { reason: '止める' }),
      runUntilIdle(h.worker('success', { owner: 'x' })),
      h.api('GET', `/api/jobs/${second.jobId}`),
      h.api('POST', `/api/jobs/${first.jobId}/cancel`, { reason: 'もう一度' }),
    ]);
    await runUntilIdle(h.worker('success', { owner: 'y' }));
    expect((await verifyAuditChain()).ok).toBe(true);
  });
});
