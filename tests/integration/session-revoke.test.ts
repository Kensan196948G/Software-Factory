import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../../src/api/audit.js';
import { one, query } from '../../src/api/db.js';
import { revokeSessions } from '../../src/api/session-revoke.js';
import { prepareTestDb, truncateBusiness } from './helpers.js';

/**
 * 旧セッション失効（監査の空白の是正）の結合テスト。
 * 対象は `mirai_sf_test` だけ（global-setup が空にして migration を適用する）。
 */

const execFileAsync = promisify(execFile);
const REASON = '結合テスト: 旧セッション失効';
const ACTOR = 'integration-test';
const HOUR = 60 * 60 * 1000;

let dbName = '';
let userId = '';

beforeAll(async () => {
  await prepareTestDb();
  dbName = (await dbNameOfConnection()) ?? '';
  expect(dbName).toMatch(/_test$/);
});

beforeEach(async () => {
  await truncateBusiness();
  userId = (await one<{ id: string }>('select id from app_user where email = $1', ['test@example.com']))?.id ?? '';
  expect(userId).not.toBe('');
});

async function dbNameOfConnection(): Promise<string | null> {
  return (await one<{ db: string }>('select current_database() as db'))?.db ?? null;
}

async function nowMs(): Promise<number> {
  return (await one<{ now: Date }>('select now() as now'))?.now.getTime() ?? Date.now();
}

async function insertSession(id: string, createdAt: number, expiresAt: number): Promise<void> {
  await query(
    `insert into session (id, user_id, acting_role, csrf_token, created_at, last_seen_at, expires_at)
     values ($1, $2, 'requester', $3, $4, $4, $5)`,
    [id, userId, `csrf-test-${id}`, new Date(createdAt), new Date(expiresAt)],
  );
}

/** 期限切れ（有効でない）セッションを count 件作り、cutoff（1 時間前）を返す。 */
async function seedExpiredSessions(count: number): Promise<{ cutoff: string; base: number }> {
  const base = await nowMs();
  for (let i = 0; i < count; i += 1) {
    await insertSession(`session-test-${i}`, base - 2 * HOUR - i, base - 30 * 60 * 1000);
  }
  return { cutoff: new Date(base - HOUR).toISOString(), base };
}

async function sessionCount(): Promise<number> {
  return (await one<{ count: number }>('select count(*)::int as count from session'))?.count ?? -1;
}

async function auditCount(): Promise<number> {
  return (await one<{ count: number }>('select count(*)::int as count from audit_log'))?.count ?? -1;
}

describe('revokeSessions（正常系）', () => {
  it('条件が一致すれば削除し、監査を 1 行だけ追記してハッシュ連鎖を壊さない', async () => {
    // 既存の監査行があっても連鎖が続くことを確かめる。
    await appendAudit({ action: 'test.seed', targetType: 'test', result: 'success', actorName: 'seed', role: 'system' });
    const { cutoff } = await seedExpiredSessions(3);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('正常系で中止された');
    expect(outcome.dryRun).toBe(false);
    expect(outcome.deleted).toBe(3);
    expect(outcome.candidates).toBe(3);
    expect(outcome.activeSessions).toBe(0);
    expect(outcome.audit?.id).toBeGreaterThan(0);
    expect(outcome.audit?.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(await sessionCount()).toBe(0);
    expect(await auditCount()).toBe(2);

    const audit = await one<{
      action: string;
      target_type: string;
      target_id: string | null;
      result: string;
      actor_name: string;
      role: string;
      diff: Record<string, unknown>;
    }>('select action, target_type, target_id, result, actor_name, role, diff from audit_log order by id desc limit 1');
    expect(audit?.action).toBe('session.revoke');
    expect(audit?.target_type).toBe('session');
    expect(audit?.target_id).toBeNull();
    expect(audit?.result).toBe('success');
    expect(audit?.actor_name).toBe(ACTOR);
    expect(audit?.role).toBe('system');
    expect(audit?.diff).toMatchObject({ database: dbName, cutoff, expectCount: 3, deleted: 3, reason: REASON });
    // セッション ID は監査に書かない（件数だけ）。
    expect(JSON.stringify(audit?.diff)).not.toContain('session-test-');

    // `pnpm db:verify` の監査連鎖チェックと同じ内容。
    await expect(verifyAuditChain()).resolves.toEqual({ ok: true, checked: 2 });
  });

  it('既定は dry-run で、削除も監査追記もしない', async () => {
    const { cutoff } = await seedExpiredSessions(2);

    const outcome = await revokeSessions({ db: dbName, cutoff, expectCount: 2, reason: REASON, actor: ACTOR });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('dry-run で中止された');
    expect(outcome.dryRun).toBe(true);
    expect(outcome.deleted).toBe(0);
    expect(outcome.candidates).toBe(2);
    expect(await sessionCount()).toBe(2);
    expect(await auditCount()).toBe(0);
  });

  it('--allow-active 相当を明示したときだけ有効セッションが残っていても失効できる', async () => {
    const { cutoff, base } = await seedExpiredSessions(3);
    await insertSession('session-active', base - 2 * HOUR, base + HOUR);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      allowActive: true,
      dryRun: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('allowActive で中止された');
    expect(outcome.deleted).toBe(3);
    expect(outcome.activeSessions).toBe(1);
    expect(await sessionCount()).toBe(1);
    expect(await auditCount()).toBe(1);
  });
});

describe('revokeSessions（中止系: ガード不成立なら削除しない）', () => {
  it('DB 名が一致しないときは中止する', async () => {
    const { cutoff } = await seedExpiredSessions(3);

    const outcome = await revokeSessions({
      db: 'mirai_sf_other',
      cutoff,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'db_name_mismatch' });
    expect(await sessionCount()).toBe(3);
    expect(await auditCount()).toBe(0);
  });

  it('対象件数が --expect-count と一致しないときは中止する', async () => {
    const { cutoff } = await seedExpiredSessions(3);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 2,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'count_mismatch' });
    expect(await sessionCount()).toBe(3);
    expect(await auditCount()).toBe(0);
  });

  it('対象件数が上限を超えるときは中止する', async () => {
    const { cutoff } = await seedExpiredSessions(3);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 2,
      maxCount: 2,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'count_exceeds_max' });
    expect(await sessionCount()).toBe(3);
    expect(await auditCount()).toBe(0);
  });

  it('--expect-count が上限を超える指定は検証の段階で拒否する', async () => {
    const { cutoff } = await seedExpiredSessions(3);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 3,
      maxCount: 2,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'invalid_expect_count' });
    expect(await sessionCount()).toBe(3);
  });

  it('cutoff が不正な形式なら中止する', async () => {
    await seedExpiredSessions(3);

    const ambiguous = await revokeSessions({
      db: dbName,
      cutoff: '2026-11-06 05:10:01',
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });
    expect(ambiguous).toMatchObject({ ok: false, abortReason: 'invalid_cutoff' });

    const broken = await revokeSessions({
      db: dbName,
      cutoff: 'not-a-date',
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });
    expect(broken).toMatchObject({ ok: false, abortReason: 'invalid_cutoff' });

    expect(await sessionCount()).toBe(3);
    expect(await auditCount()).toBe(0);
  });

  it('cutoff が未来なら中止する', async () => {
    await seedExpiredSessions(3);
    const future = new Date((await nowMs()) + HOUR).toISOString();

    const outcome = await revokeSessions({
      db: dbName,
      cutoff: future,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'cutoff_in_future' });
    expect(await sessionCount()).toBe(3);
    expect(await auditCount()).toBe(0);
  });

  it('有効なセッションが残っているときは中止する', async () => {
    const { cutoff, base } = await seedExpiredSessions(3);
    await insertSession('session-active', base - 2 * HOUR, base + HOUR);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'active_sessions' });
    expect(await sessionCount()).toBe(4);
    expect(await auditCount()).toBe(0);
  });

  it('cutoff 以後に作成されたセッションがあるときは中止する', async () => {
    const { cutoff, base } = await seedExpiredSessions(3);
    // 期限切れだが cutoff より後に作られたセッション（切替後の新規に相当）。
    await insertSession('session-after-cutoff', base - 10 * 60 * 1000, base - 5 * 60 * 1000);

    const outcome = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 3,
      reason: REASON,
      actor: ACTOR,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ ok: false, abortReason: 'sessions_after_cutoff' });
    expect(await sessionCount()).toBe(4);
    expect(await auditCount()).toBe(0);
  });

  it('--reason と --actor が無いときは中止する', async () => {
    const { cutoff } = await seedExpiredSessions(1);

    const noReason = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 1,
      reason: '  ',
      actor: ACTOR,
      dryRun: false,
    });
    expect(noReason).toMatchObject({ ok: false, abortReason: 'reason_required' });

    const noActor = await revokeSessions({
      db: dbName,
      cutoff,
      expectCount: 1,
      reason: REASON,
      actor: '',
      dryRun: false,
    });
    expect(noActor).toMatchObject({ ok: false, abortReason: 'actor_required' });

    expect(await sessionCount()).toBe(1);
    expect(await auditCount()).toBe(0);
  });

  it('削除件数が検証と一致しないときは中止し、削除も監査も残さない（guard 7）', async () => {
    // 最後の防衛（delete_count_mismatch）を回帰検知できるようにする。
    // DELETE を無効化する行トリガで「検証時は 2 件、削除は 0 件」という競合を作る。
    const { cutoff } = await seedExpiredSessions(2);
    await query(
      `create or replace function test_block_session_delete() returns trigger as $$
       begin return null; end; $$ language plpgsql`,
    );
    await query('drop trigger if exists test_block_session_delete on session');
    await query(
      'create trigger test_block_session_delete before delete on session for each row execute function test_block_session_delete()',
    );
    try {
      const outcome = await revokeSessions({
        db: dbName,
        cutoff,
        expectCount: 2,
        reason: REASON,
        actor: ACTOR,
        dryRun: false,
      });

      expect(outcome).toMatchObject({ ok: false, abortReason: 'delete_count_mismatch' });
      expect(await sessionCount()).toBe(2);
      expect(await auditCount()).toBe(0);
    } finally {
      await query('drop trigger if exists test_block_session_delete on session');
      await query('drop function if exists test_block_session_delete()');
    }
  });

  it('監査の追記に失敗したら削除もロールバックする（同一トランザクション）', async () => {
    // 削除と監査が同一 Tx であることを、監査の失敗注入で固定する。
    const { cutoff } = await seedExpiredSessions(2);
    await query(
      `create or replace function test_block_audit_insert() returns trigger as $$
       begin raise exception 'test: audit insert blocked'; end; $$ language plpgsql`,
    );
    await query('drop trigger if exists test_block_audit_insert on audit_log');
    await query(
      'create trigger test_block_audit_insert before insert on audit_log for each row execute function test_block_audit_insert()',
    );
    try {
      await expect(
        revokeSessions({
          db: dbName,
          cutoff,
          expectCount: 2,
          reason: REASON,
          actor: ACTOR,
          dryRun: false,
        }),
      ).rejects.toThrow(/audit insert blocked/);

      expect(await sessionCount()).toBe(2);
      expect(await auditCount()).toBe(0);
    } finally {
      await query('drop trigger if exists test_block_audit_insert on audit_log');
      await query('drop function if exists test_block_audit_insert()');
    }
  });
});

describe('CLI（scripts/ops/revoke-sessions.ts）', () => {
  it('--yes を付けなければ dry-run で、削除しない', async () => {
    const { cutoff } = await seedExpiredSessions(2);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/ops/revoke-sessions.ts',
        '--db',
        dbName,
        '--cutoff',
        cutoff,
        '--expect-count',
        '2',
        '--reason',
        REASON,
        '--actor',
        ACTOR,
      ],
      { cwd: process.cwd(), env: { ...process.env }, timeout: 60_000 },
    );

    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('削除=0');
    // セッション ID を出力しない。
    expect(stdout).not.toContain('session-test-');
    expect(await sessionCount()).toBe(2);
    expect(await auditCount()).toBe(0);
  });

  it('ガード不成立は終了コード 2 で、DB を変更しない', async () => {
    const { cutoff } = await seedExpiredSessions(2);

    await expect(
      execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/ops/revoke-sessions.ts',
          '--db',
          'mirai_sf_other',
          '--cutoff',
          cutoff,
          '--expect-count',
          '2',
          '--reason',
          REASON,
          '--actor',
          ACTOR,
        ],
        { cwd: process.cwd(), env: { ...process.env }, timeout: 60_000 },
      ),
    ).rejects.toMatchObject({ code: 2 });

    expect(await sessionCount()).toBe(2);
    expect(await auditCount()).toBe(0);
  });
});
