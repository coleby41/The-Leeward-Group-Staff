-- =============================================================================
-- Bid cost codes come from the vendor tags (Coleby, 2026-11-27)
--
-- The Trade tags on the Vendors page are named like "3002 - Foundations -
-- Turn-Key". Those tags are now the one list of cost codes: bid_cost_codes is
-- kept in step with them automatically, so nobody maintains two lists.
--
--   Add a Trade tag "6014 - Soffit"     -> cost code 6014 appears in Bids
--   Rename a tag                         -> the cost code's name follows
--   Delete a tag                         -> the cost code is hidden (active =
--                                           false); old bids that used it keep it
--   Trade tags without a number          -> not cost codes (e.g. "Signage")
--
-- Codes that came from the bid workbook but have no matching tag are hidden
-- the same way. Nothing is deleted.
--
-- Safe to run more than once. Run after supabase-vendor-tags-setup.sql and
-- supabase-bid-leveling-setup.sql.
-- =============================================================================

alter table public.bid_cost_codes add column if not exists vendor_tag_id uuid
  references public.vendor_tags(id) on delete set null;

-- "3002 - Foundations - Turn-Key", "9004 Paint - Interior", "11002 - Generator(s)"
-- -> code '3002' / description 'Foundations - Turn-Key'. Null when the name
-- doesn't start with a number.
create or replace function public.bid_code_from_tag(p_name text)
returns table (code text, description text)
language sql immutable as $$
  select m[1], nullif(btrim(m[2]), '')
  from regexp_match(btrim(coalesce(p_name, '')), '^"?(\d{3,6})\s*[-–—:.]?\s*(.*?)"?$') as m
  where m is not null;
$$;

-- Division from the code: 3002 -> '03', 11001 -> '11'. The name comes from an
-- existing code in the same division, else the standard CSI-style name.
create or replace function public.bid_division_for(p_code text)
returns table (division_code text, division_name text)
language sql stable as $$
  with d as (select lpad(left(p_code, length(p_code) - 3), 2, '0') as dc)
  select d.dc,
         coalesce(
           (select c.division_name from public.bid_cost_codes c where c.division_code = d.dc order by c.sort_order limit 1),
           case d.dc
             when '01' then 'General Conditions' when '02' then 'Site Work' when '03' then 'Concrete'
             when '04' then 'Masonry' when '05' then 'Structural Steel' when '06' then 'Wood & Framing'
             when '07' then 'Thermal & Moisture' when '08' then 'Doors & Windows' when '09' then 'Finishes'
             when '10' then 'Specialties' when '11' then 'Equipment' when '12' then 'Furnishings'
             else 'Other' end)
  from d;
$$;

-- Make bid_cost_codes match the Trade tags. Runs as the table owner so anyone
-- who can manage tags keeps cost codes in step (RLS on bid_cost_codes still
-- limits direct edits to bid managers).
create or replace function public.sync_bid_cost_codes_from_tags()
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Upsert every numbered Trade tag.
  insert into public.bid_cost_codes (code, description, division_code, division_name, sort_order, active, vendor_tag_id)
  select distinct on (p.code)
         p.code,
         coalesce(p.description, p.code),
         dv.division_code, dv.division_name,
         (p.code)::int * 10,
         true,
         t.id
  from public.vendor_tags t
  join public.vendor_tag_categories cat on cat.id = t.category_id and lower(cat.name) = 'trade'
  cross join lateral public.bid_code_from_tag(t.name) p
  cross join lateral public.bid_division_for(p.code) dv
  order by p.code, t.created_at
  on conflict (code) do update
    set description = excluded.description,
        active = true,
        vendor_tag_id = excluded.vendor_tag_id,
        sort_order = excluded.sort_order;

  -- Hide codes that no longer have a tag (kept for old bids).
  update public.bid_cost_codes c
     set active = false, vendor_tag_id = null
   where c.active
     and not exists (
       select 1
       from public.vendor_tags t
       join public.vendor_tag_categories cat on cat.id = t.category_id and lower(cat.name) = 'trade'
       cross join lateral public.bid_code_from_tag(t.name) p
       where p.code = c.code);
end;
$$;

create or replace function public.trg_vendor_tags_sync_bid_codes()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_bid_cost_codes_from_tags();
  return null;
end;
$$;

drop trigger if exists vendor_tags_sync_bid_codes on public.vendor_tags;
create trigger vendor_tags_sync_bid_codes
  after insert or update or delete on public.vendor_tags
  for each statement execute function public.trg_vendor_tags_sync_bid_codes();

-- Bring everything in line now.
select public.sync_bid_cost_codes_from_tags();
