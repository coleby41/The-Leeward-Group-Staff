-- Vendor page › Contacts: "Allowed to be on site" Yes / No (Coleby, 2026-10-31).
-- Run once in the Supabase SQL Editor. Safe to re-run. Existing contacts start as No.

alter table public."Contacts" add column if not exists "AllowedOnSite" boolean not null default false;

-- Sanity check:
--   select count(*) filter (where "AllowedOnSite") as yes, count(*) as total from public."Contacts";
