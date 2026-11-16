/* ===========================================================
   ACCOUNTING › DRAWS + BUDGET (pages/project-accounting.html) — 2026-11-16

   Draws tab   — "Draw #N is ready to review" callout, three numbers,
                 every draw, budget by group. Opening a draw shows the
                 editor: current payment due, four numbers, invoices that
                 still need a budget line, and budget groups that open to
                 their lines. Draft amounts save as you type (on blur).
   Budget tab  — every budget line by group; import from the AIA workbook
                 (js/draws-import.js); add / edit lines.

   Math + data: js/draws-core.js. PDF/Excel: js/draws-export.js.
   Permissions come from draws_access() (Accounting / Super Admin, or the
   project's PM). Tabs stay hidden for everyone else.
=========================================================== */
(function () {
    "use strict";

    const D = () => window.Draws;
    const $ = id => document.getElementById(id);

    let project = null;
    let can = { view: false, edit: false, submit: false, manage_budget: false };
    let state = null;
    let openDrawId = null;
    const openGroups = new Set();
    let showSplit = false;
    let busy = false;
    let importParsed = null;
    let editingLine = null;

    function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
    const money = n => D().money(n);
    const short = n => D().shortMoney(n);
    const pct = n => `${Math.round((Number(n) || 0) * 100)}%`;
    function niceDate(iso, year) {
        if (!iso) return "—";
        return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", year ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
    }
    function toast(text, type) { if (window.showToast) window.showToast(text, type || "success"); }
    function bar(p) { return `<div class="pov-bar"><span style="width:${Math.max(0, Math.min(100, p * 100))}%"></span></div>`; }
    const statusLabel = d => (d.is_opening_balance ? "Opening balance" : { draft: "Draft", submitted: "Submitted", funded: "Funded" }[d.status] || d.status);

    async function reload() {
        try {
            state = await D().load(project.id);
        } catch (e) {
            console.error("[draws] load failed:", e);
            $("drawsRoot").innerHTML = $("budgetRoot").innerHTML =
                `<p class="pov-empty">Couldn't load draws. Has sql/supabase-draws-setup.sql been run?</p>`;
            return;
        }
        render();
    }

    function render() {
        if (!state) return;
        renderDraws();
        renderBudget();
        if (window.AccountingInvoices) window.AccountingInvoices.refresh(); // show "Add to draw" on invoices
    }

    /* ===================== DRAWS TAB ===================== */

    function renderDraws() {
        const root = $("drawsRoot");
        if (!state.lines.length) {
            root.innerHTML = `
                <div class="dr-callout">
                    <div><p class="dr-callout-title">Set up the budget first</p>
                    <p class="dr-callout-sub">Draws are built from the project's budget lines. Import them from the AIA draw workbook on the Budget tab.</p></div>
                    ${can.manage_budget ? `<button type="button" class="auth-button" data-dr="go-budget">Go to Budget</button>` : ""}
                </div>`;
            return;
        }
        if (openDrawId && state.draws.some(d => d.id === openDrawId)) { renderEditor(root); return; }
        openDrawId = null;

        const real = state.draws.filter(d => !d.is_opening_balance);
        const draft = [...real].reverse().find(d => d.status === "draft");
        const last = state.draws[state.draws.length - 1];
        const nextNumber = (last ? last.draw_number : 0) + 1;
        const ov = D().overall(state);
        const T = ov.totals;
        const loanBudget = state.lines.reduce((s, l) => s + l.loan_budget, 0);
        const equityBudget = state.lines.reduce((s, l) => s + l.equity_budget, 0);

        let callout;
        if (draft) {
            const sh = D().sheet(state, draft.id);
            const untagged = D().invoiceWindow(state, draft).untagged.length;
            callout = `
                <div class="dr-callout">
                    <div><p class="dr-callout-title">Draw #${draft.draw_number} is ready to review</p>
                    <p class="dr-callout-sub">${money(sh.summary.currentPaymentDue)} due · period to ${niceDate(draft.period_to)}${untagged ? ` · <span class="pov-warn">${untagged} invoice${untagged === 1 ? "" : "s"} need a budget line</span>` : ""}</p></div>
                    <button type="button" class="auth-button" data-dr="open" data-id="${draft.id}">Review draw</button>
                </div>`;
        } else if (can.edit) {
            const end = new Date(); end.setMonth(end.getMonth() + 1, 0);
            callout = `
                <div class="dr-callout">
                    <div><p class="dr-callout-title">Start Draw #${nextNumber}</p>
                    <p class="dr-callout-sub">It fills in from invoices tagged to budget lines since the last draw.</p></div>
                    <div class="dr-callout-form">
                        <label>Period to <input type="date" id="drNewPeriod" value="${end.toISOString().slice(0, 10)}"></label>
                        <button type="button" class="auth-button" data-dr="new" data-number="${nextNumber}">Start draw</button>
                    </div>
                </div>`;
        } else callout = "";

        root.innerHTML = `
            ${callout}
            <div class="dr-tiles">
                <div class="pov-tile"><p class="pov-tile-label">Completed to date</p><p class="pov-tile-value">${short(T.completed)} <span>of ${short(T.total)}</span></p>${bar(T.percent)}<p class="pov-tile-sub">${pct(T.percent)} · ${short(T.total - T.completed)} to finish</p></div>
                <div class="pov-tile"><p class="pov-tile-label">Loan drawn</p><p class="pov-tile-value">${short(ov.loanDrawn)} <span>of ${short(loanBudget)}</span></p>${bar(loanBudget ? ov.loanDrawn / loanBudget : 0)}<p class="pov-tile-sub">${short(Math.max(0, loanBudget - ov.loanDrawn))} still available</p></div>
                <div class="pov-tile"><p class="pov-tile-label">Retainage held</p><p class="pov-tile-value">${money(ov.retainage)}</p><p class="pov-tile-sub">Equity left to contribute: ${short(Math.max(0, equityBudget - ov.equityIn))}</p></div>
            </div>
            <div class="pov-columns">
                <section class="pov-section pov-col-main">
                    <div class="pov-section-head"><h2>All draws</h2></div>
                    ${state.draws.length ? [...state.draws].reverse().map(d => {
                        const sh = D().sheet(state, d.id);
                        return `<button type="button" class="dr-draw-row" data-dr="open" data-id="${d.id}">
                            <strong>${esc(window.DrawsExport.drawLabel(d))}</strong>
                            <span class="dr-muted">${d.is_opening_balance ? "Imported from workbook" : "Period to " + niceDate(d.period_to, true)}</span>
                            <span class="dr-num">${money(d.is_opening_balance ? sh.totals.completed : sh.summary.thisPeriod)}</span>
                            <span class="dr-status dr-status--${d.is_opening_balance ? "opening" : d.status}">${statusLabel(d)}</span>
                            <span class="pov-chev" aria-hidden="true">›</span>
                        </button>`;
                    }).join("") : `<p class="pov-empty">No draws yet.</p>`}
                </section>
                <section class="pov-section pov-col-side">
                    <div class="pov-section-head"><h2>Budget by group</h2><a href="#budget" data-dr="go-budget">Budget ›</a></div>
                    ${groupProgress()}
                </section>
            </div>`;
    }

    function groupProgress() {
        const last = state.draws[state.draws.length - 1];
        if (!last) return state.groups.map(g => `<div class="dr-group-bar"><div><span>${esc(g.name)}</span><small>0%</small></div>${bar(0)}</div>`).join("");
        const sh = D().sheet(state, last.id);
        return sh.groups.map(g => `<div class="dr-group-bar"><div><span>${esc(g.name)}</span><small>${pct(g.totals.percent)}</small></div>${bar(g.totals.percent)}</div>`).join("");
    }

    /* ---------- editor ---------- */

    function renderEditor(root) {
        const draw = state.draws.find(d => d.id === openDrawId);
        const sh = D().sheet(state, draw.id);
        const s = sh.summary;
        const editable = draw.status === "draft" && !draw.is_opening_balance && can.edit;
        const win = draw.is_opening_balance ? { tagged: [], untagged: [] } : D().invoiceWindow(state, draw);
        const fill = draw.is_opening_balance ? new Map() : D().prefill(state, draw);

        const actions = [];
        actions.push(`<button type="button" class="pov-link-muted dr-linkbtn" data-dr="xlsx">Excel</button>`);
        actions.push(`<button type="button" class="pov-link-muted dr-linkbtn" data-dr="pdf">${draw.status === "draft" ? "Preview PDF" : "PDF"}</button>`);
        if (editable) actions.push(`<button type="button" class="pov-link-muted dr-linkbtn" data-dr="refill">Refill from invoices</button>`);
        if (draw.status === "draft" && !draw.is_opening_balance && can.edit) actions.push(`<button type="button" class="pov-link-muted dr-linkbtn dr-danger" data-dr="delete">Delete draft</button>`);
        if (draw.status === "submitted" && can.submit) actions.push(`<button type="button" class="pov-link-muted dr-linkbtn" data-dr="reopen">Reopen</button>`);
        if (draw.status === "draft" && !draw.is_opening_balance && can.submit) actions.push(`<button type="button" class="auth-button pov-btn" data-dr="submit">Submit draw</button>`);
        if (draw.status === "submitted" && can.submit) actions.push(`<button type="button" class="auth-button pov-btn" data-dr="funded">Mark funded</button>`);

        root.innerHTML = `
            <button type="button" class="dr-back" data-dr="back">‹ All draws</button>
            <div class="dr-ed-head">
                <div>
                    <p class="dr-muted">Draw ${esc(window.DrawsExport.drawLabel(draw))} · ${draw.is_opening_balance ? "imported from the workbook" : "period to " + niceDate(draw.period_to, true)} · <span class="dr-status dr-status--${draw.is_opening_balance ? "opening" : draw.status}">${statusLabel(draw)}</span></p>
                    <p class="dr-muted dr-mt">Current payment due</p>
                    <p class="dr-big">${money(s.currentPaymentDue)}</p>
                </div>
                <div class="dr-actions">${actions.join("")}</div>
            </div>
            <div class="dr-tiles dr-tiles--4">
                <div class="pov-tile"><p class="pov-tile-label">This period</p><p class="pov-tile-value dr-tile-sm">${money(s.thisPeriod)}</p><p class="pov-tile-sub">Equity ${short(s.equityThisPeriod)} · Loan ${short(s.loanThisPeriod)}</p></div>
                <div class="pov-tile"><p class="pov-tile-label">Completed to date</p><p class="pov-tile-value dr-tile-sm">${short(s.completedStored)} <span>· ${pct(sh.totals.percent)}</span></p>${bar(sh.totals.percent)}</div>
                <div class="pov-tile"><p class="pov-tile-label">Retainage held</p><p class="pov-tile-value dr-tile-sm">${money(s.retainage)}</p></div>
                <div class="pov-tile"><p class="pov-tile-label">Balance to finish</p><p class="pov-tile-value dr-tile-sm">${money(s.balanceToFinish)}</p></div>
            </div>
            ${win.untagged.length ? untaggedHtml(win.untagged, editable) : ""}
            <section class="dr-table">
                <div class="dr-row dr-row--head"><span>Budget group</span><span>Budget</span><span>Previous</span><span>This period</span><span>Complete</span><span></span></div>
                ${sh.groups.map(g => groupHtml(g, editable, fill)).join("")}
                <div class="dr-row dr-row--total"><span>Total</span><span>${money(sh.totals.total)}</span><span>${money(sh.totals.previous)}</span><span>${money(sh.totals.thisPeriod)}</span><span></span><span></span></div>
                <label class="dr-toggle"><input type="checkbox" data-dr-field="split"${showSplit ? " checked" : ""}> Show equity / loan split and stored materials</label>
            </section>`;
    }

    function untaggedHtml(list, editable) {
        return `
            <div class="dr-untagged">
                <p class="dr-untagged-head"><strong>${list.length} invoice${list.length === 1 ? "" : "s"}</strong> in this period ${list.length === 1 ? "needs" : "need"} a budget line before ${list.length === 1 ? "it counts" : "they count"}</p>
                ${list.map(inv => {
                    const sug = D().suggestLine(state, inv);
                    return `<div class="dr-untagged-row">
                        <span><strong>${esc(inv.vendor_name)}</strong><small>${inv.invoice_number ? "#" + esc(inv.invoice_number) + " · " : ""}${niceDate(inv.invoice_date)}</small></span>
                        <span class="dr-num">${money(inv.total_due)}</span>
                        ${editable ? `<select class="dr-select" data-dr-field="tagline" data-inv="${inv.id}" aria-label="Budget line for ${esc(inv.vendor_name)}">
                            <option value="">Choose a budget line…</option>
                            ${state.groups.map(g => `<optgroup label="${esc(g.name)}">${g.lines.map(l => `<option value="${l.id}"${l.id === sug ? " selected" : ""}>${esc((l.subName ? l.subName + " · " : "") + l.description)}</option>`).join("")}</optgroup>`).join("")}
                        </select>
                        <button type="button" class="auth-button pov-btn dr-small-btn" data-dr="tag" data-inv="${inv.id}">Add</button>` : ""}
                    </div>`;
                }).join("")}
            </div>`;
    }

    function groupHtml(g, editable, fill) {
        const open = openGroups.has(g.id);
        const t = g.totals;
        const active = g.rows.filter(r => r.thisPeriod || r.stored || fill.has(r.line.id));
        const shown = open ? (showSplit || !active.length ? g.rows : active) : [];
        return `
            <button type="button" class="dr-row dr-row--group" data-dr="group" data-id="${g.id}" aria-expanded="${open}">
                <span>${esc(g.name)}</span><span>${short(t.total)}</span><span>${short(t.previous)}</span>
                <span class="${t.thisPeriod ? "dr-strong" : "dr-faint"}">${t.thisPeriod ? money(t.thisPeriod) : "—"}</span>
                <span class="dr-complete">${bar(t.percent)}<small>${pct(t.percent)}</small></span>
                <span class="pov-chev" aria-hidden="true">${open ? "⌃" : "⌄"}</span>
            </button>
            ${open ? `<div class="dr-lines">${shown.map(r => lineHtml(r, editable, fill.get(r.line.id))).join("")}
                ${!showSplit && active.length < g.rows.length ? `<p class="dr-muted dr-more">${g.rows.length - active.length} more line${g.rows.length - active.length === 1 ? "" : "s"} with nothing this period — tick "Show equity / loan split" below to see every line.</p>` : ""}</div>` : ""}`;
    }

    function lineHtml(r, editable, fill) {
        const l = r.line;
        const src = fill && fill.invoices.length ? `From ${fill.invoices.length} invoice${fill.invoices.length === 1 ? "" : "s"} · ${esc([...new Set(fill.invoices.map(i => i.vendor_name))].slice(0, 2).join(", "))}` : "";
        const input = (field, value, label) => editable
            ? `<input type="text" inputmode="decimal" class="dr-input" data-dr-field="${field}" data-line="${l.id}" value="${value ? value.toFixed(2) : ""}" placeholder="0.00" aria-label="${label} for ${esc(l.description)}">`
            : `<span>${value ? money(value) : "—"}</span>`;
        return `
            <div class="dr-row dr-row--line">
                <span><span class="dr-line-name">${esc((l.subName ? l.subName + " · " : "") + l.description)}</span>${src ? `<small>${src}</small>` : ""}
                    ${showSplit ? `<small>Equity ${money(r.equityNow)} · Loan ${money(r.loanNow)} · equity left ${money(Math.max(0, r.equityLeft))}</small>` : ""}</span>
                <span>${money(l.total_budget)}</span>
                <span>${money(r.previous)}</span>
                <span>${input("amount", r.thisPeriod, "This period")}${showSplit ? `<span class="dr-stored">Stored ${input("stored", r.stored, "Stored materials")}</span>` : ""}</span>
                <span class="dr-muted">${pct(r.percent)} · ${short(r.balance)} left</span>
                <span></span>
            </div>`;
    }

    /* ---------- draw actions ---------- */

    function currentDraw() { return state.draws.find(d => d.id === openDrawId); }

    async function run(label, fn) {
        if (busy) return;
        busy = true;
        try { await fn(); }
        catch (e) { console.error(`[draws] ${label}:`, e); toast((e && e.message) || `Couldn't ${label}.`, "error"); }
        finally { busy = false; }
    }

    async function onAction(btn) {
        const a = btn.dataset.dr;
        if (a === "go-budget") { window.AccountingTabs && window.AccountingTabs.show("budget"); return; }
        if (a === "open") { openDrawId = btn.dataset.id; openGroups.clear(); render(); window.scrollTo(0, 0); return; }
        if (a === "back") { openDrawId = null; render(); return; }
        if (a === "group") { const id = btn.dataset.id; openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id); renderDraws(); return; }
        if (a === "new") {
            const period = $("drNewPeriod").value;
            if (!period) { toast("Pick the period-to date first.", "error"); return; }
            return run("start the draw", async () => {
                const draw = await D().createDraw(state, project.id, { drawNumber: Number(btn.dataset.number), periodTo: period });
                openDrawId = draw.id;
                await reload();
                toast(`Draw #${draw.draw_number} started from tagged invoices.`);
            });
        }
        const draw = currentDraw();
        if (!draw) return;
        if (a === "pdf") return run("make the PDF", async () => { window.DrawsExport.download(await window.DrawsExport.pdf(project, state, draw), window.DrawsExport.fileName(project, draw, "pdf")); });
        if (a === "xlsx") return run("make the Excel file", async () => { window.DrawsExport.download(await window.DrawsExport.xlsx(project, state, draw), window.DrawsExport.fileName(project, draw, "xlsx")); });
        if (a === "refill") return run("refill", async () => { await D().refillFromInvoices(state, draw); await reload(); toast("This period refilled from tagged invoices."); });
        if (a === "delete") {
            confirmPopup(`Delete Draw #${draw.draw_number}?`, "The draft and its amounts are removed. Invoices stay as they are.", "Delete draft", async () => {
                await D().deleteDraft(draw); openDrawId = null; await reload(); toast("Draft deleted.");
            });
            return;
        }
        if (a === "submit") {
            confirmPopup(`Submit Draw #${draw.draw_number}?`, "This locks the draw, saves the PDF and Excel to Project Files › Financial › Draws, and ties its invoices to it.", "Submit draw", async () => {
                const files = await window.DrawsExport.fileToProject(project, state, draw);
                await D().stampInvoices(state, draw);
                await D().setStatus(draw, "submitted", { pdf_file_id: files.pdfId, xlsx_file_id: files.xlsxId });
                await reload();
                toast(`Draw #${draw.draw_number} submitted. PDF and Excel saved to Project Files.`);
            });
            return;
        }
        if (a === "funded") return run("mark it funded", async () => { await D().setStatus(draw, "funded"); await reload(); toast("Marked funded."); });
        if (a === "reopen") return run("reopen", async () => { await D().setStatus(draw, "draft"); await reload(); toast("Reopened as a draft."); });
        if (a === "tag") {
            const sel = document.querySelector(`[data-dr-field="tagline"][data-inv="${btn.dataset.inv}"]`);
            if (!sel || !sel.value) { toast("Choose a budget line first.", "error"); return; }
            return run("tag the invoice", async () => {
                const inv = state.invoices.find(i => i.id === btn.dataset.inv);
                await D().tagInvoice(inv.id, sel.value);
                const line = state.lines.find(l => l.id === sel.value);
                const cur = D().lineRow(state, line, draw.id);
                if (inv.is_stored_material) await D().saveLine(state, draw, line, { stored: cur.stored + Number(inv.total_due) });
                else await D().saveLine(state, draw, line, { amount: cur.thisPeriod + Number(inv.total_due), stored: cur.stored });
                openGroups.add(line.groupId);
                await reload();
                toast("Invoice added to the draw.");
            });
        }
    }

    async function onChange(el) {
        const f = el.dataset.drField;
        if (f === "split") { showSplit = el.checked; renderDraws(); return; }
        if (f !== "amount" && f !== "stored") return;
        const draw = currentDraw();
        const line = state.lines.find(l => l.id === el.dataset.line);
        if (!draw || !line) return;
        const v = Number(String(el.value).replace(/[$,\s]/g, "")) || 0;
        const cur = D().lineRow(state, line, draw.id);
        const changes = f === "amount" ? { amount: v, stored: cur.stored } : { stored: v, equity: cur.equityNow, loan: cur.loanNow };
        await run("save that amount", async () => {
            await D().saveLine(state, draw, line, changes);
            await reload();
        });
    }

    /* ===================== BUDGET TAB ===================== */

    function renderBudget() {
        const root = $("budgetRoot");
        if (!state.lines.length) {
            root.innerHTML = `
                <div class="dr-callout">
                    <div><p class="dr-callout-title">No budget yet</p>
                    <p class="dr-callout-sub">Import it from the project's AIA draw workbook (the Continuation Sheet). Draws already done in the workbook come in as the starting balance.</p></div>
                    ${can.manage_budget ? `<div class="dr-callout-form"><button type="button" class="pov-link-muted dr-linkbtn" data-dr-b="add">Add a line by hand</button><button type="button" class="auth-button" data-dr-b="import">Import workbook</button></div>` : ""}
                </div>`;
            return;
        }
        const total = state.lines.reduce((s, l) => s + l.total_budget, 0);
        const equity = state.lines.reduce((s, l) => s + l.equity_budget, 0);
        const last = state.draws[state.draws.length - 1];
        const rowsById = new Map(last ? D().sheet(state, last.id).rows.map(r => [r.line.id, r]) : []);
        root.innerHTML = `
            <div class="dr-ed-head">
                <div class="dr-tiles dr-tiles--3 dr-grow">
                    <div class="pov-tile"><p class="pov-tile-label">Total budget</p><p class="pov-tile-value">${short(total)}</p><p class="pov-tile-sub">${state.lines.length} lines</p></div>
                    <div class="pov-tile"><p class="pov-tile-label">Equity</p><p class="pov-tile-value">${short(equity)}</p></div>
                    <div class="pov-tile"><p class="pov-tile-label">Loan</p><p class="pov-tile-value">${short(total - equity)}</p></div>
                </div>
            </div>
            ${can.manage_budget ? `<div class="dr-actions dr-actions--left"><button type="button" class="auth-button pov-btn" data-dr-b="add">+ Add line</button></div>` : ""}
            <section class="dr-table">
                <div class="dr-row dr-row--head dr-row--budget"><span>Line</span><span>Budget</span><span>Equity</span><span>Loan</span><span>Drawn</span><span>Retainage</span></div>
                ${state.groups.map(g => {
                    const open = openGroups.has("b:" + g.id);
                    const gt = g.lines.reduce((s, l) => s + l.total_budget, 0);
                    const gd = g.lines.reduce((s, l) => s + ((rowsById.get(l.id) || {}).completed || 0), 0);
                    return `<button type="button" class="dr-row dr-row--group dr-row--budget" data-dr-b="group" data-id="${g.id}" aria-expanded="${open}">
                        <span>${esc(g.name)} <small class="dr-muted">· ${g.lines.length}</small></span><span>${short(gt)}</span><span></span><span></span><span>${short(gd)}</span><span class="pov-chev">${open ? "⌃" : "⌄"}</span></button>
                        ${open ? `<div class="dr-lines">${g.lines.map(l => `
                            <div class="dr-row dr-row--line dr-row--budget">
                                <span><span class="dr-line-name">${esc((l.subName ? l.subName + " · " : "") + l.description)}</span>${l.source === "vpo" ? `<small>Added by a VPO</small>` : ""}</span>
                                <span>${money(l.total_budget)}</span><span>${money(l.equity_budget)}</span><span>${money(l.loan_budget)}</span>
                                <span>${money((rowsById.get(l.id) || {}).completed || 0)}</span>
                                <span>${l.retainage_pct ? l.retainage_pct + "%" : "—"}${can.manage_budget ? ` <button type="button" class="dr-edit" data-dr-b="edit" data-id="${l.id}">Edit</button>` : ""}</span>
                            </div>`).join("")}</div>` : ""}`;
                }).join("")}
                <div class="dr-row dr-row--total dr-row--budget"><span>Total</span><span>${money(total)}</span><span>${money(equity)}</span><span>${money(total - equity)}</span><span></span><span></span></div>
            </section>`;
    }

    /* ---------- import ---------- */

    function openImport() {
        importParsed = null;
        $("drImportOverlay").classList.remove("hidden");
        $("drImportBody").innerHTML = `
            <p class="auth-inline-copy">Pick the project's AIA draw workbook (.xlsx). The Continuation Sheet's lines become the budget, and the draws already in it become the starting balance.</p>
            <label class="auth-field">Workbook<input type="file" id="drImportFile" accept=".xlsx,.xlsm,.xls"></label>`;
        $("drImportConfirm").disabled = true;
        $("drImportMsg").textContent = "";
    }

    async function onImportFile(file) {
        $("drImportMsg").textContent = "Reading the workbook…";
        try {
            importParsed = await window.DrawsImport.parse(file);
        } catch (e) {
            $("drImportMsg").textContent = e.message || "Couldn't read that workbook.";
            return;
        }
        const p = importParsed;
        const sums = new Map();
        p.lines.forEach(l => sums.set(l.group, (sums.get(l.group) || 0) + l.total_budget));
        const completedNote = p.workbookCompleted != null && Math.abs(p.workbookCompleted - p.completed) >= 1
            ? `<p class="dr-note">Completed to date from the lines is <strong>${money(p.completed)}</strong>; the workbook's own total says ${money(p.workbookCompleted)}. The portal adds up every line, so its number is the one to trust — check the workbook's total formulas.</p>` : "";
        $("drImportMsg").textContent = "";
        $("drImportBody").innerHTML = `
            <p class="auth-inline-copy"><strong>${p.lines.length} lines</strong> in ${sums.size} groups · budget ${money(p.linesTotal + p.adjustment)}${p.grandTotal != null ? (Math.abs(p.grandTotal - p.linesTotal - p.adjustment) < 0.01 ? " ✓ matches the workbook total" : ` (workbook says ${money(p.grandTotal)})`) : ""}</p>
            ${p.adjustment ? `<p class="dr-note">The workbook's total includes ${money(p.adjustment)} that isn't on any line. It's added as a line called "Workbook total adjustment".</p>` : ""}
            ${completedNote}
            <div class="dr-import-groups">${[...sums].map(([g, v]) => `<div><span>${esc(g)}</span><strong>${money(v)}</strong></div>`).join("")}</div>
            <div class="dr-import-grid">
                <label class="auth-field">Draws already in this workbook (last draw #)<input type="number" id="drImportThrough" min="0" step="1" placeholder="e.g. 15"></label>
                <label class="auth-field">That draw's period-to date<input type="date" id="drImportPeriod"></label>
            </div>
            <p class="dr-muted">The next draw in the portal will be that number + 1.</p>`;
        $("drImportConfirm").disabled = false;
    }

    async function confirmImport() {
        if (!importParsed) return;
        const through = Number($("drImportThrough").value);
        const period = $("drImportPeriod").value;
        const hasHistory = importParsed.lines.some(l => l.equity_to_date || l.loan_to_date || l.stored);
        if (hasHistory && (!through || through < 1)) { $("drImportMsg").textContent = "Enter the last draw number in the workbook (e.g. 15)."; return; }
        if (hasHistory && !period) { $("drImportMsg").textContent = "Enter that draw's period-to date."; return; }
        $("drImportConfirm").disabled = true;
        $("drImportMsg").textContent = "Importing…";
        try {
            const res = await window.DrawsImport.save(project.id, importParsed, { throughDraw: through, periodTo: period });
            $("drImportOverlay").classList.add("hidden");
            await reload();
            toast(`Imported ${res.lines} budget lines.`);
        } catch (e) {
            console.error("[draws] import failed:", e);
            $("drImportMsg").textContent = (e && e.message) || "Import failed.";
            $("drImportConfirm").disabled = false;
        }
    }

    /* ---------- add / edit a line ---------- */

    function openLine(line) {
        editingLine = line || null;
        const tops = [...state.sectionsById.values()].filter(s => !s.parent_id).sort((a, b) => a.sort_order - b.sort_order);
        const sub = [...state.sectionsById.values()].filter(s => s.parent_id);
        $("drLineTitle").textContent = line ? "Edit budget line" : "Add a budget line";
        $("drLineSection").innerHTML = tops.map(t => `<option value="${t.id}">${esc(t.name)}</option>` + sub.filter(s => s.parent_id === t.id).map(s => `<option value="${s.id}">${esc(t.name)} › ${esc(s.name)}</option>`).join("")).join("")
            + `<option value="__new">+ New group…</option>`;
        $("drLineSection").value = line && line.section_id ? line.section_id : (tops[0] ? tops[0].id : "__new");
        $("drLineNewGroup").value = "";
        $("drLineNewGroupWrap").hidden = $("drLineSection").value !== "__new";
        $("drLineDesc").value = line ? line.description : "";
        $("drLineTotal").value = line ? line.total_budget : "";
        $("drLineEquity").value = line ? line.equity_budget : "";
        $("drLineRet").value = line ? line.retainage_pct : 5;
        $("drLineDelete").hidden = !line;
        $("drLineMsg").textContent = "";
        $("drLineOverlay").classList.remove("hidden");
    }

    async function saveLineForm() {
        const n = id => Number(String($(id).value).replace(/[$,\s]/g, "")) || 0;
        const desc = $("drLineDesc").value.trim();
        if (!desc) { $("drLineMsg").textContent = "Enter a description."; return; }
        let sectionId = $("drLineSection").value;
        try {
            if (sectionId === "__new") {
                const name = $("drLineNewGroup").value.trim();
                if (!name) { $("drLineMsg").textContent = "Name the new group."; return; }
                const { data, error } = await window.supabaseClient.from("budget_sections").insert({ project_id: project.id, name, cost_type: "hard", sort_order: state.sectionsById.size + 1 }).select("id").single();
                if (error) throw error;
                sectionId = data.id;
            }
            const maxOrder = state.lines.reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
            await D().saveBudgetLine(project.id, {
                id: editingLine ? editingLine.id : null,
                section_id: sectionId,
                description: desc,
                total_budget: n("drLineTotal"),
                equity_budget: n("drLineEquity"),
                retainage_pct: n("drLineRet"),
                sort_order: editingLine ? editingLine.sort_order : maxOrder + 1,
                source: editingLine ? editingLine.source : "manual"
            });
            $("drLineOverlay").classList.add("hidden");
            await reload();
            toast(editingLine ? "Budget line saved." : "Budget line added.");
        } catch (e) {
            console.error("[draws] save line:", e);
            $("drLineMsg").textContent = (e && e.message) || "Couldn't save.";
        }
    }

    async function deleteLineForm() {
        if (!editingLine) return;
        const used = state.draws.some(d => (state.linesByDraw.get(d.id) || new Map()).has(editingLine.id));
        if (used) { $("drLineMsg").textContent = "This line has amounts in a draw, so it can't be deleted. Set its budget to 0 instead."; return; }
        try {
            await D().deleteBudgetLine(editingLine.id);
            $("drLineOverlay").classList.add("hidden");
            await reload();
            toast("Budget line deleted.");
        } catch (e) { $("drLineMsg").textContent = (e && e.message) || "Couldn't delete."; }
    }

    /* ---------- shared confirm popup ---------- */

    let confirmFn = null;
    function confirmPopup(title, text, okLabel, fn) {
        confirmFn = fn;
        $("drConfirmTitle").textContent = title;
        $("drConfirmText").textContent = text;
        $("drConfirmOk").textContent = okLabel;
        $("drConfirmOk").disabled = false;
        $("drConfirmMsg").textContent = "";
        $("drConfirmOverlay").classList.remove("hidden");
        return true;
    }
    async function runConfirm() {
        if (!confirmFn) return;
        $("drConfirmOk").disabled = true;
        $("drConfirmMsg").textContent = "Working…";
        try {
            await confirmFn();
            $("drConfirmOverlay").classList.add("hidden");
        } catch (e) {
            console.error("[draws]", e);
            $("drConfirmMsg").textContent = (e && e.message) || "Something went wrong.";
            $("drConfirmOk").disabled = false;
        }
    }

    /* ---------- "Add to draw" from the invoice menu (Invoices tab) ---------- */

    let tagInv = null, tagDone = null;

    // The draft draw this invoice would land in (by date), if there is one.
    function draftFor(inv) {
        if (!state) return null;
        return state.draws.find(d => d.status === "draft" && !d.is_opening_balance &&
            D().invoiceWindow({ ...state, invoices: [{ ...inv, budget_line_id: inv.budget_line_id || "x" }] }, d).tagged.length) || null;
    }

    function describe(inv) {
        if (!state || !state.lines.length) return "";
        if (inv.draw_id) {
            const d = state.draws.find(x => x.id === inv.draw_id);
            if (d) return `In Draw #${d.draw_number}`;
        }
        if (!inv.budget_line_id) return "";
        const d = draftFor(inv);
        return d ? `In Draw #${d.draw_number} (draft)` : "On a budget line";
    }

    function openAddToDraw(inv, done) {
        if (!state) return;
        const locked = inv.draw_id && state.draws.some(d => d.id === inv.draw_id && d.status !== "draft");
        tagInv = inv; tagDone = done;
        const sug = inv.budget_line_id || D().suggestLine(state, inv);
        const d = draftFor(inv);
        $("drTagTitle").textContent = `Add ${inv.vendor_name}${inv.invoice_number ? " #" + inv.invoice_number : ""} to a draw`;
        $("drTagInfo").textContent = locked
            ? "This invoice is in a submitted draw, so its budget line can't change."
            : `${money(inv.total_due)} · ${d ? `goes into Draw #${d.draw_number} (draft)` : "goes into the next draw you start"}`;
        $("drTagLine").innerHTML = `<option value="">Choose a budget line…</option>` + state.groups.map(g =>
            `<optgroup label="${esc(g.name)}">${g.lines.map(l => `<option value="${l.id}"${l.id === sug ? " selected" : ""}>${esc((l.subName ? l.subName + " · " : "") + l.description)}</option>`).join("")}</optgroup>`).join("");
        $("drTagLine").disabled = locked;
        $("drTagStored").checked = !!inv.is_stored_material;
        $("drTagStored").disabled = locked;
        $("drTagSave").disabled = locked;
        $("drTagRemove").hidden = !inv.budget_line_id || locked;
        $("drTagMsg").textContent = "";
        $("drTagOverlay").classList.remove("hidden");
    }

    async function saveTag(remove) {
        const inv = tagInv;
        const lineId = remove ? null : $("drTagLine").value;
        const stored = !remove && $("drTagStored").checked;
        if (!remove && !lineId) { $("drTagMsg").textContent = "Choose a budget line."; return; }
        $("drTagSave").disabled = true;
        $("drTagMsg").textContent = "Saving…";
        try {
            const draft = draftFor(inv);
            const amt = Number(inv.total_due) || 0;
            // Take it off its old line in the draft first…
            if (draft && inv.budget_line_id) {
                const old = state.lines.find(l => l.id === inv.budget_line_id);
                if (old) {
                    const r = D().lineRow(state, old, draft.id);
                    if (inv.is_stored_material) await D().saveLine(state, draft, old, { stored: Math.max(0, r.stored - amt), equity: r.equityNow, loan: r.loanNow });
                    else await D().saveLine(state, draft, old, { amount: Math.max(0, r.thisPeriod - amt), stored: r.stored });
                    state = await D().load(project.id);
                }
            }
            const { data, error } = await window.supabaseClient.from("project_invoices")
                .update({ budget_line_id: lineId, is_stored_material: stored }).eq("id", inv.id).select("id");
            if (error) throw error;
            if (!data || !data.length) throw new Error("You don't have permission to edit this invoice.");
            // …then onto the new line.
            if (draft && lineId) {
                const line = state.lines.find(l => l.id === lineId);
                const r = D().lineRow(state, line, draft.id);
                if (stored) await D().saveLine(state, draft, line, { stored: r.stored + amt, equity: r.equityNow, loan: r.loanNow });
                else await D().saveLine(state, draft, line, { amount: r.thisPeriod + amt, stored: r.stored });
            }
            $("drTagOverlay").classList.add("hidden");
            await reload();
            if (tagDone) tagDone();
            toast(remove ? "Taken off the budget line." : draft ? `Added to Draw #${draft.draw_number}.` : "Saved — it'll go into the next draw.");
        } catch (e) {
            console.error("[draws] add to draw:", e);
            $("drTagMsg").textContent = (e && e.message) || "Couldn't save.";
            $("drTagSave").disabled = false;
        }
    }

    window.ProjectDraws = {
        canTag: () => Boolean(can.edit && state && state.lines.length),
        describe,
        openAddToDraw
    };

    /* ---------- wiring ---------- */

    function wire() {
        $("drawsRoot").addEventListener("click", e => { const b = e.target.closest("[data-dr]"); if (b) { e.preventDefault(); onAction(b); } });
        $("drawsRoot").addEventListener("change", e => { const el = e.target.closest("[data-dr-field]"); if (el && el.dataset.drField !== "tagline") onChange(el); });
        $("budgetRoot").addEventListener("click", e => {
            const b = e.target.closest("[data-dr-b]");
            if (!b) return;
            const a = b.dataset.drB;
            if (a === "import") openImport();
            else if (a === "add") openLine(null);
            else if (a === "edit") openLine(state.lines.find(l => l.id === b.dataset.id));
            else if (a === "group") { const k = "b:" + b.dataset.id; openGroups.has(k) ? openGroups.delete(k) : openGroups.add(k); renderBudget(); }
        });
        document.addEventListener("change", e => { if (e.target && e.target.id === "drImportFile" && e.target.files[0]) onImportFile(e.target.files[0]); });
        $("drImportConfirm").addEventListener("click", confirmImport);
        $("drImportCancel").addEventListener("click", () => $("drImportOverlay").classList.add("hidden"));
        $("drLineSave").addEventListener("click", saveLineForm);
        $("drLineCancel").addEventListener("click", () => $("drLineOverlay").classList.add("hidden"));
        $("drLineDelete").addEventListener("click", deleteLineForm);
        $("drLineSection").addEventListener("change", () => { $("drLineNewGroupWrap").hidden = $("drLineSection").value !== "__new"; });
        $("drConfirmOk").addEventListener("click", runConfirm);
        $("drTagSave").addEventListener("click", () => saveTag(false));
        $("drTagRemove").addEventListener("click", () => saveTag(true));
        $("drTagCancel").addEventListener("click", () => $("drTagOverlay").classList.add("hidden"));
        $("drConfirmCancel").addEventListener("click", () => $("drConfirmOverlay").classList.add("hidden"));
    }

    async function init(p) {
        project = p;
        can = await D().access(project.id);
        if (!can.view) return; // tabs stay hidden
        document.querySelectorAll('[data-acct-tab="draws"], [data-acct-tab="budget"]').forEach(b => { b.hidden = false; });
        if (window.AccountingTabs) window.AccountingTabs.refreshFromHash();
        await reload();
    }

    window.addEventListener("project-shell:ready", e => { const p = e.detail && e.detail.project; if (p) init(p); });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
