-- 0001_init.sql — みらいSF 受付ステーション MVP
-- 正本: 詳細仕様書 V1.0 5章（ENT-01〜ENT-11）
-- 破壊的変更は行わない。すべて additive。

create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

/* ───────── マスタ ───────── */

create table if not exists department (
  code text primary key,
  name text not null,
  short_name text not null,
  role_desc text not null,
  sort_order integer not null,
  created_at timestamptz not null default now()
);

create table if not exists catalog_tool (
  id text primary key,
  dept_code text not null references department(code) on delete restrict,
  name text not null,
  description text not null,
  signal char(1) not null check (signal in ('g','y','r')),
  seed_candidate boolean not null default false,
  version integer not null default 1,
  sort_order integer not null,
  created_at timestamptz not null default now()
);
create index if not exists catalog_tool_dept_idx on catalog_tool (dept_code, sort_order);

/* ───────── 利用者・セッション ───────── */

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  dept_code text not null references department(code) on delete restrict,
  password_hash text not null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_user_email_lower check (email = lower(email))
);

create table if not exists user_role (
  user_id uuid not null references app_user(id) on delete cascade,
  role text not null check (role in ('requester','desk','approver')),
  primary key (user_id, role)
);

create table if not exists session (
  id text primary key,
  user_id uuid not null references app_user(id) on delete cascade,
  acting_role text not null check (acting_role in ('requester','desk','approver')),
  csrf_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists session_user_idx on session (user_id);
create index if not exists session_expires_idx on session (expires_at);

/* ───────── 受付（ENT-01） ───────── */

create table if not exists request (
  id text primary key,
  seq integer not null unique,
  year integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applicant text not null,
  applicant_user_id uuid references app_user(id) on delete set null,
  dept_code text not null references department(code) on delete restrict,
  contact text,
  title text not null check (char_length(title) <= 60),
  kind text not null check (kind in ('new_tool','improve_tool','bug_report','consult')),
  tool_id text references catalog_tool(id) on delete set null,
  problem text not null check (char_length(problem) <= 2000),
  purpose text not null check (char_length(purpose) <= 2000),
  users text[] not null check (array_length(users, 1) >= 1),
  people integer check (people is null or people >= 0),
  places text[] not null default '{}',
  scope text[] not null check (array_length(scope, 1) >= 1),
  out_of_scope text[] not null default '{}',
  criteria text[] not null check (array_length(criteria, 1) >= 1 and array_length(criteria, 1) <= 8),
  decides char(1) not null check (decides in ('g','y','r')),
  data_handling text[] not null default '{}',
  parties text not null default 'internal' check (parties in ('internal','partner','client')),
  constraints text[] not null default '{}',
  constraints_other text[] not null default '{}',
  requires_human_approval text[] not null default '{}',
  frequency char(1) check (frequency is null or frequency in ('d','w','m','o')),
  minutes_per_time integer check (minutes_per_time is null or minutes_per_time >= 0),
  data_ready integer check (data_ready is null or data_ready in (1,3,5)),
  spread integer check (spread is null or spread in (1,3,5)),
  wish_date date,
  approver text not null,
  approver_user_id uuid references app_user(id) on delete set null,
  status text not null default 'received'
    check (status in ('received','review','wait','approved','dev','verify','field','release_wait','done','back','hold','cancel')),
  signal_decided char(1) check (signal_decided is null or signal_decided in ('g','y','r')),
  tailoring text check (tailoring is null or tailoring in ('T1','T2','T3')),
  order_version integer not null default 0,
  version integer not null default 1,
  deleted boolean not null default false,
  issue_no integer,
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null
);
create index if not exists request_status_idx on request (status, updated_at desc);
create index if not exists request_dept_idx on request (dept_code);
create index if not exists request_applicant_idx on request (applicant_user_id);
create index if not exists request_approver_idx on request (approver_user_id);
create index if not exists request_updated_idx on request (updated_at desc);

/* 年ごとの採番（トランザクション内で原子的に増やす） */
create table if not exists request_counter (
  year integer primary key,
  last_seq integer not null default 0
);

/* ───────── 履歴・コメント・承認・添付（ENT-02〜04, 07） ───────── */

create table if not exists request_history (
  id bigserial primary key,
  request_id text not null references request(id) on delete cascade,
  at timestamptz not null default now(),
  actor_name text not null,
  actor_user_id uuid references app_user(id) on delete set null,
  role text not null,
  action text not null,
  note text,
  before jsonb,
  after jsonb,
  correlation_id text
);
create index if not exists request_history_req_idx on request_history (request_id, at);

create table if not exists comment (
  id bigserial primary key,
  request_id text not null references request(id) on delete cascade,
  at timestamptz not null default now(),
  by_name text not null,
  by_user_id uuid references app_user(id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000)
);
create index if not exists comment_req_idx on comment (request_id, at);

create table if not exists approval (
  id uuid primary key default gen_random_uuid(),
  request_id text not null references request(id) on delete cascade,
  at timestamptz not null default now(),
  approver_name text not null,
  approver_user_id uuid references app_user(id) on delete set null,
  decision text not null check (decision in ('approved','returned','held')),
  reason text,
  decided_signal char(1) check (decided_signal is null or decided_signal in ('g','y','r')),
  suggested_signal char(1),
  checklist jsonb not null default '[]'::jsonb,
  order_version integer,
  subject_hash text
);
create index if not exists approval_req_idx on approval (request_id, at);

create table if not exists attachment (
  id uuid primary key default gen_random_uuid(),
  request_id text not null references request(id) on delete cascade,
  name text not null,
  size_bytes integer not null default 0,
  content_type text,
  sha256 text,
  storage_key text,
  created_at timestamptz not null default now()
);

/* ───────── 下書き（ENT 補助） ───────── */

create table if not exists draft (
  user_id uuid primary key references app_user(id) on delete cascade,
  payload jsonb not null,
  step integer not null default 0 check (step between 0 and 6),
  edit_id text,
  saved_at timestamptz not null default now()
);

/* ───────── 監査ログ（ENT-11・追記のみ・ハッシュ連鎖） ───────── */

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  actor_name text not null,
  role text not null,
  action text not null,
  target_type text not null,
  target_id text,
  result text not null check (result in ('success','denied','error')),
  diff jsonb,
  correlation_id text,
  prev_hash text,
  hash text not null
);
create index if not exists audit_log_at_idx on audit_log (at desc);
create index if not exists audit_log_target_idx on audit_log (target_type, target_id);

/* 監査ログは追記のみ（UPDATE/DELETE を拒否する） */
create or replace function audit_log_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only';
end;
$$ language plpgsql;

drop trigger if exists audit_log_no_update on audit_log;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_append_only();

/* ───────── 冪等キー（二重登録の防止） ───────── */

create table if not exists idempotency (
  key text primary key,
  scope text not null,
  request_id text,
  response jsonb,
  created_at timestamptz not null default now()
);
