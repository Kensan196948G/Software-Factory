-- 0003_mail_outbox.sql — 承認依頼メールの送信BOX（outbox パターン）
--
-- 依頼が「承認待ち」になった時点で、同じトランザクションの中で1行積む。
-- 送信（ファイル書き出し or ローカルMTA）はコミット後に best-effort で行い、
-- 失敗しても業務の状態遷移は巻き戻さない（status='failed' で残し、再送できる）。
--
-- additive のみ。既存テーブルの変更なし。

create table if not exists mail_outbox (
  id bigserial primary key,
  request_id text references request(id) on delete cascade,
  kind text not null check (kind in ('approval_request')),
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- 同じ依頼の同じ種類のメールは、状態遷移のたびに1通ずつ積む。
-- 「まだ送っていないもの」を素早く引くための索引。
create index if not exists mail_outbox_pending_idx on mail_outbox (status, created_at);
create index if not exists mail_outbox_request_idx on mail_outbox (request_id, created_at desc);

comment on table mail_outbox is '承認依頼メールの送信キュー（送信は失敗しても業務は止めない）';
