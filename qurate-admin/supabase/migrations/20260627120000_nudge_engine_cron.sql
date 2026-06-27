-- Schedules the nudge-engine via pg_cron (Epic C). Runs every 30 minutes; the
-- function itself enforces AEST quiet hours (07:00–19:00), weekday-only, focus-block
-- suppression, per-rule cooldowns and a per-run cap — so an unconditional */30
-- schedule is correct and cheap (most runs early-return "quiet_hours").
-- cron.schedule upserts by job name, so re-running is safe.
select cron.schedule(
  'nudge-engine-30min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://btzlkiwmdegubbvzbmyo.supabase.co/functions/v1/nudge-engine',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0emxraXdtZGVndWJidnpibXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3OTQ1MjIsImV4cCI6MjA4MjM3MDUyMn0.HYfnjFHNcMhvb_rAjhFVZlQBUJPPtpY8mOzpYqTAAk0'
    ),
    body    := '{"trigger":"scheduled"}'::jsonb
  );
  $$
);
