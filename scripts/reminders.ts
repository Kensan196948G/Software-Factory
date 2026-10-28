/**
 * 日次の滞留通知（催促メール）。
 *
 * 例: systemd timer / cron から1日1回呼ぶ。
 *   REMINDER_DAYS=3 pnpm reminders
 *
 * 同じ依頼・同じ日は unique 制約で1通に落ちる（何度呼んでも増えない）。
 * あわせて、保存期限を過ぎた下書き（DRAFT_TTL_DAYS、既定30日）を消す。
 */
import { closePool } from '../src/api/db.js';
import { deliverPendingMail, enqueueStallReminders } from '../src/api/mail-outbox.js';
import { config } from '../src/api/config.js';
import { purgeExpiredDrafts } from '../src/api/service.js';

const days = Number(process.env.REMINDER_DAYS ?? process.argv[2] ?? 3);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error(`REMINDER_DAYS が不正です: ${String(process.env.REMINDER_DAYS ?? process.argv[2])}`);
  process.exit(2);
}

if (config.mailMode === 'off') {
  console.log(JSON.stringify({ days, mode: 'off', queued: 0, note: 'MAIL_MODE=off のため送信しません' }));
  await closePool();
  process.exit(0);
}

try {
  const queued = await enqueueStallReminders({ days });
  const delivery = await deliverPendingMail(50);
  const drafts = await purgeExpiredDrafts();
  console.log(JSON.stringify({ mode: config.mailMode, ...queued, delivery, draftsPurged: drafts.deleted }));
  if (delivery.failed > 0) process.exit(1);
} finally {
  await closePool();
}
