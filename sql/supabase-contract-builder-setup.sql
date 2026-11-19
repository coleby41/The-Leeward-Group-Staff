-- ============================================================================
-- Contract Builder (Coleby, 2026-11-19)
--
-- Leeward's subcontract is generated from the project and vendor data on the
-- project's Accounts page (Generate contract), sent to the vendor, signed in
-- the Vendor Portal (initials on every page + signature), then signed by the
-- project's Project Manager for Leeward.
--
-- What this adds (safe to re-run):
--   1. projects: owner_entity (legal owner, the "project-owning entity"),
--      site_county, lender_name — asked for in the onboarding wizard's new
--      "Owner & Lender" step. (Owner contact = the existing owner_name /
--      owner_phone / owner_email columns.)
--   2. projects_overview: rebuilt so it picks up the new columns
--      (`select *` is fixed when the view is made).
--   3. project_vendor_contracts: builder columns
--        builder         the Generate contract popup's saved choices (jsonb)
--        builder_status  draft | not_completed | ready | sent  (null = uploaded contract)
--        draft_path      latest preview PDF (storage only, not in Project Files)
--        layout          where every Init: blank / signature line is (jsonb)
--        generated       true when file_id is a generated contract
--        vendor_initials
--        countersigned_file_id / _at / countersigner_* / agreement_date
--          the PM's signature for Leeward. signed_file_id stays the
--          vendor-signed copy (that's what the paperwork review looks at).
--
-- Run once in the Supabase SQL Editor. Needs
-- supabase-project-accounts-vendors-setup.sql run first.
-- ============================================================================


-- 1. projects: owner / county / lender ----------------------------------------

alter table public.projects add column if not exists owner_entity text;
alter table public.projects add column if not exists site_county text;
alter table public.projects add column if not exists lender_name text;


-- 2. projects_overview: pick up the new columns ----------------------------------

drop view if exists public.projects_overview cascade;
create view public.projects_overview
with (security_invoker = true)
as
select * from public.projects;
grant select on public.projects_overview to authenticated;


-- 3. project_vendor_contracts: builder columns -----------------------------------

alter table public.project_vendor_contracts add column if not exists builder jsonb;
alter table public.project_vendor_contracts add column if not exists builder_status text;
alter table public.project_vendor_contracts add column if not exists builder_missing text[] not null default '{}';
alter table public.project_vendor_contracts add column if not exists builder_updated_by_name text;
alter table public.project_vendor_contracts add column if not exists draft_path text;
alter table public.project_vendor_contracts add column if not exists layout jsonb;
alter table public.project_vendor_contracts add column if not exists generated boolean not null default false;
alter table public.project_vendor_contracts add column if not exists vendor_initials text;
alter table public.project_vendor_contracts add column if not exists countersigned_file_id uuid references public.project_files(id) on delete set null;
alter table public.project_vendor_contracts add column if not exists countersigned_at timestamptz;
alter table public.project_vendor_contracts add column if not exists countersigner_name text;
alter table public.project_vendor_contracts add column if not exists countersigner_title text;
alter table public.project_vendor_contracts add column if not exists countersigner_user_id uuid;
alter table public.project_vendor_contracts add column if not exists countersigner_ip text;
alter table public.project_vendor_contracts add column if not exists agreement_date date;

alter table public.project_vendor_contracts drop constraint if exists project_vendor_contracts_builder_status_check;
alter table public.project_vendor_contracts add constraint project_vendor_contracts_builder_status_check
  check (builder_status is null or builder_status in ('draft', 'not_completed', 'ready', 'sent'));


-- ============================================================================
-- Sanity checks -- run after the above:
--   select column_name from information_schema.columns
--     where table_name = 'projects' and column_name in ('owner_entity', 'site_county', 'lender_name');      -- 3 rows
--   select owner_entity, site_county, lender_name from public.projects_overview limit 1;                  -- works
--   select column_name from information_schema.columns
--     where table_name = 'project_vendor_contracts' and column_name like 'counter%';                       -- 5 rows
-- ============================================================================
