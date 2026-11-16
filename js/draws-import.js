/* ===========================================================
   DRAWS — import a project's budget from the AIA draw workbook (2026-11-16)

   Reads the Leeward AIA template's "Continuation Sheet" (same layout as
   Wrightsboro Business Park BLDGS 1-4): column B description, C total
   budget, D equity budget, E/F equity contributed, J/K loan drawn,
   L stored, M completed, P retainage.

   The top "PROJECT COST SUMMARY" block repeats the detail pages below it,
   so these rows are skipped to avoid counting things twice:
     - rows that say "(See detail …)"
     - summary hard-cost rows whose total matches a detail block's TOTALS row
     - "… Contingency" and "… Reclassified …" rows ("… Contingency
       Remaining" is the real line)
     - Total / Subtotal / TOTALS rows
   If the sheet's TOTAL PROJECT COSTS has a typed-in adjustment that isn't
   on any line (Wrightsboro: "+7795"), it becomes its own line so the
   budget still matches.

   window.DrawsImport.parse(file) → { groups, lines, grandTotal, linesTotal, adjustment, completed }
   window.DrawsImport.save(projectId, parsed, { throughDraw, periodTo })
=========================================================== */
(function () {
    "use strict";

    const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    const COL = { B: 1, C: 2, D: 3, E: 4, F: 5, J: 9, K: 10, L: 11, M: 12, P: 15 };
    const TOTAL_RE = /^(total|subtotal)\b|totals?\s*$|subtotals/i;
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const isNum = v => typeof v === "number" && Number.isFinite(v);
    const num = v => (isNum(v) ? v : 0);

    function loadXlsx() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = XLSX_URL;
            s.onload = () => resolve(window.XLSX);
            s.onerror = () => reject(new Error("Couldn't load the Excel reader."));
            document.head.appendChild(s);
        });
    }

    function titleCase(t) {
        return t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    async function parse(file) {
        const XLSX = await loadXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const name = wb.SheetNames.find(n => /continuation/i.test(n));
        if (!name) throw new Error("Couldn't find a \"Continuation Sheet\" tab in this workbook.");
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
        const headerRow = grid.findIndex(r => r && String(r[COL.B] || "").trim().toLowerCase() === "description of work");
        if (headerRow < 0) throw new Error("This doesn't look like the AIA draw template (no \"Description of Work\" column B).");

        const rows = grid.map((r, i) => ({
            i,
            desc: r && r[COL.B] != null ? String(r[COL.B]).trim() : "",
            C: r ? r[COL.C] : null, D: r ? r[COL.D] : null, E: r ? r[COL.E] : null, F: r ? r[COL.F] : null,
            J: r ? r[COL.J] : null, K: r ? r[COL.K] : null, L: r ? r[COL.L] : null, M: r ? r[COL.M] : null, P: r ? r[COL.P] : null
        })).slice(headerRow + 1);

        const detailTotals = []; // [{ i, C }] TOTALS rows after the summary block
        let grandRow = rows.find(r => /^total project costs/i.test(r.desc));
        const grandIndex = grandRow ? grandRow.i : Infinity;
        rows.forEach(r => { if (r.i > grandIndex && TOTAL_RE.test(r.desc) && isNum(r.C)) detailTotals.push(r); });

        const lines = [];
        const groupOrder = [];
        const groupMeta = new Map();
        let area = "summary", costType = "land", group = "Land", sub = "", lastHeader = "", lastWasTotal = false;

        const useGroup = (g, type) => {
            if (!groupMeta.has(g)) { groupMeta.set(g, { name: g, costType: type, subs: [] }); groupOrder.push(g); }
            return groupMeta.get(g);
        };

        for (const r of rows) {
            const hasNum = isNum(r.C);
            if (r.i === grandIndex) { area = "detail"; lastWasTotal = true; continue; }
            if (!r.desc && !hasNum) continue;
            if (TOTAL_RE.test(r.desc)) { lastWasTotal = true; continue; }
            const wasTotal = lastWasTotal;
            lastWasTotal = false;

            if (!hasNum) {
                const h = r.desc;
                if (area === "summary") {
                    const l = h.toLowerCase();
                    if (l.includes("hard")) { costType = "hard"; group = "Hard Costs"; }
                    else if (l.includes("soft")) { costType = "soft"; group = "Soft Costs"; }
                    else if (l.includes("interest") || l.includes("loan")) { costType = "finance"; group = "Finance Costs"; lastHeader = "Interest"; }
                    else if (l.includes("land")) { costType = "land"; group = "Land"; }
                    sub = "";
                } else {
                    costType = "hard";
                    if (/^\d\d\s/.test(h)) sub = h.replace(/\s+/g, " ").trim();
                    else if (wasTotal || /construction costs/i.test(h)) {
                        let g = h.replace(/\s*\(cont\w*\)\s*$/i, "").replace(/\s+construction costs$/i, "").trim();
                        group = g === g.toUpperCase() ? titleCase(g) : g;
                        sub = "";
                    }
                    // anything else with no budget is a zero line — skip
                }
                continue;
            }

            // a line with a budget number
            if (area === "summary") {
                if (/see detail/i.test(r.desc)) continue;
                if (costType === "hard" && detailTotals.some(t => Math.abs(num(t.C) - num(r.C)) < 0.005)) continue;
                if (/reclassified/i.test(r.desc)) continue;
                if (/contingency\s*$/i.test(r.desc)) continue;
            }
            const desc = r.desc || lastHeader || "Unnamed line";
            const M = num(r.M);
            const retPct = M > 0 && r.P != null ? r2((num(r.P) / M) * 100) : (r.P != null && costType === "hard" ? 5 : 0);
            const g = useGroup(group, costType);
            if (sub && !g.subs.includes(sub)) g.subs.push(sub);
            lines.push({
                group, sub, costType,
                description: desc.replace(/\s+/g, " "),
                total_budget: r2(num(r.C)),
                equity_budget: r2(num(r.D)),
                equity_to_date: r2(num(r.E) + num(r.F)),
                loan_to_date: r2(num(r.J) + num(r.K)),
                stored: r2(num(r.L)),
                retainage_pct: retPct,
                include: true
            });
        }

        const linesTotal = r2(lines.reduce((s, l) => s + l.total_budget, 0));
        const grandTotal = grandRow && isNum(grandRow.C) ? r2(grandRow.C) : null;
        let adjustment = 0;
        if (grandTotal != null && Math.abs(grandTotal - linesTotal) >= 0.01) {
            adjustment = r2(grandTotal - linesTotal);
            useGroup("Other", "soft");
            lines.push({
                group: "Other", sub: "", costType: "soft",
                description: "Workbook total adjustment",
                total_budget: adjustment,
                // Wrightsboro adds the same amount to the equity total (D49), so
                // the adjustment is equity and the loan budget stays put.
                equity_budget: grandRow && isNum(grandRow.D)
                    ? r2(Math.max(0, Math.min(adjustment, num(grandRow.D) - lines.reduce((s, l) => s + l.equity_budget, 0))))
                    : 0,
                equity_to_date: 0, loan_to_date: 0, stored: 0, retainage_pct: 0,
                include: true,
                isAdjustment: true
            });
        }

        return {
            groups: groupOrder.map(g => groupMeta.get(g)),
            lines,
            grandTotal,
            linesTotal,
            adjustment,
            completed: r2(lines.reduce((s, l) => s + l.equity_to_date + l.loan_to_date + l.stored, 0)),
            workbookCompleted: grandRow && isNum(grandRow.M) ? r2(grandRow.M) : null
        };
    }

    // Write sections, lines and the opening-balance draw.
    async function save(projectId, parsed, { throughDraw, periodTo }) {
        const sb = window.supabaseClient;
        const D = window.Draws;
        const lines = parsed.lines.filter(l => l.include);
        const sectionIds = new Map(); // "group" or "group|sub" → id
        let order = 0;

        for (const g of parsed.groups) {
            if (!lines.some(l => l.group === g.name)) continue;
            const { data, error } = await sb.from("budget_sections").insert({ project_id: projectId, name: g.name, cost_type: g.costType, sort_order: order++ }).select("id").single();
            if (error) throw error;
            sectionIds.set(g.name, data.id);
            for (const s of g.subs) {
                if (!lines.some(l => l.group === g.name && l.sub === s)) continue;
                const res = await sb.from("budget_sections").insert({ project_id: projectId, parent_id: data.id, name: s, cost_type: g.costType, sort_order: order++ }).select("id").single();
                if (res.error) throw res.error;
                sectionIds.set(`${g.name}|${s}`, res.data.id);
            }
        }

        const rows = lines.map((l, i) => ({
            project_id: projectId,
            section_id: sectionIds.get(l.sub ? `${l.group}|${l.sub}` : l.group) || sectionIds.get(l.group) || null,
            description: l.description,
            total_budget: l.total_budget,
            equity_budget: l.equity_budget,
            retainage_pct: l.retainage_pct,
            sort_order: i,
            source: "import",
            created_by: D.staffId(),
            created_by_name: D.staffName()
        }));
        const inserted = [];
        for (let i = 0; i < rows.length; i += 200) {
            const { data, error } = await sb.from("budget_lines").insert(rows.slice(i, i + 200)).select("id, sort_order");
            if (error) throw error;
            inserted.push(...data);
        }
        const idByOrder = new Map(inserted.map(x => [x.sort_order, x.id]));

        const hasHistory = lines.some(l => l.equity_to_date || l.loan_to_date || l.stored);
        if (hasHistory && throughDraw > 0) {
            const { data: draw, error } = await sb.from("draws").insert({
                project_id: projectId,
                draw_number: throughDraw,
                draw_label: throughDraw > 1 ? `#1–${throughDraw}` : "#1",
                period_to: periodTo || null,
                status: "funded",
                is_opening_balance: true,
                notes: "Imported from the AIA workbook",
                created_by: D.staffId(),
                created_by_name: D.staffName()
            }).select("id").single();
            if (error) throw error;
            const dl = lines.map((l, i) => ({
                draw_id: draw.id,
                budget_line_id: idByOrder.get(i),
                equity_this_period: l.equity_to_date,
                loan_this_period: l.loan_to_date,
                stored_materials: l.stored
            })).filter(x => x.budget_line_id && (x.equity_this_period || x.loan_this_period || x.stored_materials));
            for (let i = 0; i < dl.length; i += 200) {
                const res = await sb.from("draw_lines").insert(dl.slice(i, i + 200));
                if (res.error) throw res.error;
            }
        }
        return { lines: inserted.length };
    }

    window.DrawsImport = { parse, save, loadXlsx };
})();
