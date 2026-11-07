import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// PostgreSQL の numeric / bigint を安全に扱うための設定。
pg.types.setTypeParser(20, (value: string) => Number(value)); // int8
pg.types.setTypeParser(1700, (value: string) => Number(value)); // numeric

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'mirai-sf-intake',
});

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<pg.QueryResult<T>> {
  return db.query<T>(text, params as never[]);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | null> {
  const result = await query<T>(text, params, db);
  return result.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> {
  const result = await query<T>(text, params, db);
  return result.rows;
}

/** トランザクション。失敗時は必ずロールバックする。 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ロールバック失敗は元のエラーを優先する
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = process.hrtime.bigint();
  try {
    await pool.query('select 1');
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return { ok: true, latencyMs: Math.round(latencyMs * 10) / 10 };
  } catch (err) {
    return { ok: false, latencyMs: -1, error: (err as Error).message };
  }
}

/**
 * 有効な利用者（`app_user.is_active = true`）の件数。外形監視用（limitations C-07）。
 *
 * DB 復元直後・全利用者の無効化では「認証経路の構成は ready なのに全員 401」になる。
 * `/healthz` は構成だけを見ていたためこの状態を検知できなかったので、件数を 1 つ足す。
 * **返すのは件数だけ**で、メール・ID・名前は返さない。
 */
export async function countActiveUsers(): Promise<number> {
  const row = await one<{ count: number }>('select count(*)::int as count from app_user where is_active');
  return row?.count ?? 0;
}
