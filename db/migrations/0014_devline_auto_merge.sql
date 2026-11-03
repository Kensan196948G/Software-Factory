-- 0014_devline_auto_merge.sql — 複数リポジトリの許可台帳と自動マージ（DEVLINE_AUTO_MERGE）
--
-- additive。遷移表と stop_reason の値の追加、release の列の追加だけで、既存の行は変わらない。
-- 0012 までを適用済みの DB にそのまま足せる。0008 と同じく BEGIN/COMMIT を使わず、再適用できる形にする。
-- 戻すときは release の追加列を落とし、pr_ready → stopped / stopped → pr_ready の行が無いことを確かめてから
-- 0008 の遷移表と 0011 の stop_reason の CHECK を張り直す（自動マージの記録が残っている間は戻さない）。
--
-- 変更の理由:
-- - 自動マージの失敗だけが pr_ready から stopped（理由 auto_merge_failed）へ進む。
--   人の再開で stopped から pr_ready へ戻れるようにする（resume_to=pr_ready を CHECK が許す）。
-- - release に、機械判定で merge したことと、その根拠（ポリシー版・verdict・AC・run）を残す。
--   人の承認の行（release_approval）は作らない。自動マージは人の承認の代替ではない。

-- 自動マージの失敗。人の承認の経路は従来どおり残る
alter table job drop constraint if exists job_stop_reason_check;
alter table job add constraint job_stop_reason_check check (stop_reason is null or stop_reason in (
  'cancel_requested','order_superseded','order_invalidated','same_cause_limit','repair_total_limit',
  'session_limit','continuous_limit','ci_rerun_limit','ci_incomplete','budget_limit','policy_violation',
  'human_approval_required','red_signal_human_required','planning_question','lease_lost_repeatedly',
  'runner_failure','runner_rejected','human_stop',
  'auto_merge_failed'
));

-- 遷移表（0008 の定義 + 自動マージの2辺）。TS の JOB_TRANSITIONS と一致させる（試験 T-02）
create or replace function devline_job_transition_allowed(from_state text, to_state text) returns boolean as $$
  select (from_state, to_state) in (
    ('queued', 'planning'), ('queued', 'cancelled'),
    ('planning', 'implementing'), ('planning', 'stopped'),
    ('implementing', 'verifying'), ('implementing', 'stopped'), ('implementing', 'failed'),
    ('verifying', 'pr_ready'), ('verifying', 'revising'), ('verifying', 'stopped'),
    ('revising', 'verifying'), ('revising', 'stopped'),
    ('pr_ready', 'reviewing'), ('pr_ready', 'approved'), ('pr_ready', 'stopped'),
    ('reviewing', 'approved'), ('reviewing', 'revising'), ('reviewing', 'stopped'),
    ('approved', 'merged'),
    ('merged', 'staged'),
    ('staged', 'released'),
    ('released', 'closed'),
    ('stopped', 'planning'), ('stopped', 'implementing'), ('stopped', 'verifying'),
    ('stopped', 'revising'), ('stopped', 'reviewing'), ('stopped', 'pr_ready'), ('stopped', 'closed'),
    ('failed', 'implementing'), ('failed', 'closed'),
    ('cancelled', 'queued'), ('cancelled', 'closed')
  );
$$ language sql immutable;

-- 自動マージの記録（release は 1 job に 1 行）。人の承認の列とは分ける。
-- auto_merge=true の行は release_approval を持たない（AI・自動処理は承認しない原則を DB でも分離する）。
alter table release add column if not exists auto_merge boolean not null default false;
alter table release add column if not exists auto_merge_policy_version text;
alter table release add column if not exists auto_merge_verdict text
  check (auto_merge_verdict is null or auto_merge_verdict in ('passed', 'failed', 'incomplete', 'stale', 'no_result'));
alter table release add column if not exists auto_merge_ac_ids text[];
alter table release add column if not exists auto_merge_run_id text;
alter table release add column if not exists auto_merge_decided_at timestamptz;
alter table release add column if not exists auto_merge_detail jsonb;
alter table release drop constraint if exists release_auto_merge_evidence;
alter table release add constraint release_auto_merge_evidence check (
  not auto_merge or (auto_merge_policy_version is not null and auto_merge_decided_at is not null)
);

comment on column release.auto_merge is 'DEVLINE_AUTO_MERGE=1 の明示設定でサーバが機械判定して merge した（人の承認ではない）';
comment on column release.auto_merge_policy_version is '判定に使ったポリシー版（src/shared/devline.ts の AUTO_MERGE_POLICY_VERSION）';
comment on column release.auto_merge_verdict is '判定時の検証 verdict（passed だけを merge する）';
comment on column release.auto_merge_ac_ids is '判定時に確認済みだった受入条件の ID';
comment on column release.auto_merge_run_id is '根拠にした CI の run ID';
comment on column release.auto_merge_detail is '判定根拠・失敗理由（秘密は入れない）';
