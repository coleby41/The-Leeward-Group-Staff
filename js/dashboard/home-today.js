/* ============================================================================
   home-today.js — "Today" on the Home page: Rows / Calendar switch (2026-11-18)

   Rows     → the existing list from dashboard/calendar-card.js (unchanged).
   Calendar → a month view:
     - each day shows up to 3 dots: blue = your tasks / project to-dos,
       purple = project deadlines & milestones (active projects' timelines),
       gray = synced calendar events (calendar_events_cache)
     - tap a day to list what's on it underneath (today is picked to start)
     - ‹ › move between months; "Today" jumps back
   The Rows / Calendar choice is remembered per person in this browser.
============================================================================ */
(function () {
  "use strict";
  const DS = window.DashboardShared;
  const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
  let staffId = null;
  let shown = null;        // first day of the month on screen
  let selected = null;     // "YYYY-MM-DD"
  let items = new Map();   // "YYYY-MM-DD" → [{kind, title, sub, href, time}]
  let calendars = [];      // linked calendars [{id, name, color}], for colors and the key
  let started = false;

  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => iso(new Date());

  function prefKey() {
    let p = window.currentSupabaseProfile;
    if (!p) { try { p = JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (_) { p = null; } }
    return `homeTodayView:${(p && (p.id || p.auth_user_id || p.email)) || "anon"}`;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const cal = document.getElementById("todayCalendar");
    const list = document.getElementById("calendarEventsList");
    const buttons = Array.from(document.querySelectorAll(".hm-view-toggle [data-view]"));
    if (!cal || !list || !buttons.length || !DS) return;

    function setView(view, remember) {
      const isCal = view === "calendar";
      cal.hidden = !isCal;
      list.hidden = isCal;
      buttons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
      if (remember) { try { localStorage.setItem(prefKey(), view); } catch (_) { /* private mode */ } }
      if (isCal && !started) { started = true; const n = new Date(); selected = todayISO(); goTo(new Date(n.getFullYear(), n.getMonth(), 1)); }
    }
    buttons.forEach(b => b.addEventListener("click", () => setView(b.dataset.view, true)));

    cal.addEventListener("click", (e) => {
      const day = e.target.closest("[data-day]");
      if (day) { selected = day.dataset.day; render(); return; }
      const nav = e.target.closest("[data-nav]");
      if (!nav) return;
      if (nav.dataset.nav === "today") { const n = new Date(); selected = todayISO(); goTo(new Date(n.getFullYear(), n.getMonth(), 1)); }
      else goTo(new Date(shown.getFullYear(), shown.getMonth() + (nav.dataset.nav === "next" ? 1 : -1), 1));
    });
    cal.addEventListener("keydown", (e) => {
      const day = e.target.closest("[data-day]");
      if (!day) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!step) return;
      e.preventDefault();
      const d = new Date(`${day.dataset.day}T00:00:00`); d.setDate(d.getDate() + step);
      selected = iso(d);
      if (d.getMonth() !== shown.getMonth()) goTo(new Date(d.getFullYear(), d.getMonth(), 1), true);
      else { render(); cal.querySelector(`[data-day="${selected}"]`)?.focus(); }
    });

    // New events after a sync / connect / disconnect (home-calendar.js).
    window.addEventListener("calendar:synced", () => { if (started && shown) goTo(shown); });

    const profile = await DS.getStaffProfile();
    staffId = DS.getUserId(profile);
    let saved = null;
    try { saved = localStorage.getItem(prefKey()); } catch (_) { saved = null; }
    setView(saved === "calendar" ? "calendar" : "rows", false);
  });

  async function goTo(firstOfMonth, keepFocus) {
    shown = firstOfMonth;
    const sel = new Date(`${selected}T00:00:00`);
    if (sel.getMonth() !== shown.getMonth() || sel.getFullYear() !== shown.getFullYear()) {
      const isThisMonth = shown.getMonth() === new Date().getMonth() && shown.getFullYear() === new Date().getFullYear();
      selected = isThisMonth ? todayISO() : iso(shown);
    }
    items = new Map();
    render(true);
    await load();
    render();
    if (keepFocus) document.querySelector(`#todayCalendar [data-day="${selected}"]`)?.focus();
  }

  function add(day, item) {
    if (!day) return;
    if (!items.has(day)) items.set(day, []);
    items.get(day).push(item);
  }

  async function load() {
    if (!staffId) return;
    const sb = window.supabaseClient;
    const from = iso(shown);
    const end = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
    const to = iso(new Date(end.getFullYear(), end.getMonth(), 0));
    const monthKey = from;

    const [events, tasks, todos, projects, conn] = await Promise.all([
      DS.safeQuery("month events", sb.from("calendar_events_cache").select("id, title, start_time, end_time, location, account_id")
        .eq("user_id", staffId).gte("start_time", new Date(shown).toISOString()).lt("start_time", end.toISOString()).order("start_time")),
      DS.safeQuery("month tasks", sb.from("tasks").select("id, task_name, due_date").eq("user_id", staffId).eq("completed", false).gte("due_date", from).lte("due_date", to)),
      DS.safeQuery("month to-dos", sb.from("project_todo_subitems").select("id, label, due_date, project_id, projects(name)").eq("assigned_to", staffId).eq("completed", false).gte("due_date", from).lte("due_date", to)),
      DS.safeQuery("month projects", sb.from("projects").select("id, name").eq("status", "active")),
      DS.safeQuery("month calendar", sb.from("calendar_connections_status").select("id, provider_label, external_account_email").order("created_at"))
    ]);
    const colorOf = window.HomeCalendarColor || (() => "#12a08a");
    calendars = (conn.data || []).map((c, i) => ({ id: c.id, name: c.external_account_email || c.provider_label || "Calendar", color: colorOf(i) }));
    const calById = new Map(calendars.map(c => [c.id, c]));
    if (iso(shown) !== monthKey) return; // moved on while loading

    (tasks.data || []).forEach(t => add(t.due_date, { kind: "task", title: t.task_name, sub: "Personal", href: "/pages/staff-todo.html" }));
    (todos.data || []).forEach(t => add(t.due_date, { kind: "task", title: t.label, sub: (t.projects && t.projects.name) || "Project", href: `/pages/project-todo.html?id=${encodeURIComponent(t.project_id)}` }));
    (events.data || []).forEach(e => {
      const s = new Date(e.start_time);
      const cal = calById.get(e.account_id);
      add(iso(s), { kind: "event", title: e.title || "Event", sub: [calendars.length > 1 && cal ? cal.name : "", e.location || ""].filter(Boolean).join(" · "),
        color: cal ? cal.color : "", cal: cal ? cal.id : "", time: s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), sort: s.getTime() });
    });
    const active = projects.data || [];
    if (active.length) {
      const names = new Map(active.map(p => [p.id, p.name]));
      const { data } = await DS.safeQuery("month timeline", sb.from("schedule_tasks").select("id, name, item_type, end_date, project_id")
        .in("project_id", active.map(p => p.id)).neq("status", "complete").gte("end_date", from).lte("end_date", to));
      (data || []).forEach(t => add(t.end_date, {
        kind: "deadline", title: t.name, sub: `${names.get(t.project_id) || ""}${t.item_type === "milestone" ? " · Milestone" : ""}`,
        href: `/pages/project-timeline.html?id=${encodeURIComponent(t.project_id)}`
      }));
    }
  }

  function render(loading) {
    const cal = document.getElementById("todayCalendar");
    const esc = DS.escapeHtml;
    const today = todayISO();
    const first = shown;
    const lead = first.getDay();
    const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="hm-mc-cell is-blank" aria-hidden="true"></span>');
    for (let d = 1; d <= daysIn; d++) {
      const key = iso(new Date(first.getFullYear(), first.getMonth(), d));
      const list = items.get(key) || [];
      const kinds = ["task", "deadline"].filter(k => list.some(x => x.kind === k));
      // One dot per calendar that has something that day, in that calendar's color.
      const calDots = [...new Map(list.filter(x => x.kind === "event").map(x => [x.cal || "_", x.color])).values()];
      const cls = ["hm-mc-cell", key === today ? "is-today" : "", key === selected ? "is-selected" : "", key < today ? "is-past" : ""].filter(Boolean).join(" ");
      const label = new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) +
        (list.length ? `, ${list.length} item${list.length === 1 ? "" : "s"}` : "");
      cells.push(`<button type="button" class="${cls}" data-day="${key}" aria-label="${label}" aria-pressed="${key === selected}" tabindex="${key === selected ? 0 : -1}">
          <span class="hm-mc-num">${d}</span>
          <span class="hm-mc-dots">${kinds.map(k => `<i class="hm-mc-dot hm-mc-dot--${k}"></i>`).join("")}${calDots.map(c => `<i class="hm-mc-dot hm-mc-dot--event"${c ? ` style="background:${c}"` : ""}></i>`).join("")}</span>
        </button>`);
    }

    const dayItems = (items.get(selected) || []).slice().sort((a, b) => (a.kind === "event" ? 0 : 1) - (b.kind === "event" ? 0 : 1) || (a.sort || 0) - (b.sort || 0));
    const selDate = new Date(`${selected}T00:00:00`);
    const selTitle = selected === today ? "Today" : selDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const agenda = loading ? '<p class="hm-mc-none">Loading…</p>'
      : dayItems.length ? dayItems.map(x => {
          const lead = x.kind === "event" ? `<span class="hm-mc-time"${x.color ? ` style="border-left:3px solid ${x.color};padding-left:6px"` : ""}>${esc(x.time)}</span>` : `<i class="hm-mc-dot hm-mc-dot--${x.kind}"></i>`;
          const inner = `${lead}<span class="hm-mc-item-text"><strong>${esc(x.title)}</strong>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</span>`;
          return x.href ? `<a class="hm-mc-item" href="${x.href}">${inner}</a>` : `<div class="hm-mc-item">${inner}</div>`;
        }).join("")
      : '<p class="hm-mc-none">Nothing on this day.</p>';

    const isThisMonth = first.getMonth() === new Date().getMonth() && first.getFullYear() === new Date().getFullYear();
    cal.innerHTML = `
      <div class="hm-mc-head">
        <button type="button" class="hm-mc-nav" data-nav="prev" aria-label="Previous month">‹</button>
        <p class="hm-mc-title" aria-live="polite">${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
        <button type="button" class="hm-mc-nav" data-nav="next" aria-label="Next month">›</button>
        ${isThisMonth && selected === today ? "" : '<button type="button" class="hm-mc-today" data-nav="today">Today</button>'}
      </div>
      <div class="hm-mc-week" aria-hidden="true">${WEEKDAYS.map(w => `<span>${w}</span>`).join("")}</div>
      <div class="hm-mc-grid" role="group" aria-label="Days">${cells.join("")}</div>
      <div class="hm-mc-legend" aria-hidden="true"><span><i class="hm-mc-dot hm-mc-dot--task"></i>Tasks</span><span><i class="hm-mc-dot hm-mc-dot--deadline"></i>Project deadlines</span>${calendars.map(c => `<span><i class="hm-mc-dot hm-mc-dot--event" style="background:${c.color}"></i>${esc(c.name)}</span>`).join("")}</div>
      <div class="hm-mc-agenda">
        <p class="hm-mc-agenda-title">${esc(selTitle)}</p>
        ${agenda}
      </div>`;
  }
})();
