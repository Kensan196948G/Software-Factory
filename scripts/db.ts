/**
 * DB 運用スクリプト（migrate / seed / reset / verify）。
 *
 * 使い方:
 *   node scripts/local-run.mjs tsx scripts/db.ts migrate
 *   node scripts/local-run.mjs tsx scripts/db.ts seed
 *   node scripts/local-run.mjs tsx scripts/db.ts verify
 *   node scripts/local-run.mjs tsx scripts/db.ts reset --yes     # _dev / _test のみ
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/api/config.js';
import { seedAll, seedMaster, seedAdmin } from '../src/api/seed.js';
import { verifyAuditChain } from '../src/api/audit.js';

const config = loadConfig();
const command = process.argv[2] ?? 'help';
const migrationsDir = resolve(process.cwd(), 'db/migrations');

function databaseUrl(kind: 'app' | 'migration'): string {
  if (kind === 'migration') {
    return process.env.MIGRATION_DATABASE_URL ?? process.env.TEST_MIGRATION_DATABASE_URL ?? config.databaseUrl;
  }
  return process.env.DATABASE_URL ?? config.databaseUrl;
}

function dbName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

async function withClient<T>(kind: 'app' | 'migration', fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl(kind) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function migrate(): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  await withClient('migration', async (client) => {
    await client.query(
      `create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`,
    );
    const applied = new Set(
      (await client.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version),
    );
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file}`);
        continue;
      }
      const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
      console.log(`apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    const tables = await client.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
    );
    console.log(`migrate 完了（テーブル ${tables.rows[0]?.count ?? 0} 件）`);
  });
}

async function seed(): Promise<void> {
  await withClient('migration', async (client) => {
    await client.query('BEGIN');
    try {
      const result = await seedAll(client);
      await client.query('COMMIT');
      console.log(`seed 完了: 部署 ${result.departments} / 道具 ${result.tools} / 見本 ${result.demo} / 管理者 ${result.admin}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function reset(): Promise<void> {
  const confirmed = process.argv.includes('--yes');
  const name = dbName(databaseUrl('migration'));
  const allowed = /_(dev|test)$/.test(name) && config.nodeEnv !== 'production';
  if (!confirmed || !allowed) {
    console.error(
      `reset は _dev / _test データベースのみ、--yes 指定時だけ実行できます（対象: ${name || '(不明)'}, NODE_ENV=${config.nodeEnv}）`,
    );
    process.exit(2);
  }
  await withClient('migration', async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `truncate table request, request_history, comment, approval, attachment, draft, idempotency, request_counter, session, audit_log restart identity cascade`,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    await client.query('BEGIN');
    try {
      const result = await seedAll(client);
      await client.query('COMMIT');
      console.log(`reset 完了: 部署 ${result.departments} / 道具 ${result.tools} / 見本 ${result.demo} / 管理者 ${result.admin}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function verify(): Promise<void> {
  await withClient('app', async (client) => {
    const checks: { label: string; ok: boolean; detail: string }[] = [];
    const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });

    const tables = await client.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
    );
    add('テーブル数', (tables.rows[0]?.count ?? 0) >= 12, `${tables.rows[0]?.count} 件`);

    const dept = await client.query<{ count: number }>('select count(*)::int as count from department where selectable');
    add('部署 16（Mirai-Info）', dept.rows[0]?.count === 16, `${dept.rows[0]?.count} 件`);

    const tools = await client.query<{ signal: string; count: number }>(
      'select signal, count(*)::int as count from catalog_tool group by signal',
    );
    const by = Object.fromEntries(tools.rows.map((r) => [r.signal, r.count]));
    const total = (by.g ?? 0) + (by.y ?? 0) + (by.r ?? 0);
    add(
      '道具 118（青52/黄47/赤19）',
      total === 118 && by.g === 52 && by.y === 47 && by.r === 19,
      `計${total} 青${by.g} 黄${by.y} 赤${by.r}`,
    );

    const users = await client.query<{ count: number }>('select count(*)::int as count from app_user');
    add('利用者 1 以上', (users.rows[0]?.count ?? 0) >= 1, `${users.rows[0]?.count} 件`);

    const req = await client.query<{ count: number }>('select count(*)::int as count from request');
    add('依頼データ', (req.rows[0]?.count ?? 0) >= 0, `${req.rows[0]?.count} 件`);

    const orphan = await client.query<{ count: number }>(
      `select count(*)::int as count from request r left join department d on d.code=r.dept_code where d.code is null`,
    );
    add('部署外部キー整合', (orphan.rows[0]?.count ?? 0) === 0, `不整合 ${orphan.rows[0]?.count} 件`);

    const seq = await client.query<{ year: number; last_seq: number }>(
      'select year, last_seq from request_counter order by year',
    );
    const maxByYear = await client.query<{ year: number; max_seq: number }>(
      'select year, max(seq)::int as max_seq from request group by year',
    );
    const counterOk = maxByYear.rows.every((row) => (seq.rows.find((s) => s.year === row.year)?.last_seq ?? 0) >= row.max_seq);
    add('採番カウンタ', counterOk, JSON.stringify(seq.rows));

    const gap = await client.query<{ count: number }>(`select count(*)::int as count from request where seq > 9999 or seq < 1`);
    add('採番の範囲', (gap.rows[0]?.count ?? 0) === 0, `範囲外 ${gap.rows[0]?.count} 件`);

    const chain = await verifyAuditChain();
    add('監査ログのハッシュ連鎖', chain.ok, chain.ok ? `${chain.checked} 件 OK` : `破損 id=${chain.brokenAt}`);

    let failed = 0;
    for (const c of checks) {
      console.log(`${c.ok ? 'OK  ' : 'NG  '} ${c.label}: ${c.detail}`);
      if (!c.ok) failed += 1;
    }
    if (failed > 0) {
      console.error(`verify 失敗: ${failed} 件`);
      process.exit(1);
    }
    console.log('verify 成功');
  });
}

async function main(): Promise<void> {
  switch (command) {
    case 'migrate':
      await migrate();
      break;
    case 'seed':
      await seed();
      break;
    case 'reset':
      await reset();
      break;
    case 'verify':
      await verify();
      break;
    case 'seed:master':
      await withClient('migration', async (client) => {
        const r = await seedMaster(client);
        console.log(`master 完了: 部署 ${r.departments} / 道具 ${r.tools}`);
      });
      break;
    case 'seed:admin':
      await withClient('migration', async (client) => {
        const r = await seedAdmin(client);
        console.log(`admin: ${r.email}（新規: ${r.created}）`);
      });
      break;
    case 'rollback':
      console.log(
        'マイグレーションは additive のみです。ロールバックはバックアップからの復元、または forward fix で行います（docs/07-deployment.md 参照）。',
      );
      break;
    default:
      console.log('使い方: migrate | seed | reset --yes | verify | rollback');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
