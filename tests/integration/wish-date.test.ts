import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, buildTestApp, loginAs, prepareTestDb, sampleRequest, truncateBusiness } from './helpers.js';
import { query } from '../../src/api/db.js';

/**
 * 希望日（date 型）がサーバのタイムゾーンでずれないこと。
 * `TZ=Asia/Tokyo pnpm test` と `TZ=UTC pnpm test` の両方で確認する。データはすべて作り物。
 */
let app: FastifyInstance;

type Detail = { id: string; version: number; wishDate: string | null; title: string };

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

async function create(headers: Record<string, string>, wishDate: string): Promise<Detail> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers,
    payload: sampleRequest({ wishDate }),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { request: Detail }).request;
}

async function read(headers: Record<string, string>, id: string): Promise<Detail> {
  const res = await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { request: Detail }).request;
}

describe(`希望日のずれ（TZ=${process.env.TZ ?? '未指定'}）`, () => {
  for (const wish of ['2026-01-31', '2026-02-28', '2026-03-01', '2026-12-31', '2027-01-01', '2028-02-29']) {
    it(`${wish}: 受付 → 読み直し → 編集を繰り返しても変わらない`, async () => {
      const auth = await loginAs(app, 'desk');
      const headers = authHeaders(auth);
      const created = await create(headers, wish);
      expect(created.wishDate).toBe(wish);

      let current = await read(headers, created.id);
      for (let round = 1; round <= 3; round++) {
        expect(current.wishDate).toBe(wish);
        // 画面と同じく、読み出した値をそのまま送り返す
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/requests/${created.id}`,
          headers,
          payload: sampleRequest({ title: `作り物の件名 ${round}`, wishDate: current.wishDate, version: current.version }),
        });
        expect(res.statusCode).toBe(200);
        expect((res.json() as { detail: Detail }).detail.wishDate).toBe(wish);
        current = await read(headers, created.id);
      }
      const row = await query<{ wish: string }>(`select to_char(wish_date, 'YYYY-MM-DD') as wish from request where id = $1`, [
        created.id,
      ]);
      expect(row.rows[0]?.wish).toBe(wish);
    });
  }

  it('すでに 1 日ずれて保存された行（合成データ）は、読み書きでさらにずれない。自動では補正しない', async () => {
    const auth = await loginAs(app, 'desk');
    const headers = authHeaders(auth);
    const intended = '2027-01-01';
    const shifted = '2026-12-31'; // 旧実装の JST で 1 回編集された状態を合成する
    const created = await create(headers, intended);
    await query(`update request set wish_date = $2::date where id = $1`, [created.id, shifted]);

    let current = await read(headers, created.id);
    expect(current.wishDate).toBe(shifted);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/requests/${created.id}`,
      headers,
      payload: sampleRequest({ title: '作り物の件名（再編集）', wishDate: current.wishDate, version: current.version }),
    });
    expect(res.statusCode).toBe(200);
    current = await read(headers, created.id);
    expect(current.wishDate).toBe(shifted);
  });
});
