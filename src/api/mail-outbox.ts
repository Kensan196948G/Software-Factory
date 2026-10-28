/**
 * 承認依頼メールの送信キュー（mail_outbox）。
 *
 * 設計の要点:
 *  - 積む（enqueue）は業務の状態遷移と同じトランザクションで行う。メールが消えない。
 *  - 送る（deliver）はコミット後。失敗しても状態遷移は巻き戻さない（status='failed' で残す）。
 *  - 送信前に status='sending' へ原子的に移す（claim）。二重送信しない。
 *    送信中のまま落ちた行は、10分後に flush が拾い直す。
 *  - 宛先は「承認者のメール → 依頼の承認者欄がメール形式 → 同じ表示名の利用者 → MAIL_APPROVAL_TO」
 *    の順。どこにも無ければ積まない（架空の宛先へ送らない）。
 */
import type { PoolClient } from 'pg';
import { one, query, withTransaction } from './db.js';
import { appendAuditTx } from './audit.js';
import { config } from './config.js';
import { deliverMail, isEmailAddress, renderApprovalRequest, type MailMode } from './mailer.js';
import type { Signal } from '../shared/domain.js';

export type MailState = 'pending' | 'sending' | 'sent' | 'failed';

/** 送信中のまま放置された行を拾い直すまでの時間。 */
const STALE_CLAIM_MINUTES = 10;

export interface MailActor {
  userId: string;
  displayName: string;
  role: string;
}

/** メール本文に載せる依頼の情報（最小限）。 */
export interface ApprovalMailSource {
  id: string;
  title: string;
  applicant: string;
  deptCode: string;
  approver: string;
  approverUserId: string | null;
  signal: Signal | null;
  criteriaCount: number;
}

export interface MailOutboxItem {
  id: string;
  requestId: string | null;
  kind: string;
  to: string;
  subject: string;
  status: MailState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface MailRow {
  id: string;
  request_id: string | null;
  kind: string;
  to_email: string;
  subject: string;
  body: string;
  status: MailState;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
  claimed_at: Date | null;
}

const SELECT_COLUMNS = `id::text as id, request_id, kind, to_email, subject, body, status, attempts, last_error, created_at, sent_at, claimed_at`;

function toItem(row: Omit<MailRow, 'body'>): MailOutboxItem {
  return {
    id: row.id,
    requestId: row.request_id,
    kind: row.kind,
    to: row.to_email,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
  };
}

/** 承認者の宛先を決める（見つからなければ null＝送らない）。呼び出し側のトランザクション内で使う。 */
async function resolveRecipient(client: PoolClient, source: ApprovalMailSource): Promise<string | null> {
  if (source.approverUserId) {
    const byId = await client.query<{ email: string }>('select email from app_user where id = $1 and is_active', [
      source.approverUserId,
    ]);
    const email = byId.rows[0]?.email;
    if (email && isEmailAddress(email)) return email;
  }

  const declared = (source.approver ?? '').trim();
  if (isEmailAddress(declared)) return declared;

  // 承認者欄は表示名のことが多い（例: 「鈴木 一郎」）。同じ表示名の利用者がいればそのメールを使う。
  if (declared) {
    const byName = await client.query<{ email: string }>(
      'select email from app_user where display_name = $1 and is_active order by created_at limit 1',
      [declared],
    );
    const email = byName.rows[0]?.email;
    if (email && isEmailAddress(email)) return email;
  }

  if (isEmailAddress(config.mailApprovalTo)) return config.mailApprovalTo;
  return null;
}

/**
 * 承認待ちになった依頼のメールを1通積む（呼び出し側のトランザクション内で実行する）。
 * 送らない設定（MAIL_MODE=off）や宛先なしのときは null を返す。
 */
export async function enqueueApprovalMailInTx(
  client: PoolClient,
  source: ApprovalMailSource,
  actor: MailActor,
  correlationId: string,
): Promise<string | null> {
  if (config.mailMode === 'off') return null;
  const to = await resolveRecipient(client, source);
  if (!to) return null;

  const dept = await client.query<{ name: string }>('select name from department where code = $1', [source.deptCode]);
  const mail = renderApprovalRequest({
    requestId: source.id,
    title: source.title,
    applicant: source.applicant,
    deptName: dept.rows[0]?.name ?? source.deptCode,
    signal: source.signal,
    criteriaCount: source.criteriaCount,
    baseUrl: config.appBaseUrl,
  });

  const inserted = await client.query<{ id: string }>(
    `insert into mail_outbox (request_id, kind, to_email, subject, body)
     values ($1, 'approval_request', $2, $3, $4)
     returning id::text as id`,
    [source.id, to, mail.subject, mail.body],
  );
  const id = inserted.rows[0]?.id;
  if (!id) return null;

  await appendAuditTx(client, {
    action: 'mail.enqueue',
    targetType: 'mail_outbox',
    targetId: id,
    result: 'success',
    actorUserId: actor.userId,
    actorName: actor.displayName,
    role: actor.role,
    correlationId,
    diff: { kind: 'approval_request', requestId: source.id, to },
  });
  return id;
}

/**
 * 1通を実際に送り、結果を DB に反映する。失敗しても throw しない。
 * 送信前に status='sending' へ移してから送るので、同時に呼ばれても二重送信しない。
 * pending / failed / 古い sending を受け付ける。sent は二重送信しない。
 */
export async function deliverOutboxMail(id: string): Promise<{ id: string; status: MailState; error?: string } | null> {
  const claimed = await one<MailRow>(
    `update mail_outbox
        set status = 'sending', attempts = attempts + 1, claimed_at = now()
      where id = $1
        and (status in ('pending', 'failed')
             or (status = 'sending' and claimed_at < now() - ($2 || ' minutes')::interval))
      returning ${SELECT_COLUMNS}`,
    [id, String(STALE_CLAIM_MINUTES)],
  );
  if (!claimed) return null;

  const result = await deliverMail({
    to: claimed.to_email,
    subject: claimed.subject,
    body: claimed.body,
    requestId: claimed.request_id ?? undefined,
  });
  const status: MailState = result.ok ? 'sent' : 'failed';
  const error = result.ok ? null : (result.detail ?? '送信できませんでした');

  await withTransaction(async (client) => {
    await client.query(
      `update mail_outbox
          set status = $2, last_error = $3, claimed_at = null,
              sent_at = case when $2 = 'sent' then now() else sent_at end
        where id = $1`,
      [id, status, error],
    );
    await appendAuditTx(client, {
      action: result.ok ? 'mail.sent' : 'mail.failed',
      targetType: 'mail_outbox',
      targetId: id,
      result: result.ok ? 'success' : 'error',
      actorUserId: null,
      actorName: '受付ステーション',
      role: 'system',
      correlationId: null,
      diff: { transport: result.transport, detail: result.detail ?? null },
    });
  });
  return { id, status, ...(error ? { error } : {}) };
}

/** 未送信のぶんを順に送る（再送・起動時の掃除に使う）。 */
export async function deliverPendingMail(limit = 20): Promise<{ attempted: number; sent: number; failed: number }> {
  const { rows } = await query<{ id: string }>(
    `select id::text as id from mail_outbox
      where status = 'pending'
         or (status = 'sending' and claimed_at < now() - ($2 || ' minutes')::interval)
      order by created_at, id
      limit $1`,
    [Math.min(Math.max(limit, 1), 100), String(STALE_CLAIM_MINUTES)],
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await deliverOutboxMail(row.id);
    if (!result) continue;
    if (result.status === 'sent') sent += 1;
    else failed += 1;
  }
  return { attempted: rows.length, sent, failed };
}

export async function listOutbox(options: { status?: MailState; limit?: number } = {}): Promise<{ items: MailOutboxItem[] }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const { rows } = await query<Omit<MailRow, 'body'>>(
    `select ${SELECT_COLUMNS} from mail_outbox
      where ($1::text is null or status = $1)
      order by created_at desc, id desc
      limit $2`,
    [options.status ?? null, limit],
  );
  return { items: rows.map(toItem) };
}

/** 件数と設定の要約（画面・healthz 用。Secrets は出さない）。 */
export async function mailSummary(): Promise<{
  mode: MailMode;
  ready: boolean;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  lastSentAt: string | null;
}> {
  const counts = await one<{ pending: string; sending: string; sent: string; failed: string; last_sent_at: Date | null }>(
    `select
       count(*) filter (where status = 'pending') as pending,
       count(*) filter (where status = 'sending') as sending,
       count(*) filter (where status = 'sent') as sent,
       count(*) filter (where status = 'failed') as failed,
       max(sent_at) as last_sent_at
     from mail_outbox`,
  );
  return {
    mode: config.mailMode,
    ready: config.mailMode !== 'off',
    pending: Number(counts?.pending ?? 0),
    sending: Number(counts?.sending ?? 0),
    sent: Number(counts?.sent ?? 0),
    failed: Number(counts?.failed ?? 0),
    lastSentAt: counts?.last_sent_at ? counts.last_sent_at.toISOString() : null,
  };
}

/** 依頼に紐づく「いちばん新しい承認依頼メール」の状態（依頼詳細の表示用）。 */
export interface RequestMailStatus {
  id: string;
  status: MailState;
  to: string;
  sentAt: string | null;
  lastError: string | null;
  attempts: number;
}

export async function latestMailForRequest(requestId: string): Promise<RequestMailStatus | null> {
  const row = await one<MailRow>(
    `select ${SELECT_COLUMNS} from mail_outbox
      where request_id = $1 and kind = 'approval_request'
      order by created_at desc, id desc
      limit 1`,
    [requestId],
  );
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    to: row.to_email,
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    lastError: row.last_error,
    attempts: row.attempts,
  };
}
