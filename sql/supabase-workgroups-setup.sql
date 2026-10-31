-- ############################################################################
-- !! WARNING (added 2026-10-31 audit) !!
-- This script predates the Supabase Auth migration and creates OPEN
-- "to anon" policies/grants. supabase-rls-lockdown.sql replaced them.
--   * Existing database: DO NOT re-run this file. It re-opens these tables
--     to anyone holding the public anon key.
--   * Fresh database: fine to run for the tables it creates, but run
--     supabase-rls-lockdown.sql afterward to close the anon access again.
-- ############################################################################

-- ============================================================================
-- Workgroups + nav access — powers the new "Workgroups" tab under IT Tools
-- (workgroups.html / workgroups.js) and the shared nav-access.js that every
-- page now loads.
--
-- Same conventions as the rest of this app: no Supabase Auth, so RLS is
-- permissive-to-anon with access control enforced client-side.
--
-- IMPORTANT: nav-access.js is written to "fail open" if these tables don't
-- exist yet — it does nothing and leaves every page's existing hardcoded
-- checks in charge, exactly like before. Nothing changes for anyone until
-- this file has been run. Once it has, nav-access.js takes over as the
-- authoritative source for who sees what.
--
-- The seed data below is deliberately built to match today's REAL behavior
-- exactly (see the notes inline), so running this migration doesn't
-- silently change anyone's access — it just makes the existing rules
-- editable from the Workgroups tab going forward.
-- ============================================================================

create table if not exists public.workgroups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.workgroups enable row level security;

drop policy if exists "workgroups_all_anon" on public.workgroups;
create policy "workgroups_all_anon"
  on public.workgroups
  for all
  to anon
  using (true)
  with check (true);


-- One row per (workgroup, nav tab) that workgroup can see. Absence of a row
-- means no access. "Super Admin" is a hardcoded bypass in nav-access.js (it
-- always sees everything) so it doesn't strictly need rows here, but a few
-- are seeded anyway for the Workgroups page's grid to display accurately.
create table if not exists public.workgroup_nav_access (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  -- One of: dashboard, new_project, excel_workbook, form_templates,
  -- personal_finance, vendor_contacts, payroll_tools, manage_employees,
  -- create_account, staff_users, workgroups
  nav_key text not null,
  unique (workgroup_id, nav_key)
);

create index if not exists workgroup_nav_access_workgroup_id_idx on public.workgroup_nav_access (workgroup_id);

alter table public.workgroup_nav_access enable row level security;

drop policy if exists "workgroup_nav_access_all_anon" on public.workgroup_nav_access;
create policy "workgroup_nav_access_all_anon"
  on public.workgroup_nav_access
  for all
  to anon
  using (true)
  with check (true);


-- ============================================================================
-- Seed workgroups. "Owner" and "Field" come from admin-users.html's existing
-- create-account dropdown; "IT", "Office", "Accounting" are used throughout
-- the app's existing hardcoded checks; "Super Admin" is the bypass-all group
-- used in most of those same checks (note: it was never actually selectable
-- in the create-account dropdown before now — Coleby, worth deciding whether
-- "Owner" was meant to BE this group, since right now they're two separate,
-- unrelated names in the data); "Operations" is the fallback group name used
-- when creating a user without picking one.
-- ============================================================================
insert into public.workgroups (name) values
  ('Owner'),
  ('Field'),
  ('IT'),
  ('Office'),
  ('Accounting'),
  ('Super Admin'),
  ('Operations')
on conflict (name) do nothing;


-- ============================================================================
-- Seed access to match today's real behavior:
--   - Dashboard, New Project Onboarding, Excel Workbook Templates, Form
--     Templates, Staff Finance, Vendor Contacts: every workgroup today
--     (no gating exists anywhere for these).
--   - Payroll Tools: Office + Accounting (Super Admin already bypasses).
--     Note: payroll-tools.html's OWN internal check was actually stricter
--     (Accounting + Super Admin only, Office was missing) — that looks like
--     a pre-existing inconsistency between pages, not something intentional.
--     This seed uses the more common Office+Accounting+Super Admin version.
--   - Manage Employees: nobody via workgroup — today it's purely "is this
--     person's role = Manager, or are they Super Admin", which nav-access.js
--     keeps doing in addition to whatever's configured here.
--   - Create account / Staff users / Workgroups (IT Tools): IT only
--     (Super Admin already bypasses).
-- ============================================================================
do $$
declare
  wg record;
begin
  for wg in select id from public.workgroups loop
    insert into public.workgroup_nav_access (workgroup_id, nav_key)
    values
      (wg.id, 'dashboard'),
      (wg.id, 'new_project'),
      (wg.id, 'excel_workbook'),
      (wg.id, 'form_templates'),
      (wg.id, 'personal_finance'),
      (wg.id, 'vendor_contacts'),
      -- 2026-08-31: added so every workgroup can see the Projects sidebar
      -- link / project-home.html out of the box — this key was missing from
      -- the original seed list entirely, which silently hid Projects from
      -- every workgroup until someone granted it by hand from the
      -- Workgroups tab. See supabase-open-project-access-to-all-staff.sql
      -- for the fix applied to an already-running database.
      (wg.id, 'project_overview')
    on conflict (workgroup_id, nav_key) do nothing;
  end loop;

  insert into public.workgroup_nav_access (workgroup_id, nav_key)
  select id, 'payroll_tools' from public.workgroups where name in ('Office', 'Accounting')
  on conflict (workgroup_id, nav_key) do nothing;

  insert into public.workgroup_nav_access (workgroup_id, nav_key)
  select w.id, t.k
  from public.workgroups w
  cross join (values ('create_account'), ('staff_users'), ('workgroups')) as t(k)
  where w.name = 'IT'
  on conflict (workgroup_id, nav_key) do nothing;
end $$;
