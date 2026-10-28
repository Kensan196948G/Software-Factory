import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authHeaders,
  buildTestApp,
  loginAs,
  loginAsMember,
  prepareTestDb,
  sampleRequest,
  TEST_MEMBER,
  TEST_USER,
  truncateBusiness,
} from './helpers.js';
import { query } from '../../src/api/db.js';
import { config } from '../../src/api/config.js';

let app: FastifyInstance;

interface MailRow {
  id: string;
  request_id: string | null;
  kind: string;
  to_email: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  last_error: string | null;
}

beforeAll(async () => {
  await prepareTestDb();
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await truncateBusiness();
});

async function createRequestAs(
  auth: Awaited<ReturnType<typeof loginAs>>,
  overrides: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: authHeaders(auth),
    payload: sampleRequest(overrides),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { request: { id: string; version: number } }).request;
}

async function moveToWait(auth: Awaited<ReturnType<typeof loginAs>>, id: string, version: number) {
  const review = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(auth),
    payload: { to: 'review', version },
  });
  expect(review.statusCode).toBe(200);
  const v2 = (review.json() as { detail: { version: number } }).detail.version;
  const wait = await app.inject({
    method: 'POST',
    url: `/api/requests/${id}/transitions`,
    headers: authHeaders(auth),
    payload: { to: 'wait', version: v2 },
  });
  expect(wait.statusCode).toBe(200);
  return wait.json() as { detail: { version: number }; warnings: { code: string; message: string }[] };
}

async function mailsOf(requestId: string): Promise<MailRow[]> {
  const { rows } = await query<MailRow>('select * from mail_outbox where request_id = $1 order by id', [requestId]);
  return rows;
}

describe('承認依頼メール', () => {
  it('承認待ちになると1通積まれ、送信BOXへ書き出され、送信済みになる', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    const result = await moveToWait(auth, created.id, created.version);
    expect(result.detail.version).toBe(3);
    expect(result.warnings.map((w) => w.code)).not.toContain('INFO-002');

    const mails = await mailsOf(created.id);
    expect(mails).toHaveLength(1);
    const mail = mails[0]!;
    expect(mail.kind).toBe('approval_request');
    // 承認者欄はメール形式ではないため、設定の控え宛先（テスト環境）へ送る
    expect(mail.to_email).toBe('approver@example.com');
    expect(mail.subject).toContain(created.id);
    expect(mail.subject).toContain('承認依頼');
    expect(mail.body).toContain('承認待ち');
    expect(mail.body).toContain('受付番号: ' + created.id);
    expect(mail.body).toContain('承認する画面: ');
    expect(mail.status).toBe('sent');
    expect(mail.attempts).toBe(1);
    expect(mail.last_error).toBeNull();

    // 依頼詳細にもメールの状態が出る（画面の依頼詳細で表示する）
    const detail = await app.inject({ method: 'GET', url: `/api/requests/${created.id}`, headers: { cookie: auth.cookie } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { request: { mail: { id: string; status: string; to: string; sentAt: string | null } | null } };
    expect(body.request.mail?.status).toBe('sent');
    expect(body.request.mail?.to).toBe('approver@example.com');
    expect(body.request.mail?.sentAt).toBeTruthy();
  });

  it('承認者のメールが分かればそちらへ送る', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    const user = await query<{ id: string }>('select id from app_user where email = $1', [TEST_USER.email]);
    await query('update request set approver_user_id = $1 where id = $2', [user.rows[0]!.id, created.id]);

    await moveToWait(auth, created.id, created.version);
    const mails = await mailsOf(created.id);
    expect(mails[0]!.to_email).toBe(TEST_USER.email);
  });

  it('送信BOXと件数はAPIで確認でき、未ログインは401', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/mail/outbox' });
    expect(unauth.statusCode).toBe(401);

    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    await moveToWait(auth, created.id, created.version);

    const status = await app.inject({ method: 'GET', url: '/api/mail/status', headers: { cookie: auth.cookie } });
    expect(status.statusCode).toBe(200);
    const summary = status.json() as { mode: string; sent: number; pending: number };
    expect(summary.mode).toBe('file');
    expect(summary.sent).toBeGreaterThanOrEqual(1);

    const outbox = await app.inject({ method: 'GET', url: '/api/mail/outbox?status=sent', headers: { cookie: auth.cookie } });
    expect(outbox.statusCode).toBe(200);
    const items = (outbox.json() as { items: { requestId: string; status: string; subject: string }[] }).items;
    expect(items.some((i) => i.requestId === created.id && i.status === 'sent')).toBe(true);

    const bad = await app.inject({ method: 'GET', url: '/api/mail/outbox?status=bogus', headers: { cookie: auth.cookie } });
    expect(bad.statusCode).toBe(400);
  });

  it('MAIL_MODE=off のときは積まない', async () => {
    const restore = config.mailMode;
    config.mailMode = 'off';
    try {
      const auth = await loginAs(app);
      const created = await createRequestAs(auth);
      await moveToWait(auth, created.id, created.version);
      expect(await mailsOf(created.id)).toHaveLength(0);
    } finally {
      config.mailMode = restore;
    }
  });

  it('送信に失敗しても状態遷移は成功し、failed として残り、再送できる', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'msf-outbox-'));
    const notADir = join(scratch, 'not-a-dir');
    writeFileSync(notADir, 'これはディレクトリではない');
    const restore = config.mailOutboxDir;
    config.mailOutboxDir = notADir;
    let created: { id: string; version: number };
    let auth: Awaited<ReturnType<typeof loginAs>>;
    try {
      auth = await loginAs(app);
      created = await createRequestAs(auth);
      const result = await moveToWait(auth, created.id, created.version);
      // 業務としては成功し、警告だけが付く
      expect(result.warnings.map((w) => w.code)).toContain('INFO-002');

      const mails = await mailsOf(created.id);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.status).toBe('failed');
      expect(mails[0]!.last_error).toBeTruthy();
    } finally {
      config.mailOutboxDir = restore;
    }

    // 宛先を直して再送すると送信済みになる
    const id = (await mailsOf(created!.id))[0]!.id;
    const retry = await app.inject({
      method: 'POST',
      url: `/api/mail/outbox/${id}/retry`,
      headers: authHeaders(auth!),
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string }).status).toBe('sent');
    rmSync(scratch, { recursive: true, force: true });
  });

  it('承認者欄が利用者と一致すれば、その人を承認者にしてメールを送る', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth, { approver: TEST_MEMBER.displayName });
    const member = await query<{ id: string }>('select id from app_user where email = $1', [TEST_MEMBER.email]);
    const bound = await query<{ approver_user_id: string | null }>('select approver_user_id from request where id = $1', [
      created.id,
    ]);
    expect(bound.rows[0]!.approver_user_id).toBe(member.rows[0]!.id);

    await moveToWait(auth, created.id, created.version);
    const mails = await mailsOf(created.id);
    expect(mails[0]!.to_email).toBe(TEST_MEMBER.email);
  });

  it('承認者が別人なら、ほかの承認者は承認できない', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth, { approver: TEST_MEMBER.displayName });
    await moveToWait(auth, created.id, created.version);

    const approver = await loginAs(app, 'approver');
    const detail = await app.inject({ method: 'GET', url: `/api/requests/${created.id}`, headers: { cookie: approver.cookie } });
    const version = (detail.json() as { request: { version: number } }).request.version;
    const res = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/transitions`,
      headers: authHeaders(approver),
      payload: { to: 'approved', version, signal: 'y', checklistAcknowledged: true },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-201');
  });

  it('滞留通知は1日1回だけ積まれる', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    await moveToWait(auth, created.id, created.version);
    // 5日前から動いていないことにする
    await query(`update request set updated_at = now() - interval '5 days' where id = $1`, [created.id]);

    const first = await app.inject({
      method: 'POST',
      url: '/api/mail/reminders',
      headers: authHeaders(auth),
      payload: { days: 3 },
    });
    expect(first.statusCode).toBe(200);
    const r1 = first.json() as { queued: number; delivery: { sent: number; failed: number } };
    expect(r1.queued).toBe(1);
    expect(r1.delivery.sent).toBe(1);

    // 同じ日にもう一度回しても増えない（unique: request × kind × 日付）
    const second = await app.inject({
      method: 'POST',
      url: '/api/mail/reminders',
      headers: authHeaders(auth),
      payload: { days: 3 },
    });
    expect((second.json() as { queued: number }).queued).toBe(0);

    const rows = await query<{ kind: string; status: string }>(
      'select kind, status from mail_outbox where request_id = $1 order by id',
      [created.id],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['approval_request', 'reminder']);
    expect(rows.rows[1]!.status).toBe('sent');
  });

  it('滞留通知は管理者だけが実行できる', async () => {
    const member = await loginAsMember(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/reminders',
      headers: authHeaders(member),
      payload: { days: 3 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('状態遷移が失敗（版競合）したときはメールを積まない', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    const res = await app.inject({
      method: 'POST',
      url: `/api/requests/${created.id}/transitions`,
      headers: authHeaders(auth),
      payload: { to: 'review', version: created.version + 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(await mailsOf(created.id)).toHaveLength(0);
  });

  it('送信済み・不正なIDは再送できず、依頼者は再送できない', async () => {
    const auth = await loginAs(app);
    const created = await createRequestAs(auth);
    await moveToWait(auth, created.id, created.version);
    const id = (await mailsOf(created.id))[0]!.id;

    const sentAgain = await app.inject({
      method: 'POST',
      url: `/api/mail/outbox/${id}/retry`,
      headers: authHeaders(auth),
    });
    expect(sentAgain.statusCode).toBe(404);

    const bogus = await app.inject({
      method: 'POST',
      url: '/api/mail/outbox/99999999999999999999/retry',
      headers: authHeaders(auth),
    });
    expect(bogus.statusCode).toBe(404);

    const requester = await loginAsMember(app);
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/mail/outbox/${id}/retry`,
      headers: authHeaders(requester),
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
