-- 0006_drafts_multi.sql — 下書きを複数件にする（利用者 × 複数）
--
-- 既存の `draft`（利用者ごとに1件）はそのまま残し、新しい `draft_item` へ引き継ぐ。
-- additive のみ（既存テーブルは変更も削除もしない）。

create table if not exists draft_item (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  payload jsonb not null,
  step integer not null default 0 check (step >= 0 and step <= 6),
  edit_id text,
  label text not null default '' check (char_length(label) <= 60),
  saved_at timestamptz not null default now()
);

create index if not exists draft_item_user_idx on draft_item (user_id, saved_at desc);

comment on table draft_item is '下書き（利用者ごとに複数件。端末をまたいで再開できる）';

-- 旧 draft（1件）を draft_item へ移す（すでに同じ保存時刻の行があれば重複しない）
insert into draft_item (user_id, payload, step, edit_id, saved_at)
select d.user_id, d.payload, d.step, d.edit_id, d.saved_at
  from draft d
 where not exists (
   select 1 from draft_item i where i.user_id = d.user_id and i.saved_at = d.saved_at
 );
