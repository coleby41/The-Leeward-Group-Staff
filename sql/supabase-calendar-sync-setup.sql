-- ============================================================================
-- Calendar connections for Home › Today (2026-11-18)
--
-- Each staff member can link ONE calendar: Outlook / Microsoft 365 or Google
-- (sign-in), or Apple iCloud (Apple ID + app-specific password). The Edge
-- Function supabase/functions/calendar does the sign-in, keeps the tokens
-- (encrypted) and copies the next few months of events into
-- calendar_events_cache, which Home reads.
--
--   calendar_providers          the three choices on "Link calendar"
--   calendar_accounts           one row per person — tokens live here; no one
--                               but the Edge Function can read this table
--   calendar_connections_status what the browser sees (no tokens): your own
--                               connection's status, account email, last sync
--   calendar_events_cache       your synced events (read-only to you)
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Providers ---------------------------------------------------------------
create table if not exists public.calendar_providers (
  id text primary key,
  label text not null,
  auth_type text not null check (auth_type in ('oauth2', 'caldav')),
  is_active boolean not null default true,
  sort_order integer not null default 0
);
alter table public.calendar_providers add column if not exists is_active boolean not null default true;
alter table public.calendar_providers add column if not exists sort_order integer not null default 0;
-- An older version of this table also has a required icon_class column.
alter table public.calendar_providers add column if not exists icon_class text;

insert into public.calendar_providers (id, label, auth_type, icon_class, is_active, sort_order) values
  ('microsoft', 'Outlook / Microsoft 365', 'oauth2', 'microsoft', true, 1),
  ('google',    'Google Calendar',         'oauth2', 'google',    true, 2),
  ('icloud',    'Apple iCloud Calendar',   'caldav', 'icloud',    true, 3)
on conflict (id) do update set label = excluded.label, auth_type = excluded.auth_type,
  icon_class = excluded.icon_class, is_active = true, sort_order = excluded.sort_order;

-- Older choices with other ids (from the first, unfinished version) would
-- show up in "Link calendar" but the calendar function doesn't know them.
update public.calendar_providers set is_active = false where id not in ('microsoft', 'google', 'icloud');

alter table public.calendar_providers enable row level security;
drop policy if exists calendar_providers_read on public.calendar_providers;
create policy calendar_providers_read on public.calendar_providers for select to authenticated using (true);
grant select on public.calendar_providers to authenticated;

-- 2. Accounts (tokens) — Edge Function only ------------------------------------
create table if not exists public.calendar_accounts (
  user_id uuid primary key references public.staff_users(id) on delete cascade,
  provider_id text not null references public.calendar_providers(id),
  status text not null default 'connected' check (status in ('connected', 'error')),
  external_account_email text,
  secret_enc text,              -- encrypted JSON: OAuth tokens, or the iCloud app password
  token_expires_at timestamptz,
  caldav_calendars jsonb,       -- iCloud: the calendar URLs found at connect time
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.calendar_accounts enable row level security;
revoke all on public.calendar_accounts from anon, authenticated;
-- (no policies: only the service role — the Edge Function — can touch it)

-- 3. What the browser sees -------------------------------------------------------
drop view if exists public.calendar_connections_status cascade;
create view public.calendar_connections_status as
  select a.user_id, a.provider_id, p.label as provider_label, a.status,
         a.external_account_email, a.last_synced_at, a.last_error, a.created_at
    from public.calendar_accounts a
    join public.calendar_providers p on p.id = a.provider_id
   where a.user_id = public.current_staff_id();
grant select on public.calendar_connections_status to authenticated;

-- 4. Event cache -------------------------------------------------------------------
-- Only ever a copy of people's calendars (refilled on every sync), and the
-- first unfinished version never filled it — so it's rebuilt here to make
-- sure no leftover required columns from that version block syncing.
-- Comment this line out after the first run if you'd rather keep it.
drop table if exists public.calendar_events_cache cascade;
create table if not exists public.calendar_events_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_users(id) on delete cascade,
  title text,
  start_time timestamptz not null,
  end_time timestamptz,
  location text
);
alter table public.calendar_events_cache add column if not exists provider_id text;
alter table public.calendar_events_cache add column if not exists external_id text;
alter table public.calendar_events_cache add column if not exists all_day boolean not null default false;
create index if not exists calendar_events_cache_user_start_idx on public.calendar_events_cache (user_id, start_time);

alter table public.calendar_events_cache enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'calendar_events_cache' loop
    execute format('drop policy %I on public.calendar_events_cache', pol.policyname);
  end loop;
end $$;
create policy calendar_events_cache_own on public.calendar_events_cache
  for select to authenticated using (user_id = public.current_staff_id());
revoke insert, update, delete on public.calendar_events_cache from anon, authenticated;
grant select on public.calendar_events_cache to authenticated;
