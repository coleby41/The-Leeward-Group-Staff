/* ============================================================================
   home-today.js — "Today" on the Home page: Rows / Calendar switch (2026-11-18)

   Rows     → the existing list from dashboard/calendar-card.js (unchanged).
   Calendar → a day timeline:
     - "Due today" strip: your open tasks + assigned project to-dos due today,
       and timeline tasks/milestones due today on active projects.
     - Hour grid with synced calendar events (calendar_events_cache) placed
       at their times, side by side when they overlap, and a red "now" line.
   The choice is remembered per person in this browser.
============================================================================ */
(function () {
  "use strict";
  const DS = window.DashboardShared;
  const HOUR_PX = 48;
  const DEFAULT_START = 7, DEFAULT_END = 19;   // 7 AM – 7 PM unless events go outside it
  let staffId = null;
  let loaded = false;

  const pad = (n) => String(n).padStart(2, "0");
  function localISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function hourLabel(h) { const x = h % 24; return x === 0 ? "12 AM" : x === 12 ? "Noon" : x < 12 ? `${x} AM` : `${x - 12} PM`; }
  function timeText(d) { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }

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
      if (isCal && !loaded) { loaded = true; load(); }
    }
    buttons.forEach(b => b.addEventListener("click", () => setView(b.dataset.view, true)));

    const profile = await DS.getStaffProfile();
    staffId = DS.getUserId(profile);
    let saved = null;
    try { saved = localStorage.getItem(prefKey()); } catch (_) { saved = null; }
    setView(saved === "calendar" ? "calendar" : "rows", false);
  });

  async function load() {
    const cal = document.getElementById("todayCalendar");
    if (!staffId) { cal.innerHTML = '<p class="card-subtitle">Sign in to see your day.</p>'; return; }
    cal.innerHTML = '<p class="card-subtitle">Loading your day…</p>';
    const sb = window.supabaseClient;
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const today = localISO(now);

    const [events, tasks, todos, projects] = await Promise.all([
      DS.safeQuery("today events", sb.from("calendar_events_cache").select("id, title, start_time, end_time, location")
        .eq("user_id", staffId).lt("start_time", dayEnd.toISOString()).gt("end_time", dayStart.toISOString()).order("start_time")),
      DS.safeQuery("today tasks", sb.from("tasks").select("id, task_name").eq("user_id", staffId).eq("completed", false).eq("due_date", today)),
      DS.safeQuery("today to-dos", sb.from("project_todo_subitems").select("id, label, project_id, projects(name)").eq("assigned_to", staffId).eq("completed", false).eq("due_date", today)),
      DS.safeQuery("today projects", sb.from("projects").select("id, name").eq("status", "active"))
    ]);
    const active = projects.data || [];
    let milestones = [];
    if (active.length) {
      const { data } = await DS.safeQuery("today timeline", sb.from("schedule_tasks").select("id, name, item_type, project_id")
        .in("project_id", active.map(p => p.id)).neq("status", "complete").eq("end_date", today));
      const names = new Map(active.map(p => [p.id, p.name]));
      milestones = (data || []).map(t => ({ ...t, projectName: names.get(t.project_id) || "" }));
    }

    render({
      events: events.data || [],
      due: [
        ...(tasks.data || []).map(t => ({ title: t.task_name, tag: "Personal", href: "/pages/staff-todo.html" })),
        ...(todos.data || []).map(t => ({ title: t.label, tag: (t.projects && t.projects.name) || "Project", href: `/pages/project-todo.html?id=${encodeURIComponent(t.project_id)}` })),
        ...milestones.map(t => ({ title: t.name, tag: t.projectName, href: `/pages/project-timeline.html?id=${encodeURIComponent(t.project_id)}`, milestone: t.item_type === "milestone" }))
      ],
      dayStart, now
    });
  }

  function render({ events, due, dayStart, now }) {
    const cal = document.getElementById("todayCalendar");
    const esc = DS.escapeHtml;

    // Hours shown: 7 AM – 7 PM, stretched to fit any event outside that.
    let startH = DEFAULT_START, endH = DEFAULT_END;
    const timed = events.map(e => {
      const s = new Date(e.start_time), en = new Date(e.end_time || e.start_time);
      const sH = Math.max(0, (s - dayStart) / 3600000), eH = Math.min(24, (en - dayStart) / 3600000);
      return { ...e, s, en, sH, eH: Math.max(eH, sH + 0.5) };
    }).filter(e => e.eH > 0 && e.sH < 24);
    const allDay = timed.filter(e => e.sH <= 0 && e.eH >= 24);
    const blocks = timed.filter(e => !(e.sH <= 0 && e.eH >= 24));
    blocks.forEach(e => { startH = Math.min(startH, Math.floor(e.sH)); endH = Math.max(endH, Math.ceil(e.eH)); });

    // Side-by-side columns for overlapping events.
    const cols = [];
    blocks.forEach(e => {
      let c = cols.findIndex(endAt => endAt <= e.sH);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = e.eH; e.col = c;
    });
    blocks.forEach(e => {
      const overlapping = blocks.filter(o => o.sH < e.eH && o.eH > e.sH);
      e.cols = Math.max(...overlapping.map(o => o.col)) + 1;
    });

    const dueItems = [
      ...allDay.map(e => `<span class="hm-due-chip hm-due-chip--event"><strong>${esc(e.title || "Event")}</strong><small>All day</small></span>`),
      ...due.map(d => `<a class="hm-due-chip${d.milestone ? " hm-due-chip--milestone" : ""}" href="${d.href}"><strong>${esc(d.title)}</strong><small>${esc(d.tag)}</small></a>`)
    ];

    const hours = [];
    for (let h = startH; h < endH; h++) hours.push(`<div class="hm-daycal-hour"><span>${hourLabel(h)}</span></div>`);

    const evHtml = blocks.map(e => {
      const top = (e.sH - startH) * HOUR_PX, height = Math.max(24, (e.eH - e.sH) * HOUR_PX - 2);
      const w = 100 / e.cols, left = e.col * w;
      const short = height < 40;
      return `<div class="hm-daycal-event${e.en < now ? " is-past" : ""}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${w}% - 4px)" title="${esc(e.title || "Event")}">
          <strong>${esc(e.title || "Event")}</strong>${short ? "" : `<small>${timeText(e.s)} – ${timeText(e.en)}${e.location ? " · " + esc(e.location) : ""}</small>`}
        </div>`;
    }).join("");

    const nowH = (now - dayStart) / 3600000;
    const nowLine = nowH >= startH && nowH <= endH
      ? `<div class="hm-daycal-now" style="top:${(nowH - startH) * HOUR_PX}px"><span>${timeText(now)}</span></div>` : "";

    cal.innerHTML = `
      <div class="hm-daycal-due">
        <p class="hm-daycal-label">Due today</p>
        <div class="hm-due-chips-row">${dueItems.length ? dueItems.join("") : '<span class="hm-daycal-none">Nothing due today</span>'}</div>
      </div>
      <div class="hm-daycal-scroll" tabindex="0" aria-label="Today's schedule">
        <div class="hm-daycal-grid" style="height:${(endH - startH) * HOUR_PX}px">
          ${hours.join("")}
          <div class="hm-daycal-events">${evHtml}${nowLine}</div>
          ${blocks.length ? "" : '<p class="hm-daycal-empty">No calendar events today</p>'}
        </div>
      </div>`;

    // Start scrolled to an hour before now (or the first event).
    const scroller = cal.querySelector(".hm-daycal-scroll");
    const target = blocks.length && !(nowH >= startH && nowH <= endH) ? blocks[0].sH : nowH;
    scroller.scrollTop = Math.max(0, (target - startH - 1) * HOUR_PX);

    // Keep the "now" line moving.
    clearInterval(render._t);
    render._t = setInterval(() => {
      const line = cal.querySelector(".hm-daycal-now");
      if (!line) return;
      const n = new Date(), h = (n - dayStart) / 3600000;
      line.style.top = `${(h - startH) * HOUR_PX}px`;
      line.querySelector("span").textContent = timeText(n);
    }, 60000);
  }
})();
