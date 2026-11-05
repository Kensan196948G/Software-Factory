import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// scripts/ops/healthcheck.mjs のオフサイト（R2）送信記録の鮮度確認。
// 偽の /healthz（このテスト内の HTTP サーバー）と一時ディレクトリだけを使う。
// 実サービス・実 DB・R2・systemd には触らない。

const SCRIPT = resolve('scripts/ops/healthcheck.mjs');
const COMMIT = 'a'.repeat(40);
// 送信記録に入る値。出力へ漏れていないことを確かめる
const BUCKET = 'test-bucket-should-not-appear';
const DUMP_KEY = 'prod/mirai_sf_prod-test.dump-key-should-not-appear';
const SHA = 'f'.repeat(64);

let server: Server;
let healthUrl = '';
let root = '';
let backupDir = '';

type RunResult = { code: number; out: string };

function run(extraEnv: Record<string, string | undefined>): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    MIRAI_SF_HEALTH_URL: healthUrl,
    MIRAI_SF_HEALTH_ENV: 'production',
    MIRAI_SF_HOME: join(root, 'home'),
    MIRAI_SF_HEALTH_STATE_FILE: join(root, 'state', `healthcheck-${Math.random().toString(36).slice(2)}.json`),
    MIRAI_SF_HEALTH_BACKUP_DIR: backupDir,
    MIRAI_SF_HEALTH_BACKUP_MAX_AGE_MIN: '90',
    MIRAI_SF_REPO: root,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // execFile（非同期）でないと、同じプロセス内の偽 /healthz が応答できない
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [SCRIPT], { env, cwd: root, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

function writeDump(name: string, ageMinutes: number) {
  const path = join(backupDir, name);
  writeFileSync(path, 'dummy dump');
  const at = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, at, at);
}

function writeRecord(dumpName: string, uploadedAgeMinutes: number | null, mtimeAgeMinutes: number) {
  const path = join(backupDir, `${dumpName}.r2.json`);
  const record: Record<string, unknown> = {
    bucket: BUCKET,
    dump: { key: DUMP_KEY, size: 10, sha256: SHA },
    manifest: { key: `${DUMP_KEY}.manifest`, size: 1, sha256: SHA },
  };
  if (uploadedAgeMinutes !== null) {
    record.uploadedAt = new Date(Date.now() - uploadedAgeMinutes * 60_000).toISOString();
  }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const at = new Date(Date.now() - mtimeAgeMinutes * 60_000);
  utimesSync(path, at, at);
}

function expectNoRecordContents(out: string) {
  expect(out).not.toContain(BUCKET);
  expect(out).not.toContain(DUMP_KEY);
  expect(out).not.toContain(SHA);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mirai-sf-healthcheck-offsite-'));
  mkdirSync(join(root, 'home', 'current'), { recursive: true });
  writeFileSync(join(root, 'home', 'current', 'release.env'), `COMMIT_SHA=${COMMIT}\n`);
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', environment: 'production', commit: COMMIT, db: { ok: true } }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  const { port } = server.address() as AddressInfo;
  healthUrl = `http://127.0.0.1:${port}/healthz`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  backupDir = join(root, `backups-${Math.random().toString(36).slice(2)}`);
  mkdirSync(backupDir, { recursive: true });
  writeDump('mirai_sf_prod-new.dump', 10);
});

describe('healthcheck.mjs のオフサイト送信記録の鮮度確認', () => {
  it('正常: 最新の送信記録が閾値内なら OK（記録の中身は出力しない）', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 200, 200);
    writeRecord('mirai_sf_prod-new.dump', 12, 12);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(0);
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-new.dump.r2.json');
    expect(out).toContain('uploadedAt 基準');
    expect(out).toContain('healthcheck OK');
    expectNoRecordContents(out);
  }, 40_000);

  it('古い: ローカル dump が新しくても、送信記録が閾値より古ければ NG', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 200, 200);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('最新のオフサイト送信記録が古すぎます');
    expect(out).toContain('> 90 分');
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
  }, 40_000);

  it('古い: mtime が新しくても JSON の uploadedAt が古ければ uploadedAt を優先して NG', async () => {
    writeRecord('mirai_sf_prod-new.dump', 180, 1);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('uploadedAt 基準');
    expectNoRecordContents(out);
  }, 40_000);

  it('uploadedAt が無い記録は mtime で判断する', async () => {
    writeRecord('mirai_sf_prod-new.dump', null, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(0);
    expect(out).toContain('mtime 基準');
  }, 40_000);

  it('無し: 送信記録（*.dump.r2.json）が 1 件も無ければ NG', async () => {
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('オフサイト送信記録（*.dump.r2.json）がありません');
    expect(out).toContain('healthcheck NG');
  }, 40_000);

  it('未設定なら従来どおり確認しない（送信記録が無くても OK）', async () => {
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: undefined });
    expect(code, out).toBe(0);
    expect(out).not.toContain('オフサイト');
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('不正な閾値は設定ミスとして NG（値は出さない）', async () => {
    writeRecord('mirai_sf_prod-new.dump', 5, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: 'ninety-secret' });
    expect(code, out).toBe(1);
    expect(out).toContain('MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN が正の整数（分）ではありません');
    expect(out).not.toContain('ninety-secret');
  }, 40_000);
});
