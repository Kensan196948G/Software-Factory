-- 0002_ops_state.sql — 運用/DevOps/SecOps の状態（コンソールの S.data.ops）
-- 画面の見本データを実データ（JSONB）として保存する。additive のみ。

create table if not exists ops_state (
  id integer primary key,
  data jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  constraint ops_state_singleton check (id = 1)
);

comment on table ops_state is '運用・DevOps・SecOps の画面状態（id=1 の単一ドキュメント）';
