-- ============================================================================
-- supabase-bids-v2-setup.sql  (2026-11-26)
--
-- Bids v2: one Bids tab per project (pages/project-bids.html) replaces Bid
-- Invites + Bid Leveling. A package can be SPLIT: each line (building type +
-- cost code) gets its own winner, e.g. Foundations to GBS, Termite to Reaves.
--
--   bid_lines.winner_invite_id  the vendor (bid_invites row) awarded that line.
--     Set by the bid-invites Edge Function's "award_split" action, which also
--     marks every winner 'awarded' (awarded_amount = what they won, or the
--     negotiated amount), the other bidders 'not_selected', and the package
--     'awarded'. Each winner gets one contract for what they won.
--
-- PREREQUISITE: supabase-bid-leveling-setup.sql. Safe to re-run.
-- Run in Supabase -> SQL Editor.
-- ============================================================================

alter table public.bid_lines
  add column if not exists winner_invite_id uuid references public.bid_invites(id) on delete set null;

create index if not exists bid_lines_winner_invite_id_idx on public.bid_lines (winner_invite_id);

-- Sanity check (read-only): lines with a winner, by vendor.
--   select i.company_name, count(*) as lines
--   from public.bid_lines l join public.bid_invites i on i.id = l.winner_invite_id
--   group by i.company_name order by 1;
