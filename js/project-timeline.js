/* ============================================================================
   PROJECT SCHEDULE / GANTT SYSTEM — ground-up rebuild (2026-08-24)

   Full replacement of the old single-table, drag-only timeline. Backed by
   the normalized schedule_phases / schedule_tasks / schedule_dependencies
   tables (see SQL FILES/supabase-schedule-system-schema.sql for the schema
   and the design rationale — milestones are schedule_tasks rows with
   item_type='milestone', not a separate table; is_critical is a manual
   flag, the actual critical PATH is computed here client-side from the
   dependency graph and never stored).

   ARCHITECTURE
   ------------
   - Everything Supabase-backed loads once into flat arrays (phases, tasks,
     dependencies) plus Map lookups by id. All rendering derives from those
     arrays — there is no other source of truth in the DOM.
   - Every mutation (drag, resize, edit, create, delete, reorder, dependency
     add/remove) goes through one of the optimistic*() helpers below:
       1. mutate the local array/object immediately and re-render
       2. write to Supabase
       3. on success: nothing further to do, the UI already reflects it
       4. on failure: revert the local mutation, re-render, show an error
     This is the ONLY path any part of this file is allowed to change task/
     phase/dependency data through — see optimisticUpdateTask() etc.
   - Critical Path Method (CPM) is computed fresh on every render from the
     currently loaded tasks + dependencies (computeCPM()) — a pure function,
     nothing about it is persisted, so it can never silently drift from the
     real graph after an edit.
   - Frappe Gantt (https://github.com/frappe/gantt, MIT) is still the
     charting engine — its date-grid rendering and drag/resize interaction
     are solid and were already debugged in this app; what changed is
     everything around it (data model, task list, dependencies, CPM,
     filtering, phase grouping). `move_dependencies` is explicitly disabled
     (see GANTT OPTIONS below) — Frappe's own auto-shift-dependents-on-drag
     logic only understands simple finish-to-start and would silently
     disagree with this app's 4-type + lag dependency model, which is
     exactly the kind of UI/DB mismatch the spec calls out as unacceptable.
   ============================================================================ */

(function () {
    "use strict";

    /* ============================================================
       CONSTANTS
       ============================================================ */

    const PHASES_TABLE = "schedule_phases";
    const TASKS_TABLE = "schedule_tasks";
    const DEPS_TABLE = "schedule_dependencies";
    const STAFF_TABLE = "staff_users_directory";
    const COMPANIES_TABLE = "Companies";

    const PHASE_TYPES = ["pre_construction", "buy_out", "construction", "close_out"];
    const PHASE_TYPE_LABELS = {
        pre_construction: "Pre-Construction",
        buy_out: "Buy Out",
        construction: "Construction",
        close_out: "Close-Out"
    };
    const STATUSES = ["not_started", "in_progress", "at_risk", "delayed", "complete", "on_hold"];
    const STATUS_LABELS = {
        not_started: "Not started", in_progress: "In progress", at_risk: "At risk",
        delayed: "Delayed", complete: "Complete", on_hold: "On hold"
    };
    const PRIORITIES = ["low", "medium", "high", "urgent"];
    const PRIORITY_LABELS = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
    const DEP_TYPES = ["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"];
    const DEP_TYPE_LABELS = {
        finish_to_start: "Finish-to-Start", start_to_start: "Start-to-Start",
        finish_to_finish: "Finish-to-Finish", start_to_finish: "Start-to-Finish"
    };
    const DEP_TYPE_ABBR = { finish_to_start: "FS", start_to_start: "SS", finish_to_finish: "FF", start_to_finish: "SF" };

    /* ============================================================
       STATE
       ============================================================ */

    let currentProject = null;
    let phases = [];         // schedule_phases rows
    let tasks = [];          // schedule_tasks rows (tasks AND milestones — item_type distinguishes)
    let dependencies = [];   // schedule_dependencies rows
    let staffDirectory = []; // [{ id, full_name }]
    let contractors = [];    // [{ id, Name }] from "Companies"

    let phasesById = new Map();
    let tasksById = new Map();

    let cpmResult = { byTaskId: new Map(), projectFinishDay: null, hasCycle: false };

    let gantt = null;
    let currentViewMode = "Week";
    const collapsedPhaseIds = new Set();

    const filters = {
        search: "",
        phaseType: "all",
        status: new Set(),
        priority: new Set(),
        criticalOnly: false,
        assignee: new Set(),
        contractor: new Set(),
        dateFrom: "",
        dateTo: ""
    };
    let sortField = null;   // null = manual (sort_order); otherwise one of name/start_date/end_date/status
    let sortDir = "asc";

    // Drawer state
    let drawerMode = "create";      // "create" | "edit"
    let drawerItemType = "task";    // "task" | "milestone" | "phase"
    let drawerItemId = null;

    let pendingDeleteTarget = null; // { kind: "task"|"phase", id }
    let dragState = null;           // { kind: "task"|"phase", id, phaseId? }

    /* ============================================================
       DATE / MISC UTILITIES — pure integer day-number arithmetic so
       nothing here is ever exposed to timezone/DST drift.
       ============================================================ */

    function pad2(n) { return String(n).padStart(2, "0"); }

    function todayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function dayNum(iso) {
        const [y, m, d] = iso.split("-").map(Number);
        return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
    }

    function dayNumToISO(n) {
        const d = new Date(n * 86400000);
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }

    function addDaysISO(iso, days) { return dayNumToISO(dayNum(iso) + days); }

    function formatDateLong(iso) {
        if (!iso) return "—";
        const [y, m, d] = iso.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    }

    function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[ch]));
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function tempId() {
        return "temp-" + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(36).slice(2)));
    }

    function isTempId(id) { return typeof id === "string" && id.startsWith("temp-"); }

    function taskDurationDays(t) {
        if (t.item_type === "milestone") return 1;
        if (!t.start_date || !t.end_date) return 1;
        return Math.max(1, dayNum(t.end_date) - dayNum(t.start_date) + 1);
    }

    /* ============================================================
       IDENTITY — window.currentSupabaseProfile is set by supabase-auth.js
       from the real staff_users row for whoever is signed in (see that
       file's header comment). Never trust anything else as "who is this".
       ============================================================ */

    function getStaffProfile() { return window.currentSupabaseProfile || null; }
    function getStaffId() { return getStaffProfile()?.id || null; }
    function getStaffName() { return getStaffProfile()?.full_name || getStaffProfile()?.username || "Staff"; }

    /* ============================================================
       PAGE / DRAWER MESSAGES
       ============================================================ */

    function setPageMessage(text, type) {
        const el = document.getElementById("timelinePageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; el.textContent = ""; return; }
        el.textContent = text;
        el.className = "workbook-page-message" + (type ? " " + type : ""); // matches .workbook-page-message.success / .error in styles.css
        el.style.display = "block";
        if (type !== "error") setTimeout(() => { if (el.textContent === text) el.style.display = "none"; }, 4000);
    }

    function setDrawerMessage(text, type) {
        const el = document.getElementById("schedDrawerMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = "auth-message" + (type ? " auth-message--" + type : "");
    }

    /* ============================================================
       DATA LOADING
       ============================================================ */

    async function loadAll(projectId) {
        const [phasesRes, tasksRes, depsRes, staffRes, companiesRes] = await Promise.all([
            window.supabaseClient.from(PHASES_TABLE).select("*").eq("project_id", projectId).order("sort_order", { ascending: true }),
            window.supabaseClient.from(TASKS_TABLE).select("*").eq("project_id", projectId).order("sort_order", { ascending: true }),
            window.supabaseClient.from(DEPS_TABLE).select("*").eq("project_id", projectId),
            window.supabaseClient.from(STAFF_TABLE).select("id, full_name, active").eq("active", true).order("full_name", { ascending: true }),
            window.supabaseClient.from(COMPANIES_TABLE).select('id, "Name"').order("Name", { ascending: true })
        ]);

        if (phasesRes.error || tasksRes.error || depsRes.error) {
            console.error("Failed to load schedule data:", phasesRes.error || tasksRes.error || depsRes.error);
            setPageMessage("Couldn't load this project's schedule. Try refreshing the page.", "error");
            return false;
        }

        phases = phasesRes.data || [];
        tasks = tasksRes.data || [];
        dependencies = depsRes.data || [];
        staffDirectory = staffRes.data || [];
        contractors = (companiesRes.data || []).map(c => ({ id: c.id, name: c.Name }));

        rebuildLookups();
        return true;
    }

    function rebuildLookups() {
        phasesById = new Map(phases.map(p => [p.id, p]));
        tasksById = new Map(tasks.map(t => [t.id, t]));
    }

    /* ============================================================
       CRITICAL PATH METHOD

       Forward pass computes earliest start/finish per task from its
       recorded start_date (roots) and its predecessors' constraints;
       backward pass computes latest start/finish anchored on the overall
       project finish. float = lateStart - earlyStart; float <= 0 is on
       the critical path. All four dependency types + lag_days honored.
       Defensive: if the graph has a cycle (shouldn't happen — the DB
       trigger blocks creating one — but don't trust that blindly client-
       side), CPM is skipped rather than producing nonsense, and the UI
       says so instead of silently showing wrong critical-path highlights.
       ============================================================ */

    function computeCPM(taskList, depList) {
        const byId = new Map(taskList.map(t => [t.id, t]));
        const succMap = new Map(), predMap = new Map();
        taskList.forEach(t => { succMap.set(t.id, []); predMap.set(t.id, []); });
        depList.forEach(d => {
            if (!byId.has(d.predecessor_task_id) || !byId.has(d.successor_task_id)) return;
            succMap.get(d.predecessor_task_id).push(d);
            predMap.get(d.successor_task_id).push(d);
        });

        const indegree = new Map(taskList.map(t => [t.id, predMap.get(t.id).length]));
        const queue = taskList.filter(t => indegree.get(t.id) === 0).map(t => t.id);
        const order = [];
        while (queue.length) {
            const id = queue.shift();
            order.push(id);
            succMap.get(id).forEach(d => {
                const nd = indegree.get(d.successor_task_id) - 1;
                indegree.set(d.successor_task_id, nd);
                if (nd === 0) queue.push(d.successor_task_id);
            });
        }

        const hasCycle = order.length !== taskList.length;
        if (hasCycle) return { byTaskId: new Map(), projectFinishDay: null, hasCycle: true };

        const dur = t => taskDurationDays(t);
        const ES = new Map(), EF = new Map();
        order.forEach(id => {
            const t = byId.get(id);
            const preds = predMap.get(id);
            let es;
            if (!preds.length) {
                es = dayNum(t.item_type === "milestone" ? t.end_date : (t.start_date || t.end_date));
            } else {
                es = -Infinity;
                preds.forEach(d => {
                    const p = byId.get(d.predecessor_task_id);
                    const pES = ES.get(p.id), pEF = EF.get(p.id);
                    const lag = d.lag_days || 0;
                    let candidate;
                    if (d.dependency_type === "finish_to_start") candidate = pEF + 1 + lag;
                    else if (d.dependency_type === "start_to_start") candidate = pES + lag;
                    else if (d.dependency_type === "finish_to_finish") candidate = pEF + lag - dur(t) + 1;
                    else candidate = pES + lag - dur(t) + 1; // start_to_finish
                    if (candidate > es) es = candidate;
                });
            }
            ES.set(id, es);
            EF.set(id, es + dur(t) - 1);
        });

        const projectFinishDay = order.length ? Math.max(...order.map(id => EF.get(id))) : null;

        const LS = new Map(), LF = new Map();
        for (let i = order.length - 1; i >= 0; i--) {
            const id = order[i];
            const t = byId.get(id);
            const succs = succMap.get(id);
            let lf;
            if (!succs.length) {
                lf = projectFinishDay;
            } else {
                lf = Infinity;
                succs.forEach(d => {
                    const s = byId.get(d.successor_task_id);
                    const sLS = LS.get(s.id), sLF = LF.get(s.id);
                    const lag = d.lag_days || 0;
                    let candidate;
                    if (d.dependency_type === "finish_to_start") candidate = sLS - 1 - lag;
                    else if (d.dependency_type === "start_to_start") candidate = sLS - lag + dur(t) - 1;
                    else if (d.dependency_type === "finish_to_finish") candidate = sLF - lag;
                    else candidate = sLF - lag + dur(t) - 1; // start_to_finish
                    if (candidate < lf) lf = candidate;
                });
            }
            LF.set(id, lf);
            LS.set(id, lf - dur(t) + 1);
        }

        const byTaskId = new Map();
        order.forEach(id => {
            const float = LS.get(id) - ES.get(id);
            byTaskId.set(id, { earlyStart: ES.get(id), earlyFinish: EF.get(id), lateStart: LS.get(id), lateFinish: LF.get(id), float, critical: float <= 0 });
        });

        return { byTaskId, projectFinishDay, hasCycle: false };
    }

    /* ============================================================
       DERIVED DATA — filtering, search, sorting, schedule health,
       completion projection. Pure functions over the loaded arrays.
       ============================================================ */

    function hasActiveFilters() {
        return !!filters.search || filters.phaseType !== "all" || filters.status.size || filters.priority.size ||
            filters.criticalOnly || filters.assignee.size || filters.contractor.size || filters.dateFrom || filters.dateTo;
    }

    function taskMatchesFilters(t) {
        if (filters.search) {
            const q = filters.search.toLowerCase();
            const hay = `${t.name} ${t.description || ""} ${t.notes || ""} ${t.assigned_user_name || ""} ${t.contractor_name || ""}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        if (filters.phaseType !== "all") {
            const phase = phasesById.get(t.phase_id);
            if (!phase || phase.phase_type !== filters.phaseType) return false;
        }
        if (filters.status.size && !filters.status.has(t.status)) return false;
        if (filters.priority.size && !filters.priority.has(t.priority)) return false;
        if (filters.criticalOnly && !t.is_critical) return false;
        if (filters.assignee.size && !filters.assignee.has(String(t.assigned_user_id))) return false;
        if (filters.contractor.size && !filters.contractor.has(String(t.contractor_id))) return false;
        if (filters.dateFrom && t.end_date && t.end_date < filters.dateFrom) return false;
        if (filters.dateTo && (t.start_date || t.end_date) > filters.dateTo) return false;
        return true;
    }

    function getFilteredTasks() { return tasks.filter(taskMatchesFilters); }

    function getVisiblePhases(filteredTasks) {
        const active = hasActiveFilters();
        const filteredIds = new Set(filteredTasks.map(t => t.id));
        let list = phases.slice();
        if (filters.phaseType !== "all") list = list.filter(p => p.phase_type === filters.phaseType);
        if (active) list = list.filter(p => tasks.some(t => t.phase_id === p.id && filteredIds.has(t.id)));
        list.sort((a, b) => a.sort_order - b.sort_order);
        return list;
    }

    function sortTasksInPhase(list) {
        if (!sortField) return list.slice().sort((a, b) => a.sort_order - b.sort_order);
        const dir = sortDir === "asc" ? 1 : -1;
        return list.slice().sort((a, b) => {
            let av = a[sortField], bv = b[sortField];
            if (sortField === "start_date") { av = av || a.end_date || ""; bv = bv || b.end_date || ""; }
            if (av == null) av = "";
            if (bv == null) bv = "";
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
    }

    function computeScheduleHealth(filteredTasks) {
        const today = todayISO();
        const overdue = filteredTasks.filter(t => t.status !== "complete" && t.end_date && t.end_date < today);
        const delayedCritical = filteredTasks.filter(t => t.is_critical && (t.status === "delayed" || t.status === "at_risk"));
        const negativeFloat = filteredTasks.filter(t => {
            const r = cpmResult.byTaskId.get(t.id);
            return r && r.float < 0;
        });
        const behindProgress = filteredTasks.filter(t => {
            if (t.item_type === "milestone" || !t.start_date || !t.end_date) return false;
            if (t.status === "complete" || t.status === "on_hold") return false;
            const s = dayNum(t.start_date), e = dayNum(t.end_date), now = dayNum(today);
            if (now <= s || now >= e) return false;
            const expected = ((now - s) / Math.max(1, e - s)) * 100;
            return expected - t.progress_percent > 25;
        });

        const projection = computeCompletionProjection(filteredTasks);
        const projectedLate = projection.currentDue && projection.projectedISO && projection.projectedISO > projection.currentDue;

        let level = "green";
        const reasons = [];
        if (overdue.length) reasons.push(`${overdue.length} task${overdue.length === 1 ? "" : "s"} past due`);
        if (delayedCritical.length) reasons.push(`${delayedCritical.length} critical task${delayedCritical.length === 1 ? "" : "s"} delayed/at risk`);
        if (negativeFloat.length) reasons.push(`${negativeFloat.length} task${negativeFloat.length === 1 ? "" : "s"} scheduled inconsistently with their dependencies`);
        if (behindProgress.length) reasons.push(`${behindProgress.length} task${behindProgress.length === 1 ? "" : "s"} behind expected progress`);
        if (projectedLate) reasons.push("Projected finish has slipped past the current scheduled completion date");

        if (negativeFloat.length || delayedCritical.length || projectedLate) level = "red";
        else if (overdue.length || behindProgress.length) level = "yellow";

        return { level, reasons, overdue, delayedCritical, negativeFloat, behindProgress };
    }

    function computeCompletionProjection(taskList) {
        // Locked plan → compare against the plan's finish (latest plan_end_date).
        // No plan yet → fall back to the project's old due_date field.
        const planEnds = taskList.map(t => t.plan_end_date).filter(Boolean).sort();
        const planFinish = currentProject && currentProject.plan_locked_at && planEnds.length ? planEnds[planEnds.length - 1] : null;
        const currentDue = planFinish || (currentProject && currentProject.due_date ? currentProject.due_date : null);
        const projectedISO = cpmResult.projectFinishDay != null ? dayNumToISO(cpmResult.projectFinishDay) : null;
        let lateDays = null;
        if (currentDue && projectedISO && projectedISO > currentDue) lateDays = dayNum(projectedISO) - dayNum(currentDue);
        return { currentDue, projectedISO, lateDays };
    }

    /* ============================================================
       RENDER — one entrypoint (renderAll) that recomputes CPM, then
       redraws the toolbar state, task list, chart, completion banner,
       and health badge from the same filtered/sorted data.
       ============================================================ */

    function renderAll() {
        cpmResult = computeCPM(tasks, dependencies);

        const filtered = getFilteredTasks();
        const visiblePhases = getVisiblePhases(filtered);

        renderPhaseTabs();
        renderFilterCount();
        renderTaskListPane(visiblePhases, filtered);
        renderGanttChart(visiblePhases, filtered);
        renderCompletionBanner(filtered);
        renderScheduleHealth(filtered);

        const emptyState = document.getElementById("timelineEmptyState");
        const workspace = document.getElementById("schedWorkspace");
        const isEmpty = tasks.length === 0 && phases.length === 0;
        if (emptyState) emptyState.style.display = isEmpty ? "block" : "none";
        // "flex", not "block": #schedWorkspace is itself a flex column (see
        // its CSS rule) so .sched-main-area inside it can flex:1 0 auto to
        // fill the rest of the page's height — an inline style here always
        // wins over that stylesheet rule, so this has to match it exactly.
        if (workspace) workspace.style.display = isEmpty ? "none" : "flex";
    }

    function renderPhaseTabs() {
        document.querySelectorAll("#schedPhaseTabs .sched-phase-tab").forEach(btn => {
            const isActive = btn.dataset.phaseType === filters.phaseType;
            btn.classList.toggle("is-active", isActive);
            btn.setAttribute("aria-selected", String(isActive));
        });
    }

    function renderFilterCount() {
        let n = 0;
        if (filters.status.size) n++;
        if (filters.priority.size) n++;
        if (filters.criticalOnly) n++;
        if (filters.assignee.size) n++;
        if (filters.contractor.size) n++;
        if (filters.dateFrom || filters.dateTo) n++;
        const el = document.getElementById("schedFilterCount");
        if (!el) return;
        el.textContent = String(n);
        el.classList.toggle("hidden", n === 0);
    }

    function statusBadgeHtml(status) {
        return `<span class="sched-status-badge sched-status-badge--${status}">${STATUS_LABELS[status] || status}</span>`;
    }

    function renderTaskListPane(visiblePhases, filteredTasks) {
        const body = document.getElementById("schedTaskListBody");
        if (!body) return;
        const filteredIds = new Set(filteredTasks.map(t => t.id));
        const manualMode = !sortField;

        let html = "";
        visiblePhases.forEach(phase => {
            const phaseTasks = sortTasksInPhase(tasks.filter(t => t.phase_id === phase.id && filteredIds.has(t.id)));
            const collapsed = collapsedPhaseIds.has(phase.id);
            const total = tasks.filter(t => t.phase_id === phase.id).length;
            const done = tasks.filter(t => t.phase_id === phase.id && t.status === "complete").length;

            html += `<div class="stl-phase-group" data-phase-id="${phase.id}">
                <div class="stl-phase-header" data-phase-id="${phase.id}" ${manualMode ? 'draggable="true"' : ""}>
                    <button type="button" class="stl-phase-collapse-btn" data-collapse-phase="${phase.id}" aria-label="${collapsed ? "Expand" : "Collapse"} phase">${collapsed ? "▸" : "▾"}</button>
                    <span class="stl-phase-name">${escapeHtml(phase.name)}</span>
                    <span class="stl-phase-type-pill stl-phase-type-pill--${phase.phase_type}">${PHASE_TYPE_LABELS[phase.phase_type]}</span>
                    <span class="stl-phase-count">${done}/${total}</span>
                </div>`;

            if (!collapsed) {
                phaseTasks.forEach(t => {
                    const cpm = cpmResult.byTaskId.get(t.id);
                    const isMilestone = t.item_type === "milestone";
                    html += `<div class="stl-row${isMilestone ? " stl-row--milestone" : ""}${cpm && cpm.critical ? " stl-row--cpm-critical" : ""}" data-task-id="${t.id}" data-phase-id="${phase.id}" ${manualMode ? 'draggable="true"' : ""}>
                        <span class="stl-col stl-col--drag" aria-hidden="true">${manualMode ? "⠿" : ""}</span>
                        <span class="stl-col stl-col--name">${isMilestone ? '<span class="stl-milestone-diamond">◆</span> ' : ""}${escapeHtml(t.name)}</span>
                        <span class="stl-col stl-col--start">${isMilestone ? "" : formatDateLong(t.start_date)}</span>
                        <span class="stl-col stl-col--finish">${formatDateLong(t.end_date)}</span>
                        <span class="stl-col stl-col--status">${statusBadgeHtml(t.status)}</span>
                        <span class="stl-col stl-col--critical">${t.is_critical ? '<span class="sched-critical-icon" title="Flagged critical">⛔</span>' : ""}</span>
                    </div>`;
                });
                if (!phaseTasks.length) html += `<div class="stl-row stl-row--empty">No items match the current filters.</div>`;
            }
        });

        if (!visiblePhases.length) html = `<div class="stl-row stl-row--empty">No phases match the current filters.</div>`;

        body.innerHTML = html;

        body.querySelectorAll("[data-collapse-phase]").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = btn.dataset.collapsePhase;
                if (collapsedPhaseIds.has(id)) collapsedPhaseIds.delete(id); else collapsedPhaseIds.add(id);
                renderAll();
            });
        });
        body.querySelectorAll(".stl-row[data-task-id]").forEach(row => {
            row.addEventListener("click", () => openDrawerForEdit("task", row.dataset.taskId));
        });
        body.querySelectorAll(".stl-phase-header").forEach(row => {
            row.addEventListener("dblclick", () => openDrawerForEdit("phase", row.dataset.phaseId));
        });

        wireDragReorder(body);
    }

    /* ---- drag-to-reorder (task list pane): manual mode only ---- */

    function wireDragReorder(body) {
        if (sortField) return; // sorted by column — manual reorder disabled
        body.querySelectorAll("[draggable='true']").forEach(el => {
            el.addEventListener("dragstart", (e) => {
                const isPhase = el.classList.contains("stl-phase-header");
                dragState = isPhase ? { kind: "phase", id: el.dataset.phaseId } : { kind: "task", id: el.dataset.taskId, phaseId: el.dataset.phaseId };
                e.dataTransfer.effectAllowed = "move";
            });
            el.addEventListener("dragover", (e) => {
                if (!dragState) return;
                const isPhase = el.classList.contains("stl-phase-header");
                if (dragState.kind === "phase" && !isPhase) return;
                e.preventDefault();
                el.classList.add("stl-drop-target");
            });
            el.addEventListener("dragleave", () => el.classList.remove("stl-drop-target"));
            el.addEventListener("drop", (e) => {
                e.preventDefault();
                el.classList.remove("stl-drop-target");
                if (!dragState) return;
                const isPhase = el.classList.contains("stl-phase-header");
                if (dragState.kind === "phase" && isPhase) {
                    reorderPhase(dragState.id, el.dataset.phaseId);
                } else if (dragState.kind === "task" && !isPhase) {
                    reorderTask(dragState.id, el.dataset.taskId, el.dataset.phaseId);
                }
                dragState = null;
            });
        });
    }

    function reorderPhase(draggedId, targetId) {
        if (draggedId === targetId) return;
        const ordered = phases.slice().sort((a, b) => a.sort_order - b.sort_order);
        const fromIdx = ordered.findIndex(p => p.id === draggedId);
        const toIdx = ordered.findIndex(p => p.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = ordered.splice(fromIdx, 1);
        ordered.splice(toIdx, 0, moved);
        const updates = ordered.map((p, i) => ({ id: p.id, sort_order: i }));
        optimisticBatchReorder(PHASES_TABLE, phases, updates);
    }

    function reorderTask(draggedId, targetId, targetPhaseId) {
        const dragged = tasksById.get(draggedId);
        if (!dragged) return;
        if (draggedId === targetId && dragged.phase_id === targetPhaseId) return;
        const phaseTasks = tasks.filter(t => t.phase_id === targetPhaseId).sort((a, b) => a.sort_order - b.sort_order);
        const withoutDragged = phaseTasks.filter(t => t.id !== draggedId);
        const toIdx = withoutDragged.findIndex(t => t.id === targetId);
        const insertAt = toIdx < 0 ? withoutDragged.length : toIdx;
        withoutDragged.splice(insertAt, 0, dragged);
        const updates = withoutDragged.map((t, i) => ({ id: t.id, sort_order: i }));
        if (dragged.phase_id !== targetPhaseId) updates.forEach(u => { if (u.id === draggedId) u.phase_id = targetPhaseId; });
        optimisticBatchReorder(TASKS_TABLE, tasks, updates);
    }

    async function optimisticBatchReorder(table, collection, updates) {
        const previous = updates.map(u => ({ ...collection.find(x => x.id === u.id) }));
        updates.forEach(u => {
            const row = collection.find(x => x.id === u.id);
            if (row) Object.assign(row, u);
        });
        renderAll();
        try {
            const results = await Promise.all(updates.map(u => {
                const payload = { ...u }; delete payload.id;
                return window.supabaseClient.from(table).update(payload).eq("id", u.id);
            }));
            const failed = results.find(r => r.error);
            if (failed) throw failed.error;
        } catch (err) {
            console.error("Reorder failed, reverting:", err);
            previous.forEach(p => { const row = collection.find(x => x.id === p.id); if (row) Object.assign(row, p); });
            renderAll();
            setPageMessage("Couldn't save the new order. Reverted.", "error");
        }
    }

    /* ============================================================
       GANTT CHART (Frappe Gantt)
       ============================================================ */

    const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    function isoWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayN = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayN);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    // Custom two-line week header (kept from the earlier debugged
    // integration — Frappe's own innerText setter does render embedded
    // "\n" as a real line break; see make_dates() in Frappe's source).
    const CUSTOM_WEEK_MODE = {
        name: "Week", padding: "1m", step: "7d", date_format: "YYYY-MM-DD", column_width: 140,
        lower_text: (date) => {
            const end = new Date(date); end.setDate(end.getDate() + 6);
            const sameMonth = date.getMonth() === end.getMonth();
            const startLabel = `${MONTH_ABBR[date.getMonth()]} ${date.getDate()}`;
            const endLabel = sameMonth ? `${end.getDate()}` : `${MONTH_ABBR[end.getMonth()]} ${end.getDate()}`;
            return `W${isoWeekNumber(date)}\n${startLabel} - ${endLabel}`;
        },
        upper_text: (date, prevDate) => (!prevDate || date.getMonth() !== prevDate.getMonth()) ? MONTH_FULL[date.getMonth()] : "",
        thick_line: (date) => date.getDate() >= 1 && date.getDate() <= 7,
        upper_text_frequency: 4
    };

    // Custom calendar-quarter mode (Frappe 1.2.2 has no built-in "Quarter")
    // — every 3 months, columns are whole months, quarter label on the
    // first month of each quarter.
    const CUSTOM_QUARTER_MODE = {
        name: "Quarter", padding: "2m", step: "1m", column_width: 120, date_format: "YYYY-MM",
        lower_text: (date) => {
            const q = Math.floor(date.getMonth() / 3) + 1;
            return date.getMonth() % 3 === 0 ? `Q${q} ${MONTH_ABBR[date.getMonth()]}` : MONTH_ABBR[date.getMonth()];
        },
        upper_text: (date, prevDate) => (!prevDate || date.getFullYear() !== prevDate.getFullYear()) ? String(date.getFullYear()) : "",
        thick_line: (date) => date.getMonth() % 3 === 0,
        snap_at: "7d"
    };

    const GANTT_VIEW_MODES = ["Day", CUSTOM_WEEK_MODE, "Month", CUSTOM_QUARTER_MODE, "Year"];

    function buildGanttCustomClass(t, cpm) {
        // Frappe passes this whole string to a SINGLE classList.add() call
        // (see frappe-gantt's Bar.prepare_wrappers()) — a space-separated
        // string throws "InvalidCharacterError" there, so every distinct
        // fact has to be hyphen-joined into one token and matched on the
        // CSS side with [class*="..."] substring selectors instead of
        // plain class selectors (same convention the earlier Gantt
        // integration in this app already established).
        let token = `gantt-status-${t.status}`;
        if (t.item_type === "milestone") token += "-milestone";
        if (t.is_critical) token += "-criticalflag";
        if (cpm && cpm.critical) token += "-cpmcritical";
        return token;
    }

    function buildGanttTasksArray(filteredTasks) {
        return filteredTasks.map(t => {
            const cpm = cpmResult.byTaskId.get(t.id);
            const preds = dependencies.filter(d => d.successor_task_id === t.id).map(d => d.predecessor_task_id);
            const start = t.item_type === "milestone" ? t.end_date : t.start_date;
            return {
                id: t.id,
                name: (t.item_type === "milestone" ? "◆ " : "") + t.name,
                start,
                end: addDaysISO(t.end_date, 1), // Frappe end is exclusive of the last day in practice; +1 keeps the bar covering the full end_date
                progress: t.progress_percent || 0,
                dependencies: preds.join(","),
                custom_class: buildGanttCustomClass(t, cpm),
                _floatDays: cpm ? cpm.float : null
            };
        });
    }

    function renderGanttChart(visiblePhases, filteredTasks) {
        const el = document.getElementById("schedGanttChart");
        if (!el || typeof Gantt === "undefined") return;

        // MUST clear before every `new Gantt(...)` below, not just when the
        // task list is empty. Frappe's own setup_wrapper() checks for an
        // existing <svg> inside `el` and, if it finds one from a PRIOR
        // render, reuses it in place rather than starting clean -- but it
        // still builds a brand new .gantt-container/.grid-header/.side-header/
        // .extras/.popup-wrapper around it every time, nested inside
        // whatever container the previous render created. Nothing ever
        // removes that previous render's own header/extras (they belong to
        // the discarded old Gantt instance, and the new instance's clear()
        // only knows how to remove ITS OWN, not-yet-created, references) --
        // so every single re-render (any drag, any edit, any filter change)
        // left one more full copy of the date-column header stacked on top
        // of the last, visibly duplicating the timeline strip and bloating
        // the DOM a little more each time (confirmed directly: 3 sequential
        // drags took the chart from 1 .grid-header to 2 to 3). Wiping the
        // container first forces a genuinely fresh SVG + header every time.
        el.innerHTML = "";

        const ganttTasks = buildGanttTasksArray(filteredTasks);
        if (!ganttTasks.length) { gantt = null; return; }

        const options = {
            view_modes: GANTT_VIEW_MODES,
            view_mode: currentViewMode,
            date_format: "YYYY-MM-DD",
            today_button: false,
            move_dependencies: false, // see file header — our 4-type/lag model must stay the single source of truth
            // Frappe defaults this to true: while scrolled into roughly the
            // first/last half of the chart's current date range, ANY wheel
            // event on the chart (a trackpad nudge, not just a deliberate
            // scroll-to-edge) makes Frappe silently extend gantt_start or
            // gantt_end and call its own internal render() — a full teardown
            // and rebuild of every bar's SVG element — completely outside
            // our on_date_change/renderAll pipeline. If that fires while a
            // drag/resize gesture is in progress (confirmed via a scripted
            // repro: dispatching a wheel event mid-drag turned an 8-day
            // drag into a 66-day jump), the bar being dragged gets
            // silently detached from the live DOM mid-gesture, and the drop
            // position is then computed relative to the NEW (shifted)
            // gantt_start while the bar's raw x/width are still relative to
            // the OLD one — producing a wildly wrong saved date (tens to
            // hundreds of days off from a small, ordinary drag) with the
            // bar rendering as missing/blank afterward. Each CUSTOM_*/built-in
            // view mode already declares its own static `padding`, which is
            // what Frappe falls back to with this off — plenty of margin
            // around the real tasks without the scroll-triggered mutation.
            infinite_padding: false,
            readonly_progress: false,
            // IMPORTANT: Frappe fires on_date_change on EVERY mousemove that
            // crosses a day boundary during an active drag (not just once on
            // drop) -- see Bar.date_changed()/update_bar_position() in
            // frappe-gantt. Frappe's own bar position updates are purely
            // attribute-based and stay smooth on their own regardless; but if
            // OUR handler reacted to every one of those events synchronously
            // (optimisticUpdateTask -> renderAll -> a full `new Gantt(...)`
            // rebuild of the chart), the chart's DOM gets torn down and
            // rebuilt while the mouse button is still down, which detaches
            // the bar the browser is actively tracking and kills the drag
            // gesture outright (confirmed via instrumented event tracing).
            // Debouncing coalesces the flurry of mid-drag events into a
            // single call that fires shortly after the user releases the
            // mouse (mouseup fires one more date_change if the position
            // actually changed), so we only persist + re-render once the
            // gesture is actually finished.
            on_date_change: debouncedGanttDateChange,
            on_progress_change: handleGanttProgressChange,
            on_click: (task) => openDrawerForEdit(tasksById.get(task.id)?.item_type === "phase" ? "phase" : "task", task.id)
        };

        try {
            gantt = new Gantt(el, ganttTasks, options);
            // Frappe applies view_modes[0] as view_mode during construction
            // regardless of the view_mode option passed in (a real bug in
            // the library's own setup_options()) — force the intended mode
            // immediately after construction.
            gantt.change_view_mode(currentViewMode, false);
        } catch (err) {
            console.error("Gantt render failed:", err);
            return;
        }

        attachBarHoverCards(ganttTasks);
    }

    async function handleGanttDateChange(ganttTask, newStart, newEnd) {
        const t = tasksById.get(ganttTask.id);
        if (!t) return;
        const startISO = `${newStart.getFullYear()}-${pad2(newStart.getMonth() + 1)}-${pad2(newStart.getDate())}`;
        const endDate = new Date(newEnd);
        const endISO = `${endDate.getFullYear()}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}`;

        // Defensive guard: never hand the DB (or the local model) an
        // inverted range. A fast/awkward real-world drag gesture on the
        // chart CAN hand back a raw end-before-start pair from the
        // charting library's own internal snapping — reject it outright
        // rather than saving corrupt dates or guessing a "fix". The bar
        // simply snaps back to its last good position (re-render below).
        if (t.item_type !== "milestone" && endISO < startISO) {
            console.warn("Ignored a drag that would have put the end date before the start date:", { taskId: t.id, startISO, endISO });
            setPageMessage("That move isn't valid (end before start) — ignored.", "error");
            renderAll(); // re-render from the still-unchanged model to snap the bar back
            return;
        }

        if (t.item_type === "milestone") {
            await optimisticUpdateTask(t.id, { end_date: endISO });
        } else {
            await optimisticUpdateTask(t.id, { start_date: startISO, end_date: endISO });
        }
    }

    // See the on_date_change wiring above for why this can't just call
    // handleGanttDateChange directly. A fixed-delay debounce alone isn't
    // enough either -- if the user pauses mid-drag for longer than the
    // delay, a timer-only debounce would fire while the mouse button is
    // still down and break the gesture the same way. Instead we gate on
    // the ACTUAL mouse-button state: while the button is down over the
    // gantt, incoming date_change events just update the pending payload;
    // the pending payload is only flushed (persisted + re-rendered) once
    // the button comes back up. ganttDragMouseDown is maintained by the
    // mousedown/mouseup listeners wired in wireStaticEvents().
    let ganttDragMouseDown = false;
    let pendingGanttDateChange = null;
    let ganttDateChangeRecheckTimer = null;

    function debouncedGanttDateChange(ganttTask, newStart, newEnd) {
        pendingGanttDateChange = { ganttTask, newStart, newEnd };
        clearTimeout(ganttDateChangeRecheckTimer);
        ganttDateChangeRecheckTimer = setTimeout(flushPendingGanttDateChange, 250);
    }

    function flushPendingGanttDateChange() {
        clearTimeout(ganttDateChangeRecheckTimer);
        if (ganttDragMouseDown) {
            // Still mid-gesture (a paused-but-not-released drag outlasted
            // the debounce window) -- do NOT touch the DOM yet. Check back
            // shortly instead of acting early.
            ganttDateChangeRecheckTimer = setTimeout(flushPendingGanttDateChange, 150);
            return;
        }
        if (!pendingGanttDateChange) return;
        const { ganttTask, newStart, newEnd } = pendingGanttDateChange;
        pendingGanttDateChange = null;
        handleGanttDateChange(ganttTask, newStart, newEnd);
    }

    async function handleGanttProgressChange(ganttTask, progress) {
        await optimisticUpdateTask(ganttTask.id, { progress_percent: Math.round(progress) });
    }

    function hideGanttHoverCard() {
        const card = document.getElementById("ganttHoverCard");
        if (card) card.classList.add("hidden");
    }

    function attachBarHoverCards(ganttTasksArr) {
        hideGanttHoverCard();
        const card = document.getElementById("ganttHoverCard");
        if (!card) return;
        const titleEl = document.getElementById("ganttHoverCardTitle");
        const datesEl = document.getElementById("ganttHoverCardDates");
        const assigneeEl = document.getElementById("ganttHoverCardAssignee");

        document.querySelectorAll("#schedGanttChart .bar-wrapper").forEach(wrapper => {
            const id = wrapper.getAttribute("data-id");
            const t = tasksById.get(id);
            if (!t) return;
            wrapper.addEventListener("mouseenter", () => {
                titleEl.textContent = t.name;
                datesEl.textContent = t.item_type === "milestone" ? formatDateLong(t.end_date) : `${formatDateLong(t.start_date)} – ${formatDateLong(t.end_date)}`;
                assigneeEl.textContent = t.assigned_user_name ? `Assigned: ${t.assigned_user_name}` : "";
                const rect = wrapper.getBoundingClientRect();
                card.style.left = `${rect.left + rect.width / 2}px`;
                card.style.top = `${rect.top - 8}px`;
                card.classList.remove("hidden");
            });
            wrapper.addEventListener("mouseleave", hideGanttHoverCard);
        });
    }

    /* ============================================================
       COMPLETION BANNER + SCHEDULE HEALTH
       ============================================================ */

    function renderCompletionBanner(filteredTasks) {
        const banner = document.getElementById("schedCompletionBanner");
        if (!banner) return;
        const projection = computeCompletionProjection(filteredTasks);
        banner.style.display = "flex";
        document.getElementById("schedCurrentCompletion").textContent = projection.currentDue ? formatDateLong(projection.currentDue) : "Not set";
        document.getElementById("schedProjectedCompletion").textContent = projection.projectedISO ? formatDateLong(projection.projectedISO) : "—";
        const warnEl = document.getElementById("schedLateWarning");
        if (projection.lateDays && projection.lateDays > 0) {
            warnEl.textContent = `⚠ Project is currently projected to finish ${projection.lateDays} day${projection.lateDays === 1 ? "" : "s"} late`;
            warnEl.classList.remove("hidden");
        } else {
            warnEl.classList.add("hidden");
        }
    }

    function renderScheduleHealth(filteredTasks) {
        const health = computeScheduleHealth(filteredTasks);
        const dot = document.getElementById("schedHealthDot");
        const text = document.getElementById("schedHealthText");
        if (!dot || !text) return;
        dot.className = "sched-health-dot sched-health-dot--" + health.level;
        const labels = { green: "🟢 On Track", yellow: "🟡 At Risk", red: "🔴 Delayed" };
        text.textContent = labels[health.level];
        window.__schedHealthDetail = health; // read by the detail popover on click
    }

    function showHealthDetail() {
        const health = window.__schedHealthDetail;
        const body = document.getElementById("schedHealthDetailBody");
        if (!health || !body) return;
        body.innerHTML = health.reasons.length
            ? "<ul>" + health.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("") + "</ul>"
            : "<p>Nothing flagged — the schedule looks healthy.</p>";
        document.getElementById("schedHealthDetailOverlay").classList.remove("hidden");
    }

    /* ============================================================
       OPTIMISTIC MUTATIONS — the ONLY way data changes. Update local
       state + render first, write to Supabase second, revert + surface
       an error on failure. See file header for the 4-step contract.
       ============================================================ */

    async function optimisticUpdateTask(id, changes) {
        const t = tasksById.get(id);
        if (!t) return false;
        const previous = { ...t };
        Object.assign(t, changes);
        renderAll();
        const payload = { ...changes, updated_by: getStaffId(), updated_by_name: getStaffName() };
        const { error } = await window.supabaseClient.from(TASKS_TABLE).update(payload).eq("id", id);
        if (error) {
            console.error("Task update failed, reverting:", error);
            Object.assign(t, previous);
            renderAll();
            setPageMessage("Couldn't save that change. It has been reverted.", "error");
            return false;
        }
        return true;
    }

    async function optimisticUpdatePhase(id, changes) {
        const p = phasesById.get(id);
        if (!p) return false;
        const previous = { ...p };
        Object.assign(p, changes);
        renderAll();
        const payload = { ...changes, updated_by: getStaffId(), updated_by_name: getStaffName() };
        const { error } = await window.supabaseClient.from(PHASES_TABLE).update(payload).eq("id", id);
        if (error) {
            console.error("Phase update failed, reverting:", error);
            Object.assign(p, previous);
            renderAll();
            setPageMessage("Couldn't save that change. It has been reverted.", "error");
            return false;
        }
        return true;
    }

    async function optimisticCreateTask(payload) {
        const optimisticRow = { ...payload, id: tempId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        tasks.push(optimisticRow);
        tasksById.set(optimisticRow.id, optimisticRow);
        renderAll();

        const insertPayload = { ...payload, created_by: getStaffId(), created_by_name: getStaffName() };
        // Plan already locked → a task added now is new scope, not a slip, so
        // its plan dates start out equal to its own dates.
        if (currentProject && currentProject.plan_locked_at) {
            insertPayload.plan_start_date = payload.start_date ?? null;
            insertPayload.plan_end_date = payload.end_date ?? null;
        }
        const { data, error } = await window.supabaseClient.from(TASKS_TABLE).insert(insertPayload).select().single();
        if (error) {
            console.error("Task create failed, reverting:", error);
            tasks = tasks.filter(t => t.id !== optimisticRow.id);
            tasksById.delete(optimisticRow.id);
            renderAll();
            setDrawerMessage(friendlyDbError(error, "task"), "error");
            return null;
        }
        tasks = tasks.map(t => t.id === optimisticRow.id ? data : t);
        tasksById.delete(optimisticRow.id);
        tasksById.set(data.id, data);
        renderAll();
        return data;
    }

    async function optimisticCreatePhase(payload) {
        const optimisticRow = { ...payload, id: tempId(), sort_order: phases.length };
        phases.push(optimisticRow);
        phasesById.set(optimisticRow.id, optimisticRow);
        renderAll();

        const insertPayload = { ...payload, sort_order: phases.length - 1, created_by: getStaffId(), created_by_name: getStaffName() };
        const { data, error } = await window.supabaseClient.from(PHASES_TABLE).insert(insertPayload).select().single();
        if (error) {
            console.error("Phase create failed, reverting:", error);
            phases = phases.filter(p => p.id !== optimisticRow.id);
            phasesById.delete(optimisticRow.id);
            renderAll();
            setDrawerMessage(friendlyDbError(error, "phase"), "error");
            return null;
        }
        phases = phases.map(p => p.id === optimisticRow.id ? data : p);
        phasesById.delete(optimisticRow.id);
        phasesById.set(data.id, data);
        renderAll();
        return data;
    }

    async function optimisticDeleteTask(id) {
        const t = tasksById.get(id);
        if (!t) return false;
        const previous = t;
        const previousIndex = tasks.indexOf(t);
        tasks = tasks.filter(x => x.id !== id);
        tasksById.delete(id);
        dependencies = dependencies.filter(d => d.predecessor_task_id !== id && d.successor_task_id !== id);
        renderAll();
        const { error } = await window.supabaseClient.from(TASKS_TABLE).delete().eq("id", id);
        if (error) {
            console.error("Task delete failed, restoring:", error);
            tasks.splice(previousIndex, 0, previous);
            tasksById.set(id, previous);
            renderAll();
            setPageMessage("Couldn't delete that item. It has been restored.", "error");
            return false;
        }
        return true;
    }

    async function optimisticDeletePhase(id) {
        const p = phasesById.get(id);
        if (!p) return false;
        const previousIndex = phases.indexOf(p);
        phases = phases.filter(x => x.id !== id);
        phasesById.delete(id);
        renderAll();
        const { error } = await window.supabaseClient.from(PHASES_TABLE).delete().eq("id", id);
        if (error) {
            console.error("Phase delete failed, restoring:", error);
            phases.splice(previousIndex, 0, p);
            phasesById.set(id, p);
            renderAll();
            // schedule_tasks.phase_id is ON DELETE RESTRICT on purpose — a
            // phase with tasks in it can't be silently deleted (that would
            // orphan them). Surface that as a clear, specific message
            // instead of a generic "couldn't delete".
            const hasTasks = tasks.some(t => t.phase_id === id);
            setPageMessage(hasTasks ? "This phase still has tasks in it — move or delete them first." : "Couldn't delete that phase. It has been restored.", "error");
            return false;
        }
        return true;
    }

    async function optimisticAddDependency(payload) {
        const optimisticRow = { ...payload, id: tempId() };
        dependencies.push(optimisticRow);
        renderAll();
        const insertPayload = { ...payload, created_by: getStaffId() };
        const { data, error } = await window.supabaseClient.from(DEPS_TABLE).insert(insertPayload).select().single();
        if (error) {
            console.error("Dependency create failed, reverting:", error);
            dependencies = dependencies.filter(d => d.id !== optimisticRow.id);
            renderAll();
            setDrawerMessage(friendlyDbError(error, "dependency"), "error");
            return null;
        }
        dependencies = dependencies.map(d => d.id === optimisticRow.id ? data : d);
        renderAll();
        return data;
    }

    async function optimisticRemoveDependency(id) {
        const d = dependencies.find(x => x.id === id);
        if (!d) return false;
        dependencies = dependencies.filter(x => x.id !== id);
        renderAll();
        const { error } = await window.supabaseClient.from(DEPS_TABLE).delete().eq("id", id);
        if (error) {
            console.error("Dependency delete failed, restoring:", error);
            dependencies.push(d);
            renderAll();
            setPageMessage("Couldn't remove that dependency. It has been restored.", "error");
            return false;
        }
        return true;
    }

    function friendlyDbError(error, kind) {
        const msg = (error && error.message) || "";
        if (msg.includes("cycle")) return "That dependency would create a circular chain — pick a different task.";
        if (msg.includes("schedule_tasks_dates_valid")) return "End date can't be before the start date.";
        if (error && error.code === "23505") return `That ${kind} already exists.`;
        return `Couldn't save this ${kind}. Please try again.`;
    }

    /* ============================================================
       DRAWER (create / edit)
       ============================================================ */

    function populatePickers() {
        const phaseSelect = document.getElementById("schedPhaseInput");
        phaseSelect.innerHTML = phases.slice().sort((a, b) => a.sort_order - b.sort_order)
            .map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${PHASE_TYPE_LABELS[p.phase_type]})</option>`).join("");

        const assigneeSelect = document.getElementById("schedAssigneeInput");
        assigneeSelect.innerHTML = '<option value="">Unassigned</option>' + staffDirectory.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("");

        const contractorSelect = document.getElementById("schedContractorInput");
        contractorSelect.innerHTML = '<option value="">None</option>' + contractors.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

        const filterAssignee = document.getElementById("schedFilterAssignee");
        if (filterAssignee) filterAssignee.innerHTML = staffDirectory.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("");
        const filterContractor = document.getElementById("schedFilterContractor");
        if (filterContractor) filterContractor.innerHTML = contractors.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

        const statusChips = document.getElementById("schedFilterStatus");
        if (statusChips) statusChips.innerHTML = STATUSES.map(s => `<button type="button" class="sched-filter-chip" data-value="${s}">${STATUS_LABELS[s]}</button>`).join("");
        const priorityChips = document.getElementById("schedFilterPriority");
        if (priorityChips) priorityChips.innerHTML = PRIORITIES.map(p => `<button type="button" class="sched-filter-chip" data-value="${p}">${PRIORITY_LABELS[p]}</button>`).join("");
    }

    function setDrawerType(type) {
        drawerItemType = type;
        document.getElementById("schedDrawer").dataset.itemType = type;
        document.querySelectorAll("#schedTypeToggle .timeline-type-toggle-btn").forEach(btn => btn.classList.toggle("is-active", btn.dataset.type === type));
        const startLabel = document.getElementById("schedStartDateLabel");
        const endLabelText = document.getElementById("schedEndDateLabelText");
        if (type === "milestone") { startLabel.style.display = "none"; endLabelText.textContent = "Date"; document.getElementById("schedStartDateInput").required = false; }
        else { startLabel.style.display = ""; endLabelText.textContent = "End date"; document.getElementById("schedStartDateInput").required = type === "task"; }

        // THE ACTUAL "Save does nothing" ROOT CAUSE: schedPhaseInput and
        // schedEndDateInput are hardcoded `required` in the HTML and were
        // never toggled off here the way schedStartDateInput's required is
        // above. Both live inside .sched-field--item-only, which styles.css
        // sets to display:none for phase type -- but hiding a required field
        // with display:none does NOT exempt it from the browser's native
        // form validation, it just makes the invalid field unfocusable. On
        // submit, Chrome still finds it invalid, can't focus it to show the
        // usual red validation bubble, silently blocks the submit anyway,
        // and only logs "An invalid form control with name='' is not
        // focusable" to the console -- which is exactly what "the Save
        // button does nothing" looks like: every attempt to save a new
        // Phase failed here, on two fields the user never even sees.
        const isPhase = type === "phase";
        document.getElementById("schedPhaseInput").required = !isPhase;
        document.getElementById("schedEndDateInput").required = !isPhase;
    }

    function openDrawerForCreate(type, defaultPhaseId) {
        drawerMode = "create"; drawerItemId = null;
        populatePickers();
        document.getElementById("schedItemForm").reset();
        document.getElementById("schedItemIdInput").value = "";
        setDrawerType(type);
        document.getElementById("schedDrawerTitle").textContent = type === "phase" ? "New phase" : (type === "milestone" ? "New milestone" : "New task");
        document.getElementById("schedDeleteItemBtn").style.display = "none";
        document.getElementById("schedDrawerCriticalIcon").classList.add("hidden");
        document.getElementById("schedDrawerMilestoneIcon").classList.add("hidden");
        document.getElementById("schedDrawerMeta").textContent = "";
        document.getElementById("schedDependenciesHint").classList.remove("hidden");
        document.getElementById("schedDependenciesAdd").classList.add("hidden");
        document.getElementById("schedDependenciesList").innerHTML = "";
        if (defaultPhaseId) document.getElementById("schedPhaseInput").value = defaultPhaseId;
        setDrawerMessage("");
        document.getElementById("schedDrawer").classList.remove("hidden");
    }

    function openDrawerForEdit(type, id) {
        populatePickers();
        drawerMode = "edit"; drawerItemId = id;
        setDrawerType(type);
        document.getElementById("schedItemIdInput").value = id;
        document.getElementById("schedDeleteItemBtn").style.display = "";
        setDrawerMessage("");

        if (type === "phase") {
            const p = phasesById.get(id);
            if (!p) return;
            document.getElementById("schedDrawerTitle").textContent = p.name;
            document.getElementById("schedNameInput").value = p.name;
            document.getElementById("schedPhaseTypeInput").value = p.phase_type;
            document.getElementById("schedPhaseDescriptionInput").value = p.description || "";
            document.getElementById("schedDrawerCriticalIcon").classList.add("hidden");
            document.getElementById("schedDrawerMilestoneIcon").classList.add("hidden");
            document.getElementById("schedDrawerMeta").textContent = "";
        } else {
            const t = tasksById.get(id);
            if (!t) return;
            setDrawerType(t.item_type);
            document.getElementById("schedDrawerTitle").textContent = t.name;
            document.getElementById("schedNameInput").value = t.name;
            document.getElementById("schedPhaseInput").value = t.phase_id;
            document.getElementById("schedStartDateInput").value = t.start_date || "";
            document.getElementById("schedEndDateInput").value = t.end_date || "";
            document.getElementById("schedStatusInput").value = t.status;
            document.getElementById("schedPriorityInput").value = t.priority;
            document.getElementById("schedProgressInput").value = t.progress_percent;
            document.getElementById("schedProgressValue").textContent = t.progress_percent + "%";
            document.getElementById("schedAssigneeInput").value = t.assigned_user_id || "";
            document.getElementById("schedContractorInput").value = t.contractor_id || "";
            document.getElementById("schedCriticalInput").checked = !!t.is_critical;
            document.getElementById("schedWeatherDelayInput").checked = !!t.weather_delay;
            document.getElementById("schedDescriptionInput").value = t.description || "";
            document.getElementById("schedNotesInput").value = t.notes || "";
            document.getElementById("schedDrawerCriticalIcon").classList.toggle("hidden", !t.is_critical);
            document.getElementById("schedDrawerMilestoneIcon").classList.toggle("hidden", t.item_type !== "milestone");
            const dur = document.getElementById("schedDurationReadout");
            if (t.item_type !== "milestone") { dur.textContent = `Duration: ${taskDurationDays(t)} day${taskDurationDays(t) === 1 ? "" : "s"}`; dur.classList.remove("hidden"); }
            else dur.classList.add("hidden");
            const meta = [];
            if (t.created_by_name) meta.push(`Created by ${t.created_by_name} on ${formatDateLong((t.created_at || "").slice(0, 10))}`);
            if (t.updated_by_name) meta.push(`Last updated by ${t.updated_by_name} on ${formatDateLong((t.updated_at || "").slice(0, 10))}`);
            document.getElementById("schedDrawerMeta").textContent = meta.join(" · ");
            renderDependenciesSection(t);
        }
        document.getElementById("schedDrawer").classList.remove("hidden");
    }

    function renderDependenciesSection(t) {
        document.getElementById("schedDependenciesHint").classList.add("hidden");
        document.getElementById("schedDependenciesAdd").classList.remove("hidden");

        const taskSelect = document.getElementById("schedDependencyTaskSelect");
        taskSelect.innerHTML = '<option value="">Depends on…</option>' + tasks
            .filter(other => other.id !== t.id)
            .map(other => `<option value="${other.id}">${escapeHtml(other.name)}</option>`).join("");

        const list = document.getElementById("schedDependenciesList");
        const predDeps = dependencies.filter(d => d.successor_task_id === t.id);
        if (!predDeps.length) { list.innerHTML = '<p class="sched-dependencies-empty">No dependencies yet.</p>'; return; }
        list.innerHTML = predDeps.map(d => {
            const pred = tasksById.get(d.predecessor_task_id);
            return `<div class="sched-dependency-row" data-dep-id="${d.id}">
                <span>${escapeHtml(pred ? pred.name : "Unknown")}</span>
                <span class="sched-dependency-type">${DEP_TYPE_ABBR[d.dependency_type]}${d.lag_days ? ` +${d.lag_days}d` : ""}</span>
                <button type="button" class="sched-dependency-remove" data-remove-dep="${d.id}" aria-label="Remove dependency">✕</button>
            </div>`;
        }).join("");
        list.querySelectorAll("[data-remove-dep]").forEach(btn => {
            btn.addEventListener("click", () => optimisticRemoveDependency(btn.dataset.removeDep).then(() => renderDependenciesSection(tasksById.get(t.id))));
        });
    }

    function closeDrawer() {
        document.getElementById("schedDrawer").classList.add("hidden");
        drawerItemId = null;
    }

    async function handleDrawerSave(e) {
        e.preventDefault();
        const saveBtn = document.getElementById("schedSaveItemBtn");
        saveBtn.disabled = true;
        setDrawerMessage("");

        // Defensive guard: every payload below reads currentProject.id
        // unconditionally. If this drawer is ever opened before
        // "project-shell:ready" has actually set currentProject (e.g. a
        // slow/failed project load that the user didn't notice because the
        // rest of the page still rendered), that property access used to
        // throw a bare TypeError with nothing shown in the drawer — the
        // button would just silently do nothing while the real error only
        // showed up in the browser console. Surface it instead.
        if (!currentProject || !currentProject.id) {
            setDrawerMessage("This project hasn't finished loading yet. Refresh the page and try again.", "error");
            saveBtn.disabled = false;
            return;
        }

        try {
            if (drawerItemType === "phase") {
                const payload = {
                    project_id: currentProject.id,
                    name: document.getElementById("schedNameInput").value.trim(),
                    phase_type: document.getElementById("schedPhaseTypeInput").value,
                    description: document.getElementById("schedPhaseDescriptionInput").value.trim() || null
                };
                if (!payload.name) { setDrawerMessage("Name is required.", "error"); return; }
                if (drawerMode === "create") {
                    const created = await optimisticCreatePhase(payload);
                    if (!created) return;
                } else {
                    const ok = await optimisticUpdatePhase(drawerItemId, payload);
                    if (!ok) { setDrawerMessage("Couldn't save your changes. They were reverted — please try again.", "error"); return; }
                }
            } else {
                const phaseId = document.getElementById("schedPhaseInput").value;
                if (!phaseId) { setDrawerMessage("Every task must belong to a phase.", "error"); return; }
                const endDate = document.getElementById("schedEndDateInput").value;
                const startDate = drawerItemType === "milestone" ? null : document.getElementById("schedStartDateInput").value;
                if (drawerItemType === "task" && startDate && endDate && endDate < startDate) {
                    setDrawerMessage("End date can't be before the start date.", "error"); return;
                }
                const payload = {
                    project_id: currentProject.id,
                    phase_id: phaseId,
                    item_type: drawerItemType,
                    name: document.getElementById("schedNameInput").value.trim(),
                    description: document.getElementById("schedDescriptionInput").value.trim() || null,
                    notes: document.getElementById("schedNotesInput").value.trim() || null,
                    start_date: startDate || null,
                    end_date: endDate,
                    status: document.getElementById("schedStatusInput").value,
                    progress_percent: drawerItemType === "milestone" ? 0 : Number(document.getElementById("schedProgressInput").value),
                    priority: document.getElementById("schedPriorityInput").value,
                    is_critical: document.getElementById("schedCriticalInput").checked,
                    weather_delay: document.getElementById("schedWeatherDelayInput").checked,
                    assigned_user_id: document.getElementById("schedAssigneeInput").value || null,
                    assigned_user_name: (staffDirectory.find(s => s.id === document.getElementById("schedAssigneeInput").value) || {}).full_name || null,
                    // contractor_id is bigint on the Companies table, but every
                    // <select> option's .value is always a string — comparing
                    // contractors[].id (a number, as Supabase deserializes
                    // bigint) against that string with === always failed, so
                    // contractor_name was silently saved as null even when a
                    // contractor was actually selected. String() on both sides
                    // fixes the comparison without changing contractor_id
                    // itself (Postgres accepts the numeric string fine).
                    contractor_id: document.getElementById("schedContractorInput").value || null,
                    contractor_name: (contractors.find(c => String(c.id) === document.getElementById("schedContractorInput").value) || {}).name || null
                };
                if (!payload.name) { setDrawerMessage("Name is required.", "error"); return; }
                if (!payload.end_date) { setDrawerMessage("Date is required.", "error"); return; }

                if (drawerMode === "create") {
                    const created = await optimisticCreateTask(payload);
                    if (!created) return;
                    drawerItemId = created.id;
                    drawerMode = "edit";
                    openDrawerForEdit(drawerItemType, created.id);
                    return;
                } else {
                    const ok = await optimisticUpdateTask(drawerItemId, payload);
                    if (!ok) { setDrawerMessage("Couldn't save your changes. They were reverted — please try again.", "error"); return; }
                }
            }
            closeDrawer();
            setPageMessage("Saved.", "success");
        } catch (err) {
            // Belt-and-suspenders: optimisticCreate*/optimisticUpdate* already
            // catch and surface real Supabase errors via setDrawerMessage, so
            // this only fires for a genuine bug in this function itself (a
            // null/undefined property read, etc.) — those used to fail as an
            // unhandled promise rejection with zero on-screen feedback, which
            // is exactly what "the Save button doesn't do anything" looks
            // like from the outside. Now it at least tells the user something
            // broke instead of leaving them to click Save into the void.
            console.error("Unexpected error saving from the schedule drawer:", err);
            setDrawerMessage("Something went wrong saving this. Please try again.", "error");
        } finally {
            saveBtn.disabled = false;
        }
    }

    // Typing the phase/task's own name to confirm (same pattern used for
    // project deletion) -- cheap insurance against a one-click delete
    // landing on the wrong item, which is otherwise unrecoverable.
    function schedDeleteConfirmNameMatches() {
        const expected = (pendingDeleteTarget && pendingDeleteTarget.name) || "";
        const typed = document.getElementById("schedDeleteConfirmNameInput").value;
        return expected.length > 0 && typed.trim() === expected;
    }

    function schedDeleteConfirmReady() {
        return schedDeleteConfirmNameMatches()
            && document.getElementById("schedDeleteConfirmUnderstandCheckbox").checked;
    }

    function updateSchedDeleteConfirmBtnState() {
        document.getElementById("schedConfirmDeleteBtn").disabled = !schedDeleteConfirmReady();
    }

    function openDeleteConfirm(kind, id) {
        const name = kind === "phase" ? (phasesById.get(id) || {}).name : (tasksById.get(id) || {}).name;
        pendingDeleteTarget = { kind, id, name: name || "" };
        document.getElementById("schedDeleteConfirmName").textContent = name || (kind === "phase" ? "this phase" : "this item");
        document.getElementById("schedDeleteConfirmText").textContent = kind === "phase"
            ? "Phases with tasks in them can't be deleted — move or delete those tasks first."
            : "This can't be undone. Any dependencies involving it are removed too.";
        document.getElementById("schedDeleteConfirmMessage").textContent = "";
        const input = document.getElementById("schedDeleteConfirmNameInput");
        input.value = "";
        document.getElementById("schedDeleteConfirmUnderstandCheckbox").checked = false;
        document.getElementById("schedDeleteConfirmOverlay").classList.remove("hidden");
        updateSchedDeleteConfirmBtnState();
        input.focus();
    }

    async function handleConfirmDelete() {
        if (!pendingDeleteTarget) return;
        if (!schedDeleteConfirmReady()) return;
        const { kind, id } = pendingDeleteTarget;
        const btn = document.getElementById("schedConfirmDeleteBtn");
        btn.disabled = true;
        const ok = kind === "phase" ? await optimisticDeletePhase(id) : await optimisticDeleteTask(id);
        btn.disabled = false;
        document.getElementById("schedDeleteConfirmOverlay").classList.add("hidden");
        pendingDeleteTarget = null;
        if (ok) closeDrawer();
    }

    /* ============================================================
       EVENT WIRING
       ============================================================ */

    function wireStaticEvents() {
        // Tracks whether a Gantt bar drag/resize gesture is actively in
        // progress, so debouncedGanttDateChange (above) knows it must not
        // flush (and trigger a chart-rebuilding re-render) until the mouse
        // button is actually released. Bound on the chart's container
        // (not the SVG itself, since renderGanttChart() replaces the SVG
        // element wholesale on every re-render -- a listener bound directly
        // to it would be lost the first time that happens) with capture so
        // it still sees the mousedown even if it lands on a bar/handle deep
        // inside the SVG. mouseup is bound on document, matching Frappe's
        // own approach, since the pointer can end up outside the chart by
        // the time the button is released.
        const ganttChartEl = document.getElementById("schedGanttChart");
        if (ganttChartEl) {
            ganttChartEl.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (e.target.closest(".bar-wrapper, .handle")) ganttDragMouseDown = true;
            }, true);
        }
        document.addEventListener("mouseup", () => {
            if (!ganttDragMouseDown) return;
            ganttDragMouseDown = false;
            flushPendingGanttDateChange();
        });

        document.getElementById("schedAddTaskBtn").addEventListener("click", () => openDrawerForCreate("task"));
        document.getElementById("schedAddMilestoneBtn").addEventListener("click", () => openDrawerForCreate("milestone"));
        document.getElementById("schedAddPhaseBtn").addEventListener("click", () => openDrawerForCreate("phase"));

        document.querySelectorAll("#schedTypeToggle .timeline-type-toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => setDrawerType(btn.dataset.type));
        });

        document.getElementById("schedItemForm").addEventListener("submit", handleDrawerSave);
        document.getElementById("schedCancelItemBtn").addEventListener("click", closeDrawer);
        document.getElementById("schedCloseDrawerBtn").addEventListener("click", closeDrawer);
        document.getElementById("schedDeleteItemBtn").addEventListener("click", () => openDeleteConfirm(drawerItemType === "phase" ? "phase" : "task", drawerItemId));
        document.getElementById("schedCancelDeleteBtn").addEventListener("click", () => { document.getElementById("schedDeleteConfirmOverlay").classList.add("hidden"); pendingDeleteTarget = null; });
        document.getElementById("schedConfirmDeleteBtn").addEventListener("click", handleConfirmDelete);
        document.getElementById("schedDeleteConfirmNameInput")?.addEventListener("input", updateSchedDeleteConfirmBtnState);
        document.getElementById("schedDeleteConfirmUnderstandCheckbox")?.addEventListener("change", updateSchedDeleteConfirmBtnState);

        document.getElementById("schedProgressInput").addEventListener("input", (e) => {
            document.getElementById("schedProgressValue").textContent = e.target.value + "%";
        });

        document.getElementById("schedDependencyAddBtn").addEventListener("click", async () => {
            const predId = document.getElementById("schedDependencyTaskSelect").value;
            if (!predId || !drawerItemId) return;
            const payload = {
                project_id: currentProject.id,
                predecessor_task_id: predId,
                successor_task_id: drawerItemId,
                dependency_type: document.getElementById("schedDependencyTypeSelect").value,
                lag_days: Number(document.getElementById("schedDependencyLagInput").value) || 0
            };
            const created = await optimisticAddDependency(payload);
            if (created) renderDependenciesSection(tasksById.get(drawerItemId));
        });

        // Phase category tabs
        document.querySelectorAll("#schedPhaseTabs .sched-phase-tab").forEach(btn => {
            btn.addEventListener("click", () => { filters.phaseType = btn.dataset.phaseType; renderAll(); });
        });

        // Search (debounced)
        document.getElementById("schedSearchInput").addEventListener("input", debounce((e) => {
            filters.search = e.target.value.trim();
            renderAll();
        }, 200));

        // Filters panel
        document.getElementById("schedFiltersBtn").addEventListener("click", () => {
            const panel = document.getElementById("schedFiltersPanel");
            const btn = document.getElementById("schedFiltersBtn");
            const open = panel.classList.toggle("hidden") === false;
            btn.setAttribute("aria-expanded", String(open));
        });
        document.getElementById("schedFilterCritical").addEventListener("change", (e) => { filters.criticalOnly = e.target.checked; renderAll(); });
        document.getElementById("schedFilterAssignee").addEventListener("change", (e) => {
            filters.assignee = new Set(Array.from(e.target.selectedOptions).map(o => o.value));
            renderAll();
        });
        document.getElementById("schedFilterContractor").addEventListener("change", (e) => {
            filters.contractor = new Set(Array.from(e.target.selectedOptions).map(o => o.value));
            renderAll();
        });
        document.getElementById("schedFilterDateFrom").addEventListener("change", (e) => { filters.dateFrom = e.target.value; renderAll(); });
        document.getElementById("schedFilterDateTo").addEventListener("change", (e) => { filters.dateTo = e.target.value; renderAll(); });
        document.getElementById("schedFiltersClearBtn").addEventListener("click", () => {
            filters.status.clear(); filters.priority.clear(); filters.criticalOnly = false;
            filters.assignee.clear(); filters.contractor.clear(); filters.dateFrom = ""; filters.dateTo = "";
            document.getElementById("schedFilterCritical").checked = false;
            document.getElementById("schedFilterDateFrom").value = ""; document.getElementById("schedFilterDateTo").value = "";
            document.querySelectorAll(".sched-filter-chip.is-active").forEach(c => c.classList.remove("is-active"));
            document.querySelectorAll("#schedFilterAssignee option, #schedFilterContractor option").forEach(o => o.selected = false);
            renderAll();
        });
        document.getElementById("schedFiltersPanel").addEventListener("click", (e) => {
            const chip = e.target.closest(".sched-filter-chip");
            if (!chip) return;
            const group = chip.parentElement.dataset.filter;
            const set = group === "status" ? filters.status : filters.priority;
            const val = chip.dataset.value;
            chip.classList.toggle("is-active");
            if (set.has(val)) set.delete(val); else set.add(val);
            renderAll();
        });

        // Sort
        document.querySelectorAll(".stl-sort-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const field = btn.dataset.sort;
                if (sortField === field) {
                    if (sortDir === "asc") sortDir = "desc";
                    else { sortField = null; sortDir = "asc"; }
                } else { sortField = field; sortDir = "asc"; }
                document.querySelectorAll(".stl-sort-caret").forEach(c => c.textContent = "");
                if (sortField) {
                    const caret = document.querySelector(`.stl-sort-caret[data-sort-caret="${sortField}"]`);
                    if (caret) caret.textContent = sortDir === "asc" ? " ▲" : " ▼";
                }
                renderAll();
            });
        });

        // Zoom
        document.querySelectorAll("#schedZoomToggle .sched-zoom-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                currentViewMode = btn.dataset.viewMode;
                document.querySelectorAll("#schedZoomToggle .sched-zoom-btn").forEach(b => b.classList.toggle("is-active", b === btn));
                if (gantt) gantt.change_view_mode(currentViewMode, false);
                else renderAll();
            });
        });

        // Today
        document.getElementById("schedTodayBtn").addEventListener("click", () => {
            if (gantt && typeof gantt.scroll_current === "function") gantt.scroll_current();
        });

        // Schedule health popover
        document.getElementById("schedHealthBadge").addEventListener("click", showHealthDetail);
        document.getElementById("schedHealthDetailCloseBtn").addEventListener("click", () => document.getElementById("schedHealthDetailOverlay").classList.add("hidden"));
    }

    /* ============================================================
       LOCK / UPDATE PLAN (2026-11-16)
       First click "Lock plan" saves every task's current dates as the
       plan; after that the button reads "Update plan" — that's how an
       accepted delay becomes the new plan. Uses the lock_project_plan()
       function from sql/supabase-project-overview-plan.sql.
       ============================================================ */

    function formatPlanDate(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function renderPlanLock() {
        const btn = document.getElementById("schedLockPlanBtn");
        const note = document.getElementById("schedPlanNote");
        if (!btn || !currentProject) return;
        const locked = Boolean(currentProject.plan_locked_at);
        btn.style.display = "inline-flex";
        btn.textContent = locked ? "Update plan" : "Lock plan";
        if (note) {
            note.textContent = locked
                ? `Plan locked ${formatPlanDate(currentProject.plan_locked_at)}${currentProject.plan_locked_by_name ? " by " + currentProject.plan_locked_by_name : ""}`
                : "Plan not locked yet";
        }
    }

    function openLockPlanConfirm() {
        const locked = Boolean(currentProject && currentProject.plan_locked_at);
        document.getElementById("schedLockPlanTitle").textContent = locked ? "Make the current dates the new plan?" : "Lock the plan?";
        document.getElementById("schedLockPlanText").textContent = locked
            ? "Use this when a delay has been accepted. Every task's current dates replace the old plan, and \"days behind\" on the Overview starts counting from here."
            : "Every task's current dates become the plan. From now on the Overview shows how far ahead or behind the project is compared to this plan, even when tasks get pushed.";
        const confirmBtn = document.getElementById("schedLockPlanConfirmBtn");
        confirmBtn.textContent = locked ? "Update plan" : "Lock plan";
        confirmBtn.disabled = false;
        document.getElementById("schedLockPlanMessage").textContent = "";
        document.getElementById("schedLockPlanOverlay").classList.remove("hidden");
    }

    function closeLockPlanConfirm() {
        document.getElementById("schedLockPlanOverlay").classList.add("hidden");
    }

    async function confirmLockPlan() {
        if (!currentProject || !currentProject.id) return;
        const confirmBtn = document.getElementById("schedLockPlanConfirmBtn");
        const msg = document.getElementById("schedLockPlanMessage");
        confirmBtn.disabled = true;
        msg.textContent = "Saving…";
        const byName = getStaffName();
        const { error } = await window.supabaseClient.rpc("lock_project_plan", {
            p_project_id: currentProject.id,
            p_by_name: byName
        });
        if (error) {
            console.error("lock_project_plan failed:", error);
            msg.textContent = "Couldn't save the plan. Has sql/supabase-project-overview-plan.sql been run?";
            confirmBtn.disabled = false;
            return;
        }
        // Mirror what the database just did so the page doesn't need a reload.
        tasks = tasks.map(t => ({ ...t, plan_start_date: t.start_date ?? null, plan_end_date: t.end_date ?? null }));
        tasksById = new Map(tasks.map(t => [t.id, t]));
        currentProject.plan_locked_at = new Date().toISOString();
        currentProject.plan_locked_by_name = byName;
        closeLockPlanConfirm();
        renderAll();
        renderPlanLock();
        setPageMessage("Plan saved. The Overview now tracks days behind against it.", "success");
    }

    function wirePlanLock() {
        const btn = document.getElementById("schedLockPlanBtn");
        if (!btn) return;
        btn.addEventListener("click", openLockPlanConfirm);
        document.getElementById("schedLockPlanCancelBtn").addEventListener("click", closeLockPlanConfirm);
        document.getElementById("schedLockPlanConfirmBtn").addEventListener("click", confirmLockPlan);
    }

    /* ============================================================
       BOOTSTRAP
       ============================================================ */

    async function handleProjectReady(evt) {
        const project = evt.detail && evt.detail.project;
        const loadingEl = document.getElementById("timelineLoadingState");
        if (!project) {
            if (loadingEl) loadingEl.innerHTML = "<p>Couldn't load this project.</p>";
            return;
        }
        currentProject = project;

        const ok = await loadAll(project.id);
        if (loadingEl) loadingEl.style.display = "none";
        const toolbar = document.getElementById("schedToolbar");
        if (toolbar) toolbar.style.display = "flex";
        if (!ok) return;

        renderAll();
        renderPlanLock();
    }

    document.addEventListener("DOMContentLoaded", () => {
        wireStaticEvents();
        wirePlanLock();
        window.addEventListener("project-shell:ready", handleProjectReady);
    });

})();
