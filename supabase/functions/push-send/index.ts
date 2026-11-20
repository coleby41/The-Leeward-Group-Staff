// Phone push notifications (Coleby, 2026-11-20). Everything that lands in
// the notification center (the `notifications` table) is also pushed to the
// phones / computers where that staff member turned on notifications
// (push_subscriptions). Works for the portal saved to the Home Screen on
// iPhone (iOS 16.4+), Android and desktop browsers.
//
//   { action: "public_key" }            staff — the VAPID public key the
//                                       browser needs to subscribe
//   { action: "test" }                  staff — sends a test to your own devices
//   { action: "notify", notification_id }
//       called by the notifications insert trigger
//       (sql/supabase-push-notifications-setup.sql) with the service-role
//       key. A notification for one person (user_id) goes to their devices;
//       one with no user_id (everyone) goes to every device.
//
// Secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   from: npx web-push generate-vapid-keys
//   VAPID_SUBJECT                          e.g. mailto:you@example.com
//   STAFF_PORTAL_URL                       (already set) — makes relative links absolute
//
// Deploy:  supabase functions deploy push-send

import webpush from "npm:web-push@3.6.7";
import { CORS_HEADERS, SERVICE_ROLE_KEY, json, serviceClient } from "../_shared/bid-common.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:no-reply@theleewardgroup.us";
const PORTAL = (Deno.env.get("STAFF_PORTAL_URL") || "").replace(/\/+$/, "");

const fail = (error: string, status = 400) => json({ ok: false, error }, status);

// The gateway already checked the JWT's signature (deployed with JWT
// verification on), so its role claim can be trusted here.
function isServiceRoleJwt(token: string): boolean {
  try {
    const part = token.split(".")[1];
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return payload?.role === "service_role";
  } catch { return false; }
}

async function requireStaff(req: Request, admin: Row) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: fail("Please sign in again.", 401) };
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return { error: fail("Your session has expired. Please sign in again.", 401) };
  const { data: staff } = await admin.from("staff_users").select("id, full_name, active").eq("auth_user_id", data.user.id).maybeSingle();
  if (!staff || staff.active === false) return { error: fail("This account can't do that.", 403) };
  return { staff };
}

// Unread count for the app icon badge (same rule as the bell: newest 50).
async function unreadCount(admin: Row, staffId: string): Promise<number | null> {
  try {
    const { data: rows } = await admin.from("notifications").select("id")
      .or(`user_id.is.null,user_id.eq.${staffId}`).order("created_at", { ascending: false }).limit(50);
    const ids = (rows || []).map((r: Row) => r.id);
    if (!ids.length) return 0;
    const { data: reads } = await admin.from("notification_reads").select("notification_id").eq("staff_user_id", staffId).in("notification_id", ids);
    return ids.length - (reads || []).length;
  } catch { return null; }
}

function absolute(url: unknown): string {
  const s = String(url || "").trim();
  if (!s) return "/pages/notifications";
  if (/^https?:\/\//i.test(s)) return s;
  return `${PORTAL}${s.startsWith("/") ? "" : "/"}${s}`;
}

// Encrypts and sends one push with fetch. Returns the HTTP status.
async function pushTo(sub: Row, payload: Row): Promise<number> {
  const details = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { TTL: 60 * 60 * 24, urgency: "high", vapidDetails: { subject: SUBJECT, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY } },
  );
  const res = await fetch(details.endpoint, { method: "POST", headers: details.headers as Record<string, string>, body: details.body });
  await res.body?.cancel();
  return res.status;
}

async function sendAll(admin: Row, subs: Row[], payloadFor: (sub: Row) => Promise<Row>) {
  let sent = 0, removed = 0;
  for (const sub of subs) {
    try {
      const status = await pushTo(sub, await payloadFor(sub));
      if (status === 404 || status === 410) {
        // The device unsubscribed or the app was removed — forget it.
        await admin.from("push_subscriptions").delete().eq("id", sub.id);
        removed++;
      } else if (status >= 200 && status < 300) {
        sent++;
        await admin.from("push_subscriptions").update({ last_sent_at: new Date().toISOString(), last_error: null }).eq("id", sub.id);
      } else {
        await admin.from("push_subscriptions").update({ last_error: `HTTP ${status}` }).eq("id", sub.id);
      }
    } catch (error) {
      console.error("push failed:", error);
      await admin.from("push_subscriptions").update({ last_error: String((error as Error)?.message || error).slice(0, 300) }).eq("id", sub.id);
    }
  }
  return { sent, removed };
}

async function notify(admin: Row, body: Row) {
  const { data: n, error } = await admin.from("notifications").select("*").eq("id", body.notification_id).maybeSingle();
  if (error) throw error;
  if (!n) return fail("not_found", 404);
  let q = admin.from("push_subscriptions").select("*");
  if (n.user_id) q = q.eq("staff_id", n.user_id);
  const { data: subs, error: subError } = await q;
  if (subError) throw subError;
  if (!subs?.length) return json({ ok: true, sent: 0 });
  const badges = new Map<string, number | null>();
  const result = await sendAll(admin, subs, async (sub) => {
    if (!badges.has(sub.staff_id)) badges.set(sub.staff_id, await unreadCount(admin, sub.staff_id));
    return {
      title: n.title || "The Leeward Group",
      body: n.message || "",
      url: absolute(n.link_url),
      tag: String(n.id),
      badge: badges.get(sub.staff_id),
    };
  });
  return json({ ok: true, ...result });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail("POST only", 405);
  let body: Row;
  try { body = await req.json(); } catch { return fail("Invalid JSON body"); }
  const admin = serviceClient();
  const action = String(body?.action || "");
  if (!PUBLIC_KEY || !PRIVATE_KEY) return fail("Push isn't set up yet (VAPID keys missing).", 503);
  try {
    if (action === "notify") {
      // Only the database trigger (service-role key) can fan out pushes.
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token || (token !== SERVICE_ROLE_KEY && !isServiceRoleJwt(token))) return fail("Not allowed.", 403);
      return await notify(admin, body);
    }
    const auth = await requireStaff(req, admin);
    if (auth.error) return auth.error;
    if (action === "public_key") return json({ ok: true, key: PUBLIC_KEY });
    if (action === "test") {
      const { data: subs } = await admin.from("push_subscriptions").select("*").eq("staff_id", auth.staff.id);
      if (!subs?.length) return fail("This device isn't signed up for notifications yet.", 409);
      const result = await sendAll(admin, subs, async () => ({
        title: "Notifications are on",
        body: "This is how Leeward portal notifications will show up on this device.",
        url: absolute("/pages/notifications"),
        tag: "test",
      }));
      return json({ ok: true, ...result });
    }
    return fail(`Unknown action "${action}"`);
  } catch (error) {
    console.error(`push-send ${action} failed:`, error);
    return fail("Something went wrong sending the notification.", 500);
  }
});
