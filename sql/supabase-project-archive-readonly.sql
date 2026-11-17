-- ============================================================================
-- Archived projects are read only (2026-11-17)
--
-- Coleby: "if a project is on archive then you can't edit anything, and just
-- read it ... the project manager will have to open it."
--
--   1. project_can_reopen(project) — the project's manager (project_members
--      role project_manager / project_admin, same rule as draws) or a
--      Super Admin.
--   2. block_archived_project_writes() — a trigger on every table that holds
--      a project_id (plus draw_lines and bid_invites, which hang off draws
--      and bid packages). Any insert / update / delete from the portal on an
--      archived project is refused.
--   3. projects_guard_archived() — on the projects row itself: while
--      archived, only the offload fields can change (Save to hard drive),
--      and only project_can_reopen() can change the status (reopen).
--
-- Not blocked:
--   - The SQL editor, cron jobs and Edge Functions using the service key
--     (no portal login). The Siri function checks for itself.
--   - Deleting the whole project (its rows go with it).
--   - Log / activity / notification tables.
--
-- Safe to re-run. Tables added later need this file run again to be covered.
-- Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Who can reopen -----------------------------------------------------------
create or replace function public.project_can_reopen(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or exists (
    select 1 from public.project_members m
     where m.project_id = p_project_id
       and m.user_id = auth.uid()
       and m.role in ('project_manager', 'project_admin')
  );
$$;
revoke all on function public.project_can_reopen(uuid) from public, anon;
grant execute on function public.project_can_reopen(uuid) to authenticated;

create or replace function public.project_is_archived(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.projects where id = p_project_id and status = 'archived');
$$;


-- 2. Child tables -------------------------------------------------------------
create or replace function public.block_archived_project_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  pid uuid;
begin
  -- Only portal users are locked out (checked by their login, so it still
  -- applies inside security-definer functions like lock_project_plan).
  if coalesce(auth.role(), '') <> 'authenticated' then
    return coalesce(new, old);
  end if;
  -- A delete that cascades from deleting the whole project (or a parent
  -- row) runs inside another trigger — let it through.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  if tg_argv[0] = 'draw' then
    select project_id into pid from public.draws where id = (r ->> 'draw_id')::uuid;
  elsif tg_argv[0] = 'package' then
    select project_id into pid from public.bid_packages where id = (r ->> 'package_id')::uuid;
  else
    pid := (r ->> 'project_id')::uuid;
  end if;

  -- Moving a row OUT of an archived project counts too.
  if pid is not null and public.project_is_archived(pid) then
    raise exception 'This project is archived and is read only. The project manager needs to reopen it before anything can be changed.'
      using errcode = 'P0001', hint = 'PROJECT_ARCHIVED';
  end if;
  if tg_op = 'UPDATE' and tg_argv[0] is null and (to_jsonb(old) ->> 'project_id') is distinct from (r ->> 'project_id')
     and public.project_is_archived((to_jsonb(old) ->> 'project_id')::uuid) then
    raise exception 'This project is archived and is read only. The project manager needs to reopen it before anything can be changed.'
      using errcode = 'P0001', hint = 'PROJECT_ARCHIVED';
  end if;

  return coalesce(new, old);
end $$;

do $$
declare
  t record;
begin
  -- Every base table in public with a uuid project_id column.
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped
     where n.nspname = 'public'
       and c.relkind = 'r'
       and a.atttypid = 'uuid'::regtype
       and c.relname <> 'projects'
       and c.relname !~* '(log|activity|audit|notification|_reads?$)'
  loop
    execute format('drop trigger if exists zz_archived_readonly on public.%I', t.relname);
    execute format('create trigger zz_archived_readonly before insert or update or delete on public.%I
                      for each row execute function public.block_archived_project_writes()', t.relname);
    raise notice 'Locked when archived: %', t.relname;
  end loop;

  if to_regclass('public.draw_lines') is not null then
    drop trigger if exists zz_archived_readonly on public.draw_lines;
    create trigger zz_archived_readonly before insert or update or delete on public.draw_lines
      for each row execute function public.block_archived_project_writes('draw');
  end if;
  if to_regclass('public.bid_invites') is not null then
    drop trigger if exists zz_archived_readonly on public.bid_invites;
    create trigger zz_archived_readonly before insert or update or delete on public.bid_invites
      for each row execute function public.block_archived_project_writes('package');
  end if;
end $$;


-- 3. The project row itself ---------------------------------------------------
create or replace function public.projects_guard_archived()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  free text[] := array['offloaded_at', 'offloaded_by_name', 'offload_notified_at',
                       'updated_at', 'updated_by_id', 'updated_by_name'];
begin
  if coalesce(auth.role(), '') <> 'authenticated' or old.status is distinct from 'archived' then
    return new;
  end if;

  if new.status is distinct from 'archived' then
    if not public.project_can_reopen(old.id) then
      raise exception 'Only the project manager can reopen an archived project.'
        using errcode = 'P0001', hint = 'PROJECT_ARCHIVED';
    end if;
    return new;   -- reopening: any other changes in the same save are fine
  end if;

  if (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
    raise exception 'This project is archived and is read only. The project manager needs to reopen it before anything can be changed.'
      using errcode = 'P0001', hint = 'PROJECT_ARCHIVED';
  end if;
  return new;
end $$;

drop trigger if exists zz_projects_guard_archived on public.projects;
create trigger zz_projects_guard_archived
  before update on public.projects
  for each row execute function public.projects_guard_archived();
