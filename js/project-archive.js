/* ===========================================================
   PROJECT ARCHIVE OFFLOAD (pages/projects.html) — 2026-11-17

   When a project has been archived for a year, IT and Super Admin see a
   banner on its Overview: "ready to offload". Download project archive
   builds ONE zip with everything in the project, to save on a hard drive:
     Files/<01 Acquisition…>/<subfolder>/…  every Project Files file
     Records/*.pdf                           the project's records, one PDF each
     Archive summary.pdf                     what's inside + when
   After the download, "I saved it" marks the project offloaded (nothing is
   deleted — it stays in the portal).

   The nightly notification to IT is sql/supabase-project-archive-offload.sql.
=========================================================== */
(function () {
    "use strict";

    const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    const YEAR_MS = 365 * 86400000;
    // One WD My Passport Ultra 2TB (USB-C) per project — Coleby, 2026-11-17
    const DRIVE_URL = "https://a.co/d/09HtRtIx";

    // Every kind of record → Records/<label>.pdf (Coleby: PDFs, no CSVs).
    // cols: [column, heading, format]. Formats: date, money, yesno, pct, text.
    const RECORDS = [
        { table: "schedule_phases", label: "Timeline phases", cols: [["name", "Phase"], ["phase_type", "Type"], ["description", "Description"]] },
        { table: "schedule_tasks", label: "Timeline", landscape: true, cols: [["name", "Task"], ["item_type", "Type"], ["start_date", "Start", "date"], ["end_date", "End", "date"], ["plan_end_date", "Planned end", "date"], ["status", "Status"], ["progress_percent", "Done", "pct"], ["assigned_user_name", "Assigned to"], ["contractor_name", "Contractor"]] },
        { table: "project_contacts", label: "Contacts", landscape: true, cols: [["contact_type", "Type"], ["full_name", "Name"], ["title", "Title"], ["company_name", "Company"], ["phone", "Phone"], ["email", "Email"], ["notes", "Notes"]] },
        { table: "project_utility_accounts", label: "Utility accounts", landscape: true, cols: [["utility_type", "Utility"], ["provider_name", "Provider"], ["account_number", "Account #"], ["service_address", "Service address"], ["meter_number", "Meter #"], ["status", "Status"], ["start_date", "Start", "date"], ["close_date", "Closed", "date"]] },
        { table: "vendor_project_assignments", label: "Vendors on project", cols: [["company_name", "Vendor"], ["scope", "Scope"], ["coi_requested_at", "COI requested", "date"], ["coi_received_at", "COI received", "date"]] },
        { table: "project_vendor_contracts", label: "Vendor contracts", cols: [["company_name", "Vendor"], ["signed_at", "Signed", "date"], ["signer_name", "Signed by"], ["not_needed", "Not needed", "yesno"]] },
        { table: "project_invoices", label: "Invoices", landscape: true, cols: [["invoice_date", "Date", "date"], ["vendor_name", "Vendor"], ["invoice_number", "Invoice #"], ["description", "Description"], ["total_due", "Total due", "money"], ["paid", "Paid", "yesno"]], total: "total_due" },
        { table: "vpos", label: "VPOs", landscape: true, cols: [["vpo_number", "VPO #"], ["report_date", "Date", "date"], ["vendor_name", "Vendor"], ["change_in_scope", "Change in scope"], ["price", "Price", "money"]], total: "price" },
        { table: "back_charges", label: "Back charges", landscape: true, cols: [["bc_number", "BC #"], ["report_date", "Date", "date"], ["vendor_to_charge_name", "Charged to"], ["vendor_to_cr_back_name", "Credited back to"], ["price", "Amount", "money"]], total: "price" },
        { table: "incident_reports", label: "Incident reports", landscape: true, cols: [["ir_number", "IR #"], ["report_date", "Date", "date"], ["person_making_report", "Reported by"], ["reason_for_report", "Reason"], ["change_in_scope", "Change in scope"], ["price", "Price", "money"], ["status", "Status"]] },
        { table: "bid_packages", label: "Bid packages", cols: [["name", "Package"], ["trade_tag_name", "Trade"], ["status", "Status"], ["due_at", "Due", "date"], ["awarded_at", "Awarded", "date"]] },
        { table: "budget_lines", label: "Budget", cols: [["description", "Line"], ["total_budget", "Budget", "money"], ["equity_budget", "Equity", "money"], ["retainage_pct", "Retainage", "pct"]], total: "total_budget" },
        { table: "draws", label: "Draws", cols: [["draw_number", "Draw"], ["period_to", "Period to", "date"], ["status", "Status"], ["submitted_at", "Submitted", "date"], ["funded_at", "Funded", "date"]] },
        { table: "project_todo_items", label: "To-do items", cols: [["title", "Item"], ["created_by_name", "Added by"], ["created_at", "Added", "date"]] },
        { table: "project_members", label: "Project team", cols: [["staff_name", "Name"], ["role", "Role"], ["can_view_financials", "Sees financials", "yesno"]] },
        { table: "project_files", label: "File list", landscape: true, cols: [["folder", "Folder"], ["file_name", "File"], ["uploaded_by_name", "Uploaded by"], ["created_at", "Uploaded", "date"]] }
        // (form submissions are filed into Project Files, so they come along with Files/)
    ];

    let project = null;

    function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
    function profile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile")); } catch (e) { return null; }
    }
    function isIt() {
        const p = profile();
        return Boolean(p && window.isSupabaseUserInGroup && (window.isSupabaseUserInGroup(p, "IT") || window.isSupabaseUserInGroup(p, "Super Admin")));
    }
    function niceDate(iso) {
        return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    }
    function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || "untitled"; }

    function loadJsZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = JSZIP_URL;
            s.onload = () => resolve(window.JSZip);
            s.onerror = () => reject(new Error("Couldn't load the zip tool."));
            document.head.appendChild(s);
        });
    }

    /* ---------- banner ---------- */

    function render() {
        const el = document.getElementById("povArchiveBanner");
        if (!el) return;
        const archivedAt = project && project.status === "archived" && project.archived_at;
        if (!archivedAt || !isIt()) { el.hidden = true; return; }
        const ready = Date.now() - new Date(archivedAt).getTime() >= YEAR_MS;
        if (!ready && !project.offloaded_at) { el.hidden = true; return; }

        el.hidden = false;
        el.innerHTML = project.offloaded_at
            ? `<div><strong>Ready to be deleted</strong>
                 <p>Offloaded ${esc(niceDate(project.offloaded_at))}${project.offloaded_by_name ? " by " + esc(project.offloaded_by_name) : ""} — the archive zip is saved to the hard drive, so this project can be deleted from the portal.</p></div>
               <button type="button" class="pov-link-muted pov-archive-btn" data-arch="download">Save again</button>`
            : `<div><strong>Ready to offload data</strong>
                 <p>Archived since ${esc(niceDate(archivedAt))}. Download the project archive and save it to the hard drive.</p></div>
               <div class="pov-archive-actions">
                   <a class="pov-link-muted pov-archive-btn" href="${DRIVE_URL}" target="_blank" rel="noopener">Buy a hard drive ↗</a>
                   <button type="button" class="auth-button pov-btn" data-arch="download">${typeof window.showDirectoryPicker === "function" ? "Save to hard drive" : "Download project archive"}</button>
               </div>`;
    }

    /* ---------- the zip ---------- */

    const PDFMAKE = "https://cdn.jsdelivr.net/npm/pdfmake@0.3.10/build/pdfmake.min.js";
    const PDFMAKE_FONTS = "https://cdn.jsdelivr.net/npm/pdfmake@0.3.10/build/vfs_fonts.js";
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement("script");
            el.src = src; el.onload = resolve; el.onerror = () => reject(new Error("Couldn't load " + src));
            document.head.appendChild(el);
        });
    }
    async function pdfMake() {
        if (!window.pdfMake) await loadScript(PDFMAKE);
        if (!window.pdfMake.vfs || !Object.keys(window.pdfMake.vfs).length) await loadScript(PDFMAKE_FONTS);
        return window.pdfMake;
    }

    function fmt(v, kind) {
        if (v === null || v === undefined || v === "") return "";
        if (kind === "date") { const d = new Date(String(v).length === 10 ? v + "T00:00:00" : v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
        if (kind === "money") return (Number(v) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
        if (kind === "yesno") return v ? "Yes" : "No";
        if (kind === "pct") return `${Number(v) || 0}%`;
        if (typeof v === "string") return v.replace(/_/g, (m, i, str) => (/^[a-z_]+$/.test(str) ? " " : m)); // not_started → not started
        return String(v);
    }

    function docBase(title, landscape) {
        const p = profile();
        return {
            pageSize: "LETTER",
            pageOrientation: landscape ? "landscape" : "portrait",
            pageMargins: [36, 40, 36, 40],
            defaultStyle: { fontSize: 9, color: "#14263a" },
            styles: { h1: { fontSize: 16, bold: true }, sub: { fontSize: 9, color: "#5f6e7d" }, th: { bold: true, fontSize: 8.5, fillColor: "#e7eef3" } },
            footer: (page, pages) => ({ text: `${project.name} · ${title} · page ${page} of ${pages}`, alignment: "center", fontSize: 7, color: "#8a96a3", margin: [0, 12, 0, 0] }),
            content: [
                { text: title, style: "h1" },
                { text: `${project.name} · exported ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} by ${(p && (p.full_name || p.username)) || "staff"}`, style: "sub", margin: [0, 2, 0, 14] }
            ]
        };
    }

    async function tablePdf(spec, rows) {
        const pm = await pdfMake();
        const doc = docBase(spec.label, spec.landscape);
        const head = spec.cols.map(c => ({ text: c[1], style: "th", alignment: c[2] === "money" ? "right" : "left" }));
        const body = [head, ...rows.map(r => spec.cols.map(c => ({ text: fmt(r[c[0]], c[2]), alignment: c[2] === "money" ? "right" : "left" })))];
        if (spec.total) {
            const sum = rows.reduce((t, r) => t + (Number(r[spec.total]) || 0), 0);
            body.push(spec.cols.map((c, i) => ({ text: i === 0 ? "Total" : c[0] === spec.total ? fmt(sum, "money") : "", bold: true, alignment: c[0] === spec.total ? "right" : "left" })));
        }
        doc.content.push({ text: `${rows.length} ${rows.length === 1 ? "record" : "records"}`, style: "sub", margin: [0, 0, 0, 6] });
        doc.content.push({ table: { headerRows: 1, widths: spec.cols.map((c, i) => (i === 0 ? "*" : "auto")), body }, layout: "lightHorizontalLines" });
        return pm.createPdf(doc).getBlob();
    }

    async function projectInfoPdf(p) {
        const pm = await pdfMake();
        const doc = docBase("Project info", false);
        const skip = /^(id|.*_id|.*_path|cover_photo_url)$/;
        const rows = Object.keys(p).filter(k => !skip.test(k) && p[k] !== null && p[k] !== "" && typeof p[k] !== "object")
            .map(k => [{ text: k.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()), color: "#5f6e7d" }, fmt(p[k], /(_at|_date)$/.test(k) ? "date" : /(value|amount|spent)/.test(k) ? "money" : "")]);
        doc.content.push({ table: { widths: [170, "*"], body: rows }, layout: "lightHorizontalLines" });
        return pm.createPdf(doc).getBlob();
    }

    async function summaryPdf(lines) {
        const pm = await pdfMake();
        const doc = docBase("Archive summary", false);
        lines.forEach(l => doc.content.push(typeof l === "string" ? { text: l, margin: [0, 0, 0, 4] } : l));
        return pm.createPdf(doc).getBlob();
    }

    async function fetchAll(table, column, value) {
        const sb = window.supabaseClient;
        const out = [];
        for (let from = 0; ; from += 1000) {
            const { data, error } = await sb.from(table).select("*").eq(column, value).range(from, from + 999);
            if (error) return { rows: out, error };
            out.push(...(data || []));
            if (!data || data.length < 1000) return { rows: out };
        }
    }

    function folderFor(file) {
        const PF = window.ProjectFields || {};
        const cat = (PF.PROJECT_FILE_CATEGORIES || []).find(c => c.key === file.category);
        const catName = cat ? `${cat.number} ${cat.label}` : (file.category || "Other");
        const sub = cat && (cat.subfolders || []).find(s => s.key === file.subfolder);
        const subName = sub ? sub.label : (file.subfolder || "");
        const subSub = sub && file.sub_subfolder ? ((sub.subfolders || sub.children || []).find(x => x.key === file.sub_subfolder) || {}).label || file.sub_subfolder : (file.sub_subfolder || "");
        return ["Files", catName, subName, subSub].filter(Boolean).map(safeName).join("/");
    }

    function setProgress(text) {
        const el = document.getElementById("povArchiveProgress");
        if (el) el.textContent = text;
    }

    // Gathers everything and hands each file to put(path, data) — a zip, or
    // the hard drive itself (writeToDrive). Returns counts for the summary.
    async function collect(put) {
        const sb = window.supabaseClient;
        const problems = [];

        // Records → Records/<label>.pdf
        const counts = [];
        setProgress("Exporting project info…");
        await put("Records/Project info.pdf", await projectInfoPdf(project));
        const companyName = new Map();
        async function namesFor(ids) {
            const need = [...new Set(ids.filter(id => id && !companyName.has(id)))];
            if (!need.length) return;
            const { data } = await sb.from("Companies").select("id, Name").in("id", need);
            (data || []).forEach(c => companyName.set(c.id, c.Name));
        }
        for (const spec of RECORDS) {
            setProgress(`Exporting ${spec.label.toLowerCase()}…`);
            let { rows, error } = await fetchAll(spec.table, "project_id", project.id);
            if (error) { if (!/does not exist|schema cache/i.test(error.message || "")) problems.push(`${spec.label}: ${error.message}`); continue; }
            if (!rows.length) continue;
            if (spec.table === "vendor_project_assignments" || spec.table === "project_vendor_contracts") {
                await namesFor(rows.map(r => r.company_id));
                rows = rows.map(r => ({ ...r, company_name: companyName.get(r.company_id) || "" }));
            }
            if (spec.table === "project_members") {
                const { data } = await sb.from("staff_users").select("full_name, auth_user_id").in("auth_user_id", rows.map(r => r.user_id));
                const byAuth = new Map((data || []).map(x => [x.auth_user_id, x.full_name]));
                rows = rows.map(r => ({ ...r, staff_name: byAuth.get(r.user_id) || "" }));
            }
            if (spec.table === "project_files") rows = rows.map(r => ({ ...r, folder: folderFor(r).replace(/^Files\//, "") }));
            await put(`Records/${spec.label}.pdf`, await tablePdf(spec, rows));
            counts.push(`${spec.label}: ${rows.length}`);
            if (spec.table === "bid_packages") {
                const ids = rows.map(r => r.id);
                const inv = ids.length ? await sb.from("bid_invites").select("*").in("package_id", ids) : { data: [] };
                if (inv.data && inv.data.length) {
                    const pkg = new Map(rows.map(r => [r.id, r.name]));
                    const spec2 = { label: "Bid invites", landscape: true, cols: [["package", "Package"], ["company_name", "Vendor"], ["status", "Status"], ["sent_at", "Sent", "date"], ["responded_at", "Replied", "date"], ["bid_amount", "Bid", "money"]] };
                    await put("Records/Bid invites.pdf", await tablePdf(spec2, inv.data.map(x => ({ ...x, package: pkg.get(x.package_id) || "" }))));
                    counts.push(`Bid invites: ${inv.data.length}`);
                }
            }
        }

        // Files
        const { rows: files } = await fetchAll("project_files", "project_id", project.id);
        const used = new Set();
        let done = 0, bytes = 0;
        for (const f of files) {
            done++;
            setProgress(`Downloading file ${done} of ${files.length}…`);
            try {
                const { data, error } = await sb.storage.from(f.bucket || "project-documents").download(f.storage_path);
                if (error || !data) throw error || new Error("not found");
                let path = `${folderFor(f)}/${safeName(f.file_name)}`;
                // two files with the same name in one folder → "name (2).pdf"
                for (let n = 2; used.has(path.toLowerCase()); n++) path = path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
                used.add(path.toLowerCase());
                await put(path, data);
                bytes += data.size || 0;
            } catch (e) {
                problems.push(`File "${f.file_name}" (${f.storage_path}): couldn't download`);
            }
        }
        if (project.cover_photo_url) {
            try {
                const res = await fetch(project.cover_photo_url);
                if (res.ok) await put(`Files/Cover photo${(project.cover_photo_url.match(/\.[a-z0-9]+(?=$|\?)/i) || [".jpg"])[0]}`, await res.blob());
            } catch (e) { /* cover photo is optional */ }
        }

        const p = profile();
        const okFiles = files.length - problems.filter(x => x.startsWith("File ")).length;
        await put("Archive summary.pdf", await summaryPdf([
            project.archived_at ? `Archived in the portal since ${niceDate(project.archived_at)}.` : "",
            { text: "What's in this folder", bold: true, margin: [0, 8, 0, 4] },
            "Files — every file from Project Files, in the same folders as the portal.",
            "Records — the project's records as PDF tables (timeline, contacts, invoices, VPOs, bids, budget, draws and more).",
            { text: "Counts", bold: true, margin: [0, 8, 0, 4] },
            `Files: ${okFiles} of ${files.length} (${(bytes / 1048576).toFixed(1)} MB)`,
            ...counts,
            ...(problems.length ? [{ text: "Couldn't include", bold: true, color: "#9c3c3c", margin: [0, 8, 0, 4] }, ...problems] : [])
        ].filter(Boolean)));

        return { problems, fileCount: files.length, bytes };
    }

    async function buildZip() {
        const JSZip = await loadJsZip();
        const zip = new JSZip();
        const res = await collect(async (path, data) => { zip.file(path, data); });
        setProgress("Zipping…");
        const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 3 } },
            meta => setProgress(`Zipping… ${Math.round(meta.percent)}%`));
        return { ...res, blob };
    }

    /* ---------- straight to the hard drive (Chrome / Edge) ----------
       The File System Access API lets the page write into a folder the
       person picks — the hard drive. Each file is written as soon as it
       downloads, so nothing big is held in memory and there's no zip to
       move afterwards. Safari / Firefox don't have it → zip fallback. */

    const canWriteToDrive = () => typeof window.showDirectoryPicker === "function";
    let driveHandle = null;

    async function pickDrive() {
        driveHandle = await window.showDirectoryPicker({ id: "project-archive", mode: "readwrite", startIn: "desktop" });
        return driveHandle;
    }

    async function writeToDrive(root) {
        const folderName = `${safeName(project.name)} - project archive ${new Date().toISOString().slice(0, 10)}`;
        const top = await root.getDirectoryHandle(folderName, { create: true });
        const dirs = new Map([["", top]]);
        async function dirFor(path) {
            if (dirs.has(path)) return dirs.get(path);
            const i = path.lastIndexOf("/");
            const parent = await dirFor(i < 0 ? "" : path.slice(0, i));
            const h = await parent.getDirectoryHandle(path.slice(i + 1), { create: true });
            dirs.set(path, h);
            return h;
        }
        const res = await collect(async (path, data) => {
            const i = path.lastIndexOf("/");
            const dir = await dirFor(i < 0 ? "" : path.slice(0, i));
            const fh = await dir.getFileHandle(path.slice(i + 1), { create: true });
            const w = await fh.createWritable();
            await w.write(data);
            await w.close();
        });
        return { ...res, folderName, driveName: root.name };
    }

    async function download() {
        const overlay = document.getElementById("povArchiveOverlay");
        overlay.classList.remove("hidden");
        document.getElementById("povArchiveConfirm").hidden = true;
        document.getElementById("povArchiveClose").disabled = true;
        setProgress("Starting…");
        if (driveHandle) {
            try {
                const r = await writeToDrive(driveHandle);
                setProgress(`Saved to "${r.driveName}" › "${r.folderName}" — ${r.fileCount} file${r.fileCount === 1 ? "" : "s"}, ${(r.bytes / 1048576).toFixed(1)} MB.` +
                    (r.problems.length ? ` ${r.problems.length} item${r.problems.length === 1 ? "" : "s"} couldn't be included (listed in Archive summary.pdf on the drive).` : "") +
                    (project.offloaded_at ? "" : " Check the folder on the drive, then click I saved it."));
                document.getElementById("povArchiveConfirm").hidden = Boolean(project.offloaded_at);
            } catch (e) {
                console.error("Writing to the drive failed:", e);
                setProgress(`Couldn't write to the drive: ${e.message || e}. Make sure it's plugged in and has room, then try again.`);
            } finally {
                driveHandle = null;
                document.getElementById("povArchiveClose").disabled = false;
            }
            return;
        }
        try {
            const { blob, problems, fileCount } = await buildZip();
            const name = `${safeName(project.name)} - project archive ${new Date().toISOString().slice(0, 10)}.zip`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 120000);
            setProgress(`Downloaded "${name}" — ${fileCount} file${fileCount === 1 ? "" : "s"}, ${(blob.size / 1048576).toFixed(1)} MB.` +
                (problems.length ? ` ${problems.length} item${problems.length === 1 ? "" : "s"} couldn't be included (listed in Archive summary.pdf).` : "") +
                (project.offloaded_at ? "" : " Once it's saved to the hard drive, click I saved it."));
            document.getElementById("povArchiveConfirm").hidden = Boolean(project.offloaded_at);
        } catch (e) {
            console.error("Archive export failed:", e);
            setProgress(`Couldn't build the archive: ${e.message || e}. A very large project may be too big for the browser in one zip.`);
        } finally {
            document.getElementById("povArchiveClose").disabled = false;
        }
    }

    async function markOffloaded() {
        const p = profile();
        const by = (p && (p.full_name || p.username)) || "Staff";
        const { error } = await window.supabaseClient.from("projects").update({ offloaded_at: new Date().toISOString(), offloaded_by_name: by }).eq("id", project.id);
        if (error) { setProgress("Couldn't mark it offloaded: " + error.message); return; }
        project.offloaded_at = new Date().toISOString();
        project.offloaded_by_name = by;
        document.getElementById("povArchiveOverlay").classList.add("hidden");
        render();
        if (window.showToast) window.showToast("Marked offloaded — the project is ready to be deleted.", "success");
    }

    function wire() {
        document.addEventListener("click", e => {
            const b = e.target.closest("[data-arch]");
            if (b && b.dataset.arch === "download") {
                const g = document.getElementById("povDriveOverlay");
                g.dispatchEvent(new Event("guide:open"));
                g.classList.remove("hidden");
            }
        });
        document.getElementById("povArchiveClose").addEventListener("click", () => document.getElementById("povArchiveOverlay").classList.add("hidden"));
        document.getElementById("povArchiveConfirm").addEventListener("click", markOffloaded);
        // Step-by-step guide → pick the drive → write straight to it
        // (zip download instead on browsers without folder access).
        const guide = document.getElementById("povDriveOverlay");
        let step = 0;
        const steps = () => [...guide.querySelectorAll("[data-guide-step]")];
        function showStep(n) {
            const all = steps();
            step = Math.max(0, Math.min(all.length - 1, n));
            all.forEach((el, i) => { el.hidden = i !== step; });
            guide.querySelectorAll("[data-guide-dot]").forEach((d, i) => d.classList.toggle("is-on", i <= step));
            document.getElementById("povGuideStep").textContent = `Step ${step + 1} of ${all.length}`;
            document.getElementById("povGuideBack").style.visibility = step ? "visible" : "hidden";
            const last = step === all.length - 1;
            document.getElementById("povGuideNext").hidden = last;
            document.getElementById("povGuidePick").hidden = !last;
        }
        guide.addEventListener("guide:open", () => {
            document.getElementById("povGuideNoSupport").hidden = canWriteToDrive();
            document.getElementById("povGuidePick").textContent = canWriteToDrive() ? "Choose hard drive" : "Download zip instead";
            document.getElementById("povGuideMsg").textContent = "";
            showStep(0);
        });
        document.getElementById("povGuideNext").addEventListener("click", () => showStep(step + 1));
        document.getElementById("povGuideBack").addEventListener("click", () => showStep(step - 1));
        document.getElementById("povDriveCancel").addEventListener("click", () => guide.classList.add("hidden"));
        document.getElementById("povGuideX").addEventListener("click", () => guide.classList.add("hidden"));
        document.getElementById("povGuidePick").addEventListener("click", async () => {
            if (canWriteToDrive()) {
                try { await pickDrive(); }
                catch (e) {
                    if (e && e.name === "AbortError") return; // closed the picker
                    document.getElementById("povGuideMsg").textContent = "That folder can't be used. Pick the hard drive itself, or a folder on it.";
                    return;
                }
            }
            guide.classList.add("hidden");
            download();
        });
    }

    window.addEventListener("project-shell:ready", e => {
        project = e.detail && e.detail.project;
        // profile may arrive a beat after the project — retry briefly
        let tries = 0;
        (function tick() { render(); if (!profile() && tries++ < 25) setTimeout(tick, 200); })();
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
