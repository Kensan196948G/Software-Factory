/**
 * L-08: 一覧の「信号の色」の絞り込みを、取得後の JS 全件フィルタから SQL の WHERE へ移したことの確認。
 *
 * 1. 画面の候補色（`evaluateSignal`）と SQL の CASE が、同じ行で同じ色になる（判定の等価性）
 * 2. 絞り込みがサーバで効く（返却件数と total が減る）
 * 3. ページング・並び順・既存のクエリパラメータとの併用が変わらない
 * 4. 不正値の扱いが従来と同じ（該当なし）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, buildTestApp, loginAs, prepareTestDb, sampleRequest, truncateBusiness } from './helpers.js';
import type { Authed } from './helpers.js';
import { many, query } from '../../src/api/db.js';
import { suggestedSignalCaseSql, suggestedSignalParams } from '../../src/api/repo.js';
import { evaluateSignal } from '../../src/shared/domain.js';
import type { Signal } from '../../src/shared/domain.js';

let app: FastifyInstance;

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

interface ListItem {
  id: string;
  title: string;
  status: string;
  deptCode: string;
  signalDecided: Signal | null;
  suggested: Signal;
}

interface ListBody {
  items: ListItem[];
  total: number;
  page: number;
  pageSize: number;
}

async function list(cookie: string, query = ''): Promise<ListBody> {
  const res = await app.inject({ method: 'GET', url: `/api/requests${query}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as ListBody;
}

/**
 * 合成の依頼を1件作る。作った依頼の「候補色」は decides / カタログの色 / データ / 社外 / 安全の組み合わせで決まる。
 * 実データは使わない（すべて作り物）。
 */
async function create(auth: Authed, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: authHeaders(auth),
    payload: sampleRequest(overrides),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { request: { id: string } }).request.id;
}

/** 色の判定に必要な列だけを SQL で読み、SQL の CASE と JS の evaluateSignal を突き合わせる。 */
async function effectiveSignals(): Promise<
  {
    id: string;
    signal_decided: Signal | null;
    effective: Signal;
    decides: string;
    data_handling: string[];
    parties: string;
    requires_human_approval: string[];
    catalog_signal: Signal | null;
  }[]
> {
  const [dataKeys, safety] = suggestedSignalParams();
  return many(
    `select r.id, r.signal_decided, r.decides, r.data_handling, r.parties, r.requires_human_approval,
            t.signal as catalog_signal,
            coalesce(r.signal_decided, ${suggestedSignalCaseSql(1, 2)}) as effective
       from request r
       left join catalog_tool t on t.id = r.tool_id
      order by r.id`,
    [dataKeys, safety],
  );
}

/** 旧実装（取得後に JS で濾す）と同じ結果を、API の全件から作る。 */
function legacyFilter(items: ListItem[], signal: string): ListItem[] {
  return items.filter((s) => (s.signalDecided ?? s.suggested) === signal);
}

/**
 * 青・黄・赤と、黄へ引き上げる条件（カタログの色・データ・社外・安全）をひととおり含む合成データ。
 * 期待値は evaluateSignal から計算する（決め打ちにしない）。
 */
const CASES: Record<string, unknown>[] = [
  { title: '青: 記録の道具', decides: 'g', dataHandling: [], parties: 'internal', approvals: [], toolId: null },
  { title: '黄: たたき台の道具', decides: 'y', dataHandling: [], parties: 'internal', approvals: [], toolId: null },
  { title: '赤: 決める仕事', decides: 'r', dataHandling: [], parties: 'internal', approvals: [], toolId: null },
  { title: '黄: 写真を扱う', decides: 'g', dataHandling: ['photo'], parties: 'internal', approvals: [], toolId: null },
  { title: '黄: 協力会社も使う', decides: 'g', dataHandling: [], parties: 'partner', approvals: [], toolId: null },
  {
    title: '黄: 安全の判定',
    decides: 'g',
    dataHandling: [],
    parties: 'internal',
    approvals: ['安全・品質の判定にかかわる変更'],
    toolId: null,
  },
  {
    title: '黄: カタログが黄',
    deptCode: 'keiei',
    decides: 'g',
    dataHandling: [],
    parties: 'internal',
    approvals: [],
    toolId: 'keiei-04',
  },
  {
    title: '赤: カタログが赤',
    deptCode: 'keiei',
    decides: 'g',
    dataHandling: [],
    parties: 'internal',
    approvals: [],
    toolId: 'keiei-06',
  },
  { title: '黄: 全部入り', decides: 'y', dataHandling: ['money'], parties: 'client', approvals: [], toolId: null },
  { title: '赤: 決める仕事とデータ', decides: 'r', dataHandling: ['personal'], parties: 'internal', approvals: [], toolId: null },
];

async function seedCases(auth: Authed): Promise<Map<string, Signal>> {
  const expected = new Map<string, Signal>();
  for (const c of CASES) {
    const id = await create(auth, c);
    expected.set(
      id,
      evaluateSignal({
        decides: String(c.decides),
        catalogSignal: c.toolId ? ((c.toolId as string) === 'keiei-04' ? 'y' : 'r') : null,
        dataHandling: c.dataHandling as string[],
        parties: String(c.parties),
        approvals: c.approvals as string[],
      }).color,
    );
  }
  return expected;
}

describe('信号の色: SQL の CASE と画面の判定（evaluateSignal）が一致する', () => {
  it('全件で SQL の色 = evaluateSignal の色（signal_decided があればそれが優先）', async () => {
    const desk = await loginAs(app);
    const expected = await seedCases(desk);
    // 承認で決まった色は候補より優先する（旧実装の signalDecided ?? suggested と同じ）
    const decided = await create(desk, { title: '決定済み: 候補は青でも赤', decides: 'g', toolId: null });
    await query(`update request set signal_decided='r' where id=$1`, [decided]);

    const rows = await effectiveSignals();
    expect(rows).toHaveLength(CASES.length + 1);
    for (const row of rows) {
      const jsColor =
        row.signal_decided ??
        evaluateSignal({
          decides: row.decides,
          catalogSignal: row.catalog_signal,
          dataHandling: row.data_handling,
          parties: row.parties,
          approvals: row.requires_human_approval,
        }).color;
      expect({ id: row.id, color: row.effective }).toEqual({ id: row.id, color: jsColor });
    }
    // 合成データが青・黄・赤のすべてを踏んでいること（片方しか無いと等価性の証拠にならない）
    const colors = new Set(rows.map((r) => r.effective));
    expect([...colors].sort()).toEqual(['g', 'r', 'y']);
    expect(expected.size).toBe(CASES.length);
  });
});

describe('信号の色: サーバ（SQL の WHERE）で絞り込む', () => {
  it('返却件数と total が減り、全件から JS で濾した結果と同じになる', async () => {
    const desk = await loginAs(app);
    await seedCases(desk);

    const all = await list(desk.cookie);
    expect(all.total).toBe(CASES.length);
    expect(all.items).toHaveLength(CASES.length);

    let sum = 0;
    for (const signal of ['g', 'y', 'r'] as const) {
      const filtered = await list(desk.cookie, `?signal=${signal}`);
      const legacy = legacyFilter(all.items, signal);
      expect(filtered.items.map((i) => i.id).sort()).toEqual(legacy.map((i) => i.id).sort());
      expect(filtered.total).toBe(legacy.length);
      expect(filtered.total).toBeLessThan(all.total); // 条件がサーバで効いている（減っている）
      for (const item of filtered.items) expect(item.signalDecided ?? item.suggested).toBe(signal);
      sum += filtered.total;
    }
    // 3色で全件を重複なく分ける（取りこぼし・二重計上なし）
    expect(sum).toBe(all.total);
  });

  it('signal_decided があれば候補色ではなく決定色で絞る', async () => {
    const desk = await loginAs(app);
    const id = await create(desk, {
      title: '候補は青・決定は赤',
      decides: 'g',
      dataHandling: [],
      approvals: [],
      toolId: null,
    });
    const before = await list(desk.cookie, '?signal=g');
    expect(before.items.map((i) => i.id)).toContain(id);

    await query(`update request set signal_decided='r' where id=$1`, [id]);

    const afterG = await list(desk.cookie, '?signal=g');
    expect(afterG.items.map((i) => i.id)).not.toContain(id);
    expect(afterG.total).toBe(before.total - 1);
    const afterR = await list(desk.cookie, '?signal=r');
    expect(afterR.items.map((i) => i.id)).toContain(id);
  });

  it('不正な値は従来どおり「該当なし」（200・0件）', async () => {
    const desk = await loginAs(app);
    await seedCases(desk);
    for (const value of ['x', 'g,r', 'G', '1']) {
      const res = await list(desk.cookie, `?signal=${encodeURIComponent(value)}`);
      expect({ value, total: res.total, items: res.items.length }).toEqual({ value, total: 0, items: 0 });
    }
    // 空文字は「絞り込みなし」（従来どおり全件）
    const empty = await list(desk.cookie, '?signal=');
    expect(empty.total).toBe(CASES.length);
  });
});

describe('信号の色: ページング・並び順・既存パラメータとの併用', () => {
  it('絞り込んだ結果を、同じ並び順（受付の新しい順）でページに切る', async () => {
    const desk = await loginAs(app);
    await seedCases(desk);

    const all = await list(desk.cookie);
    const legacyG = legacyFilter(all.items, 'g');

    const p1 = await list(desk.cookie, '?signal=g&pageSize=2&page=1');
    expect(p1.total).toBe(legacyG.length);
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(2);

    const p2 = await list(desk.cookie, '?signal=g&pageSize=2&page=2');
    expect(p2.total).toBe(legacyG.length);
    expect(p2.page).toBe(2);

    const paged = [...p1.items, ...p2.items].map((i) => i.id);
    // 全件を JS で濾してから切ったものと同じ（重複なし・順序も同じ）
    expect(paged).toEqual(legacyG.slice(0, 4).map((i) => i.id));
    expect(new Set(paged).size).toBe(paged.length);

    // 並び順は従来どおり created_at の新しい順（= 全件一覧の順序を保つ）
    const order = new Map(all.items.map((i, idx) => [i.id, idx]));
    const idxs = paged.map((id) => order.get(id) as number);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });

  it('部署・状態・キーワードとの併用は AND になる', async () => {
    const desk = await loginAs(app);
    await seedCases(desk);
    await create(desk, {
      title: '海の現場の赤',
      deptCode: 'kaijo',
      decides: 'r',
      dataHandling: [],
      approvals: [],
      toolId: null,
    });

    const all = await list(desk.cookie);
    const res = await list(desk.cookie, '?dept=kaijo&status=received&signal=r');
    expect(res.total).toBe(3); // 合成データの「赤: 決める仕事」2件 + 海の現場の赤
    for (const item of res.items) {
      expect(item.deptCode).toBe('kaijo');
      expect(item.status).toBe('received');
      expect(item.signalDecided ?? item.suggested).toBe('r');
    }
    const legacy = legacyFilter(
      all.items.filter((i) => i.deptCode === 'kaijo' && i.status === 'received'),
      'r',
    );
    expect(res.items.map((i) => i.id).sort()).toEqual(legacy.map((i) => i.id).sort());

    const q = await list(desk.cookie, '?signal=r&q=海の現場');
    expect(q.items.map((i) => i.title)).toEqual(['海の現場の赤']);
  });
});

/**
 * 一覧のページ取得。以前は「最大 5000 件を取ってから JS で切る」だったため、
 * 5001 件目以降のページが空になっていた。SQL の LIMIT/OFFSET で取ることの確認。
 */
describe('一覧: サーバ側のページ取得（LIMIT / OFFSET）', () => {
  /** 合成の依頼を N 件、直接入れる（API を N 回叩かずに 5000 件超を作る）。 */
  async function insertSynthetic(count: number): Promise<void> {
    await query(
      `insert into request (id, seq, year, created_at, updated_at, applicant, dept_code, title, kind,
                            problem, purpose, users, scope, criteria, decides, parties, approver, status)
       select 'SYN-' || lpad(i::text, 5, '0'), i, 2026,
              timestamptz '2026-01-01 00:00:00+09' - (i * interval '1 minute'),
              timestamptz '2026-01-01 00:00:00+09',
              '合成 太郎', 'dx', '合成 ' || i, 'consult', '合成', '合成',
              array['現場の担当者'], array['合成'], array['合成'], 'g', 'internal', '鈴木 一郎', 'received'
         from generate_series(1, $1::int) as i`,
      [count],
    );
  }

  it('5000 件を超えても、後ろのページが取れる（件数は全件）', async () => {
    const desk = await loginAs(app);
    await insertSynthetic(5100);

    const first = await list(desk.cookie, '?page=1&pageSize=50');
    expect(first.total).toBe(5100);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.id).toBe('SYN-00001'); // created_at の新しい順

    const p101 = await list(desk.cookie, '?page=101&pageSize=50');
    expect(p101.items.map((i) => i.id)).toEqual(Array.from({ length: 50 }, (_, k) => `SYN-${String(5001 + k).padStart(5, '0')}`));

    // 以前はここが空だった（取得上限 5000 件の外）
    const p102 = await list(desk.cookie, '?page=102&pageSize=50');
    expect(p102.total).toBe(5100);
    expect(p102.items).toHaveLength(50);
    expect(p102.items[0]?.id).toBe('SYN-05051');
    expect(p102.items.at(-1)?.id).toBe('SYN-05100');

    const beyond = await list(desk.cookie, '?page=103&pageSize=50');
    expect(beyond.items).toHaveLength(0);
    expect(beyond.total).toBe(5100);

    // 既定（pageSize 未指定）は 50 件のまま。返す形は変えない。
    const noParams = await list(desk.cookie);
    expect(noParams.items).toHaveLength(50);
    expect(noParams.page).toBe(1);
    expect(noParams.pageSize).toBe(50);
  });

  it('同じ時刻の行があっても、ページの継ぎ目で重複・欠落しない（created_at + id の安定ソート）', async () => {
    const desk = await loginAs(app);
    await insertSynthetic(12);
    await query(`update request set created_at = timestamptz '2026-01-01 00:00:00+09'`);

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await list(desk.cookie, `?page=${page}&pageSize=5`);
      expect(res.total).toBe(12);
      seen.push(...res.items.map((i) => i.id));
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? 1 : -1))); // id の降順で安定
  });

  it('色で絞ったページも、同じ条件の total と一致する', async () => {
    const desk = await loginAs(app);
    await insertSynthetic(5100);

    const blue = await list(desk.cookie, '?signal=g&page=102&pageSize=50');
    expect(blue.total).toBe(5100);
    expect(blue.items).toHaveLength(50);
    for (const item of blue.items) expect(item.signalDecided ?? item.suggested).toBe('g');

    const red = await list(desk.cookie, '?signal=r&page=1&pageSize=50');
    expect(red.total).toBe(0);
    expect(red.items).toHaveLength(0);
  });

  it('page / pageSize の不正値は有限の整数へ丸め、500 を返さない', async () => {
    const desk = await loginAs(app);
    await insertSynthetic(3);

    for (const query of ['?page=abc&pageSize=50', '?page=1.1&pageSize=2.5', '?page=Infinity&pageSize=Infinity']) {
      const res = await list(desk.cookie, query);
      expect(Number.isInteger(res.page)).toBe(true);
      expect(res.page).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(res.pageSize)).toBe(true);
      expect(res.pageSize).toBeGreaterThanOrEqual(1);
      expect(res.pageSize).toBeLessThanOrEqual(500);
      expect(res.items.length).toBeLessThanOrEqual(res.pageSize);
    }
  });

  it('ホームの total は 5000 件を超えても全件を数える', async () => {
    const desk = await loginAs(app);
    await insertSynthetic(5100);

    const res = await app.inject({ method: 'GET', url: '/api/home', headers: { cookie: desk.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: { total: number; waitingApproval: number } };
    expect(body.counts.total).toBe(5100);
    expect(body.counts.waitingApproval).toBe(0);
  });
});
