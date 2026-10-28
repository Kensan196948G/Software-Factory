-- 0007_mail_retry.sql — 送信失敗の自動リトライ（指数バックオフ）
--
-- 失敗した行に次回試行時刻を入れ、日次ジョブ（pnpm reminders）や flush が
-- 期日を過ぎたものだけを拾って再送する。常駐ワーカーは置かない。
--
-- additive のみ。

alter table mail_outbox add column if not exists next_attempt_at timestamptz;

create index if not exists mail_outbox_retry_idx
  on mail_outbox (status, next_attempt_at)
  where status = 'failed';

comment on column mail_outbox.next_attempt_at is '次に再送してよい時刻（失敗時のみ）。daemon ではなく日次/手動の flush が拾う';
