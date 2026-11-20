// Staff Calendar (Coleby, 2026-11-20) — pages/calendar.html.
// Events, people (invite / assign), answers, busy checks and the private
// calendar link for Google / Apple. Tables: my_calendar_events,
// calendar_event_people, calendar_feed_tokens, calendar_settings
// (sql/supabase-my-calendar-setup.sql + sql/supabase-staff-calendar-setup.sql).
//
// Signed-in staff (POST, Authorization: Bearer <session>):
//   { action: "save", event: {...}, people: [{ staff_id, role: "invite"|"assign" }] }
//       create / update (organizer only). New people get a bell + phone
//       notification; people taken off and people on a moved event are told too.
//   { action: "delete", id }                      organizer only; everyone is told
//   { action: "respond", id, response: "accepted"|"declined"|"conflict" }
//       an invitee answers; the organizer is told ("conflict" says with what,
//       so they can move it)
//   { action: "busy", staff_ids, start, end, exclude_id? }
//       who's busy then, with what (portal events by title; Google /
//       Outlook / iCloud events as "Busy")
//   { action: "suggest", staff_ids, minutes, from?, exclude_id? }
//       the next free times for everyone (your working hours, next 10 days)
//   { action: "feed_token" | "feed_off" | "feed_status" }   your private calendar link
// Google / Apple Calendar (no sign-in):
//   GET ?feed=<token>   your portal events as an .ics calendar
//
// Deploy:  supabase functions deploy staff-calendar --no-verify-jwt

import { CORS_HEADERS, json, serviceClient } from "../_shared/bid-common.ts";
import { addDays, occurrencesBetween, timeLabel, zonedToUtc, zonedToday } from "../_shared/my-calendar.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const fail = (error: string, status = 400) => json({ ok: false, error }, status);
const isUuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v || ""));
const clean = (v: unknown, max = 300) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"];
const REMINDERS = [0, 5, 15, 30, 60, 1440, 10080];
const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const isTime = (v: unknown) => /^\d{2}:\d{2}(:\d{2})?$/.test(String(v || ""));

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
  const { data: staff } = await admin.from("staff_users").select("id, full_name, username, active").eq("auth_user_id", data.user.id).maybeSingle();
  if (!staff || staff.active === false) return { error: fail("This account can't do that.", 403) };
  return { staff };
}

const nameOf = (s: Row) => s?.full_name || s?.username || "Someone";

async function notify(admin: Row, staffIds: string[], title: string, message: string, eventId: string | null) {
  const ids = [...new Set(staffIds.filter(Boolean))];
  if (!ids.length) return;
  const { error } = await admin.from("notifications").insert(ids.map((id) => ({
    user_id: id, title, message, type: "calendar",
    link_url: eventId ? `/pages/calendar.html?event=${eventId}` : "/pages/calendar.html", link_label: "Open calendar",
  })));
  if (error) console.error("calendar notify failed:", error.message);
}

function whenText(ev: Row): string {
  const occ = occurrencesBetween([{ ...ev, repeat: "none" }], new Date(Date.UTC(1970, 0, 1)), new Date(Date.UTC(2999, 0, 1)))[0];
  if (!occ) return ev.start_date;
  const t = timeLabel(ev, occ.start);
  return ev.repeat && ev.repeat !== "none" ? `${t} (repeats ${ev.repeat})` : t;
}

/* ---------------- busy ---------------- */

// Everything that keeps each person busy between two moments.
async function busyFor(admin: Row, staffIds: string[], from: Date, to: Date, excludeId?: string | null) {
  const out = new Map<string, { title: string; start: Date; end: Date; source: string }[]>();
  staffIds.forEach((id) => out.set(id, []));
  if (!staffIds.length) return out;
  const [own, people, settings] = await Promise.all([
    admin.from("my_calendar_events").select("*").in("staff_id", staffIds).eq("organizer_attends", true),
    admin.from("calendar_event_people").select("staff_id, response, role, my_calendar_events(*)").in("staff_id", staffIds).neq("response", "declined").neq("response", "conflict"),
    admin.from("calendar_settings").select("staff_id, google_busy").in("staff_id", staffIds),
  ]);
  const add = (staffId: string, ev: Row) => {
    if (!ev || ev.id === excludeId) return;
    for (const o of occurrencesBetween([ev], from, to)) {
      if (o.end > from && o.start < to && !ev.all_day) out.get(staffId)!.push({ title: ev.title, start: o.start, end: o.end, source: "portal" });
    }
  };
  (own.data || []).forEach((ev: Row) => add(ev.staff_id, ev));
  (people.data || []).forEach((p: Row) => add(p.staff_id, Array.isArray(p.my_calendar_events) ? p.my_calendar_events[0] : p.my_calendar_events));
  const noGoogle = new Set((settings.data || []).filter((s: Row) => s.google_busy === false).map((s: Row) => s.staff_id));
  const linked = staffIds.filter((id) => !noGoogle.has(id));
  if (linked.length) {
    const { data } = await admin.from("calendar_events_cache").select("user_id, start_time, end_time, all_day")
      .in("user_id", linked).lt("start_time", to.toISOString()).gt("end_time", from.toISOString()).eq("all_day", false);
    (data || []).forEach((r: Row) => out.get(r.user_id)!.push({ title: "Busy", start: new Date(r.start_time), end: new Date(r.end_time), source: "linked" }));
  }
  out.forEach((list) => list.sort((a, b) => a.start.getTime() - b.start.getTime()));
  return out;
}

async function busy(admin: Row, body: Row) {
  const ids = (Array.isArray(body.staff_ids) ? body.staff_ids : []).filter(isUuid).slice(0, 50);
  const from = new Date(body.start), to = new Date(body.end);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return fail("Bad time range.");
  const map = await busyFor(admin, ids, from, to, isUuid(body.exclude_id) ? body.exclude_id : null);
  const result: Row = {};
  map.forEach((list, id) => { result[id] = list.map((b) => ({ title: b.title, start: b.start.toISOString(), end: b.end.toISOString(), source: b.source })); });
  return json({ ok: true, busy: result });
}

// Next free times for everyone, inside the asker's working hours.
async function suggest(admin: Row, body: Row, staff: Row) {
  const ids = [...new Set([staff.id, ...(Array.isArray(body.staff_ids) ? body.staff_ids : []).filter(isUuid)])].slice(0, 50);
  const minutes = Math.min(Math.max(Number(body.minutes) || 60, 15), 8 * 60);
  const { data: set } = await admin.from("calendar_settings").select("work_start, work_end").eq("staff_id", staff.id).maybeSingle();
  const ws = String(set?.work_start || "07:00").slice(0, 5), we = String(set?.work_end || "17:00").slice(0, 5);
  const tz = "America/New_York";
  const start = body.from ? new Date(body.from) : new Date();
  const horizon = new Date(start.getTime() + 10 * 86400000);
  const map = await busyFor(admin, ids, start, horizon, isUuid(body.exclude_id) ? body.exclude_id : null);
  const all = [...map.values()].flat();
  const out: string[] = [];
  let day = zonedToday(tz, start);
  for (let d = 0; d < 10 && out.length < 3; d++, day = addDays(day, 1)) {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    let t = zonedToUtc(day, ws, tz);
    const end = zonedToUtc(day, we, tz);
    while (t.getTime() + minutes * 60000 <= end.getTime() && out.length < 3) {
      const s = t, e = new Date(t.getTime() + minutes * 60000);
      if (s > start && !all.some((b) => b.start < e && b.end > s)) { out.push(s.toISOString()); t = new Date(e.getTime() + 60 * 60000); continue; }
      t = new Date(t.getTime() + 30 * 60000);
    }
  }
  return json({ ok: true, times: out, minutes });
}

/* ---------------- save / delete / respond ---------------- */

function cleanEvent(e: Row) {
  const allDay = Boolean(e.all_day);
  const ev = {
    title: clean(e.title, 200), location: clean(e.location, 200), notes: clean(e.notes, 2000),
    all_day: allDay,
    start_date: isDate(e.start_date) ? e.start_date : null,
    end_date: isDate(e.end_date) ? e.end_date : (isDate(e.start_date) ? e.start_date : null),
    start_time: allDay ? null : (isTime(e.start_time) ? String(e.start_time).slice(0, 5) : null),
    end_time: allDay ? null : (isTime(e.end_time) ? String(e.end_time).slice(0, 5) : (isTime(e.start_time) ? String(e.start_time).slice(0, 5) : null)),
    tz: clean(e.tz, 60) || "America/New_York",
    repeat: REPEATS.includes(e.repeat) ? e.repeat : "none",
    repeat_until: e.repeat && e.repeat !== "none" && isDate(e.repeat_until) ? e.repeat_until : null,
    reminders: [...new Set((Array.isArray(e.reminders) ? e.reminders : []).map(Number).filter((m: number) => REMINDERS.includes(m)))],
    project_id: isUuid(e.project_id) ? e.project_id : null,
  };
  const problems: string[] = [];
  if (!ev.title) problems.push("a title");
  if (!ev.start_date) problems.push("a start date");
  if (!allDay && !ev.start_time) problems.push("a start time");
  if (problems.length) return { error: `Please add ${problems.join(" and ")}.` };
  if (ev.end_date! < ev.start_date! || (!allDay && ev.end_date === ev.start_date && ev.end_time! < ev.start_time!)) return { error: "The end has to be after the start." };
  return { ev };
}

async function save(admin: Row, body: Row, staff: Row) {
  const c = cleanEvent(body.event || {});
  if ("error" in c) return fail(c.error!);
  const ev = c.ev!;
  const wanted = new Map<string, string>();
  for (const p of Array.isArray(body.people) ? body.people : []) {
    if (isUuid(p?.staff_id) && p.staff_id !== staff.id) wanted.set(p.staff_id, p.role === "assign" ? "assign" : "invite");
  }
  const roles = [...wanted.values()];
  const organizer_attends = !roles.length || roles.includes("invite") || body.event?.organizer_attends === true;

  let before: Row = null;
  const id = isUuid(body.event?.id) ? body.event.id : null;
  if (id) {
    const { data } = await admin.from("my_calendar_events").select("*").eq("id", id).maybeSingle();
    if (!data) return fail("That event doesn't exist anymore.", 404);
    if (data.staff_id !== staff.id) return fail("Only the person who made this event can change it.", 403);
    before = data;
  }
  const row = { ...ev, organizer_attends };
  const { data: saved, error } = id
    ? await admin.from("my_calendar_events").update(row).eq("id", id).select().single()
    : await admin.from("my_calendar_events").insert({ ...row, staff_id: staff.id }).select().single();
  if (error) throw error;

  const { data: existing } = await admin.from("calendar_event_people").select("*").eq("event_id", saved.id);
  const had = new Map((existing || []).map((p: Row) => [p.staff_id, p]));
  const added = [...wanted.keys()].filter((s) => !had.has(s));
  const removed = [...had.keys()].filter((s) => !wanted.has(s as string)) as string[];
  const kept = [...wanted.keys()].filter((s) => had.has(s));

  if (added.length) {
    const { data: sets } = await admin.from("calendar_settings").select("staff_id, default_reminders").in("staff_id", added);
    const defaults = new Map((sets || []).map((s: Row) => [s.staff_id, s.default_reminders]));
    const { error: addError } = await admin.from("calendar_event_people").insert(added.map((s) => ({
      event_id: saved.id, staff_id: s, role: wanted.get(s), response: "pending", reminders: defaults.get(s) || [15],
    })));
    if (addError) throw addError;
  }
  if (removed.length) await admin.from("calendar_event_people").delete().eq("event_id", saved.id).in("staff_id", removed);
  for (const s of kept) {
    const p: Row = had.get(s);
    if (p.role !== wanted.get(s)) await admin.from("calendar_event_people").update({ role: wanted.get(s), response: "pending", responded_at: null }).eq("event_id", saved.id).eq("staff_id", s);
  }

  // Notifications.
  const when = whenText(saved);
  const by = nameOf(staff);
  const invited = added.filter((s) => wanted.get(s) === "invite");
  const assigned = added.filter((s) => wanted.get(s) === "assign");
  await notify(admin, invited, `Invite: ${saved.title}`, `${by} invited you · ${when}. Accept or decline on your calendar.`, saved.id);
  await notify(admin, assigned, `On your calendar: ${saved.title}`, `${by} put this on your calendar · ${when}.`, saved.id);
  await notify(admin, removed, `Removed: ${before?.title || saved.title}`, `${by} took you off this event.`, null);
  const timeChanged = before && ["start_date", "start_time", "end_date", "end_time", "all_day", "repeat", "repeat_until"].some((k) => String(before[k] ?? "") !== String((saved as Row)[k] ?? ""));
  if (timeChanged && kept.length) {
    // A new time: anyone who had a conflict or declined gets asked again.
    await admin.from("calendar_event_people").update({ response: "pending", responded_at: null })
      .eq("event_id", saved.id).in("staff_id", kept).in("response", ["conflict", "declined"]);
    await notify(admin, kept, `Moved: ${saved.title}`, `${by} changed the time · now ${when}.`, saved.id);
  }
  return json({ ok: true, id: saved.id });
}

async function remove(admin: Row, body: Row, staff: Row) {
  if (!isUuid(body.id)) return fail("Missing event.");
  const { data: ev } = await admin.from("my_calendar_events").select("*").eq("id", body.id).maybeSingle();
  if (!ev) return json({ ok: true });
  if (ev.staff_id !== staff.id) return fail("Only the person who made this event can delete it.", 403);
  const { data: people } = await admin.from("calendar_event_people").select("staff_id").eq("event_id", ev.id);
  const { error } = await admin.from("my_calendar_events").delete().eq("id", ev.id);
  if (error) throw error;
  await notify(admin, (people || []).map((p: Row) => p.staff_id), `Canceled: ${ev.title}`, `${nameOf(staff)} canceled ${whenText(ev)}.`, null);
  return json({ ok: true });
}

async function respond(admin: Row, body: Row, staff: Row) {
  const response = ["accepted", "declined", "conflict"].includes(body.response) ? body.response : null;
  if (!isUuid(body.id) || !response) return fail("Missing answer.");
  const { data: p } = await admin.from("calendar_event_people").select("*").eq("event_id", body.id).eq("staff_id", staff.id).maybeSingle();
  if (!p) return fail("You're not on this event.", 404);
  const { data: ev } = await admin.from("my_calendar_events").select("*").eq("id", body.id).maybeSingle();
  if (!ev) return fail("That event was canceled.", 404);
  const { error } = await admin.from("calendar_event_people").update({ response, responded_at: new Date().toISOString() }).eq("event_id", ev.id).eq("staff_id", staff.id);
  if (error) throw error;

  let what = "";
  if (response === "conflict") {
    // What's in the way (first occurrence).
    const occ = occurrencesBetween([ev], new Date(Date.now() - 86400000), new Date(Date.now() + 400 * 86400000))[0];
    if (occ) {
      const map = await busyFor(admin, [staff.id], occ.start, occ.end, ev.id);
      const hit = (map.get(staff.id) || [])[0];
      if (hit) what = ` with “${hit.title}”`;
    }
  }
  const who = nameOf(staff);
  const msg = response === "accepted" ? `${who} is going · ${whenText(ev)}.`
    : response === "conflict" ? `${who} has a conflict${what} · ${whenText(ev)}. Open it to move the event.`
    : `${who} can't make it · ${whenText(ev)}.`;
  const title = response === "accepted" ? `Accepted: ${ev.title}` : response === "conflict" ? `Conflict: ${ev.title}` : `Declined: ${ev.title}`;
  await notify(admin, [ev.staff_id], title, msg, ev.id);
  return json({ ok: true });
}

/* ---------------- private calendar link (ICS) ---------------- */

const icsEsc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const fold = (line: string) => {
  const out: string[] = [];
  let s = line;
  while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); }
  out.push(s);
  return out.join("\r\n");
};
const d8 = (d: string) => d.replace(/-/g, "");
const t6 = (t: string) => `${String(t).slice(0, 5).replace(":", "")}00`;

async function feed(admin: Row, token: string, ua: string) {
  if (!token || token.length < 20) return new Response("Not found", { status: 404 });
  const { data: link } = await admin.from("calendar_feed_tokens").select("staff_id").eq("token_hash", await sha256(token)).maybeSingle();
  if (!link) return new Response("This calendar link was turned off.", { status: 404 });
  await admin.from("calendar_feed_tokens").update({ last_used_at: new Date().toISOString(), last_used_by: ua.slice(0, 120) }).eq("staff_id", link.staff_id);
  const [own, people] = await Promise.all([
    admin.from("my_calendar_events").select("*").eq("staff_id", link.staff_id).eq("organizer_attends", true),
    admin.from("calendar_event_people").select("response, role, my_calendar_events(*)").eq("staff_id", link.staff_id).neq("response", "declined"),
  ]);
  const events: Row[] = [...(own.data || [])];
  (people.data || []).forEach((p: Row) => { const e = Array.isArray(p.my_calendar_events) ? p.my_calendar_events[0] : p.my_calendar_events; if (e) events.push(e); });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//The Leeward Group//Staff Calendar//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Leeward Portal", "X-WR-TIMEZONE:America/New_York", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@leeward-portal`, `DTSTAMP:${stamp}`, fold(`SUMMARY:${icsEsc(e.title)}`));
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${d8(e.start_date)}`, `DTEND;VALUE=DATE:${d8(addDays(e.end_date || e.start_date, 1))}`);
    } else {
      const tz = e.tz || "America/New_York";
      lines.push(`DTSTART;TZID=${tz}:${d8(e.start_date)}T${t6(e.start_time)}`, `DTEND;TZID=${tz}:${d8(e.end_date || e.start_date)}T${t6(e.end_time || e.start_time)}`);
    }
    if (e.repeat && e.repeat !== "none") {
      lines.push(`RRULE:FREQ=${String(e.repeat).toUpperCase()}${e.repeat_until ? `;UNTIL=${d8(e.repeat_until)}T235959Z` : ""}`);
    }
    if (e.location) lines.push(fold(`LOCATION:${icsEsc(e.location)}`));
    if (e.notes) lines.push(fold(`DESCRIPTION:${icsEsc(e.notes)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
  });
}

async function feedAction(admin: Row, action: string, staff: Row) {
  if (action === "feed_token") {
    const token = randomToken();
    const { error } = await admin.from("calendar_feed_tokens")
      .upsert({ staff_id: staff.id, token_hash: await sha256(token), created_at: new Date().toISOString(), last_used_at: null, last_used_by: null }, { onConflict: "staff_id" });
    if (error) throw error;
    return json({ ok: true, token });
  }
  if (action === "feed_off") {
    await admin.from("calendar_feed_tokens").delete().eq("staff_id", staff.id);
    return json({ ok: true });
  }
  const { data } = await admin.from("calendar_feed_tokens").select("created_at, last_used_at, last_used_by").eq("staff_id", staff.id).maybeSingle();
  return json({ ok: true, on: Boolean(data), created_at: data?.created_at || null, last_used_at: data?.last_used_at || null, last_used_by: data?.last_used_by || null });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  const admin = serviceClient();
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      return await feed(admin, (u.searchParams.get("feed") || "").replace(/\.ics$/i, ""), req.headers.get("user-agent") || "");
    }
    if (req.method !== "POST") return fail("GET or POST only", 405);
    let body: Row;
    try { body = await req.json(); } catch { return fail("Invalid JSON body"); }
    const auth = await requireStaff(req, admin);
    if (auth.error) return auth.error;
    const action = String(body.action || "");
    switch (action) {
      case "save": return await save(admin, body, auth.staff);
      case "delete": return await remove(admin, body, auth.staff);
      case "respond": return await respond(admin, body, auth.staff);
      case "busy": return await busy(admin, body);
      case "suggest": return await suggest(admin, body, auth.staff);
      case "feed_token": case "feed_off": case "feed_status": return await feedAction(admin, action, auth.staff);
      default: return fail(`Unknown action "${action}"`);
    }
  } catch (error) {
    console.error("staff-calendar failed:", error);
    return fail("Something went wrong with the calendar. Please try again.", 500);
  }
});
