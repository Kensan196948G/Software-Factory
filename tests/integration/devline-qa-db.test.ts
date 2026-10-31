/**
 * QA: 契約と DB（T-01〜T-09, T-17, T-91）と migration の共存。
 * migration は専用の schema に当てるので public の表に触らない。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/api/audit.js';
import { query } from '../../src/api/db.js';
import { seedDemo, seedMaster } from '../../src/api/seed.js';
import {
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  JOB_STATES,
  JOB_TRANSITIONS,
  RUNNER_KINDS,
  STOP_REASONS,
  VERIFICATION_SOURCES,
} from '../../src/shared/devline.js';
import { truncateBusiness } from './helpers.js';
import { migrationUrl, runScript, useHarness } from './devline-qa-harness.js';

const h = useHarness();
const MIGRATIONS = resolve(process.cwd(), 'db/migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sqlOf = (file: string): string => readFileSync(resolve(MIGRATIONS, file), 'utf8');
const NEW = '0008_devline_foundation.sql';
const OLD_FILES = files.filter((f) => f < NEW);
const NEW_TABLES = ['order_snapshot', 'handoff_intent', 'job', 'job_attempt', 'job_event', 'job_artifact', 'verification'];

async function withSchema<T>(name: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: migrationUrl() });
  await client.connect();
  try {
    await client.query(`drop schema if exists ${name} cascade`);
    await client.query(`create schema ${name}`);
    await client.query(`set search_path to ${name}, public`);
    return await fn(client);
  } finally {
    await client.query(`drop schema if exists ${name} cascade`);
    await client.end();
  }
}

/** 既存の表の定義の写し（列・制約・索引・トリガ）。 */
async function catalog(client: pg.Client, schema: string, tables: string[]): Promise<Record<string, unknown>> {
  const columns = await client.query(
    `select table_name, column_name, data_type, is_nullable, column_default, ordinal_position from information_schema.columns
      where table_schema=$1 and table_name = any($2) order by table_name, ordinal_position`,
    [schema, tables],
  );
  const constraints = await client.query(
    `select c.conrelid::regclass::text as t, c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
       join pg_namespace n on n.oid=c.connamespace
      where n.nspname=$1 and c.conrelid <> 0 and c.conrelid::regclass::text = any($2) order by 1, 2`,
    [schema, tables],
  );
  const indexes = await client.query(
    `select tablename, indexname, indexdef from pg_indexes where schemaname=$1 and tablename = any($2) order by 1, 2`,
    [schema, tables],
  );
  const triggers = await client.query(
    `select event_object_table, trigger_name, action_statement, event_manipulation from information_schema.triggers
      where trigger_schema=$1 and event_object_table = any($2) order by 1, 2, 4`,
    [schema, tables],
  );
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, triggers: triggers.rows };
}

describe('migration 0008（T-01, T-91）', () => {
  it('T-01: 空の schema に全部当たり、0008 の生 SQL を2回再適用しても失敗しない', async () => {
    await withSchema('qa_mig_empty', async (client) => {
      for (const file of files) await client.query(sqlOf(file));
      await client.query(sqlOf(NEW));
      await client.query(sqlOf(NEW));
      const { rows } = await client.query(`select table_name from information_schema.tables where table_schema='qa_mig_empty'`);
      const names = rows.map((r) => r.table_name);
      for (const t of NEW_TABLES) expect(names).toContain(t);
    });
  });

  it('T-01: db.ts migrate と同じく BEGIN の中でも当たる（BEGIN/COMMIT を含まない）', async () => {
    expect(sqlOf(NEW)).not.toMatch(/^\s*(begin|commit)\s*;/im);
    await withSchema('qa_mig_tx', async (client) => {
      for (const file of OLD_FILES) await client.query(sqlOf(file));
      await client.query('BEGIN');
      await client.query(sqlOf(NEW));
      await client.query('ROLLBACK');
      const { rows } = await client.query(
        `select 1 from information_schema.tables where table_schema='qa_mig_tx' and table_name='job'`,
      );
      expect(rows).toHaveLength(0); // 取り消せる＝トランザクションの中で完結している
      await client.query('BEGIN');
      await client.query(sqlOf(NEW));
      await client.query('COMMIT');
    });
  });

  it('T-91: 既存相当のデータが入った DB に当たり、既存の表の定義とデータが変わらない', async () => {
    await withSchema('qa_mig_old', async (client) => {
      for (const file of OLD_FILES) await client.query(sqlOf(file));
      await seedMaster(client as unknown as pg.PoolClient);
      const demo = await seedDemo(client as unknown as pg.PoolClient);
      expect(demo).toBeGreaterThan(0);
      const { rows: oldTables } = await client.query(
        `select table_name from information_schema.tables where table_schema='qa_mig_old' order by 1`,
      );
      const tables = oldTables.map((r) => r.table_name as string);
      expect(tables).toEqual(expect.arrayContaining(['request', 'approval', 'audit_log', 'mail_outbox']));

      const before = await catalog(client, 'qa_mig_old', tables);
      const digest = async (t: string): Promise<string> =>
        (await client.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as m from ${t} x`)).rows[0].m;
      const dataBefore = {
        request: await digest('request'),
        approval: await digest('approval'),
        history: await digest('request_history'),
      };

      await client.query(sqlOf(NEW));

      expect(await catalog(client, 'qa_mig_old', tables)).toEqual(before);
      expect({
        request: await digest('request'),
        approval: await digest('approval'),
        history: await digest('request_history'),
      }).toEqual(dataBefore);
    });
  });

  it('T-91: 0008 は既存の表を変更しない（alter/drop table が無い。drop は自分のトリガだけ）', () => {
    const sql = sqlOf(NEW)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\balter\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\s+/i);
    for (const m of sql.matchAll(/drop trigger if exists \w+ on (\w+)/gi)) expect(NEW_TABLES).toContain(m[1]);
  });

  it('旧版のアプリの SQL が 0008 の後も動く（devline の行が無ければ issue_no の更新・履歴・全削除が通る）', async () => {
    await withSchema('qa_mig_compat', async (client) => {
      for (const file of OLD_FILES) await client.query(sqlOf(file));
      await seedMaster(client as unknown as pg.PoolClient);
      await seedDemo(client as unknown as pg.PoolClient);
      await client.query(sqlOf(NEW));
      const { rows } = await client.query('select id from request limit 1');
      const id = rows[0].id as string;
      // 旧 handoffToGithub の更新
      await client.query('update request set issue_no = $2, version = version + 1, updated_at = now() where id = $1', [id, 7]);
      // 旧 importAll / resetDemo の全削除
      await client.query('delete from request');
      await client.query('delete from request_counter');
      expect((await client.query('select count(*)::int as c from request')).rows[0].c).toBe(0);
    });
  });
});

describe('遷移表（T-02, T-03）', () => {
  it('T-02: job 15×15 の全組合せで TS と SQL が一致する', async () => {
    expect(JOB_STATES).toHaveLength(15);
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const { rows } = await query<{ ok: boolean }>('select devline_job_transition_allowed($1,$2) as ok', [from, to]);
        expect(rows[0]?.ok, `${from} -> ${to}`).toBe(JOB_TRANSITIONS[from].includes(to));
      }
    }
  });

  it('T-02: handoff 5×5 の全組合せで TS と SQL が一致する', async () => {
    expect(HANDOFF_STATES).toHaveLength(5);
    for (const from of HANDOFF_STATES) {
      for (const to of HANDOFF_STATES) {
        const { rows } = await query<{ ok: boolean }>('select devline_handoff_transition_allowed($1,$2) as ok', [from, to]);
        expect(rows[0]?.ok, `${from} -> ${to}`).toBe(HANDOFF_TRANSITIONS[from].includes(to));
      }
    }
  });

  /** `check (x in ('a','b'))` の値の集合を取り出す。 */
  async function checkValues(table: string, column: string): Promise<string[]> {
    const { rows } = await query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = $1::regclass and c.contype='c' and pg_get_constraintdef(c.oid) ~ $2`,
      [table, `\\(${column} = ANY|\\(\\(${column} = ANY|${column} IS NULL`],
    );
    // その列だけの CHECK を選ぶ。pg_constraint の並びは不定で、job_stop_recorded なども state = ANY を含む
    const single = new RegExp(`^CHECK \\(+(${column} IS NULL\\) OR \\(+)?${column} = ANY \\(ARRAY\\[[^\\]]*\\]\\)\\)+$`);
    const def = rows.find((r) => single.test(r.def))?.def ?? '';
    return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1] as string).sort();
  }

  it('T-02: STOP_REASONS と job の状態・runner・handoff の状態・検証の source が CHECK と一致する', async () => {
    expect(await checkValues('job', 'stop_reason')).toEqual([...STOP_REASONS].sort());
    expect(await checkValues('job', 'state')).toEqual([...JOB_STATES].sort());
    expect(await checkValues('job', 'runner_kind')).toEqual([...RUNNER_KINDS].sort());
    expect(await checkValues('handoff_intent', 'state')).toEqual([...HANDOFF_STATES].sort());
    expect(await checkValues('verification', 'source')).toEqual([...VERIFICATION_SOURCES].sort());
  });

  it('T-03: job の遷移表が仕様 4-3 の表と一致する（期待値は仕様から直書き）', () => {
    const spec: Record<string, string[]> = {
      queued: ['planning', 'cancelled'],
      planning: ['implementing', 'stopped'],
      implementing: ['verifying', 'stopped', 'failed'],
      verifying: ['pr_ready', 'revising', 'stopped'],
      revising: ['verifying', 'stopped'],
      pr_ready: ['reviewing', 'approved'],
      reviewing: ['approved', 'revising', 'stopped'],
      approved: ['merged'],
      merged: ['staged'],
      staged: ['released'],
      released: ['closed'],
      closed: [],
      stopped: ['planning', 'implementing', 'verifying', 'revising', 'reviewing', 'closed'],
      failed: ['implementing', 'closed'],
      cancelled: ['queued', 'closed'],
    };
    for (const state of JOB_STATES)
      expect([...JOB_TRANSITIONS[state]].sort(), state).toEqual([...(spec[state] as string[])].sort());
    for (const running of ['planning', 'implementing', 'verifying', 'revising', 'reviewing'] as const) {
      expect(JOB_TRANSITIONS[running]).not.toContain('cancelled');
    }
  });
});

describe('追記のみと削除の拒否（T-04, T-05）', () => {
  async function pipeline(): Promise<{ id: string; jobId: string }> {
    const id = await h.approvedRequest();
    const { jobId } = await h.untilPrReady(id);
    return { id, jobId };
  }

  it.each([
    [
      'order_snapshot',
      `update order_snapshot set policy_version='x' where request_id=$1`,
      `delete from order_snapshot where request_id=$1`,
      'request',
    ],
    ['job_event', `update job_event set kind='x' where job_id=$1`, `delete from job_event where job_id=$1`, 'job'],
    ['job_artifact', `update job_artifact set name='x' where job_id=$1`, `delete from job_artifact where job_id=$1`, 'job'],
    ['verification', `update verification set log_ref='x' where job_id=$1`, `delete from verification where job_id=$1`, 'job'],
  ])('T-04: %s の UPDATE / DELETE が DB で拒否される', async (table, update, del, key) => {
    const { id, jobId } = await pipeline();
    const param = key === 'request' ? id : jobId;
    const rows = await h.count(`from ${table} where ${key === 'request' ? 'request_id' : 'job_id'}=$1`, [param]);
    expect(rows).toBeGreaterThan(0);
    await expect(query(update, [param])).rejects.toThrow(/append-only/);
    await expect(query(del, [param])).rejects.toThrow(/append-only/);
    expect(await h.count(`from ${table} where ${key === 'request' ? 'request_id' : 'job_id'}=$1`, [param])).toBe(rows);
  });

  it.each([
    ['job', 'delete from job where request_id=$1'],
    ['handoff_intent', 'delete from handoff_intent where request_id=$1'],
    ['job_attempt', 'delete from job_attempt where job_id in (select id from job where request_id=$1)'],
  ])('T-05: %s の DELETE が拒否される', async (_table, sql) => {
    const { id } = await pipeline();
    await expect(query(sql, [id])).rejects.toThrow(/cannot be deleted/);
  });

  it('T-05: 終わった attempt は UPDATE できない', async () => {
    const { jobId } = await pipeline();
    expect(await h.count('from job_attempt where job_id=$1 and finished_at is not null', [jobId])).toBeGreaterThan(0);
    await expect(query(`update job_attempt set outcome='failed' where job_id=$1`, [jobId])).rejects.toThrow(/immutable/);
  });

  it('D-09: 依頼は devline の行があると DELETE できない（証跡を連鎖で消さない）', async () => {
    const { id } = await pipeline();
    await expect(query('delete from request where id=$1', [id])).rejects.toMatchObject({
      code: expect.stringMatching(/^230(01|503)$|^23503$/),
    });
    expect(await h.count('from request where id=$1', [id])).toBe(1);
  });
});

describe('job と handoff_intent の DB 制約（T-06, T-07）', () => {
  async function queuedJob(): Promise<{ id: string; jobId: string }> {
    const id = await h.approvedRequest();
    const res = await h.handoff(id);
    expect(res.statusCode, res.body).toBe(200);
    return { id, jobId: res.json().jobId };
  }

  it.each(['planning', 'pr_ready', 'stopped', 'closed'])('T-06: job は %s で作れない', async (state) => {
    const { jobId } = await queuedJob();
    const row = await h.jobRow(jobId);
    await expect(
      query(
        `insert into job (snapshot_id, request_id, order_version, target_repo_id, handoff_intent_id, policy_version, state, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [
          row.snapshot_id,
          row.request_id,
          row.order_version,
          row.target_repo_id,
          row.handoff_intent_id,
          row.policy_version,
          state,
        ],
      ),
    ).rejects.toThrow(/must start as queued/);
  });

  it('T-06: 不正な遷移が DB で拒否される', async () => {
    const { jobId } = await queuedJob();
    for (const to of ['verifying', 'pr_ready', 'merged', 'released']) {
      await expect(query('update job set state=$2 where id=$1', [jobId, to])).rejects.toThrow(/is not allowed/);
    }
    expect((await h.jobRow(jobId)).state).toBe('queued');
  });

  it.each([
    ['request_id', `'REQ-0000-0000'`],
    ['order_version', '99'],
    ['target_repo_id', `'a/b'`],
    ['policy_version', `'x'`],
    ['snapshot_id', 'gen_random_uuid()'],
    ['handoff_intent_id', 'gen_random_uuid()'],
  ])('T-06: 識別列 %s の変更が DB で拒否される', async (column, value) => {
    const { jobId } = await queuedJob();
    await expect(query(`update job set ${column}=${value} where id=$1`, [jobId])).rejects.toThrow(/immutable/);
  });

  it('T-06: fencing の減少が DB で拒否される', async () => {
    const { jobId } = await queuedJob();
    await query('update job set fencing_token=5 where id=$1', [jobId]);
    await expect(query('update job set fencing_token=4 where id=$1', [jobId])).rejects.toThrow(/must not decrease/);
  });

  it('T-07: 停止系は理由・残作業・時刻・再開先のどれが欠けても拒否される', async () => {
    const { jobId } = await queuedJob();
    const base = { stop_reason: `'cancel_requested'`, remaining_work: `'{}'::jsonb`, stopped_at: 'now()', resume_to: `'queued'` };
    for (const missing of Object.keys(base)) {
      const sets = Object.entries(base)
        .filter(([k]) => k !== missing)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      await expect(query(`update job set state='cancelled', ${sets} where id=$1`, [jobId])).rejects.toMatchObject({
        code: '23514',
      });
    }
    // 再開先が遷移表に無い・closed は拒否
    await expect(
      query(
        `update job set state='cancelled', stop_reason='cancel_requested', remaining_work='{}', stopped_at=now(), resume_to='planning' where id=$1`,
        [jobId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      query(
        `update job set state='cancelled', stop_reason='cancel_requested', remaining_work='{}', stopped_at=now(), resume_to='closed' where id=$1`,
        [jobId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // 正の対照
    await query(
      `update job set state='cancelled', stop_reason='cancel_requested', remaining_work='{}', stopped_at=now(), resume_to='queued' where id=$1`,
      [jobId],
    );
  });

  it('T-07: lease を持ったまま pr_ready・停止系へ行けない。理由だけ入れて実行中のままにもできない', async () => {
    const { jobId } = await queuedJob();
    await query(`update job set lease_owner='w', lease_expires_at=now() where id=$1`, [jobId]);
    await expect(
      query(
        `update job set state='cancelled', stop_reason='cancel_requested', remaining_work='{}', stopped_at=now(), resume_to='queued' where id=$1`,
        [jobId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await query(`update job set state='planning' where id=$1`, [jobId]);
    await query(`update job set state='implementing' where id=$1`, [jobId]);
    await query(`update job set state='verifying', head_sha=$2 where id=$1`, [jobId, 'a'.repeat(40)]);
    await expect(query(`update job set state='pr_ready' where id=$1`, [jobId])).rejects.toMatchObject({ code: '23514' });
    await expect(query(`update job set stop_reason='human_stop' where id=$1`, [jobId])).rejects.toMatchObject({ code: '23514' });
    await expect(query(`update job set lease_expires_at=null where id=$1`, [jobId])).rejects.toMatchObject({ code: '23514' });
  });

  it('handoff_intent: 不正な遷移・マーカーの変更を拒否し、未確定の作成と送信中は1件だけ', async () => {
    const { id } = await queuedJob();
    const [intent] = await h.intents(id);
    await expect(query(`update handoff_intent set state='sent' where id=$1`, [intent.id])).rejects.toThrow(/is not allowed/);
    await expect(query(`update handoff_intent set marker='x' where id=$1`, [intent.id])).rejects.toThrow(/immutable/);
    await expect(query(`update handoff_intent set order_version=99 where id=$1`, [intent.id])).rejects.toThrow(/immutable/);
    // 同じ依頼の2つ目の create（別の版）は部分 unique 索引で拒否
    await expect(
      query(
        `insert into handoff_intent (snapshot_id, request_id, order_version, target_repo_id, op_kind, marker, created_at, updated_at)
         select snapshot_id, request_id, order_version, target_repo_id, 'create_issue', 'm2', now(), now() from handoff_intent where id=$1`,
        [intent.id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('T-08, T-09: 全消去と db.ts', () => {
  it('T-08: truncateBusiness が devline の行があっても通り、devline の表も空になる', async () => {
    const id = await h.approvedRequest();
    await h.untilPrReady(id);
    await truncateBusiness();
    for (const table of NEW_TABLES) expect(await h.count(`from ${table}`)).toBe(0);
  });

  it('T-09・T-08: 別プロセスの db.ts verify が devline の操作の後も成功し、db.ts reset --yes も通る', async () => {
    const id = await h.approvedRequest();
    await h.untilPrReady(id);
    expect((await verifyAuditChain()).ok).toBe(true);

    const verified = await runScript(['scripts/db.ts', 'verify']);
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain('監査ログのハッシュ連鎖');
    expect(verified.out).toContain('verify 成功');

    const reset = await runScript(['scripts/db.ts', 'reset', '--yes']);
    expect(reset.code, reset.out).toBe(0);
    for (const table of NEW_TABLES) expect(await h.count(`from ${table}`)).toBe(0);
    expect(await h.count('from request')).toBeGreaterThan(0);
  }, 60000);
});

describe('T-17: DB のトリガ単独でも承認の有効性を確かめる', () => {
  const yaml = 'order_version: 1\n';
  const sha = createHash('sha256').update(yaml, 'utf8').digest('hex');

  async function insertSnapshot(
    requestId: string,
    over: { version?: number; approvalId?: string; approver?: string; yaml?: string; sha?: string; envelope?: object } = {},
  ) {
    const row = (await query<any>('select order_version from request where id=$1', [requestId])).rows[0];
    const approval = (
      await query<any>('select id, approver_user_id from approval where request_id=$1 order by at desc, id desc limit 1', [
        requestId,
      ])
    ).rows[0];
    return query(
      `insert into order_snapshot (request_id, order_version, content_sha256, canonical_yaml, envelope, envelope_sha256, approval_id,
         approver_user_id, target_repo_id, base_sha, policy_version, frozen_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'a/b',$9,'p',now())`,
      [
        requestId,
        over.version ?? row.order_version,
        over.sha ?? sha,
        over.yaml ?? yaml,
        JSON.stringify(over.envelope ?? { schema: 'msf.order-envelope/v1' }),
        'e'.repeat(64),
        over.approvalId ?? approval?.id ?? '00000000-0000-4000-8000-000000000000',
        over.approver ?? approval?.approver_user_id ?? h.auth.user.id,
        'b'.repeat(40),
      ],
    );
  }

  it('正の対照: 承認済みの最新の版は入る', async () => {
    const id = await h.approvedRequest();
    await expect(insertSnapshot(id)).resolves.toBeTruthy();
  });

  it('旧版を拒否する', async () => {
    const id = await h.approvedRequest();
    const old = await h.orderVersion(id);
    await h.reapprove(id, '変更した目的');
    await expect(insertSnapshot(id, { version: old })).rejects.toThrow(/approval is not valid/);
  });

  it('別の承認者・古い承認の ID を拒否する', async () => {
    const id = await h.approvedRequest();
    const firstApproval = (await query<any>('select id from approval where request_id=$1', [id])).rows[0].id;
    const other = (await query<any>('select id from app_user where id <> $1 limit 1', [h.auth.user.id])).rows[0].id;
    await expect(insertSnapshot(id, { approver: other })).rejects.toThrow(/approval is not valid/);
    await h.reapprove(id, '変更した目的');
    await expect(insertSnapshot(id, { approvalId: firstApproval })).rejects.toThrow(/approval is not valid/);
  });

  it('未承認・差戻し・削除を拒否する', async () => {
    const pending = await h.createRequest();
    await expect(insertSnapshot(pending)).rejects.toThrow(/approval is not valid/);
    const returned = await h.approvedRequest();
    await query(`update request set status='back' where id=$1`, [returned]);
    await expect(insertSnapshot(returned)).rejects.toThrow(/approval is not valid/);
    const removed = await h.approvedRequest();
    await query(`update request set deleted=true where id=$1`, [removed]);
    await expect(insertSnapshot(removed)).rejects.toThrow(/approval is not valid/);
  });

  it('本文とハッシュの不一致・未正規化の本文・別の envelope を CHECK で拒否する（T-13）', async () => {
    const id = await h.approvedRequest();
    await expect(insertSnapshot(id, { sha: 'f'.repeat(64) })).rejects.toMatchObject({ code: '23514' });
    const crlf = 'a\r\nb\n';
    await expect(
      insertSnapshot(id, { yaml: crlf, sha: createHash('sha256').update(crlf, 'utf8').digest('hex') }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    const noNewline = 'a';
    await expect(
      insertSnapshot(id, { yaml: noNewline, sha: createHash('sha256').update(noNewline, 'utf8').digest('hex') }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertSnapshot(id, { envelope: { schema: 'other' } })).rejects.toMatchObject({ code: '23514' });
  });
});
