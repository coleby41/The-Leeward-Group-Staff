/* ===========================================================
   DRAWS — PDF + Excel for a draw (2026-11-16)

   Numbers only (no lender, architect or notary blocks):
     page 1  Application for Payment — the summary lines 1–9
     page 2+ Continuation Sheet — every budget line, grouped
   Excel has the same two sheets with the workbook's column letters.

   window.DrawsExport.pdf(project, state, draw)   → Blob
   window.DrawsExport.xlsx(project, state, draw)  → Blob
   window.DrawsExport.fileName(project, draw, ext)
=========================================================== */
(function () {
    "use strict";

    const PDFMAKE = "https://cdn.jsdelivr.net/npm/pdfmake@0.3.10/build/pdfmake.min.js";
    const PDFMAKE_FONTS = "https://cdn.jsdelivr.net/npm/pdfmake@0.3.10/build/vfs_fonts.js";

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error("Couldn't load " + src));
            document.head.appendChild(s);
        });
    }
    async function pdfMake() {
        if (!window.pdfMake) await loadScript(PDFMAKE);
        if (!window.pdfMake.vfs || !Object.keys(window.pdfMake.vfs).length) await loadScript(PDFMAKE_FONTS);
        return window.pdfMake;
    }

    const m = n => window.Draws.money(n);
    const pct = n => `${Math.round((Number(n) || 0) * 100)}%`;

    function drawLabel(draw) {
        return draw.is_opening_balance ? (draw.draw_label || `#1–${draw.draw_number}`) : `#${draw.draw_number}`;
    }

    function fileName(project, draw, ext) {
        const clean = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
        const period = draw.period_to ? ` ${draw.period_to}` : "";
        return `${clean(project.name)} - Draw ${draw.draw_number}${period}.${ext}`;
    }

    function shortDate(iso) {
        if (!iso) return "—";
        return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    }

    /* ---------- PDF ---------- */

    async function pdf(project, state, draw) {
        const pm = await pdfMake();
        const sh = window.Draws.sheet(state, draw.id);
        const s = sh.summary;

        const summaryRows = [
            ["1. Contract sum (total budget)", m(s.contract)],
            ["2. Total completed & stored to date", m(s.completedStored)],
            ["3. Retainage", m(s.retainage)],
            ["4. Total earned less retainage", m(s.earnedLessRetainage)],
            ["5. Less previous draws", m(s.previousCertificates)],
            [{ text: "6. Current payment due", bold: true }, { text: m(s.currentPaymentDue), bold: true }],
            ["7. Balance to finish, including retainage", m(s.balanceToFinish)],
            [" ", " "],
            ["Work this period", m(s.thisPeriod)],
            ["   from equity", m(s.equityThisPeriod)],
            ["   from loan", m(s.loanThisPeriod)]
        ];

        const head = ["Description of work", "Budget", "Equity budget", "Loan budget", "Previous", "This period", "Stored", "Completed to date", "%", "Balance", "Retainage"]
            .map(t => ({ text: t, style: "th" }));
        const body = [head];
        sh.groups.forEach(g => {
            body.push([{ text: g.name, bold: true, colSpan: 11, fillColor: "#eef2f6" }, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}]);
            g.rows.forEach(r => body.push([
                (r.line.subName ? r.line.subName + " · " : "") + r.line.description,
                m(r.line.total_budget), m(r.line.equity_budget), m(r.line.loan_budget),
                m(r.previous), m(r.thisPeriod), m(r.stored), m(r.completed), pct(r.percent), m(r.balance), m(r.retainage)
            ].map((v, i) => (i ? { text: v, alignment: "right" } : v))));
            const t = g.totals;
            body.push([`${g.name} total`, m(t.total), m(t.equity), m(t.loan), m(t.previous), m(t.thisPeriod), m(t.stored), m(t.completed), pct(t.percent), m(t.balance), m(t.retainage)]
                .map((v, i) => ({ text: v, bold: true, alignment: i ? "right" : "left" })));
        });
        const T = sh.totals;
        body.push(["Total project", m(T.total), m(T.equity), m(T.loan), m(T.previous), m(T.thisPeriod), m(T.stored), m(T.completed), pct(T.percent), m(T.balance), m(T.retainage)]
            .map((v, i) => ({ text: v, bold: true, alignment: i ? "right" : "left", fillColor: "#dfe7ee" })));

        const doc = {
            pageSize: "LETTER",
            pageOrientation: "landscape",
            pageMargins: [28, 36, 28, 36],
            defaultStyle: { fontSize: 8 },
            styles: { h1: { fontSize: 16, bold: true }, sub: { fontSize: 10, color: "#5f6e7d" }, th: { bold: true, fontSize: 7.5, color: "#14263a", fillColor: "#e7eef3" } },
            footer: (page, pages) => ({ text: `${project.name} · Draw ${drawLabel(draw)} · page ${page} of ${pages}`, alignment: "center", fontSize: 7, color: "#8a96a3", margin: [0, 10, 0, 0] }),
            content: [
                { text: "Application for Payment", style: "h1" },
                { text: `${project.name} · Draw ${drawLabel(draw)} · Period to ${shortDate(draw.period_to)}`, style: "sub", margin: [0, 2, 0, 16] },
                { table: { widths: [260, 120], body: summaryRows.map(r => [r[0], typeof r[1] === "object" ? { ...r[1], alignment: "right" } : { text: r[1], alignment: "right" }]) }, layout: "lightHorizontalLines", fontSize: 10 },
                { text: "Continuation Sheet", style: "h1", pageBreak: "before", margin: [0, 0, 0, 8] },
                { table: { headerRows: 1, widths: ["*", 52, 52, 52, 52, 52, 44, 56, 26, 52, 46], body }, layout: "lightHorizontalLines" }
            ]
        };
        return pm.createPdf(doc).getBlob(); // pdfmake 0.3 returns a Promise (same as companies.js)
    }

    /* ---------- Excel ---------- */

    async function xlsx(project, state, draw) {
        const XLSX = await window.DrawsImport.loadXlsx();
        const sh = window.Draws.sheet(state, draw.id);
        const s = sh.summary;
        const summary = [
            ["APPLICATION FOR PAYMENT"],
            ["Project", project.name],
            ["Draw", drawLabel(draw)],
            ["Period to", draw.period_to || ""],
            [],
            ["1. Contract sum (total budget)", s.contract],
            ["2. Total completed & stored to date", s.completedStored],
            ["3. Retainage", s.retainage],
            ["4. Total earned less retainage", s.earnedLessRetainage],
            ["5. Less previous draws", s.previousCertificates],
            ["6. Current payment due", s.currentPaymentDue],
            ["7. Balance to finish, including retainage", s.balanceToFinish],
            [],
            ["Work this period", s.thisPeriod],
            ["   from equity", s.equityThisPeriod],
            ["   from loan", s.loanThisPeriod]
        ];
        const cont = [[
            "Item", "Description of Work", "Total Project Cost", "Equity Budget", "Equity from Prior Draws", "Equity Draw This Period",
            "Equity % Contributed", "Equity Left", "Loan Budget", "Loan from Previous Draws", "Loan Draw This Period",
            "Materials Presently Stored", "Total Completed and Stored", "% Complete", "Balance to Finish", "Retainage"
        ]];
        let item = 1;
        sh.groups.forEach(g => {
            cont.push(["", g.name.toUpperCase()]);
            g.rows.forEach(r => {
                const eqTotal = r.equityPrev + r.equityNow;
                cont.push([
                    item++, (r.line.subName ? r.line.subName + " · " : "") + r.line.description,
                    r.line.total_budget, r.line.equity_budget, r.equityPrev, r.equityNow,
                    r.line.equity_budget ? eqTotal / r.line.equity_budget : "", window.Draws.r2(r.line.equity_budget - eqTotal),
                    r.line.loan_budget, r.loanPrev, r.loanNow, r.stored, r.completed, r.percent, r.balance, r.retainage
                ]);
            });
            const t = g.totals;
            cont.push(["", `${g.name} total`, t.total, t.equity, "", t.equityNow, "", "", t.loan, "", t.loanNow, t.stored, t.completed, t.percent, t.balance, t.retainage]);
            cont.push([]);
        });
        const T = sh.totals;
        cont.push(["", "TOTAL PROJECT COSTS", T.total, T.equity, "", T.equityNow, "", "", T.loan, "", T.loanNow, T.stored, T.completed, T.percent, T.balance, T.retainage]);

        const wb = XLSX.utils.book_new();
        const ws1 = XLSX.utils.aoa_to_sheet(summary);
        ws1["!cols"] = [{ wch: 42 }, { wch: 18 }];
        const ws2 = XLSX.utils.aoa_to_sheet(cont);
        ws2["!cols"] = [{ wch: 6 }, { wch: 48 }, ...Array(14).fill({ wch: 15 })];
        // money / percent formats
        const range = XLSX.utils.decode_range(ws2["!ref"]);
        for (let R = 1; R <= range.e.r; R++) {
            for (let C = 2; C <= 15; C++) {
                const cell = ws2[XLSX.utils.encode_cell({ r: R, c: C })];
                if (cell && typeof cell.v === "number") cell.z = (C === 6 || C === 13) ? "0%" : "#,##0.00";
            }
        }
        for (let R = 5; R < summary.length; R++) {
            const cell = ws1[XLSX.utils.encode_cell({ r: R, c: 1 })];
            if (cell && typeof cell.v === "number") cell.z = "$#,##0.00";
        }
        XLSX.utils.book_append_sheet(wb, ws1, "Application for Payment");
        XLSX.utils.book_append_sheet(wb, ws2, "Continuation Sheet");
        const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }

    // Save both files to Project Files › 07 Financial › Draws; returns { pdfId, xlsxId }.
    async function fileToProject(project, state, draw) {
        const sb = window.supabaseClient;
        const out = {};
        for (const [ext, make] of [["pdf", pdf], ["xlsx", xlsx]]) {
            const blob = await make(project, state, draw);
            const name = fileName(project, draw, ext);
            const file = new File([blob], name, { type: blob.type });
            const path = await window.ProjectFields.uploadFile(project.id, file, null, { pathSegments: ["financial", "draws"] });
            const { data, error } = await sb.from("project_files").insert({
                project_id: project.id, category: "financial", subfolder: "draws", sub_subfolder: null,
                bucket: "project-documents", storage_path: path, file_name: name, source: "upload",
                uploaded_by_name: window.Draws.staffName()
            }).select("id").single();
            if (error) throw error;
            out[ext === "pdf" ? "pdfId" : "xlsxId"] = data.id;
        }
        return out;
    }

    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        if (window.FilePreview && window.FilePreview.download) window.FilePreview.download(url, name);
        else { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    window.DrawsExport = { pdf, xlsx, fileToProject, fileName, download, drawLabel };
})();
