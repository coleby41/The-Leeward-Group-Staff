// My Calendar — iPhone widget feed (Coleby, 2026-11-20).
//
// The widget runs in the free Scriptable app, which can't sign in to the
// portal, so it uses a private widget link instead:
//
//   { action: "widget_token" }   staff (signed in) — makes a new widget link
//                                for you; the old one stops working. Only a
//                                hash of it is saved.
//   { action: "widget_off" }     staff — turns your widget link off.
//   GET ?token=...  or  { token }  — your next events (14 days, repeats
//                                expanded), for the widget. No sign-in.
//
// Deploy:  supabase functions deploy my-calendar --no-verify-jwt
// (no JWT check at the gateway: the widget calls it with only its token;
//  staff actions check the session themselves)

import { CORS_HEADERS, json, serviceClient } from "../_shared/bid-common.ts";
import { occurrencesBetween } from "../_shared/my-calendar.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const fail = (error: string, status = 400) => json({ ok: false, error }, status);
const DAYS_AHEAD = 14;
const MAX_ITEMS = 12;

async function sha256(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

async function feed(admin: Row, token: string) {
  if (!token || token.length < 20) return fail("Missing widget link.", 401);
  const { data: link } = await admin.from("my_calendar_widget_tokens").select("staff_id").eq("token_hash", await sha256(token)).maybeSingle();
  if (!link) return fail("This widget link was turned off. Make a new one on the portal's Home page.", 401);
  const { data: staff } = await admin.from("staff_users").select("full_name, active").eq("id", link.staff_id).maybeSingle();
  if (!staff || staff.active === false) return fail("This account can't use the widget.", 403);
  await admin.from("my_calendar_widget_tokens").update({ last_used_at: new Date().toISOString() }).eq("staff_id", link.staff_id);

  const { data: events, error } = await admin.from("my_calendar_events").select("*").eq("staff_id", link.staff_id);
  if (error) throw error;
  const now = new Date();
  const occs = occurrencesBetween(events || [], now, new Date(now.getTime() + DAYS_AHEAD * 86400000)).slice(0, MAX_ITEMS);
  return json({
    ok: true,
    name: staff.full_name || "",
    updated_at: now.toISOString(),
    events: occs.map((o) => ({
      id: o.event.id, title: o.event.title || "Event", location: o.event.location || "",
      all_day: Boolean(o.event.all_day), start: o.start.toISOString(), end: o.end.toISOString(), tz: o.event.tz || "America/New_York",
    })),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  const admin = serviceClient();
  try {
    if (req.method === "GET") return await feed(admin, new URL(req.url).searchParams.get("token") || "");
    if (req.method !== "POST") return fail("GET or POST only", 405);
    let body: Row;
    try { body = await req.json(); } catch { return fail("Invalid JSON body"); }
    if (body.token && !body.action) return await feed(admin, String(body.token));

    const auth = await requireStaff(req, admin);
    if (auth.error) return auth.error;
    if (body.action === "widget_token") {
      const token = randomToken();
      const { error } = await admin.from("my_calendar_widget_tokens")
        .upsert({ staff_id: auth.staff.id, token_hash: await sha256(token), created_at: new Date().toISOString(), last_used_at: null }, { onConflict: "staff_id" });
      if (error) throw error;
      return json({ ok: true, token });
    }
    if (body.action === "widget_off") {
      await admin.from("my_calendar_widget_tokens").delete().eq("staff_id", auth.staff.id);
      return json({ ok: true });
    }
    if (body.action === "widget_status") {
      const { data } = await admin.from("my_calendar_widget_tokens").select("created_at, last_used_at").eq("staff_id", auth.staff.id).maybeSingle();
      return json({ ok: true, on: Boolean(data), created_at: data?.created_at || null, last_used_at: data?.last_used_at || null });
    }
    return fail(`Unknown action "${body.action}"`);
  } catch (error) {
    console.error("my-calendar failed:", error);
    return fail("Something went wrong.", 500);
  }
});
