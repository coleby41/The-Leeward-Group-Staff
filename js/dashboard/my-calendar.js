/* ============================================================================
   my-calendar.js — shared portal-calendar data (2026-11-20)

   Your portal events (made in the portal, no Google / Outlook): the ones you
   made, plus the ones you're invited to or assigned (calendar_event_people).
   Used by:
     - Home › "Calender For You" (home-today.js month view, home-calendar.js
       Rows) — "+ Event" and tapping an event open the Calendar page
     - the Calendar page (js/calendar-page.js)
   Declined invites, and events you only assigned to others, are left out of
   *your* calendar.

   window.MyCalendar
     .load(force)                -> { events, mine: Map(eventId -> your people row) }
     .occurrenceDates(ev, from, to)
     .occurrences(fromISO, toISO) -> your events in that date range, repeats expanded
     .color                      -> Leeward blue
============================================================================ */
(function () {
  "use strict";
  const COLOR = "#085c98";
  const ASSIGNED_COLOR = "#127a68";
  let cache = null;        // { events, mine, me }
  let loading = null;

  const sb = () => window.supabaseClient;
  const pad = (n) => String(n).padStart(2, "0");
  const DAY = 86400000;
  const utcDay = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (s, n) => new Date(utcDay(s) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((utcDay(b) - utcDay(a)) / DAY);
  function addMonths(s, n) {
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, d));
    return t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
  }

  // Same rules as supabase/functions/_shared/my-calendar.ts occurrenceDates().
  function occurrenceDates(ev, from, to) {
    const start = ev.start_date;
    const span = Math.max(0, daysBetween(start, ev.end_date || start));
    const until = ev.repeat && ev.repeat !== "none" ? (ev.repeat_until || "9999-12-31") : start;
    const out = [];
    const keep = (d) => { if (d <= to && addDays(d, span) >= from && d <= until) out.push(d); };
    if (!ev.repeat || ev.repeat === "none") { keep(start); return out; }
    if (ev.repeat === "daily" || ev.repeat === "weekly") {
      const step = ev.repeat === "daily" ? 1 : 7;
      let k = Math.max(0, Math.floor((daysBetween(start, from) - span) / step));
      for (let i = 0; i < 1000; i++, k++) { const d = addDays(start, k * step); if (d > to || d > until) break; keep(d); }
      return out;
    }
    const months = ev.repeat === "monthly" ? 1 : 12;
    for (let k = 0; k < 3000; k++) { const d = addMonths(start, k * months); if (d === null) continue; if (d > to || d > until) break; keep(d); }
    return out;
  }

  function timeText(t) {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  async function myStaffId() {
    try { await window.supabaseInitialProfilePromise; } catch (_) { /* fall through */ }
    const p = window.currentSupabaseProfile || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    return p?.id || null;
  }

  async function load(force) {
    if (cache && !force) return cache;
    if (loading && !force) return loading;
    loading = (async () => {
      for (let i = 0; i < 50 && !sb(); i++) await new Promise(r => setTimeout(r, 100));
      if (!sb()) { loading = null; return { events: [], mine: new Map(), me: null }; }
      const me = await myStaffId();
      const [ev, ppl] = await Promise.all([
        sb().from("my_calendar_events").select("*").order("start_date"),
        me ? sb().from("calendar_event_people").select("event_id, role, response, reminders").eq("staff_id", me) : Promise.resolve({ data: [] })
      ]);
      if (ev.error) console.warn("Calendar: couldn't load events (have the calendar SQL files been run?)", ev.error);
      const mine = new Map((ppl.data || []).map(p => [p.event_id, p]));
      cache = { events: ev.data || [], mine, me };
      loading = null;
      return cache;
    })();
    return loading;
  }

  // Is this event on *my* calendar, and how? -> null | {kind: "own"|"invite"|"assign", person}
  function relation(ev, data) {
    const p = data.mine.get(ev.id);
    if (p) {
      if (p.response === "declined" || p.response === "conflict") return null;
      return { kind: p.role === "assign" ? "assign" : "invite", person: p };
    }
    if (ev.staff_id === data.me) return ev.organizer_attends === false ? null : { kind: "own", person: null };
    return null;
  }

  // Your events in [from, to] (YYYY-MM-DD), one entry per occurrence.
  async function occurrences(from, to) {
    const data = await load();
    const out = [];
    for (const ev of data.events) {
      const rel = relation(ev, data);
      if (!rel) continue;
      for (const date of occurrenceDates(ev, from, to)) {
        const span = Math.max(0, daysBetween(ev.start_date, ev.end_date || ev.start_date));
        const start = new Date(`${date}T${ev.all_day ? "00:00" : (ev.start_time || "00:00").slice(0, 5)}`);
        const endDate = addDays(date, span);
        const end = ev.all_day ? new Date(`${addDays(endDate, 1)}T00:00`) : new Date(`${endDate}T${(ev.end_time || ev.start_time || "00:00").slice(0, 5)}`);
        out.push({
          id: ev.id, title: ev.title, location: ev.location || "", all_day: ev.all_day, date, start, end,
          repeat: ev.repeat, kind: rel.kind, pending: rel.kind === "invite" && rel.person.response === "pending",
          color: rel.kind === "assign" ? ASSIGNED_COLOR : COLOR,
          href: `/pages/calendar.html?event=${ev.id}`,
          time: ev.all_day ? "All day" : timeText((ev.start_time || "").slice(0, 5))
        });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Old phone reminders opened /pages/dashboard?event=<id>; send them on.
  if (/\/dashboard(\.html)?$/.test(location.pathname)) {
    const old = new URLSearchParams(location.search).get("event");
    if (old) location.replace(`/pages/calendar.html?event=${encodeURIComponent(old)}`);
  }

  // Home: the "Calender For You" title opens the Calendar page.
  document.addEventListener("DOMContentLoaded", () => {
    // Home header is just the title + Rows / Calendar (2026-11-20). Adding events,
    // linking calendars and settings all live on the Calendar page now.
    const tools = document.querySelector(".hm-today-tools");
    // "Calender For You" heading opens the Calendar page.
    const head = tools?.closest(".hm-section-head")?.querySelector("h2");
    if (head && !head.querySelector("a")) {
      const a = document.createElement("a");
      a.href = "/pages/calendar.html";
      a.className = "hm-cal-head-link";
      a.innerHTML = `${head.innerHTML} <span aria-hidden="true">›</span>`;
      head.innerHTML = "";
      head.appendChild(a);
    }
  });

  window.MyCalendar = { load, reload: () => load(true), occurrences, occurrenceDates, relation, addDays, daysBetween, timeText, color: COLOR, assignedColor: ASSIGNED_COLOR };
})();
