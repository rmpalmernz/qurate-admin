-- Schedules the weekly auto-handled digest (Epic E §3) via pg_cron.
-- Mon 07:00 AEST = Sun 21:00 UTC. Idempotent in-function via api_cost_log.
-- cron.schedule upserts by job name, so re-running is safe.
select cron.schedule(
  'auto-handled-digest-weekly',
  '0 21 * * 0',
  $$
  select net.http_post(
    url     := 'https://btzlkiwmdegubbvzbmyo.supabase.co/functions/v1/auto-handled-digest',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0emxraXdtZGVndWJidnpibXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3OTQ1MjIsImV4cCI6MjA4MjM3MDUyMn0.HYfnjFHNcMhvb_rAjhFVZlQBUJPPtpY8mOzpYqTAAk0'
    ),
    body    := '{"send":true}'::jsonb
  );
  $$
);
