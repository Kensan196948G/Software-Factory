-- 0012_devline_release.sql — 人の承認 → 製品 PR の merge → 検証環境への配備 → 復旧の記録（ENT-10・仕様 4-9）
--
-- additive。表と列の追加だけで、既存の行は変わらない。0011 までを適用済みの DB にそのまま足せる。
-- job の状態と遷移表は変えない（released / closed はこの経路で使わない）。
-- 戻すときは release_attempt → release_approval → release の順に落とし、app_user.is_agent を落とす（追加の列は表と一緒に消える）。
-- 0008 と同じく BEGIN/COMMIT を使わず、再適用できる形にする。

-- AI・自動処理の利用者の印。承認の経路は DB のこの列を見て、セッションの申告を信じない
alter table app_user add column if not exists is_agent boolean not null default false;

-- 1 job・1 レコード。作業の結果を載せる。更新は job の行を握るか fencing_token の条件付きで行う
create table if not exists release (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references job (id) on delete restrict,
  repo text not null,
  pr_number integer not null check (pr_number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  -- merge
  merge_state text not null default 'none' check (merge_state in ('none','sending','unknown','rejected','merged')),
  merge_detail text,
  merge_sending_at timestamptz,
  merge_approver_user_id uuid references app_user (id) on delete restrict,
  merge_approved_at timestamptz,
  approved_head_sha text check (approved_head_sha is null or approved_head_sha ~ '^[0-9a-f]{40}$'),
  merge_sha text check (merge_sha is null or merge_sha ~ '^[0-9a-f]{40}$'),
  head_tree_sha text,
  merge_tree_sha text,
  tree_match boolean,
  -- 成果物（合否の根拠にした CI の run が残したイメージ。このホストでは作らない。取得元の列は下の alter）
  image_digest text check (image_digest is null or image_digest ~ '^sha256:[0-9a-f]{64}$'),
  artifact_built_at timestamptz,
  artifact_health boolean,
  artifact_smoke boolean,
  -- 配備の承認（SHA + digest + 環境）
  deploy_approver_user_id uuid references app_user (id) on delete restrict,
  deploy_approved_at timestamptz,
  deploy_approved_sha text,
  deploy_approved_digest text,
  environment text,
  -- 配備の結果
  deployed_at timestamptz,
  health boolean,
  smoke boolean,
  url text,
  previous_digest text,
  previous_sha text,
  current_digest text,
  rolled_back_at timestamptz,
  fencing_token integer not null default 0 check (fencing_token >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint release_merged_has_sha check (merge_state <> 'merged' or merge_sha is not null),
  -- 配備承認は3つが揃う
  constraint release_deploy_approval_complete check (
    (deploy_approved_at is null) = (deploy_approved_sha is null)
    and (deploy_approved_at is null) = (deploy_approved_digest is null)
    and (deploy_approved_at is null) = (deploy_approver_user_id is null)
  )
);

-- 承認の行（追記のみ）。人だけ（approver_user_id が必須で、役割は approver のみ）
create table if not exists release_approval (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references release (id) on delete restrict,
  job_id uuid not null references job (id) on delete restrict,
  kind text not null check (kind in ('merge','deploy','rollback')),
  approver_user_id uuid not null references app_user (id) on delete restrict,
  approver_name text not null,
  role text not null check (role = 'approver'),
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  digest text,
  environment text,
  reason text,
  correlation_id text,
  decided_at timestamptz not null,
  -- 押した人ごと・取消ごとに1行を追記する（行は変えない）
  seq bigserial,
  decision text not null default 'approved' check (decision in ('approved','revoked')),
  requester_user_id uuid references app_user (id) on delete restrict,
  requester_name text,
  repo text,
  pr_number integer,
  verified_run_id text,
  verified_run_attempt integer,
  constraint release_approval_merge_bound check (kind <> 'merge' or (repo is not null and pr_number is not null)),
  constraint release_approval_revoke_scope check (decision = 'approved' or (kind = 'merge' and reason is not null and reason <> '')),
  constraint release_approval_deploy_bound check (kind <> 'deploy' or (digest is not null and environment is not null)),
  constraint release_approval_rollback_reason check (kind <> 'rollback' or (reason is not null and reason <> ''))
);
create index if not exists release_approval_job_idx on release_approval (job_id, decided_at);

-- 成果物の作成・配備・戻しの試行（行を消さない）。worker はこの行の lease と fence で書く（job には lease を置けない）
create table if not exists release_attempt (
  seq bigserial primary key,
  id uuid not null unique default gen_random_uuid(),
  release_id uuid not null references release (id) on delete restrict,
  job_id uuid not null references job (id) on delete restrict,
  kind text not null check (kind in ('build','deploy','rollback')),
  state text not null default 'pending' check (state in ('pending','running','succeeded','failed')),
  environment text not null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  digest text,
  previous_digest text,
  previous_sha text,
  -- 終わった時点で環境に載っているもの。環境のいまの版はこの列の最新で決まる
  deployed_digest text,
  deployed_sha text,
  health boolean,
  smoke boolean,
  url text,
  error_code text,
  auto_rollback text check (auto_rollback is null or auto_rollback in ('restored','nothing_to_restore','failed')),
  requested_by uuid references app_user (id) on delete restrict,
  reason text,
  correlation_id text,
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token integer not null default 0 check (fencing_token >= 0),
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  constraint release_attempt_lease_pair check ((lease_owner is null) = (lease_expires_at is null)),
  constraint release_attempt_finished check ((state in ('succeeded','failed')) = (finished_at is not null))
);
-- 1つの環境で同時に動く配備・戻しは1つだけ。同じ release の作成も1つだけ
create unique index if not exists release_attempt_env_active on release_attempt (environment)
  where kind in ('deploy','rollback') and state in ('pending','running');
create unique index if not exists release_attempt_build_active on release_attempt (release_id)
  where kind = 'build' and state in ('pending','running');
create index if not exists release_attempt_claim_idx on release_attempt (seq) where state in ('pending','running');
create index if not exists release_attempt_job_idx on release_attempt (job_id, seq);

create or replace function release_approval_append_only() returns trigger as $$
begin
  raise exception 'release_approval: append only' using errcode = 'check_violation';
end;
$$ language plpgsql;

create or replace trigger release_approval_no_change before update or delete on release_approval
  for each row execute function release_approval_append_only();

create or replace function release_attempt_no_delete() returns trigger as $$
begin
  raise exception 'release_attempt: rows are never deleted' using errcode = 'check_violation';
end;
$$ language plpgsql;

create or replace trigger release_attempt_no_delete before delete on release_attempt
  for each row execute function release_attempt_no_delete();

-- 検査した成果物の配備：合否の根拠にした run を merge の承認で固定し、取得元を残す
alter table release add column if not exists verified_run_id text;
alter table release add column if not exists verified_run_attempt integer;
alter table release add column if not exists artifact_run_id text;
alter table release add column if not exists artifact_run_attempt integer;
alter table release add column if not exists artifact_id bigint;
alter table release add column if not exists artifact_tar_sha256 text
  check (artifact_tar_sha256 is null or artifact_tar_sha256 ~ '^[0-9a-f]{64}$');

create index if not exists release_approval_seq_idx on release_approval (job_id, seq);
