import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
/** 偽 /healthz が返す本文。テストの途中で差し替えて認証状態を変える。 */
let healthBody: Record<string, unknown> = {};

function healthyBody() {
  return {
    status: 'ok',
    environment: 'production',
    commit: COMMIT,
    db: { ok: true },
    auth: {
      mode: 'access',
      jwtConfigured: true,
      headerTrustEnabled: false,
      allowlistConfigured: true,
      status: 'ready',
    },
  };
}

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

// 新チェックの NG 文言に保存先のフルパスを出さない（既存の dump 鮮度チェックの行は対象外）
function expectNoBackupDirInOffsiteLines(out: string) {
  const offsiteLines = out.split('\n').filter((line) => line.includes('オフサイト'));
  expect(offsiteLines.length).toBeGreaterThan(0);
  for (const line of offsiteLines) expect(line).not.toContain(backupDir);
}

function writeRaw(name: string, body: string, mtimeAgeMinutes: number) {
  const path = join(backupDir, name);
  writeFileSync(path, body, { mode: 0o600 });
  const at = new Date(Date.now() - mtimeAgeMinutes * 60_000);
  utimesSync(path, at, at);
  return path;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mirai-sf-healthcheck-offsite-'));
  mkdirSync(join(root, 'home', 'current'), { recursive: true });
  writeFileSync(join(root, 'home', 'current', 'release.env'), `COMMIT_SHA=${COMMIT}\n`);
  healthBody = healthyBody();
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(healthBody));
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
  healthBody = healthyBody();
  backupDir = join(root, `backups-${Math.random().toString(36).slice(2)}`);
  mkdirSync(backupDir, { recursive: true });
  // 最新 dump は既定の世代猶予（10 分）以内に置く。各テストが必要に応じて上書きする
  writeDump('mirai_sf_prod-new.dump', 5);
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
    // 最新 dump に対応する記録があるので、世代相関の情報行も出る
    expect(out).toContain('最新世代のオフサイト送信記録: mirai_sf_prod-new.dump.r2.json');
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

  it('uploadedAt キーが無い（正常に parse できた）記録だけ mtime で判断する', async () => {
    writeRecord('mirai_sf_prod-new.dump', null, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(0);
    expect(out).toContain('mtime 基準');
  }, 40_000);

  it('無し: 送信記録（*.dump.r2.json）が 1 件も無ければ NG（保存先のパスは出さない）', async () => {
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('オフサイト送信記録（*.dump.r2.json）がありません（MIRAI_SF_HEALTH_BACKUP_DIR）');
    expect(out).toContain('healthcheck NG');
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('未来の uploadedAt（許容 5 分超）は負の経過分を正常扱いせず NG', async () => {
    writeRecord('mirai_sf_prod-new.dump', -30, 1);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('最新のオフサイト送信記録を検証できません（uploadedAt が未来です（時計ずれの許容 5 分を超過））');
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
  }, 40_000);

  it('許容幅内の未来の uploadedAt（時計ずれ 2 分）は 0 分として OK', async () => {
    writeRecord('mirai_sf_prod-new.dump', -2, 1);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(0);
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-new.dump.r2.json（0 分前、uploadedAt 基準）');
  }, 40_000);

  it('未来の mtime（許容 5 分超）は uploadedAt が無くても NG', async () => {
    writeRecord('mirai_sf_prod-new.dump', null, -30);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('最新のオフサイト送信記録を検証できません（更新時刻が未来です（時計ずれの許容 5 分を超過））');
    expect(out).toContain('healthcheck NG');
  }, 40_000);

  it('破損 JSON の最新記録は mtime へ逃げず NG（古い正常な記録があっても）', async () => {
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    writeRaw('mirai_sf_prod-new.dump.r2.json', `{"bucket":"${BUCKET}", broken`, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain(
      '最新のオフサイト送信記録を検証できません（JSON として解釈できません）: mirai_sf_prod-new.dump.r2.json',
    );
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
  }, 40_000);

  it('uploadedAt が時刻として解釈できない記録は NG', async () => {
    writeRaw('mirai_sf_prod-new.dump.r2.json', JSON.stringify({ bucket: BUCKET, uploadedAt: 'not-a-date' }), 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('uploadedAt を時刻として解釈できません');
    expectNoRecordContents(out);
  }, 40_000);

  it('サイズ上限（64KiB）超過の記録は NG', async () => {
    writeRaw('mirai_sf_prod-new.dump.r2.json', `{"pad":"${'x'.repeat(70 * 1024)}"}`, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('サイズが想定外です');
  }, 40_000);

  it('シンボリックリンクの記録は追跡せず NG（リンク先が新しく正常でも）', async () => {
    const target = join(root, `outside-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(target, JSON.stringify({ bucket: BUCKET, uploadedAt: new Date().toISOString() }));
    symlinkSync(target, join(backupDir, 'mirai_sf_prod-new.dump.r2.json'));
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain(
      'オフサイト送信記録が通常ファイルではありません（シンボリックリンク等は不可）: mirai_sf_prod-new.dump.r2.json',
    );
    expect(out).toContain('healthcheck NG');
    expect(out).not.toContain(target);
    expectNoRecordContents(out);
  }, 40_000);

  it('境界: 閾値 90 分 + 1 秒は（分に丸めると 90 分でも）NG', async () => {
    writeRecord('mirai_sf_prod-new.dump', 90 + 1 / 60, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toMatch(/最新のオフサイト送信記録が古すぎます（90 分 \d+ 秒前 > 90 分、uploadedAt 基準）/);
    expect(out).toContain('healthcheck NG');
  }, 40_000);

  it('境界: 閾値 90 分 - 30 秒は OK', async () => {
    writeRecord('mirai_sf_prod-new.dump', 89.5, 5);
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(0);
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('BACKUP_DIR が通常ファイルでも例外で落ちず、既存の dump 鮮度確認も含め固定文言の NG（パス・stack を出さない）', async () => {
    const file = join(root, `backups-as-file-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, 'not a directory');
    backupDir = file;
    for (const offsite of [undefined, '90']) {
      const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: offsite });
      expect(code, out).toBe(1);
      expect(out).toContain(
        'NG: バックアップの保存先を読めません（MIRAI_SF_HEALTH_BACKUP_DIR。ディレクトリでない・権限不足など）',
      );
      expect(out).toContain('healthcheck NG');
      expect(out).not.toContain(file);
      expect(out).not.toContain('ENOTDIR');
      expect(out).not.toMatch(/\n\s+at /);
      if (offsite) expect(out).toContain('オフサイト送信記録の保存先がディレクトリではありません（MIRAI_SF_HEALTH_BACKUP_DIR）');
    }
  }, 40_000);

  it('BACKUP_DIR が無ければ NG（オフサイトの行に保存先のパスを出さない）', async () => {
    const missing = join(root, 'no-such-backups');
    backupDir = missing;
    const { code, out } = await run({ MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' });
    expect(code, out).toBe(1);
    expect(out).toContain('オフサイト送信記録の保存先がありません（MIRAI_SF_HEALTH_BACKUP_DIR）');
    expect(out).toContain('healthcheck NG');
    expectNoBackupDirInOffsiteLines(out);
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

describe('healthcheck.mjs のオフサイト送信記録の世代相関（最新 dump との対応）', () => {
  const offSiteEnv = { MIRAI_SF_HEALTH_OFFSITE_MAX_AGE_MIN: '90' };

  it('猶予内: 最新 dump に対応する記録がまだ無くても、dump の経過が既定の猶予（10 分）以内なら OK', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(0);
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-old.dump.r2.json');
    expect(out).toContain('最新世代のオフサイト送信記録: まだありません（dump の経過 5 分 ≤ 猶予 10 分）');
    expect(out).toContain('healthcheck OK');
    expectNoRecordContents(out);
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('NG: 最新 dump に対応する記録が無く、dump の経過が猶予を超えていれば、1つ前の記録が閾値内でも NG', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    writeDump('mirai_sf_prod-new.dump', 60);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    // 従来の記録鮮度チェックは通っている（旧世代の記録が 90 分以内）
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-old.dump.r2.json');
    expect(out).toMatch(
      /最新世代のオフサイト送信記録がありません（dump の経過 \d+ 分 \d+ 秒前 > 猶予 10 分）: mirai_sf_prod-new\.dump/,
    );
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('NG: 古い記録しか無い状態で最新 dump の記録が欠落していれば、旧記録が 90 分以内でも検知する', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 80, 80);
    writeDump('mirai_sf_prod-new.dump', 45);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-old.dump.r2.json（80 分前');
    expect(out).toMatch(/最新世代のオフサイト送信記録がありません（dump の経過 \d+ 分 \d+ 秒前 > 猶予 10 分）/);
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('猶予は環境変数 MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN で変更できる（30 分なら dump 20 分は猶予内）', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    writeDump('mirai_sf_prod-new.dump', 20);
    const { code, out } = await run({
      ...offSiteEnv,
      MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN: '30',
    });
    expect(code, out).toBe(0);
    expect(out).toContain('≤ 猶予 30 分');
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('不正な猶予は設定ミスとして NG（値は出さない）', async () => {
    writeRecord('mirai_sf_prod-new.dump', 5, 5);
    const { code, out } = await run({
      ...offSiteEnv,
      MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN: 'ten-minutes-secret',
    });
    expect(code, out).toBe(1);
    expect(out).toContain('MIRAI_SF_HEALTH_OFFSITE_GENERATION_GRACE_MIN が正の整数（分）ではありません');
    expect(out).not.toContain('ten-minutes-secret');
    expect(out).toContain('healthcheck NG');
  }, 40_000);

  it('NG: ローカルの dump が 1 件も無ければ世代対応を判定できない（旧世代の記録だけが残っていても）', async () => {
    rmSync(join(backupDir, 'mirai_sf_prod-new.dump'), { force: true });
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    expect(out).toContain('最新のローカル dump（*.dump）を特定できません（オフサイト送信記録との世代対応を確認できません）');
    expect(out).toContain('healthcheck NG');
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('dot 始まりの dump（一時ファイル）は最新世代として扱わない', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    writeRecord('mirai_sf_prod-new.dump', 5, 5);
    // dot 始まりを世代として数えてしまうと、この dump（猶予超過・記録なし）で NG になる
    writeDump('.mirai_sf_prod-tmp.dump', 30);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(0);
    expect(out).toContain('最新世代のオフサイト送信記録: mirai_sf_prod-new.dump.r2.json');
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('NG: *.dump が通常ファイルでない（シンボリックリンク）ならリンク先を追わず NG', async () => {
    const target = join(root, `outside-dump-${Math.random().toString(36).slice(2)}.dump`);
    writeFileSync(target, 'outside dump');
    symlinkSync(target, join(backupDir, 'mirai_sf_prod-link.dump'));
    writeRecord('mirai_sf_prod-new.dump', 5, 5);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    expect(out).toContain('ローカル dump が通常ファイルではありません（シンボリックリンク等は不可）: mirai_sf_prod-link.dump');
    expect(out).toContain('healthcheck NG');
    expect(out).not.toContain(target);
    expectNoRecordContents(out);
  }, 40_000);

  it('NG: 対応する記録が壊れていれば、記録層の「最新記録」が正常でも NG（fail-closed）', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    // 対応する記録の mtime を旧記録より古くして、記録層の「最新記録」には選ばれないようにする
    writeRaw('mirai_sf_prod-new.dump.r2.json', `{"bucket":"${BUCKET}", broken`, 40);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    expect(out).toContain('最新オフサイト送信記録: mirai_sf_prod-old.dump.r2.json');
    expect(out).toContain(
      '最新世代のオフサイト送信記録を検証できません（JSON として解釈できません）: mirai_sf_prod-new.dump.r2.json',
    );
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
    expectNoBackupDirInOffsiteLines(out);
  }, 40_000);

  it('NG: 対応する記録の uploadedAt が未来なら、記録層が旧記録で通っていても NG', async () => {
    writeDump('mirai_sf_prod-old.dump', 200);
    writeRecord('mirai_sf_prod-old.dump', 30, 30);
    // mtime を旧記録より古くしつつ uploadedAt だけ未来にする
    writeRecord('mirai_sf_prod-new.dump', -30, 40);
    const { code, out } = await run(offSiteEnv);
    expect(code, out).toBe(1);
    expect(out).toContain(
      '最新世代のオフサイト送信記録を検証できません（uploadedAt が未来です（時計ずれの許容 5 分を超過））: mirai_sf_prod-new.dump.r2.json',
    );
    expect(out).toContain('healthcheck NG');
    expectNoRecordContents(out);
  }, 40_000);
});

describe('healthcheck.mjs の認証状態（auth.status）', () => {
  it('auth.status=ready なら OK（ログにも認証状態を出す）', async () => {
    const { code, out } = await run({});
    expect(code, out).toBe(0);
    expect(out).toContain('auth.status=ready（mode=access）');
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('HTTP 200 / status=ok でも auth.status=misconfigured なら NG（認証不能）', async () => {
    healthBody.auth = {
      mode: 'access',
      jwtConfigured: false,
      headerTrustEnabled: false,
      allowlistConfigured: false,
      status: 'misconfigured',
    };
    const { code, out } = await run({});
    expect(code, out).toBe(1);
    expect(out).toContain('auth.status=misconfigured（認証不能。');
    expect(out).toContain('jwtConfigured=false');
    expect(out).toContain('headerTrustEnabled=false');
    expect(out).toContain('allowlistConfigured=false');
    expect(out).toContain('healthcheck NG');
    // 既存の確認（HTTP 200 / status=ok / db.ok）は通っているのに失敗していること
    expect(out).not.toContain('status=(想定外の値)');
  }, 40_000);

  it('auth が無い（旧版 API など）は警告のみ（版ずれの過渡期を許容し、失敗にはしない）', async () => {
    delete healthBody.auth;
    const { code, out } = await run({});
    expect(code, out).toBe(0);
    expect(out).toContain('警告: auth が healthz にありません');
    expect(out).toContain('healthcheck OK');
  }, 40_000);

  it('未知の auth.status は NG（ready 以外を通さない）', async () => {
    healthBody.auth = {
      mode: 'access',
      jwtConfigured: true,
      headerTrustEnabled: false,
      allowlistConfigured: true,
      status: 'unknown',
    };
    const { code, out } = await run({});
    expect(code, out).toBe(1);
    expect(out).toContain('auth.status=unknown（ready を期待）');
  }, 40_000);

  it('auth の中の余分な値（team domain・AUD・メール等）はログに出さない', async () => {
    healthBody.auth = {
      mode: 'access',
      jwtConfigured: false,
      headerTrustEnabled: false,
      allowlistConfigured: false,
      status: 'misconfigured',
      teamDomain: 'leak-team-should-not-appear',
      aud: 'leak-aud-should-not-appear',
      email: 'leak-email-should-not-appear@example.com',
    };
    const { code, out } = await run({});
    expect(code, out).toBe(1);
    expect(out).not.toContain('leak-team-should-not-appear');
    expect(out).not.toContain('leak-aud-should-not-appear');
    expect(out).not.toContain('leak-email-should-not-appear');
  }, 40_000);
});
