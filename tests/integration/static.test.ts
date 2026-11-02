import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';

describe('静的ファイル配信の正規形でないパス', () => {
  const webDist = resolve(process.cwd(), 'dist/web');
  const createdWebDist = !existsSync(webDist);
  let app: FastifyInstance;

  beforeAll(async () => {
    if (createdWebDist) mkdirSync(webDist, { recursive: true });
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (createdWebDist) rmSync(webDist, { recursive: true });
  });

  it('API配下は 500 ではなく 404 ERR-104 を返す', async () => {
    const res = await app.inject({ method: 'GET', url: '/api//unknown' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('ERR-104');
  });

  it('API以外は 500 ではなくトップへリダイレクトする', async () => {
    const res = await app.inject({ method: 'GET', url: '//bridge.js' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('静的ファイルのキャッシュ', () => {
  const webDist = resolve(process.cwd(), 'dist/web');
  const createdWebDist = !existsSync(webDist);
  const file = resolve(webDist, '__cache-test.js');
  let app: FastifyInstance;

  beforeAll(async () => {
    mkdirSync(webDist, { recursive: true });
    writeFileSync(file, '// test\n');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(file, { force: true });
    if (createdWebDist) rmSync(webDist, { recursive: true, force: true });
  });

  it('毎回確認させ、変わっていなければ 304 で本体を送らない', async () => {
    const res = await app.inject({ method: 'GET', url: '/__cache-test.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    const etag = res.headers.etag as string;
    expect(etag).toBeTruthy();

    const again = await app.inject({ method: 'GET', url: '/__cache-test.js', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });
});
