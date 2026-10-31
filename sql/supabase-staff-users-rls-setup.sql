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
-- staff_users — RLS + hiding password_hash from general reads.
--
-- IMPORTANT CONTEXT (read this before running):
-- This app does not use Supabase Auth. Sign-in queries staff_users directly
-- with the anon key and there's no auth.uid() to check — so RLS here can't
-- verify "this request is really from an IT admin", it can only restrict the
-- *shape* of what anon is allowed to do. Given that, this migration does two
-- things:
--   1. Baseline lockdown: turns RLS on (it likely wasn't before) with
--      policies that allow anon to do exactly what the app already does
--      today — insert new staff (admin-users.html), update staff (the
--      Staff Users admin page), but NOT select the raw table directly.
--   2. Hides password_hash from reads: instead of anon being able to
--      select(*) the whole table (which includes password_hash — that's how
--      login worked before), reads now go through either:
--        - a SECURITY DEFINER RPC (verify_staff_login) for the actual
--          sign-in check, which never returns password_hash, or
--        - a view (staff_users_directory) for everywhere else that reads
--          staff_users (the Staff Users admin page, Manage Employees'
--          direct-reports lookup, Payroll Tools' staff directory, and the
--          payroll PDF generator), which simply omits the password_hash
--          column.
--      Both are set up below. supabase-auth.js's login function, plus every
--      page/script that used to `.from('staff_users').select(...)`, were
--      updated to use these instead of reading the base table directly —
--      see staff-users.js, payroll-tools.js, manage-employees.js, and
--      payroll-pdf-stub.js.
--
-- Run this whole file once in the Supabase SQL editor. Nothing here changes
-- what the app does today from a user's perspective — same login flow, same
-- admin pages — it only closes off the raw table from being queried directly
-- with the anon key (e.g. via curl) for anything beyond insert/update.
-- ============================================================================

alter table public.staff_users enable row level security;

-- Anon can create new staff accounts (admin-users.html → createSupabaseUser)
-- and edit existing ones (staff-users.html's Staff Users admin page).
-- Note these aren't actually restricted to IT/Super Admin at the database
-- level — that check only happens in the app's JS today. Doing it for real
-- would require knowing who's asking, which this auth model can't do. If you
-- want that enforced server-side later, it needs a real identity on the
-- request (e.g. a Postgres function that takes a session token you issue at
-- login and validates it), not just RLS.
drop policy if exists "staff_users_insert_anon" on public.staff_users;
create policy "staff_users_insert_anon"
  on public.staff_users
  for insert
  to anon
  with check (true);

drop policy if exists "staff_users_update_anon" on public.staff_users;
create policy "staff_users_update_anon"
  on public.staff_users
  for update
  to anon
  using (true)
  with check (true);

-- Deliberately no SELECT policy for anon on the base table — this is what
-- keeps password_hash from being readable via a plain
-- `.from('staff_users').select(...)` anymore. Reads happen through
-- verify_staff_login() (login) or staff_users_directory (admin listing)
-- below instead, both of which never expose password_hash.


-- ============================================================================
-- Login, without exposing password_hash to the client.
--
-- Mirrors the exact match logic that used to run client-side in
-- supabase-auth.js: match against the SHA-256 hash the client already
-- computes, OR (legacy fallback that was already there) a stored value that
-- happens to just be the plaintext password. SECURITY DEFINER means this
-- runs with the function owner's privileges, so it can read password_hash
-- internally even though anon can't select it directly anymore.
-- ============================================================================
create or replace function public.verify_staff_login(
  p_username text,
  p_entered_hash text,
  p_raw_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_users;
  v_stored_hash text;
  v_matches boolean;
begin
  select * into v_row from public.staff_users where username = p_username limit 1;
  if not found then
    return null;
  end if;

  v_stored_hash := lower(trim(coalesce(v_row.password_hash, '')));
  v_matches := (
    v_stored_hash = lower(trim(coalesce(p_entered_hash, '')))
    or v_stored_hash = lower(coalesce(p_raw_password, ''))
    or v_stored_hash = coalesce(p_raw_password, '')
  );

  if not v_matches then
    return null;
  end if;

  -- Strip password_hash before handing the row back to the client.
  return to_jsonb(v_row) - 'password_hash';
end;
$$;

revoke all on function public.verify_staff_login(text, text, text) from public;
grant execute on function public.verify_staff_login(text, text, text) to anon;


-- ============================================================================
-- Staff directory view for the admin "Staff Users" page (staff-users.js),
-- same columns that page already reads/displays, minus password_hash.
--
-- If your staff_users table has more columns than this (check with
-- `\d staff_users` in the SQL editor), add them here — anything not listed
-- just won't show up in the admin directory, it won't break anything.
-- ============================================================================
create or replace view public.staff_users_directory as
select
  id,
  username,
  full_name,
  workgroup,
  role,
  manager_id,
  employee_code,
  account_notes,
  active,
  created_at
from public.staff_users;

grant select on public.staff_users_directory to anon;


-- ============================================================================
-- FOLLOW-UP FIX (added after staff-users.html updates went silently to 0
-- rows even though staff_users_update_anon above is fully permissive):
--
-- Postgres needs SELECT-level visibility on a row to identify it as a target
-- for UPDATE/DELETE — this is separate from, and in addition to, the
-- UPDATE policy's own using()/with check(). With RLS on and *no* SELECT
-- policy at all (which is what "deliberately no SELECT policy" above set
-- up), every row is invisible for this purpose, so any UPDATE's WHERE
-- clause matches nothing: no error, just 0 rows affected. That's the actual
-- cause of staff info not saving.
--
-- Fix: add the SELECT policy back so rows are visible, but keep
-- password_hash hidden via column-level grants instead of via RLS. anon can
-- only actually read the listed columns off the base table directly; a bare
-- `select=*` or a request for password_hash specifically will fail with a
-- column permission error. The admin directory continues reading through
-- staff_users_directory (unaffected, granted above) — this just gives RLS
-- something non-sensitive to check for write targeting.
-- ============================================================================
drop policy if exists "staff_users_select_anon" on public.staff_users;
create policy "staff_users_select_anon"
  on public.staff_users
  for select
  to anon
  using (true);

revoke select on public.staff_users from anon;
grant select (
  id, username, full_name, workgroup, role, manager_id,
  employee_code, account_notes, active, created_at
) on public.staff_users to anon;
