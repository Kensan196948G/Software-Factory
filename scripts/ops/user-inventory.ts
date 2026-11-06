#!/usr/bin/env node
/**
 * 利用者と役割の棚卸し（読み取り専用）。
 *
 * 目的: Issue #102 の完了条件 3「未登録利用者の staging 管理者自動登録を最小権限へ」の残作業として、
 * 旧実装（is_admin=true・3 役で自動作成）が作った既存の行を所有者が確認・是正できるようにする。
 *
 *   tsx scripts/ops/user-inventory.ts --db <DB名> [--out <CSVのパス>] [--force]
 *
 * 設計（PII を AI・ログへ出さない）:
 * - 既定の出力は**件数だけ**（総数・管理者数・無効数・役割別・作成月別）。メールアドレスは出さない。
 * - `--out` を指定したときだけ、レビュー用の CSV（0600）を書く。標準出力には**パスと件数だけ**を出す。
 * - 既存ファイルは `--force` がない限り上書きしない。
 * - DB は READ ONLY トランザクションで読む。書込み・変更は一切しない。
 *
 * 終了コード: 0=成功 / 2=引数不正・出力先の衝突 / 1=想定外の失敗
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const USAGE =
  '使い方: tsx scripts/ops/user-inventory.ts --db <DB名> [--out <CSVのパス>] [--force]';

export class InventoryUsageError extends Error {}

export interface UserRow {
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  roles: string[];
}

export interface InventorySummary {
  total: number;
  admins: number;
  inactive: number;
  byRole: Record<string, number>;
  byCreatedMonth: Record<string, number>;
  /** 管理者かつ 3 役すべてを持つ行（旧 auto-provision の典型）。 */
  adminWithAllRoles: number;
}

/** 行から件数サマリを作る（純関数。テスト対象）。 */
export function summarize(users: UserRow[]): InventorySummary {
  const byRole: Record<string, number> = {};
  const byCreatedMonth: Record<string, number> = {};
  let admins = 0;
  let inactive = 0;
  let adminWithAllRoles = 0;
  for (const u of users) {
    if (u.isAdmin) admins += 1;
    if (!u.isActive) inactive += 1;
    for (const role of u.roles) byRole[role] = (byRole[role] ?? 0) + 1;
    const month = u.createdAt.slice(0, 7);
    byCreatedMonth[month] = (byCreatedMonth[month] ?? 0) + 1;
    if (u.isAdmin && ['requester', 'desk', 'approver'].every((r) => u.roles.includes(r))) {
      adminWithAllRoles += 1;
    }
  }
  return {
    total: users.length,
    admins,
    inactive,
    byRole: Object.fromEntries(Object.entries(byRole).sort(([a], [b]) => a.localeCompare(b))),
    byCreatedMonth: Object.fromEntries(Object.entries(byCreatedMonth).sort(([a], [b]) => a.localeCompare(b))),
    adminWithAllRoles,
  };
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** レビュー用 CSV（ヘッダ + 行）。PII を含むため、書出し先は 0600 にする。 */
export function toCsv(users: UserRow[]): string {
  const header = 'email,is_admin,is_active,created_at,roles';
  const lines = users.map((u) =>
    [u.email, String(u.isAdmin), String(u.isActive), u.createdAt, u.roles.join(';')].map(csvCell).join(','),
  );
  return `${[header, ...lines].join('\n')}\n`;
}

export function formatSummary(db: string, summary: InventorySummary): string {
  const roles = Object.entries(summary.byRole)
    .map(([r, n]) => `${r}=${n}`)
    .join(' ');
  const months = Object.entries(summary.byCreatedMonth)
    .map(([m, n]) => `${m}=${n}`)
    .join(' ');
  return [
    `利用者棚卸し: db=${db}`,
    `合計=${summary.total} 管理者=${summary.admins} 無効=${summary.inactive} 管理者かつ3役=${summary.adminWithAllRoles}`,
    `役割別: ${roles || 'なし'}`,
    `作成月別: ${months || 'なし'}`,
    'メールアドレスは表示していません（--out で 0600 の CSV に書き出せます）',
  ].join('\n');
}

/** DB から利用者と役割を読む（READ ONLY）。 */
export function loadUsers(db: string): UserRow[] {
  // 1 行 1 利用者の TSV（JSON は psql の行折り返しで壊れることがあるため使わない）。
  const sql = [
    'begin read only;',
    'select u.email, u.is_admin, u.is_active, u.created_at,',
    "  coalesce((select string_agg(r.role, ';' order by r.role) from user_role r where r.user_id = u.id), '')",
    'from app_user u',
    'order by u.created_at;',
    'rollback;',
  ].join('\n');
  const out = execFileSync(
    'psql',
    ['-d', db, '-h', '/var/run/postgresql', '-tA', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return parseUsersTsv(out);
}

/** psql -tA -F '\t' の出力（BEGIN / 行 / ROLLBACK）から利用者行を取り出す（純関数。テスト対象）。 */
export function parseUsersTsv(out: string): UserRow[] {
  const rows: UserRow[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('\t')) continue; // BEGIN / ROLLBACK / 空行はタブを含まない
    const [email, isAdmin, isActive, createdAt, roles] = line.split('\t');
    if (!email || createdAt === undefined) continue;
    rows.push({
      email,
      isAdmin: isAdmin === 't',
      isActive: isActive === 't',
      createdAt,
      roles: (roles ?? '').split(';').filter((r) => r.length > 0),
    });
  }
  return rows;
}

interface Args {
  db: string;
  out: string | null;
  force: boolean;
}

export function parseArgs(argv: string[]): Args | { help: true } {
  let db = '';
  let out: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--force') {
      force = true;
    } else if (arg === '--db') {
      const v = argv[i + 1];
      if (!v) throw new InventoryUsageError('--db に値がありません');
      db = v;
      i += 1;
    } else if (arg === '--out') {
      const v = argv[i + 1];
      if (!v) throw new InventoryUsageError('--out に値がありません');
      out = v;
      i += 1;
    } else {
      throw new InventoryUsageError(`不明な引数です: ${arg}`);
    }
  }
  if (!db) throw new InventoryUsageError('--db は必須です（例: --db mirai_sf_prod）');
  if (!/^[A-Za-z0-9_]{1,63}$/.test(db)) throw new InventoryUsageError('--db の形式が不正です');
  return { db, out, force };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if ('help' in parsed) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (parsed.out) {
      const target = resolve(parsed.out);
      if (existsSync(target) && !parsed.force) {
        throw new InventoryUsageError(`出力先が既に存在します（--force で上書き）: ${target}`);
      }
    }
    const users = loadUsers(parsed.db);
    const summary = summarize(users);
    if (parsed.out) {
      const target = resolve(parsed.out);
      writeFileSync(target, toCsv(users), { mode: 0o600 });
      process.stdout.write(`CSV を書き出しました（0600）: ${target}\n`);
    }
    process.stdout.write(`${formatSummary(parsed.db, summary)}\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof InventoryUsageError) {
      process.stderr.write(`${err.message}\n${USAGE}\n`);
      process.exit(2);
    }
    process.stderr.write(`想定外の失敗: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
