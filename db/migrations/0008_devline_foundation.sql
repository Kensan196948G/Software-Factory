-- 0008_devline_foundation.sql — 開発ライン Phase 1 fake 縦断 PoC の土台（Issue #14）
--
-- 判断の根拠: docs/devline/adr-001-devline-foundation.md
-- 遷移表の正本: src/shared/devline.ts（ここの SQL と一致することを試験 T-02 で確かめる）
--
-- additive のみ。既存の表（approval / request ほか）は変更しない。
-- global-setup は BEGIN なしで生の SQL を流し、db.ts migrate は BEGIN で包む。
-- どちらでも通し、再適用もできるよう BEGIN/COMMIT や CREATE TYPE は使わない。

/* ───────── 共通の関数 ───────── */

/* 追記のみの表の UPDATE/DELETE を拒否する（audit_log_append_only と同じ方式）。表全体の一括削除 は対象外。 */
create or replace function devline_append_only() returns trigger as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;

/* 消してはいけないが、行の更新は認める表の DELETE を拒否する。 */
create or replace function devline_no_delete() returns trigger as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name;
end;
$$ language plpgsql;

/* job 状態の遷移表（詳細仕様書 4-3）。src/shared/devline.ts の JOB_TRANSITIONS と同じ内容。 */
create or replace function devline_job_transition_allowed(from_state text, to_state text) returns boolean as $$
  select (from_state, to_state) in (
    ('queued', 'planning'), ('queued', 'cancelled'),
    ('planning', 'implementing'), ('planning', 'stopped'),
    ('implementing', 'verifying'), ('implementing', 'stopped'), ('implementing', 'failed'),
    ('verifying', 'pr_ready'), ('verifying', 'revising'), ('verifying', 'stopped'),
    ('revising', 'verifying'), ('revising', 'stopped'),
    ('pr_ready', 'reviewing'), ('pr_ready', 'approved'),
    ('reviewing', 'approved'), ('reviewing', 'revising'), ('reviewing', 'stopped'),
    ('approved', 'merged'),
    ('merged', 'staged'),
    ('staged', 'released'),
    ('released', 'closed'),
    ('stopped', 'planning'), ('stopped', 'implementing'), ('stopped', 'verifying'),
    ('stopped', 'revising'), ('stopped', 'reviewing'), ('stopped', 'closed'),
    ('failed', 'implementing'), ('failed', 'closed'),
    ('cancelled', 'queued'), ('cancelled', 'closed')
  );
$$ language sql immutable;

/* handoff_intent の補助状態の遷移表。src/shared/devline.ts の HANDOFF_TRANSITIONS と同じ内容。 */
create or replace function devline_handoff_transition_allowed(from_state text, to_state text) returns boolean as $$
  select (from_state, to_state) in (
    ('intent', 'sent'), ('intent', 'failed'),
    ('sent', 'succeeded'), ('sent', 'unknown'), ('sent', 'failed'),
    ('unknown', 'succeeded'), ('unknown', 'sent'),
    ('failed', 'sent')
  );
$$ language sql immutable;

/* ───────── 版固定（order_snapshot・追記のみ） ───────── */

create table if not exists order_snapshot (
  id uuid primary key default gen_random_uuid(),
  request_id text not null references request(id) on delete restrict,
  order_version integer not null check (order_version >= 1),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_yaml text not null,
  envelope jsonb not null,
  envelope_sha256 text not null check (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  approval_id uuid not null references approval(id) on delete restrict,
  approver_user_id uuid not null references app_user(id) on delete restrict,
  target_repo_id text not null check (target_repo_id ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  policy_version text not null check (policy_version <> ''),
  frozen_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint order_snapshot_version_unique unique (request_id, order_version, target_repo_id),
  constraint order_snapshot_ref_unique unique (id, request_id, order_version, target_repo_id),
  constraint order_snapshot_yaml_normalized check (
    position(E'\r' in canonical_yaml) = 0 and canonical_yaml ~ E'[^\n]\n$'
  ),
  constraint order_snapshot_yaml_hash check (
    encode(sha256(convert_to(canonical_yaml, 'UTF8')), 'hex') = content_sha256
  ),
  constraint order_snapshot_envelope_schema check (envelope ->> 'schema' = 'msf.order-envelope/v1')
);

/* 承認の有効性を DB でも確かめる（サービス層の検査をすり抜けた旧版・未承認を止める最後の砦）。 */
create or replace function order_snapshot_check_approval() returns trigger as $$
declare
  req record;
  latest record;
begin
  select status, order_version, deleted into req from request where id = new.request_id;
  select id, decision, order_version, approver_user_id into latest
    from approval where request_id = new.request_id
    order by at desc, id desc limit 1;
  if req.status is distinct from 'approved'
     or req.deleted is distinct from false
     or req.order_version is distinct from new.order_version
     or latest.id is distinct from new.approval_id
     or latest.decision is distinct from 'approved'
     or latest.order_version is distinct from new.order_version
     or latest.approver_user_id is distinct from new.approver_user_id then
    raise exception 'order_snapshot: approval is not valid for request % version %', new.request_id, new.order_version;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists order_snapshot_approval_guard on order_snapshot;
create trigger order_snapshot_approval_guard before insert on order_snapshot
  for each row execute function order_snapshot_check_approval();

drop trigger if exists order_snapshot_no_update on order_snapshot;
create trigger order_snapshot_no_update before update or delete on order_snapshot
  for each row execute function devline_append_only();

/* ───────── 冪等 handoff（handoff_intent） ───────── */

create table if not exists handoff_intent (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  request_id text not null,
  order_version integer not null,
  target_repo_id text not null,
  op_kind text not null check (op_kind in ('create_issue','update_issue')),
  state text not null default 'intent' check (state in ('intent','sent','succeeded','unknown','failed')),
  marker text not null,
  target_issue_no integer check (target_issue_no is null or target_issue_no >= 1),
  issue_no integer check (issue_no is null or issue_no >= 1),
  issue_url text,
  attempts integer not null default 0 check (attempts >= 0),
  sent_at timestamptz,
  next_attempt_at timestamptz,
  last_outcome text,
  last_http_status integer,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  reconciled_at timestamptz,
  confirmed_absent_by uuid references app_user(id) on delete restrict,
  confirmed_absent_at timestamptz,
  confirmed_absent_reason text,
  created_by uuid references app_user(id) on delete restrict,
  correlation_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint handoff_intent_key unique (request_id, order_version, target_repo_id, op_kind),
  constraint handoff_intent_snapshot_fk foreign key (snapshot_id, request_id, order_version, target_repo_id)
    references order_snapshot (id, request_id, order_version, target_repo_id) on delete restrict,
  constraint handoff_intent_target_issue check ((op_kind = 'update_issue') = (target_issue_no is not null)),
  constraint handoff_intent_succeeded_has_issue check (state <> 'succeeded' or (issue_no is not null and issue_url is not null)),
  constraint handoff_intent_sent_has_time check (state not in ('sent','unknown','succeeded') or sent_at is not null),
  constraint handoff_intent_confirm_complete check (
    (confirmed_absent_at is null and confirmed_absent_by is null and confirmed_absent_reason is null)
    or (confirmed_absent_at is not null and confirmed_absent_by is not null and confirmed_absent_reason is not null)
  )
);

/* 1依頼・1リポジトリの Issue は1つだけ。未確定（intent/sent/unknown）の作成が残るあいだは次の版でも作成させない。 */
create unique index if not exists handoff_intent_one_create_idx
  on handoff_intent (request_id, target_repo_id)
  where op_kind = 'create_issue' and state in ('intent','sent','unknown','succeeded');

/* 外部呼び出し中（sent）は依頼とリポジトリごとに1件だけ。古い版の PATCH が新しい版を追い越さないようにする。 */
create unique index if not exists handoff_intent_one_inflight_idx
  on handoff_intent (request_id, target_repo_id)
  where state = 'sent';

create index if not exists handoff_intent_request_idx on handoff_intent (request_id, order_version);

create or replace function handoff_intent_guard() returns trigger as $$
begin
  if old.snapshot_id is distinct from new.snapshot_id
     or old.request_id is distinct from new.request_id
     or old.order_version is distinct from new.order_version
     or old.target_repo_id is distinct from new.target_repo_id
     or old.op_kind is distinct from new.op_kind
     or old.marker is distinct from new.marker then
    raise exception 'handoff_intent: key columns are immutable';
  end if;
  if old.state is distinct from new.state
     and not devline_handoff_transition_allowed(old.state, new.state) then
    raise exception 'handoff_intent: transition % -> % is not allowed', old.state, new.state;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists handoff_intent_update_guard on handoff_intent;
create trigger handoff_intent_update_guard before update on handoff_intent
  for each row execute function handoff_intent_guard();

drop trigger if exists handoff_intent_no_delete on handoff_intent;
create trigger handoff_intent_no_delete before delete on handoff_intent
  for each row execute function devline_no_delete();

/* ───────── 実行ジョブ（ENT-08） ───────── */

create table if not exists job (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null,
  request_id text not null,
  order_version integer not null,
  target_repo_id text not null,
  handoff_intent_id uuid not null unique references handoff_intent(id) on delete restrict,
  state text not null default 'queued' check (state in (
    'queued','planning','implementing','verifying','revising','pr_ready','reviewing',
    'approved','merged','staged','released','closed','stopped','failed','cancelled'
  )),
  policy_version text not null check (policy_version <> ''),
  runner_kind text not null default 'fake' check (runner_kind in ('fake','local-isolated','real')),
  plan jsonb,
  work_state jsonb not null default '{}'::jsonb,
  head_sha text check (head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
  repair_count_total integer not null default 0 check (repair_count_total >= 0),
  repair_count_by_cause jsonb not null default '{}'::jsonb check (jsonb_typeof(repair_count_by_cause) = 'object'),
  ci_rerun_count integer not null default 0 check (ci_rerun_count >= 0),
  session_started_at timestamptz,
  continuous_seconds integer not null default 0 check (continuous_seconds >= 0),
  cost_jpy integer not null default 0 check (cost_jpy >= 0),
  usage jsonb not null default '{}'::jsonb,
  stop_reason text check (stop_reason is null or stop_reason in (
    'cancel_requested','order_superseded','order_invalidated','same_cause_limit','repair_total_limit',
    'session_limit','continuous_limit','ci_rerun_limit','budget_limit','policy_violation',
    'human_approval_required','red_signal_human_required','planning_question','lease_lost_repeatedly',
    'runner_failure','runner_rejected','human_stop'
  )),
  stop_detail jsonb,
  remaining_work jsonb,
  resume_to text,
  stopped_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid references app_user(id) on delete restrict,
  superseded_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  fencing_token integer not null default 0 check (fencing_token >= 0),
  lease_reclaim_count integer not null default 0 check (lease_reclaim_count >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint job_version_unique unique (request_id, order_version, target_repo_id),
  constraint job_snapshot_fk foreign key (snapshot_id, request_id, order_version, target_repo_id)
    references order_snapshot (id, request_id, order_version, target_repo_id) on delete restrict,
  constraint job_lease_pair check ((lease_owner is null) = (lease_expires_at is null)),
  constraint job_no_lease_when_waiting check (
    state not in ('pr_ready','reviewing','approved','merged','staged','released','closed','stopped','failed','cancelled')
    or lease_owner is null
  ),
  constraint job_stop_recorded check (
    (state in ('stopped','failed','cancelled')) = (stop_reason is not null)
    and (state not in ('stopped','failed','cancelled') or (
      remaining_work is not null and stopped_at is not null and resume_to is not null
      and devline_job_transition_allowed(state, resume_to) and resume_to <> 'closed'
    ))
  )
);

create index if not exists job_claim_idx on job (created_at)
  where state in ('queued','planning','implementing','revising','verifying');
create index if not exists job_request_idx on job (request_id, order_version desc);

create or replace function job_guard() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'queued' then
      raise exception 'job: must start as queued (got %)', new.state;
    end if;
    return new;
  end if;
  if old.snapshot_id is distinct from new.snapshot_id
     or old.request_id is distinct from new.request_id
     or old.order_version is distinct from new.order_version
     or old.target_repo_id is distinct from new.target_repo_id
     or old.handoff_intent_id is distinct from new.handoff_intent_id
     or old.policy_version is distinct from new.policy_version then
    raise exception 'job: identity columns are immutable';
  end if;
  if new.fencing_token < old.fencing_token then
    raise exception 'job: fencing_token must not decrease';
  end if;
  if old.state is distinct from new.state
     and not devline_job_transition_allowed(old.state, new.state) then
    raise exception 'job: transition % -> % is not allowed', old.state, new.state;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_write_guard on job;
create trigger job_write_guard before insert or update on job
  for each row execute function job_guard();

drop trigger if exists job_no_delete on job;
create trigger job_no_delete before delete on job
  for each row execute function devline_no_delete();

/* ───────── 実行の試行（job_attempt） ───────── */

create table if not exists job_attempt (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references job(id) on delete restrict,
  attempt_no integer not null check (attempt_no >= 1),
  state_at_start text not null check (state_at_start in ('planning','implementing','revising')),
  fencing_token integer not null check (fencing_token >= 0),
  runner_kind text not null check (runner_kind in ('fake','local-isolated','real')),
  started_at timestamptz not null,
  finished_at timestamptz,
  outcome text check (outcome is null or outcome in ('succeeded','failed','needs_human','timed_out','cancelled','rejected','discarded')),
  exit_code integer,
  log_ref text,
  result jsonb,
  usage jsonb not null default '{}'::jsonb,
  cost_jpy integer not null default 0 check (cost_jpy >= 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  constraint job_attempt_no_unique unique (job_id, attempt_no),
  constraint job_attempt_finished check ((finished_at is null) = (outcome is null))
);

/* 終わった試行は書きかえない。 */
create or replace function job_attempt_guard() returns trigger as $$
begin
  if old.finished_at is not null then
    raise exception 'job_attempt: finished attempt is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_attempt_update_guard on job_attempt;
create trigger job_attempt_update_guard before update on job_attempt
  for each row execute function job_attempt_guard();

drop trigger if exists job_attempt_no_delete on job_attempt;
create trigger job_attempt_no_delete before delete on job_attempt
  for each row execute function devline_no_delete();

/* ───────── 出来事（job_event・追記のみ） ───────── */

/* actor_user_id は audit_log と同じく外部キーにしない（利用者の削除に左右されない記録にする）。 */
create table if not exists job_event (
  id bigserial primary key,
  job_id uuid not null references job(id) on delete restrict,
  at timestamptz not null,
  kind text not null check (kind <> ''),
  from_state text,
  to_state text,
  fencing_token integer,
  actor_type text not null check (actor_type in ('human','system','agent')),
  actor_user_id uuid,
  correlation_id text,
  detail jsonb,
  constraint job_event_transition check (
    (from_state is null and to_state is null)
    or (from_state is not null and to_state is not null and devline_job_transition_allowed(from_state, to_state))
  )
);
create index if not exists job_event_job_idx on job_event (job_id, id);

drop trigger if exists job_event_no_update on job_event;
create trigger job_event_no_update before update or delete on job_event
  for each row execute function devline_append_only();

/* ───────── 成果物（job_artifact・追記のみ） ───────── */

create table if not exists job_artifact (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references job(id) on delete restrict,
  attempt_id uuid references job_attempt(id) on delete restrict,
  kind text not null check (kind in ('plan','patch','log','test_report','runner_output','pr_body_draft')),
  name text not null check (name <> '' and name not like '/%' and position('..' in name) = 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size >= 0),
  storage_ref text,
  content text check (content is null or octet_length(content) <= 262144),
  created_at timestamptz not null,
  constraint job_artifact_unique unique (job_id, kind, name, sha256),
  constraint job_artifact_has_body check (storage_ref is not null or content is not null),
  constraint job_artifact_ref_relative check (storage_ref is null or storage_ref !~ '^(/|[A-Za-z]:)')
);
create index if not exists job_artifact_job_idx on job_artifact (job_id, kind);

drop trigger if exists job_artifact_no_update on job_artifact;
create trigger job_artifact_no_update before update or delete on job_artifact
  for each row execute function devline_append_only();

/* ───────── 検証結果（ENT-09・追記のみ） ───────── */

create table if not exists verification (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references job(id) on delete restrict,
  delivery_id text not null unique check (delivery_id <> ''),
  source text not null check (source in ('fake_ci','ci')),
  ci_run_id text not null check (ci_run_id <> ''),
  run_sequence bigint not null check (run_sequence >= 1),
  run_attempt integer not null default 1 check (run_attempt >= 1),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  stages jsonb not null check (jsonb_typeof(stages) = 'array'),
  ac_results jsonb not null default '[]'::jsonb check (jsonb_typeof(ac_results) = 'array'),
  log_ref text,
  report_digest text check (report_digest is null or report_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null,
  constraint verification_run_unique unique (job_id, ci_run_id, run_attempt)
);
create index if not exists verification_job_sha_idx on verification (job_id, head_sha, run_sequence desc, run_attempt desc);

drop trigger if exists verification_no_update on verification;
create trigger verification_no_update before update or delete on verification
  for each row execute function devline_append_only();

comment on table order_snapshot is '承認済み注文書の版固定。追記のみ。canonical_yaml を一度だけ作って保存し、再生成して比べない';
comment on table handoff_intent is '外部呼び出しの前に記録する意図。state は ENT-08 の状態ではなく補助フィールド';
comment on table job is '実行ジョブ（ENT-08）。状態は詳細仕様書 4-3 のみ。受付12状態とは別管理';
comment on table verification is '検証結果（ENT-09）。追記のみ。Agent の自己申告を入れない（source に agent が無い）';
