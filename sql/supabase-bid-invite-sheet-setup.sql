-- =============================================================================
-- Bids › Invite Sheet (Coleby, 2026-11-27)
--
-- The Invite Sheet on a project's Bids tab lists every cost code with the
-- vendors tagged for it. Codes a job doesn't need (no pool, no elevator) can
-- be hidden for that project only. This table remembers which ones.
--
-- Hiding a code never touches bids already sent, and it can be shown again
-- any time ("Show hidden codes" on the sheet).
--
-- Who: anyone who can send or manage bid invites. Safe to run more than once.
-- Needs supabase-bid-leveling-setup.sql first.
-- =============================================================================

create table if not exists public.bid_project_hidden_codes (
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code text not null references public.bid_cost_codes(code) on update cascade on delete cascade,
  hidden_by_name text,
  created_at timestamptz not null default now(),
  primary key (project_id, cost_code)
);

alter table public.bid_project_hidden_codes enable row level security;

drop policy if exists "bid_project_hidden_codes_select" on public.bid_project_hidden_codes;
create policy "bid_project_hidden_codes_select" on public.bid_project_hidden_codes
  for select to authenticated using (public.can_view_bid_invites());

drop policy if exists "bid_project_hidden_codes_insert" on public.bid_project_hidden_codes;
create policy "bid_project_hidden_codes_insert" on public.bid_project_hidden_codes
  for insert to authenticated
  with check (public.has_permission('vendors.send_bid_invites') or public.has_permission('projects.manage_bid_invites'));

drop policy if exists "bid_project_hidden_codes_delete" on public.bid_project_hidden_codes;
create policy "bid_project_hidden_codes_delete" on public.bid_project_hidden_codes
  for delete to authenticated
  using (public.has_permission('vendors.send_bid_invites') or public.has_permission('projects.manage_bid_invites'));
