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
-- Employee Timesheet Management System
--
-- Adds the role/manager fields on staff_users, plus five new tables:
--   payroll_employees   — roster of staff opted into payroll (Add Employee)
--   timesheets           — one row per payroll_employee per pay_period
--   timesheet_entries     — daily clock in/out + regular/overtime hours within a timesheet
--   timesheet_events       — append-only audit trail: submit/approve/reject/
--                            comment/send-to-accounting/process/complete.
--                            Covers both "Timesheet Approvals" and "Approval
--                            Comments" from the original spec in one table,
--                            since every one of those is just "something
--                            happened to this timesheet, by someone, maybe
--                            with a note" — no need for two tables.
--   pdf_history           — hook point for the Excel/PDF workflow. No real
--                            generation logic yet (workbook not provided) —
--                            this just gives the app somewhere to record
--                            "initial" and "final" PDFs once that's wired up.
--
-- Status enum (7 values — "Submitted" and "Waiting for Manager Approval"
-- from the original spec are the same moment, so they're one status here):
--   Not Started -> In Progress -> Submitted -> (Needs Corrections <-> Submitted)
--   -> Sent to Accounting -> Processed -> Complete
--
-- "Sent to Accounting" doubles as "Approved by Manager" — the spec says
-- approval should automatically land in the Accounting dashboard, so there's
-- no separate lingering "approved but not yet sent" state. The approval fact
-- itself is captured in approved_by/approved_at, and in a timesheet_events
-- row with event_type = 'approved'.
--
-- Rejections reopen the timesheet for the employee: status goes to
-- 'Needs Corrections', their existing entries stay intact, they edit and
-- resubmit (status back to 'Submitted'), and the manager's comment is
-- stored as a timesheet_events row so it's visible on their Personal
-- Finance page.
--
-- Custom auth model note (see memory / supabase-auth.js): this portal does
-- NOT use Supabase Auth, so auth.uid() is always null. Matching every other
-- table in this app, RLS below is open to the anon role and access control
-- (employees only touching their own timesheet, managers only seeing direct
-- reports, Accounting-only pages) is enforced in the app/UI layer, not by
-- Postgres. Hourly rate and hours data therefore have the same trust model
-- as everything else in this app (e.g. vendor SSN/FID) — flagging this since
-- payroll data is more sensitive than most of what's here today.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- staff_users: role + manager + optional employee code
-- ---------------------------------------------------------------------------

alter table public.staff_users
  add column if not exists role text not null default 'Employee';

alter table public.staff_users
  drop constraint if exists staff_users_role_check;
alter table public.staff_users
  add constraint staff_users_role_check check (role in ('Employee', 'Manager'));

alter table public.staff_users
  add column if not exists manager_id uuid references public.staff_users(id);

alter table public.staff_users
  add column if not exists employee_code text;

create index if not exists staff_users_manager_id_idx on public.staff_users (manager_id);

-- ---------------------------------------------------------------------------
-- payroll_employees — roster of staff opted into the payroll/timesheet system
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_employees (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null unique references public.staff_users(id) on delete cascade,
  department text,
  hourly_rate numeric(10, 2),
  employment_type text not null default 'Full-time'
    check (employment_type in ('Full-time', 'Part-time', 'Contractor')),
  overtime_exempt boolean not null default false,
  active boolean not null default true,
  date_added date not null default current_date,
  notes text,
  created_by uuid references public.staff_users(id),
  created_at timestamptz not null default now()
);

create index if not exists payroll_employees_staff_id_idx on public.payroll_employees (staff_id);
create index if not exists payroll_employees_active_idx on public.payroll_employees (active);

-- ---------------------------------------------------------------------------
-- timesheets — one per payroll_employee per pay_period
-- ---------------------------------------------------------------------------

create table if not exists public.timesheets (
  id uuid primary key default gen_random_uuid(),
  payroll_employee_id uuid not null references public.payroll_employees(id) on delete cascade,
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  status text not null default 'Not Started'
    check (status in (
      'Not Started', 'In Progress', 'Submitted', 'Needs Corrections',
      'Sent to Accounting', 'Processed', 'Complete'
    )),
  submitted_at timestamptz,
  approved_by uuid references public.staff_users(id),
  approved_at timestamptz,
  processed_by uuid references public.staff_users(id),
  processed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payroll_employee_id, pay_period_id)
);

create index if not exists timesheets_payroll_employee_id_idx on public.timesheets (payroll_employee_id);
create index if not exists timesheets_pay_period_id_idx on public.timesheets (pay_period_id);
create index if not exists timesheets_status_idx on public.timesheets (status);

-- ---------------------------------------------------------------------------
-- timesheet_entries — daily clock in/out + regular/overtime hours
-- (if you already ran an earlier version of this file with a pto_hours
-- column, run supabase-timesheet-clockinout-setup.sql instead to migrate it)
-- ---------------------------------------------------------------------------

create table if not exists public.timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  work_date date not null,
  clock_in time,
  clock_out time,
  regular_hours numeric(5, 2) not null default 0,
  overtime_hours numeric(5, 2) not null default 0,
  notes text,
  unique (timesheet_id, work_date)
);

create index if not exists timesheet_entries_timesheet_id_idx on public.timesheet_entries (timesheet_id);

-- ---------------------------------------------------------------------------
-- timesheet_events — audit trail: submissions, approvals, rejections,
-- comments, and the Accounting-side status changes, all in one feed
-- ---------------------------------------------------------------------------

create table if not exists public.timesheet_events (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  event_type text not null check (event_type in (
    'submitted', 'approved', 'rejected', 'comment',
    'sent_to_accounting', 'processed', 'completed'
  )),
  actor_id uuid references public.staff_users(id),
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists timesheet_events_timesheet_id_idx on public.timesheet_events (timesheet_id);
create index if not exists timesheet_events_created_at_idx on public.timesheet_events (created_at);

-- ---------------------------------------------------------------------------
-- pdf_history — hook point for the future Excel workbook -> PDF pipeline.
-- No generation logic yet; this just gives it somewhere to record output
-- once the real workbook is provided.
-- ---------------------------------------------------------------------------

create table if not exists public.pdf_history (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  kind text not null check (kind in ('initial', 'final')),
  file_url text,
  generated_at timestamptz not null default now()
);

create index if not exists pdf_history_timesheet_id_idx on public.pdf_history (timesheet_id);

-- ---------------------------------------------------------------------------
-- RLS — open to anon, matching every other table in this app (see note above)
-- ---------------------------------------------------------------------------

alter table public.payroll_employees enable row level security;
alter table public.timesheets enable row level security;
alter table public.timesheet_entries enable row level security;
alter table public.timesheet_events enable row level security;
alter table public.pdf_history enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['payroll_employees', 'timesheets', 'timesheet_entries', 'timesheet_events', 'pdf_history']
  loop
    execute format('drop policy if exists "Allow anon select" on public.%I', t);
    execute format('create policy "Allow anon select" on public.%I for select to anon using (true)', t);

    execute format('drop policy if exists "Allow anon insert" on public.%I', t);
    execute format('create policy "Allow anon insert" on public.%I for insert to anon with check (true)', t);

    execute format('drop policy if exists "Allow anon update" on public.%I', t);
    execute format('create policy "Allow anon update" on public.%I for update to anon using (true)', t);

    execute format('drop policy if exists "Allow anon delete" on public.%I', t);
    execute format('create policy "Allow anon delete" on public.%I for delete to anon using (true)', t);
  end loop;
end $$;

-- If gen_random_uuid() errors when this file is run (pgcrypto not enabled on
-- this project), run this once first:
-- create extension if not exists pgcrypto;
