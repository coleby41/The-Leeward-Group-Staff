/* ===========================================================
   PROJECT ARCHIVE OFFLOAD (pages/projects.html) — 2026-11-17

   When a project has been archived for a year, IT and Super Admin see a
   banner on its Overview: "ready to offload". Download project archive
   builds ONE zip with everything in the project, to save on a hard drive:
     Files/<01 Acquisition…>/<subfolder>/…  every Project Files file
     Data/*.csv                              the project's records
     README.txt                              what's inside + when
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

    // Every table that holds this project's records → Data/<name>.csv
    const TABLES = [
        ["projects", "Project", "id"],
        ["schedule_phases", "Timeline phases"], ["schedule_tasks", "Timeline tasks"], ["schedule_dependencies", "Timeline dependencies"],
        ["project_contacts", "Contacts"], ["project_utility_accounts", "Utility accounts"],
        ["vendor_project_assignments", "Vendors on project"], ["project_vendor_contracts", "Vendor contracts"],
        ["project_invoices", "Invoices"], ["vpos", "VPOs"], ["back_charges", "Back charges"],
        ["incident_reports", "Incident reports"],
        ["bid_packages", "Bid packages"],
        ["budget_sections", "Budget sections"], ["budget_lines", "Budget lines"], ["draws", "Draws"],
        ["project_todo_items", "To-do items"],
        ["project_files", "File list"],
        ["project_members", "Project members"]
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

    function csv(rows) {
        if (!rows.length) return "";
        const cols = [...rows.reduce((set, r) => { Object.keys(r).forEach(k => set.add(k)); return set; }, new Set())];
        const cell = v => {
            if (v === null || v === undefined) return "";
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n");
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

        // Records
        const counts = [];
        for (const [table, label, col] of TABLES) {
            setProgress(`Exporting ${label.toLowerCase()}…`);
            const { rows, error } = await fetchAll(table, col || "project_id", project.id);
            if (error) { if (!/does not exist|schema cache/i.test(error.message || "")) problems.push(`${label}: ${error.message}`); continue; }
            if (!rows.length) continue;
            await put(`Data/${label}.csv`, csv(rows));
            counts.push(`${label}: ${rows.length}`);
            // Bid invites + draw lines hang off parent rows
            if (table === "bid_packages") {
                const ids = rows.map(r => r.id);
                const inv = ids.length ? await sb.from("bid_invites").select("*").in("package_id", ids) : { data: [] };
                if (inv.data && inv.data.length) { await put("Data/Bid invites.csv", csv(inv.data)); counts.push(`Bid invites: ${inv.data.length}`); }
            }
            if (table === "draws") {
                const ids = rows.map(r => r.id);
                const dl = ids.length ? await sb.from("draw_lines").select("*").in("draw_id", ids) : { data: [] };
                if (dl.data && dl.data.length) { await put("Data/Draw lines.csv", csv(dl.data)); counts.push(`Draw lines: ${dl.data.length}`); }
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
        await put("README.txt", [
            `${project.name} — project archive`,
            `Exported ${new Date().toLocaleString("en-US")} by ${(p && (p.full_name || p.username)) || "staff"} from the Leeward staff portal.`,
            project.archived_at ? `Archived in the portal since ${niceDate(project.archived_at)}.` : "",
            "",
            "Files/  every file from Project Files, in the same folders",
            "Data/   the project's records as spreadsheets (CSV — opens in Excel)",
            "",
            `Files: ${files.length - problems.filter(x => x.startsWith("File ")).length} of ${files.length} (${(bytes / 1048576).toFixed(1)} MB)`,
            ...counts,
            problems.length ? "\nCouldn't include:\n" + problems.map(x => " - " + x).join("\n") : ""
        ].filter(x => x !== null).join("\r\n"));

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
                    (r.problems.length ? ` ${r.problems.length} item${r.problems.length === 1 ? "" : "s"} couldn't be included (listed in README.txt on the drive).` : "") +
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
                (problems.length ? ` ${problems.length} item${problems.length === 1 ? "" : "s"} couldn't be included (listed in README.txt).` : "") +
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
