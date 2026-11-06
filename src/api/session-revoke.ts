import type { PoolClient } from 'pg';
import { appendAuditTx } from './audit.js';
import { withTransaction } from './db.js';

/**
 * 旧セッションの失効（条件検証 → 削除 → 監査追記を単一トランザクションで行う）。
 *
 * 背景: 2026-11-06 の Staging 切替で、運用者が DB を直接操作して旧セッション 21 件を
 * 削除し、`audit_log` に記録が残らなかった（docs/production/17 §3「監査の空白」）。
 * 同じ手作業を繰り返さないため、この関数が削除と監査追記を同じトランザクションに閉じる。
 *
 * 設計（fail-closed）:
 * - ガードを 1 つでも満たさなければ削除せず、`{ ok: false }` を返す（例外にしない）。
 * - 削除は `appendAuditTx` と同じトランザクションで行い、監査のハッシュ連鎖を壊さない。
 * - 既定は dry-run（`dryRun` を false にしたときだけ削除する）。
 * - セッション ID・秘密・個人情報は戻り値に含めない（件数だけ）。
 */

export type SessionRevokeAbortReason =
  | 'invalid_db_name'
  | 'invalid_cutoff'
  | 'cutoff_in_future'
  | 'invalid_expect_count'
  | 'invalid_max_count'
  | 'reason_required'
  | 'invalid_reason'
  | 'actor_required'
  | 'invalid_actor'
  | 'db_name_mismatch'
  | 'active_sessions'
  | 'sessions_after_cutoff'
  | 'count_exceeds_max'
  | 'count_mismatch'
  | 'delete_count_mismatch';

export interface SessionRevokeOptions {
  /** 接続先として期待する DB 名。`current_database()` と完全一致しなければ削除しない。 */
  db: string;
  /** この時刻より前に作成されたセッションだけを対象にする（タイムゾーン付き ISO 8601）。 */
  cutoff: string | Date;
  /** 削除予定件数。実際の対象件数と一致しなければ削除しない。 */
  expectCount: number;
  /** 監査に残す理由（必須）。 */
  reason: string;
  /** 監査に残す実行者（必須。個人情報ではなく役割・uid などにする）。 */
  actor: string;
  /** 1 回に削除してよい上限（既定 100、最大 1000）。 */
  maxCount?: number;
  /** 有効なセッションが残っていても続行する（既定 false = 中止）。 */
  allowActive?: boolean;
  /** 監査の相関 ID（任意）。 */
  correlationId?: string | null;
  /** true なら検証だけ行い、削除も監査追記もしない（既定 true）。 */
  dryRun?: boolean;
}

export interface SessionRevokeReport {
  dryRun: boolean;
  db: string;
  cutoff: string;
  expectCount: number;
  maxCount: number;
  candidates: number;
  activeSessions: number;
  sessionsAfterCutoff: number;
  deleted: number;
  audit: { id: number; hash: string } | null;
}

export type SessionRevokeOutcome =
  | ({ ok: true } & SessionRevokeReport)
  | { ok: false; abortReason: SessionRevokeAbortReason; report: Partial<SessionRevokeReport> | null };

/** 既定の上限（2026-11-06 の実績 21 件に対して十分な余裕がある）。 */
export const SESSION_REVOKE_DEFAULT_MAX_COUNT = 100;
/** 上限の絶対的な天井。これを超える指定は受け付けない。 */
export const SESSION_REVOKE_MAX_COUNT_CEILING = 1000;

/** 失効処理どうしを直列化する advisory lock（監査追記の 918273645 とは別のキー）。 */
const SESSION_REVOKE_LOCK_KEY = 918273646;

const DB_NAME_PATTERN = /^[A-Za-z0-9_]{1,63}$/;
const CUTOFF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT_LENGTH = 200;
const MAX_ACTOR_LENGTH = 100;

/** 制御文字を取り除き、空白を 1 つに畳む（監査に 1 行で残すため）。 */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** タイムゾーン付き ISO 8601 だけを受け付ける（曖昧な形式を拒む）。 */
function toCutoff(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const text = value.trim();
  if (!CUTOFF_PATTERN.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface CheckedOptions {
  db: string;
  cutoff: Date;
  cutoffIso: string;
  expectCount: number;
  maxCount: number;
  reason: string;
  actor: string;
  correlationId: string | null;
}

type Validation = { ok: true; value: CheckedOptions } | { ok: false; abortReason: SessionRevokeAbortReason };

function validate(options: SessionRevokeOptions): Validation {
  const db = typeof options.db === 'string' ? options.db.trim() : '';
  if (!DB_NAME_PATTERN.test(db)) return { ok: false, abortReason: 'invalid_db_name' };

  const cutoff = toCutoff(options.cutoff);
  if (!cutoff) return { ok: false, abortReason: 'invalid_cutoff' };

  const maxCount = options.maxCount ?? SESSION_REVOKE_DEFAULT_MAX_COUNT;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > SESSION_REVOKE_MAX_COUNT_CEILING) {
    return { ok: false, abortReason: 'invalid_max_count' };
  }

  const expectCount = options.expectCount;
  if (!Number.isInteger(expectCount) || expectCount < 1 || expectCount > maxCount) {
    return { ok: false, abortReason: 'invalid_expect_count' };
  }

  const reason = cleanText(options.reason);
  if (!reason) return { ok: false, abortReason: 'reason_required' };
  if (reason.length > MAX_TEXT_LENGTH) return { ok: false, abortReason: 'invalid_reason' };

  const actor = cleanText(options.actor);
  if (!actor) return { ok: false, abortReason: 'actor_required' };
  if (actor.length > MAX_ACTOR_LENGTH) return { ok: false, abortReason: 'invalid_actor' };

  const correlationId = cleanText(options.correlationId);

  return {
    ok: true,
    value: {
      db,
      cutoff,
      cutoffIso: cutoff.toISOString(),
      expectCount,
      maxCount,
      reason,
      actor,
      correlationId: correlationId || null,
    },
  };
}

/** ガード不成立を伝える内部例外。投げると withTransaction が必ずロールバックする。 */
class RevokeAbort extends Error {
  readonly reason: SessionRevokeAbortReason;
  readonly report: Partial<SessionRevokeReport>;

  constructor(reason: SessionRevokeAbortReason, report: Partial<SessionRevokeReport>) {
    super(`session revoke aborted: ${reason}`);
    this.name = 'RevokeAbort';
    this.reason = reason;
    this.report = report;
  }
}

async function runWithinTransaction(
  client: PoolClient,
  checked: CheckedOptions,
  dryRun: boolean,
  allowActive: boolean,
): Promise<SessionRevokeReport> {
  // 同時に 2 つ走らせない（検証と削除の間の競合を減らす）。トランザクション終了で解放される。
  await client.query('select pg_advisory_xact_lock($1)', [SESSION_REVOKE_LOCK_KEY]);

  const identity = await client.query<{ db: string; now: Date }>('select current_database() as db, now() as now');
  const current = identity.rows[0];
  if (!current) throw new Error('DB の識別情報を取得できません');

  const base: Partial<SessionRevokeReport> = {
    dryRun,
    db: current.db,
    cutoff: checked.cutoffIso,
    expectCount: checked.expectCount,
    maxCount: checked.maxCount,
    candidates: 0,
    activeSessions: 0,
    sessionsAfterCutoff: 0,
    deleted: 0,
    audit: null,
  };

  // ガード 1: 接続先が宣言した DB と一致するか（取り違えを止める）。
  if (current.db !== checked.db) throw new RevokeAbort('db_name_mismatch', base);

  // ガード 2: cutoff が未来でないか（未来だと新規セッションまで対象になりうる）。
  if (checked.cutoff.getTime() > current.now.getTime()) throw new RevokeAbort('cutoff_in_future', base);

  const counts = await client.query<{ candidates: number; active: number; after_cutoff: number }>(
    `select
       count(*) filter (where created_at < $1 and expires_at <= now())::bigint as candidates,
       count(*) filter (where expires_at > now())::bigint as active,
       count(*) filter (where created_at >= $1)::bigint as after_cutoff
     from session`,
    [checked.cutoff],
  );
  const row = counts.rows[0];
  const candidates = row?.candidates ?? 0;
  const activeSessions = row?.active ?? 0;
  const sessionsAfterCutoff = row?.after_cutoff ?? 0;
  const snapshot: Partial<SessionRevokeReport> = { ...base, candidates, activeSessions, sessionsAfterCutoff };

  // ガード 3: 有効なセッションが残っていないか（--allow-active で明示的に緩めた場合だけ続行）。
  if (!allowActive && activeSessions > 0) throw new RevokeAbort('active_sessions', snapshot);

  // ガード 4: cutoff 以後に作成されたセッションが無いか（切替後に作られた新規を巻き込まない）。
  if (sessionsAfterCutoff > 0) throw new RevokeAbort('sessions_after_cutoff', snapshot);

  // ガード 5: 対象件数が上限以下か。
  if (candidates > checked.maxCount) throw new RevokeAbort('count_exceeds_max', snapshot);

  // ガード 6: 対象件数が宣言した件数と一致するか。
  if (candidates !== checked.expectCount) throw new RevokeAbort('count_mismatch', snapshot);

  if (dryRun) {
    return {
      dryRun,
      db: current.db,
      cutoff: checked.cutoffIso,
      expectCount: checked.expectCount,
      maxCount: checked.maxCount,
      candidates,
      activeSessions,
      sessionsAfterCutoff,
      deleted: 0,
      audit: null,
    };
  }

  // 削除は ID を取得しない（セッション ID をメモリ・監査・出力へ持ち込まない）。件数だけ検証する。
  const deleted = await client.query('delete from session where created_at < $1 and expires_at <= now()', [checked.cutoff]);
  const deletedCount = deleted.rowCount ?? -1;
  const afterDelete: Partial<SessionRevokeReport> = { ...snapshot, deleted: deletedCount };

  // ガード 7: 実際に消えた件数が検証と一致するか（競合したらロールバック）。
  if (deletedCount !== candidates || deletedCount !== checked.expectCount) {
    throw new RevokeAbort('delete_count_mismatch', afterDelete);
  }

  // 同一トランザクション内で監査を追記する（ハッシュ連鎖は appendAuditTx が維持する）。
  const audit = await appendAuditTx(client, {
    action: 'session.revoke',
    targetType: 'session',
    targetId: null,
    result: 'success',
    actorUserId: null,
    actorName: checked.actor,
    role: 'system',
    diff: {
      database: current.db,
      cutoff: checked.cutoffIso,
      expectCount: checked.expectCount,
      deleted: deletedCount,
      reason: checked.reason,
      allowActive,
      via: 'ops-revoke-sessions',
    },
    correlationId: checked.correlationId,
  });

  return {
    dryRun,
    db: current.db,
    cutoff: checked.cutoffIso,
    expectCount: checked.expectCount,
    maxCount: checked.maxCount,
    candidates,
    activeSessions,
    sessionsAfterCutoff,
    deleted: deletedCount,
    audit: { id: audit.id, hash: audit.hash },
  };
}

/**
 * セッションを失効させる。削除したときだけ監査に 1 行追記する。
 * ガード不成立は `{ ok: false, abortReason }` を返し、DB は変更しない（例外を投げない）。
 */
export async function revokeSessions(options: SessionRevokeOptions): Promise<SessionRevokeOutcome> {
  const checked = validate(options);
  if (!checked.ok) return { ok: false, abortReason: checked.abortReason, report: null };

  const dryRun = options.dryRun !== false;
  const allowActive = options.allowActive === true;

  try {
    const report = await withTransaction((client) => runWithinTransaction(client, checked.value, dryRun, allowActive));
    return { ok: true, ...report };
  } catch (err) {
    if (err instanceof RevokeAbort) {
      return { ok: false, abortReason: err.reason, report: err.report };
    }
    throw err;
  }
}
