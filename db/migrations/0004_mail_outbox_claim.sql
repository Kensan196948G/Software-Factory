-- 0004_mail_outbox_claim.sql — 送信の「確保（claim）」と整合制約
--
-- 二重送信を防ぐため、送信前に status='sending' へ原子的に移す。
-- 送信中のまま落ちた行（claimed_at が古い）は flush が拾い直せる。
--
-- additive のみ（既存行の意味は変えない）。

alter table mail_outbox drop constraint if exists mail_outbox_status_check;
alter table mail_outbox add constraint mail_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'failed'));

alter table mail_outbox add column if not exists claimed_at timestamptz;

-- 送信済みなら sent_at が必ず入っている（逆は運用上あり得るので縛らない）
alter table mail_outbox drop constraint if exists mail_outbox_sent_at_check;
alter table mail_outbox add constraint mail_outbox_sent_at_check
  check (status <> 'sent' or sent_at is not null);

comment on column mail_outbox.claimed_at is '送信を確保した時刻（sending のとき）。古い行は flush が再取得する';
