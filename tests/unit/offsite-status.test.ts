/**
 * オフサイト状態の検証ツール（scripts/ops/offsite-status.ts）の単体テスト。
 * 一時ディレクトリに世代一式を作り、欠落・不一致・鮮度の判定を固定する。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkOffsiteStatus, formatReport, inspectGeneration } from '../../scripts/ops/offsite-status.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'offsite-status-'));
  dirs.push(dir);
  return dir;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

const DUMP = Buffer.from('dump-bytes');
const MANIFEST = Buffer.from('manifest-bytes');

interface Options {
  name?: string;
  makeDump?: boolean;
  makeManifest?: boolean;
  makeR2?: boolean;
  r2DumpSize?: number;
  r2DumpSha?: string;
  uploadedAt?: string;
}

/** 1 世代分のファイルを作る（既定は整合した状態）。 */
async function makeGeneration(dir: string, options: Options = {}): Promise<string> {
  const name = options.name ?? 'mirai_sf_prod-20261106T000000Z';
  const dumpPath = join(dir, `${name}.dump`);
  const manifestPath = join(dir, `${name}.manifest.tsv`);
  const markerPath = join(dir, `${name}.dump.r2.json`);

  if (options.makeDump !== false) await writeFile(dumpPath, DUMP);
  if (options.makeManifest !== false) await writeFile(manifestPath, MANIFEST);
  if (options.makeR2 !== false) {
    const marker = {
      bucket: 'test-bucket',
      uploadedAt: options.uploadedAt ?? new Date().toISOString(),
      dump: { key: `${name}.dump`, size: options.r2DumpSize ?? DUMP.length, sha256: options.r2DumpSha ?? sha256(DUMP) },
      manifest: { key: `${name}.manifest.tsv`, size: MANIFEST.length, sha256: sha256(MANIFEST) },
    };
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }
  return name;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('inspectGeneration', () => {
  it('dump・manifest・r2.json が揃っていれば問題なし', async () => {
    const dir = await tempDir();
    const name = await makeGeneration(dir);
    const gen = inspectGeneration(dir, name);
    expect(gen.problems).toEqual([]);
    expect(gen.r2.present).toBe(true);
    expect(gen.dumpBytes).toBe(DUMP.length);
    expect(gen.r2.dumpSha256).toBe(sha256(DUMP));
  });

  it('r2.json が無ければ「オフサイト送信記録が無い」', async () => {
    const dir = await tempDir();
    const name = await makeGeneration(dir, { makeR2: false });
    const gen = inspectGeneration(dir, name);
    expect(gen.r2.present).toBe(false);
    expect(gen.problems.some((p) => p.includes('r2.json'))).toBe(true);
  });

  it('dump のサイズが r2 と違えば不一致を報告する', async () => {
    const dir = await tempDir();
    const name = await makeGeneration(dir, { r2DumpSize: DUMP.length + 1 });
    const gen = inspectGeneration(dir, name);
    expect(gen.problems.some((p) => p.includes('dump のサイズ不一致'))).toBe(true);
  });

  it('dump の SHA-256 が違えば不一致を報告する', async () => {
    const dir = await tempDir();
    const name = await makeGeneration(dir, { r2DumpSha: 'f'.repeat(64) });
    const gen = inspectGeneration(dir, name);
    expect(gen.problems.some((p) => p.includes('dump の SHA-256 不一致'))).toBe(true);
  });

  it('manifest が無ければ報告する', async () => {
    const dir = await tempDir();
    const name = await makeGeneration(dir, { makeManifest: false });
    const gen = inspectGeneration(dir, name);
    expect(gen.problems.some((p) => p.includes('manifest が無い'))).toBe(true);
  });
});

describe('checkOffsiteStatus', () => {
  it('直近 N 世代がすべて整合していれば ok', async () => {
    const dir = await tempDir();
    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T010000Z' });
    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T020000Z' });
    const report = checkOffsiteStatus({ backupDir: dir, count: 2, now: Date.now() });
    expect(report.ok).toBe(true);
    expect(report.generations.map((g) => g.name)).toEqual([
      'mirai_sf_prod-20261106T020000Z',
      'mirai_sf_prod-20261106T010000Z',
    ]);
  });

  it('世代数が要求に足りなければ NG', async () => {
    const dir = await tempDir();
    await makeGeneration(dir);
    const report = checkOffsiteStatus({ backupDir: dir, count: 3 });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('足りません'))).toBe(true);
  });

  it('最新世代の r2 が古ければ鮮度で NG', async () => {
    const dir = await tempDir();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await makeGeneration(dir, { uploadedAt: old });
    const report = checkOffsiteStatus({ backupDir: dir, count: 1, maxAgeMinutes: 90 });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('古すぎます'))).toBe(true);
    expect(report.newestOffsiteAgeMinutes).toBeGreaterThan(170);
  });

  it('1 世代でも欠落があれば NG で世代名が分かる', async () => {
    const dir = await tempDir();
    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T010000Z' });
    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T020000Z', makeR2: false });
    const report = checkOffsiteStatus({ backupDir: dir, count: 2 });
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.startsWith('mirai_sf_prod-20261106T020000Z:'))).toBe(true);
  });

  it('存在しないディレクトリは NG（例外にしない）', async () => {
    const report = checkOffsiteStatus({ backupDir: join(tmpdir(), 'no-such-dir-offsite-status'), count: 1 });
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it('count が範囲外なら usage エラー', async () => {
    const dir = await tempDir();
    expect(() => checkOffsiteStatus({ backupDir: dir, count: 0 })).toThrow(/--count/);
    expect(() => checkOffsiteStatus({ backupDir: dir, count: 100 })).toThrow(/--count/);
  });
});

describe('formatReport', () => {
  it('OK と NG を人が読める行で返す', async () => {
    const dir = await tempDir();
    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T020000Z' });
    const okReport = checkOffsiteStatus({ backupDir: dir, count: 1 });
    const okLines = formatReport(okReport);
    expect(okLines[0]).toContain('OK');
    expect(okLines.some((l) => l.includes('r2=あり'))).toBe(true);

    await makeGeneration(dir, { name: 'mirai_sf_prod-20261106T030000Z', makeR2: false });
    const ngReport = checkOffsiteStatus({ backupDir: dir, count: 1 });
    const ngLines = formatReport(ngReport);
    expect(ngLines[0]).toContain('NG');
    expect(ngLines.some((l) => l.includes('NG:'))).toBe(true);
  });
});
