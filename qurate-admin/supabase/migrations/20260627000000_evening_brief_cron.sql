-- Schedules the end-of-day ("evening") brief via pg_cron.
-- Fires 17:30 AEST (07:30 UTC) on weekdays, calling the morning-brief Edge
-- Function with the endofday variant. Mirrors the existing morning-brief-daily
-- job. cron.schedule upserts by job name, so re-running is safe.
select cron.schedule(
  'evening-brief-daily',
  '30 7 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://btzlkiwmdegubbvzbmyo.supabase.co/functions/v1/morning-brief',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0emxraXdtZGVndWJidnpibXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY3OTQ1MjIsImV4cCI6MjA4MjM3MDUyMn0.HYfnjFHNcMhvb_rAjhFVZlQBUJPPtpY8mOzpYqTAAk0'
    ),
    body    := '{"variant":"endofday","send":true}'::jsonb
  );
  $$
);
