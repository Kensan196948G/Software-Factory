-- 0009_devline_pr_ready_guard.sql — verifying → pr_ready に合格の記録と PR 候補を必須にする（Issue #14）
--
-- additive。job_guard を置きかえるだけで、表は変更しない。サービス層をすり抜けた更新を止める最後の砦。
-- BEGIN/COMMIT や CREATE TYPE を使わず、再適用できる形にする（0008 と同じ）。

create or replace function devline_has_passing_verification(p_job_id uuid, p_head_sha text) returns boolean as $$
  with latest as (
    select stages from verification
     where job_id = p_job_id and head_sha = p_head_sha
     order by run_sequence desc, run_attempt desc
     limit 1
  ), required(stage) as (
    values ('static'), ('build'), ('unit'), ('integration'), ('e2e'), ('security')
  )
  select exists (select 1 from latest)
     and not exists (
       select 1 from required r
        where not exists (
          select 1 from latest l, jsonb_array_elements(l.stages) e where e ->> 'stage' = r.stage
        )
           or exists (
          select 1 from latest l, jsonb_array_elements(l.stages) e
           where e ->> 'stage' = r.stage and e ->> 'status' <> 'passed'
        )
     );
$$ language sql stable;

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
  if old.state = 'verifying' and new.state = 'pr_ready' then
    if new.head_sha is null or not devline_has_passing_verification(new.id, new.head_sha) then
      raise exception 'job: pr_ready requires a passing verification' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from job_artifact a where a.job_id = new.id and a.kind = 'pr_body_draft') then
      raise exception 'job: pr_ready requires a pr_body_draft artifact' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
