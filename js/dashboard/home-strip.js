/* ============================================================================
   home-strip.js — the liquid-glass "today" bar on the Home page
   (pages/dashboard.html, redesigned 2026-11-18).

   Fills: date line, My tasks (open + due today), Approvals (incident
   reports waiting on me), Timesheet (this pay period's status).
   Weather lives in weather.js; Active projects in projects.js.
   Also wires "+ New task" to the add-a-task line.
============================================================================ */
(function () {
  "use strict";
  const DS = window.DashboardShared;

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function shortDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function setText(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = `hm-stat-sub ${cls}`;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const dateEl = document.getElementById("homeDate");
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

    const btn = document.getElementById("homeNewTaskBtn");
    const input = document.getElementById("newTaskInlineInput");
    if (btn && input) btn.addEventListener("click", () => { input.scrollIntoView({ behavior: "smooth", block: "center" }); input.focus(); });

    if (!DS || !window.supabaseClient) return;
    const profile = await DS.getStaffProfile();
    const staffId = DS.getUserId(profile);
    if (!staffId) return;
    const sb = window.supabaseClient;
    const today = todayISO();

    // Active projects + upcoming deadlines (2026-11-18). Replaces
    // dashboard/projects.js on this page, which read a project_deadlines
    // table that was never created (404). Deadlines now come from the
    // project timelines: open tasks and milestones, late or due in the next
    // 30 days, on active projects.
    (async () => {
      const { data: projects } = await DS.safeQuery("home active projects",
        sb.from("projects").select("id, name").eq("status", "active"));
      const list = projects || [];
      const countEl = document.getElementById("activeProjectsCount");
      if (countEl) countEl.textContent = String(list.length);

      const wrap = document.getElementById("upcomingDeadlinesList");
      if (!wrap) return;
      if (!list.length) { wrap.innerHTML = '<p class="card-subtitle">No active projects.</p>'; return; }
      const names = new Map(list.map(p => [p.id, p.name]));
      const until = new Date(); until.setDate(until.getDate() + 30);
      const untilISO = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")}`;
      const { data: tasks, error } = await DS.safeQuery("home deadlines",
        sb.from("schedule_tasks").select("id, name, item_type, end_date, status, project_id")
          .in("project_id", list.map(p => p.id)).neq("status", "complete")
          .lte("end_date", untilISO).order("end_date", { ascending: true }).limit(40));
      if (error) { wrap.innerHTML = '<p class="card-subtitle">Couldn\'t load upcoming deadlines.</p>'; return; }
      // Late ones first (most recent), then upcoming; milestones before plain tasks on the same day.
      const rows = (tasks || [])
        .sort((a, b) => (a.end_date < today) - (b.end_date < today) || a.end_date.localeCompare(b.end_date) || (a.item_type === "milestone" ? -1 : 1))
        .slice(0, 6);
      if (!rows.length) { wrap.innerHTML = '<p class="card-subtitle">Nothing due in the next 30 days.</p>'; return; }
      const esc = DS.escapeHtml;
      wrap.innerHTML = rows.map(t => {
        const d = new Date(`${t.end_date}T00:00:00`);
        const late = t.end_date < today;
        const daysLate = late ? Math.round((new Date(`${today}T00:00:00`) - d) / 86400000) : 0;
        const tagHtml = late
          ? `<span class="hm-tag hm-tag--red">${daysLate} day${daysLate === 1 ? "" : "s"} late</span>`
          : t.status === "in_progress" ? '<span class="hm-tag hm-tag--blue">In progress</span>'
          : t.item_type === "milestone" ? '<span class="hm-tag">Milestone</span>' : "";
        return `<a class="info-item hm-deadline" href="/pages/project-timeline.html?id=${encodeURIComponent(t.project_id)}">
            <span class="hm-date-chip"><small>${d.toLocaleDateString("en-US", { month: "short" })}</small>${d.getDate()}</span>
            <div><h3>${esc(t.name)}</h3><p>${esc(names.get(t.project_id) || "")}</p></div>
            ${tagHtml}
          </a>`;
      }).join("");
    })();

    // My tasks
    DS.safeQuery("home task count", sb.from("tasks").select("id, due_date").eq("user_id", staffId).eq("completed", false))
      .then(({ data }) => {
        const rows = data || [];
        const dueToday = rows.filter(t => t.due_date && t.due_date <= today).length;
        setText("homeTaskCount", String(rows.length));
        setText("homeTaskSub", dueToday ? `${dueToday} due today or late` : "Nothing due today", dueToday ? "hm-warn" : "");
      });

    // Approvals waiting on me
    DS.safeQuery("home approvals", sb.from("incident_reports").select("id").eq("assigned_approver_id", staffId).eq("status", "pending_approval"))
      .then(({ data }) => {
        const n = (data || []).length;
        setText("homeApprovalCount", String(n));
        setText("homeApprovalSub", n ? `Incident report${n === 1 ? "" : "s"} to review` : "Nothing waiting", n ? "hm-warn" : "");
      });

    // Timesheet — this pay period
    (async () => {
      const [{ data: emp }, { data: periods }] = await Promise.all([
        DS.safeQuery("home payroll employee", sb.from("payroll_employees").select("id").eq("staff_id", staffId).limit(1)),
        DS.safeQuery("home pay period", sb.from("pay_periods").select("id, end_date").lte("start_date", today).gte("end_date", today).order("start_date", { ascending: false }).limit(1))
      ]);
      const period = periods && periods[0];
      if (!emp || !emp.length || !period) {
        setText("homeTimesheetStatus", "—");
        setText("homeTimesheetSub", emp && emp.length ? "No open pay period" : "Open timesheet", "");
        return;
      }
      const { data: ts } = await DS.safeQuery("home timesheet", sb.from("timesheets").select("status").eq("payroll_employee_id", emp[0].id).eq("pay_period_id", period.id).limit(1));
      const status = (ts && ts[0] && ts[0].status) || "Not Started";
      const label = { "Not Started": "Not started", "In Progress": "Draft", "Needs Corrections": "Fix needed" }[status] || status;
      setText("homeTimesheetStatus", label);
      const open = ["Not Started", "In Progress", "Needs Corrections"].includes(status);
      setText("homeTimesheetSub", open ? `Due ${shortDate(period.end_date)}` : "Sent", status === "Needs Corrections" ? "hm-bad" : "");
    })();
  });
})();
