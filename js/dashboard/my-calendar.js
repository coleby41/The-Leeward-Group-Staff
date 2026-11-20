/* ============================================================================
   my-calendar.js — My Calendar on Home › "Calender For You" (2026-11-20)

   Your own events, made right in the portal (no Google / Outlook). Private:
   only you see them. They show in Rows and the month Calendar next to linked
   calendars, in Leeward blue.
     - "+ Event" (or tap one of your events) opens the event popup: title,
       all day, start / end, location, notes, repeat (daily / weekly /
       monthly / yearly, optional end date) and phone reminders (pick any).
     - Reminders are push notifications to your phone only (not the bell);
       sent by push-send every minute (sql/supabase-my-calendar-setup.sql).
     - "iPhone widget" sets up the Scriptable widget: makes your private
       widget link and the script to paste (my-calendar Edge Function).
     - Opening /pages/dashboard?event=<id> (tapping a reminder) opens it.
   Table: my_calendar_events (only your own rows, RLS).

   window.MyCalendar.occurrences(fromISO, toISO) -> your events in that date
   range (repeats expanded), used by home-today.js and home-calendar.js.
============================================================================ */
(function () {
  "use strict";
  const COLOR = "#085c98";
  const REMINDERS = [
    { m: 0, label: "At start" }, { m: 5, label: "5 min" }, { m: 15, label: "15 min" }, { m: 30, label: "30 min" },
    { m: 60, label: "1 hour" }, { m: 1440, label: "1 day" }, { m: 10080, label: "1 week" }
  ];
  const REPEATS = [["none", "Doesn't repeat"], ["daily", "Every day"], ["weekly", "Every week"], ["monthly", "Every month"], ["yearly", "Every year"]];
  let events = null;       // my_calendar_events rows (cached)
  let editing = null;      // row being edited, or {} for new
  let busy = false;

  const sb = () => window.supabaseClient;
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  async function load(force) {
    if (events && !force) return events;
    if (!sb()) return [];
    const { data, error } = await sb().from("my_calendar_events").select("*").order("start_date");
    if (error) { console.warn("My Calendar: couldn't load events (has sql/supabase-my-calendar-setup.sql been run?)", error); events = []; return events; }
    events = data || [];
    return events;
  }

  // Your events in [from, to] (YYYY-MM-DD), one entry per occurrence.
  async function occurrences(from, to) {
    const list = await load();
    const out = [];
    for (const ev of list) {
      for (const date of occurrenceDates(ev, from, to)) {
        const span = Math.max(0, daysBetween(ev.start_date, ev.end_date || ev.start_date));
        const start = new Date(`${date}T${ev.all_day ? "00:00" : (ev.start_time || "00:00").slice(0, 5)}`);
        const endDate = addDays(date, span);
        const end = ev.all_day ? new Date(`${addDays(endDate, 1)}T00:00`) : new Date(`${endDate}T${(ev.end_time || ev.start_time || "00:00").slice(0, 5)}`);
        out.push({
          id: ev.id, title: ev.title, location: ev.location || "", all_day: ev.all_day, date, start, end,
          repeat: ev.repeat, color: COLOR, href: `#my-event:${ev.id}`,
          time: ev.all_day ? "All day" : timeText((ev.start_time || "").slice(0, 5))
        });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function changed() {
    window.dispatchEvent(new CustomEvent("mycalendar:changed"));
    window.dispatchEvent(new CustomEvent("calendar:synced"));   // home-today.js reloads the month
  }

  /* ---------- popups ---------- */

  function inject() {
    if ($("myEventOverlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
<div class="popup-overlay popup-overlay--blur hidden" id="myEventOverlay">
  <div class="popup mycal-popup" role="dialog" aria-modal="true" aria-labelledby="myEventTitle">
    <div class="mycal-head">
      <h2 id="myEventTitle">New event</h2>
      <button type="button" class="pav-close-btn" data-mycal-close aria-label="Close">✕</button>
    </div>
    <form id="myEventForm" class="mycal-form" novalidate>
      <label class="auth-field">Title<input type="text" name="title" maxlength="200" required autocomplete="off"></label>
      <label class="mycal-check"><input type="checkbox" name="all_day"> All day</label>
      <div class="mycal-grid">
        <label class="auth-field">Starts<input type="date" name="start_date" required></label>
        <label class="auth-field" data-time>Time<input type="time" name="start_time" step="300"></label>
        <label class="auth-field">Ends<input type="date" name="end_date" required></label>
        <label class="auth-field" data-time>Time<input type="time" name="end_time" step="300"></label>
      </div>
      <div class="mycal-grid">
        <label class="auth-field">Repeat<select name="repeat">${REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <label class="auth-field" data-until>Until (optional)<input type="date" name="repeat_until"></label>
      </div>
      <fieldset class="mycal-reminders">
        <legend>Phone reminders <span>— to your phone only, before it starts</span></legend>
        <div class="mycal-chips">${REMINDERS.map(r => `<label class="mycal-chip"><input type="checkbox" name="reminder" value="${r.m}"><span>${r.label}</span></label>`).join("")}</div>
        <p class="mycal-hint" id="myEventPushHint"></p>
      </fieldset>
      <label class="auth-field">Location (optional)<input type="text" name="location" maxlength="200" autocomplete="off"></label>
      <label class="auth-field">Notes (optional)<textarea name="notes" rows="2" maxlength="2000"></textarea></label>
      <p class="auth-message" id="myEventMessage" role="status"></p>
      <div class="popup-buttons mycal-foot">
        <button type="button" class="mycal-delete" id="myEventDelete">Delete</button>
        <span class="mycal-foot-right">
          <button type="button" class="auth-button auth-button--secondary sheet-close" data-mycal-close>Cancel</button>
          <button type="submit" class="auth-button" id="myEventSave">Save</button>
        </span>
      </div>
    </form>
  </div>
</div>
<div class="popup-overlay popup-overlay--blur hidden" id="myWidgetOverlay">
  <div class="popup mycal-popup" role="dialog" aria-modal="true" aria-labelledby="myWidgetTitle">
    <div class="mycal-head">
      <h2 id="myWidgetTitle">iPhone widget</h2>
      <button type="button" class="pav-close-btn" data-widget-close aria-label="Close">✕</button>
    </div>
    <div class="mycal-form">
      <p class="mycal-hint" style="margin:0">Shows your next events on your Home Screen. It uses the free <strong>Scriptable</strong> app.</p>
      <ol class="mycal-steps">
        <li>Install <strong>Scriptable</strong> from the App Store.</li>
        <li>Tap <strong>Make my widget</strong> below, then <strong>Copy script</strong>.</li>
        <li>In Scriptable, tap <strong>+</strong>, paste, and name it <strong>Leeward Calendar</strong>.</li>
        <li>On your Home Screen, press and hold › <strong>Edit</strong> › <strong>Add Widget</strong> › <strong>Scriptable</strong>, pick a size, add it.</li>
        <li>Press and hold the new widget › <strong>Edit Widget</strong> › Script: <strong>Leeward Calendar</strong>.</li>
      </ol>
      <div id="myWidgetBody"></div>
      <p class="auth-message" id="myWidgetMessage" role="status"></p>
      <div class="popup-buttons mycal-foot">
        <button type="button" class="mycal-delete" id="myWidgetOff">Turn off widget link</button>
        <span class="mycal-foot-right">
          <button type="button" class="auth-button auth-button--secondary sheet-close" data-widget-close>Close</button>
          <button type="button" class="auth-button" id="myWidgetMake">Make my widget</button>
        </span>
      </div>
    </div>
  </div>
</div>`;
    document.body.append(...wrap.children);
    const form = $("myEventForm");
    document.querySelectorAll("[data-mycal-close]").forEach(b => b.addEventListener("click", closeEvent));
    document.querySelectorAll("[data-widget-close]").forEach(b => b.addEventListener("click", closeWidget));
    $("myEventOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeEvent(); });
    $("myWidgetOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeWidget(); });
    form.addEventListener("submit", save);
    form.elements.all_day.addEventListener("change", syncForm);
    form.elements.repeat.addEventListener("change", syncForm);
    form.elements.start_date.addEventListener("change", () => {
      // Keep the end on/after the start.
      if (!form.elements.end_date.value || form.elements.end_date.value < form.elements.start_date.value) form.elements.end_date.value = form.elements.start_date.value;
    });
    form.elements.start_time.addEventListener("change", () => {
      const s = form.elements.start_time.value, e = form.elements.end_time.value;
      if (s && (!e || (form.elements.end_date.value === form.elements.start_date.value && e <= s))) {
        const [h, m] = s.split(":").map(Number);
        const t = new Date(2000, 0, 1, h + 1, m);
        form.elements.end_time.value = t.getDate() === 1 ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : "23:55";
      }
    });
    $("myEventDelete").addEventListener("click", remove);
    $("myWidgetMake").addEventListener("click", makeWidget);
    $("myWidgetOff").addEventListener("click", widgetOff);
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("myEventOverlay").classList.contains("hidden")) closeEvent();
      if (!$("myWidgetOverlay").classList.contains("hidden")) closeWidget();
    });
  }

  function syncForm() {
    const form = $("myEventForm");
    const allDay = form.elements.all_day.checked;
    form.querySelectorAll("[data-time]").forEach(el => { el.hidden = allDay; });
    form.querySelector("[data-until]").hidden = form.elements.repeat.value === "none";
  }

  function show(id) { $(id).classList.remove("hidden"); document.body.classList.add("popup-active"); }
  function hide(id) {
    $(id).classList.add("hidden");
    if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
  }

  async function pushHint() {
    const el = $("myEventPushHint");
    el.textContent = "";
    try {
      const s = await window.PushNotifications?.state?.();
      if (s && s !== "on") el.innerHTML = `Phone notifications aren't on for this device. Turn them on on your phone from the <a href="/pages/notifications.html">Notifications</a> page.`;
    } catch { /* ignore */ }
  }

  async function openEvent(id, date) {
    inject();
    await load();
    const form = $("myEventForm");
    form.reset();
    $("myEventMessage").textContent = "";
    const ev = id ? (events || []).find(e => e.id === id) : null;
    if (id && !ev) { window.showToast?.("That event isn't on your calendar anymore."); return; }
    editing = ev || {};
    $("myEventTitle").textContent = ev ? "Edit event" : "New event";
    $("myEventDelete").hidden = !ev;
    const day = date || isoDay(new Date());
    if (ev) {
      form.elements.title.value = ev.title || "";
      form.elements.all_day.checked = ev.all_day;
      form.elements.start_date.value = ev.start_date;
      form.elements.end_date.value = ev.end_date;
      form.elements.start_time.value = (ev.start_time || "").slice(0, 5);
      form.elements.end_time.value = (ev.end_time || "").slice(0, 5);
      form.elements.repeat.value = ev.repeat || "none";
      form.elements.repeat_until.value = ev.repeat_until || "";
      form.elements.location.value = ev.location || "";
      form.elements.notes.value = ev.notes || "";
      form.querySelectorAll('[name="reminder"]').forEach(c => { c.checked = (ev.reminders || []).includes(Number(c.value)); });
    } else {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
      form.elements.start_date.value = day;
      form.elements.end_date.value = day;
      form.elements.start_time.value = `${pad(next.getHours())}:00`;
      form.elements.end_time.value = `${pad((next.getHours() + 1) % 24)}:00`;
      form.querySelector('[name="reminder"][value="15"]').checked = true;
    }
    syncForm();
    show("myEventOverlay");
    pushHint();
    setTimeout(() => form.elements.title.focus(), 50);
  }

  function closeEvent() { if (!busy) { hide("myEventOverlay"); editing = null; } }

  function message(id, text, type) { const el = $(id); el.textContent = text || ""; el.className = `auth-message ${type || ""}`.trim(); }

  async function save(e) {
    e.preventDefault();
    if (busy || !editing) return;
    const f = $("myEventForm").elements;
    const allDay = f.all_day.checked;
    const row = {
      title: f.title.value.trim(), all_day: allDay,
      start_date: f.start_date.value, end_date: f.end_date.value || f.start_date.value,
      start_time: allDay ? null : f.start_time.value || null, end_time: allDay ? null : (f.end_time.value || f.start_time.value || null),
      repeat: f.repeat.value, repeat_until: f.repeat.value === "none" ? null : (f.repeat_until.value || null),
      location: f.location.value.trim() || null, notes: f.notes.value.trim() || null,
      reminders: Array.from(document.querySelectorAll('#myEventForm [name="reminder"]:checked')).map(c => Number(c.value)),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"
    };
    const problems = [];
    if (!row.title) problems.push("a title");
    if (!row.start_date) problems.push("a start date");
    if (!allDay && !row.start_time) problems.push("a start time");
    if (problems.length) { message("myEventMessage", `Please add ${problems.join(" and ")}.`, "error"); return; }
    if (row.end_date < row.start_date || (!allDay && row.end_date === row.start_date && row.end_time < row.start_time)) {
      message("myEventMessage", "The end has to be after the start.", "error"); return;
    }
    if (row.repeat_until && row.repeat_until < row.start_date) { message("myEventMessage", "\"Until\" has to be after the start date.", "error"); return; }

    busy = true;
    $("myEventSave").disabled = true;
    try {
      // staff_id fills itself in (current_staff_id()) on a new event.
      const q = editing.id
        ? sb().from("my_calendar_events").update(row).eq("id", editing.id).select().single()
        : sb().from("my_calendar_events").insert(row).select().single();
      const { error } = await q;
      if (error) throw error;
      await load(true);
      busy = false;
      closeEvent();
      window.showToast?.(row.reminders.length ? "Event saved. You'll get a reminder on your phone." : "Event saved.");
      changed();
    } catch (err) {
      console.error("My Calendar save failed:", err);
      message("myEventMessage", err?.message || "Couldn't save the event.", "error");
    } finally {
      busy = false;
      $("myEventSave").disabled = false;
    }
  }

  async function remove() {
    if (busy || !editing?.id) return;
    if (!confirm(editing.repeat && editing.repeat !== "none" ? "Delete this event and all of its repeats?" : "Delete this event?")) return;
    busy = true;
    try {
      const { error } = await sb().from("my_calendar_events").delete().eq("id", editing.id);
      if (error) throw error;
      await load(true);
      busy = false;
      closeEvent();
      window.showToast?.("Event deleted.");
      changed();
    } catch (err) {
      message("myEventMessage", err?.message || "Couldn't delete the event.", "error");
    } finally { busy = false; }
  }

  /* ---------- iPhone widget (Scriptable) ---------- */

  async function callFn(action) {
    const cfg = window.SUPABASE_CONFIG || {};
    const { data: { session } } = await sb().auth.getSession();
    const res = await fetch(`${cfg.url}/functions/v1/my-calendar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey || "", Authorization: `Bearer ${session ? session.access_token : cfg.anonKey}` },
      body: JSON.stringify({ action })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `The calendar service returned ${res.status}.`);
    return data;
  }

  function script(token) {
    const cfg = window.SUPABASE_CONFIG || {};
    return `// Leeward — My Calendar widget (Scriptable). Made in the staff portal.
// This link is private: don't share it. Make a new one on Home › iPhone widget.
const FEED = "${cfg.url}/functions/v1/my-calendar?token=${token}";
const PORTAL = "${location.origin}/pages/dashboard";
const NAVY = new Color("#0b2236"), SOFT = new Color("#c8d6e2"), ACCENT = new Color("#7cc0ff");

let data;
try {
  const req = new Request(FEED);
  req.headers = { apikey: "${cfg.anonKey || ""}" };
  data = await req.loadJSON();
} catch (e) { data = { ok: false, error: "Can't reach the portal right now." }; }

const family = config.widgetFamily || "medium";
const max = family === "small" ? 2 : family === "large" ? 7 : 3;
const w = new ListWidget();
w.backgroundColor = NAVY;
w.url = PORTAL;
w.setPadding(14, 14, 12, 14);

const head = w.addText("LEEWARD · MY CALENDAR");
head.font = Font.boldSystemFont(10); head.textColor = ACCENT;
w.addSpacer(8);

function dayLabel(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((x - t) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

if (!data || !data.ok) {
  const t = w.addText((data && data.error) || "Couldn't load your calendar.");
  t.font = Font.systemFont(12); t.textColor = Color.white();
} else if (!data.events.length) {
  const t = w.addText("Nothing in the next 2 weeks.");
  t.font = Font.systemFont(13); t.textColor = Color.white();
} else {
  for (const ev of data.events.slice(0, max)) {
    const s = new Date(ev.start);
    const when = dayLabel(s) + " · " + (ev.all_day ? "All day" : s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
    const a = w.addText(ev.title);
    a.font = Font.semiboldSystemFont(family === "small" ? 12 : 14); a.textColor = Color.white(); a.lineLimit = 1;
    const b = w.addText(when + (ev.location && family !== "small" ? " · " + ev.location : ""));
    b.font = Font.systemFont(11); b.textColor = SOFT; b.lineLimit = 1;
    w.addSpacer(6);
  }
}
w.addSpacer();
w.refreshAfterDate = new Date(Date.now() + 15 * 60000);
if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
Script.complete();
`;
  }

  async function openWidget() {
    inject();
    message("myWidgetMessage", "");
    $("myWidgetBody").innerHTML = "";
    $("myWidgetOff").hidden = true;
    show("myWidgetOverlay");
    try {
      const st = await callFn("widget_status");
      $("myWidgetOff").hidden = !st.on;
      $("myWidgetMake").textContent = st.on ? "Make a new widget link" : "Make my widget";
      if (st.on) $("myWidgetBody").innerHTML = `<p class="mycal-hint">Your widget link is on${st.last_used_at ? ` (last used ${esc(new Date(st.last_used_at).toLocaleString("en-US"))})` : ""}. Making a new one turns the old one off, so you'd paste the new script into Scriptable.</p>`;
    } catch (err) { message("myWidgetMessage", err.message, "error"); }
  }
  function closeWidget() { if (!busy) hide("myWidgetOverlay"); }

  async function makeWidget() {
    if (busy) return;
    busy = true;
    $("myWidgetMake").disabled = true;
    try {
      const { token } = await callFn("widget_token");
      const code = script(token);
      $("myWidgetBody").innerHTML = `
        <label class="auth-field">Script<textarea class="mycal-script" readonly rows="6">${esc(code)}</textarea></label>
        <button type="button" class="auth-button" id="myWidgetCopy">Copy script</button>`;
      $("myWidgetCopy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(code); window.showToast?.("Script copied. Paste it into Scriptable."); }
        catch { const ta = document.querySelector(".mycal-script"); ta.focus(); ta.select(); document.execCommand?.("copy"); window.showToast?.("Script copied."); }
      });
      $("myWidgetOff").hidden = false;
      $("myWidgetMake").textContent = "Make a new widget link";
      message("myWidgetMessage", "Widget link made. Copy the script into Scriptable.", "success");
    } catch (err) {
      message("myWidgetMessage", err.message, "error");
    } finally { busy = false; $("myWidgetMake").disabled = false; }
  }

  async function widgetOff() {
    if (busy || !confirm("Turn off your widget link? The widget will stop showing events until you make a new one.")) return;
    busy = true;
    try {
      await callFn("widget_off");
      $("myWidgetBody").innerHTML = "";
      $("myWidgetOff").hidden = true;
      $("myWidgetMake").textContent = "Make my widget";
      message("myWidgetMessage", "Widget link turned off.", "success");
    } catch (err) { message("myWidgetMessage", err.message, "error"); }
    finally { busy = false; }
  }

  /* ---------- start ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    const tools = document.querySelector(".hm-today-tools");
    if (tools && !document.getElementById("myEventAddLink")) {
      const add = document.createElement("a");
      add.href = "#"; add.id = "myEventAddLink"; add.textContent = "+ Event";
      const widget = document.createElement("a");
      widget.href = "#"; widget.id = "myWidgetLink"; widget.textContent = "iPhone widget";
      const toggle = tools.querySelector(".hm-view-toggle");
      tools.insertBefore(widget, toggle ? toggle.nextSibling : tools.firstChild);
      tools.insertBefore(add, widget);
      add.addEventListener("click", e => { e.preventDefault(); openEvent(null, document.querySelector("#todayCalendar:not([hidden]) [aria-pressed='true'][data-day]")?.dataset.day); });
      widget.addEventListener("click", e => { e.preventDefault(); openWidget(); });
    }
    // Your events in the lists are links to "#my-event:<id>".
    document.addEventListener("click", e => {
      const a = e.target.closest('a[href^="#my-event:"]');
      if (!a) return;
      e.preventDefault();
      openEvent(a.getAttribute("href").slice("#my-event:".length));
    });
    // Tapped a phone reminder: /pages/dashboard?event=<id>
    const id = new URLSearchParams(location.search).get("event");
    if (id) {
      const tryOpen = (n) => { if (sb()) openEvent(id); else if (n < 50) setTimeout(() => tryOpen(n + 1), 200); };
      tryOpen(0);
      history.replaceState(null, "", location.pathname);
    }
  });

  window.MyCalendar = { occurrences, open: openEvent, reload: () => load(true), color: COLOR };
})();
