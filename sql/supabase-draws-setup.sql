-- ============================================================================
-- supabase-draws-setup.sql
--
-- Draws (AIA pay applications) — Accounting › Draws and Accounting › Budget.
-- Built Nov 16, 2026 from the Wrightsboro Business Park AIA draw workbook.
-- Plan: claude/draws-feature-plan.md in the Project.
--
-- HOW IT FITS TOGETHER
--   budget_sections  the groups on the continuation sheet (Land, Soft Costs,
--                    Building 1 › 03 Concrete…)
--   budget_lines     one row per continuation-sheet line: total budget and
--                    equity budget (loan budget = total − equity)
--   draws            one row per monthly draw (#16, #17…). The workbook's
--                    history comes in as ONE "opening balance" draw.
--   draw_lines       what each draw adds to each line: equity this period,
--                    loan this period, stored materials. "Previous" and
--                    "total to date" are always summed from earlier draws.
--   project_invoices gets budget_line_id (which line it's for), draw_id
--                    (the draw it landed in) and is_stored_material.
--   vpos             gets budget_line_id (the line a VPO created/increased).
--
-- WHO CAN DO WHAT (permissions table, checked by draws_access()):
--   draws.view            see Draws + Budget, download PDF/Excel
--   draws.edit            create/fill a draft, tag invoices to lines
--   draws.submit          submit (locks it), mark funded, reopen
--   draws.manage_budget   import the workbook, edit budget lines
--   Accounting + Super Admin workgroups get all four. The project's PM
--   (project_members.role = 'project_manager') gets view/edit/submit on
--   their own projects.
--
-- Safe to re-run. Run in Supabase → SQL Editor.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
create table if not exists public.budget_sections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  parent_id uuid references public.budget_sections(id) on delete cascade,
  name text not null,
  cost_type text not null default 'hard' check (cost_type in ('land', 'hard', 'soft', 'finance')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists budget_sections_project_idx on public.budget_sections (project_id, sort_order);

create table if not exists public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  section_id uuid references public.budget_sections(id) on delete set null,
  description text not null,
  total_budget numeric(14, 2) not null default 0,
  equity_budget numeric(14, 2) not null default 0,
  retainage_pct numeric(5, 2) not null default 0,
  sort_order integer not null default 0,
  source text not null default 'manual' check (source in ('import', 'vpo', 'manual')),
  vpo_id uuid,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists budget_lines_project_idx on public.budget_lines (project_id, sort_order);
create index if not exists budget_lines_section_idx on public.budget_lines (section_id);

create table if not exists public.draws (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  draw_number integer not null,
  draw_label text,                         -- "#1–15" for the opening balance
  period_to date,
  application_date date,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'funded')),
  is_opening_balance boolean not null default false,
  submitted_at timestamptz,
  submitted_by_name text,
  funded_at timestamptz,
  funded_amount numeric(14, 2),
  pdf_file_id uuid references public.project_files(id) on delete set null,
  xlsx_file_id uuid references public.project_files(id) on delete set null,
  notes text,
  created_by uuid references public.staff_users(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, draw_number)
);
create index if not exists draws_project_idx on public.draws (project_id, draw_number);

create table if not exists public.draw_lines (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null references public.draws(id) on delete cascade,
  budget_line_id uuid not null references public.budget_lines(id) on delete cascade,
  equity_this_period numeric(14, 2) not null default 0,
  loan_this_period numeric(14, 2) not null default 0,
  stored_materials numeric(14, 2) not null default 0,
  note text,
  unique (draw_id, budget_line_id)
);
create index if not exists draw_lines_line_idx on public.draw_lines (budget_line_id);


-- ----------------------------------------------------------------------------
-- 2. Invoices + VPOs point at budget lines
-- ----------------------------------------------------------------------------
alter table public.project_invoices
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null,
  add column if not exists draw_id uuid references public.draws(id) on delete set null,
  add column if not exists is_stored_material boolean not null default false;
create index if not exists project_invoices_budget_line_idx on public.project_invoices (budget_line_id);

do $$
begin
  if to_regclass('public.vpos') is not null then
    execute 'alter table public.vpos add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 3. Permissions
-- ----------------------------------------------------------------------------
insert into public.permissions (key, category, page_label, label, description, governed_by, sort_order) values
  ('draws.view',          'Draws', 'Accounting', 'View Draws & Budget',   'See the Draws and Budget tabs and download draw PDFs / Excel', 'workgroup', 80),
  ('draws.edit',          'Draws', 'Accounting', 'Prepare Draws',         'Create and fill in a draft draw, tag invoices to budget lines', 'workgroup', 81),
  ('draws.submit',        'Draws', 'Accounting', 'Submit Draws',          'Submit a draw (locks it and files the PDF), mark funded, reopen', 'workgroup', 82),
  ('draws.manage_budget', 'Draws', 'Accounting', 'Manage Project Budget', 'Import the AIA workbook and add / edit / reorder budget lines', 'workgroup', 83)
on conflict (key) do update set
  category = excluded.category, page_label = excluded.page_label, label = excluded.label,
  description = excluded.description, governed_by = excluded.governed_by, sort_order = excluded.sort_order;

insert into public.workgroup_permissions (workgroup_id, permission_key)
select w.id, p.key
from public.workgroups w
cross join (values ('draws.view'), ('draws.edit'), ('draws.submit'), ('draws.manage_budget')) as p(key)
where w.name in ('Accounting', 'Super Admin')
on conflict (workgroup_id, permission_key) do nothing;

-- One call the page makes to learn what this person can do on THIS project:
-- workgroup permissions, plus view/edit/submit for the project's PM.
create or replace function public.draws_access(p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with pm as (
    select exists (
      select 1 from public.project_members m
       where m.project_id = p_project_id
         and m.user_id = auth.uid()
         and m.role in ('project_manager', 'project_admin')
    ) as is_pm
  )
  select jsonb_build_object(
    'view',          public.has_permission('draws.view')          or pm.is_pm,
    'edit',          public.has_permission('draws.edit')          or pm.is_pm,
    'submit',        public.has_permission('draws.submit')        or pm.is_pm,
    'manage_budget', public.has_permission('draws.manage_budget')
  )
  from pm;
$$;
revoke all on function public.draws_access(uuid) from public, anon;
grant execute on function public.draws_access(uuid) to authenticated;

create or replace function public.draws_can(p_project_id uuid, p_what text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.draws_access(p_project_id) ->> p_what)::boolean, false);
$$;
revoke all on function public.draws_can(uuid, text) from public, anon;
grant execute on function public.draws_can(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. Row level security
--    read: draws.view (or PM) · budget writes: manage_budget
--    draw writes: edit, but only while the draw is a draft — submit/funded
--    changes need draws.submit.
-- ----------------------------------------------------------------------------
alter table public.budget_sections enable row level security;
alter table public.budget_lines    enable row level security;
alter table public.draws           enable row level security;
alter table public.draw_lines      enable row level security;

drop policy if exists budget_sections_select on public.budget_sections;
create policy budget_sections_select on public.budget_sections for select to authenticated
  using (public.draws_can(project_id, 'view'));
drop policy if exists budget_sections_write on public.budget_sections;
create policy budget_sections_write on public.budget_sections for all to authenticated
  using (public.draws_can(project_id, 'manage_budget'))
  with check (public.draws_can(project_id, 'manage_budget'));

drop policy if exists budget_lines_select on public.budget_lines;
create policy budget_lines_select on public.budget_lines for select to authenticated
  using (public.draws_can(project_id, 'view') or public.is_active_staff());   -- invoice form needs the line names
drop policy if exists budget_lines_write on public.budget_lines;
create policy budget_lines_write on public.budget_lines for all to authenticated
  using (public.draws_can(project_id, 'manage_budget'))
  with check (public.draws_can(project_id, 'manage_budget'));
-- A filed VPO adds to its line even for someone without manage_budget.
drop policy if exists budget_lines_vpo_insert on public.budget_lines;
create policy budget_lines_vpo_insert on public.budget_lines for insert to authenticated
  with check (source = 'vpo' and public.is_active_staff());

drop policy if exists draws_select on public.draws;
create policy draws_select on public.draws for select to authenticated
  using (public.draws_can(project_id, 'view'));
drop policy if exists draws_insert on public.draws;
create policy draws_insert on public.draws for insert to authenticated
  with check (
    (status = 'draft' and public.draws_can(project_id, 'edit'))
    or (is_opening_balance and public.draws_can(project_id, 'manage_budget'))
  );
drop policy if exists draws_update on public.draws;
create policy draws_update on public.draws for update to authenticated
  using (
    (status = 'draft' and public.draws_can(project_id, 'edit'))
    or public.draws_can(project_id, 'submit')
    or (is_opening_balance and public.draws_can(project_id, 'manage_budget'))
  )
  with check (
    (status = 'draft' and public.draws_can(project_id, 'edit'))
    or public.draws_can(project_id, 'submit')
    or (is_opening_balance and public.draws_can(project_id, 'manage_budget'))
  );
drop policy if exists draws_delete on public.draws;
create policy draws_delete on public.draws for delete to authenticated
  using (
    (status = 'draft' and public.draws_can(project_id, 'edit'))
    or (is_opening_balance and public.draws_can(project_id, 'manage_budget'))
  );

drop policy if exists draw_lines_select on public.draw_lines;
create policy draw_lines_select on public.draw_lines for select to authenticated
  using (exists (select 1 from public.draws d where d.id = draw_id and public.draws_can(d.project_id, 'view')));
drop policy if exists draw_lines_write on public.draw_lines;
create policy draw_lines_write on public.draw_lines for all to authenticated
  using (exists (
    select 1 from public.draws d where d.id = draw_id
       and ((d.status = 'draft' and public.draws_can(d.project_id, 'edit'))
            or (d.is_opening_balance and public.draws_can(d.project_id, 'manage_budget')))))
  with check (exists (
    select 1 from public.draws d where d.id = draw_id
       and ((d.status = 'draft' and public.draws_can(d.project_id, 'edit'))
            or (d.is_opening_balance and public.draws_can(d.project_id, 'manage_budget')))));

revoke all on public.budget_sections, public.budget_lines, public.draws, public.draw_lines from anon;
grant select, insert, update, delete on public.budget_sections, public.budget_lines, public.draws, public.draw_lines to authenticated;


-- ----------------------------------------------------------------------------
-- 5. updated_at stamps
-- ----------------------------------------------------------------------------
create or replace function public.draws_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists budget_lines_touch on public.budget_lines;
create trigger budget_lines_touch before update on public.budget_lines
  for each row execute function public.draws_touch_updated_at();
drop trigger if exists draws_touch on public.draws;
create trigger draws_touch before update on public.draws
  for each row execute function public.draws_touch_updated_at();


-- ============================================================================
-- Sanity checks (run after):
--   select key, label from public.permissions where key like 'draws.%';          -- 4 rows
--   select w.name, wp.permission_key from public.workgroup_permissions wp
--     join public.workgroups w on w.id = wp.workgroup_id
--    where wp.permission_key like 'draws.%' order by 1, 2;                        -- Accounting + Super Admin × 4
--   select public.draws_access('<a project id>');                                 -- {"view": true, ...} for you
--   select column_name from information_schema.columns
--    where table_name = 'project_invoices' and column_name in ('budget_line_id', 'draw_id', 'is_stored_material'); -- 3 rows
-- ============================================================================
