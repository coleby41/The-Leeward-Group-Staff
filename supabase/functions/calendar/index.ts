// supabase/functions/calendar/index.ts
// Calendar connections for the staff portal's Home › Today (2026-11-18).
// See sql/supabase-calendar-sync-setup.sql for the tables.
//
// One function for everything:
//   POST {action:"oauth_start", provider:"microsoft"|"google"}  -> { url }   (browser then goes there)
//   GET  ?action=callback&code=…&state=…                         (Microsoft/Google send people back here)
//   POST {action:"caldav_connect", username, app_password}       (Apple iCloud)
//   POST {action:"sync"}                                          (refresh events now)
//   POST {action:"disconnect"}
// Every POST must carry the signed-in staff member's session
// (Authorization: Bearer <access token>). The callback is checked with a
// signed "state" instead.
//
// Deploy:  supabase functions deploy calendar --no-verify-jwt
//
// Secrets (Supabase → Edge Functions → Secrets):
//   CALENDAR_SECRET        any long random string — signs sign-in requests and
//                          encrypts tokens/passwords. Don't change it later
//                          (everyone would have to link again).
//   MS_CLIENT_ID / MS_CLIENT_SECRET          Microsoft (Azure) app registration
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  Google Cloud OAuth client
//   STAFF_PORTAL_URL       optional — e.g. https://stafftheleewardgroup.vercel.app
// Redirect URI to register with BOTH Microsoft and Google:
//   https://<project-ref>.supabase.co/functions/v1/calendar?action=callback

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("CALENDAR_SECRET") || "";
const PORTAL = (Deno.env.get("STAFF_PORTAL_URL") || "https://stafftheleewardgroup.vercel.app").replace(/\/+$/, "");
const CALLBACK_URL = `${SUPABASE_URL}/functions/v1/calendar?action=callback`;
const TZ = "America/New_York";

const MS = {
  id: Deno.env.get("MS_CLIENT_ID") || "",
  secret: Deno.env.get("MS_CLIENT_SECRET") || "",
  auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scope: "offline_access openid email User.Read Calendars.Read",
};
const GOOGLE = {
  id: Deno.env.get("GOOGLE_CLIENT_ID") || "",
  secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const back = (ok: boolean, detail = "") =>
  Response.redirect(`${PORTAL}/pages/dashboard.html?calendar_connected=${ok ? "1" : "0"}${detail ? `&calendar_detail=${encodeURIComponent(detail)}` : ""}`, 302);

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
type Row = any;

/* ---------------- crypto: signed state + encrypted secrets ---------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function hmacKey() {
  return crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function aesKey() {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`aes:${SECRET}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function signState(data: Record<string, unknown>) {
  const body = b64u(enc.encode(JSON.stringify(data)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return `${body}.${sig}`;
}
async function readState(state: string): Promise<Row | null> {
  const [body, sig] = (state || "").split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), fromB64u(sig), enc.encode(body));
  if (!ok) return null;
  const data = JSON.parse(dec.decode(fromB64u(body)));
  return data.exp > Date.now() ? data : null;
}
async function seal(obj: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(JSON.stringify(obj)));
  return `${b64u(iv)}.${b64u(ct)}`;
}
async function unseal(s: string | null): Promise<Row> {
  if (!s) return {};
  const [iv, ct] = s.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(iv) }, await aesKey(), fromB64u(ct));
  return JSON.parse(dec.decode(pt));
}

/* ---------------- who's calling ---------------- */

async function staffFrom(req: Request): Promise<{ id: string } | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: staff } = await db.from("staff_users").select("id, active").eq("auth_user_id", data.user.id).maybeSingle();
  return staff && staff.active !== false ? { id: staff.id } : null;
}

/* ---------------- time helpers ---------------- */

// Offset (minutes) of a time zone at a given UTC instant, e.g. -300 for New York in winter.
function tzOffset(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(at).reduce((o: Row, p) => (o[p.type] = p.value, o), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return (asUTC - at.getTime()) / 60000;
}
// A wall-clock time in a zone → the real instant.
function zoned(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  try {
    const off1 = tzOffset(tz, new Date(guess));
    let t = guess - off1 * 60000;
    const off2 = tzOffset(tz, new Date(t));   // DST edge: re-check at the real instant
    if (off2 !== off1) t = guess - off2 * 60000;
    return new Date(t);
  } catch {
    return new Date(guess);                   // unknown zone: treat as UTC
  }
}
function windowRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 1));
  return { from, to };
}

/* ---------------- OAuth (Microsoft + Google) ---------------- */

function oauthConfig(provider: string) {
  if (provider === "microsoft") return MS;
  if (provider === "google") return GOOGLE;
  return null;
}

async function exchange(provider: string, params: Record<string, string>) {
  const c = oauthConfig(provider)!;
  const body = new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params });
  if (provider === "microsoft") body.set("scope", MS.scope);
  const res = await fetch(c.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `token request failed (${res.status})`);
  return data;
}

function emailFromIdToken(idToken?: string) {
  try {
    const payload = JSON.parse(dec.decode(fromB64u((idToken || "").split(".")[1])));
    return payload.email || payload.preferred_username || payload.upn || null;
  } catch { return null; }
}

// Fresh access token, refreshing if it's about to run out.
async function accessToken(acct: Row): Promise<string> {
  const secret = await unseal(acct.secret_enc);
  const exp = acct.token_expires_at ? new Date(acct.token_expires_at).getTime() : 0;
  if (secret.access_token && exp - Date.now() > 120000) return secret.access_token;
  if (!secret.refresh_token) throw new Error("Sign-in expired — reconnect your calendar.");
  const t = await exchange(acct.provider_id, { grant_type: "refresh_token", refresh_token: secret.refresh_token });
  const next = { access_token: t.access_token, refresh_token: t.refresh_token || secret.refresh_token };
  await db.from("calendar_accounts").update({
    secret_enc: await seal(next),
    token_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("user_id", acct.user_id);
  return t.access_token;
}

/* ---------------- fetching events ---------------- */

type Ev = { external_id: string; title: string; start_time: string; end_time: string | null; location: string | null; all_day: boolean };

async function microsoftEvents(acct: Row): Promise<Ev[]> {
  const token = await accessToken(acct);
  const { from, to } = windowRange();
  let url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}` +
    `&$select=id,subject,start,end,location,isAllDay,isCancelled,showAs&$top=250&$orderby=start/dateTime`;
  const out: Ev[] = [];
  for (let page = 0; url && page < 10; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Outlook returned ${res.status}`);
    for (const e of data.value || []) {
      if (e.isCancelled) continue;
      const allDay = !!e.isAllDay;
      const s = allDay ? dayStart(e.start.dateTime.slice(0, 10)) : new Date(e.start.dateTime + "Z");
      const en = allDay ? dayStart(e.end.dateTime.slice(0, 10)) : new Date(e.end.dateTime + "Z");
      out.push({ external_id: e.id, title: e.subject || "Busy", start_time: s.toISOString(), end_time: en.toISOString(), location: e.location?.displayName || null, all_day: allDay });
    }
    url = data["@odata.nextLink"] || "";
  }
  return out;
}

async function googleEvents(acct: Row): Promise<Ev[]> {
  const token = await accessToken(acct);
  const { from, to } = windowRange();
  const out: Ev[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250` +
      `&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Google returned ${res.status}`);
    for (const e of data.items || []) {
      if (e.status === "cancelled") continue;
      const allDay = !!e.start?.date;
      const s = allDay ? dayStart(e.start.date) : new Date(e.start.dateTime);
      const en = allDay ? dayStart(e.end.date) : new Date(e.end?.dateTime || e.start.dateTime);
      out.push({ external_id: e.id, title: e.summary || "Busy", start_time: s.toISOString(), end_time: en.toISOString(), location: e.location || null, all_day: allDay });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

// Midnight of a calendar date in the office time zone.
function dayStart(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return zoned(y, m, d, 0, 0, 0, TZ);
}

/* ---------------- Apple iCloud (CalDAV) ---------------- */

const ICLOUD = "https://caldav.icloud.com";

function basic(username: string, password: string) {
  return "Basic " + btoa(`${username}:${password}`);
}
async function dav(url: string, method: string, auth: string, body: string, depth = "0") {
  const res = await fetch(url, { method, headers: { Authorization: auth, Depth: depth, "Content-Type": "application/xml; charset=utf-8" }, body, redirect: "follow" });
  const text = await res.text();
  return { res, text, url: res.url || url };
}
const decodeXml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const hrefIn = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<[^>]*${tag}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<`, "i"));
  return m ? m[1].trim() : null;
};
const absolute = (href: string, base: string) => new URL(href, base).toString();

async function icloudDiscover(username: string, password: string) {
  const auth = basic(username, password);
  const p1 = await dav(`${ICLOUD}/`, "PROPFIND", auth, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
  if (p1.res.status === 401 || p1.res.status === 403) throw new Error("Apple didn't accept that Apple ID and app-specific password.");
  const principal = hrefIn(p1.text, "current-user-principal");
  if (!principal) throw new Error("Couldn't find your iCloud calendars.");
  const principalUrl = absolute(principal, p1.url);
  const p2 = await dav(principalUrl, "PROPFIND", auth, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
  const home = hrefIn(p2.text, "calendar-home-set");
  if (!home) throw new Error("Couldn't find your iCloud calendars.");
  const homeUrl = absolute(home, p2.url);
  const p3 = await dav(homeUrl, "PROPFIND", auth, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>`, "1");
  const cals: { url: string; name: string }[] = [];
  for (const block of p3.text.split(/<[^>]*:?response[\s>]/i).slice(1)) {
    if (!/<[^>]*calendar[\s/>]/i.test(block.match(/<[^>]*resourcetype[^>]*>([\s\S]*?)<\/[^>]*resourcetype>/i)?.[1] || "")) continue;
    if (/supported-calendar-component-set/i.test(block) && !/name="VEVENT"/i.test(block)) continue;
    const href = block.match(/<[^>]*href[^>]*>([^<]+)</i)?.[1];
    if (!href) continue;
    const name = decodeXml(block.match(/<[^>]*displayname[^>]*>([^<]*)</i)?.[1] || "Calendar");
    cals.push({ url: absolute(href.trim(), homeUrl), name });
  }
  if (!cals.length) throw new Error("No calendars found in that iCloud account.");
  return cals;
}

// Parse VEVENTs out of iCalendar text (recurrences already expanded by iCloud).
function parseIcs(ics: string, calName: string): Ev[] {
  const lines = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Ev[] = [];
  let cur: Row = null;
  const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
  const when = (key: string, val: string) => {
    const tzid = key.match(/TZID=([^;:]+)/i)?.[1];
    if (/VALUE=DATE(?!-)/i.test(key) || /^\d{8}$/.test(val)) {
      return { date: dayStart(`${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`), allDay: true };
    }
    const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : zoned(+y, +mo, +d, +h, +mi, +s, tzid || TZ);
    return { date, allDay: false };
  };
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur?.start && cur.status !== "CANCELLED") {
        out.push({
          external_id: `${cur.uid || crypto.randomUUID()}${cur.rid ? "#" + cur.rid : ""}`,
          title: cur.summary || calName || "Busy",
          start_time: cur.start.date.toISOString(),
          end_time: (cur.end?.date || cur.start.date).toISOString(),
          location: cur.location || null,
          all_day: cur.start.allDay,
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i), val = line.slice(i + 1);
    const name = key.split(";")[0].toUpperCase();
    if (name === "SUMMARY") cur.summary = unescape(val);
    else if (name === "LOCATION") cur.location = unescape(val);
    else if (name === "UID") cur.uid = val;
    else if (name === "RECURRENCE-ID") cur.rid = val;
    else if (name === "STATUS") cur.status = val.toUpperCase();
    else if (name === "DTSTART") cur.start = when(key, val);
    else if (name === "DTEND") cur.end = when(key, val);
  }
  return out;
}

async function icloudEvents(acct: Row): Promise<Ev[]> {
  const secret = await unseal(acct.secret_enc);
  const auth = basic(acct.external_account_email, secret.app_password);
  const { from, to } = windowRange();
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${f(from)}" end="${f(to)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${f(from)}" end="${f(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const out: Ev[] = [];
  for (const cal of (acct.caldav_calendars || []) as { url: string; name: string }[]) {
    const r = await dav(cal.url, "REPORT", auth, body, "1");
    if (r.res.status === 401 || r.res.status === 403) throw new Error("Apple stopped accepting the app-specific password — reconnect your calendar.");
    if (!r.res.ok && r.res.status !== 207) continue;
    for (const m of r.text.matchAll(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi)) {
      out.push(...parseIcs(decodeXml(m[1]), cal.name));
    }
  }
  return out;
}

/* ---------------- sync ---------------- */

async function syncUser(userId: string) {
  const { data: acct } = await db.from("calendar_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!acct) return { status: "none" };
  try {
    const events = acct.provider_id === "microsoft" ? await microsoftEvents(acct)
      : acct.provider_id === "google" ? await googleEvents(acct)
      : await icloudEvents(acct);
    // Same event can come from more than one iCloud calendar — keep one.
    const seen = new Set<string>();
    const rows = events.filter(e => (seen.has(e.external_id + e.start_time) ? false : (seen.add(e.external_id + e.start_time), true)))
      .map(e => ({ ...e, user_id: userId, provider_id: acct.provider_id }));
    await db.from("calendar_events_cache").delete().eq("user_id", userId);
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("calendar_events_cache").insert(rows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }
    await db.from("calendar_accounts").update({ status: "connected", last_error: null, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId);
    return { status: "connected", count: rows.length };
  } catch (e) {
    const message = (e as Error).message || "Sync failed.";
    await db.from("calendar_accounts").update({ status: "error", last_error: message, updated_at: new Date().toISOString() }).eq("user_id", userId);
    return { status: "error", message };
  }
}

/* ---------------- handler ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SECRET) return json({ error: "CALENDAR_SECRET isn't set on the server yet." }, 500);
  const url = new URL(req.url);

  try {
    // Microsoft / Google send the person back here after they approve.
    if (req.method === "GET" && url.searchParams.get("action") === "callback") {
      const state = await readState(url.searchParams.get("state") || "");
      if (!state) return back(false, "That sign-in link expired. Try again.");
      if (url.searchParams.get("error")) return back(false, url.searchParams.get("error_description") || "Access wasn't granted.");
      const t = await exchange(state.p, { grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: CALLBACK_URL });
      let email = emailFromIdToken(t.id_token);
      if (!email && state.p === "microsoft") {
        const me = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json()).catch(() => ({}));
        email = me.mail || me.userPrincipalName || null;
      }
      await db.from("calendar_accounts").upsert({
        user_id: state.u, provider_id: state.p, status: "connected", external_account_email: email,
        secret_enc: await seal({ access_token: t.access_token, refresh_token: t.refresh_token }),
        token_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
        caldav_calendars: null, last_error: null, updated_at: new Date().toISOString(),
      });
      await syncUser(state.u);
      return back(true);
    }

    if (req.method !== "POST") return json({ error: "Not found." }, 404);
    const staff = await staffFrom(req);
    if (!staff) return json({ error: "Please sign in again." }, 401);
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "oauth_start": {
        const provider = String(body.provider || "");
        const c = oauthConfig(provider);
        if (!c) return json({ error: "Unknown calendar." }, 400);
        if (!c.id || !c.secret) return json({ error: `${provider === "google" ? "Google" : "Microsoft"} sign-in isn't set up on the server yet.` }, 500);
        const state = await signState({ u: staff.id, p: provider, exp: Date.now() + 15 * 60000, n: crypto.randomUUID() });
        const q = new URLSearchParams({ client_id: c.id, response_type: "code", redirect_uri: CALLBACK_URL, scope: c.scope, state });
        if (provider === "google") { q.set("access_type", "offline"); q.set("prompt", "consent"); q.set("include_granted_scopes", "true"); }
        else q.set("prompt", "select_account");
        return json({ url: `${c.auth}?${q}` });
      }
      case "caldav_connect": {
        const username = String(body.username || "").trim();
        const password = String(body.app_password || "").trim();
        if (!username || !password) return json({ error: "Enter your Apple ID and app-specific password." }, 400);
        const calendars = await icloudDiscover(username, password);
        await db.from("calendar_accounts").upsert({
          user_id: staff.id, provider_id: "icloud", status: "connected", external_account_email: username,
          secret_enc: await seal({ app_password: password }), token_expires_at: null,
          caldav_calendars: calendars, last_error: null, updated_at: new Date().toISOString(),
        });
        const result = await syncUser(staff.id);
        return json({ ok: true, calendars: calendars.length, ...result });
      }
      case "sync":
        return json({ ok: true, synced: [await syncUser(staff.id)] });
      case "disconnect": {
        const { data: acct } = await db.from("calendar_accounts").select("provider_id, secret_enc").eq("user_id", staff.id).maybeSingle();
        if (acct?.provider_id === "google") {
          const s = await unseal(acct.secret_enc).catch(() => ({}));
          if (s.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refresh_token)}`, { method: "POST" }).catch(() => {});
        }
        await db.from("calendar_events_cache").delete().eq("user_id", staff.id);
        await db.from("calendar_accounts").delete().eq("user_id", staff.id);
        return json({ ok: true });
      }
      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    console.error("calendar:", e);
    if (req.method === "GET") return back(false, (e as Error).message);
    return json({ error: (e as Error).message || "Something went wrong." }, 500);
  }
});
