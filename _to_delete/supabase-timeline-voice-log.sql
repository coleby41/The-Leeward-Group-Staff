-- Log of every change made by the Siri shortcut (lets "undo" work and gives an audit trail).
create table if not exists public.timeline_voice_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  batch_id    uuid not null,            -- one voice command = one batch (includes cascaded rows)
  project_id  uuid,
  item_id     uuid not null,
  command     text not null,            -- what Siri heard
  before      jsonb not null,
  after       jsonb not null,
  undone      boolean not null default false
);

create index if not exists timeline_voice_log_batch_idx on public.timeline_voice_log (batch_id);
create index if not exists timeline_voice_log_created_idx on public.timeline_voice_log (created_at desc);

-- RLS on with no anon policies: only the Edge Function (service role) can read/write it.
alter table public.timeline_voice_log enable row level security;

-- Sanity check
select count(*) as log_rows from public.timeline_voice_log;
