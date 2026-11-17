-- ============================================================================
-- Test data for "TESTING PROJECT - DO NOT PUT REAL DATA"
-- id 7dcf2d22-f6be-4c25-b6d0-5723b9c0aeb0
--
-- Fills every table the archive export reads so each Records PDF has rows:
-- timeline, contacts, utilities, vendors, contracts, invoices, incident
-- reports + VPOs + back charges, bid packages + invites, budget, draws,
-- to-dos and project team.
--
-- Safe to run more than once: it first removes the rows it added last time
-- (everything it adds is stamped "Test data"). It never touches real
-- projects. Vendors and staff are borrowed from your existing Companies and
-- staff_users tables (nothing new is created there).
--
-- Run in the Supabase SQL editor.
-- ============================================================================

begin;

-- Incident reports normally force "pending approval" and need a default
-- approver. Turn those two triggers off just for this script.
alter table public.incident_reports disable trigger incident_reports_set_defaults;
alter table public.incident_reports disable trigger incident_reports_log_submitted;

do $$
declare
  p   uuid := '7dcf2d22-f6be-4c25-b6d0-5723b9c0aeb0';
  tag text := 'Test data';
  v_id   bigint[];
  v_name text[];
  s_id   uuid[];
  s_name text[];
  s_auth uuid[];
  ph_pre uuid; ph_buy uuid; ph_con uuid; ph_close uuid;
  sec_hard uuid; sec_soft uuid; sec_vpo uuid;
  bl_site uuid; bl_found uuid; bl_frame uuid; bl_roof uuid; bl_mep uuid; bl_arch uuid; bl_permit uuid; bl_vpo uuid;
  d1 uuid; d2 uuid; d3 uuid;
  ir1 uuid; ir2 uuid; ir3 uuid;
  bp1 uuid; bp2 uuid;
  td1 uuid;
  i int;
begin
  if not exists (select 1 from public.projects where id = p) then
    raise exception 'Test project % not found', p;
  end if;

  -- ---- Borrow 6 vendors and up to 3 staff ---------------------------------
  select array_agg(id order by id), array_agg("Name" order by id)
    into v_id, v_name
    from (select id, "Name" from public."Companies" where "Name" is not null order by id limit 6) c;
  if coalesce(array_length(v_id, 1), 0) < 6 then
    raise exception 'Need at least 6 rows in Companies to borrow as test vendors';
  end if;

  select array_agg(id order by full_name), array_agg(full_name order by full_name), array_agg(auth_user_id order by full_name)
    into s_id, s_name, s_auth
    from (select id, full_name, auth_user_id from public.staff_users
           where auth_user_id is not null and full_name is not null
           order by full_name limit 3) s;

  -- ---- Clear last run's rows ----------------------------------------------
  delete from public.incident_reports        where project_id = p and submitted_by_name = tag;  -- VPOs + BCs cascade
  delete from public.draws                   where project_id = p and created_by_name = tag;   -- draw lines cascade
  delete from public.project_invoices        where project_id = p and created_by_name = tag;
  delete from public.budget_lines            where project_id = p and created_by_name = tag;
  delete from public.budget_sections         where project_id = p and name in ('Hard costs', 'Soft costs', 'VPOs (test)');
  delete from public.bid_packages            where project_id = p and created_by_name = tag;   -- invites cascade
  delete from public.schedule_tasks          where project_id = p and created_by_name = tag;
  delete from public.schedule_phases         where project_id = p and created_by_name = tag;
  delete from public.project_contacts        where project_id = p and created_by_name = tag;
  delete from public.project_utility_accounts where project_id = p and created_by_name = tag;
  delete from public.vendor_project_assignments where project_id = p and added_by_name = tag;
  delete from public.project_vendor_contracts where project_id = p and uploaded_by_name = tag;
  delete from public.project_todo_items      where project_id = p and created_by_name = tag;   -- sub-items cascade

  -- ---- Project basics -----------------------------------------------------
  update public.projects
     set contract_value = coalesce(contract_value, 1850000),
         start_date     = coalesce(start_date, date '2025-03-03'),
         plan_locked_at = coalesce(plan_locked_at, timestamptz '2025-03-10 09:00-05'),
         plan_locked_by_name = coalesce(plan_locked_by_name, tag)
   where id = p;

  -- ---- Timeline -----------------------------------------------------------
  insert into public.schedule_phases (project_id, name, phase_type, description, sort_order, created_by_name)
  values (p, 'Pre-construction', 'pre_construction', 'Design, permits, budget', 1, tag) returning id into ph_pre;
  insert into public.schedule_phases (project_id, name, phase_type, description, sort_order, created_by_name)
  values (p, 'Buy out', 'buy_out', 'Bid and award trades', 2, tag) returning id into ph_buy;
  insert into public.schedule_phases (project_id, name, phase_type, description, sort_order, created_by_name)
  values (p, 'Construction', 'construction', 'Site work through finishes', 3, tag) returning id into ph_con;
  insert into public.schedule_phases (project_id, name, phase_type, description, sort_order, created_by_name)
  values (p, 'Close out', 'close_out', 'Punch, CO, turnover', 4, tag) returning id into ph_close;

  insert into public.schedule_tasks
    (project_id, phase_id, item_type, name, start_date, end_date, plan_start_date, plan_end_date,
     status, progress_percent, priority, assigned_user_name, contractor_id, contractor_name, sort_order, created_by_name)
  values
    (p, ph_pre,  'task',      'Civil drawings',          '2025-03-03', '2025-03-28', '2025-03-03', '2025-03-21', 'complete', 100, 'high',   s_name[1], null,     null,      1, tag),
    (p, ph_pre,  'task',      'Building permit',         '2025-03-17', '2025-04-18', '2025-03-17', '2025-04-11', 'complete', 100, 'urgent', s_name[1], null,     null,      2, tag),
    (p, ph_pre,  'milestone', 'Permit issued',           null,         '2025-04-18', null,         '2025-04-11', 'complete', 100, 'high',   null,      null,     null,      3, tag),
    (p, ph_buy,  'task',      'Bid framing package',     '2025-04-01', '2025-04-25', '2025-04-01', '2025-04-25', 'complete', 100, 'medium', s_name[2], null,     null,      1, tag),
    (p, ph_buy,  'task',      'Bid roofing package',     '2025-04-07', '2025-05-02', '2025-04-07', '2025-05-02', 'complete', 100, 'medium', s_name[2], null,     null,      2, tag),
    (p, ph_con,  'task',      'Site clearing & grading', '2025-04-21', '2025-05-16', '2025-04-14', '2025-05-09', 'complete', 100, 'high',   s_name[1], v_id[1], v_name[1], 1, tag),
    (p, ph_con,  'task',      'Foundations',             '2025-05-19', '2025-06-20', '2025-05-12', '2025-06-13', 'complete', 100, 'high',   s_name[1], v_id[2], v_name[2], 2, tag),
    (p, ph_con,  'task',      'Framing',                 '2025-06-23', '2025-08-29', '2025-06-16', '2025-08-15', 'complete', 100, 'high',   s_name[1], v_id[3], v_name[3], 3, tag),
    (p, ph_con,  'task',      'Roofing',                 '2025-09-02', '2025-09-26', '2025-08-18', '2025-09-12', 'complete', 100, 'medium', s_name[1], v_id[4], v_name[4], 4, tag),
    (p, ph_con,  'task',      'MEP rough-in',            '2025-09-15', '2025-10-31', '2025-09-08', '2025-10-24', 'complete', 100, 'high',   s_name[1], v_id[5], v_name[5], 5, tag),
    (p, ph_con,  'task',      'Drywall & finishes',      '2025-11-03', '2026-01-23', '2025-10-27', '2026-01-09', 'complete', 100, 'medium', s_name[1], v_id[6], v_name[6], 6, tag),
    (p, ph_close,'task',      'Punch list',              '2026-01-26', '2026-02-13', '2026-01-12', '2026-01-30', 'complete', 100, 'medium', s_name[2], null,     null,      1, tag),
    (p, ph_close,'milestone', 'Certificate of occupancy',null,         '2026-02-20', null,         '2026-02-06', 'complete', 100, 'urgent', null,      null,     null,      2, tag);

  -- ---- Contacts + utilities ----------------------------------------------
  insert into public.project_contacts (project_id, contact_type, full_name, title, company_name, phone, email, notes, created_by_name) values
    (p, 'property_owner',      'Jordan Test',   'Owner',             'Test Holdings LLC',    '910-555-0101', 'jordan@example.com',  'Prefers email', tag),
    (p, 'point_of_contact',    'Riley Sample',  'Site super',        'The Leeward Group',    '910-555-0102', 'riley@example.com',   null,            tag),
    (p, 'county_city_office',  'Casey Inspector','Building inspector','New Hanover County',  '910-555-0103', 'casey@example.com',   'Call before 9am', tag),
    (p, 'trash_porta_potties', 'Dispatch',      null,                'Test Waste Services',  '910-555-0104', 'dispatch@example.com', 'Pickup Tuesdays', tag);

  insert into public.project_utility_accounts
    (project_id, utility_type, provider_name, account_number, service_address, meter_number, status, start_date, close_date, phone, created_by_name) values
    (p, 'electric', 'Test Power Co',  'TEST-E-1001', '123 Test St, Wilmington, NC', 'M-55501', 'transferred', '2025-03-10', '2026-02-27', '800-555-0110', tag),
    (p, 'water',    'Test Water Auth','TEST-W-2002', '123 Test St, Wilmington, NC', 'M-55502', 'transferred', '2025-03-10', '2026-02-27', '800-555-0111', tag),
    (p, 'trash',    'Test Waste',     'TEST-T-3003', '123 Test St, Wilmington, NC', null,      'closed',      '2025-04-01', '2026-02-13', '800-555-0112', tag);

  -- ---- Vendors on project + contracts ------------------------------------
  for i in 1..6 loop
    insert into public.vendor_project_assignments (company_id, project_id, scope, added_by_name, coi_requested_at, coi_received_at)
    values (v_id[i], p,
            (array['Site work','Foundations','Framing','Roofing','MEP','Drywall & finishes'])[i],
            tag, timestamptz '2025-04-01 10:00-04' + (i || ' days')::interval,
            case when i <= 5 then timestamptz '2025-04-08 10:00-04' + (i || ' days')::interval end)
    on conflict (company_id, project_id) do nothing;

    insert into public.project_vendor_contracts (project_id, company_id, not_needed, signed_at, signer_name, signer_title, uploaded_by_name)
    values (p, v_id[i], i = 6,
            case when i < 6 then timestamptz '2025-04-15 14:00-04' + (i || ' days')::interval end,
            case when i < 6 then 'Test Signer ' || i end,
            case when i < 6 then 'Owner' end, tag)
    on conflict (project_id, company_id) do nothing;
  end loop;

  -- ---- Budget -------------------------------------------------------------
  insert into public.budget_sections (project_id, name, cost_type, sort_order) values (p, 'Hard costs', 'hard', 1) returning id into sec_hard;
  insert into public.budget_sections (project_id, name, cost_type, sort_order) values (p, 'Soft costs', 'soft', 2) returning id into sec_soft;
  insert into public.budget_sections (project_id, name, cost_type, sort_order) values (p, 'VPOs (test)', 'hard', 3) returning id into sec_vpo;

  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_hard, 'Site work',          185000, 185000, 10, 1, 'manual', tag) returning id into bl_site;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_hard, 'Foundations',        240000, 120000, 10, 2, 'manual', tag) returning id into bl_found;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_hard, 'Framing',            410000, 100000, 10, 3, 'manual', tag) returning id into bl_frame;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_hard, 'Roofing',            145000,      0, 10, 4, 'manual', tag) returning id into bl_roof;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_hard, 'MEP',                390000,      0, 10, 5, 'manual', tag) returning id into bl_mep;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_soft, 'Architect & engineering', 95000, 95000, 0, 1, 'manual', tag) returning id into bl_arch;
  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_soft, 'Permits & fees',      38000,  38000, 0, 2, 'manual', tag) returning id into bl_permit;

  -- ---- Incident reports -> VPOs and back charges --------------------------
  insert into public.incident_reports
    (project_id, report_date, price, buildings, unit_numbers, person_making_report, reason_for_report, change_in_scope,
     who_caused_issue, status, submitted_by_name, assigned_approver_name, decided_at, ir_number)
  values (p, '2025-06-02', 8400, '1', '101-104', 'Riley Sample', 'Unsuitable soil at footing line',
          'Over-excavate and replace with stone', 'Unforeseen site condition', 'approved', tag, s_name[1], '2025-06-03', 'IR-TEST-001')
  returning id into ir1;
  insert into public.incident_reports
    (project_id, report_date, price, buildings, unit_numbers, person_making_report, reason_for_report, change_in_scope,
     who_caused_issue, status, submitted_by_name, assigned_approver_name, decided_at, ir_number)
  values (p, '2025-08-11', 2650, '1', '102', 'Riley Sample', 'Framing damaged by plumbing crew',
          'Replace two damaged studs and header', v_name[5], 'approved', tag, s_name[1], '2025-08-12', 'IR-TEST-002')
  returning id into ir2;
  insert into public.incident_reports
    (project_id, report_date, price, buildings, unit_numbers, person_making_report, reason_for_report, change_in_scope,
     who_caused_issue, status, submitted_by_name, assigned_approver_name)
  values (p, '2025-12-04', 1200, '1', '103', 'Riley Sample', 'Owner asked for extra outlet in kitchen',
          'Add one duplex outlet', 'Owner request', 'pending_approval', tag, s_name[1])
  returning id into ir3;

  insert into public.budget_lines (project_id, section_id, description, total_budget, equity_budget, retainage_pct, sort_order, source, created_by_name)
  values (p, sec_vpo, 'VPO-TEST-1 Soil replacement', 8400, 8400, 0, 1, 'vpo', tag) returning id into bl_vpo;

  insert into public.vpos (incident_report_id, project_id, vpo_number, building_number, building_seq, project_total_at_creation,
                           vendor_id, vendor_name, project_name, report_date, unit_numbers, person_making_report,
                           reason_for_report, change_in_scope, price, created_by_name, budget_line_id)
  values (ir1, p, 'VPO-TEST-1-1-1', '1', 1, 1, v_id[2], v_name[2], 'TESTING PROJECT', '2025-06-02', '101-104',
          'Riley Sample', 'Unsuitable soil at footing line', 'Over-excavate and replace with stone', 8400, tag, bl_vpo);
  update public.budget_lines set vpo_id = (select id from public.vpos where incident_report_id = ir1) where id = bl_vpo;

  insert into public.back_charges (incident_report_id, project_id, bc_number, vendor_to_charge_id, vendor_to_charge_name,
                                   vendor_to_cr_back_id, vendor_to_cr_back_name, project_name, report_date, price, buildings,
                                   unit_numbers, person_making_report, reason_for_report, change_in_scope, created_by_name)
  values (ir2, p, 'BC-TEST-001', v_id[5], v_name[5], v_id[3], v_name[3], 'TESTING PROJECT', '2025-08-11', 2650, '1', '102',
          'Riley Sample', 'Framing damaged by plumbing crew', 'Replace two damaged studs and header', tag);

  -- ---- Draws --------------------------------------------------------------
  insert into public.draws (project_id, draw_number, period_to, application_date, status, submitted_at, submitted_by_name, funded_at, funded_amount, created_by_name)
  values (p, 1, '2025-05-31', '2025-06-05', 'funded',    '2025-06-05 10:00-04', tag, '2025-06-16 12:00-04', 198000, tag) returning id into d1;
  insert into public.draws (project_id, draw_number, period_to, application_date, status, submitted_at, submitted_by_name, funded_at, funded_amount, created_by_name)
  values (p, 2, '2025-08-31', '2025-09-04', 'funded',    '2025-09-04 10:00-04', tag, '2025-09-15 12:00-04', 412500, tag) returning id into d2;
  insert into public.draws (project_id, draw_number, period_to, application_date, status, submitted_at, submitted_by_name, created_by_name)
  values (p, 3, '2025-11-30', '2025-12-04', 'submitted', '2025-12-04 10:00-05', tag, tag) returning id into d3;

  insert into public.draw_lines (draw_id, budget_line_id, equity_this_period, loan_this_period, stored_materials) values
    (d1, bl_site,   150000,      0,     0),
    (d1, bl_arch,    48000,      0,     0),
    (d2, bl_site,    35000,      0,     0),
    (d2, bl_found,  120000, 112000,     0),
    (d2, bl_frame,   45000,  95000, 18000),
    (d2, bl_vpo,      8400,      0,     0),
    (d3, bl_frame,   55000, 160000,     0),
    (d3, bl_roof,        0, 145000,     0),
    (d3, bl_mep,         0, 120000, 22000),
    (d3, bl_permit,  38000,      0,     0);

  -- ---- Invoices (most tagged to a budget line + draw) ---------------------
  insert into public.project_invoices (project_id, vendor_id, vendor_name, invoice_number, description, total_due, invoice_date, paid, budget_line_id, draw_id, is_stored_material, created_by_name) values
    (p, v_id[1]::text, v_name[1], 'T-1001', 'Clearing and rough grade',     150000, '2025-05-20', true,  bl_site,   d1, false, tag),
    (p, v_id[1]::text, v_name[1], 'T-1002', 'Final grade',                   35000, '2025-06-18', true,  bl_site,   d2, false, tag),
    (p, v_id[2]::text, v_name[2], 'T-2001', 'Footings and slab',            232000, '2025-06-25', true,  bl_found,  d2, false, tag),
    (p, v_id[2]::text, v_name[2], 'T-2002', 'VPO-TEST-1 soil replacement',    8400, '2025-06-27', true,  bl_vpo,    d2, false, tag),
    (p, v_id[3]::text, v_name[3], 'T-3001', 'Framing progress 1',           140000, '2025-08-22', true,  bl_frame,  d2, false, tag),
    (p, v_id[3]::text, v_name[3], 'T-3002', 'Framing lumber on site',        18000, '2025-08-25', true,  bl_frame,  d2, true,  tag),
    (p, v_id[3]::text, v_name[3], 'T-3003', 'Framing progress 2',           215000, '2025-10-03', true,  bl_frame,  d3, false, tag),
    (p, v_id[4]::text, v_name[4], 'T-4001', 'Roof complete',                145000, '2025-10-10', true,  bl_roof,   d3, false, tag),
    (p, v_id[5]::text, v_name[5], 'T-5001', 'MEP rough-in',                 120000, '2025-11-07', false, bl_mep,    d3, false, tag),
    (p, v_id[5]::text, v_name[5], 'T-5002', 'Fixtures stored on site',       22000, '2025-11-14', false, bl_mep,    d3, true,  tag),
    (p, v_id[6]::text, v_name[6], 'T-6001', 'Drywall progress',              64500, '2025-12-19', false, null,      null, false, tag),
    (p, null,          'Test County', 'T-PERMIT', 'Building permit fees',    38000, '2025-04-11', true,  bl_permit, d3, false, tag),
    (p, null,          'Test Architects', 'T-A-01', 'Design + CA',           48000, '2025-05-02', true,  bl_arch,   d1, false, tag);

  -- ---- Bid packages + invites --------------------------------------------
  insert into public.bid_packages (project_id, name, trade_tag_name, scope, location, due_at, contact_name, contact_email, status, awarded_at, awarded_by_name, created_by_name)
  values (p, 'Framing', 'Framing', 'All wood framing, sheathing and blocking', '123 Test St, Wilmington, NC',
          '2025-04-25 17:00-04', coalesce(s_name[2], 'Test PM'), 'pm@example.com', 'awarded', '2025-04-29 11:00-04', tag, tag)
  returning id into bp1;
  insert into public.bid_packages (project_id, name, trade_tag_name, scope, location, due_at, contact_name, contact_email, status, created_by_name)
  values (p, 'Landscaping', 'Landscaping', 'Sod, plantings and irrigation', '123 Test St, Wilmington, NC',
          '2026-01-16 17:00-05', coalesce(s_name[2], 'Test PM'), 'pm@example.com', 'closed', tag)
  returning id into bp2;

  insert into public.bid_invites (package_id, company_id, company_name, contact_email, status, sent_at, viewed_at, responded_at, bid_amount, bid_received_on, bid_source, decline_reason) values
    (bp1, v_id[3], v_name[3], 'bids1@example.com', 'awarded',      '2025-04-02 09:00-04', '2025-04-02 13:00-04', '2025-04-22 15:00-04', 405000, '2025-04-22', 'portal', null),
    (bp1, v_id[4], v_name[4], 'bids2@example.com', 'bid_received', '2025-04-02 09:00-04', '2025-04-03 08:00-04', '2025-04-24 10:00-04', 438500, '2025-04-24', 'staff',  null),
    (bp1, v_id[6], v_name[6], 'bids3@example.com', 'declined',     '2025-04-02 09:00-04', '2025-04-04 16:00-04', '2025-04-07 09:00-04', null,   null,         null,     'Too busy'),
    (bp2, v_id[1], v_name[1], 'bids4@example.com', 'pending',      '2026-01-05 09:00-05', null,                  null,                  null,   null,         null,     null);
  update public.bid_packages set awarded_invite_id = (select id from public.bid_invites where package_id = bp1 and status = 'awarded') where id = bp1;

  -- ---- To-dos -------------------------------------------------------------
  insert into public.project_todo_items (project_id, title, position, completed, created_by_name)
  values (p, 'Close out documents', 1, true, tag) returning id into td1;
  insert into public.project_todo_items (project_id, title, position, completed, created_by_name) values
    (p, 'Warranty binder to owner', 2, true,  tag),
    (p, 'Final lien waivers',       3, false, tag);
  insert into public.project_todo_subitems (todo_item_id, project_id, label, completed)
  values (td1, p, 'As-built drawings', true), (td1, p, 'O&M manuals', true);

  -- ---- Project team -------------------------------------------------------
  if s_auth is not null then
    for i in 1..array_length(s_auth, 1) loop
      insert into public.project_members (project_id, user_id, role, can_view_financials)
      values (p, s_auth[i], (array['project_manager','accounting','staff'])[i], i <= 2)
      on conflict (project_id, user_id) do nothing;
    end loop;
  end if;

  raise notice 'Test data added to the test project.';
end $$;

alter table public.incident_reports enable trigger incident_reports_set_defaults;
alter table public.incident_reports enable trigger incident_reports_log_submitted;

commit;
