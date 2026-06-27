-- Web Push subscriptions for the PWA (Epic C — proactive nudges, foundation slice).
-- Single-user MVP: one row per browser/device subscription. The send-push Edge
-- Function reads these (service role) and dispatches Web Push; the /api/push/subscribe
-- route upserts on endpoint. RLS is permissive to match the rest of the schema.
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.push_subscriptions enable row level security;

-- Permissive single-user policy (consistent with existing tables; service role bypasses RLS).
drop policy if exists "allow all push_subscriptions" on public.push_subscriptions;
create policy "allow all push_subscriptions"
  on public.push_subscriptions for all
  using (true) with check (true);
