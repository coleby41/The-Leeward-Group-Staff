-- ============================================================================
-- Staff Calendar (Coleby, 2026-11-20) — pages/calendar.html
--
-- Builds on My Calendar (supabase-my-calendar-setup.sql, run it first):
-- my_calendar_events stays the event table (staff_id = the organizer).
--
--   1. my_calendar_events: project_id (optional), organizer_attends
--      (false when the organizer only assigned it to others).
--   2. calendar_event_people: who's on an event besides the organizer.
--        role      'invite' (asked to come: Accept / Decline)
--                  'assign' (put on their calendar; the organizer isn't attending)
--        response  pending | accepted | declined | conflict ("Decline – I have
--                  a conflict": the organizer is told so they can move it)
--        reminders their own phone reminders
--   3. Who can see what: you see your own events and every event you're on.
--      Only the organizer changes an event; people change only their own
--      answer + reminders. Saving / inviting / answering go through the
--      staff-calendar Edge Function, which also sends the notifications.
--   4. calendar_feed_tokens: your private calendar link (ICS) for Google /
--      Apple Calendar. Only a hash is stored.
--   5. calendar_settings: default reminders, working hours, week start.
--
-- Safe to re-run.
-- ============================================================================


-- 1. Events: project + organizer attending ----------------------------------------

alter table public.my_calendar_events add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.my_calendar_events add column if not exists organizer_attends boolean not null default true;


-- 2. People on an event ----------------------------------------------------------------

create table if not exists public.calendar_event_people (
  event_id uuid not null references public.my_calendar_events(id) on delete cascade,
  staff_id uuid not null references public.staff_users(id) on delete cascade,
  role text not null default 'invite',
  response text not null default 'pending',
  reminders integer[] not null default '{15}',
  responded_at timestamptz,
  added_at timestamptz not null default now(),
  primary key (event_id, staff_id)
);
alter table public.calendar_event_people drop constraint if exists calendar_event_people_role_check;
alter table public.calendar_event_people add constraint calendar_event_people_role_check check (role in ('invite', 'assign'));
alter table public.calendar_event_people drop constraint if exists calendar_event_people_response_check;
alter table public.calendar_event_people add constraint calendar_event_people_response_check
  check (response in ('pending', 'accepted', 'declined', 'conflict'));
create index if not exists calendar_event_people_staff_idx on public.calendar_event_people (staff_id);

-- Reminders sent to people on an event (organizer's go in my_calendar_reminders_sent).
alter table public.my_calendar_reminders_sent add column if not exists staff_id uuid;
update public.my_calendar_reminders_sent r set staff_id = e.staff_id
  from public.my_calendar_events e where r.staff_id is null and e.id = r.event_id;
alter table public.my_calendar_reminders_sent alter column staff_id set not null;
alter table public.my_calendar_reminders_sent drop constraint if exists my_calendar_reminders_sent_pkey;
alter table public.my_calendar_reminders_sent add constraint my_calendar_reminders_sent_pkey primary key (event_id, occurrence_date, minutes, staff_id);


-- 3. Who can see what ----------------------------------------------------------------

-- Am I on this event? (security definer so the policies don't loop)
create or replace function public.is_on_calendar_event(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.calendar_event_people where event_id = p_event and staff_id = public.current_staff_id());
$$;
create or replace function public.is_calendar_organizer(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.my_calendar_events where id = p_event and staff_id = public.current_staff_id());
$$;
revoke all on function public.is_on_calendar_event(uuid) from public, anon;
revoke all on function public.is_calendar_organizer(uuid) from public, anon;
grant execute on function public.is_on_calendar_event(uuid) to authenticated;
grant execute on function public.is_calendar_organizer(uuid) to authenticated;

drop policy if exists my_calendar_events_own on public.my_calendar_events;
drop policy if exists my_calendar_events_read on public.my_calendar_events;
drop policy if exists my_calendar_events_write on public.my_calendar_events;
create policy my_calendar_events_read on public.my_calendar_events
  for select to authenticated
  using (staff_id = public.current_staff_id() or public.is_on_calendar_event(id));
create policy my_calendar_events_write on public.my_calendar_events
  for all to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());

alter table public.calendar_event_people enable row level security;
revoke all on public.calendar_event_people from anon, authenticated;
grant select, update on public.calendar_event_people to authenticated;
grant all on public.calendar_event_people to service_role;
drop policy if exists calendar_event_people_read on public.calendar_event_people;
create policy calendar_event_people_read on public.calendar_event_people
  for select to authenticated
  using (staff_id = public.current_staff_id() or public.is_calendar_organizer(event_id) or public.is_on_calendar_event(event_id));
-- Your own reminders (answers go through the Edge Function so the organizer is told).
drop policy if exists calendar_event_people_own_reminders on public.calendar_event_people;
create policy calendar_event_people_own_reminders on public.calendar_event_people
  for update to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());
revoke update on public.calendar_event_people from authenticated;
grant update (reminders) on public.calendar_event_people to authenticated;


-- 4. Private calendar link (server only) ---------------------------------------------

create table if not exists public.calendar_feed_tokens (
  staff_id uuid primary key references public.staff_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_used_by text
);
alter table public.calendar_feed_tokens enable row level security;
revoke all on public.calendar_feed_tokens from anon, authenticated;
grant all on public.calendar_feed_tokens to service_role;


-- 5. Settings ---------------------------------------------------------------------------

create table if not exists public.calendar_settings (
  staff_id uuid primary key default public.current_staff_id() references public.staff_users(id) on delete cascade,
  default_reminders integer[] not null default '{15}',
  work_start time not null default '07:00',
  work_end time not null default '17:00',
  week_start smallint not null default 0,                -- 0 = Sunday, 1 = Monday
  google_busy boolean not null default true,             -- count Google events when people check if I'm busy
  updated_at timestamptz not null default now()
);
alter table public.calendar_settings enable row level security;
revoke all on public.calendar_settings from anon, authenticated;
grant select, insert, update on public.calendar_settings to authenticated;
grant all on public.calendar_settings to service_role;
drop policy if exists calendar_settings_own on public.calendar_settings;
create policy calendar_settings_own on public.calendar_settings
  for all to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());


-- 6. Reminders cron: also run when only invited people have reminders ------------------

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
  where exists (select 1 from public.my_calendar_events where reminders <> '{}')
     or exists (select 1 from public.calendar_event_people where reminders <> '{}' and response in ('pending', 'accepted'));
  $$
);


-- ============================================================================
-- Sanity checks -- run after the above:
--   select count(*) from public.calendar_event_people;                         -- 0 to start
--   select column_name from information_schema.columns
--     where table_name = 'my_calendar_events' and column_name in ('project_id', 'organizer_attends');   -- 2 rows
--   select * from public.calendar_settings;                                    -- your row after you open Settings
-- ============================================================================
