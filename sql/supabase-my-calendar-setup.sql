-- ============================================================================
-- My Calendar (Coleby, 2026-11-20)
--
-- Each staff member's own events, made right in the portal on Home ›
-- "Calender For You" (no Google / Outlook needed). Private: only you see
-- yours. Events can repeat (daily / weekly / monthly / yearly, optional end
-- date) and have phone reminders (none, at start, 5/15/30 min, 1 hr, 1 day,
-- 1 week before — pick any). Reminders go to your phone only (push), not
-- the notification center.
--
--   1. my_calendar_events         the events (wall-clock date/time + time zone,
--                                 so repeats keep their local time across DST)
--   2. my_calendar_reminders_sent one row per reminder sent (never twice)
--   3. my_calendar_widget_tokens  the private link the iPhone widget
--                                 (Scriptable) uses — only a hash is stored
--   4. pg_cron: every minute, push-send › reminders. Uses the Vault secret
--      'coi_reminders_service_role_key' (from the COI setup).
--
-- Needs supabase-push-notifications-setup.sql (push_subscriptions) first,
-- and push-send + my-calendar deployed. Safe to re-run.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- 1. Events --------------------------------------------------------------------

create table if not exists public.my_calendar_events (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null default public.current_staff_id() references public.staff_users(id) on delete cascade,
  title text not null,
  location text,
  notes text,
  all_day boolean not null default false,
  start_date date not null,
  start_time time,                         -- null when all day
  end_date date not null,
  end_time time,                           -- null when all day
  tz text not null default 'America/New_York',
  repeat text not null default 'none',
  repeat_until date,                       -- null = repeats forever
  reminders integer[] not null default '{}',   -- minutes before: 0 = at start, 1440 = 1 day ...
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.my_calendar_events drop constraint if exists my_calendar_events_repeat_check;
alter table public.my_calendar_events add constraint my_calendar_events_repeat_check
  check (repeat in ('none', 'daily', 'weekly', 'monthly', 'yearly'));
alter table public.my_calendar_events drop constraint if exists my_calendar_events_dates_check;
alter table public.my_calendar_events add constraint my_calendar_events_dates_check
  check (end_date >= start_date and (all_day or start_time is not null));

alter table public.my_calendar_events alter column staff_id set default public.current_staff_id();
create index if not exists my_calendar_events_staff_idx on public.my_calendar_events (staff_id, start_date);

alter table public.my_calendar_events enable row level security;
revoke all on public.my_calendar_events from anon, authenticated;
grant select, insert, update, delete on public.my_calendar_events to authenticated;
grant all on public.my_calendar_events to service_role;

drop policy if exists my_calendar_events_own on public.my_calendar_events;
create policy my_calendar_events_own on public.my_calendar_events
  for all to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());

create or replace function public.touch_my_calendar_events()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists my_calendar_events_touch on public.my_calendar_events;
create trigger my_calendar_events_touch before update on public.my_calendar_events
  for each row execute function public.touch_my_calendar_events();


-- 2. Reminders sent (server only) ------------------------------------------------

create table if not exists public.my_calendar_reminders_sent (
  event_id uuid not null references public.my_calendar_events(id) on delete cascade,
  occurrence_date date not null,
  minutes integer not null,
  sent_at timestamptz not null default now(),
  primary key (event_id, occurrence_date, minutes)
);
alter table public.my_calendar_reminders_sent enable row level security;
revoke all on public.my_calendar_reminders_sent from anon, authenticated;
grant all on public.my_calendar_reminders_sent to service_role;


-- 3. Widget links (server only) ----------------------------------------------------

create table if not exists public.my_calendar_widget_tokens (
  staff_id uuid primary key references public.staff_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.my_calendar_widget_tokens enable row level security;
revoke all on public.my_calendar_widget_tokens from anon, authenticated;
grant all on public.my_calendar_widget_tokens to service_role;


-- 4. Every minute: send due reminders ----------------------------------------------

select cron.unschedule('my-calendar-reminders')
 where exists (select 1 from cron.job where jobname = 'my-calendar-reminders');
select cron.schedule(
  'my-calendar-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'coi_reminders_service_role_key')
    ),
    body := '{"action":"reminders"}'::jsonb
  )
  where exists (select 1 from public.my_calendar_events where reminders <> '{}');
  $$
);

-- Old "sent" rows aren't needed after a month.
select cron.unschedule('my-calendar-reminders-cleanup')
 where exists (select 1 from cron.job where jobname = 'my-calendar-reminders-cleanup');
select cron.schedule(
  'my-calendar-reminders-cleanup',
  '30 7 * * *',
  $$ delete from public.my_calendar_reminders_sent where sent_at < now() - interval '30 days'; $$
);


-- ============================================================================
-- Sanity checks -- run after the above:
--   select jobname, schedule from cron.job where jobname like 'my-calendar%';     -- 2 rows
--   select count(*) from public.my_calendar_events;                                -- your events
--   -- after adding an event with a reminder due in a couple of minutes:
--   select * from public.my_calendar_reminders_sent order by sent_at desc limit 5;
--   select status_code, content from net._http_response order by id desc limit 3;
-- ============================================================================
