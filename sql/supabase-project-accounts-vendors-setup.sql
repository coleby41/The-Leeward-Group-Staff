-- ============================================================================
-- Project › Accounts redesign (Coleby, 2026-10-31)
--
-- What this adds (safe to re-run):
--   1. project_files: allow source = 'contract'
--   2. project_vendor_contracts: one row per vendor per project — the
--      contract, plus "Allowed to be on site" (allowed_on_site).
--      Staff upload it on the project's Accounts page; the vendor signs it
--      in the Vendor Portal (built-in signature). Until the contract is
--      signed AND the vendor has a W-9 on file AND a COI for that project,
--      the project stays locked in the portal (checklist only).
--   3. project_utility_accounts: service address, meter #, status, dates
--   4. project_vendors(project_id): every vendor tied to a project
--      (awarded, Manage Projects, invoice, invited to bid) with W-9 / COI.
--
-- Run once in the Supabase SQL Editor. Needs supabase-vendor-portal-setup.sql
-- (is_active_staff, vendor_project_assignments, bid tables) run first.
-- ============================================================================


-- 1. project_files: allow source = 'contract' ---------------------------------

do $$
declare
  allowed text;
begin
  select string_agg(quote_literal(v), ', ' order by v) into allowed
  from (
    select unnest(array['upload', 'form_submission', 'incident_report', 'back_charge', 'vpo', 'invoice', 'bid', 'contract']) as v
    union
    select distinct source from public.project_files where source is not null
  ) s;

  alter table public.project_files drop constraint if exists project_files_source_check;
  execute format(
    'alter table public.project_files add constraint project_files_source_check check (source in (%s))',
    allowed
  );
end $$;


-- 2. project_vendor_contracts --------------------------------------------------
-- Status is worked out from the columns:
--   not_needed = true                 → Not needed
--   signed_file_id set                → Signed
--   file_id set, not signed           → Waiting on vendor signature
--   no row / no file                  → Missing

create table if not exists public.project_vendor_contracts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  company_id bigint not null references public."Companies"(id) on delete cascade,
  file_id uuid references public.project_files(id) on delete set null,          -- the contract staff uploaded
  signed_file_id uuid references public.project_files(id) on delete set null,   -- the signed PDF
  not_needed boolean not null default false,
  signed_at timestamptz,
  signed_in_portal boolean not null default false,  -- false = staff uploaded an already-signed copy
  signer_name text,
  signer_title text,
  signer_email text,
  signer_vendor_user_id uuid,
  signer_ip text,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, company_id)
);

-- "Allowed to be on site" Yes / No for this vendor on this project (Coleby, 2026-10-31).
alter table public.project_vendor_contracts add column if not exists allowed_on_site boolean not null default false;

create index if not exists project_vendor_contracts_company_idx on public.project_vendor_contracts (company_id);

alter table public.project_vendor_contracts enable row level security;
revoke all on public.project_vendor_contracts from anon, authenticated;
grant select, insert, update, delete on public.project_vendor_contracts to authenticated;
grant all on public.project_vendor_contracts to service_role;

drop policy if exists project_vendor_contracts_staff on public.project_vendor_contracts;
create policy project_vendor_contracts_staff on public.project_vendor_contracts
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

create or replace function public.touch_project_vendor_contracts()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_vendor_contracts_touch on public.project_vendor_contracts;
create trigger project_vendor_contracts_touch
  before update on public.project_vendor_contracts
  for each row execute function public.touch_project_vendor_contracts();


-- 3. project_utility_accounts: new fields ---------------------------------------

alter table public.project_utility_accounts add column if not exists service_address text;
alter table public.project_utility_accounts add column if not exists meter_number text;
alter table public.project_utility_accounts add column if not exists status text not null default 'active';
alter table public.project_utility_accounts add column if not exists start_date date;
alter table public.project_utility_accounts add column if not exists close_date date;
alter table public.project_utility_accounts drop constraint if exists project_utility_accounts_status_check;
alter table public.project_utility_accounts add constraint project_utility_accounts_status_check
  check (status in ('active', 'transferred', 'closed'));


-- 4. project_vendors(): the Accounts page's Vendors tab -------------------------

drop function if exists public.project_vendors(uuid);
create function public.project_vendors(p_project_id uuid)
returns table (
  company_id bigint,
  company_name text,
  sources text[],              -- any of: awarded, assigned, invoice, invited
  scope text,
  bid_due_at timestamptz,      -- for invited-only vendors
  w9_file_path text,
  w9_updated_at timestamptz,
  w9_exempt boolean,
  coi_expires_on date,
  coi_exempt boolean,
  coi_file_id uuid,
  coi_file_name text,
  coi_requested_at timestamptz,
  coi_received_at timestamptz,
  awarded_invite_id uuid       -- for Request COI (bid-invites › request_coi)
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  invoice_ids bigint[] := '{}';
begin
  if not public.is_active_staff() then
    return;
  end if;

  if to_regclass('public.project_invoices') is not null then
    execute 'select coalesce(array_agg(distinct vendor_id::bigint), ''{}'')
               from public.project_invoices
              where project_id = $1 and vendor_id ~ ''^[0-9]+$'''
      into invoice_ids using p_project_id;
  end if;

  return query
  with awarded as (
    select bi.company_id, bi.id as invite_id, bp.name as pkg_name,
           bi.coi_file_id, bi.coi_requested_at, bi.coi_received_at
    from public.bid_invites bi
    join public.bid_packages bp on bp.id = bi.package_id
    where bp.project_id = p_project_id and bi.status = 'awarded'
  ),
  invited as (
    select bi.company_id, bp.name as pkg_name, bp.due_at
    from public.bid_invites bi
    join public.bid_packages bp on bp.id = bi.package_id
    where bp.project_id = p_project_id and bp.status = 'open'
      and bi.status in ('sent', 'viewed', 'bidding', 'bid_received')
  ),
  assigned as (
    select a.company_id, a.scope, a.coi_file_id, a.coi_requested_at, a.coi_received_at
    from public.vendor_project_assignments a
    where a.project_id = p_project_id and not a.hidden
  ),
  hidden as (
    select a.company_id from public.vendor_project_assignments a
    where a.project_id = p_project_id and a.hidden
  ),
  ids as (
    select x.company_id from (
      select aw.company_id from awarded aw
      union select iv.company_id from invited iv
      union select asg.company_id from assigned asg
      union select unnest(invoice_ids)
    ) x
    where x.company_id not in (select h.company_id from hidden h)
  ),
  coi as (
    -- this project's COI PDF: newest one from an awarded invite or the assignment
    select distinct on (c.company_id) c.company_id, c.coi_file_id, c.coi_received_at
    from (
      select aw.company_id, aw.coi_file_id, aw.coi_received_at from awarded aw where aw.coi_file_id is not null
      union all
      select asg.company_id, asg.coi_file_id, asg.coi_received_at from assigned asg where asg.coi_file_id is not null
    ) c
    order by c.company_id, c.coi_received_at desc nulls last
  )
  select
    co.id::bigint,
    coalesce(nullif(co."FriendlyName", ''), co."Name")::text,
    array_remove(array[
      case when exists (select 1 from awarded aw where aw.company_id = co.id) then 'awarded' end,
      case when exists (select 1 from assigned asg where asg.company_id = co.id) then 'assigned' end,
      case when co.id = any(invoice_ids) then 'invoice' end,
      case when exists (select 1 from invited iv where iv.company_id = co.id) then 'invited' end
    ], null)::text[],
    coalesce(
      (select string_agg(distinct aw.pkg_name, ', ') from awarded aw where aw.company_id = co.id),
      (select max(asg.scope) from assigned asg where asg.company_id = co.id),
      (select string_agg(distinct iv.pkg_name, ', ') from invited iv where iv.company_id = co.id)
    )::text,
    (select min(iv.due_at) from invited iv where iv.company_id = co.id)::timestamptz,
    co."W9FilePath"::text,
    co."W9UpdatedAt"::timestamptz,
    coalesce(co."W9Exempt", false),
    co."COIExpiresOn"::date,
    coalesce(co."COIExempt", false),
    coi.coi_file_id,
    pf.file_name::text,
    greatest(
      (select max(aw.coi_requested_at) from awarded aw where aw.company_id = co.id),
      (select max(asg.coi_requested_at) from assigned asg where asg.company_id = co.id)
    ),
    coi.coi_received_at,
    (select aw.invite_id from awarded aw where aw.company_id = co.id limit 1)
  from ids
  join public."Companies" co on co.id = ids.company_id
  left join coi on coi.company_id = co.id
  left join public.project_files pf on pf.id = coi.coi_file_id
  order by 2;
end;
$$;

revoke all on function public.project_vendors(uuid) from public, anon;
grant execute on function public.project_vendors(uuid) to authenticated;


-- 5. Sanity checks -- run after the above -----------------------------------------
--   select * from public.project_vendors('<a project id>');          -- one row per vendor on the job
--   select count(*) from public.project_vendor_contracts;              -- 0
--   select column_name from information_schema.columns
--     where table_name = 'project_utility_accounts' and column_name in
--     ('service_address', 'meter_number', 'status', 'start_date', 'close_date');   -- 5 rows
-- ============================================================================
