import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  result: 'success' | 'denied' | 'error';
  actorUserId?: string | null;
  actorName: string;
  role: string;
  diff?: unknown;
  correlationId?: string | null;
}

/** キー順を固定した決定的な JSON（ハッシュの再現性のため）。 */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key]);
    return out;
  };
  return JSON.stringify(walk(value ?? null));
}

function hashEntry(prevHash: string | null, payload: unknown): string {
  return createHash('sha256').update(`${prevHash ?? ''}|${canonical(payload)}`).digest('hex');
}

/**
 * 監査ログを追記する（NFR-12・ENT-11）。
 * 追記のみ・ハッシュ連鎖。advisory lock で並行書き込みを直列化する。
 */
export async function appendAudit(entry: AuditEntry): Promise<{ id: number; hash: string }> {
  return withTransaction(async (client) => appendAuditTx(client, entry));
}

export async function appendAuditTx(client: PoolClient, entry: AuditEntry): Promise<{ id: number; hash: string }> {
  await client.query('select pg_advisory_xact_lock(918273645)');
  const last = await client.query<{ hash: string }>('select hash from audit_log order by id desc limit 1');
  const prevHash = last.rows[0]?.hash ?? null;
  const at = new Date().toISOString();
  const payload = {
    at,
    actorUserId: entry.actorUserId ?? null,
    actorName: entry.actorName,
    role: entry.role,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    result: entry.result,
    diff: entry.diff ?? null,
    correlationId: entry.correlationId ?? null,
  };
  const hash = hashEntry(prevHash, payload);
  const result = await client.query<{ id: number }>(
    `insert into audit_log
      (at, actor_user_id, actor_name, role, action, target_type, target_id, result, diff, correlation_id, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      at,
      entry.actorUserId ?? null,
      entry.actorName,
      entry.role,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.result,
      entry.diff ?? null,
      entry.correlationId ?? null,
      prevHash,
      hash,
    ],
  );
  return { id: result.rows[0]?.id ?? 0, hash };
}

/** 監査ログのハッシュ連鎖を検証する（管理画面・verify 用）。 */
export async function verifyAuditChain(): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  return withTransaction(async (client) => {
    const rows = await client.query<{
      id: number;
      at: Date;
      actor_user_id: string | null;
      actor_name: string;
      role: string;
      action: string;
      target_type: string;
      target_id: string | null;
      result: string;
      diff: unknown;
      correlation_id: string | null;
      prev_hash: string | null;
      hash: string;
    }>('select * from audit_log order by id asc');
    let prev: string | null = null;
    for (const row of rows.rows) {
      const payload = {
        at: row.at.toISOString(),
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        role: row.role,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        result: row.result,
        diff: row.diff ?? null,
        correlationId: row.correlation_id ?? null,
      };
      const expected = hashEntry(prev, payload);
      if (expected !== row.hash) return { ok: false, checked: rows.rows.length, brokenAt: row.id };
      prev = row.hash;
    }
    return { ok: true, checked: rows.rows.length };
  });
}
