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
