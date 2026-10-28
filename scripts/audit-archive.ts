/**
 * 監査ログのアーカイブ（日次バックアップ・世代管理）。
 *
 *   pnpm audit:archive
 *
 * - audit_log は追記のみ（DBからは消さない）。ここでは JSONL.gz として外へ出す。
 * - 前回までに出した最大 id を記録し、差分だけを追記する。
 * - アーカイブは世代（AUDIT_RETENTION_DAYS、既定365日）を過ぎたら消す。
 * - 実行の前後でハッシュ連鎖を検証し、壊れていれば終了コード2で止まる。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { homedir } from 'node:os';
import { many, closePool } from '../src/api/db.js';
import { verifyAuditChain } from '../src/api/audit.js';

const dir = process.env.AUDIT_ARCHIVE_DIR ?? join(homedir(), '.local', 'state', 'mirai-sf', 'audit');
const retentionDays = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
const statePath = join(dir, 'state.json');
mkdirSync(dir, { recursive: true });

const before = await verifyAuditChain();
if (!before.ok) {
  console.error(JSON.stringify({ ok: false, stage: 'before', chain: before }));
  await closePool();
  process.exit(2);
}

const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { lastId?: number }) : {};
const lastId = Number(state.lastId ?? 0);
const rows = await many<{ id: number; at: Date; hash: string }>(
  'select id, at, hash from audit_log where id > $1 order by id',
  [lastId],
);

if (rows.length) {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `audit-${day}.jsonl.gz`);
  const out = createWriteStream(file, { flags: 'a', mode: 0o600 });
  const gzip = createGzip();
  gzip.pipe(out);
  for (const row of rows) {
    const full = await many<Record<string, unknown>>('select * from audit_log where id = $1', [row.id]);
    gzip.write(JSON.stringify(full[0]) + '\n');
  }
  gzip.end();
  await new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
  });
  writeFileSync(statePath, JSON.stringify({ lastId: rows[rows.length - 1]!.id, at: new Date().toISOString() }), { mode: 0o600 });
}

// 世代管理（アーカイブのファイルだけ。DBの行は消さない）
let removed = 0;
const cutoff = Date.now() - retentionDays * 86400_000;
for (const name of readdirSync(dir)) {
  if (!/^audit-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name)) continue;
  const path = join(dir, name);
  if (statSync(path).mtimeMs < cutoff) {
    unlinkSync(path);
    removed += 1;
  }
}

const after = await verifyAuditChain();
await closePool();
console.log(
  JSON.stringify({
    ok: before.ok && after.ok,
    archived: rows.length,
    lastId: rows.length ? rows[rows.length - 1]!.id : lastId,
    dir,
    removedOldArchives: removed,
    retentionDays,
    checked: after.checked,
  }),
);
if (!after.ok) process.exit(2);
