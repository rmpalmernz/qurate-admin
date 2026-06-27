-- Spend guard: a daily AI-spend circuit-breaker plus a per-function alert throttle.
--
-- Why: api_cost_log records spend but nothing acts on it, and the unattended crons
-- can fire Claude on a schedule with no hard ceiling (the 227k-row runaway was the
-- expensive lesson). This adds state + helper functions that the `spend-guard` Edge
-- Function uses to pause the two autonomous AI crons when today's spend crosses a
-- ceiling, and resume them when it drops back under.
--
-- Scope is intentionally the two AI crons only — interactive chat/draft-reply are
-- bounded by the user and stay usable.

-- 1. Single-row breaker state.
create table if not exists public.spend_guard_state (
  id          boolean primary key default true,
  paused      boolean not null default false,
  paused_at   timestamptz,
  last_spend  numeric,
  updated_at  timestamptz not null default now(),
  constraint spend_guard_state_single_row check (id)
);
insert into public.spend_guard_state (id, paused) values (true, false)
  on conflict (id) do nothing;

-- 2. Per-function alert throttle state (rate-limits failure emails).
create table if not exists public.function_alert_state (
  fn               text primary key,
  last_alerted_at  timestamptz not null default now()
);

-- 3. Today's AI spend in the app's timezone (AEST, Australia/Brisbane), matching
--    morning-brief's day boundary.
create or replace function public.ai_spend_today_aest()
returns numeric
language sql
stable
as $$
  select coalesce(sum(estimated_cost), 0)::numeric
  from public.api_cost_log
  where created_at >= (date_trunc('day', now() at time zone 'Australia/Brisbane')
                       at time zone 'Australia/Brisbane');
$$;
grant execute on function public.ai_spend_today_aest() to service_role;

-- 4. Toggle the two autonomous AI crons. SECURITY DEFINER so the service role can
--    reach the protected cron schema.
create or replace function public.set_ai_crons_active(p_active boolean)
returns integer
language plpgsql
security definer
set search_path = cron, public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select jobid from cron.job
    where jobname in ('morning-brief-daily', 'sync-outlook-matrix')
  loop
    perform cron.alter_job(r.jobid, active := p_active);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.set_ai_crons_active(boolean) from public;
grant execute on function public.set_ai_crons_active(boolean) to service_role;

-- 5. Alert throttle: returns true at most once per p_min per function key.
create or replace function public.should_alert(p_fn text, p_min interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  insert into public.function_alert_state (fn, last_alerted_at)
  values (p_fn, now())
  on conflict (fn) do update
    set last_alerted_at = now()
    where public.function_alert_state.last_alerted_at < now() - p_min
  returning true into ok;
  return coalesce(ok, false);
end;
$$;
revoke all on function public.should_alert(text, interval) from public;
grant execute on function public.should_alert(text, interval) to service_role;

-- 6. Run the guard every 13 minutes (off-the-:00 minute to avoid fleet pile-ups).
--    The bearer is the public anon key, identical to the existing cron commands.
select cron.unschedule(jobid) from cron.job where jobname = 'spend-guard';
select cron.schedule('spend-guard', '*/13 * * * *', $job$
  SELECT net.http_post(
    url := 'https://btzlkiwmdegubbvzbmyo.supabase.co/functions/v1/spend-guard',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0emxraXdtZGVndWJidnpibXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3OTQ1MjIsImV4cCI6MjA4MjM3MDUyMn0.HYfnjFHNcMhvb_rAjhFVZlQBUJPPtpY8mOzpYqTAAk0"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
$job$);
