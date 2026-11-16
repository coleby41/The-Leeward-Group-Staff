/* ===========================================================
   PROJECT METRICS (2026-11-16)

   One place that turns live data into the numbers the Overview page
   (pages/projects.html) and the project list cards (project-home.html)
   show — so the two never disagree. Nothing here is hand-typed: every
   number comes from the timeline, invoices, VPOs, bids or vendor records.

   window.ProjectMetrics
     .schedule(project, tasks, today?)       → % done, plan %, days behind, finish…
     .phases(phases, tasks)                   → per-phase dates + progress
     .money(project, invoices, vpos)          → contract (+VPOs), paid, unpaid, left
     .upcoming(tasks, bidPackages, days?)     → next N days of tasks/milestones/bid due dates
     .loadOverview(project)                   → everything the Overview needs, in one call
     .loadScheduleForProjects(projects)       → Map(projectId → schedule()) for list cards

   "Days behind" compares the timeline's current finish with the finish
   saved by Lock plan / Update plan on the Timeline page
   (schedule_tasks.plan_end_date, sql/supabase-project-overview-plan.sql).
   No plan locked yet → hasPlan = false and daysBehind = null.
=========================================================== */
(function () {
    "use strict";

    const DAY = 86400000;

    /* ---------- dates (all plain YYYY-MM-DD, compared as UTC days) ---------- */

    function todayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    function dayNum(iso) { return iso ? Math.round(Date.parse(iso + "T00:00:00Z") / DAY) : null; }
    function addDays(iso, n) {
        const d = new Date(iso + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    function maxISO(list) { const v = list.filter(Boolean).sort(); return v.length ? v[v.length - 1] : null; }
    function minISO(list) { const v = list.filter(Boolean).sort(); return v.length ? v[0] : null; }

    /* ---------- schedule ---------- */

    // Only "leaf" tasks count toward progress — a parent task and its
    // subtasks would otherwise be counted twice.
    function leafTasks(tasks) {
        const parents = new Set(tasks.map(t => t.parent_task_id).filter(Boolean));
        return tasks.filter(t => t.item_type !== "milestone" && !parents.has(t.id) && t.end_date);
    }

    function duration(start, end) {
        const s = dayNum(start || end), e = dayNum(end);
        return Math.max(1, e - s + 1);
    }

    function taskProgress(t) {
        if (t.status === "complete") return 100;
        return Math.max(0, Math.min(100, Number(t.progress_percent) || 0));
    }

    function schedule(project, tasks, today) {
        today = today || todayISO();
        const all = (tasks || []).filter(t => t.end_date);
        const leaves = leafTasks(all);

        // % done — weighted by task length
        let w = 0, done = 0;
        leaves.forEach(t => { const d = duration(t.start_date, t.end_date); w += d; done += d * taskProgress(t); });
        const percentDone = w ? Math.round(done / w) : 0;

        // Plan % by today — how much of each task's plan window has passed
        // (falls back to the current dates when no plan is locked)
        const t0 = dayNum(today);
        let pw = 0, pdone = 0;
        leaves.forEach(t => {
            const s = t.plan_start_date || t.start_date || t.plan_end_date || t.end_date;
            const e = t.plan_end_date || t.end_date;
            const d = duration(s, e);
            const elapsed = Math.max(0, Math.min(d, t0 - dayNum(s) + 1));
            pw += d; pdone += elapsed;
        });
        const planPercent = pw ? Math.round((pdone / pw) * 100) : 0;

        const finishDate = maxISO(all.map(t => t.end_date));
        const planFinish = maxISO(all.map(t => t.plan_end_date));
        const hasPlan = Boolean(project && project.plan_locked_at && planFinish);
        const daysBehind = hasPlan && finishDate ? dayNum(finishDate) - dayNum(planFinish) : null;
        const daysLeft = finishDate ? dayNum(finishDate) - t0 : null;

        const open = all.filter(t => t.status !== "complete");
        const overdue = open.filter(t => t.end_date < today);

        return {
            percentDone,
            planPercent,
            hasPlan,
            daysBehind,           // >0 behind, <0 ahead, 0 on plan, null = no plan locked
            finishDate,
            planFinish,
            daysLeft,
            startDate: minISO(all.map(t => t.start_date || t.end_date)),
            openCount: open.filter(t => t.item_type !== "milestone").length,
            overdue,              // incomplete tasks/milestones past their end date
            doneCount: all.filter(t => t.status === "complete" && t.item_type !== "milestone").length,
            milestonesLeft: open.filter(t => t.item_type === "milestone").length,
            hasTasks: all.length > 0
        };
    }

    function phases(phaseRows, tasks) {
        return (phaseRows || []).map(p => {
            const mine = (tasks || []).filter(t => t.phase_id === p.id && t.end_date);
            const leaves = leafTasks(mine);
            let w = 0, done = 0;
            leaves.forEach(t => { const d = duration(t.start_date, t.end_date); w += d; done += d * taskProgress(t); });
            const total = mine.filter(t => t.item_type !== "milestone").length;
            const complete = mine.filter(t => t.item_type !== "milestone" && t.status === "complete").length;
            return {
                id: p.id,
                name: p.name,
                start: minISO(mine.map(t => t.start_date || t.end_date)),
                end: maxISO(mine.map(t => t.end_date)),
                percent: w ? Math.round(done / w) : 0,
                total,
                complete
            };
        });
    }

    /* ---------- money ---------- */

    function money(project, invoices, vpos, today) {
        today = today || todayISO();
        const original = Number(project && project.contract_value) || 0;
        const vpoList = (vpos || []).filter(v => v.price != null);
        const vpoTotal = vpoList.reduce((s, v) => s + (Number(v.price) || 0), 0);
        const contract = original + vpoTotal;
        const inv = invoices || [];
        const spent = inv.reduce((s, i) => s + (Number(i.total_due) || 0), 0);
        const paid = inv.filter(i => i.paid).reduce((s, i) => s + (Number(i.total_due) || 0), 0);
        const unpaidList = inv.filter(i => !i.paid);
        const cutoff = addDays(today, -30);
        const unpaid30 = unpaidList.filter(i => (i.invoice_date || (i.created_at || "").slice(0, 10)) < cutoff);
        return {
            original,
            vpoTotal,
            vpoCount: vpoList.length,
            contract,
            spent,
            paid,
            unpaid: spent - paid,
            left: Math.max(0, contract - spent),
            spentPercent: contract ? Math.round((spent / contract) * 100) : null,
            unpaid30,
            unpaid30Total: unpaid30.reduce((s, i) => s + (Number(i.total_due) || 0), 0),
            invoiceCount: inv.length
        };
    }

    /* ---------- coming up ---------- */

    function upcoming(tasks, bidPackages, days, today) {
        today = today || todayISO();
        const until = addDays(today, days || 14);
        const items = [];
        (tasks || []).forEach(t => {
            if (t.status === "complete" || !t.end_date) return;
            const isMilestone = t.item_type === "milestone";
            if (t.end_date < today) {
                items.push({ date: t.end_date, name: t.name, kind: "late", note: `${dayNum(today) - dayNum(t.end_date)} days late` });
            } else if (t.status === "in_progress" && t.end_date <= until) {
                items.push({ date: t.end_date, name: t.name, kind: "progress", note: "In progress" });
            } else if (isMilestone && t.end_date <= until) {
                items.push({ date: t.end_date, name: t.name, kind: "milestone", note: "Milestone" });
            } else if (!isMilestone && t.start_date && t.start_date >= today && t.start_date <= until) {
                items.push({ date: t.start_date, name: t.name, kind: "starts", note: "Starts" });
            }
        });
        (bidPackages || []).forEach(p => {
            if (p.status !== "open" || !p.due_at) return;
            const d = p.due_at.slice(0, 10);
            if (d >= today && d <= until) items.push({ date: d, name: `${p.name} bids due`, kind: "bid", note: "Bids due" });
        });
        return items.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    }

    /* ---------- loading ---------- */

    // A missing table (feature not set up yet) or a failed query returns []
    // so one broken section never blanks the whole page.
    async function safe(query, label) {
        try {
            const { data, error } = await query;
            if (error) { console.warn(`[project-metrics] ${label}:`, error.message || error); return []; }
            return data || [];
        } catch (e) {
            console.warn(`[project-metrics] ${label}:`, e);
            return [];
        }
    }

    async function loadOverview(project) {
        const sb = window.supabaseClient;
        const id = project.id;
        const today = todayISO();

        const [phaseRows, tasks, invoices, vpos, packages, assignments, contracts, photos, voice, files] = await Promise.all([
            safe(sb.from("schedule_phases").select("id, name, sort_order").eq("project_id", id).order("sort_order"), "phases"),
            safe(sb.from("schedule_tasks").select("id, phase_id, parent_task_id, item_type, name, start_date, end_date, plan_start_date, plan_end_date, status, progress_percent, updated_at, updated_by_name").eq("project_id", id), "tasks"),
            safe(sb.from("project_invoices").select("id, vendor_name, invoice_number, total_due, invoice_date, paid, created_at, created_by_name").eq("project_id", id), "invoices"),
            safe(sb.from("vpos").select("id, vpo_number, price, vendor_name, created_at, created_by_name").eq("project_id", id), "vpos"),
            safe(sb.from("bid_packages").select("id, name, status, due_at, awarded_invite_id").eq("project_id", id), "bid packages"),
            safe(sb.from("vendor_project_assignments").select("company_id, hidden").eq("project_id", id), "vendor assignments"),
            safe(sb.from("project_vendor_contracts").select("company_id, file_id, signed_file_id, not_needed").eq("project_id", id), "contracts"),
            safe(sb.from("project_files").select("id, file_name, storage_path, bucket, created_at").eq("project_id", id).eq("category", "marketing").eq("subfolder", "photography").order("created_at", { ascending: false }).limit(3), "photos"),
            safe(sb.from("timeline_voice_log").select("command, created_at, staff_user_id, undone").eq("project_id", id).order("created_at", { ascending: false }).limit(8), "voice log"),
            safe(sb.from("project_files").select("file_name, category, created_at, uploaded_by_name").eq("project_id", id).order("created_at", { ascending: false }).limit(8), "files")
        ]);

        // Bid invites for this project's packages
        const packageIds = packages.map(p => p.id);
        const invites = packageIds.length
            ? await safe(sb.from("bid_invites").select("id, package_id, company_id, company_name, status, sent_at, responded_at").in("package_id", packageIds), "bid invites")
            : [];

        // Vendor names + COI dates for vendors tied to the project
        const companyIds = [...new Set([
            ...assignments.filter(a => !a.hidden).map(a => a.company_id),
            ...invites.filter(i => packages.some(p => p.awarded_invite_id === i.id)).map(i => i.company_id)
        ].filter(Boolean))];
        const companies = companyIds.length
            ? await safe(sb.from("Companies").select("id, Name, COIExpiresOn").in("id", companyIds), "companies")
            : [];

        // Latest draw, once the Draws feature exists (table missing → [])
        const draws = await safe(sb.from("draws").select("draw_number, status, period_to").eq("project_id", id).eq("is_opening_balance", false).order("draw_number", { ascending: false }).limit(1), "draws");

        const sched = schedule(project, tasks, today);
        const cash = money(project, invoices, vpos, today);
        const attention = buildAttention({ sched, cash, packages, invites, assignments, contracts, companies, today });

        return {
            schedule: sched,
            phases: phases(phaseRows, tasks),
            money: cash,
            upcoming: upcoming(tasks, packages, 14, today),
            attention,
            bids: {
                open: packages.filter(p => p.status === "open"),
                invited: invites.filter(i => packages.some(p => p.id === i.package_id && p.status === "open")).length,
                replied: invites.filter(i => i.responded_at && packages.some(p => p.id === i.package_id && p.status === "open")).length,
                nextDue: minISO(packages.filter(p => p.status === "open" && p.due_at).map(p => p.due_at.slice(0, 10)))
            },
            latestDraw: draws[0] || null,
            photos,
            activity: buildActivity({ tasks, invoices, vpos, voice, files, invites })
        };
    }

    function fmtMoney(n) {
        return (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    }

    function buildAttention({ sched, cash, packages, invites, assignments, contracts, companies, today }) {
        const items = [];
        const byId = new Map(companies.map(c => [c.id, c]));

        if (sched.overdue.length) {
            const names = sched.overdue.slice(0, 2).map(t => t.name).join(", ");
            const more = sched.overdue.length > 2 ? `, +${sched.overdue.length - 2}` : "";
            items.push({ level: "red", title: `${sched.overdue.length} overdue task${sched.overdue.length === 1 ? "" : "s"}`, meta: names + more, href: "/pages/project-timeline.html" });
        }

        if (cash.unpaid30.length) {
            const top = [...cash.unpaid30].sort((a, b) => (Number(b.total_due) || 0) - (Number(a.total_due) || 0))[0];
            items.push({ level: "orange", title: `${cash.unpaid30.length} invoice${cash.unpaid30.length === 1 ? "" : "s"} unpaid 30+ days`, meta: `${fmtMoney(cash.unpaid30Total)} · oldest from ${top.vendor_name}`, href: "/pages/project-accounting.html" });
        }

        // COIs expired or expiring in the next 30 days
        const soon = addDays(today, 30);
        assignments.filter(a => !a.hidden).forEach(a => {
            const c = byId.get(a.company_id);
            const exp = c && c.COIExpiresOn;
            if (!exp || exp > soon) return;
            items.push({
                level: "orange",
                title: exp < today ? `${c.Name} COI expired` : `${c.Name} COI expires ${new Date(exp + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
                meta: "Vendor paperwork",
                href: "/pages/project-accounts.html"
            });
        });

        // Awarded vendors with no contract on file
        const contractByCompany = new Map(contracts.map(c => [c.company_id, c]));
        const missing = packages
            .filter(p => p.awarded_invite_id)
            .map(p => invites.find(i => i.id === p.awarded_invite_id))
            .filter(i => i && i.company_id)
            .filter(i => { const c = contractByCompany.get(i.company_id); return !c || (!c.file_id && !c.signed_file_id && !c.not_needed); });
        if (missing.length) {
            items.push({ level: "blue", title: `No contract on file for ${missing.length} awarded vendor${missing.length === 1 ? "" : "s"}`, meta: missing.slice(0, 2).map(i => i.company_name).join(", "), href: "/pages/project-accounts.html" });
        }

        // Bids due within 7 days with vendors who haven't replied
        const week = addDays(today, 7);
        packages.filter(p => p.status === "open" && p.due_at && p.due_at.slice(0, 10) >= today && p.due_at.slice(0, 10) <= week).forEach(p => {
            const waiting = invites.filter(i => i.package_id === p.id && !i.responded_at).length;
            if (!waiting) return;
            const days = dayNum(p.due_at.slice(0, 10)) - dayNum(today);
            items.push({ level: "blue", title: `${p.name} bids due ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`, meta: `${waiting} vendor${waiting === 1 ? " hasn't" : "s haven't"} replied`, href: "/pages/project-bid-invites.html" });
        });

        return items;
    }

    function buildActivity({ tasks, invoices, vpos, voice, files, invites }) {
        const rows = [];
        voice.forEach(v => rows.push({ at: v.created_at, text: `${v.command} (Siri)${v.undone ? " — undone" : ""}`, who: "" }));
        invoices.forEach(i => rows.push({ at: i.created_at, text: `Added invoice ${i.invoice_number ? "#" + i.invoice_number + " · " : ""}${i.vendor_name} · ${fmtMoney(i.total_due)}`, who: i.created_by_name || "" }));
        vpos.forEach(v => rows.push({ at: v.created_at, text: `Filed ${v.vpo_number || "a VPO"}${v.price != null ? " · " + fmtMoney(v.price) : ""}`, who: v.created_by_name || "" }));
        files.filter(f => f.category !== "marketing").forEach(f => rows.push({ at: f.created_at, text: `Uploaded ${f.file_name}`, who: f.uploaded_by_name || "" }));
        // One row per batch of bid invites sent the same day
        const sentDays = new Map();
        invites.filter(i => i.sent_at).forEach(i => { const k = i.sent_at.slice(0, 10) + i.package_id; sentDays.set(k, { at: i.sent_at, n: (sentDays.get(k)?.n || 0) + 1 }); });
        sentDays.forEach(v => rows.push({ at: v.at, text: `Sent ${v.n} bid invite${v.n === 1 ? "" : "s"}`, who: "" }));
        tasks.filter(t => t.updated_at && t.updated_by_name).forEach(t => rows.push({ at: t.updated_at, text: `Updated ${t.name}`, who: t.updated_by_name }));
        return rows.filter(r => r.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
    }

    // Project list cards: one query for every project's tasks.
    async function loadScheduleForProjects(projects) {
        const out = new Map();
        const ids = (projects || []).map(p => p.id);
        if (!ids.length || !window.supabaseClient) return out;
        const rows = await safe(window.supabaseClient.from("schedule_tasks")
            .select("project_id, parent_task_id, id, item_type, start_date, end_date, plan_start_date, plan_end_date, status, progress_percent")
            .in("project_id", ids), "list tasks");
        const byProject = new Map();
        rows.forEach(r => { if (!byProject.has(r.project_id)) byProject.set(r.project_id, []); byProject.get(r.project_id).push(r); });
        const today = todayISO();
        projects.forEach(p => out.set(p.id, schedule(p, byProject.get(p.id) || [], today)));
        return out;
    }

    window.ProjectMetrics = { schedule, phases, money, upcoming, loadOverview, loadScheduleForProjects, todayISO, dayNum, addDays };
})();
