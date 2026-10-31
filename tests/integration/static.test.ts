import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
