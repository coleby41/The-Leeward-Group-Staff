-- ============================================================================
-- supabase-project-archive-offload.sql
--
-- Archived projects → offload to a hard drive after 1 year (Nov 17, 2026).
--
--   1. projects.archived_at       set automatically when status becomes
--                                 'archived' (cleared if it's un-archived)
--      projects.offload_notified_at  when IT was told it's ready
--      projects.offloaded_at / offloaded_by_name  when someone downloaded the
--                                 archive zip and confirmed it's saved
--   2. Already-archived projects start counting from their last update
--      (updated_at) — the closest date on record.
--   3. notify_projects_ready_to_offload() — once per project, notifies every
--      active staff member in the IT workgroup when a project has been
--      archived for a year. Runs nightly with pg_cron.
--   4. projects_overview rebuilt so the new columns show through it.
--
-- Nothing is ever deleted: after the zip is saved the project is just
-- marked offloaded (Coleby: "keep it, mark offloaded").
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Columns
alter table public.projects
  add column if not exists archived_at timestamptz,
  add column if not exists offload_notified_at timestamptz,
  add column if not exists offloaded_at timestamptz,
  add column if not exists offloaded_by_name text;

-- 2. Backfill projects that are already archived
update public.projects
   set archived_at = coalesce(updated_at, created_at, now())
 where status = 'archived' and archived_at is null;

-- 1b. Keep archived_at in step with status
create or replace function public.projects_track_archived_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'archived' and (tg_op = 'INSERT' or old.status is distinct from 'archived') then
    new.archived_at := now();
    new.offload_notified_at := null;   -- a fresh archive starts a fresh year
  elsif new.status is distinct from 'archived' then
    new.archived_at := null;
    new.offload_notified_at := null;
  end if;
  return new;
end $$;

drop trigger if exists projects_track_archived_at on public.projects;
create trigger projects_track_archived_at
  before insert or update of status on public.projects
  for each row execute function public.projects_track_archived_at();

-- 3. Nightly: tell IT about projects archived 1+ year that haven't been offloaded
create or replace function public.notify_projects_ready_to_offload()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
  v_count integer := 0;
begin
  for p in
    select id, name, archived_at
      from public.projects
     where status = 'archived'
       and archived_at <= now() - interval '1 year'
       and offloaded_at is null
       and offload_notified_at is null
  loop
    insert into public.notifications (user_id, title, message, type, link_url, link_label)
    select su.id,
           'Project ready to offload',
           format('%s has been archived since %s. Download its archive zip and save it to the hard drive.',
                  p.name, to_char(p.archived_at, 'Mon DD, YYYY')),
           'project_ready_to_offload',
           '/pages/projects.html?id=' || p.id,
           'Open project'
      from public.staff_users su
     where su.active is not false
       and exists (select 1 from unnest(su.workgroup) g where lower(trim(g)) = 'it');

    update public.projects set offload_notified_at = now() where id = p.id;
    v_count := v_count + 1;
  end loop;
  return v_count;   -- projects flagged this run
end $$;

revoke all on function public.notify_projects_ready_to_offload() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.unschedule('notify-projects-ready-to-offload')
 where exists (select 1 from cron.job where jobname = 'notify-projects-ready-to-offload');
select cron.schedule(
  'notify-projects-ready-to-offload',
  '15 11 * * *',                           -- daily, 6:15 AM Eastern
  $$ select public.notify_projects_ready_to_offload(); $$
);

-- 4. projects_overview — pick up the new columns (`select *` is fixed when the view is made)
drop view if exists public.projects_overview cascade;
create view public.projects_overview
with (security_invoker = true)
as
select * from public.projects;
grant select on public.projects_overview to authenticated;

-- ============================================================================
-- Sanity checks:
--   select name, status, archived_at from public.projects where status = 'archived';
--   select public.notify_projects_ready_to_offload();   -- run once by hand; returns how many were flagged
--   select jobname, schedule from cron.job where jobname = 'notify-projects-ready-to-offload';
-- ============================================================================
