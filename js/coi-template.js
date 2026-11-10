/* ===========================================================
   COI TEMPLATE — shared (2026-11-10)

   One COI template per project: a sample COI showing the coverage and
   additional-insured wording that project needs. The file is a normal
   project_files row (Contracts & Procurement › Vendors); the link lives in
   public.project_coi_templates (one row per project).

   Vendors can't upload their own COI in the Vendor Portal until a template
   is posted, and staff can't Award (when a COI is needed) or Request COI
   without one — vendor-api and bid-invites enforce both.

   Used by: project-bid-invites.html, projects.html (Overview),
   project-files.html, vendors.html (Generate A Invite Bid).

   API (window.CoiTemplate):
     load(projectId)                     → { file, uploaded_by_name, updated_at } | null
     upload(project, file)               → uploads a PDF and makes it the template
     useExisting(projectId, fileId)      → makes an existing project PDF the template
     remove(projectId)                   → unlinks it (the file stays in Project Files)
     open(file)                          → in-portal preview (never a new tab)
     canManage()                         → has projects.manage_bid_invites
     mount(el, { project, canManage, intro, compact }) → renders the card;
         returns { reload(), get value }
   Every change fires window "coi-template:changed" { projectId, template }
   so other parts of the page (Request COI, Award, the wizard) can react.
   Requires supabase-config.js, project-fields.js, file-preview.js.
=========================================================== */
(function () {
    "use strict";

    const TABLE = "project_coi_templates";
    const DOCS_BUCKET = "project-documents";
    const CATEGORY = "contracts_procurement";
    const SUBFOLDER = "vendors";
    const MANAGE = "projects.manage_bid_invites";

    const client = () => window.supabaseClient;

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function staffName() {
        let p = window.currentSupabaseProfile;
        if (!p) { try { p = JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (e) { p = null; } }
        return (p && (p.full_name || p.username)) || "Staff";
    }

    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
    }

    function shortDate(value) {
        if (!value) return "";
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function canManage() {
        return window.Permissions ? window.Permissions.hasPermission(MANAGE) : false;
    }

    function changed(projectId, template) {
        window.dispatchEvent(new CustomEvent("coi-template:changed", { detail: { projectId, template } }));
    }

    async function load(projectId) {
        if (!projectId) return null;
        const { data, error } = await client().from(TABLE)
            .select("project_file_id, uploaded_by_name, updated_at, project_files(id, file_name, bucket, storage_path)")
            .eq("project_id", projectId).maybeSingle();
        if (error) { console.warn("COI template not loaded (run sql/supabase-vendor-portal-setup.sql):", error.message); return null; }
        const file = data ? (Array.isArray(data.project_files) ? data.project_files[0] : data.project_files) : null;
        return file ? { file, uploaded_by_name: data.uploaded_by_name, updated_at: data.updated_at } : null;
    }

    async function link(projectId, fileId) {
        const { error } = await client().from(TABLE).upsert({
            project_id: projectId, project_file_id: fileId, uploaded_by_name: staffName(), updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        const tpl = await load(projectId);
        changed(projectId, tpl);
        return tpl;
    }

    async function upload(project, file) {
        if (!file) throw new Error("No file chosen.");
        if (!/\.pdf$/i.test(file.name)) throw new Error("The COI template has to be a PDF.");
        const name = `${project.name || "Project"} - COI Template.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
        const renamed = new File([file], name, { type: "application/pdf" });
        const path = await window.ProjectFields.uploadFile(project.id, renamed, null, { pathSegments: [CATEGORY, SUBFOLDER] });
        const { data: row, error } = await client().from("project_files").insert({
            project_id: project.id, category: CATEGORY, subfolder: SUBFOLDER, sub_subfolder: null,
            bucket: DOCS_BUCKET, storage_path: path, file_name: name, source: "bid", uploaded_by_name: staffName(),
        }).select("id").single();
        if (error) { client().storage.from(DOCS_BUCKET).remove([path]).catch(() => {}); throw error; }
        return link(project.id, row.id);
    }

    const useExisting = (projectId, fileId) => link(projectId, fileId);

    async function remove(projectId) {
        const { error } = await client().from(TABLE).delete().eq("project_id", projectId);
        if (error) throw error;
        changed(projectId, null);
    }

    function open(file) {
        if (!file || !file.storage_path) return;
        window.FilePreview.open({
            name: file.file_name,
            getUrl: async () => {
                const { data, error } = await client().storage.from(file.bucket || DOCS_BUCKET).createSignedUrl(file.storage_path, 60 * 10);
                if (error || !data?.signedUrl) throw error || new Error("no url");
                return data.signedUrl;
            },
        });
    }

    // The card: status chip, the file (View / Remove), Upload / Replace.
    function mount(el, opts) {
        const project = opts.project;
        const manage = opts.canManage ?? canManage();
        const intro = opts.intro ?? "A sample COI showing the coverage and additional-insured wording this project needs. Awarded vendors download it in the Vendor Portal — they can't upload their own COI until this is posted.";
        let tpl = null;
        let busy = false;
        let ready = false;
        let armed = false;      // Remove takes two clicks
        const inputId = `coiTplInput-${Math.random().toString(36).slice(2, 8)}`;

        function render() {
            el.style.display = "";
            el.innerHTML = `
                <div class="card-header"><h2 class="card-title">COI Template</h2>${!ready ? "" : tpl ? `<span class="chip chip--success">On file</span>` : `<span class="chip chip--warning">Not posted</span>`}</div>
                ${opts.compact ? "" : `<p class="auth-inline-copy" style="margin:0 0 12px">${esc(intro)}</p>`}
                ${!ready ? `<p class="auth-inline-copy" style="margin:0">Loading…</p>` : tpl ? `<div class="bid-file-row">
                        <span class="bid-file-row-name">${esc(tpl.file.file_name)}<span class="bid-cell-sub">Uploaded ${esc(shortDate(tpl.updated_at))}${tpl.uploaded_by_name ? ` by ${esc(tpl.uploaded_by_name)}` : ""}</span></span>
                        <button type="button" class="workbook-btn" style="flex:0 0 auto" data-coi-act="view">View</button>
                        ${manage ? `<button type="button" class="workbook-btn workbook-btn--danger" style="flex:0 0 auto" data-coi-act="remove" ${busy ? "disabled" : ""}>${armed ? "Click again to remove" : "Remove"}</button>` : ""}
                    </div>` : `<p class="coi-tpl-warning">No COI template yet — vendors can't upload their COI for this project, and Award / Request COI are blocked until one is posted.</p>`}
                ${ready && manage ? `<div class="bid-file-add-row">
                        <label class="bid-file-add-btn" style="cursor:pointer">${busy ? "Uploading…" : tpl ? "Replace COI Template (PDF)" : "+ Upload COI Template (PDF)"}
                            <input type="file" id="${inputId}" accept="application/pdf,.pdf" hidden ${busy ? "disabled" : ""}>
                        </label>
                    </div>` : ""}
                ${ready && !manage && !tpl ? `<p class="auth-inline-copy" style="margin:0">Ask someone who can manage bid invites to post it.</p>` : ""}`;
            el.querySelector(`#${inputId}`)?.addEventListener("change", e => doUpload(e.target.files && e.target.files[0]));
        }

        async function doUpload(file) {
            if (!file || busy) return;
            busy = true; render();
            try {
                const had = Boolean(tpl);
                tpl = await upload(project, file);
                toast(had ? "COI template replaced" : "COI template uploaded");
            } catch (err) {
                console.error("COI template upload failed:", err);
                toast(`Couldn't upload the COI template: ${err.message || err}`, "error");
            } finally { busy = false; render(); }
        }

        async function doRemove() {
            if (!tpl || busy) return;
            if (!armed) { armed = true; render(); setTimeout(() => { if (armed) { armed = false; render(); } }, 4000); return; }
            armed = false;
            busy = true; render();
            try { await remove(project.id); tpl = null; toast("COI template removed (the file is still in Project Files)"); }
            catch (err) { toast(`Couldn't remove it: ${err.message || err}`, "error"); }
            finally { busy = false; render(); }
        }

        el.addEventListener("click", e => {
            const b = e.target.closest("[data-coi-act]");
            if (!b) return;
            if (b.dataset.coiAct === "view" && tpl) open(tpl.file);
            if (b.dataset.coiAct === "remove") doRemove();
        });
        // Another card on the page (or Project Files' "Set as COI template") changed it.
        window.addEventListener("coi-template:changed", e => {
            if (String(e.detail.projectId) !== String(project.id) || busy) return;
            tpl = e.detail.template; render();
        });

        async function reload() { tpl = await load(project.id); ready = true; render(); return tpl; }
        render();
        reload();
        return { reload, get value() { return tpl; } };
    }

    window.CoiTemplate = { load, upload, useExisting, remove, open, canManage, mount };
})();
