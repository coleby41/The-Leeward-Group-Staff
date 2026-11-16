/* ===========================================================
   DRAWS — data + math (2026-11-16)

   The numbers behind Accounting › Draws / Budget, the draw PDF/Excel
   and the Overview's draw tile. No DOM here.

   Model (sql/supabase-draws-setup.sql):
     budget_sections → budget_lines (total_budget, equity_budget, retainage_pct)
     draws (#16, #17… plus one opening-balance draw for the workbook history)
     draw_lines (equity_this_period, loan_this_period, stored_materials)

   Same rules as the AIA workbook's continuation sheet:
     loan budget        = total − equity budget
     completed to date  = equity to date + loan to date   (cols E+F+J+K)
     stored             = materials presently stored (col L) on THIS draw
     retainage          = retainage % × completed & stored, per line
     this period splits = equity first until the line's equity budget is
                          used, then loan
   Summary (the Application for Payment page):
     4  completed & stored to date
     5  retainage
     6  earned less retainage           (4 − 5)
     7  less previous draws             (line 6 as of the previous draw)
     8  current payment due              (6 − 7)
     9  balance to finish incl. retainage (contract − 6)
=========================================================== */
(function () {
    "use strict";

    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const num = n => Number(n) || 0;

    function client() { return window.supabaseClient; }
    function profile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile")); } catch (e) { return null; }
    }
    function staffName() { const p = profile(); return (p && (p.full_name || p.username)) || "Staff"; }
    function staffId() { const p = profile(); return (p && p.id) || null; }

    /* ---------- access ---------- */

    async function access(projectId) {
        const none = { view: false, edit: false, submit: false, manage_budget: false, ready: false };
        try {
            const { data, error } = await client().rpc("draws_access", { p_project_id: projectId });
            if (error) { console.warn("[draws] draws_access:", error.message); return none; }
            return { ...none, ...(data || {}), ready: true };
        } catch (e) {
            return none;
        }
    }

    /* ---------- loading ---------- */

    async function load(projectId) {
        const [sec, lines, draws, invoices] = await Promise.all([
            client().from("budget_sections").select("*").eq("project_id", projectId).order("sort_order"),
            client().from("budget_lines").select("*").eq("project_id", projectId).order("sort_order"),
            client().from("draws").select("*").eq("project_id", projectId).order("draw_number"),
            client().from("project_invoices").select("id, vendor_name, invoice_number, total_due, invoice_date, created_at, paid, budget_line_id, draw_id, is_stored_material, project_file_id").eq("project_id", projectId)
        ]);
        for (const res of [sec, lines, draws]) if (res.error) throw res.error;
        const drawIds = (draws.data || []).map(d => d.id);
        let drawLines = [];
        if (drawIds.length) {
            const dl = await client().from("draw_lines").select("*").in("draw_id", drawIds);
            if (dl.error) throw dl.error;
            drawLines = dl.data || [];
        }
        return buildState({
            sections: sec.data || [],
            lines: lines.data || [],
            draws: draws.data || [],
            drawLines,
            invoices: invoices.error ? [] : (invoices.data || [])
        });
    }

    function buildState(raw) {
        const sectionsById = new Map(raw.sections.map(s => [s.id, s]));
        const top = s => { let cur = s; while (cur && cur.parent_id && sectionsById.get(cur.parent_id)) cur = sectionsById.get(cur.parent_id); return cur; };
        const lines = raw.lines.map(l => {
            const sec = sectionsById.get(l.section_id) || null;
            const group = sec ? top(sec) : null;
            return {
                ...l,
                total_budget: num(l.total_budget),
                equity_budget: num(l.equity_budget),
                retainage_pct: num(l.retainage_pct),
                loan_budget: r2(num(l.total_budget) - num(l.equity_budget)),
                groupId: group ? group.id : "none",
                groupName: group ? group.name : "Other",
                subName: sec && group && sec.id !== group.id ? sec.name : "",
                costType: (group || sec || {}).cost_type || "hard"
            };
        });
        const draws = [...raw.draws].sort((a, b) => a.draw_number - b.draw_number);
        const linesByDraw = new Map();
        raw.drawLines.forEach(dl => {
            if (!linesByDraw.has(dl.draw_id)) linesByDraw.set(dl.draw_id, new Map());
            linesByDraw.get(dl.draw_id).set(dl.budget_line_id, {
                ...dl,
                equity_this_period: num(dl.equity_this_period),
                loan_this_period: num(dl.loan_this_period),
                stored_materials: num(dl.stored_materials)
            });
        });
        // groups in sheet order
        const groups = [];
        const seen = new Map();
        lines.forEach(l => {
            if (!seen.has(l.groupId)) { const g = { id: l.groupId, name: l.groupName, costType: l.costType, lines: [] }; seen.set(l.groupId, g); groups.push(g); }
            seen.get(l.groupId).lines.push(l);
        });
        return { ...raw, sectionsById, lines, groups, draws, linesByDraw };
    }

    /* ---------- math ---------- */

    function drawIndex(state, drawId) { return state.draws.findIndex(d => d.id === drawId); }

    // Equity / loan through the END of the draw at index i (inclusive).
    function toDate(state, lineId, uptoIndex) {
        let equity = 0, loan = 0;
        for (let i = 0; i <= uptoIndex; i++) {
            const dl = state.linesByDraw.get(state.draws[i].id);
            const row = dl && dl.get(lineId);
            if (row) { equity += row.equity_this_period; loan += row.loan_this_period; }
        }
        return { equity: r2(equity), loan: r2(loan) };
    }

    // One continuation-sheet row for a line, as of draw `drawId`.
    function lineRow(state, line, drawId) {
        const i = drawIndex(state, drawId);
        const prev = i > 0 ? toDate(state, line.id, i - 1) : { equity: 0, loan: 0 };
        const cur = (state.linesByDraw.get(drawId) || new Map()).get(line.id) || { equity_this_period: 0, loan_this_period: 0, stored_materials: 0 };
        const previous = r2(prev.equity + prev.loan);
        const thisPeriod = r2(cur.equity_this_period + cur.loan_this_period);
        const stored = r2(cur.stored_materials);
        const completed = r2(previous + thisPeriod + stored);
        const retainage = r2(completed * line.retainage_pct / 100);
        return {
            line,
            equityPrev: prev.equity,
            loanPrev: prev.loan,
            equityNow: r2(cur.equity_this_period),
            loanNow: r2(cur.loan_this_period),
            previous,
            thisPeriod,
            stored,
            completed,
            percent: line.total_budget ? completed / line.total_budget : 0,
            balance: r2(line.total_budget - completed),
            retainage,
            equityLeft: r2(line.equity_budget - prev.equity - cur.equity_this_period)
        };
    }

    function summarize(rows) {
        const s = { total: 0, equity: 0, loan: 0, previous: 0, thisPeriod: 0, equityNow: 0, loanNow: 0, stored: 0, completed: 0, retainage: 0, balance: 0 };
        rows.forEach(r => {
            s.total += r.line.total_budget; s.equity += r.line.equity_budget; s.loan += r.line.loan_budget;
            s.previous += r.previous; s.thisPeriod += r.thisPeriod; s.equityNow += r.equityNow; s.loanNow += r.loanNow;
            s.stored += r.stored; s.completed += r.completed; s.retainage += r.retainage; s.balance += r.balance;
        });
        Object.keys(s).forEach(k => { s[k] = r2(s[k]); });
        s.percent = s.total ? s.completed / s.total : 0;
        return s;
    }

    // Everything for one draw: rows, group totals, and the summary page.
    function sheet(state, drawId) {
        const rows = state.lines.map(l => lineRow(state, l, drawId));
        const byLine = new Map(rows.map(r => [r.line.id, r]));
        const groups = state.groups.map(g => {
            const gr = g.lines.map(l => byLine.get(l.id));
            return { ...g, rows: gr, totals: summarize(gr) };
        });
        const totals = summarize(rows);
        const i = drawIndex(state, drawId);
        let previousEarned = 0;
        if (i > 0) {
            const prevRows = state.lines.map(l => lineRow(state, l, state.draws[i - 1].id));
            const pt = summarize(prevRows);
            previousEarned = r2(pt.completed - pt.retainage);
        }
        const earned = r2(totals.completed - totals.retainage);
        return {
            rows, groups, totals,
            summary: {
                contract: totals.total,
                completedStored: totals.completed,
                retainage: totals.retainage,
                earnedLessRetainage: earned,
                previousCertificates: previousEarned,
                currentPaymentDue: r2(earned - previousEarned),
                balanceToFinish: r2(totals.total - earned),
                thisPeriod: totals.thisPeriod,
                loanThisPeriod: totals.loanNow,
                equityThisPeriod: totals.equityNow
            }
        };
    }

    // Latest numbers for the Draws tab tiles (as of the newest draw).
    function overall(state) {
        const last = state.draws[state.draws.length - 1];
        if (!last) {
            const t = summarize(state.lines.map(l => ({ line: l, previous: 0, thisPeriod: 0, equityNow: 0, loanNow: 0, stored: 0, completed: 0, retainage: 0, balance: l.total_budget })));
            return { totals: t, loanDrawn: 0, equityIn: 0, retainage: 0 };
        }
        const sh = sheet(state, last.id);
        const idx = state.draws.length - 1;
        let loanDrawn = 0, equityIn = 0;
        state.lines.forEach(l => { const td = toDate(state, l.id, idx); loanDrawn += td.loan; equityIn += td.equity; });
        return { totals: sh.totals, loanDrawn: r2(loanDrawn), equityIn: r2(equityIn), retainage: sh.totals.retainage, last };
    }

    /* ---------- invoices → draw ---------- */

    // Invoices that belong in a draw: tagged to a line, dated after the
    // previous draw's period and on/before this one's, not already in
    // another draw.
    function invoiceWindow(state, draw) {
        const i = drawIndex(state, draw.id);
        const prev = i > 0 ? state.draws[i - 1] : null;
        const from = prev && prev.period_to ? prev.period_to : null;
        const to = draw.period_to;
        const dateOf = inv => inv.invoice_date || (inv.created_at || "").slice(0, 10);
        const inWindow = inv => {
            if (inv.draw_id && inv.draw_id !== draw.id) return false;
            if (inv.draw_id === draw.id) return true;
            const d = dateOf(inv);
            return (!from || d > from) && (!to || d <= to);
        };
        const all = state.invoices.filter(inWindow);
        return { tagged: all.filter(x => x.budget_line_id), untagged: all.filter(x => !x.budget_line_id) };
    }

    // Split an amount for a line: equity first, then loan.
    function split(state, line, drawId, amount) {
        const i = drawIndex(state, drawId);
        const prev = i > 0 ? toDate(state, line.id, i - 1) : { equity: 0, loan: 0 };
        const equityRoom = Math.max(0, r2(line.equity_budget - prev.equity));
        const equity = Math.min(Math.max(0, amount), equityRoom);
        return { equity: r2(equity), loan: r2(amount - equity) };
    }

    // { lineId → { work, stored, invoices: [...] } } from the invoice window
    function prefill(state, draw) {
        const out = new Map();
        invoiceWindow(state, draw).tagged.forEach(inv => {
            if (!out.has(inv.budget_line_id)) out.set(inv.budget_line_id, { work: 0, stored: 0, invoices: [] });
            const row = out.get(inv.budget_line_id);
            if (inv.is_stored_material) row.stored = r2(row.stored + num(inv.total_due));
            else row.work = r2(row.work + num(inv.total_due));
            row.invoices.push(inv);
        });
        return out;
    }

    /* ---------- writes ---------- */

    async function createDraw(state, projectId, { drawNumber, periodTo }) {
        const { data: draw, error } = await client().from("draws").insert({
            project_id: projectId,
            draw_number: drawNumber,
            period_to: periodTo,
            application_date: new Date().toISOString().slice(0, 10),
            status: "draft",
            created_by: staffId(),
            created_by_name: staffName()
        }).select().single();
        if (error) throw error;
        // fill from invoices
        const tmpState = { ...state, draws: [...state.draws, draw] };
        const rows = [];
        prefill(tmpState, draw).forEach((v, lineId) => {
            const line = state.lines.find(l => l.id === lineId);
            if (!line) return;
            const sp = split(tmpState, line, draw.id, v.work);
            rows.push({ draw_id: draw.id, budget_line_id: lineId, equity_this_period: sp.equity, loan_this_period: sp.loan, stored_materials: v.stored });
        });
        if (rows.length) {
            const { error: lErr } = await client().from("draw_lines").insert(rows);
            if (lErr) throw lErr;
        }
        return draw;
    }

    // Re-pull "this period" from invoices (draft only); keeps stored edits only where no invoice says otherwise.
    async function refillFromInvoices(state, draw) {
        const fill = prefill(state, draw);
        const existing = state.linesByDraw.get(draw.id) || new Map();
        const ids = new Set([...fill.keys(), ...existing.keys()]);
        const rows = [];
        ids.forEach(lineId => {
            const line = state.lines.find(l => l.id === lineId);
            if (!line) return;
            const v = fill.get(lineId) || { work: 0, stored: 0 };
            const sp = split(state, line, draw.id, v.work);
            rows.push({ draw_id: draw.id, budget_line_id: lineId, equity_this_period: sp.equity, loan_this_period: sp.loan, stored_materials: v.stored });
        });
        if (!rows.length) return;
        const { error } = await client().from("draw_lines").upsert(rows, { onConflict: "draw_id,budget_line_id" });
        if (error) throw error;
    }

    // Save one line's amounts. `amount` is this period's total work; split
    // equity-first unless explicit equity/loan are given.
    async function saveLine(state, draw, line, { amount, equity, loan, stored }) {
        let e = equity, l = loan;
        if (amount !== undefined) { const sp = split(state, line, draw.id, num(amount)); e = sp.equity; l = sp.loan; }
        const cur = (state.linesByDraw.get(draw.id) || new Map()).get(line.id) || {};
        const row = {
            draw_id: draw.id,
            budget_line_id: line.id,
            equity_this_period: r2(e !== undefined ? e : cur.equity_this_period),
            loan_this_period: r2(l !== undefined ? l : cur.loan_this_period),
            stored_materials: r2(stored !== undefined ? stored : cur.stored_materials)
        };
        const { error } = await client().from("draw_lines").upsert(row, { onConflict: "draw_id,budget_line_id" });
        if (error) throw error;
        return row;
    }

    async function setStatus(draw, status, extra) {
        const patch = { status, ...(extra || {}) };
        if (status === "submitted") { patch.submitted_at = new Date().toISOString(); patch.submitted_by_name = staffName(); }
        if (status === "funded") patch.funded_at = new Date().toISOString();
        if (status === "draft") { patch.submitted_at = null; patch.funded_at = null; }
        const { data, error } = await client().from("draws").update(patch).eq("id", draw.id).select();
        if (error) throw error;
        if (!data || !data.length) throw new Error("You don't have permission to change this draw.");
        return data[0];
    }

    // Lock the window's tagged invoices to this draw (best effort — an
    // invoice the person can't edit just stays matched by date).
    async function stampInvoices(state, draw) {
        const ids = invoiceWindow(state, draw).tagged.filter(i => !i.draw_id).map(i => i.id);
        if (!ids.length) return;
        const { error } = await client().from("project_invoices").update({ draw_id: draw.id }).in("id", ids);
        if (error) console.warn("[draws] couldn't stamp invoices:", error.message);
    }

    async function deleteDraft(draw) {
        const { error } = await client().from("draws").delete().eq("id", draw.id).eq("status", "draft");
        if (error) throw error;
    }

    async function tagInvoice(invoiceId, lineId) {
        const { data, error } = await client().from("project_invoices").update({ budget_line_id: lineId }).eq("id", invoiceId).select("id");
        if (error) throw error;
        if (!data || !data.length) throw new Error("You don't have permission to edit this invoice.");
    }

    // Suggest a line for an untagged invoice from the vendor's past tags.
    function suggestLine(state, inv) {
        const k = String(inv.vendor_name || "").trim().toLowerCase();
        const counts = new Map();
        state.invoices.forEach(x => {
            if (!x.budget_line_id || String(x.vendor_name || "").trim().toLowerCase() !== k) return;
            counts.set(x.budget_line_id, (counts.get(x.budget_line_id) || 0) + 1);
        });
        let best = null, n = 0;
        counts.forEach((c, id) => { if (c > n) { n = c; best = id; } });
        return best;
    }

    /* ---------- budget writes ---------- */

    async function saveBudgetLine(projectId, line) {
        const payload = {
            project_id: projectId,
            section_id: line.section_id || null,
            description: line.description,
            total_budget: r2(line.total_budget),
            equity_budget: r2(line.equity_budget),
            retainage_pct: r2(line.retainage_pct),
            sort_order: line.sort_order || 0,
            source: line.source || "manual"
        };
        if (line.id) {
            const { error } = await client().from("budget_lines").update(payload).eq("id", line.id);
            if (error) throw error;
            return line.id;
        }
        const { data, error } = await client().from("budget_lines").insert({ ...payload, created_by: staffId(), created_by_name: staffName() }).select("id").single();
        if (error) throw error;
        return data.id;
    }

    async function deleteBudgetLine(lineId) {
        const { error } = await client().from("budget_lines").delete().eq("id", lineId);
        if (error) throw error;
    }

    function money(n, opts) {
        const v = num(n);
        return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: opts && opts.whole ? 0 : 2, maximumFractionDigits: opts && opts.whole ? 0 : 2 });
    }
    function shortMoney(n) {
        const v = num(n);
        if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
        if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
        return money(v, { whole: true });
    }

    window.Draws = {
        access, load, buildState, sheet, overall, lineRow, summarize, split,
        invoiceWindow, prefill, createDraw, refillFromInvoices, saveLine, setStatus,
        stampInvoices, deleteDraft, tagInvoice, suggestLine, saveBudgetLine, deleteBudgetLine,
        money, shortMoney, r2, staffName, staffId
    };
})();
