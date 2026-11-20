-- ============================================================================
-- Phone push notifications (Coleby, 2026-11-20)
--
-- Everything that lands in the notification center (public.notifications)
-- is also pushed to every phone / computer where that staff member tapped
-- "Turn on phone notifications" (Notifications page or the bell).
-- Notifications with no user_id (for everyone) go to every device.
--
--   1. push_subscriptions: one row per device (browser push subscription).
--      Staff add / remove / see only their own (current_staff_id()); the
--      push-send Edge Function (service role) reads them to send.
--   2. notifications insert trigger -> push-send (pg_net), using the
--      service-role key already saved in Vault for the COI emails
--      ('coi_reminders_service_role_key', see
--      supabase-coi-notifications-cron-setup.sql STEP 1). If that secret
--      isn't there, notifications still save — they just aren't pushed.
--
-- Before running: deploy push-send and set its VAPID secrets (see the
-- function's header). Safe to re-run.
-- ============================================================================

create extension if not exists pg_net;


-- 1. push_subscriptions -----------------------------------------------------------

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text
);

create index if not exists push_subscriptions_staff_idx on public.push_subscriptions (staff_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());

-- A device that someone else signed in on before: hand the subscription
-- over to whoever turns notifications on now (the endpoint is unique, and
-- RLS hides the other person's row from the client's upsert).
create or replace function public.claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
begin
  if v_staff is null then
    raise exception 'not signed in';
  end if;
  insert into public.push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent)
  values (v_staff, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_error = null;
end;
$$;

revoke all on function public.claim_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.claim_push_subscription(text, text, text, text) to authenticated;


-- 2. notifications -> push ----------------------------------------------------------

create or replace function public.push_new_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  -- Nobody to send to? Skip the call.
  if new.user_id is not null and not exists (select 1 from public.push_subscriptions where staff_id = new.user_id) then
    return new;
  end if;
  if new.user_id is null and not exists (select 1 from public.push_subscriptions) then
    return new;
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'coi_reminders_service_role_key';
  if v_key is null then
    return new;   -- Vault secret not set up: still save the notification
  end if;

  perform net.http_post(
    url := 'https://ostaqjuawieqpwuhrvsm.supabase.co/functions/v1/push-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('action', 'notify', 'notification_id', new.id)
  );
  return new;
exception when others then
  -- Never block a notification because the push call failed.
  raise warning 'push_new_notification failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push
  after insert on public.notifications
  for each row execute function public.push_new_notification();


-- ============================================================================
-- Sanity checks -- run after the above:
--   select count(*) from public.push_subscriptions;                            -- 0 until someone turns it on
--   select name from vault.decrypted_secrets where name = 'coi_reminders_service_role_key';   -- 1 row
--   -- after turning it on on your phone, send yourself one:
--   insert into public.notifications (user_id, title, message, type, link_url)
--   values ((select id from public.staff_users where full_name = '<your name>'), 'Test', 'Hello from the portal', 'general', '/pages/notifications');
--   select id, status_code, content from net._http_response order by id desc limit 3;  -- 200 = sent
-- ============================================================================
