/* ===========================================================
   PROJECT CHECKLIST (pages/projects.html, the project Overview) — 2026-11-27

   What the Leeward team needs to do on a job, in order, with Theo on top.
   Every step checks itself off from what's already in the portal; nobody
   ticks anything by hand. Goes away once the project is Archived.

     Setup & bidding
       1  Finish project setup        code, address and owner entity
       2  Set up the buildings        bid_areas
       3  Post the COI template       project_coi_templates
       4  Send bid invites            any bid package sent
       5  Award every cost code       every code still showing on Bids is on
                                      an awarded package (hidden codes skip)
     Vendor paperwork
       6  Clear every vendor for site contract signed, W-9, COI (same rule as
                                      Accounts / Contacts › Cleared for Site)
     Schedule & budget
       7  Build the timeline          schedule_tasks
       8  Lock the plan               projects.plan_locked_at
       9  Import the budget           budget_lines

   A table that isn't set up yet just leaves its step unchecked. Waits for
   project-shell.js's "project-shell:ready" event. Theo: js/help-buddies.js.
=========================================================== */
(function () {
    "use strict";

    const $ = id => document.getElementById(id);
    const db = () => window.supabaseClient;
    const esc = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; };

    async function safe(p) { try { const r = await p; return r && !r.error ? r.data : null; } catch (e) { return null; } }
    const isPast = d => d && new Date(`${String(d).slice(0, 10)}T23:59:59`) < new Date();

    async function facts(project) {
        const id = project.id;
        const [full, areas, coi, pkgs, codes, hidden, tasks, budget, vendors, contracts] = await Promise.all([
            safe(db().from("projects").select("*").eq("id", id).maybeSingle()),
            safe(db().from("bid_areas").select("id, enabled").eq("project_id", id)),
            safe(db().from("project_coi_templates").select("project_id").eq("project_id", id)),
            safe(db().from("bid_packages").select("status, cost_codes").eq("project_id", id)),
            safe(db().from("bid_cost_codes").select("code").eq("active", true)),
            safe(db().from("bid_project_hidden_codes").select("cost_code").eq("project_id", id)),
            safe(db().from("schedule_tasks").select("id").eq("project_id", id).limit(1)),
            safe(db().from("budget_lines").select("id").eq("project_id", id).limit(1)),
            safe(db().rpc("project_vendors", { p_project_id: id })),
            safe(db().from("project_vendor_contracts").select("company_id, signed_file_id, countersigned_file_id, not_needed").eq("project_id", id)),
        ]);
        const p = { ...project, ...(full || {}) };

        const sentPkgs = (pkgs || []).filter(x => x.status && x.status !== "draft");
        const hide = new Set((hidden || []).map(r => r.cost_code));
        const visible = (codes || []).map(c => c.code).filter(c => !hide.has(c));
        const awarded = new Set();
        (pkgs || []).forEach(x => { if (x.status === "awarded") (x.cost_codes || []).forEach(c => awarded.add(c)); });
        const codesLeft = visible.filter(c => !awarded.has(c)).length;

        // Cleared for Site, for every vendor actually working the job.
        let exempt = new Set();
        const working = (vendors || []).filter(v => (v.sources || []).some(s => s === "awarded" || s === "assigned"));
        if (working.length) {
            const ex = await safe(db().from("Companies").select("id, ContractExempt").in("id", working.map(v => v.company_id)));
            exempt = new Set((ex || []).filter(r => r.ContractExempt).map(r => String(r.id)));
        }
        const notCleared = working.filter(v => {
            const c = (contracts || []).find(x => String(x.company_id) === String(v.company_id));
            const contractOk = c && (c.signed_file_id || c.countersigned_file_id || c.not_needed) || exempt.has(String(v.company_id));
            const w9Ok = v.w9_file_path || v.w9_exempt;
            const coiOk = v.coi_exempt || (v.coi_file_id && !isPast(v.coi_expires_on));
            return !(contractOk && w9Ok && coiOk);
        });

        return {
            p,
            setupMissing: [["project code", p.project_code], ["address", p.site_address], ["owner entity", p.owner_entity]].filter(([, v]) => !v || !String(v).trim()).map(([k]) => k),
            hasAreas: (areas || []).some(a => a.enabled !== false),
            hasCoi: (coi || []).length > 0,
            sent: sentPkgs.length,
            codesTotal: visible.length, codesLeft, bidsReady: codes !== null,
            working: working.length, notCleared: notCleared.length,
            hasTasks: (tasks || []).length > 0,
            planLocked: !!p.plan_locked_at,
            hasBudget: (budget || []).length > 0,
        };
    }

    function steps(f) {
        const q = `?id=${encodeURIComponent(f.p.id)}`;
        return [
            { group: "Setup & bidding", title: "Finish the project setup",
              done: !f.setupMissing.length,
              sub: f.setupMissing.length ? `Still needs: ${f.setupMissing.join(", ")}.` : "Code, address and owner are in.",
              go: `/pages/project-home.html?openWizard=${encodeURIComponent(f.p.id)}`, cta: "Edit project" },
            { group: "Setup & bidding", title: "Set up the buildings",
              done: f.hasAreas, sub: "Building types and how many, so vendors can price per building.",
              go: `/pages/project-bids.html${q}`, cta: "Go to Bids" },
            { group: "Setup & bidding", title: "Post the COI template",
              done: f.hasCoi, sub: "The insurance this job needs. Award emails can't go out without it.",
              go: `/pages/project-bids.html${q}`, cta: "Go to Bids" },
            { group: "Setup & bidding", title: "Send bid invites",
              done: f.sent > 0, sub: f.sent ? `${f.sent} bid package${f.sent === 1 ? "" : "s"} sent.` : "Check vendors on the Invite Sheet and Send all.",
              go: `/pages/project-bids.html${q}`, cta: "Open Invite Sheet" },
            { group: "Setup & bidding", title: "Award every cost code",
              done: f.bidsReady && f.codesTotal > 0 && f.codesLeft === 0,
              sub: f.codesTotal ? `${f.codesTotal - f.codesLeft} of ${f.codesTotal} cost codes awarded. Hide the ones this job doesn't need.` : "Award the winners on each bid package.",
              go: `/pages/project-bids.html${q}`, cta: "Go to Bids" },
            { group: "Vendor paperwork", title: "Clear every vendor for site",
              done: f.working > 0 && f.notCleared === 0,
              sub: f.working ? (f.notCleared ? `${f.notCleared} of ${f.working} vendors still need a contract, W-9 or COI.` : `All ${f.working} vendors have their contract, W-9 and COI.`) : "Once vendors are awarded, collect their contract, W-9 and COI.",
              go: `/pages/project-accounts.html${q}`, cta: "Accounts" },
            { group: "Schedule & budget", title: "Build the timeline",
              done: f.hasTasks, sub: "Phases, tasks and milestones for the job.",
              go: `/pages/project-timeline.html${q}`, cta: "Timeline" },
            { group: "Schedule & budget", title: "Lock the plan",
              done: f.planLocked, sub: "Locks today's dates as the plan, so you can see if the job is ahead or behind.",
              go: `/pages/project-timeline.html${q}`, cta: "Timeline" },
            { group: "Schedule & budget", title: "Import the budget",
              done: f.hasBudget, sub: "Bring in the AIA budget so invoices and draws have lines to land on.",
              go: `/pages/project-accounting.html${q}`, cta: "Accounting" },
        ];
    }

    function theoLine(list, f) {
        let me = window.currentSupabaseProfile;
        if (!me) { try { me = JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (e) { me = null; } }
        const first = String((me && (me.full_name || me.username)) || "").split(/\s+/)[0] || "there";
        const name = f.p.name || "this project";
        const done = list.filter(s => s.done).length;
        const next = list.find(s => !s.done);
        if (!next) return `Look at that, ${first}! Everything's done for ${name}. I'll keep an eye on things from here.`;
        if (done === 0) return `Hi ${first}! Here's what ${name} needs from the team. Let's start with: ${next.title.toLowerCase()}.`;
        if (done >= list.length - 2) return `So close, ${first}! ${done} of ${list.length} done on ${name}. Next up: ${next.title.toLowerCase()}.`;
        return `Nice work, ${first}. ${done} of ${list.length} done on ${name}. Next up: ${next.title.toLowerCase()}.`;
    }

    async function render(project) {
        const box = $("povChecklist");
        if (!box || !project || !db()) return;
        if ((project.status || "") === "archived") { box.hidden = true; return; }
        const f = await facts(project);
        if ((f.p.status || "") === "archived") { box.hidden = true; return; }
        const list = steps(f);
        const done = list.filter(s => s.done).length;
        const next = list.findIndex(s => !s.done);
        let lastGroup = null;
        const rows = list.map((s, i) => {
            const head = s.group !== lastGroup ? `<li class="pcl-group">${esc(s.group)}</li>` : "";
            lastGroup = s.group;
            const state = s.done ? "is-done" : i === next ? "is-next" : "";
            return `${head}<li class="pcl-step ${state}">
                <span class="pcl-check" aria-hidden="true">${s.done ? "✓" : i + 1}</span>
                <span class="pcl-text"><strong>${esc(s.title)}</strong><span>${esc(s.sub)}</span></span>
                ${s.done ? `<span class="pcl-done">Done</span>` : `<a class="pcl-go ${i === next ? "pcl-go--next" : ""}" href="${esc(s.go)}">${esc(s.cta)} ›</a>`}
            </li>`;
        }).join("");
        box.innerHTML = `
            <div class="pov-section-head"><h2>Team checklist</h2><span class="pcl-count">${done} of ${list.length} done</span></div>
            <div class="pcl-theo"><span class="hc-buddy pcl-buddy" data-buddy="${done === list.length ? "wave" : "clipboard"}" data-say="Hi, I'm Theo!"></span><p class="pcl-say">${esc(theoLine(list, f))}</p></div>
            <div class="pcl-bar" aria-hidden="true"><span style="width:${Math.round((done / list.length) * 100)}%"></span></div>
            <ol class="pcl-list">${rows}</ol>`;
        box.hidden = false;
        if (window.HelpBuddies) window.HelpBuddies.refresh();
    }

    window.addEventListener("project-shell:ready", e => {
        const project = e.detail && e.detail.project;
        if (project) render(project);
    });
})();
