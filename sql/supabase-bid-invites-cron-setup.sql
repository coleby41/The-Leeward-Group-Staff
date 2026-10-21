-- ============================================================================
-- supabase-bid-invites-cron-setup.sql
--
-- Runs the bid-reminders Edge Function once a day at 9 AM Eastern (13:00
-- UTC; 8 AM during standard time) — same setup as the COI reminders
-- (supabase-coi-notifications-cron-setup.sql), and it reuses the service
-- role key that file already stored in Vault, so there's nothing new to
-- configure.
--
-- Run AFTER deploying the bid-reminders function. Safe to re-run.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any earlier version of this job.
select cron.unschedule(jobid) from cron.job where jobname = 'send-bid-reminders-daily';

select cron.schedule(
  'send-bid-reminders-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/bid-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'coi_reminders_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Sanity check:
--   select jobname, schedule, active from cron.job where jobname = 'send-bid-reminders-daily';  -- one row, active
-- After the next 9 AM run:
--   select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'send-bid-reminders-daily') order by start_time desc limit 5;
