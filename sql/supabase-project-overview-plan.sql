-- ============================================================================
-- supabase-project-overview-plan.sql
--
-- Project Overview redesign (Nov 16, 2026) — step 1.
--
-- WHAT THIS ADDS
--   1. schedule_tasks.plan_start_date / plan_end_date
--        The ORIGINAL plan for each task. Set by the "Lock plan" /
--        "Update plan" button on the Project Timeline page. Pushing a task
--        (by hand or with Siri) changes start_date/end_date but NOT these,
--        so the Overview can say "3 days behind" against the original plan.
--   2. projects.plan_locked_at / plan_locked_by_name
--        When the plan was locked (or last updated) and by whom. Null = the
--        plan has never been locked, so the Overview shows a "Lock the plan"
--        hint instead of a days-behind number.
--   3. projects.start_date
--        Filled in once on the onboarding wizard.
--   4. projects_overview view rebuilt as `select *` so every projects column
--        (including project_code and the new ones above) is readable through
--        the view the pages already use. The view stopped masking anything in
--        supabase-open-project-financials-to-all-staff.sql, so an explicit
--        column list no longer buys anything — and it kept falling behind
--        whenever a column was added to projects.
--
--   5. lock_project_plan() — used by the Timeline page's button.
--   6. One-time copy of the old onboarding answers into Accounts / Contacts
--        (contacts + utility accounts) and Project Files, since the trimmed
--        wizard no longer asks for them.
--
-- Nothing is dropped from projects. progress_percent, due_date,
-- spent_to_date, committed_amount etc. stay in the table; the pages just stop
-- showing or editing them.
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Plan dates on timeline tasks
-- ----------------------------------------------------------------------------
alter table public.schedule_tasks
  add column if not exists plan_start_date date,
  add column if not exists plan_end_date date;

comment on column public.schedule_tasks.plan_start_date is
  'Original planned start. Copied from start_date by Lock/Update plan on the Timeline page.';
comment on column public.schedule_tasks.plan_end_date is
  'Original planned end. Copied from end_date by Lock/Update plan. Overview "days behind" = latest end_date - latest plan_end_date.';


-- ----------------------------------------------------------------------------
-- 2 + 3. Plan lock info + start date on projects
-- ----------------------------------------------------------------------------
alter table public.projects
  add column if not exists plan_locked_at timestamptz,
  add column if not exists plan_locked_by_name text,
  add column if not exists start_date date;


-- ----------------------------------------------------------------------------
-- 4. projects_overview — every column of projects, no masking.
--    drop + create (not create or replace) because the column list changes.
-- ----------------------------------------------------------------------------
drop view if exists public.projects_overview cascade;
create view public.projects_overview
with (security_invoker = true)
as
select * from public.projects;

grant select on public.projects_overview to authenticated;


-- ----------------------------------------------------------------------------
-- 5. Lock the plan for one project in one statement (used by the Timeline
--    page's Lock plan / Update plan button). Copies every task's current
--    dates into its plan dates and stamps the project. Runs as the caller
--    (security invoker), so the existing schedule_tasks / projects RLS
--    still decides who can do it.
-- ----------------------------------------------------------------------------
create or replace function public.lock_project_plan(p_project_id uuid, p_by_name text)
returns integer
language plpgsql
security invoker
as $$
declare
  v_count integer;
begin
  update public.schedule_tasks
     set plan_start_date = start_date,
         plan_end_date   = end_date
   where project_id = p_project_id;
  get diagnostics v_count = row_count;

  update public.projects
     set plan_locked_at      = now(),
         plan_locked_by_name = p_by_name
   where id = p_project_id;

  return v_count;   -- number of tasks whose plan dates were set
end $$;

grant execute on function public.lock_project_plan(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 6. One-time copy of what was typed into the OLD onboarding steps, so
--    nothing disappears now that the wizard only asks for name, code,
--    address, cover photo, original contract, start date and permit #.
--    Each insert skips anything already there, so re-running is safe.
-- ----------------------------------------------------------------------------

-- 6a. Owner / GC / point of contact / county office → Accounts / Contacts
insert into public.project_contacts (project_id, contact_type, full_name, title, company_name, phone, email, notes, created_by_name)
select p.id, c.contact_type, c.full_name, c.title, c.company_name, c.phone, c.email, c.notes, 'Onboarding (copied)'
from public.projects p
cross join lateral (values
  ('property_owner',     nullif(trim(p.owner_name), ''), null::text, null::text, p.owner_phone, p.owner_email, nullif(trim(p.owner_address), '')),
  ('general_contractor', nullif(trim(p.gc_name), ''),    null, nullif(trim(p.gc_name), ''), p.gc_phone, p.gc_email, null),
  ('point_of_contact',   nullif(trim(p.poc_name), ''),   nullif(trim(p.poc_role), ''), null, p.poc_phone, p.poc_email, null),
  ('county_city_office', coalesce(nullif(trim(p.county_city_contact_name), ''), nullif(trim(p.county_city_office_name), '')),
                         null, nullif(trim(p.county_city_office_name), ''), p.county_city_phone, p.county_city_email, null)
) as c(contact_type, full_name, title, company_name, phone, email, notes)
where c.full_name is not null
  and not exists (
    select 1 from public.project_contacts x
     where x.project_id = p.id and x.contact_type = c.contact_type and lower(x.full_name) = lower(c.full_name)
  );

-- 6b. Electric / water / trash / porta potty → Accounts / Contacts › utility accounts
insert into public.project_utility_accounts (project_id, utility_type, provider_name, account_number, notes, created_by_name)
select p.id, u.utility_type, u.provider_name, u.account_number, u.notes, 'Onboarding (copied)'
from public.projects p
cross join lateral (values
  ('electric', nullif(trim(p.electric_provider), ''),  nullif(trim(p.electric_account_number), ''),    null::text),
  ('water',    nullif(trim(p.water_provider), ''),     nullif(trim(p.water_account_number), ''),       null),
  ('trash',    nullif(trim(p.trash_vendor), ''),       nullif(trim(p.trash_account_number), ''),       nullif(trim(p.temp_services_notes), '')),
  ('other',    nullif(trim(p.porta_potty_vendor), ''), nullif(trim(p.porta_potty_account_number), ''), 'Porta potties')
) as u(utility_type, provider_name, account_number, notes)
where u.provider_name is not null
  and not exists (
    select 1 from public.project_utility_accounts x
     where x.project_id = p.id and x.utility_type = u.utility_type and lower(x.provider_name) = lower(u.provider_name)
  );

-- 6c. Site plan / permit plan files → Project Files
--     (Design & Engineering › Civil, Permits & Inspections › Building Permits)
insert into public.project_files (project_id, category, subfolder, bucket, storage_path, file_name, source, uploaded_by_name)
select p.id, f.category, f.subfolder, 'project-documents', f.path,
       regexp_replace(split_part(f.path, '/', array_length(string_to_array(f.path, '/'), 1)), '^[0-9]+-', ''),
       'upload', 'Onboarding (copied)'
from public.projects p
cross join lateral (values
  ('design_engineering',  'civil',            nullif(trim(p.site_plans_file_path), '')),
  ('permits_inspections', 'building_permits', nullif(trim(p.permit_plans_file_path), ''))
) as f(category, subfolder, path)
where f.path is not null
  and not exists (select 1 from public.project_files x where x.project_id = p.id and x.storage_path = f.path);


-- ============================================================================
-- Sanity checks (run after):
--   select column_name from information_schema.columns
--    where table_name = 'schedule_tasks' and column_name like 'plan_%';      -- 2 rows
--   select project_code, start_date, plan_locked_at from public.projects_overview limit 5;
--   select contact_type, full_name from public.project_contacts where created_by_name = 'Onboarding (copied)';
--   select utility_type, provider_name from public.project_utility_accounts where created_by_name = 'Onboarding (copied)';
--   select category, subfolder, file_name from public.project_files where uploaded_by_name = 'Onboarding (copied)';
--   select count(*) filter (where plan_end_date is not null) as locked_tasks,
--          count(*) as all_tasks
--     from public.schedule_tasks;                                             -- 0 locked until someone clicks Lock plan
-- ============================================================================
