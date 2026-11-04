-- Siri "Update Timeline" setup: personal codes + change log.
-- Safe to run more than once.

-- 1) Personal Siri codes. The portal stores only a SHA-256 hash of each code;
--    the code itself lives in the employee's iPhone shortcut.
create table if not exists public.siri_tokens (
  id            uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references public.staff_users(id) on delete cascade,
  staff_name    text,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked       boolean not null default false
);
create index if not exists siri_tokens_staff_idx on public.siri_tokens (staff_user_id);

alter table public.siri_tokens enable row level security;
-- Same anon pattern as the rest of the portal (custom auth, no auth.uid()).
-- The portal inserts new codes; only hashes are stored, so reading them is harmless.
drop policy if exists "siri_tokens_all_anon" on public.siri_tokens;
create policy "siri_tokens_all_anon" on public.siri_tokens
  for all to anon using (true) with check (true);

-- 2) Log of every Siri change (powers "undo" and shows who did what).
create table if not exists public.timeline_voice_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  batch_id    uuid not null,
  project_id  uuid,
  item_id     uuid not null,
  command     text not null,
  before      jsonb not null,
  after       jsonb not null,
  undone      boolean not null default false
);
-- Columns added for the schedule_* version (in case the first version was already run)
alter table public.timeline_voice_log add column if not exists item_table text not null default 'schedule_tasks';
alter table public.timeline_voice_log add column if not exists staff_user_id uuid references public.staff_users(id);

create index if not exists timeline_voice_log_batch_idx on public.timeline_voice_log (batch_id);
create index if not exists timeline_voice_log_staff_idx on public.timeline_voice_log (staff_user_id, created_at desc);

-- RLS on with no anon policies: only the Edge Function (service role) touches the log.
alter table public.timeline_voice_log enable row level security;

-- Sanity checks
select count(*) as siri_tokens from public.siri_tokens;
select count(*) as voice_log_rows from public.timeline_voice_log;
