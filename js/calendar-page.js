/* ============================================================================
   calendar-page.js — the Staff Calendar (pages/calendar.html), 2026-11-20

   Day / Week / Month / Agenda views of everything on your calendar:
     My events        your portal events + invites (pending ones are dashed)
     Assigned to me   events someone put on your calendar
     Linked calendars Google / Outlook / iCloud (read-only, via the calendar function)
     Tasks            your tasks + project to-dos
     Deadlines        project timeline items ending
     COI expirations  every vendor's COI expiry (bright red)

   Saving, inviting, answers, busy checks and the private Google / Apple
   link go through the staff-calendar Edge Function. Linked calendars use the
   existing calendar function (ics_connect / sync / disconnect).
============================================================================ */
(function () {
  "use strict";

  const COLORS = { mine: "#085c98", assigned: "#127a68", linked: "#e0702b", tasks: "#7a4fbf", deadlines: "#8a96a3", coi: "#e11d2a" };
  const LINKED_EXTRA = ["#e0702b", "#c2562a", "#d98f1f", "#b8742f"];
  const REMINDER_CHOICES = [[0, "At start"], [5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "1 hour"], [1440, "1 day"], [10080, "1 week"]];
  const HOUR_PX = 48;
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch { return "America/New_York"; } })();
  const HIDDEN_KEY = "staffCalendar.hidden";
  const VIEW_KEY = "staffCalendar.view";

  const $ = (sel, root = document) => root.querySelector(sel);
  const sb = () => window.supabaseClient;
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const sameDay = (a, b) => iso(a) === iso(b);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timeOf = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const toast = (m, type) => window.showToast ? window.showToast(m, { type: type || "success" }) : console.log(m);
  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

  const state = {
    me: null, view: "week", cursor: new Date(), items: [], settings: null,
    staff: [], accounts: [], projects: [], hidden: new Set(), invites: [], loadSeq: 0
  };
  try { (JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]") || []).forEach((k) => state.hidden.add(k)); } catch (_) { /* none */ }

  /* ---------------- server ---------------- */

  async function callFn(fn, body) {
    const { data: { session } } = await sb().auth.getSession();
    const cfg = window.SUPABASE_CONFIG || {};
    const res = await fetch(`${cfg.url}/functions/v1/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey || "", Authorization: `Bearer ${session ? session.access_token : cfg.anonKey}` },
      body: JSON.stringify(body)
    });
    let out = {};
    try { out = await res.json(); } catch (_) { out = {}; }
    if (!res.ok || out.ok === false || out.error) throw new Error(out.error || "Something went wrong. Please try again.");
    return out;
  }
  const cal = (body) => callFn("staff-calendar", body);

  /* ---------------- calendars (left panel) ---------------- */

  function calendarList() {
    const list = [
      { key: "mine", name: "My events", color: COLORS.mine },
      { key: "assigned", name: "Assigned to me", color: COLORS.assigned }
    ];
    state.accounts.forEach((a, i) => list.push({ key: `linked:${a.id}`, name: a.external_account_email || a.provider_label || "Linked calendar", color: LINKED_EXTRA[i % LINKED_EXTRA.length], account: a }));
    list.push({ key: "tasks", name: "Tasks", color: COLORS.tasks });
    list.push({ key: "deadlines", name: "Project deadlines", color: COLORS.deadlines });
    list.push({ key: "coi", name: "COI expirations", color: COLORS.coi });
    return list;
  }
  const colorFor = (key) => (calendarList().find((c) => c.key === key) || {}).color || COLORS.mine;

  function renderCalendars() {
    const box = $("#calList");
    const list = calendarList();
    const allOn = list.every((c) => !state.hidden.has(c.key));
    box.innerHTML = `
      <label class="cal-check cal-check--all"><input type="checkbox" id="calSelectAll" ${allOn ? "checked" : ""}><span>Select all</span></label>
      ${list.map((c) => `
        <label class="cal-check" style="--c:${c.color}">
          <input type="checkbox" data-cal="${esc(c.key)}" ${state.hidden.has(c.key) ? "" : "checked"}>
          <i aria-hidden="true"></i><span>${esc(c.name)}</span>
        </label>`).join("")}
      ${state.accounts.length ? "" : `<button type="button" class="cal-text-btn" data-open="settings-linked">+ Link your Google calendar</button>`}`;
    $("#calSelectAll").addEventListener("change", (e) => {
      list.forEach((c) => { if (e.target.checked) state.hidden.delete(c.key); else state.hidden.add(c.key); });
      saveHidden(); renderCalendars(); render();
    });
    box.querySelectorAll("[data-cal]").forEach((cb) => cb.addEventListener("change", () => {
      if (cb.checked) state.hidden.delete(cb.dataset.cal); else state.hidden.add(cb.dataset.cal);
      saveHidden(); renderCalendars(); render();
    }));
  }
  function saveHidden() { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden])); } catch (_) { /* fine */ } }

  /* ---------------- range + data ---------------- */

  function weekStart(d) {
    const ws = state.settings?.week_start || 0;
    return addD(d, -((d.getDay() - ws + 7) % 7));
  }
  function range() {
    const c = state.cursor;
    if (state.view === "day") return [c, c];
    if (state.view === "week") { const s = weekStart(c); return [s, addD(s, 6)]; }
    if (state.view === "agenda") return [c, addD(c, 59)];
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const s = weekStart(first);
    return [s, addD(s, 41)];
  }

  async function loadItems() {
    const seq = ++state.loadSeq;
    const [from, to] = range();
    const f = iso(from), t = iso(to);
    const startIso = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
    const endIso = addD(to, 1).toISOString();
    const me = state.me;
    const [portal, assignedByMe, linked, tasks, todos, projects, coi] = await Promise.all([
      window.MyCalendar.load(true).then(() => window.MyCalendar.occurrences(f, t)).catch(() => []),
      sb().from("my_calendar_events").select("*").eq("staff_id", me).eq("organizer_attends", false),
      sb().from("calendar_events_cache").select("id, title, start_time, end_time, location, all_day, account_id").eq("user_id", me).lt("start_time", endIso).gt("end_time", startIso).order("start_time").limit(1500),
      sb().from("tasks").select("id, task_name, due_date").eq("user_id", me).eq("completed", false).gte("due_date", f).lte("due_date", t),
      sb().from("project_todo_subitems").select("id, label, due_date, project_id, projects(name)").eq("assigned_to", me).eq("completed", false).gte("due_date", f).lte("due_date", t),
      sb().from("projects").select("id, name").eq("status", "active"),
      sb().from("Companies").select("id, Name, COIExpiresOn, COIExempt").gte("COIExpiresOn", f).lte("COIExpiresOn", t)
    ]);
    if (seq !== state.loadSeq) return;
    const items = [];
    // Portal events.
    portal.forEach((o) => items.push({
      key: `p:${o.id}:${o.date}`, cal: o.kind === "assign" ? "assigned" : "mine", eventId: o.id, date: o.date,
      title: o.title, sub: o.location, start: o.start, end: o.end, allDay: o.all_day, pending: o.pending
    }));
    // Events you only assigned to other people (you're not going): shown faded.
    (assignedByMe.data || []).forEach((ev) => {
      window.MyCalendar.occurrenceDates(ev, f, t).forEach((date) => {
        const span = window.MyCalendar.daysBetween(ev.start_date, ev.end_date || ev.start_date);
        const endDate = window.MyCalendar.addDays(date, span);
        const start = new Date(`${date}T${ev.all_day ? "00:00" : String(ev.start_time).slice(0, 5)}`);
        const end = ev.all_day ? new Date(`${window.MyCalendar.addDays(endDate, 1)}T00:00`) : new Date(`${endDate}T${String(ev.end_time || ev.start_time).slice(0, 5)}`);
        items.push({ key: `p:${ev.id}:${date}`, cal: "mine", eventId: ev.id, date, title: ev.title, sub: "You assigned this", start, end, allDay: ev.all_day, faded: true });
      });
    });
    // Linked calendars.
    (linked.data || []).forEach((e) => {
      const s = new Date(e.start_time), en = new Date(e.end_time || e.start_time);
      items.push({ key: `l:${e.id}`, cal: `linked:${e.account_id}`, title: e.title || "Busy", sub: e.location || "", start: s, end: en, allDay: !!e.all_day, readOnly: true });
    });
    const dayItem = (date, rest) => { const s = parseDay(date); return { ...rest, start: s, end: addD(s, 1), allDay: true }; };
    (tasks.data || []).forEach((x) => items.push(dayItem(x.due_date, { key: `t:${x.id}`, cal: "tasks", title: x.task_name, sub: "Personal task", href: "/pages/staff-todo.html" })));
    (todos.data || []).forEach((x) => items.push(dayItem(x.due_date, { key: `td:${x.id}`, cal: "tasks", title: x.label, sub: x.projects?.name || "Project to-do", href: `/pages/project-todo.html?id=${encodeURIComponent(x.project_id)}` })));
    state.projects = projects.data || [];
    if (state.projects.length) {
      const names = new Map(state.projects.map((p) => [p.id, p.name]));
      const { data } = await sb().from("schedule_tasks").select("id, name, item_type, end_date, project_id")
        .in("project_id", state.projects.map((p) => p.id)).neq("status", "complete").gte("end_date", f).lte("end_date", t);
      if (seq !== state.loadSeq) return;
      (data || []).forEach((x) => items.push(dayItem(x.end_date, { key: `d:${x.id}`, cal: "deadlines", title: x.name, sub: `${names.get(x.project_id) || "Project"}${x.item_type === "milestone" ? " · Milestone" : ""}`, href: `/pages/project-timeline.html?id=${encodeURIComponent(x.project_id)}` })));
    }
    (coi.data || []).filter((c) => !c.COIExempt).forEach((c) => items.push(dayItem(c.COIExpiresOn, {
      key: `c:${c.id}`, cal: "coi", title: `COI expires · ${c.Name || "Vendor"}`, sub: "Certificate of insurance", href: `/pages/vendor.html?id=${encodeURIComponent(c.id)}`
    })));
    state.items = items.sort((a, b) => a.start - b.start);
    render();
  }

  // Invites you haven't answered (upcoming).
  async function loadInvites() {
    const data = await window.MyCalendar.load();
    const today = iso(new Date());
    state.invites = data.events.filter((ev) => {
      const p = data.mine.get(ev.id);
      if (!p || p.role !== "invite" || p.response !== "pending") return false;
      return (ev.repeat && ev.repeat !== "none") ? (!ev.repeat_until || ev.repeat_until >= today) : (ev.end_date || ev.start_date) >= today;
    });
    const line = $("#calInvites");
    if (!state.invites.length) { line.hidden = true; return; }
    line.hidden = false;
    line.innerHTML = `<strong>${state.invites.length} ${state.invites.length === 1 ? "invite" : "invites"} waiting</strong>
      ${state.invites.slice(0, 3).map((ev) => `<button type="button" class="cal-invite-chip" data-event="${esc(ev.id)}">${esc(ev.title)} · ${esc(whenOf(ev))}</button>`).join("")}`;
    line.querySelectorAll("[data-event]").forEach((b) => b.addEventListener("click", () => openEvent(b.dataset.event)));
  }

  function whenOf(ev) {
    const d = parseDay(ev.start_date);
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (ev.all_day) return `${day} · All day`;
    return `${day} · ${window.MyCalendar.timeText(String(ev.start_time).slice(0, 5))}`;
  }

  /* ---------------- views ---------------- */

  const visible = () => state.items.filter((i) => !state.hidden.has(i.cal));

  function title() {
    const c = state.cursor;
    if (state.view === "day") return c.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (state.view === "week") {
      const [s, e] = range();
      const sameMonth = s.getMonth() === e.getMonth();
      return `${s.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${e.toLocaleDateString("en-US", sameMonth ? { day: "numeric", year: "numeric" } : { month: "long", day: "numeric", year: "numeric" })}`;
    }
    if (state.view === "agenda") return `From ${c.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
    return c.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function render() {
    $("#calTitle").textContent = title();
    document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
    const body = $("#calBody");
    body.className = `cal-body cal-body--${state.view}`;
    if (state.view === "month") body.innerHTML = monthHtml();
    else if (state.view === "agenda") body.innerHTML = agendaHtml();
    else body.innerHTML = gridHtml(state.view === "day" ? [state.cursor] : Array.from({ length: 7 }, (_, i) => addD(range()[0], i)));
    if (state.view === "day" || state.view === "week") {
      const scroller = $(".cal-grid-scroll", body);
      const ws = Number(String(state.settings?.work_start || "07:00").slice(0, 2));
      if (scroller && !scroller.dataset.scrolled) { scroller.scrollTop = Math.max(0, (ws - 0.5) * HOUR_PX); scroller.dataset.scrolled = "1"; }
      wireGridCreate(body);
    }
    body.querySelectorAll("[data-item]").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); openItem(el.dataset.item); }));
    body.querySelectorAll("[data-goday]").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); state.cursor = parseDay(el.dataset.goday); setView("day"); }));
    renderMini();
  }

  function chip(i, extra = "") {
    const time = i.allDay ? "" : `<b>${esc(timeOf(i.start))}</b> `;
    return `<button type="button" class="cal-chip ${i.pending ? "is-pending" : ""} ${i.faded ? "is-faded" : ""} ${extra}" style="--c:${colorFor(i.cal)}" data-item="${esc(i.key)}" title="${esc(i.title)}">${time}${esc(i.title)}</button>`;
  }

  function onDay(i, d) {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()), e = addD(s, 1);
    return i.start < e && (i.end > s || (i.end.getTime() === i.start.getTime() && i.start >= s));
  }

  function monthHtml() {
    const [s] = range();
    const month = state.cursor.getMonth();
    const today = new Date();
    const items = visible();
    const heads = Array.from({ length: 7 }, (_, i) => addD(s, i).toLocaleDateString("en-US", { weekday: "short" }));
    const cells = Array.from({ length: 42 }, (_, n) => {
      const d = addD(s, n);
      const list = items.filter((i) => onDay(i, d)).sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
      const more = list.length > 3 ? `<button type="button" class="cal-more" data-goday="${iso(d)}">+${list.length - 3} more</button>` : "";
      return `<div class="cal-mcell ${d.getMonth() !== month ? "is-out" : ""} ${sameDay(d, today) ? "is-today" : ""}" data-newday="${iso(d)}">
        <button type="button" class="cal-mday" data-goday="${iso(d)}">${d.getDate()}</button>
        ${list.slice(0, 3).map((i) => chip(i)).join("")}${more}</div>`;
    }).join("");
    return `<div class="cal-month"><div class="cal-mhead">${heads.map((h) => `<span>${h}</span>`).join("")}</div><div class="cal-mgrid">${cells}</div></div>`;
  }

  function agendaHtml() {
    const items = visible();
    const [s] = range();
    const days = [];
    for (let n = 0; n < 60; n++) {
      const d = addD(s, n);
      const list = items.filter((i) => onDay(i, d));
      if (list.length) days.push({ d, list });
    }
    if (!days.length) return `<p class="cal-empty">Nothing in the next 60 days.</p>`;
    return `<div class="cal-agenda">${days.map(({ d, list }) => `
      <section class="cal-aday ${sameDay(d, new Date()) ? "is-today" : ""}">
        <h3>${esc(d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))}</h3>
        <div>${list.map((i) => `
          <button type="button" class="cal-arow ${i.pending ? "is-pending" : ""} ${i.faded ? "is-faded" : ""}" style="--c:${colorFor(i.cal)}" data-item="${esc(i.key)}">
            <i aria-hidden="true"></i>
            <span class="cal-arow-time">${i.allDay ? "All day" : `${esc(timeOf(i.start))} – ${esc(timeOf(i.end))}`}</span>
            <span class="cal-arow-title">${esc(i.title)}${i.pending ? ' <em>Invite</em>' : ""}${i.sub ? `<small>${esc(i.sub)}</small>` : ""}</span>
          </button>`).join("")}</div>
      </section>`).join("")}</div>`;
  }

  // Lay out the timed events of one day side by side when they overlap.
  function layoutDay(list) {
    const cols = [];
    const placed = list.map((i) => ({ i }));
    placed.forEach((p) => {
      let c = cols.findIndex((end) => end <= p.i.start.getTime());
      if (c === -1) { c = cols.length; cols.push(0); }
      cols[c] = p.i.end.getTime();
      p.col = c;
    });
    // Width: how many columns are in use while this one runs.
    placed.forEach((p) => {
      const overl = placed.filter((q) => q.i.start < p.i.end && q.i.end > p.i.start);
      p.cols = Math.max(...overl.map((q) => q.col)) + 1;
    });
    return placed;
  }

  function gridHtml(days) {
    const items = visible();
    const now = new Date();
    const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hour"><span>${h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" })}</span></div>`).join("");
    const head = days.map((d) => `<button type="button" class="cal-dhead ${sameDay(d, now) ? "is-today" : ""}" data-goday="${iso(d)}">
      <small>${d.toLocaleDateString("en-US", { weekday: "short" })}</small><b>${d.getDate()}</b></button>`).join("");
    const allDay = days.map((d) => `<div class="cal-allday-cell">${items.filter((i) => i.allDay && onDay(i, d)).map((i) => chip(i)).join("")}</div>`).join("");
    const cols = days.map((d) => {
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()), e = addD(s, 1);
      const timed = items.filter((i) => !i.allDay && i.start < e && i.end > s).sort((a, b) => a.start - b.start || b.end - a.end);
      const blocks = layoutDay(timed).map((p) => {
        const st = Math.max(p.i.start, s), en = Math.min(p.i.end, e);
        const top = ((st - s) / 3600000) * HOUR_PX;
        const h = Math.max(20, ((en - st) / 3600000) * HOUR_PX - 2);
        const w = 100 / p.cols;
        return `<button type="button" class="cal-block ${p.i.pending ? "is-pending" : ""} ${p.i.faded ? "is-faded" : ""}" data-item="${esc(p.i.key)}"
          style="--c:${colorFor(p.i.cal)};top:${top}px;height:${h}px;left:calc(${p.col * w}% + 2px);width:calc(${w}% - 4px)">
          <b>${esc(p.i.title)}</b><small>${esc(timeOf(p.i.start))}${p.i.sub ? ` · ${esc(p.i.sub)}` : ""}</small></button>`;
      }).join("");
      const nowLine = sameDay(d, now) ? `<div class="cal-now" style="top:${((now - s) / 3600000) * HOUR_PX}px"></div>` : "";
      return `<div class="cal-col" data-newday="${iso(d)}">${blocks}${nowLine}</div>`;
    }).join("");
    return `<div class="cal-grid" style="--days:${days.length}">
      <div class="cal-grid-head"><span></span>${head}</div>
      <div class="cal-grid-allday"><span>All day</span>${allDay}</div>
      <div class="cal-grid-scroll"><div class="cal-grid-inner" style="height:${24 * HOUR_PX}px"><div class="cal-hours">${hours}</div>${cols}</div></div>
    </div>`;
  }

  // Click an empty spot in the grid → new event at that time.
  function wireGridCreate(body) {
    body.querySelectorAll(".cal-col").forEach((col) => col.addEventListener("click", (e) => {
      if (e.target !== col) return;
      const rect = col.getBoundingClientRect();
      const mins = Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30;
      openEditor(null, { date: col.dataset.newday, time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` });
    }));
  }

  /* ---------------- mini month ---------------- */

  let miniShown = null;
  function renderMini() {
    const box = $("#calMini");
    if (!miniShown || state.view !== "month") miniShown = new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1);
    const first = miniShown;
    const s = weekStart(first);
    const today = new Date();
    const heads = Array.from({ length: 7 }, (_, i) => addD(s, i).toLocaleDateString("en-US", { weekday: "narrow" }));
    const [rs, re] = range();
    box.innerHTML = `
      <div class="cal-mini-head">
        <strong>${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
        <span><button type="button" data-mini="-1" aria-label="Previous month">‹</button><button type="button" data-mini="1" aria-label="Next month">›</button></span>
      </div>
      <div class="cal-mini-grid">${heads.map((h) => `<span>${h}</span>`).join("")}
        ${Array.from({ length: 42 }, (_, n) => {
          const d = addD(s, n);
          const inRange = d >= new Date(rs.getFullYear(), rs.getMonth(), rs.getDate()) && d <= re && state.view !== "month" && state.view !== "agenda";
          return `<button type="button" data-mday="${iso(d)}" class="${d.getMonth() !== first.getMonth() ? "is-out" : ""} ${sameDay(d, today) ? "is-today" : ""} ${inRange ? "is-range" : ""} ${sameDay(d, state.cursor) ? "is-sel" : ""}">${d.getDate()}</button>`;
        }).join("")}</div>`;
    box.querySelectorAll("[data-mini]").forEach((b) => b.addEventListener("click", () => { miniShown = new Date(first.getFullYear(), first.getMonth() + Number(b.dataset.mini), 1); renderMini(); }));
    box.querySelectorAll("[data-mday]").forEach((b) => b.addEventListener("click", () => { state.cursor = parseDay(b.dataset.mday); if (isPhone()) closePanel(); refresh(); }));
  }

  /* ---------------- navigation ---------------- */

  function setView(v) {
    state.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* fine */ }
    refresh();
  }
  function step(n) {
    const c = state.cursor;
    if (state.view === "day") state.cursor = addD(c, n);
    else if (state.view === "week") state.cursor = addD(c, 7 * n);
    else if (state.view === "agenda") state.cursor = addD(c, 30 * n);
    else state.cursor = new Date(c.getFullYear(), c.getMonth() + n, 1);
    refresh();
  }
  function refresh() {
    $("#calTitle").textContent = title();
    loadItems().catch((err) => { console.error(err); toast("Couldn't load your calendar.", "error"); });
  }

  /* ---------------- popups ---------------- */

  function popup(html, cls = "") {
    closePopup();
    const ov = document.createElement("div");
    ov.className = "cal-pop-overlay";
    ov.innerHTML = `<div class="cal-pop ${cls}" role="dialog" aria-modal="true">
      <button type="button" class="cal-pop-x" aria-label="Close">✕</button>${html}</div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) closePopup(); });
    $(".cal-pop-x", ov).addEventListener("click", closePopup);
    requestAnimationFrame(() => ov.classList.add("is-open"));
    return $(".cal-pop", ov);
  }
  function closePopup() { document.querySelectorAll(".cal-pop-overlay").forEach((o) => o.remove()); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopup(); });
  const msg = (box, text, type) => { if (!box) return; box.textContent = text || ""; box.className = `cal-msg ${type ? `cal-msg--${type}` : ""}`; };

  function openItem(key) {
    const i = state.items.find((x) => x.key === key);
    if (!i) return;
    if (i.eventId) return openEvent(i.eventId, i.date);
    const name = (calendarList().find((c) => c.key === i.cal) || {}).name || "";
    const when = i.allDay ? i.start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : `${i.start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · ${timeOf(i.start)} – ${timeOf(i.end)}`;
    popup(`
      <div class="cal-ev-head" style="--c:${colorFor(i.cal)}"><i></i><div><h2>${esc(i.title)}</h2><p>${esc(when)}</p></div></div>
      ${i.sub ? `<p class="cal-ev-line">${esc(i.sub)}</p>` : ""}
      <p class="cal-ev-line cal-soft">${esc(name)}${i.readOnly ? " · Change this one in its own calendar app." : ""}</p>
      ${i.href ? `<div class="cal-actions"><a class="auth-button" href="${esc(i.href)}">Open ›</a></div>` : ""}`);
  }

  async function fetchEvent(id) {
    const [{ data: ev }, { data: people }] = await Promise.all([
      sb().from("my_calendar_events").select("*").eq("id", id).maybeSingle(),
      sb().from("calendar_event_people").select("staff_id, role, response, reminders, responded_at").eq("event_id", id)
    ]);
    return { ev, people: people || [] };
  }
  const staffName = (id) => { const s = state.staff.find((x) => x.id === id); return s ? (s.full_name || s.username) : "Someone"; };

  async function openEvent(id, date) {
    const { ev, people } = await fetchEvent(id);
    if (!ev) { toast("That event was canceled or you're not on it anymore.", "error"); return; }
    const mine = people.find((p) => p.staff_id === state.me);
    const organizer = ev.staff_id === state.me;
    const color = mine?.role === "assign" ? COLORS.assigned : COLORS.mine;
    const repeatText = ev.repeat && ev.repeat !== "none" ? ` · Repeats ${ev.repeat}${ev.repeat_until ? ` until ${parseDay(ev.repeat_until).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}` : "";
    const occDate = date || ev.start_date;
    const d = parseDay(occDate);
    const when = ev.all_day ? `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · All day`
      : `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · ${window.MyCalendar.timeText(String(ev.start_time).slice(0, 5))} – ${window.MyCalendar.timeText(String(ev.end_time || ev.start_time).slice(0, 5))}`;
    const project = ev.project_id ? state.projects.find((p) => p.id === ev.project_id) : null;
    const RESP = { pending: "Waiting", accepted: "Going", declined: "Can't go", conflict: "Has a conflict" };
    const peopleHtml = people.length ? `
      <div class="cal-sec"><h3>People</h3>
        <ul class="cal-people">
          <li><span>${esc(staffName(ev.staff_id))}</span><em>Organizer${ev.organizer_attends === false ? " · not going" : ""}</em></li>
          ${people.map((p) => `<li class="is-${p.response}"><span>${esc(staffName(p.staff_id))}</span>
            <em>${p.role === "assign" ? "Assigned" : RESP[p.response] || p.response}</em></li>`).join("")}
        </ul></div>` : "";
    const trouble = organizer && people.some((p) => p.response === "conflict" || p.response === "declined");
    const remindersOf = organizer ? (ev.reminders || []) : (mine?.reminders || []);

    let actions = "";
    if (organizer) {
      actions = `<div class="cal-actions">
        ${trouble ? `<button type="button" class="auth-button" id="calMoveBtn">Find a new time</button>` : ""}
        <button type="button" class="auth-button ${trouble ? "auth-button--secondary" : ""}" id="calEditBtn">Edit</button>
        <button type="button" class="auth-button auth-button--secondary cal-danger" id="calDeleteBtn">Delete</button></div>`;
    } else if (mine?.role === "invite") {
      actions = `<div class="cal-sec"><h3>Your answer</h3><div class="cal-rsvp">
        <button type="button" data-rsvp="accepted" class="${mine.response === "accepted" ? "is-on" : ""}">Accept</button>
        <button type="button" data-rsvp="declined" class="${mine.response === "declined" ? "is-on" : ""}">Decline</button>
        <button type="button" data-rsvp="conflict" class="${mine.response === "conflict" ? "is-on" : ""}">Decline – I have a conflict</button>
      </div><p class="cal-soft cal-small">"I have a conflict" tells ${esc(staffName(ev.staff_id))} what's in the way so they can move it.</p></div>`;
    } else if (mine?.role === "assign") {
      actions = `<p class="cal-ev-line cal-soft">${esc(staffName(ev.staff_id))} put this on your calendar.</p>`;
    }

    const box = popup(`
      <div class="cal-ev-head" style="--c:${color}"><i></i><div><h2>${esc(ev.title)}</h2><p>${esc(when)}${esc(repeatText)}</p></div></div>
      ${ev.location ? `<p class="cal-ev-line">📍 ${esc(ev.location)}</p>` : ""}
      ${project ? `<p class="cal-ev-line"><a href="/pages/project-home.html?id=${esc(project.id)}">${esc(project.name)} ›</a></p>` : ""}
      ${ev.notes ? `<p class="cal-ev-notes">${esc(ev.notes)}</p>` : ""}
      ${peopleHtml}
      ${(organizer || mine) ? `<div class="cal-sec"><h3>Phone reminders</h3><div class="cal-rem" id="calRemPick">${remPick(remindersOf)}</div></div>` : ""}
      <div id="calMoveBox"></div>
      <p class="cal-msg" id="calEvMsg"></p>
      ${actions}`, "cal-pop--event");

    // Your own reminders.
    box.querySelectorAll("#calRemPick [data-rem]").forEach((b) => b.addEventListener("click", async () => {
      b.classList.toggle("is-on");
      const list = [...box.querySelectorAll("#calRemPick .is-on")].map((x) => Number(x.dataset.rem));
      const q = organizer
        ? sb().from("my_calendar_events").update({ reminders: list }).eq("id", ev.id)
        : sb().from("calendar_event_people").update({ reminders: list }).eq("event_id", ev.id).eq("staff_id", state.me);
      const { error } = await q;
      msg($("#calEvMsg", box), error ? "Couldn't save your reminders." : "Reminders saved.", error ? "error" : "ok");
    }));
    box.querySelectorAll("[data-rsvp]").forEach((b) => b.addEventListener("click", async () => {
      box.querySelectorAll("[data-rsvp]").forEach((x) => { x.disabled = true; });
      try {
        await cal({ action: "respond", id: ev.id, response: b.dataset.rsvp });
        toast(b.dataset.rsvp === "accepted" ? "You're going." : b.dataset.rsvp === "conflict" ? `${staffName(ev.staff_id)} knows you have a conflict.` : "Declined.");
        closePopup(); await afterChange();
      } catch (err) { msg($("#calEvMsg", box), err.message, "error"); box.querySelectorAll("[data-rsvp]").forEach((x) => { x.disabled = false; }); }
    }));
    $("#calEditBtn", box)?.addEventListener("click", () => openEditor(ev, null, people));
    $("#calDeleteBtn", box)?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!btn.dataset.sure) { btn.dataset.sure = "1"; btn.textContent = people.length ? "Delete and tell everyone" : "Tap again to delete"; return; }
      btn.disabled = true;
      try { await cal({ action: "delete", id: ev.id }); toast("Event deleted."); closePopup(); await afterChange(); }
      catch (err) { btn.disabled = false; msg($("#calEvMsg", box), err.message, "error"); }
    });
    $("#calMoveBtn", box)?.addEventListener("click", () => showMove(ev, people, $("#calMoveBox", box), $("#calEvMsg", box)));
  }

  function remPick(on) {
    return REMINDER_CHOICES.map(([m, label]) => `<button type="button" data-rem="${m}" class="${(on || []).includes(m) ? "is-on" : ""}">${label}</button>`).join("");
  }

  function minutesOf(ev) {
    if (ev.all_day) return 60;
    const s = new Date(`${ev.start_date}T${String(ev.start_time).slice(0, 5)}`);
    const e = new Date(`${ev.end_date || ev.start_date}T${String(ev.end_time || ev.start_time).slice(0, 5)}`);
    return Math.max(15, Math.round((e - s) / 60000));
  }

  // Organizer: free times for everyone, one tap to move the event.
  async function showMove(ev, people, box, msgBox) {
    box.innerHTML = `<div class="cal-sec"><h3>Free for everyone</h3><p class="cal-soft cal-small">Looking…</p></div>`;
    try {
      const ids = people.filter((p) => p.response !== "declined").map((p) => p.staff_id);
      const r = await cal({ action: "suggest", staff_ids: ids, minutes: minutesOf(ev), exclude_id: ev.id });
      if (!r.times.length) { box.innerHTML = `<div class="cal-sec"><h3>Free for everyone</h3><p class="cal-soft cal-small">No time works for everyone in the next 10 days. Edit the event to pick one.</p></div>`; return; }
      box.innerHTML = `<div class="cal-sec"><h3>Free for everyone</h3><div class="cal-suggest">${r.times.map((t) => {
        const d = new Date(t);
        return `<button type="button" data-move="${t}">Move to ${esc(d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))} · ${esc(timeOf(d))}</button>`;
      }).join("")}</div></div>`;
      box.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        const s = new Date(b.dataset.move), e = new Date(s.getTime() + minutesOf(ev) * 60000);
        try {
          await cal({ action: "save", event: { ...ev, all_day: false, start_date: iso(s), start_time: hhmm(s), end_date: iso(e), end_time: hhmm(e), tz: TZ }, people: people.map((p) => ({ staff_id: p.staff_id, role: p.role })) });
          toast("Moved. Everyone was told the new time.");
          closePopup(); await afterChange();
        } catch (err) { b.disabled = false; msg(msgBox, err.message, "error"); }
      }));
    } catch (err) { box.innerHTML = ""; msg(msgBox, err.message, "error"); }
  }

  /* ---------------- event editor ---------------- */

  async function openEditor(ev, preset, people) {
    if (ev && !people) people = (await fetchEvent(ev.id)).people;
    people = (people || []).map((p) => ({ staff_id: p.staff_id, role: p.role, response: p.response }));
    const now = new Date();
    const startDate = ev?.start_date || preset?.date || iso(state.cursor || now);
    const startTime = ev?.start_time ? String(ev.start_time).slice(0, 5) : (preset?.time || `${pad(Math.min(now.getHours() + 1, 23))}:00`);
    const endT = (() => { const [h, m] = startTime.split(":").map(Number); const t = h * 60 + m + 60; return t >= 24 * 60 ? "23:59" : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; })();
    const defaults = state.settings?.default_reminders || [15];
    const box = popup(`
      <h2>${ev ? "Edit event" : "New event"}</h2>
      <form id="calForm" class="cal-form" autocomplete="off">
        <input class="cal-title-input" name="title" maxlength="200" placeholder="Add a title" value="${esc(ev?.title || "")}" required>
        <div class="cal-row">
          <label>Starts<input type="date" name="start_date" value="${esc(startDate)}" required></label>
          <label class="cal-t">&nbsp;<input type="time" name="start_time" value="${esc(startTime)}"></label>
          <label>Ends<input type="date" name="end_date" value="${esc(ev?.end_date || startDate)}"></label>
          <label class="cal-t">&nbsp;<input type="time" name="end_time" value="${esc(ev?.end_time ? String(ev.end_time).slice(0, 5) : endT)}"></label>
        </div>
        <div class="cal-row">
          <label class="cal-inline"><input type="checkbox" name="all_day" ${ev?.all_day ? "checked" : ""}> All day</label>
          <label>Repeats<select name="repeat">${["none", "daily", "weekly", "monthly", "yearly"].map((r) => `<option value="${r}" ${(ev?.repeat || "none") === r ? "selected" : ""}>${r === "none" ? "Doesn't repeat" : r[0].toUpperCase() + r.slice(1)}</option>`).join("")}</select></label>
          <label class="cal-until" ${(ev?.repeat || "none") === "none" ? "hidden" : ""}>Until <span class="cal-optional">(optional)</span><input type="date" name="repeat_until" value="${esc(ev?.repeat_until || "")}"></label>
        </div>
        <label>Location<input name="location" maxlength="200" value="${esc(ev?.location || "")}" placeholder="Job site, office, call…"></label>
        <label>Project <span class="cal-optional">(optional)</span><select name="project_id"><option value="">None</option>${state.projects.map((p) => `<option value="${esc(p.id)}" ${ev?.project_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <div class="cal-sec"><h3>People</h3>
          <p class="cal-soft cal-small"><b>Invite</b> asks them to accept or decline. <b>Assign</b> just puts it on their calendar.</p>
          <div class="cal-people-pick">
            <input type="search" id="calPersonSearch" placeholder="Add people…">
            <div class="cal-person-results" id="calPersonResults" hidden></div>
          </div>
          <ul class="cal-people cal-people--edit" id="calPeopleList"></ul>
          <label class="cal-inline" id="calAttendRow" hidden><input type="checkbox" name="organizer_attends" ${ev?.organizer_attends !== false ? "checked" : ""}> I'm going too</label>
          <div id="calBusyNote"></div>
        </div>
        <div class="cal-sec"><h3>Phone reminders</h3><div class="cal-rem" id="calRemEdit">${remPick(ev ? (ev.reminders || []) : defaults)}</div></div>
        <label>Notes<textarea name="notes" rows="3" maxlength="2000">${esc(ev?.notes || "")}</textarea></label>
        <p class="cal-msg" id="calFormMsg"></p>
        <div class="cal-actions">
          <button type="button" class="auth-button auth-button--secondary" id="calCancel">Cancel</button>
          <button type="submit" class="auth-button" id="calSave">${ev ? "Save" : people.length ? "Save and send" : "Save"}</button>
        </div>
      </form>`, "cal-pop--editor");

    const form = $("#calForm", box);
    const f = (n) => form.elements[n];
    const syncAllDay = () => form.querySelectorAll('input[type="time"]').forEach((x) => { x.disabled = f("all_day").checked; x.closest("label").hidden = f("all_day").checked; });
    syncAllDay();
    f("all_day").addEventListener("change", () => { syncAllDay(); checkBusy(); });
    f("repeat").addEventListener("change", () => { $(".cal-until", form).hidden = f("repeat").value === "none"; });
    f("start_date").addEventListener("change", () => { if (!f("end_date").value || f("end_date").value < f("start_date").value) f("end_date").value = f("start_date").value; checkBusy(); });
    f("start_time").addEventListener("change", () => {
      const [h, m] = f("start_time").value.split(":").map(Number);
      const t = h * 60 + m + (ev ? minutesOf(ev) : 60);
      if (f("end_date").value === f("start_date").value) f("end_time").value = t >= 1440 ? "23:59" : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      checkBusy();
    });
    ["end_date", "end_time"].forEach((n) => f(n).addEventListener("change", checkBusy));
    box.querySelectorAll("#calRemEdit [data-rem]").forEach((b) => b.addEventListener("click", () => b.classList.toggle("is-on")));
    $("#calCancel", box).addEventListener("click", closePopup);

    // People picker.
    let busy = {};
    const search = $("#calPersonSearch", box), results = $("#calPersonResults", box);
    function drawPeople() {
      $("#calPeopleList", box).innerHTML = people.map((p, n) => {
        const b = busy[p.staff_id] || [];
        const chipTxt = busy.__loading ? "" : b.length ? `<span class="cal-busy is-busy">Busy · ${esc(b[0].title)}</span>` : `<span class="cal-busy">Free</span>`;
        return `<li><span>${esc(staffName(p.staff_id))}</span>${chipTxt}
          <select data-role="${n}" aria-label="Invite or assign"><option value="invite" ${p.role === "invite" ? "selected" : ""}>Invite</option><option value="assign" ${p.role === "assign" ? "selected" : ""}>Assign</option></select>
          <button type="button" class="cal-x" data-remove="${n}" aria-label="Remove">✕</button></li>`;
      }).join("");
      $("#calPeopleList", box).querySelectorAll("[data-role]").forEach((s) => s.addEventListener("change", () => { people[Number(s.dataset.role)].role = s.value; drawPeople(); }));
      $("#calPeopleList", box).querySelectorAll("[data-remove]").forEach((x) => x.addEventListener("click", () => { people.splice(Number(x.dataset.remove), 1); drawPeople(); checkBusy(); }));
      $("#calAttendRow", box).hidden = !people.length || people.some((p) => p.role === "invite");
      $("#calSave", box).textContent = ev ? "Save" : people.length ? "Save and send" : "Save";
      drawBusyNote();
    }
    function drawBusyNote() {
      const note = $("#calBusyNote", box);
      const taken = people.filter((p) => (busy[p.staff_id] || []).length);
      if (!taken.length || busy.__loading) { note.innerHTML = ""; return; }
      note.innerHTML = `<div class="cal-warn"><p><b>${esc(taken.map((p) => staffName(p.staff_id)).join(", "))}</b> ${taken.length === 1 ? "is" : "are"} busy then.</p>
        <button type="button" class="cal-text-btn" id="calFindTime">Find a time that works</button><div class="cal-suggest" id="calSuggest"></div></div>`;
      $("#calFindTime", note).addEventListener("click", async () => {
        const sug = $("#calSuggest", note);
        sug.textContent = "Looking…";
        try {
          const s0 = whenFromForm();
          const mins = s0 ? Math.max(15, Math.round((s0.end - s0.start) / 60000)) : 60;
          const r = await cal({ action: "suggest", staff_ids: people.map((p) => p.staff_id), minutes: mins, exclude_id: ev?.id || null });
          sug.innerHTML = r.times.length ? r.times.map((t) => { const d = new Date(t); return `<button type="button" data-time="${t}">${esc(d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))} · ${esc(timeOf(d))}</button>`; }).join("")
            : "No time works for everyone in the next 10 days.";
          sug.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => {
            const s = new Date(b.dataset.time), e = new Date(s.getTime() + mins * 60000);
            f("all_day").checked = false; syncAllDay();
            f("start_date").value = iso(s); f("start_time").value = hhmm(s); f("end_date").value = iso(e); f("end_time").value = hhmm(e);
            checkBusy();
          }));
        } catch (err) { sug.textContent = err.message; }
      });
    }
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const taken = new Set([state.me, ...people.map((p) => p.staff_id)]);
      const hits = state.staff.filter((s) => !taken.has(s.id) && (!q || `${s.full_name || ""} ${s.username || ""} ${s.workgroup || ""}`.toLowerCase().includes(q))).slice(0, 8);
      results.hidden = !hits.length;
      results.innerHTML = hits.map((s) => `<button type="button" data-add="${esc(s.id)}">${esc(s.full_name || s.username)}${s.workgroup ? `<small>${esc(s.workgroup)}</small>` : ""}</button>`).join("");
      results.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        people.push({ staff_id: b.dataset.add, role: "invite", response: "pending" });
        search.value = ""; results.hidden = true; drawPeople(); checkBusy();
      }));
    });
    search.addEventListener("focus", () => search.dispatchEvent(new Event("input")));
    search.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));

    function whenFromForm() {
      if (!f("start_date").value) return null;
      if (f("all_day").checked) return { start: parseDay(f("start_date").value), end: addD(parseDay(f("end_date").value || f("start_date").value), 1) };
      if (!f("start_time").value) return null;
      return { start: new Date(`${f("start_date").value}T${f("start_time").value}`), end: new Date(`${f("end_date").value || f("start_date").value}T${f("end_time").value || f("start_time").value}`) };
    }
    let busySeq = 0;
    async function checkBusy() {
      const w = whenFromForm();
      if (!people.length || !w || f("all_day").checked || w.end <= w.start) { busy = {}; drawPeople(); return; }
      const seq = ++busySeq;
      busy = { __loading: true }; drawPeople();
      try {
        const r = await cal({ action: "busy", staff_ids: people.map((p) => p.staff_id), start: w.start.toISOString(), end: w.end.toISOString(), exclude_id: ev?.id || null });
        if (seq === busySeq) { busy = r.busy || {}; drawPeople(); }
      } catch (_) { if (seq === busySeq) { busy = {}; drawPeople(); } }
    }
    drawPeople(); checkBusy();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const save = $("#calSave", box);
      save.disabled = true;
      msg($("#calFormMsg", box), "Saving…");
      const event = {
        id: ev?.id || null, title: f("title").value, location: f("location").value, notes: f("notes").value,
        all_day: f("all_day").checked, start_date: f("start_date").value, start_time: f("start_time").value,
        end_date: f("end_date").value || f("start_date").value, end_time: f("end_time").value,
        repeat: f("repeat").value, repeat_until: f("repeat_until").value || null, tz: TZ,
        project_id: f("project_id").value || null,
        reminders: [...box.querySelectorAll("#calRemEdit .is-on")].map((x) => Number(x.dataset.rem)),
        organizer_attends: people.some((p) => p.role === "invite") || !people.length || f("organizer_attends").checked
      };
      try {
        const r = await cal({ action: "save", event, people: people.map((p) => ({ staff_id: p.staff_id, role: p.role })) });
        toast(people.length && !ev ? "Saved. Everyone was notified." : "Saved.");
        closePopup();
        state.cursor = parseDay(event.start_date);
        await afterChange();
        if (!ev) history.replaceState(null, "", `${location.pathname}?event=${r.id}`);
      } catch (err) { save.disabled = false; msg($("#calFormMsg", box), err.message, "error"); }
    });
    setTimeout(() => f("title").focus(), 50);
  }

  async function afterChange() {
    await window.MyCalendar.load(true);
    await Promise.all([loadItems(), loadInvites()]);
  }

  /* ---------------- settings ---------------- */

  const feedUrl = (token) => `${(window.SUPABASE_CONFIG || {}).url}/functions/v1/staff-calendar?feed=${token}`;

  async function openSettings(focus) {
    const [{ data: providers }, status] = await Promise.all([
      sb().from("calendar_providers").select("id, label, auth_type").eq("is_active", true).eq("auth_type", "ics").order("sort_order"),
      cal({ action: "feed_status" }).catch(() => ({ on: false }))
    ]);
    const s = state.settings || {};
    const box = popup(`
      <h2>Calendar settings</h2>
      <div class="cal-sec" id="setLinked"><h3>Bring in your Google calendar</h3>
        <p class="cal-soft cal-small">Shows your Google (or Outlook / iCloud) events here, including past ones. Read-only — change them in Google.</p>
        <ul class="cal-linked">${state.accounts.map((a) => `<li><span><b>${esc(a.external_account_email || a.provider_label)}</b><small>${a.status === "error" ? "Needs attention" : a.last_synced_at ? `Synced ${esc(new Date(a.last_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}` : "Connected"}</small></span>
          <button type="button" class="cal-text-btn" data-sync="${esc(a.id)}">Sync now</button><button type="button" class="cal-text-btn cal-danger" data-unlink="${esc(a.id)}">Remove</button></li>`).join("") || '<li class="cal-soft">Nothing linked yet.</li>'}</ul>
        <form id="setLinkForm" class="cal-form">
          <div class="cal-row">
            <label>Calendar<select name="provider">${(providers || []).map((p) => `<option value="${esc(p.id)}" ${p.id === "google" ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
            <label class="cal-grow">Private link<input type="url" name="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" required></label>
          </div>
          <p class="cal-soft cal-small">Google: Google Calendar on a computer › ⚙ Settings › click your calendar › <b>Secret address in iCal format</b> › copy.</p>
          <div class="cal-actions"><button type="submit" class="auth-button">Link calendar</button></div>
        </form>
      </div>
      <div class="cal-sec" id="setShare"><h3>Show this calendar in Google or Apple</h3>
        <p class="cal-soft cal-small">Your portal events (yours, invites, assigned) show up in Google or Apple Calendar and keep updating. Google refreshes every few hours; Apple every 15–60 minutes.</p>
        <div id="setFeed"></div>
      </div>
      <form class="cal-sec cal-form" id="setDefaults"><h3>Defaults</h3>
        <div class="cal-row">
          <label>Work day starts<input type="time" name="work_start" value="${esc(String(s.work_start || "07:00").slice(0, 5))}"></label>
          <label>Ends<input type="time" name="work_end" value="${esc(String(s.work_end || "17:00").slice(0, 5))}"></label>
          <label>Week starts on<select name="week_start"><option value="0" ${!s.week_start ? "selected" : ""}>Sunday</option><option value="1" ${s.week_start === 1 ? "selected" : ""}>Monday</option></select></label>
        </div>
        <div><span class="cal-label">Reminders on new events</span><div class="cal-rem" id="setRem">${remPick(s.default_reminders || [15])}</div></div>
        <label class="cal-inline"><input type="checkbox" name="google_busy" ${s.google_busy !== false ? "checked" : ""}> Count my Google events as busy when someone invites me (they only see "Busy")</label>
        <p class="cal-msg" id="setMsg"></p>
        <div class="cal-actions"><button type="submit" class="auth-button">Save defaults</button></div>
      </form>`, "cal-pop--settings");

    // Linked calendars.
    box.querySelectorAll("[data-sync]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "Syncing…";
      try { await callFn("calendar", { action: "sync", account_id: b.dataset.sync }); toast("Synced."); await loadAccounts(); openSettings(); refresh(); }
      catch (err) { b.disabled = false; b.textContent = "Sync now"; toast(err.message, "error"); }
    }));
    box.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", async () => {
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Tap again to remove"; return; }
      b.disabled = true;
      try { await callFn("calendar", { action: "disconnect", account_id: b.dataset.unlink }); toast("Removed."); await loadAccounts(); openSettings(); refresh(); }
      catch (err) { b.disabled = false; toast(err.message, "error"); }
    }));
    $("#setLinkForm", box).addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget, btn = form.querySelector("button");
      btn.disabled = true; btn.textContent = "Checking the link…";
      try {
        const r = await callFn("calendar", { action: "ics_connect", provider: form.elements.provider.value, url: form.elements.url.value.trim() });
        if (r.status === "error") throw new Error(r.message || "Couldn't read that calendar.");
        toast(`Linked — ${r.count ?? r.found ?? 0} events brought in.`);
        await loadAccounts(); openSettings(); refresh();
      } catch (err) { btn.disabled = false; btn.textContent = "Link calendar"; toast(err.message, "error"); }
    });

    // Your private link.
    function drawFeed(st, token) {
      const box2 = $("#setFeed", box);
      if (token) {
        const url = feedUrl(token);
        const webcal = url.replace(/^https:/, "webcal:");
        box2.innerHTML = `
          <div class="cal-copy"><input readonly value="${esc(url)}" id="setFeedUrl"><button type="button" class="auth-button" id="setCopy">Copy</button></div>
          <div class="cal-actions cal-actions--left">
            <a class="auth-button auth-button--secondary" href="${esc(webcal)}">Add to Apple Calendar</a>
            <a class="auth-button auth-button--secondary" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}">Add to Google Calendar</a>
          </div>
          <p class="cal-soft cal-small">Copy it now — for your privacy it's only shown once. Anyone with this link can see your portal events. Google on a computer: Other calendars › + › From URL › paste.</p>`;
        $("#setCopy", box2).addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch (_) { $("#setFeedUrl", box2).select(); document.execCommand("copy"); toast("Link copied."); }
        });
        return;
      }
      box2.innerHTML = st.on ? `
          <p class="cal-small">Your link is on${st.last_used_at ? ` · last checked by ${esc(/google/i.test(st.last_used_by || "") ? "Google" : /apple|ical|darwin|ios|mac/i.test(st.last_used_by || "") ? "Apple" : "a calendar")} ${esc(new Date(st.last_used_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}` : " · not used yet"}.</p>
          <div class="cal-actions cal-actions--left">
            <button type="button" class="auth-button auth-button--secondary" id="setNewLink">Make a new link</button>
            <button type="button" class="cal-text-btn cal-danger" id="setOff">Turn off</button>
          </div>
          <p class="cal-soft cal-small">A new link stops the old one — you'd add the new one to Google / Apple again.</p>`
        : `<div class="cal-actions cal-actions--left"><button type="button" class="auth-button" id="setNewLink">Make my calendar link</button></div>`;
      $("#setNewLink", box2)?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await cal({ action: "feed_token" }); drawFeed({ on: true }, r.token); }
        catch (err) { e.currentTarget.disabled = false; toast(err.message, "error"); }
      });
      $("#setOff", box2)?.addEventListener("click", async (e) => {
        const b = e.currentTarget;
        if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Tap again — Google / Apple stop updating"; return; }
        try { await cal({ action: "feed_off" }); toast("Calendar link turned off."); drawFeed({ on: false }); }
        catch (err) { toast(err.message, "error"); }
      });
    }
    drawFeed(status);

    // Defaults.
    box.querySelectorAll("#setRem [data-rem]").forEach((b) => b.addEventListener("click", () => b.classList.toggle("is-on")));
    $("#setDefaults", box).addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const row = {
        staff_id: state.me,
        work_start: form.elements.work_start.value || "07:00", work_end: form.elements.work_end.value || "17:00",
        week_start: Number(form.elements.week_start.value), google_busy: form.elements.google_busy.checked,
        default_reminders: [...box.querySelectorAll("#setRem .is-on")].map((x) => Number(x.dataset.rem)),
        updated_at: new Date().toISOString()
      };
      if (row.work_end <= row.work_start) { msg($("#setMsg", box), "The work day has to end after it starts.", "error"); return; }
      const { data, error } = await sb().from("calendar_settings").upsert(row, { onConflict: "staff_id" }).select().single();
      if (error) { msg($("#setMsg", box), "Couldn't save. Has the calendar SQL been run?", "error"); return; }
      state.settings = data;
      msg($("#setMsg", box), "Saved.", "ok");
      refresh();
    });

    if (focus) $(focus === "share" ? "#setShare" : focus === "defaults" ? "#setDefaults" : "#setLinked", box)?.scrollIntoView({ block: "start" });
  }

  /* ---------------- help ("?") ---------------- */

  async function openHelp() {
    const status = await cal({ action: "feed_status" }).catch(() => ({ on: false }));
    const pushOn = "Notification" in window && Notification.permission === "granted";
    const steps = [
      { done: pushOn, title: "Turn on phone notifications", text: "Invites and reminders go to your phone. On iPhone, add the portal to your Home Screen first (Share › Add to Home Screen), open it from there, then turn notifications on.", btn: "Open notification settings", go: () => { location.href = "/pages/notifications.html"; } },
      { done: state.accounts.length > 0, title: "Bring in your Google calendar", text: "Paste your Google calendar's secret iCal link. Everything — past and future — shows here. It's read-only in the portal.", btn: "Link Google", go: () => openSettings("linked") },
      { done: !!status.on, title: "Show the portal calendar in Google or Apple", text: "Make your private link and add it to Google or Apple Calendar. Portal events then show up on your phone's calendar and keep updating.", btn: "Make my link", go: () => openSettings("share") },
      { done: !!state.settings, title: "Set your working hours", text: "Used when finding a time that works for everyone.", btn: "Set hours", go: () => openSettings("defaults") },
      { done: false, title: "Invite or assign people", text: "Create an event and add people. Invite asks them to accept or decline (they can say they have a conflict). Assign just puts it on their calendar.", btn: "Create an event", go: () => openEditor(null) }
    ];
    const box = popup(`
      <h2>Setting up your calendar</h2>
      <p class="cal-soft">${steps.filter((s) => s.done).length} of ${steps.length - 1} done</p>
      <ol class="cal-help">${steps.map((s, n) => `
        <li class="${s.done ? "is-done" : ""}"><span class="cal-help-n">${s.done ? "✓" : n + 1}</span>
          <div><b>${esc(s.title)}</b><p>${esc(s.text)}</p>${s.done ? "" : `<button type="button" class="cal-text-btn" data-step="${n}">${esc(s.btn)} ›</button>`}</div></li>`).join("")}</ol>
      <div class="cal-sec"><h3>Good to know</h3>
        <ul class="cal-help-notes">
          <li>Google events can't be changed here — change them in Google and they update here.</li>
          <li>Portal events show in Google within a few hours, in Apple within about an hour.</li>
          <li>Dashed events are invites you haven't answered yet.</li>
          <li>COI expirations (red) show every vendor's certificate of insurance end date.</li>
        </ul></div>`, "cal-pop--help");
    box.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => steps[Number(b.dataset.step)].go()));
  }

  /* ---------------- start ---------------- */

  async function loadAccounts() {
    const { data } = await sb().from("calendar_connections_status").select("*").order("created_at");
    state.accounts = data || [];
    renderCalendars();
  }

  function openPanel() { document.body.classList.add("cal-panel-open"); }
  function closePanel() { document.body.classList.remove("cal-panel-open"); }

  async function start() {
    for (let i = 0; i < 100 && !sb(); i++) await new Promise((r) => setTimeout(r, 100));
    try { await window.supabaseInitialProfilePromise; } catch (_) { /* fall through */ }
    const profile = window.currentSupabaseProfile || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    state.me = profile?.id || null;
    if (!sb() || !state.me) { $("#calBody").innerHTML = '<p class="cal-empty">Please sign in again.</p>'; return; }

    let saved = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch (_) { saved = null; }
    state.view = ["day", "week", "month", "agenda"].includes(saved) ? saved : (isPhone() ? "agenda" : "week");

    const [settings, staff] = await Promise.all([
      sb().from("calendar_settings").select("*").eq("staff_id", state.me).maybeSingle(),
      sb().from("staff_users").select("id, full_name, username, workgroup, active").order("full_name")
    ]);
    state.settings = settings.data || null;
    state.staff = (staff.data || []).filter((s) => s.active !== false);

    const params = new URLSearchParams(location.search);
    if (params.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(params.get("date"))) state.cursor = parseDay(params.get("date"));

    // Toolbar.
    $("#calToday").addEventListener("click", () => { state.cursor = new Date(); refresh(); });
    $("#calPrev").addEventListener("click", () => step(-1));
    $("#calNext").addEventListener("click", () => step(1));
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    document.querySelectorAll("[data-create]").forEach((b) => b.addEventListener("click", () => { if (isPhone()) closePanel(); openEditor(null); }));
    $("#calSettingsBtn").addEventListener("click", () => openSettings());
    $("#calHelpBtn").addEventListener("click", openHelp);
    $("#calPanelBtn").addEventListener("click", openPanel);
    $("#calPanelScrim").addEventListener("click", closePanel);
    document.addEventListener("click", (e) => { const b = e.target.closest('[data-open="settings-linked"]'); if (b) openSettings("linked"); });
    $("#calBody").addEventListener("dblclick", (e) => { const c = e.target.closest(".cal-mcell"); if (c && !e.target.closest("[data-item]")) openEditor(null, { date: c.dataset.newday }); });
    // Keyboard: t = today, j/k or arrows = move, n = new.
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, select, [contenteditable]") || document.querySelector(".cal-pop-overlay") || e.metaKey || e.ctrlKey) return;
      if (e.key === "t") { state.cursor = new Date(); refresh(); }
      else if (e.key === "ArrowLeft" || e.key === "k") step(-1);
      else if (e.key === "ArrowRight" || e.key === "j") step(1);
      else if (e.key === "n" || e.key === "c") { e.preventDefault(); openEditor(null); }
      else if (e.key === "d") setView("day"); else if (e.key === "w") setView("week"); else if (e.key === "m") setView("month"); else if (e.key === "a") setView("agenda");
    });

    await loadAccounts();
    refresh();
    loadInvites().catch(() => {});

    // Deep links: ?event=<id> (notifications, reminders) and ?new=1.
    const id = params.get("event");
    if (id && /^[0-9a-f-]{36}$/i.test(id)) {
      const { ev } = await fetchEvent(id);
      if (ev) { state.cursor = parseDay(ev.start_date); refresh(); }
      openEvent(id);
    } else if (params.get("new")) {
      openEditor(null, { date: params.get("date") || iso(state.cursor) });
      history.replaceState(null, "", location.pathname);
    }
    // Calendar first time: show the setup guide once.
    try {
      if (!localStorage.getItem("staffCalendar.helped") && !id && !params.get("new")) { localStorage.setItem("staffCalendar.helped", "1"); openHelp(); }
    } catch (_) { /* fine */ }
    // Back to the page after a while: catch new invites / changes.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") afterChange().catch(() => {}); });
  }

  document.addEventListener("DOMContentLoaded", () => { start().catch((err) => { console.error("calendar:", err); toast("Couldn't open the calendar.", "error"); }); });
})();
