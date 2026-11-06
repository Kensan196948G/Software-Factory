/**
 * 利用者棚卸しツール（scripts/ops/user-inventory.ts）の単体テスト。
 * 既定出力にメールアドレスを出さないこと、CSV が 0600 で書かれることを固定する。
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatSummary,
  parseArgs,
  parseUsersTsv,
  summarize,
  toCsv,
  type UserRow,
} from '../../scripts/ops/user-inventory.js';

const USERS: UserRow[] = [
  {
    email: 'admin@example.com',
    isAdmin: true,
    isActive: true,
    createdAt: '2026-10-28T12:28:00.000Z',
    roles: ['approver', 'desk', 'requester'],
  },
  {
    email: 'second@example.com',
    isAdmin: true,
    isActive: true,
    createdAt: '2026-10-28T12:51:00.000Z',
    roles: ['approver', 'desk', 'requester'],
  },
  {
    email: 'member@example.com',
    isAdmin: false,
    isActive: false,
    createdAt: '2026-11-06T09:00:00.000Z',
    roles: ['requester'],
  },
];

describe('summarize', () => {
  it('件数と役割・作成月を集計する', () => {
    const s = summarize(USERS);
    expect(s.total).toBe(3);
    expect(s.admins).toBe(2);
    expect(s.inactive).toBe(1);
    expect(s.byRole).toEqual({ approver: 2, desk: 2, requester: 3 });
    expect(s.byCreatedMonth).toEqual({ '2026-10': 2, '2026-11': 1 });
  });

  it('管理者かつ3役を持つ行（旧自動登録の典型）を数える', () => {
    expect(summarize(USERS).adminWithAllRoles).toBe(2);
  });

  it('空でも壊れない', () => {
    expect(summarize([])).toMatchObject({ total: 0, admins: 0, inactive: 0, adminWithAllRoles: 0 });
  });
});

describe('formatSummary', () => {
  it('メールアドレスを出さない', () => {
    const text = formatSummary('mirai_sf_prod', summarize(USERS));
    expect(text).toContain('db=mirai_sf_prod');
    expect(text).toContain('合計=3');
    expect(text).toContain('管理者=2');
    expect(text).not.toContain('@');
    expect(text).not.toContain('example.com');
  });
});

describe('toCsv', () => {
  it('ヘッダと行を出し、PII を含み得る値は引用する', () => {
    const csv = toCsv([{ ...USERS[0]!, email: 'a"b@example.com' }]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('email,is_admin,is_active,created_at,roles');
    expect(lines[1]).toContain('"a""b@example.com"');
    expect(lines[1]).toContain('approver;desk;requester');
  });
});

describe('parseUsersTsv', () => {
  it('psql の BEGIN/ROLLBACK 混じり出力からタブ区切りの行を取り出す', () => {
    const out = 'BEGIN\na@example.com\tt\tt\t2026-10-28 12:28:02+09\tapprover;desk;requester\nROLLBACK\n';
    const rows = parseUsersTsv(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'a@example.com',
      isAdmin: true,
      isActive: true,
      roles: ['approver', 'desk', 'requester'],
    });
  });

  it('無効・役割なしの行も読める', () => {
    const out = 'BEGIN\nb@example.com\tf\tf\t2026-11-06 09:00:00+09\t\nROLLBACK\n';
    const rows = parseUsersTsv(out);
    expect(rows[0]).toMatchObject({ email: 'b@example.com', isAdmin: false, isActive: false, roles: [] });
  });

  it('行が無ければ空配列（例外にしない）', () => {
    expect(parseUsersTsv('BEGIN\nROLLBACK\n')).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('--db は必須', () => {
    expect(() => parseArgs([])).toThrow(/--db/);
  });

  it('DB 名の形式を検証する', () => {
    expect(() => parseArgs(['--db', 'bad name; drop'])).toThrow(/形式/);
  });

  it('--out と --force を解釈する', () => {
    expect(parseArgs(['--db', 'mirai_sf_prod', '--out', '/tmp/x.csv', '--force'])).toEqual({
      db: 'mirai_sf_prod',
      out: '/tmp/x.csv',
      force: true,
    });
  });

  it('--help は help を返す', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('未知の引数は usage エラー', () => {
    expect(() => parseArgs(['--db', 'x', '--bogus'])).toThrow(/不明な引数/);
  });
});

describe('CLI（scripts/ops/user-inventory.ts）', () => {
  const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
  const script = join(process.cwd(), 'scripts/ops/user-inventory.ts');

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(tsx, [script, ...args], { encoding: 'utf8' });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('--help は exit 0', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('使い方');
  });

  it('--db が無ければ exit 2', () => {
    expect(run([]).status).toBe(2);
  });

  it('既存の --out は --force なしで exit 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inv-'));
    const target = join(dir, 'existing.csv');
    try {
      await readFile(join(dir, '.'), 'utf8').catch(() => undefined);
      execFileSync('/usr/bin/touch', [target]);
      const res = run(['--db', 'mirai_sf', '--out', target]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('既に存在します');
      // 既存ファイルを勝手に上書きしない（サイズ 0 のまま）
      expect((await stat(target)).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
