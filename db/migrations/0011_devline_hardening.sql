-- 0011_devline_hardening.sql — 実ランナーの堅牢化（docs/devline/real-runner.md）
--
-- additive。列の追加と CHECK の値の拡張だけで、既存の行は変わらない。0010 までを適用済みの DB にそのまま足せる。
-- 戻すときは ci_incomplete の行が無いことを確かめて元の CHECK を張り直し（0008 の定義）、列を落とす。
-- 0008 と同じく BEGIN/COMMIT を使わず、再適用できる形にする。

-- 試行に割り当てた費用の上限。worker が落ちて結果を受け取れなかった試行は、これを費用として計上する
alter table job_attempt add column if not exists allotment_jpy integer not null default 0;
alter table job_attempt drop constraint if exists job_attempt_allotment_jpy_check;
alter table job_attempt add constraint job_attempt_allotment_jpy_check check (allotment_jpy >= 0);

-- 実 CI の結果が揃わない（skip・cancelled・段階名の不一致）。待たずに止める理由
alter table job drop constraint if exists job_stop_reason_check;
alter table job add constraint job_stop_reason_check check (stop_reason is null or stop_reason in (
  'cancel_requested','order_superseded','order_invalidated','same_cause_limit','repair_total_limit',
  'session_limit','continuous_limit','ci_rerun_limit','ci_incomplete','budget_limit','policy_violation',
  'human_approval_required','red_signal_human_required','planning_question','lease_lost_repeatedly',
  'runner_failure','runner_rejected','human_stop'
));
