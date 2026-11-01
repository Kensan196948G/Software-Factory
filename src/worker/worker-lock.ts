/**
 * 実 runner の worker を1台に強制する（PostgreSQL の advisory lock）。
 *
 * - 起動時の片付け（sweepOrphans）は「他に worker がいない」ことが前提。取れなければ起動を拒否し、片付けもしない。
 * - セッションのロックなので、接続を1本持ち続ける。プロセスが落ちれば接続と一緒に外れる。
 * - 接続を失うとロックも失う。isHeld が false になったら新しい AI を動かさず、動いている AI は止める。
 * - ロックは DB ごと。別の DB の worker とは競合しないので、片付けの範囲（scope）も DB ごとに分ける。
 */
import { createHash } from 'node:crypto';
import { pool } from '../api/db.js';

/** 監査の advisory lock（1つの bigint のキー）と重ならないように、2つの int のキーを使う。 */
const LOCK_CLASS = 0x4d5346; // 'MSF'
const LOCK_ID = 0x444c; // 'DL'

export interface WorkerLock {
  /** Docker のラベルに入れる片付けの範囲。DB 名のハッシュ（名前は出さない）。 */
  scope: string;
  isHeld(): boolean;
  release(): Promise<void>;
}

/** 取れなければ null。 */
export async function acquireWorkerLock(): Promise<WorkerLock | null> {
  const client = await pool.connect();
  let held = true;
  const lost = (): void => {
    held = false;
  };
  // 借りている間は pool がエラーを受けないので、ここで受ける（受けないとプロセスが落ちる）
  client.on('error', lost);
  client.on('end', lost);
  const giveBack = (destroy: boolean): void => {
    client.removeListener('error', lost);
    client.removeListener('end', lost);
    client.release(destroy);
  };
  let row: { locked: boolean; db: string } | undefined;
  try {
    const result = await client.query<{ locked: boolean; db: string }>(
      'select pg_try_advisory_lock($1::int, $2::int) as locked, current_database() as db',
      [LOCK_CLASS, LOCK_ID],
    );
    row = result.rows[0];
  } catch (err) {
    giveBack(true);
    throw err;
  }
  if (!row?.locked) {
    giveBack(false);
    return null;
  }
  const scope = createHash('sha256').update(row.db, 'utf8').digest('hex').slice(0, 16);
  let released = false;
  return {
    scope,
    isHeld: () => held && !released,
    async release() {
      if (released) return;
      released = true;
      // 接続ごと捨てる。プールへ戻すとセッションのロックが残る恐れがある
      await client.query('select pg_advisory_unlock($1::int, $2::int)', [LOCK_CLASS, LOCK_ID]).catch(() => undefined);
      giveBack(true);
    },
  };
}
