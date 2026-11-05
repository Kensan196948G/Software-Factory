import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareOutDir } from '../../scripts/ops/offsite-recover.mjs';

// scripts/ops/offsite-recover.mjs の実行部を、偽の wrangler と一時ディレクトリだけで試す。
// ネットワーク・R2・DB には触らない（list はトークンの検査で止まり、guess は偽の wrangler を呼ぶ）。

const SCRIPT = resolve('scripts/ops/offsite-recover.mjs');
const TOKEN = 'SECRETTOKEN0123456789abcdefSHOULDNOTAPPEAR';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

let root = '';
let fakeWrangler = '';
let pidFile = '';

type RunResult = { code: number | null; signal: NodeJS.Signals | null; out: string };

function runCli(args: string[], env: Record<string, string>, onStart?: (pid: number) => void): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: join(root, 'tmp'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    if (onStart && child.pid) onStart(child.pid);
    child.on('close', (code, signal) => done({ code, signal, out }));
  });
}

async function waitFor(predicate: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'offsite-recover-cli-'));
  mkdirSync(join(root, 'tmp'));
  pidFile = join(root, 'pids');
  // 偽の wrangler: bucket info は成功。object get は孫プロセス（sleep）を起こして待つ。SIGTERM/SIGINT は無視する
  // （親が 2 回目のシグナルで SIGKILL へ格上げすることを確かめるため）。孫の PID を記録する。
  fakeWrangler = join(root, 'wrangler');
  writeFileSync(
    fakeWrangler,
    `#!/usr/bin/env bash
if [[ "$1 $2" == "r2 bucket" ]]; then echo '{}'; exit 0; fi
trap '' TERM INT
sleep 300 &
echo "$$ $!" >> "${pidFile}"
wait
`,
  );
  chmodSync(fakeWrangler, 0o755);
});

afterAll(() => {
  if (existsSync(pidFile)) {
    for (const pid of readFileSync(pidFile, 'utf8').split(/\s+/).filter(Boolean).map(Number)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('list: トークンの検査（改行入りのトークンを送らず、出力にも出さない）', () => {
  for (const [label, token] of [
    ['改行', `${TOKEN}\n`],
    ['CRLF とヘッダ', `${TOKEN}\r\nX-Evil: 1`],
    ['空白', `${TOKEN} x`],
  ] as const) {
    it(label, async () => {
      const r = await runCli(['--verify-only'], { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, MIRAI_SF_R2_READ_TOKEN: token });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/MIRAI_SF_R2_READ_TOKEN の形が不正です/);
      expect(r.out).not.toContain(TOKEN);
      expect(r.out).not.toContain('Bearer');
      expect(r.out).not.toContain(ACCOUNT);
    });
  }
  it('prefix の .. は API を呼ぶ前に拒否', async () => {
    const r = await runCli(['--verify-only'], {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      MIRAI_SF_R2_READ_TOKEN: TOKEN,
      MIRAI_SF_R2_PREFIX: 'a/../b',
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PREFIX が不正/);
    expect(r.out).not.toContain(TOKEN);
  });
});

describe('guess: 中断（子のプロセスグループへ転送、2 回目で SIGKILL、一時領域を消す）', () => {
  it('SIGINT 2 回で、シグナルを無視する子と孫まで止まり、130 で終わる', async () => {
    const args = [
      '--source',
      'guess',
      '--verify-only',
      '--max-age-hours',
      '0',
      '--from',
      '2026-11-05T07:00:00Z',
      '--to',
      '2026-11-05T07:00:05Z',
    ];
    let cli = 0;
    const result = runCli(args, { MIRAI_SF_WRANGLER: fakeWrangler }, (pid) => (cli = pid));
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const [child, grandchild] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    expect(alive(child as number)).toBe(true);
    expect(alive(grandchild as number)).toBe(true);
    // 一時領域が作られていること（後で消えたことを確かめる前提）
    expect(readdirSync(join(root, 'tmp')).filter((n) => n.startsWith('mirai-sf-offsite-recover-'))).toHaveLength(1);
    process.kill(cli, 'SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    // 子は TERM/INT を無視するので、1 回目では残る
    expect(alive(child as number)).toBe(true);
    process.kill(cli, 'SIGINT');
    const r = await result;
    expect(r.code).toBe(130);
    expect(r.out).toMatch(/中断されました（SIGINT）/);
    await waitFor(() => !alive(child as number) && !alive(grandchild as number));
    expect(readdirSync(join(root, 'tmp')).filter((n) => n.startsWith('mirai-sf-offsite-recover-'))).toEqual([]);
  }, 30_000);
});

describe('--out の置き場所', () => {
  it('無ければ 0700 で新規作成する', () => {
    const dir = join(root, 'out-new');
    expect(prepareOutDir(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it('既存のディレクトリは権限を変えずに使う', () => {
    const dir = join(root, 'out-existing');
    mkdirSync(dir, { mode: 0o750 });
    chmodSync(dir, 0o750);
    prepareOutDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o750);
  });
  it('シンボリックリンク・ディレクトリ以外・親が無い場所は拒否する', () => {
    const target = join(root, 'out-target');
    mkdirSync(target);
    const link = join(root, 'out-link');
    symlinkSync(target, link);
    expect(() => prepareOutDir(link)).toThrow(/シンボリックリンク/);
    const file = join(root, 'out-file');
    writeFileSync(file, 'x');
    expect(() => prepareOutDir(file)).toThrow(/ディレクトリではありません/);
    expect(() => prepareOutDir(join(root, 'no-parent', 'child'))).toThrow(/作れません/);
  });
});
