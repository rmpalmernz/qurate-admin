-- Dedup/audit log for proactive nudges (Epic C). One row per dispatched nudge;
-- the nudge-engine reads recent rows to enforce per-rule cooldowns.
create table if not exists public.nudge_log (
  id         uuid primary key default gen_random_uuid(),
  dedup_key  text not null,
  rule       text not null,
  title      text,
  body       text,
  url        text,
  created_at timestamptz not null default now()
);

create index if not exists idx_nudge_log_dedup_created
  on public.nudge_log (dedup_key, created_at desc);

alter table public.nudge_log enable row level security;
drop policy if exists "allow all nudge_log" on public.nudge_log;
create policy "allow all nudge_log"
  on public.nudge_log for all
  using (true) with check (true);
