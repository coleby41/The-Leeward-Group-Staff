-- ============================================================================
-- supabase-bid-leveling-setup.sql  (2026-11-24)
--
-- Bid Leveling: the portal version of the V2026 Bid Workbook.
--   pages/project-bid-leveling.html + js/project-bid-leveling.js (staff)
--   Vendor Portal invite page (vendors enter one price per building for each
--   cost code in their package -- no breakdown).
--
-- How it fits with Bid Invites (sql/supabase-vendor-portal-setup.sql):
--   * A project's BUILDINGS (bid_areas) are set up once: each building type
--     with how many buildings, building #s, units, GBSF, leasable SF, plus the
--     site-wide sections (Site Work, Hardscape & Landscape, Amenities).
--   * An invite package (bid_packages) now lists the COST CODES and AREAS the
--     vendors price (cost_codes, area_ids). Old packages without them still
--     work the old way: one total + PDF.
--   * A vendor's prices are per building, per area, per cost code
--     (bid_invite_prices). bid_invites.bid_amount is kept = the vendor's total
--     (price x number of buildings), so Compare/Award/contracts keep working.
--   * Budget, estimate and the negotiation reduction live on bid_lines
--     (one per area + cost code).
--   * Award stays per package (the existing bid-invites "award" action).
--     bid_invites.awarded_amount = the vendor's total after the negotiation
--     reductions; the contract builder uses it when it's set.
--
-- Access: the same two Bid Invites permissions. Seeing Bid Leveling needs
-- vendors.send_bid_invites or projects.manage_bid_invites; changing it needs
-- projects.manage_bid_invites. Vendors never touch these tables directly
-- (vendor-api Edge Function, service role).
--
-- PREREQUISITE: supabase-vendor-portal-setup.sql (it has been run).
-- Safe to re-run. Run in Supabase -> SQL Editor.
-- ============================================================================


-- 1. Cost codes (company-wide list, from the workbook's "Bid Sheet Data") -------

create table if not exists public.bid_cost_codes (
  code text primary key,                      -- '3002'
  description text not null,                  -- 'Foundations - Turn-Key'
  division_code text not null,                -- '03'
  division_name text not null,                -- 'Concrete'
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Seeded from V2026 Bid Workbook - Temp - 06.10.2026.xlsm. Spelling fixed
-- (Concreate, Masonary, Genreal, Treatnent...); 5005 was listed twice.
-- New codes added later (e.g. from "+ Add line") keep their own wording.
insert into public.bid_cost_codes (code, description, division_code, division_name, sort_order) values
  ('1001', 'Const. Clean - Interior', '01', 'General Conditions', 0),
  ('1002', 'Const. Clean - Site', '01', 'General Conditions', 10),
  ('1003', 'Const. Clean - Site Labor Misc', '01', 'General Conditions', 20),
  ('1004', 'Const. Clean - Supplies', '01', 'General Conditions', 30),
  ('1005', 'Construction Trash', '01', 'General Conditions', 40),
  ('1006', 'Plan Reprographics', '01', 'General Conditions', 50),
  ('1007', 'Portolets', '01', 'General Conditions', 60),
  ('1008', 'Street Sweeping', '01', 'General Conditions', 70),
  ('1009', 'Survey/Staking - Construction', '01', 'General Conditions', 80),
  ('1010', 'Temporary Electric', '01', 'General Conditions', 90),
  ('1011', 'Temporary Water', '01', 'General Conditions', 100),
  ('1012', 'Third Party Inspections', '01', 'General Conditions', 110),
  ('1013', 'Vendor Appreciation', '01', 'General Conditions', 120),
  ('3001', 'Termite Treatment', '03', 'Concrete', 130),
  ('3002', 'Foundations - Turn-Key', '03', 'Concrete', 140),
  ('3003', 'Pool Deck - Turn Key', '03', 'Concrete', 150),
  ('4001', 'Brick Veneer - Turn-Key', '04', 'Masonry', 160),
  ('4002', 'Block - Turn Key', '04', 'Masonry', 170),
  ('4003', 'Stone Veneer - Turn Key', '04', 'Masonry', 180),
  ('5001', 'Stairs', '05', 'Structural Steel', 190),
  ('5002', 'Railings', '05', 'Structural Steel', 200),
  ('5003', 'Gates', '05', 'Structural Steel', 210),
  ('5004', 'Dogs Wash Gate', '05', 'Structural Steel', 220),
  ('5005', 'Trash Compactor Gates', '05', 'Structural Steel', 230),
  ('5006', 'Electrical Coral Gates', '05', 'Structural Steel', 240),
  ('5007', 'Structural Steel - Misc', '05', 'Structural Steel', 250),
  ('5008', 'Pre-Engineered Steel Pckg.', '05', 'Structural Steel', 260),
  ('5009', 'Steel Engineered Labor', '05', 'Structural Steel', 270),
  ('6001', 'Framing Material', '06', 'Carpentry', 280),
  ('6002', 'Framing Hardware', '06', 'Carpentry', 290),
  ('6004', 'Plywood Clips', '06', 'Carpentry', 300),
  ('6005', 'Nails And Fasteners', '06', 'Carpentry', 310),
  ('6006', 'Framing Labor', '06', 'Carpentry', 320),
  ('6007', 'Floor Truss Package', '06', 'Carpentry', 330),
  ('6011', 'Roof Truss Package', '06', 'Carpentry', 340),
  ('6012', 'Siding and Boxing', '06', 'Carpentry', 350),
  ('6013', 'Porch Railings', '06', 'Carpentry', 360),
  ('7001', 'Insulation', '07', 'Thermal', 370),
  ('7002', 'Roofing - Turn Key', '07', 'Thermal', 380),
  ('7003', 'Gutters', '07', 'Thermal', 390),
  ('8001', 'Exterior Doors', '08', 'Doors/Windows', 400),
  ('8002', 'Windows', '08', 'Doors/Windows', 410),
  ('8003', 'Window & Door Install Mtl.', '08', 'Doors/Windows', 420),
  ('8004', 'NP1 Sealants', '08', 'Doors/Windows', 430),
  ('8005', 'Windows/Door Flashing Tape', '08', 'Doors/Windows', 440),
  ('8006', 'Storefronts', '08', 'Doors/Windows', 450),
  ('8007', 'Garage Doors/Overhead Doors', '08', 'Doors/Windows', 460),
  ('8008', 'Attic Hatches', '08', 'Doors/Windows', 470),
  ('8009', 'Roof Draft Stop Doors', '08', 'Doors/Windows', 480),
  ('9001', 'Drywall Turn-Key', '09', 'Finishes', 490),
  ('9002', 'Ext Drywall (Breezeway) Mtl.', '09', 'Finishes', 500),
  ('9003', 'Acoustic Ceilings', '09', 'Finishes', 510),
  ('9004', 'Paint - Interior', '09', 'Finishes', 520),
  ('9005', 'Exterior Paint/Pressure Washing', '09', 'Finishes', 530),
  ('9006', 'Wire Shelving', '09', 'Finishes', 540),
  ('9007', 'Bath Hardware', '09', 'Finishes', 550),
  ('9008', 'Flooring - Turn-Key', '09', 'Finishes', 560),
  ('9009', 'Interior Trim - Turn-Key', '09', 'Finishes', 570),
  ('9010', 'Interior Trim - Labor', '09', 'Finishes', 580),
  ('9011', 'Interior Trim - Materials', '09', 'Finishes', 590),
  ('9012', 'Cabinets - Turn-Key', '09', 'Finishes', 600),
  ('9013', 'Cabinets - Material Only', '09', 'Finishes', 610),
  ('9014', 'Cabinets - Labor Only', '09', 'Finishes', 620),
  ('9015', 'Granite Kitchen Tops - Mtl.', '09', 'Finishes', 630),
  ('9016', 'Granite Bath Tops - Mtl.', '09', 'Finishes', 640),
  ('9017', 'Granite Kitchen Tops - Labor', '09', 'Finishes', 650),
  ('9018', 'Granite Bath Tops - Labor', '09', 'Finishes', 660),
  ('9019', 'Mirrors', '09', 'Finishes', 670),
  ('9020', 'Blinds', '09', 'Finishes', 680),
  ('9021', 'Door Hardware', '09', 'Finishes', 690),
  ('9022', 'Temp Locks', '09', 'Finishes', 700),
  ('9023', 'Exterior Lock Sets', '09', 'Finishes', 710),
  ('9024', 'Interior Lock Sets', '09', 'Finishes', 720),
  ('10001', 'Awnings', '10', 'Specialties', 730),
  ('10002', 'Flag pole', '10', 'Specialties', 740),
  ('10003', 'Mailboxes', '10', 'Specialties', 750),
  ('10004', 'Rent Drop Box', '10', 'Specialties', 760),
  ('10005', 'Dog Wash Station', '10', 'Specialties', 770),
  ('10006', 'Knox Box', '10', 'Specialties', 780),
  ('10007', 'Bath Partitions', '10', 'Specialties', 790),
  ('10008', 'Fire Extinguishers', '10', 'Specialties', 800),
  ('10009', 'Signage', '10', 'Specialties', 810),
  ('12001', 'Appliances', '12', 'Furnishings', 820),
  ('16001', 'High Voltage', '16', 'Electrical', 830),
  ('16002', 'Low Voltage', '16', 'Electrical', 840),
  ('16003', 'Security Systems', '16', 'Electrical', 850),
  ('16004', 'Fire Alarm', '16', 'Electrical', 860),
  ('16005', 'Electrical Fixtures', '16', 'Electrical', 870)
on conflict (code) do nothing;


-- 2. Buildings: building types + site-wide sections ----------------------------

create table if not exists public.bid_areas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null default 'building'
    check (kind in ('building', 'site_work', 'hardscape', 'amenities')),
  name text not null,                         -- 'Pool House', '24 Unit 1BR & 2BR', 'Site Work'
  building_count int not null default 1 check (building_count >= 0),
  building_numbers text,                      -- '3, 4, 5'
  units int not null default 0 check (units >= 0),          -- per building
  gbsf numeric(12, 2) not null default 0 check (gbsf >= 0), -- per building
  leasable_sf numeric(12, 2) not null default 0 check (leasable_sf >= 0),
  enabled boolean not null default true,      -- site-wide sections can be turned off
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bid_areas_project_id_idx on public.bid_areas (project_id);
-- One row per site-wide section per project.
create unique index if not exists bid_areas_one_section_idx
  on public.bid_areas (project_id, kind) where kind <> 'building';


-- 3. Bid lines: budget / estimate / negotiation per area + cost code -----------

create table if not exists public.bid_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  area_id uuid not null references public.bid_areas(id) on delete cascade,
  cost_code text not null references public.bid_cost_codes(code) on update cascade,
  budget numeric(14, 2),                      -- per building
  estimate numeric(14, 2),                    -- per building, for reference only
  reduction numeric(14, 2),                   -- negotiation: asked off the vendor's price, per building
  notes text,
  updated_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (area_id, cost_code)
);

create index if not exists bid_lines_project_id_idx on public.bid_lines (project_id);


-- 4. What each package covers ------------------------------------------------

alter table public.bid_packages add column if not exists cost_codes text[];
alter table public.bid_packages add column if not exists area_ids uuid[];


-- 5. Vendor prices: one per building, per area, per cost code -------------------

create table if not exists public.bid_invite_prices (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.bid_invites(id) on delete cascade,
  area_id uuid not null references public.bid_areas(id) on delete cascade,
  cost_code text not null references public.bid_cost_codes(code) on update cascade,
  amount numeric(14, 2) not null check (amount >= 0),   -- per building
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invite_id, area_id, cost_code)
);

create index if not exists bid_invite_prices_invite_id_idx on public.bid_invite_prices (invite_id);
create index if not exists bid_invite_prices_area_id_idx on public.bid_invite_prices (area_id);

-- The contract amount after negotiation (set by Bid Leveling right before it
-- awards). Null = use bid_amount, as before.
alter table public.bid_invites add column if not exists awarded_amount numeric(14, 2);


-- 6. Keep bid_invites.bid_amount = the vendor's total ---------------------------
-- total = sum(price per building x number of buildings in that area).
-- Re-run whenever a price changes or an area's building count changes, so
-- "we added a building" never needs a re-bid.

create or replace function public.recalc_bid_invite_total(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  total numeric(14, 2);
  n int;
begin
  select count(*), coalesce(sum(p.amount * a.building_count), 0)
    into n, total
  from public.bid_invite_prices p
  join public.bid_areas a on a.id = p.area_id
  where p.invite_id = p_invite_id;
  -- Only invites priced line by line; an old-style single total is left alone.
  if n > 0 then
    update public.bid_invites set bid_amount = total where id = p_invite_id;
  end if;
end;
$$;

revoke all on function public.recalc_bid_invite_total(uuid) from public, anon;

create or replace function public.bid_invite_prices_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalc_bid_invite_total(old.invite_id);
    return old;
  end if;
  perform public.recalc_bid_invite_total(new.invite_id);
  return new;
end;
$$;

drop trigger if exists bid_invite_prices_recalc on public.bid_invite_prices;
create trigger bid_invite_prices_recalc
  after insert or update or delete on public.bid_invite_prices
  for each row execute function public.bid_invite_prices_after_change();

create or replace function public.bid_areas_after_count_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv uuid;
begin
  if new.building_count is distinct from old.building_count then
    for inv in select distinct invite_id from public.bid_invite_prices where area_id = new.id loop
      perform public.recalc_bid_invite_total(inv);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists bid_areas_recalc on public.bid_areas;
create trigger bid_areas_recalc
  after update of building_count on public.bid_areas
  for each row execute function public.bid_areas_after_count_change();

drop trigger if exists bid_areas_touch_updated_at on public.bid_areas;
create trigger bid_areas_touch_updated_at before update on public.bid_areas
  for each row execute function public.touch_bid_updated_at();
drop trigger if exists bid_lines_touch_updated_at on public.bid_lines;
create trigger bid_lines_touch_updated_at before update on public.bid_lines
  for each row execute function public.touch_bid_updated_at();
drop trigger if exists bid_invite_prices_touch_updated_at on public.bid_invite_prices;
create trigger bid_invite_prices_touch_updated_at before update on public.bid_invite_prices
  for each row execute function public.touch_bid_updated_at();


-- 7. Row level security ---------------------------------------------------------

alter table public.bid_cost_codes enable row level security;
alter table public.bid_areas enable row level security;
alter table public.bid_lines enable row level security;
alter table public.bid_invite_prices enable row level security;

-- Cost codes: any active staff member can read them; Bid managers can add
-- new ones (from "+ Add line").
drop policy if exists "bid_cost_codes_select" on public.bid_cost_codes;
create policy "bid_cost_codes_select" on public.bid_cost_codes for select to authenticated
  using (public.is_active_staff());
drop policy if exists "bid_cost_codes_insert" on public.bid_cost_codes;
create policy "bid_cost_codes_insert" on public.bid_cost_codes for insert to authenticated
  with check (public.has_permission('projects.manage_bid_invites'));
drop policy if exists "bid_cost_codes_update" on public.bid_cost_codes;
create policy "bid_cost_codes_update" on public.bid_cost_codes for update to authenticated
  using (public.has_permission('projects.manage_bid_invites'))
  with check (public.has_permission('projects.manage_bid_invites'));

-- Areas, lines and prices: see with either bid permission, change with
-- projects.manage_bid_invites. (The invite wizard only reads areas.)
do $$
declare
  t text;
begin
  foreach t in array array['bid_areas', 'bid_lines', 'bid_invite_prices'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_view_bid_invites())', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_permission(''projects.manage_bid_invites''))', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_permission(''projects.manage_bid_invites'')) with check (public.has_permission(''projects.manage_bid_invites''))', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_permission(''projects.manage_bid_invites''))', t || '_delete', t);
  end loop;
end $$;


-- 8. Sanity checks (read-only) ---------------------------------------------------
-- Expect 88 cost codes:
--   select count(*) from public.bid_cost_codes;
-- Every invite priced line by line, and its total:
--   select i.company_name, i.bid_amount, count(p.*) as prices
--   from public.bid_invites i join public.bid_invite_prices p on p.invite_id = i.id
--   group by i.id order by i.company_name;
