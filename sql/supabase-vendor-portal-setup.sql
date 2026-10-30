-- ============================================================================
-- supabase-vendor-portal-setup.sql
--
-- Everything the Vendor Portal and Bid Invites need, in one file:
--
--   A. Bid Invites (beta) — Vendors › More Actions › Generate A Invite Bid,
--      and each project's Bid Invites tab.
--   B. Vendor Portal — a separate site (its own Vercel project) where
--      vendors sign in with an emailed link, see their bid invites, submit
--      bids, and keep their company info, W-9 and COI current.
--   C. Staff side of the portal — Vendor Applications, the vendor page's
--      Contacts (who has a dashboard login), Friendly name, merging
--      duplicate contacts.
--
-- HOW VENDORS SIGN IN (important):
--   Vendors do NOT get a Supabase Auth account. Most of this database uses
--   "any signed-in user can read/write" policies (`to authenticated using
--   (true)`), which is fine while only staff can sign in -- but a vendor
--   with a normal Supabase session would be able to read every project,
--   every vendor's SSN/FID, and so on. So the Vendor Portal never talks to
--   the database directly. It only calls the vendor-auth / vendor-api /
--   vendor-apply Edge Functions, which use the service role and only ever
--   return that vendor's own company's rows. Their sign-in sessions live in
--   vendor_sessions below (hashed tokens), not in auth.users.
--   The tables in this file are readable by staff only.
--
-- PREREQUISITE: supabase-auth-rearchitecture-schema.sql and
-- supabase-permissions-system-setup.sql have already been run (they have).
--
-- Safe to re-run. Run in Supabase -> SQL Editor.
-- ============================================================================


-- 1. Helpers ----------------------------------------------------------------------

-- The same "can the signed-in person do X" check js/permissions.js does in
-- the browser, available to RLS. Super Admin always passes.
create or replace function public.has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin() or exists (
    select 1
    from public.staff_users su
    join public.workgroups w
      on lower(trim(w.name)) in (select lower(trim(g)) from unnest(su.workgroup) g)
    join public.workgroup_permissions wp
      on wp.workgroup_id = w.id and wp.permission_key = p_key
    where su.auth_user_id = auth.uid()
      and su.active is not false
  );
$$;

revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;

-- True for an active staff member. (Vendors never have an auth session, so
-- this is really "is this a real staff login" -- used on the new tables so
-- they don't inherit the open `using (true)` pattern.)
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_users su
    where su.auth_user_id = auth.uid() and su.active is not false
  );
$$;

revoke all on function public.is_active_staff() from public, anon;
grant execute on function public.is_active_staff() to authenticated;


-- 2. Permissions ------------------------------------------------------------------

do $$
declare
  next_sort int;
begin
  select coalesce(max(sort_order), 0) + 1 into next_sort from public.permissions;

  insert into public.permissions (key, category, page_label, label, description, governed_by, sort_order) values
    ('vendors.send_bid_invites', 'Vendors & Companies', 'Vendor Contacts', 'Send Bid Invites (Beta)',
     'Use More Actions › Generate A Invite Bid to invite approved vendors to bid', 'workgroup', next_sort),
    ('projects.manage_bid_invites', 'Projects', 'Project Overview', 'Manage Bid Invites (Beta)',
     'A project''s Bid Invites tab: see responses and bid amounts, log bids, send reminders, compare and award', 'workgroup', next_sort + 1),
    ('vendors.approve_applications', 'Vendors & Companies', 'Vendor Contacts', 'Approve Vendor Applications',
     'More Actions › Vendor Applications: approve or reject companies that applied on the Vendor Portal', 'workgroup', next_sort + 2)
  on conflict (key) do update set
    category = excluded.category, page_label = excluded.page_label,
    label = excluded.label, description = excluded.description, governed_by = excluded.governed_by;
end $$;

insert into public.workgroup_permissions (workgroup_id, permission_key)
select w.id, p.key
from public.workgroups w
cross join (values ('vendors.send_bid_invites'), ('projects.manage_bid_invites'), ('vendors.approve_applications')) as p(key)
where w.name in ('IT', 'Super Admin')
on conflict (workgroup_id, permission_key) do nothing;

-- Either bid permission can see bid invites.
create or replace function public.can_view_bid_invites()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('vendors.send_bid_invites')
      or public.has_permission('projects.manage_bid_invites');
$$;

revoke all on function public.can_view_bid_invites() from public, anon;
grant execute on function public.can_view_bid_invites() to authenticated;


-- 3. project_files: allow source = 'bid' -----------------------------------------
-- Plans/specs attached to an invite and the proposals vendors submit are
-- filed in 05 Contracts & Procurement › Bids.

do $$
declare
  allowed text;
begin
  select string_agg(quote_literal(v), ', ' order by v) into allowed
  from (
    select unnest(array['upload', 'form_submission', 'incident_report', 'back_charge', 'vpo', 'invoice', 'bid']) as v
    union
    select distinct source from public.project_files where source is not null
  ) s;

  alter table public.project_files drop constraint if exists project_files_source_check;
  execute format(
    'alter table public.project_files add constraint project_files_source_check check (source in (%s))',
    allowed
  );
end $$;


-- 4. Companies / Contacts: new columns ---------------------------------------------

-- "Friendly name": what Leeward calls the company day to day (44 Glass vs.
-- 44 Glass and Shower Door, Inc.). Shown on the vendor page; asked for on
-- the portal's application form.
alter table public."Companies" add column if not exists "FriendlyName" text;

-- A second email, kept when two duplicate contacts are merged.
alter table public."Contacts" add column if not exists "Email2" text;


-- 5. Bid invite tables -------------------------------------------------------------

create table if not exists public.bid_packages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,                        -- "Windows & Glazing"
  trade_tag_id uuid,                         -- vendor_tags.id used to pre-select vendors (kept loose)
  trade_tag_name text,
  scope text,
  location text,                             -- defaults to the project's site address
  due_at timestamptz not null,
  walkthrough_at timestamptz,
  walkthrough_location text,
  questions_due_at timestamptz,
  contact_name text not null,                -- the Leeward person vendors reply to
  contact_email text not null,
  contact_phone text,
  remind_no_response boolean not null default true,
  remind_before_due boolean not null default true,
  status text not null default 'open' check (status in ('open', 'awarded', 'closed')),
  app_url text,                              -- (unused by the portal flow; kept for old rows)
  awarded_invite_id uuid,
  awarded_at timestamptz,
  awarded_by_name text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bid_packages_project_id_idx on public.bid_packages (project_id);

-- Drafts (2026-10-29): Generate A Invite Bid › Save Draft saves the invite
-- with status 'draft' and the picked vendors in draft_vendors
-- ([{company_id, contact_id}]). Drafts have no bid_invites rows, so vendors,
-- reminders and the project's Bid Invites tab never see them. A draft may
-- not have its due date or contact yet, so those can be empty until it's
-- sent (the wizard requires them before sending).
alter table public.bid_packages add column if not exists draft_vendors jsonb;
alter table public.bid_packages alter column due_at drop not null;
alter table public.bid_packages alter column contact_name drop not null;
alter table public.bid_packages alter column contact_email drop not null;
alter table public.bid_packages drop constraint if exists bid_packages_status_check;
alter table public.bid_packages add constraint bid_packages_status_check
  check (status in ('draft', 'open', 'awarded', 'closed'));

create table if not exists public.bid_package_files (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.bid_packages(id) on delete cascade,
  project_file_id uuid not null references public.project_files(id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (package_id, project_file_id)
);

create index if not exists bid_package_files_package_id_idx on public.bid_package_files (package_id);

create table if not exists public.bid_invites (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.bid_packages(id) on delete cascade,
  company_id bigint references public."Companies"(id) on delete set null,
  company_name text not null,                -- name at the time it was sent
  contact_name text,
  contact_email text not null,
  -- The private link behind the email's "View Invite & Bid" button. It
  -- signs the vendor into the portal (vendor-auth Edge Function) and is
  -- good until 14 days after bids are due.
  token uuid not null unique default gen_random_uuid(),
  status text not null default 'pending',
  send_error text,
  sent_at timestamptz,
  viewed_at timestamptz,                     -- first opened in the portal
  responded_at timestamptz,
  decline_reason text,
  decline_note text,
  reminder_count int not null default 0,
  last_reminded_at timestamptz,
  due_reminder_sent_at timestamptz,
  bid_amount numeric(14, 2),
  bid_received_on date,
  bid_notes text,
  bid_source text,                           -- 'portal' (vendor submitted) or 'staff' (logged from an email)
  proposal_file_id uuid references public.project_files(id) on delete set null,
  submitted_by_vendor_user uuid,             -- vendor_users.id when submitted in the portal
  logged_by uuid references public.staff_users(id),
  logged_by_name text,
  logged_at timestamptz,
  result_emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (package_id, company_id)
);

-- Statuses (re-applied so re-running fixes an older version of the check):
--   pending -> sent -> viewed -> bidding / not_bidding -> bid_received
--   -> awarded / not_selected.  failed = the email didn't send.
alter table public.bid_invites add column if not exists viewed_at timestamptz;
alter table public.bid_invites add column if not exists bid_source text;
alter table public.bid_invites add column if not exists submitted_by_vendor_user uuid;
-- 2026-10-21: COI PDF is only asked for once a vendor is awarded the job.
alter table public.bid_invites add column if not exists coi_requested_at timestamptz;  -- last time Leeward asked for the COI PDF
alter table public.bid_invites add column if not exists coi_received_at timestamptz;   -- vendor uploaded it in the portal
alter table public.bid_invites add column if not exists coi_file_id uuid;            -- the project's COI PDF (project_files.id, filed in Contracts & Procurement › Vendors)
alter table public.bid_invites drop constraint if exists bid_invites_status_check;
alter table public.bid_invites add constraint bid_invites_status_check check (status in (
  'pending', 'failed', 'sent', 'viewed', 'bidding', 'not_bidding', 'bid_received', 'awarded', 'not_selected'
));

create index if not exists bid_invites_package_id_idx on public.bid_invites (package_id);
create index if not exists bid_invites_company_id_idx on public.bid_invites (company_id);
create index if not exists bid_invites_status_idx on public.bid_invites (status);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bid_packages_awarded_invite_id_fkey') then
    alter table public.bid_packages
      add constraint bid_packages_awarded_invite_id_fkey
      foreign key (awarded_invite_id) references public.bid_invites(id) on delete set null;
  end if;
end $$;


-- 6. Vendor Portal tables ------------------------------------------------------------

-- Companies that applied on the portal's "New Vendor Portal Access Request"
-- form, waiting for staff to approve them.
create table if not exists public.vendor_applications (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  friendly_name text not null,
  street text,
  city text,
  state text,
  zip text,
  contact_name text not null,
  contact_title text,
  contact_email text not null,
  contact_phone text,
  ssn_fid text,                              -- same sensitivity as Companies."SSN/FID"
  w9_path text,                              -- company-w9s bucket
  coi_expires_on date,                       -- optional; COIs are per vendor, uploaded later
  language text not null default 'en' check (language in ('en', 'es')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text,
  reviewed_by uuid references public.staff_users(id),
  reviewed_by_name text,
  reviewed_at timestamptz,
  company_id bigint references public."Companies"(id) on delete set null,   -- set when approved
  created_at timestamptz not null default now()
);

create index if not exists vendor_applications_status_idx on public.vendor_applications (status);

-- One row per person who can sign in to the portal ("Vendor Dashboard
-- User"). The account holder is whoever applied (or the first person
-- Leeward invited); they're the only one who can add/remove teammates.
create table if not exists public.vendor_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  title text,
  phone text,
  company_id bigint references public."Companies"(id) on delete cascade,  -- null while the application is pending
  application_id uuid references public.vendor_applications(id) on delete set null,
  role text not null default 'member' check (role in ('holder', 'member')),
  status text not null default 'active' check (status in ('pending', 'active', 'disabled', 'rejected')),
  language text not null default 'en' check (language in ('en', 'es')),
  added_by text,                             -- 'application' | 'invite' | 'staff' | 'vendor'
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vendor_users_email_key on public.vendor_users (lower(email));
create index if not exists vendor_users_company_id_idx on public.vendor_users (company_id);

-- vendor_users.contact_id must match the type of "Contacts".id, which was
-- created in the dashboard (bigint on the copy this was written against) --
-- so read the real type instead of assuming it.
do $$
declare
  contact_id_type text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'vendor_users' and column_name = 'contact_id'
  ) then
    select format_type(a.atttypid, a.atttypmod) into contact_id_type
    from pg_attribute a
    where a.attrelid = 'public."Contacts"'::regclass and a.attname = 'id' and not a.attisdropped;

    execute format(
      'alter table public.vendor_users add column contact_id %s references public."Contacts"(id) on delete set null',
      contact_id_type
    );
  end if;
end $$;

create index if not exists vendor_users_contact_id_idx on public.vendor_users (contact_id);

-- One-time sign-in links (emailed) and signed-in sessions. Only the
-- SHA-256 of each token is stored. No policies: the Edge Functions (service
-- role) are the only thing that reads or writes these.
create table if not exists public.vendor_login_tokens (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references public.vendor_users(id) on delete cascade,
  token_hash text not null unique,
  redirect_to text,                          -- portal page to land on, e.g. invite.html?id=...
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists vendor_login_tokens_user_idx on public.vendor_login_tokens (vendor_user_id, created_at);

create table if not exists public.vendor_sessions (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references public.vendor_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists vendor_sessions_user_idx on public.vendor_sessions (vendor_user_id);


-- 7. Row level security --------------------------------------------------------------

alter table public.bid_packages enable row level security;
alter table public.bid_package_files enable row level security;
alter table public.bid_invites enable row level security;
alter table public.vendor_applications enable row level security;
alter table public.vendor_users enable row level security;
alter table public.vendor_login_tokens enable row level security;
alter table public.vendor_sessions enable row level security;

-- bid_packages
drop policy if exists "bid_packages_select" on public.bid_packages;
create policy "bid_packages_select" on public.bid_packages for select to authenticated
  using (public.can_view_bid_invites());
drop policy if exists "bid_packages_insert" on public.bid_packages;
create policy "bid_packages_insert" on public.bid_packages for insert to authenticated
  with check (public.has_permission('vendors.send_bid_invites'));
drop policy if exists "bid_packages_update" on public.bid_packages;
create policy "bid_packages_update" on public.bid_packages for update to authenticated
  using (public.has_permission('projects.manage_bid_invites'))
  with check (public.has_permission('projects.manage_bid_invites'));
drop policy if exists "bid_packages_delete" on public.bid_packages;
create policy "bid_packages_delete" on public.bid_packages for delete to authenticated
  using (public.can_view_bid_invites());

-- bid_package_files
drop policy if exists "bid_package_files_select" on public.bid_package_files;
create policy "bid_package_files_select" on public.bid_package_files for select to authenticated
  using (public.can_view_bid_invites());
drop policy if exists "bid_package_files_insert" on public.bid_package_files;
create policy "bid_package_files_insert" on public.bid_package_files for insert to authenticated
  with check (public.has_permission('vendors.send_bid_invites'));
drop policy if exists "bid_package_files_delete" on public.bid_package_files;
create policy "bid_package_files_delete" on public.bid_package_files for delete to authenticated
  using (public.can_view_bid_invites());

-- bid_invites
drop policy if exists "bid_invites_select" on public.bid_invites;
create policy "bid_invites_select" on public.bid_invites for select to authenticated
  using (public.can_view_bid_invites());
drop policy if exists "bid_invites_insert" on public.bid_invites;
create policy "bid_invites_insert" on public.bid_invites for insert to authenticated
  with check (public.has_permission('vendors.send_bid_invites'));
drop policy if exists "bid_invites_update" on public.bid_invites;
create policy "bid_invites_update" on public.bid_invites for update to authenticated
  using (public.has_permission('projects.manage_bid_invites'))
  with check (public.has_permission('projects.manage_bid_invites'));
drop policy if exists "bid_invites_delete" on public.bid_invites;
create policy "bid_invites_delete" on public.bid_invites for delete to authenticated
  using (public.has_permission('projects.manage_bid_invites'));

-- vendor_applications: the approvers see and review them (approving runs in
-- the vendor-admin Edge Function, which also creates the vendor).
drop policy if exists "vendor_applications_select" on public.vendor_applications;
create policy "vendor_applications_select" on public.vendor_applications for select to authenticated
  using (public.has_permission('vendors.approve_applications'));
drop policy if exists "vendor_applications_update" on public.vendor_applications;
create policy "vendor_applications_update" on public.vendor_applications for update to authenticated
  using (public.has_permission('vendors.approve_applications'))
  with check (public.has_permission('vendors.approve_applications'));

-- vendor_users: any staff member can see who has a dashboard login (the
-- vendor page's Contacts list); people who manage contacts can update one
-- (merging duplicate contacts re-points contact_id).
drop policy if exists "vendor_users_select" on public.vendor_users;
create policy "vendor_users_select" on public.vendor_users for select to authenticated
  using (public.is_active_staff());
drop policy if exists "vendor_users_update" on public.vendor_users;
create policy "vendor_users_update" on public.vendor_users for update to authenticated
  using (public.has_permission('vendors.manage_contacts'))
  with check (public.has_permission('vendors.manage_contacts'));

-- vendor_login_tokens / vendor_sessions: no policies on purpose.

-- Supabase gives anon/authenticated every privilege on new tables by
-- default (including TRUNCATE, which skips RLS), so start from nothing and
-- grant back only what the policies above use.
revoke all on public.bid_packages, public.bid_package_files, public.bid_invites,
  public.vendor_applications, public.vendor_users, public.vendor_login_tokens, public.vendor_sessions
  from anon, authenticated;
grant select, insert, update, delete on public.bid_packages, public.bid_package_files, public.bid_invites to authenticated;
grant select, update on public.vendor_applications, public.vendor_users to authenticated;
grant all on public.bid_packages, public.bid_package_files, public.bid_invites,
  public.vendor_applications, public.vendor_users, public.vendor_login_tokens, public.vendor_sessions
  to service_role;


-- 8. Defaults + updated_at --------------------------------------------------------------

create or replace function public.set_bid_packages_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := public.current_staff_id();
  end if;
  return new;
end;
$$;

drop trigger if exists bid_packages_set_defaults on public.bid_packages;
create trigger bid_packages_set_defaults
  before insert on public.bid_packages
  for each row execute function public.set_bid_packages_defaults();

create or replace function public.touch_bid_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bid_packages_touch_updated_at on public.bid_packages;
create trigger bid_packages_touch_updated_at
  before update on public.bid_packages
  for each row execute function public.touch_bid_updated_at();

drop trigger if exists bid_invites_touch_updated_at on public.bid_invites;
create trigger bid_invites_touch_updated_at
  before update on public.bid_invites
  for each row execute function public.touch_bid_updated_at();

drop trigger if exists vendor_users_touch_updated_at on public.vendor_users;
create trigger vendor_users_touch_updated_at
  before update on public.vendor_users
  for each row execute function public.touch_bid_updated_at();


-- 8b. vendor_project_assignments (2026-10-24) ---------------------------------------
-- Staff add a vendor to a project straight from the vendor page ("Manage
-- Projects") -- for work that wasn't awarded through a Bid Invite. The vendor
-- then gets that project's folder in the Vendor Portal (COI template + COI
-- upload), same as an awarded bid. The COI columns mirror bid_invites'.

create table if not exists public.vendor_project_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id bigint not null references public."Companies"(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  scope text,                                 -- e.g. "Windows & Glazing" (optional)
  added_by uuid,
  added_by_name text,
  created_at timestamptz not null default now(),
  coi_requested_at timestamptz,
  coi_received_at timestamptz,
  coi_file_id uuid references public.project_files(id) on delete set null,
  unique (company_id, project_id)
);
-- hidden = staff removed this project from the vendor (Manage Projects › Remove)
-- even though it came from an awarded bid or an invoice. Keeps the bid/invoice
-- itself untouched; just takes it off the vendor's list and portal.
alter table public.vendor_project_assignments add column if not exists hidden boolean not null default false;
create index if not exists vendor_project_assignments_project_idx on public.vendor_project_assignments (project_id);

alter table public.vendor_project_assignments enable row level security;
revoke all on public.vendor_project_assignments from anon, authenticated;
grant select, insert, update, delete on public.vendor_project_assignments to authenticated;
grant all on public.vendor_project_assignments to service_role;

drop policy if exists vendor_project_assignments_select on public.vendor_project_assignments;
create policy vendor_project_assignments_select on public.vendor_project_assignments
  for select to authenticated using (public.is_active_staff());
drop policy if exists vendor_project_assignments_write on public.vendor_project_assignments;
create policy vendor_project_assignments_write on public.vendor_project_assignments
  for all to authenticated
  using (public.has_permission('vendors.add_edit_vendor'))
  with check (public.has_permission('vendors.add_edit_vendor'));


-- 9. vendor_projects(): the vendor page's "Projects" card ------------------------------
-- Projects a vendor works on: ones they were awarded a bid on, plus ones
-- with an invoice from them. Any staff member can see the list (just
-- project names -- no bid amounts, which stay limited to the bid
-- permissions above).

-- Return columns changed (2026-10-21: per-project COI), so drop first.
drop function if exists public.vendor_projects(bigint);
create function public.vendor_projects(p_company_id bigint)
returns table (
  project_id uuid, project_name text, source text,
  coi_file_id uuid, coi_requested_at timestamptz, coi_received_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_staff() then
    return;
  end if;

  -- Awarded projects, with that project's COI PDF (one per vendor per project).
  return query
    select p.id, p.name, 'awarded'::text,
           (array_agg(bi.coi_file_id order by bi.coi_received_at desc nulls last))[1],
           max(bi.coi_requested_at), max(bi.coi_received_at)
    from public.bid_invites bi
    join public.bid_packages bp on bp.id = bi.package_id
    join public.projects p on p.id = bp.project_id
    where bi.company_id = p_company_id and bi.status = 'awarded'
      and not exists (select 1 from public.vendor_project_assignments h
                       where h.company_id = p_company_id and h.project_id = p.id and h.hidden)
    group by p.id, p.name;

  -- Projects staff added the vendor to directly (Manage Projects).
  return query
    select p.id, p.name, 'assigned'::text, a.coi_file_id, a.coi_requested_at, a.coi_received_at
    from public.vendor_project_assignments a
    join public.projects p on p.id = a.project_id
    where a.company_id = p_company_id and not a.hidden;

  if to_regclass('public.project_invoices') is not null then
    return query execute
      'select distinct p.id, p.name, ''invoice''::text, null::uuid, null::timestamptz, null::timestamptz
         from public.project_invoices pi
         join public.projects p on p.id = pi.project_id
        where pi.vendor_id = $1::text
          and not exists (select 1 from public.vendor_project_assignments h
                           where h.company_id = $1 and h.project_id = p.id and h.hidden)'
      using p_company_id;
  end if;
end;
$$;

revoke all on function public.vendor_projects(bigint) from public, anon;
grant execute on function public.vendor_projects(bigint) to authenticated;


-- 9a. W-9 exemption (2026-10-21) -------------------------------------------------------
-- Same idea as "COIExempt": staff can check "Exempt from W-9 requirement" on a
-- vendor, and a missing W-9 no longer keeps that vendor from being Approved.
alter table public."Companies" add column if not exists "W9Exempt" boolean not null default false;


-- 9b. project_coi_templates: the COI template for a project (2026-10-21) ----------------
-- Leeward uploads a sample COI per project (the coverage and additional-
-- insured wording that project needs). Awarded vendors download it from the
-- project's folder in the Vendor Portal before uploading their own COI. The
-- file itself is a normal project_files row (Contracts & Procurement › Vendors).

create table if not exists public.project_coi_templates (
  project_id uuid primary key references public.projects(id) on delete cascade,
  project_file_id uuid not null references public.project_files(id) on delete cascade,
  uploaded_by_name text,
  updated_at timestamptz not null default now()
);

alter table public.project_coi_templates enable row level security;
revoke all on public.project_coi_templates from anon, authenticated;
grant select, insert, update, delete on public.project_coi_templates to authenticated;
grant all on public.project_coi_templates to service_role;

drop policy if exists project_coi_templates_select on public.project_coi_templates;
create policy project_coi_templates_select on public.project_coi_templates
  for select to authenticated using (public.can_view_bid_invites());
drop policy if exists project_coi_templates_write on public.project_coi_templates;
create policy project_coi_templates_write on public.project_coi_templates
  for all to authenticated
  using (public.has_permission('projects.manage_bid_invites'))
  with check (public.has_permission('projects.manage_bid_invites'));


-- 10. Sanity checks -- run after the above -----------------------------------------------
--   select key, label from public.permissions where key in
--     ('vendors.send_bid_invites', 'projects.manage_bid_invites', 'vendors.approve_applications');   -- 3 rows
--   select public.has_permission('vendors.approve_applications');   -- true for you (Super Admin)
--   select count(*) from public.vendor_users;                         -- 0
--   select format_type(atttypid, atttypmod) from pg_attribute
--     where attrelid = 'public.vendor_users'::regclass and attname = 'contact_id';   -- same type as "Contacts".id
-- ============================================================================
