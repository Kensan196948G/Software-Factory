#!/usr/bin/env node
/**
 * L-08（一覧の信号絞り込み）の性能実測。**合成データだけ**を使う。
 *
 * 何を測るか:
 *   - before: 旧実装（`listRequests` で最大 5000 件を取り、取得後に JS で
 *     `(signalDecided ?? suggested) === signal` を全件に適用）と同じ経路。
 *     `listRequests` に signal を渡さない呼び出しは origin/main の実装と同じ SQL になる。
 *   - after: 新実装（signal を SQL の WHERE に渡し、取得後の JS フィルタをしない）。
 *   同じ DB・同じデータ・同じプロセスで交互に測る。
 *
 * 使い方（接続先は `_test` で終わる DB のみ。開発・本番 DB を守るため）:
 *   node_modules/.bin/tsx scripts/perf/list-filter-bench.ts setup   --url 'postgresql:///mirai_sf_perf_test?host=/var/run/postgresql' --rows 10000
 *   node_modules/.bin/tsx scripts/perf/list-filter-bench.ts measure --url '...' --signal g --iter 7
 *   node_modules/.bin/tsx scripts/perf/list-filter-bench.ts explain --url '...' --signal g
 *
 * `setup` は接続先の schema public を作り直す（破壊的）。`_test` 以外では実行しない。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

type Mode = 'setup' | 'measure' | 'explain';

const argv = process.argv.slice(2);
const mode = argv[0] as Mode;
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const url = arg('url') ?? process.env.PERF_DATABASE_URL;
if (!url) {
  console.error('--url か PERF_DATABASE_URL で接続先を指定してください');
  process.exit(2);
}
if (!/^\w+:\/\//.test(url)) {
  console.error('接続文字列の形が不正です');
  process.exit(2);
}
const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
if (!/_test$/.test(dbName)) {
  console.error(`合成データの DB（名前が _test で終わる）だけを対象にします（対象: ${dbName || '(不明)'}）`);
  process.exit(2);
}

const signal = (arg('signal') ?? 'g') as 'g' | 'y' | 'r';
const rows = Number(arg('rows') ?? '10000');
const iter = Number(arg('iter') ?? '7');

const repoRoot = resolve(import.meta.dirname, '..', '..');

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const ms = (v: number) => Math.round(v * 10) / 10;

/* ───────────────────────────── setup ───────────────────────────── */

/** 空の schema へ migration を順に適用し、マスタ（部署・道具カタログ）を入れる。 */
async function resetAndSeed(client: pg.Client): Promise<void> {
  await client.query('drop schema if exists public cascade');
  await client.query('create schema public');
  await client.query('grant usage on schema public to public');
  const dir = resolve(repoRoot, 'db/migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await client.query(readFileSync(resolve(dir, file), 'utf8'));
  }
  const seedDir = resolve(repoRoot, 'db/seed');
  const departments = JSON.parse(readFileSync(resolve(seedDir, 'departments.json'), 'utf8')) as {
    code: string;
    name: string;
    short_name: string;
    role_desc: string;
    sort_order: number;
  }[];
  const tools = JSON.parse(readFileSync(resolve(seedDir, 'catalog.json'), 'utf8')) as {
    id: string;
    dept_code: string;
    name: string;
    description: string;
    signal: string;
    seed_candidate: boolean;
    sort_order: number;
  }[];
  for (const d of departments) {
    await client.query(`insert into department (code, name, short_name, role_desc, sort_order) values ($1,$2,$3,$4,$5)`, [
      d.code,
      d.name,
      d.short_name,
      d.role_desc,
      d.sort_order,
    ]);
  }
  for (const t of tools) {
    await client.query(
      `insert into catalog_tool (id, dept_code, name, description, signal, seed_candidate, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [t.id, t.dept_code, t.name, t.description, t.signal, t.seed_candidate, t.sort_order],
    );
  }
}

/**
 * 合成の依頼を N 件、決定的な式だけで作る（乱数の種に依存しない）。
 * 色の材料（decides / カタログ / データ / 社外 / 安全 / 決定済み）を満遍なく散らす。
 */
async function seedRequests(client: pg.Client, count: number): Promise<void> {
  await client.query(
    `insert into request (
       id, seq, year, created_at, updated_at, applicant, dept_code, title, kind, tool_id,
       problem, purpose, users, places, scope, out_of_scope, criteria, decides, data_handling,
       parties, constraints, constraints_other, requires_human_approval, frequency, minutes_per_time,
       data_ready, spread, approver, status, signal_decided, order_version, version, deleted
     )
     select
       'SYN-' || lpad(i::text, greatest(5, length($1::text)), '0'),
       i,
       2026,
       timestamptz '2026-10-01 09:00:00+09' - (i * interval '1 minute'),
       timestamptz '2026-10-01 09:00:00+09' - (i * interval '1 minute'),
       '合成 太郎',
       d.code,
       '合成の依頼 ' || i,
       case i % 4 when 0 then 'new_tool' when 1 then 'improve_tool' when 2 then 'bug_report' else 'consult' end,
       (select c.id from catalog_tool c where c.dept_code = d.code order by c.sort_order offset (i % 6) limit 1),
       '合成の困りごと ' || i,
       '合成の目的 ' || i,
       array['現場の担当者'],
       array['事務所'],
       array['合成の作るもの'],
       array['合成の対象外'],
       array['合成の合格条件1', '合成の合格条件2'],
       case i % 10 when 0 then 'g' when 1 then 'g' when 2 then 'g' when 3 then 'g' when 4 then 'g'
                   when 5 then 'y' when 6 then 'y' when 7 then 'y' else 'r' end,
       case i % 10 when 3 then array['photo']
                   when 6 then array['money', 'personal']
                   else array[]::text[] end,
       case i % 10 when 8 then 'partner' when 9 then 'client' else 'internal' end,
       array['写真・記録の原本は加工しない'],
       array[]::text[],
       case i % 20 when 5 then array['安全・品質の判定にかかわる変更']
                   when 11 then array['作業船の運航・海の上の作業にかかわる変更']
                   else array['提出様式の変更'] end,
       case i % 4 when 0 then 'd' when 1 then 'w' when 2 then 'm' else 'o' end,
       15,
       5,
       3,
       '鈴木 一郎',
       case i % 5 when 0 then 'approved' when 1 then 'wait' when 2 then 'review' else 'received' end,
       case i % 20 when 0 then null when 1 then null when 2 then null when 3 then null when 4 then null
                   when 5 then null when 6 then null when 7 then null
                   else (array['g','y','r'])[1 + (i % 3)] end,
       0,
       1,
       false
     from generate_series(1, $1::int) as i
     cross join lateral (select code from department order by sort_order offset (i % 19) limit 1) d`,
    [count],
  );
  // 滞留日数の計算（status_since）が参照する履歴。受付の1行と、3件に1件は状態変更の行も置く。
  await client.query(
    `insert into request_history (request_id, at, actor_name, actor_user_id, role, action, note, correlation_id)
     select r.id, r.created_at, '合成 太郎', null, 'desk', '受付', null, null from request r
     where r.id like 'SYN-%'`,
  );
  await client.query(
    `insert into request_history (request_id, at, actor_name, actor_user_id, role, action, note, correlation_id)
     select r.id, r.created_at + interval '10 minutes', '合成 花子', null, 'desk',
            '状態を「' || r.status || '」へ変更', '合成', null
       from request r
      where r.id like 'SYN-%' and (right(r.id, 5)::int % 3) = 0`,
  );
}

/* ─────────────────────────── before / after ─────────────────────────── */

interface VariantResult {
  fetchedRows: number;
  returned: number;
  total: number;
  ms: number;
}

/**
 * before: 旧実装（取得 → JS で全件フィルタ）。
 * `listRequests` に signal を渡さない場合の SQL は、signal 対応前の実装と同じ。
 */
async function runBefore(limit: number): Promise<VariantResult> {
  const { evaluateSignal } = await import('../../src/shared/domain.ts');
  const { listRequests, getCatalogSignals } = await import('../../src/api/repo.ts');
  const started = performance.now();
  const { rows } = await listRequests({ limit });
  const signals = await getCatalogSignals(rows.map((r) => r.tool_id).filter((v): v is string => Boolean(v)));
  const kept = rows.filter(
    (r) =>
      (r.signal_decided ??
        evaluateSignal({
          decides: r.decides,
          catalogSignal: r.tool_id ? (signals.get(r.tool_id) ?? null) : null,
          dataHandling: r.data_handling,
          parties: r.parties,
          approvals: r.requires_human_approval,
        }).color) === signal,
  );
  const elapsed = performance.now() - started;
  return { fetchedRows: rows.length, returned: kept.length, total: kept.length, ms: elapsed };
}

/** after: 新実装（signal を SQL の WHERE へ。取得後の全件フィルタはしない）。 */
async function runAfter(limit: number): Promise<VariantResult> {
  const { listRequests } = await import('../../src/api/repo.ts');
  const started = performance.now();
  const { rows, total } = await listRequests({ signal, limit });
  const elapsed = performance.now() - started;
  return { fetchedRows: rows.length, returned: rows.length, total, ms: elapsed };
}

/** 参考: 新実装のサービス層全体（要約の組み立て・ページングを含む）。 */
async function runAfterService(pageSize: number): Promise<{ returned: number; total: number; ms: number }> {
  const { listForActor } = await import('../../src/api/service.ts');
  const actor = { userId: '00000000-0000-4000-8000-000000000000', role: 'desk' as const, displayName: '合成 受付' };
  const started = performance.now();
  const result = await listForActor(actor, { signal, page: 1, pageSize });
  const elapsed = performance.now() - started;
  return { returned: result.items.length, total: result.total, ms: elapsed };
}

/* ───────────────────────────── main ───────────────────────────── */

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (mode === 'setup') {
    await client.query('begin');
    await resetAndSeed(client);
    await seedRequests(client, rows);
    await client.query('commit');
    await client.query('analyze');
    const check = await client.query<{ requests: number; history: number }>(
      `select (select count(*)::int from request) as requests,
              (select count(*)::int from request_history) as history`,
    );
    console.log(JSON.stringify({ mode, db: dbName, ...check.rows[0], signal }, null, 2));
  } else if (mode === 'measure') {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const limit = Number(arg('limit') ?? '5000');
    const pageSize = Number(arg('pageSize') ?? '50');

    // 暖機（接続と計画のキャッシュを温める）
    await runBefore(limit);
    await runAfter(limit);
    await runAfterService(pageSize);

    const before: number[] = [];
    const after: number[] = [];
    const service: number[] = [];
    let b: VariantResult | null = null;
    let a: VariantResult | null = null;
    let s: { returned: number; total: number; ms: number } | null = null;
    for (let i = 0; i < iter; i += 1) {
      b = await runBefore(limit);
      before.push(b.ms);
      a = await runAfter(limit);
      after.push(a.ms);
      s = await runAfterService(pageSize);
      service.push(s.ms);
    }
    console.log(
      JSON.stringify(
        {
          mode,
          db: dbName,
          signal,
          iter,
          limit,
          before: {
            fetchedRows: b?.fetchedRows,
            returned: b?.returned,
            total: b?.total,
            ms_min: ms(Math.min(...before)),
            ms_median: ms(median(before)),
            ms_all: before.map(ms),
          },
          after: {
            fetchedRows: a?.fetchedRows,
            returned: a?.returned,
            total: a?.total,
            ms_min: ms(Math.min(...after)),
            ms_median: ms(median(after)),
            ms_all: after.map(ms),
          },
          after_service: {
            returned: s?.returned,
            total: s?.total,
            ms_min: ms(Math.min(...service)),
            ms_median: ms(median(service)),
            ms_all: service.map(ms),
          },
        },
        null,
        2,
      ),
    );
  } else if (mode === 'explain') {
    const { suggestedSignalCaseSql, suggestedSignalParams } = await import('../../src/api/repo.ts');
    const [dataKeys, safety] = suggestedSignalParams();
    const SELECT_BASE = `
      select r.*, d.name as dept_name, t.name as tool_name,
             (select max(h.at) from request_history h
               where h.request_id = r.id
                 and (h.action like '状態を%' or h.action = '受付')) as status_since
        from request r
        join department d on d.code = r.dept_code
        left join catalog_tool t on t.id = r.tool_id`;
    const countFrom = 'from request r left join catalog_tool t on t.id = r.tool_id';
    const beforeSql = `${SELECT_BASE} where r.deleted = false order by r.created_at desc limit 5000`;
    const beforeCount = `select count(*)::int as count from request r where r.deleted = false`;
    const afterSql = `${SELECT_BASE} where r.deleted = false and coalesce(r.signal_decided, ${suggestedSignalCaseSql(
      1,
      2,
    )}) = $3 order by r.created_at desc limit 5000`;
    const afterCount = `select count(*)::int as count ${countFrom} where r.deleted = false and coalesce(r.signal_decided, ${suggestedSignalCaseSql(
      1,
      2,
    )}) = $3`;
    const plans: Record<string, string[]> = {};
    for (const [name, sql, params] of [
      ['before_rows', beforeSql, []],
      ['before_count', beforeCount, []],
      ['after_rows', afterSql, [dataKeys, safety, signal]],
      ['after_count', afterCount, [dataKeys, safety, signal]],
    ] as [string, string, unknown[]][]) {
      const res = await client.query(`explain (analyze, buffers, costs off) ${sql}`, params as never[]);
      plans[name] = res.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']);
    }
    const indexes = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'request' order by indexname`,
    );
    console.log(JSON.stringify({ mode, db: dbName, signal, indexes: indexes.rows.map((r) => r.indexname), plans }, null, 2));
  } else {
    console.error('使い方: list-filter-bench.ts setup|measure|explain --url <_test の DB>');
    process.exit(2);
  }
} finally {
  await client.end();
}
