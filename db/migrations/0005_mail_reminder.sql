-- 0005_mail_reminder.sql — 滞留通知メール（kind='reminder'）と1日1回の重複防止
--
-- 承認待ち・公開承認待ちのまま N 日動かない依頼を、日次で1回だけ催促する。
-- 同じ依頼・同じ日に何度ジョブを回しても、unique 制約で1通に落ちる。
--
-- additive のみ（既存行・既存制約の意味は変えない）。

alter table mail_outbox drop constraint if exists mail_outbox_kind_check;
alter table mail_outbox add constraint mail_outbox_kind_check
  check (kind in ('approval_request', 'reminder'));

alter table mail_outbox add column if not exists reminder_date date;

-- 承認依頼メール（reminder_date is null）は複数行を許す。
-- 滞留通知は「依頼 × 日付」で1通に固定する。
create unique index if not exists mail_outbox_reminder_once_idx
  on mail_outbox (request_id, kind, reminder_date)
  where kind = 'reminder';

comment on column mail_outbox.reminder_date is '滞留通知を積んだ日（JST）。同じ日に2通積まないためのキー';
