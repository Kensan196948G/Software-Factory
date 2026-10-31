/**
 * 結合テストの前提: `mirai_sf_test` を空にして migration を適用する。
 * 破壊的だが、DB名が `_test` で終わる場合のみ実行する（本番・開発DBを守る）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_MIGRATION_DATABASE_URL / TEST_DATABASE_URL が未設定です');
  const name = (() => {
    try {
      return new URL(url).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();
  if (!/_test$/.test(name)) throw new Error(`結合テストは _test DB でのみ実行します（対象: ${name}）`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('grant usage on schema public to public');
    const dir = resolve(process.cwd(), 'db/migrations');
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      await client.query(readFileSync(resolve(dir, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}
