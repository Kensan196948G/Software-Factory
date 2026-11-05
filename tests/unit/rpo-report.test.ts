import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// scripts/ops/rpo-report.mjs の境界・fail-closed テスト。
// 一時ディレクトリに合成した dump / manifest / 送信記録（mtime と uploadedAt を制御）だけを使う。
// 実バックアップ・DB・R2・systemd には触らない。

const SCRIPT = resolve('scripts/ops/rpo-report.mjs');
const MIN = 60_000;
// 送信記録に入る値。出力へ漏れていないことを確かめる
const BUCKET = 'rpo-test-bucket-should-not-appear';
const KEY_PREFIX = 'prod/rpo-test-key-should-not-appear';
const SHA = 'e'.repeat(64);
const FAILURE_REASON = 'secret-failure-reason-should-not-appear';

let root = '';
let dir = '';
let healthState = '';
/** テストの基準時刻（until）。実行時刻より少し前に固定し、各世代をここからの相対で置く。 */
let base = 0;

type RunResult = { code: number; out: string; json: any };

function run(args: string[], json = true): Promise<RunResult> {
  const argv = [SCRIPT, '--dir', dir, '--health-state', healthState, '--until', new Date(base).toISOString(), ...args];
  if (json) argv.push('--json');
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      argv,
      { env: { PATH: process.env.PATH, HOME: root }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        let parsed: any = null;
        if (json) {
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }
        }
        resolvePromise({ code, out: `${stdout}\n${stderr}`, json: parsed });
      },
    );
  });
}

function stampName(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `mirai_sf_prod-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function setMtime(path: string, at: number) {
  const date = new Date(at);
  utimesSync(path, date, date);
}

type GenOptions = {
  /** dump の完成時刻（mtime）。snapshot 時刻（名前）はこの 10 秒前 */
  doneAt: number;
  /** R2 送信記録の uploadedAt。null なら記録を作らない。undefined なら doneAt + 10 秒 */
  uploadedAt?: number | null;
  manifest?: boolean;
};

/** 1 世代を作る。名前の snapshot 時刻は doneAt の 10 秒前（秒単位に切り捨て）。 */
function generation({ doneAt, uploadedAt, manifest = true }: GenOptions) {
  const snapshotAt = Math.floor((doneAt - 10_000) / 1000) * 1000;
  const name = stampName(snapshotAt);
  const dump = join(dir, `${name}.dump`);
  writeFileSync(dump, 'dummy dump');
  setMtime(dump, doneAt);
  if (manifest) {
    const path = join(dir, `${name}.manifest.tsv`);
    writeFileSync(path, '#audit_tip\t\nrequests\t1\n');
    setMtime(path, doneAt - 5_000);
  }
  const uploaded = uploadedAt === undefined ? doneAt + 10_000 : uploadedAt;
  if (uploaded !== null) {
    const path = join(dir, `${name}.dump.r2.json`);
    writeFileSync(
      path,
      `${JSON.stringify({ bucket: BUCKET, uploadedAt: new Date(uploaded).toISOString(), dump: { key: `${KEY_PREFIX}/${name}.dump`, size: 10, sha256: SHA } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    setMtime(path, uploaded);
  }
  return { name, dump, record: join(dir, `${name}.dump.r2.json`) };
}

/** 毎時（間隔 stepMs）で n 世代を、最新が base - lastAgoMs になるように作る。 */
function series(n: number, stepMs: number, lastAgoMs = 10 * MIN) {
  const made = [];
  for (let i = n - 1; i >= 0; i -= 1) made.push(generation({ doneAt: base - lastAgoMs - i * stepMs }));
  return made;
}

/** 配列の要素を取り出す（無ければテストを失敗させる）。 */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} がありません`);
  return item;
}

function expectNoSecrets(out: string) {
  expect(out).not.toContain(BUCKET);
  expect(out).not.toContain(KEY_PREFIX);
  expect(out).not.toContain(SHA);
  expect(out).not.toContain(FAILURE_REASON);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mirai-sf-rpo-report-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dir = join(root, `backups-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  healthState = join(root, `health-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    healthState,
    JSON.stringify({
      ok: true,
      checkedAt: '2026-11-05T08:00:00.000Z',
      consecutiveFailures: 0,
      totalFailures: 3,
      lastFailureAt: '2026-11-04T01:00:00.000Z',
      lastFailureReason: FAILURE_REASON,
    }),
  );
  // 実行時刻の 1 分前・秒の境界に揃える
  base = Math.floor((Date.now() - MIN) / 1000) * 1000;
});

describe('rpo-report.mjs', () => {
  it('59:59 間隔だけなら OK（終了コード 0）。中身・失敗理由は出さず、healthcheck の件数は併記', async () => {
    series(6, 59 * MIN + 59_000);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(0);
    expect(json.verdict).toBe('ok');
    expect(json.local.overThresholdCount).toBe(0);
    expect(json.offsite.overThresholdCount).toBe(0);
    expect(json.local.maxGapClock).toBe('59:59.000');
    expect(json.restorable.minutesSinceUpload).toBeCloseTo(9.8, 1);
    expect(json.healthcheck).toMatchObject({ available: true, totalFailures: 3, lastFailureAt: '2026-11-04T01:00:00.000Z' });
    expect(json.healthcheck).not.toHaveProperty('lastFailureReason');
    expectNoSecrets(out);
  }, 40_000);

  it('境界: ちょうど 60:00 は閾値内（ミリ秒で比較）', async () => {
    series(4, 60 * MIN);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(0);
    expect(json.local.maxGapClock).toBe('60:00.000');
  }, 40_000);

  it('境界: 60:01 の間隔が 1 つでもあれば gap（終了コード 1）。区間を出す', async () => {
    const t0 = base - 10 * MIN - 3 * 60 * MIN;
    generation({ doneAt: t0 });
    generation({ doneAt: t0 + 60 * MIN });
    generation({ doneAt: t0 + 120 * MIN + 1_000 }); // 60:01
    generation({ doneAt: t0 + 180 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(1);
    expect(json.verdict).toBe('gap');
    expect(json.local.overThresholdCount).toBe(1);
    expect(json.local.overThreshold[0]).toMatchObject({ clock: '60:01.000', from: new Date(t0 + 60 * MIN).toISOString() });
    expect(json.offsite.overThresholdCount).toBe(1);
  }, 40_000);

  it('境界: 丸めると 60.0 分になる 60:00.1 でも gap（丸めた分で比べない）', async () => {
    const t0 = base - 10 * MIN - 60 * MIN - 100;
    generation({ doneAt: t0, uploadedAt: t0 + 10_000 });
    generation({ doneAt: t0 + 60 * MIN + 100, uploadedAt: t0 + 10_000 + 60 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(1);
    expect(json.local.overThreshold[0]).toMatchObject({ minutes: 60, clock: '60:00.100' });
    expect(json.offsite.overThresholdCount).toBe(0);
  }, 40_000);

  it('記録欠落: dump は毎時でも R2 送信記録が 1 世代抜けると R2 系列だけ gap', async () => {
    const t0 = base - 10 * MIN - 3 * 60 * MIN;
    generation({ doneAt: t0 });
    generation({ doneAt: t0 + 60 * MIN });
    generation({ doneAt: t0 + 120 * MIN, uploadedAt: null }); // 送信失敗
    generation({ doneAt: t0 + 180 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(1);
    expect(json.local.overThresholdCount).toBe(0);
    expect(json.offsite.overThresholdCount).toBe(1);
    expect(json.offsite.maxGapClock).toBe('120:00.000');
    expect(json.counts).toMatchObject({ dumps: 4, offsiteRecords: 3 });
  }, 40_000);

  it('未完了の間隔: 最新の復元可能 snapshot から閾値超が経過していれば gap', async () => {
    series(4, 50 * MIN, 61 * MIN);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(1);
    expect(json.offsite.openGapOverThreshold).toBe(true);
    expect(json.restorable.minutesSinceUpload).toBeGreaterThan(60);
  }, 40_000);

  it('--since で対象外期間を除く: 開始前の空白は数えず、開始をまたぐ間隔は数える', async () => {
    // オフサイト設定前の世代（送信記録なし）。old1 → old2 は 940 分の空白
    generation({ doneAt: base - 20 * 60 * MIN, uploadedAt: null });
    generation({ doneAt: base - 260 * MIN, uploadedAt: null });
    series(5, 55 * MIN); // 最古は base - 230 分

    // 直近 1 日: 期間内の 940 分の空白が gap
    const day = await run(['--days', '1']);
    expect(day.code, day.out).toBe(1);
    expect(day.json.local.overThreshold[0]).toMatchObject({ clock: '940:00.000', crossesStart: false });

    // 開始を old2 の後にすると、空白は対象外。old2 は開始前の基点として開始をまたぐ間隔（30 分）に使う
    const since = await run(['--since', new Date(base - 240 * MIN).toISOString()]);
    expect(since.code, since.out).toBe(0);
    expect(since.json.local).toMatchObject({ hasAnchorBeforeStart: true, maxGapClock: '55:00.000' });
    expect(since.json.offsite.hasAnchorBeforeStart).toBe(false);
    expect(since.json.offsite.leadingMinutes).toBe(10.2); // 開始 → 最初の uploadedAt（完成の 10 秒後）

    // 開始が空白の途中なら、開始をまたぐ間隔として数える
    const crossing = await run(['--since', new Date(base - 300 * MIN).toISOString()]);
    expect(crossing.code, crossing.out).toBe(1);
    expect(crossing.json.local.overThreshold[0]).toMatchObject({ clock: '940:00.000', crossesStart: true });
  }, 40_000);

  it('データ不足: 時刻が 2 つ未満なら終了コード 2', async () => {
    generation({ doneAt: base - 10 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.verdict).toBe('insufficient');
    expect(json.reasons.join('\n')).toContain('データ不足');
  }, 40_000);

  it('manifest の無い dump は完成した世代として数えない', async () => {
    series(3, 30 * MIN);
    generation({ doneAt: base - 5 * MIN, manifest: false, uploadedAt: null });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(0);
    expect(json.counts).toMatchObject({ dumps: 3, dumpsWithoutManifest: 1 });
  }, 40_000);

  it('壊れた JSON の送信記録は黙って除外せず検証不能（終了コード 2）', async () => {
    const made = series(4, 30 * MIN);
    writeFileSync(at(made, 1).record, `{"bucket":"${BUCKET}", broken`);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors).toEqual([{ file: `${at(made, 1).name}.dump.r2.json`, reason: 'JSON として解釈できません' }]);
    expectNoSecrets(out);
  }, 40_000);

  it('uploadedAt の無い送信記録は mtime で代用せず検証不能', async () => {
    const made = series(3, 30 * MIN);
    writeFileSync(at(made, 0).record, JSON.stringify({ bucket: BUCKET }));
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors[0].reason).toBe('uploadedAt がありません');
  }, 40_000);

  it('未来の uploadedAt（許容 5 分超）は検証不能（負の間隔を正常扱いしない）', async () => {
    series(3, 30 * MIN);
    generation({ doneAt: base - 1 * MIN, uploadedAt: Date.now() + 30 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors[0].reason).toBe('uploadedAt が未来です（時計ずれの許容 5 分を超過）');
  }, 40_000);

  it('未来の dump mtime（許容 5 分超）は検証不能', async () => {
    const made = series(3, 30 * MIN);
    setMtime(at(made, 2).dump, Date.now() + 30 * MIN);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors[0].reason).toBe('dump の更新時刻が未来です（時計ずれの許容 5 分を超過）');
  }, 40_000);

  it('uploadedAt が dump 名の snapshot 時刻より前（世代と矛盾）は検証不能', async () => {
    series(3, 30 * MIN);
    generation({ doneAt: base - 2 * MIN, uploadedAt: base - 60 * MIN });
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors[0].reason).toContain('記録と世代が矛盾');
  }, 40_000);

  it('シンボリックリンクの送信記録は追跡せず検証不能（リンク先を出さない）', async () => {
    const made = series(3, 30 * MIN);
    const target = join(root, `outside-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(target, JSON.stringify({ bucket: BUCKET, uploadedAt: new Date(base).toISOString() }));
    rmSync(at(made, 2).record);
    symlinkSync(target, at(made, 2).record);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(2);
    expect(json.errors[0]).toEqual({
      file: `${at(made, 2).name}.dump.r2.json`,
      reason: '通常ファイルではありません（シンボリックリンク等は不可）',
    });
    expect(out).not.toContain(target);
    expectNoSecrets(out);
  }, 40_000);

  it('保存先が無い・通常ファイルなら検証不能（終了コード 2）', async () => {
    dir = join(root, 'no-such-dir');
    const missing = await run(['--days', '1']);
    expect(missing.code, missing.out).toBe(2);
    expect(missing.json.reasons).toContain('保存先がありません（または状態を取得できません）');

    dir = join(root, `file-${Math.random().toString(36).slice(2)}`);
    writeFileSync(dir, 'x');
    const file = await run(['--days', '1']);
    expect(file.code, file.out).toBe(2);
    expect(file.json.reasons[0]).toContain('ディレクトリではありません');
  }, 40_000);

  it('healthcheck の状態ファイルが壊れていても判定には影響せず、読めない旨だけ出す', async () => {
    series(3, 30 * MIN);
    writeFileSync(healthState, `{"lastFailureReason":"${FAILURE_REASON}", broken`);
    const { code, json, out } = await run(['--days', '1']);
    expect(code, out).toBe(0);
    expect(json.healthcheck.available).toBe(false);
    expectNoSecrets(out);
  }, 40_000);

  it('表形式でも同じ判定・終了コードで、中身は出さない', async () => {
    series(3, 59 * MIN + 59_000);
    const { code, out } = await run(['--days', '1'], false);
    expect(code, out).toBe(0);
    expect(out).toContain('# RPO 実測レポート（読取り専用。RPO の保証ではない）');
    expect(out).toContain('判定       : ok（終了コード 0）');
    expect(out).toContain('totalFailures=3');
    expectNoSecrets(out);
  }, 40_000);

  it('引数不正は終了コード 3（値は出さない）', async () => {
    const cases: string[][] = [
      ['--days', '0'],
      ['--since', 'yesterday-secret'],
      ['--since', '2026-11-03T09:00:00'], // タイムゾーン無し
      ['--since', '2026-11-03T09:00:00Z', '--days', '3'],
      ['--rpo-min', 'abc'],
      ['--unknown-secret'],
    ];
    for (const args of cases) {
      const { code, out } = await run(args, false);
      expect(code, `${args.join(' ')}\n${out}`).toBe(3);
      expect(out).not.toContain('yesterday-secret');
      expect(out).not.toContain('--unknown-secret');
    }
  }, 60_000);

  it('--until が実行時刻より未来ならデータ不足（判定しない）', async () => {
    series(3, 30 * MIN);
    base = Date.now() + 60 * MIN;
    const { code, json, out } = await run([]);
    expect(code, out).toBe(2);
    expect(json.reasons).toContain('--until が実行時刻より未来です');
  }, 40_000);
});
