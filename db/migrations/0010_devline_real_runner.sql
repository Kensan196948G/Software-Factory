-- 0010_devline_real_runner.sql — 実 AI ランナーと実 CI の種別を許可する（docs/devline/real-runner.md）
--
-- additive。CHECK の値を広げるだけで、既存の行は変わらない。
-- 戻すときは新しい値の行が無いことを確かめて元の CHECK を張り直す（0008 の定義）。
-- 0008 と同じく BEGIN/COMMIT を使わず、再適用できる形にする。

alter table job drop constraint if exists job_runner_kind_check;
alter table job add constraint job_runner_kind_check
  check (runner_kind in ('fake','local-isolated','real','docker-claude'));

alter table job_attempt drop constraint if exists job_attempt_runner_kind_check;
alter table job_attempt add constraint job_attempt_runner_kind_check
  check (runner_kind in ('fake','local-isolated','real','docker-claude'));

alter table verification drop constraint if exists verification_source_check;
alter table verification add constraint verification_source_check
  check (source in ('fake_ci','ci','github'));

create index if not exists job_claim_runner_idx on job (runner_kind, updated_at)
  where state in ('queued','planning','implementing','revising','verifying');
