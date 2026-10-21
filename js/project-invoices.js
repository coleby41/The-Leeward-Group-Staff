/* ===========================================================
   PROJECT INVOICES (shared)

   Everything about a project invoice that more than one page needs:
     - the data: load / save / edit / delete (project_invoices + the PDF's
       project_files row + the file in the project-documents bucket)
     - who may edit/delete (can_manage_invoices RPC — a per-project setting,
       see sql/supabase-project-invoices-setup.sql)
     - approved vendors (same rule as the Vendors page's "Approved" badge)
     - merging photos and PDFs into ONE PDF (pdf-lib, loaded on demand)
     - the invoice form (add or edit) — a bottom sheet on phones, a centered
       popup on desktop.

   File name: "<Project name> - <Vendor name> - <Invoice number>.pdf",
   saved under 07 Financial › Invoices.

   Used by js/project-accounting.js (Accounting page) and
   js/project-photos.js (phone camera bubble on the Overview page).
   Needs project-fields.js (ProjectFields.uploadFile) loaded first.
=========================================================== */
(function () {
    "use strict";

    const INVOICES_TABLE = "project_invoices";
    const SETTINGS_TABLE = "project_settings";
    const FILES_TABLE = "project_files";
    const BUCKET = "project-documents";
    const CATEGORY = "financial";
    const SUBFOLDER = "invoices";
    const FOLDER_LABEL = "07 Financial › Invoices";
    const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
    const DEFAULT_MANAGE_ROLES = ["project_admin", "project_manager", "accounting"];
    const MAX_IMAGE_SIDE = 2200; // px — keeps a phone photo page readable without a 10 MB PDF

    /* ---------- small helpers ---------- */

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function client() { return window.supabaseClient; }

    function profile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (e) { return null; }
    }

    function staffName() {
        const p = profile();
        return (p && (p.full_name || p.username)) || "Staff";
    }

    function staffId() {
        const p = profile();
        return (p && (p.id || p.uid)) || null;
    }

    function isPhone() {
        return window.matchMedia ? window.matchMedia("(max-width: 768px)").matches : window.innerWidth <= 768;
    }

    function cleanPart(text) {
        return String(text || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    }

    function fileNameFor(projectName, vendorName, invoiceNumber) {
        const parts = [cleanPart(projectName) || "Project", cleanPart(vendorName) || "Vendor", cleanPart(invoiceNumber) || "Invoice"];
        return parts.join(" - ").slice(0, 180) + ".pdf";
    }

    function parseMoney(text) {
        const n = Number(String(text ?? "").replace(/[^0-9.-]/g, ""));
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
    }

    function formatMoney(n) {
        const v = Number(n) || 0;
        return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
    }

    function formatDate(value) {
        if (!value) return "";
        const d = new Date(String(value).slice(0, 10) + "T00:00:00");
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
    }

    function todayIso() {
        const d = new Date();
        const pad = n => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }

    /* ---------- permissions ---------- */

    async function canManage(projectId) {
        const p = profile();
        if (window.isSupabaseUserInGroup && (window.isSupabaseUserInGroup(p, "Super Admin") || window.isSupabaseUserInGroup(p, "IT"))) return true;
        try {
            const { data, error } = await client().rpc("can_manage_invoices", { p_project_id: projectId });
            if (!error) return data === true;
        } catch (e) { /* fall through */ }
        // RPC not there yet (SQL not run): fall back to the default rule.
        try {
            const { data } = await client().rpc("project_role", { p_project_id: projectId });
            return DEFAULT_MANAGE_ROLES.includes(data);
        } catch (e) { return false; }
    }

    async function loadSettings(projectId) {
        const { data, error } = await client().from(SETTINGS_TABLE).select("*").eq("project_id", projectId).maybeSingle();
        if (error) throw error;
        return { invoice_manage_roles: (data && Array.isArray(data.invoice_manage_roles)) ? data.invoice_manage_roles : DEFAULT_MANAGE_ROLES.slice() };
    }

    async function saveSettings(projectId, settings) {
        const { error } = await client().from(SETTINGS_TABLE).upsert({
            project_id: projectId,
            invoice_manage_roles: settings.invoice_manage_roles,
            updated_at: new Date().toISOString()
        }, { onConflict: "project_id" });
        if (error) throw error;
    }

    /* ---------- approved vendors (same rule as js/companies.js) ---------- */

    let vendorCache = null;

    function isBlank(v) { return v === null || v === undefined || String(v).trim() === ""; }

    async function loadApprovedVendors() {
        if (vendorCache) return vendorCache;
        const sb = client();
        const [companiesRes, catsRes, tagsRes, companyTagsRes] = await Promise.all([
            sb.from("Companies").select("*").order("Name", { ascending: true }),
            sb.from("vendor_tag_categories").select("*"),
            sb.from("vendor_tags").select("*"),
            sb.from("company_tags").select("*")
        ]);
        if (companiesRes.error) throw companiesRes.error;
        const cats = catsRes.data || [];
        const tagById = new Map((tagsRes.data || []).map(t => [String(t.id), t]));
        const catsByCompany = new Map();
        (companyTagsRes.data || []).forEach(ct => {
            const tag = tagById.get(String(ct.tag_id));
            if (!tag) return;
            const key = String(ct.company_id);
            if (!catsByCompany.has(key)) catsByCompany.set(key, new Set());
            catsByCompany.get(key).add(String(tag.category_id));
        });
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const approved = (companiesRes.data || []).filter(c => {
            if (["Name", "Street", "City", "State", "Zip", "SSN/FID"].some(k => isBlank(c[k]))) return false;
            if (!c.W9FilePath && !c.W9Exempt) return false;
            // Same rules as the Vendors page: a COI expiration date that
            // hasn't passed (no PDF needed), unless COI-exempt.
            if (!c.COIExempt) {
                if (!c.COIExpiresOn) return false;
                const exp = new Date(`${c.COIExpiresOn}T00:00:00`);
                if (Number.isNaN(exp.getTime()) || exp < today) return false;
            }
            if (!cats.length) return false;
            const have = catsByCompany.get(String(c.id)) || new Set();
            return cats.every(cat => have.has(String(cat.id)));
        });
        vendorCache = approved.map(c => ({ id: String(c.id), name: String(c.Name).trim() }));
        return vendorCache;
    }

    /* ---------- PDF building ---------- */

    let pdfLibPromise = null;
    function loadPdfLib() {
        if (window.PDFLib) return Promise.resolve(window.PDFLib);
        if (!pdfLibPromise) {
            pdfLibPromise = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = PDF_LIB_URL;
                s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error("PDF library failed to load"));
                s.onerror = () => { pdfLibPromise = null; reject(new Error("PDF library failed to load")); };
                document.head.appendChild(s);
            });
        }
        return pdfLibPromise;
    }

    function isPdf(file) {
        return file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`"${file.name}" couldn't be read as a photo.`)); };
            img.src = url;
        });
    }

    async function imageToJpegBytes(file) {
        const img = await loadImage(file);
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
        if (!blob) throw new Error(`"${file.name}" couldn't be converted.`);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
    }

    // Photos and PDFs, in order, merged into one PDF Blob.
    async function buildPdf(files) {
        const PDFLib = await loadPdfLib();
        const out = await PDFLib.PDFDocument.create();
        for (const file of files) {
            if (isPdf(file)) {
                let src;
                try {
                    src = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
                } catch (e) {
                    throw new Error(`"${file.name}" isn't a PDF that can be added.`);
                }
                const pages = await out.copyPages(src, src.getPageIndices());
                pages.forEach(p => out.addPage(p));
            } else {
                const { bytes, w, h } = await imageToJpegBytes(file);
                const jpg = await out.embedJpg(bytes);
                // Fit the photo on a letter-width page (8.5in = 612pt).
                const pageW = 612;
                const pageH = Math.round(pageW * (h / w));
                const page = out.addPage([pageW, pageH]);
                page.drawImage(jpg, { x: 0, y: 0, width: pageW, height: pageH });
            }
        }
        if (!out.getPageCount()) throw new Error("Add at least one page.");
        const bytes = await out.save();
        return new Blob([bytes], { type: "application/pdf" });
    }

    /* ---------- data ---------- */

    async function loadInvoices(projectId) {
        const { data, error } = await client()
            .from(INVOICES_TABLE)
            .select("*, project_files(id, file_name, storage_path, bucket)")
            .eq("project_id", projectId)
            .order("invoice_date", { ascending: false, nullsFirst: false })
            .order("created_at", { ascending: false });
        if (error) throw error;
        return (data || []).map(normalize);
    }

    function normalize(row) {
        const file = Array.isArray(row.project_files) ? row.project_files[0] : row.project_files;
        return { ...row, file: file || null, total_due: Number(row.total_due) || 0 };
    }

    // vendor is { id, name } for an approved vendor, or { id: null, name: <store name> }
    // for a hardware-store purchase (isHardware true, with an optional description).
    async function createInvoice({ project, vendor, invoiceNumber, totalDue, invoiceDate, paid, files, isHardware, description }) {
        const pdf = await buildPdf(files);
        const name = fileNameFor(project.name, vendor.name, invoiceNumber);
        const pdfFile = new File([pdf], name, { type: "application/pdf" });
        const path = await window.ProjectFields.uploadFile(project.id, pdfFile, null, { pathSegments: [CATEGORY, SUBFOLDER] });

        const { data: fileRow, error: fileErr } = await client().from(FILES_TABLE).insert({
            project_id: project.id,
            category: CATEGORY,
            subfolder: SUBFOLDER,
            sub_subfolder: null,
            bucket: BUCKET,
            storage_path: path,
            file_name: name,
            source: "invoice",
            uploaded_by_name: staffName()
        }).select("id").single();
        if (fileErr) {
            client().storage.from(BUCKET).remove([path]).catch(() => {});
            throw fileErr;
        }

        const { data: inv, error: invErr } = await client().from(INVOICES_TABLE).insert({
            project_id: project.id,
            vendor_id: isHardware ? null : vendor.id,
            vendor_name: vendor.name,
            is_hardware_store: !!isHardware,
            description: isHardware ? (description || null) : null,
            invoice_number: invoiceNumber,
            total_due: totalDue,
            invoice_date: invoiceDate || null,
            paid: !!paid,
            project_file_id: fileRow.id,
            created_by: staffId(),
            created_by_name: staffName()
        }).select("*, project_files(id, file_name, storage_path, bucket)").single();
        if (invErr) {
            // Don't leave a stray file behind if the invoice row couldn't be saved.
            client().from(FILES_TABLE).delete().eq("id", fileRow.id).then(() => {});
            client().storage.from(BUCKET).remove([path]).catch(() => {});
            throw invErr;
        }
        return normalize(inv);
    }

    async function updateInvoice(invoice, project, changes) {
        const { data, error } = await client().from(INVOICES_TABLE).update({
            vendor_id: changes.isHardware ? null : changes.vendor.id,
            vendor_name: changes.vendor.name,
            is_hardware_store: !!changes.isHardware,
            description: changes.isHardware ? (changes.description || null) : null,
            invoice_number: changes.invoiceNumber,
            total_due: changes.totalDue,
            invoice_date: changes.invoiceDate || null,
            paid: !!changes.paid
        }).eq("id", invoice.id).select("*, project_files(id, file_name, storage_path, bucket)");
        if (error) throw error;
        if (!data || !data.length) throw new Error("You don't have permission to edit invoices on this project.");
        const updated = normalize(data[0]);

        // Keep the file's name in step with the vendor / invoice number.
        const newName = fileNameFor(project.name, changes.vendor.name, changes.invoiceNumber);
        if (updated.file && updated.file.file_name !== newName) {
            const { error: fErr } = await client().from(FILES_TABLE).update({ file_name: newName }).eq("id", updated.file.id);
            if (!fErr) updated.file = { ...updated.file, file_name: newName };
        }
        return updated;
    }

    async function deleteInvoice(invoice) {
        // Invoice row first: RLS decides whether this person may delete. If it
        // removes nothing, stop before touching the file.
        const { data, error } = await client().from(INVOICES_TABLE).delete().eq("id", invoice.id).select("id");
        if (error) throw error;
        if (!data || !data.length) throw new Error("You don't have permission to delete invoices on this project.");
        if (invoice.file) {
            await client().from(FILES_TABLE).delete().eq("id", invoice.file.id);
            if (invoice.file.storage_path) {
                await client().storage.from(invoice.file.bucket || BUCKET).remove([invoice.file.storage_path]).catch(err => console.warn("Couldn't remove invoice file:", err));
            }
        }
    }

    async function signedUrl(invoice, download) {
        if (!invoice.file || !invoice.file.storage_path) throw new Error("This invoice has no file.");
        const { data, error } = await client().storage.from(invoice.file.bucket || BUCKET)
            .createSignedUrl(invoice.file.storage_path, 60 * 10, download ? { download: invoice.file.file_name } : undefined);
        if (error || !data || !data.signedUrl) throw error || new Error("Couldn't open the file.");
        return data.signedUrl;
    }

    /* ===========================================================
       INVOICE FORM (add / edit)
    =========================================================== */

    const ICON = {
        plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        camera: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
        x: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
        back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
        search: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>'
    };

    let form = null; // the one open form's state

    function ensureFormDom() {
        let overlay = document.getElementById("invoiceFormOverlay");
        if (overlay) return overlay;
        overlay = document.createElement("div");
        overlay.id = "invoiceFormOverlay";
        overlay.className = "inv-overlay";
        overlay.innerHTML = '<div class="inv-scrim"></div><section class="inv-sheet" role="dialog" aria-modal="true" aria-label="Invoice"></section>';
        document.body.appendChild(overlay);

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,application/pdf";
        input.multiple = true;
        input.hidden = true;
        input.id = "invoiceFormFileInput";
        document.body.appendChild(input);
        input.addEventListener("change", () => {
            const files = Array.from(input.files || []);
            input.value = "";
            if (form) { addFiles(files); renderForm(); }
        });

        overlay.addEventListener("click", onFormClick);
        overlay.addEventListener("input", onFormInput);
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && form && !form.saving && overlay.classList.contains("is-open")) {
                if (form.view === "vendor") { form.view = "form"; renderForm(); } else closeForm();
            }
        });
        return overlay;
    }

    function addFiles(files) {
        files.filter(f => f && (isPdf(f) || /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)))
            .forEach(f => form.pages.push({ file: f, url: isPdf(f) ? null : URL.createObjectURL(f) }));
    }

    /*
      opts: {
        project: { id, name },
        invoice: existing invoice (edit mode) or undefined (add mode),
        files: initial File[] (add mode),
        onAddFromCamera: optional () => void — shows a "Camera" tile; the
            caller hides the form (hideForm), takes photos, then calls
            ProjectInvoices.resumeForm(newFiles),
        onSaved: (invoice) => void,
        onClosed: () => void
      }
    */
    function openForm(opts) {
        const overlay = ensureFormDom();
        if (form) cleanupPages();
        const inv = opts.invoice || null;
        form = {
            opts,
            mode: inv ? "edit" : "add",
            view: "form",
            pages: [],
            vendor: inv && !inv.is_hardware_store ? { id: inv.vendor_id, name: inv.vendor_name } : null,
            isHardware: !!(inv && inv.is_hardware_store),
            storeName: inv && inv.is_hardware_store ? (inv.vendor_name || "") : "",
            description: inv ? (inv.description || "") : "",
            invoiceNumber: inv ? inv.invoice_number : "",
            totalDue: inv ? String(inv.total_due.toFixed ? inv.total_due.toFixed(2) : inv.total_due) : "",
            invoiceDate: inv ? (inv.invoice_date || "") : todayIso(),
            paid: inv ? !!inv.paid : false,
            vendorQuery: "",
            vendors: vendorCache,
            vendorError: "",
            error: "",
            saving: false
        };
        if (opts.files && opts.files.length) addFiles(opts.files);
        renderForm();
        overlay.classList.add("is-open");
        document.body.classList.add("inv-form-open");
        if (!form.vendors) {
            loadApprovedVendors().then(list => { if (form) { form.vendors = list; if (form.view === "vendor") renderForm(); } })
                .catch(err => { console.error("Couldn't load vendors:", err); if (form) { form.vendorError = "Couldn't load vendors."; renderForm(); } });
        }
    }

    function hideForm() {
        document.getElementById("invoiceFormOverlay")?.classList.remove("is-open");
        document.body.classList.remove("inv-form-open");
    }

    function resumeForm(newFiles) {
        if (!form) return;
        if (newFiles && newFiles.length) addFiles(newFiles);
        renderForm();
        document.getElementById("invoiceFormOverlay")?.classList.add("is-open");
        document.body.classList.add("inv-form-open");
    }

    function cleanupPages() {
        if (!form) return;
        form.pages.forEach(p => p.url && URL.revokeObjectURL(p.url));
    }

    function closeForm() {
        const closed = form && form.opts.onClosed;
        cleanupPages();
        form = null;
        hideForm();
        if (closed) closed();
    }

    function currentFileName() {
        const who = form.isHardware ? (form.storeName.trim() || "Store name") : (form.vendor ? form.vendor.name : "Vendor");
        return fileNameFor(form.opts.project.name, who, form.invoiceNumber || (form.isHardware ? "Receipt #" : "Invoice #"));
    }

    function renderForm() {
        const sheet = document.querySelector("#invoiceFormOverlay .inv-sheet");
        if (!sheet || !form) return;
        if (form.view === "vendor") { sheet.innerHTML = vendorViewHtml(); const s = sheet.querySelector(".inv-vendor-search input"); if (s && !isPhone()) s.focus(); return; }

        const isAdd = form.mode === "add";
        const pagesHtml = isAdd ? `
            <div class="inv-pages">
                ${form.pages.map((p, i) => `
                    <div class="inv-page">
                        ${p.url ? `<img src="${p.url}" alt="Page ${i + 1}">` : `<span class="inv-page-pdf">PDF</span><span class="inv-page-name">${esc(p.file.name)}</span>`}
                        <span class="inv-page-num">${i + 1}</span>
                        <button type="button" class="inv-page-remove" data-inv-action="remove-page" data-index="${i}" aria-label="Remove page ${i + 1}">${ICON.x}</button>
                    </div>`).join("")}
                ${form.opts.onAddFromCamera ? `<button type="button" class="inv-page-add" data-inv-action="camera">${ICON.camera}<span>Camera</span></button>` : ""}
                <button type="button" class="inv-page-add" data-inv-action="add-files">${ICON.plus}<span>${form.pages.length ? "Add more" : "Add files"}</span></button>
            </div>
            <p class="inv-hint">${form.pages.length ? (form.pages.length === 1 ? "1 page" : form.pages.length + " pages") + " · saved together as one PDF" : "Add photos or PDFs of the invoice — they'll be saved as one PDF."}</p>
        ` : "";

        sheet.innerHTML = `
            <div class="inv-handle"><span></span></div>
            <div class="inv-head">
                <div><h2>${isAdd ? "Invoice details" : "Edit invoice"}</h2><p>${esc(form.opts.project.name || "")}</p></div>
                <button type="button" class="inv-head-cancel" data-inv-action="cancel"${form.saving ? " disabled" : ""}>Cancel</button>
            </div>
            <div class="inv-body">
                ${pagesHtml}
                <label class="inv-check">
                    <input type="checkbox" data-inv-field="isHardware"${form.isHardware ? " checked" : ""}>
                    <span><strong>Hardware store</strong><small>Home Depot, Lowe's, etc. — no approved vendor needed</small></span>
                </label>
                ${form.isHardware ? `
                <label class="inv-field"><span class="inv-label">Name of hardware store</span>
                    <input type="text" class="inv-input" data-inv-field="storeName" value="${esc(form.storeName)}" placeholder="e.g. Home Depot" autocomplete="off" maxlength="80"></label>
                <label class="inv-field"><span class="inv-label">Description</span>
                    <textarea class="inv-input inv-textarea" data-inv-field="description" rows="3" maxlength="500" placeholder="What was bought and what it's for">${esc(form.description)}</textarea></label>
                ` : `
                <div class="inv-field">
                    <span class="inv-label">Vendor</span>
                    <button type="button" class="inv-select${form.vendor ? "" : " is-empty"}" data-inv-action="pick-vendor">
                        <span>${form.vendor ? esc(form.vendor.name) : "Choose an approved vendor"}</span>${ICON.chevron}
                    </button>
                </div>`}
                <div class="inv-grid">
                    <label class="inv-field"><span class="inv-label">${form.isHardware ? "Receipt / invoice #" : "Invoice number"}</span>
                        <input type="text" class="inv-input" data-inv-field="invoiceNumber" value="${esc(form.invoiceNumber)}" autocomplete="off" maxlength="60"></label>
                    <label class="inv-field"><span class="inv-label">Total due</span>
                        <input type="text" class="inv-input" data-inv-field="totalDue" value="${esc(form.totalDue)}" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
                </div>
                <label class="inv-field"><span class="inv-label">Invoice date</span>
                    <input type="date" class="inv-input" data-inv-field="invoiceDate" value="${esc(form.invoiceDate)}"></label>
                <div class="inv-field">
                    <span class="inv-label">Status</span>
                    <div class="inv-seg" role="group" aria-label="Paid status">
                        <button type="button" class="inv-seg-btn${form.paid ? "" : " is-on is-unpaid"}" data-inv-action="unpaid" aria-pressed="${!form.paid}">Not paid</button>
                        <button type="button" class="inv-seg-btn${form.paid ? " is-on is-paid" : ""}" data-inv-action="paid" aria-pressed="${form.paid}">Paid</button>
                    </div>
                </div>
                <div class="inv-filename">
                    <small>FILE NAME</small>
                    <strong id="invFileNamePreview">${esc(currentFileName())}</strong>
                    <span>Saves to ${esc(FOLDER_LABEL)}</span>
                </div>
                ${form.error ? `<p class="inv-error" role="alert">${esc(form.error)}</p>` : ""}
            </div>
            <div class="inv-actions">
                <button type="button" class="inv-btn inv-btn--soft" data-inv-action="cancel"${form.saving ? " disabled" : ""}>Cancel</button>
                <button type="button" class="inv-btn inv-btn--primary" data-inv-action="save"${form.saving ? " disabled" : ""}>${form.saving ? "Saving…" : (isAdd ? "Save invoice" : "Save changes")}</button>
            </div>`;
    }

    function vendorViewHtml() {
        const q = form.vendorQuery.trim().toLowerCase();
        let listHtml;
        if (form.vendorError) listHtml = `<p class="inv-hint">${esc(form.vendorError)}</p>`;
        else if (!form.vendors) listHtml = `<p class="inv-hint">Loading vendors…</p>`;
        else {
            const list = form.vendors.filter(v => !q || v.name.toLowerCase().includes(q));
            listHtml = list.length
                ? list.map(v => `<button type="button" class="inv-vendor-row${form.vendor && form.vendor.id === v.id ? " is-selected" : ""}" data-inv-action="choose-vendor" data-vendor-id="${esc(v.id)}">
                        <span class="inv-vendor-av">${esc(v.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase())}</span>
                        <span class="inv-vendor-name">${esc(v.name)}</span><span class="inv-vendor-ok">Approved</span></button>`).join("")
                : `<p class="inv-hint">${form.vendors.length ? "No approved vendors match." : "There are no approved vendors yet. Vendors become approved on the Vendors page once all their info is filled in."}</p>`;
        }
        return `
            <div class="inv-handle"><span></span></div>
            <div class="inv-head">
                <button type="button" class="inv-back" data-inv-action="vendor-back" aria-label="Back">${ICON.back}</button>
                <div><h2>Choose vendor</h2><p>Only approved vendors are listed</p></div>
            </div>
            <label class="inv-vendor-search">${ICON.search}<input type="search" data-inv-field="vendorQuery" value="${esc(form.vendorQuery)}" placeholder="Search vendors" aria-label="Search vendors" autocomplete="off"></label>
            <div class="inv-body inv-vendor-list">${listHtml}</div>`;
    }

    function onFormInput(e) {
        const el = e.target.closest("[data-inv-field]");
        if (!el || !form) return;
        const key = el.dataset.invField;
        if (key === "isHardware") {
            form.isHardware = el.checked;
            form.error = "";
            renderForm();
            if (form.isHardware && !isPhone()) document.querySelector('#invoiceFormOverlay [data-inv-field="storeName"]')?.focus();
            return;
        }
        form[key] = el.value;
        if (key === "vendorQuery") {
            const list = document.querySelector("#invoiceFormOverlay .inv-vendor-list");
            const pos = el.selectionStart;
            renderForm();
            const input = document.querySelector('#invoiceFormOverlay [data-inv-field="vendorQuery"]');
            if (input) { input.focus(); try { input.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
            void list;
        } else if (key === "invoiceNumber" || key === "storeName") {
            const prev = document.getElementById("invFileNamePreview");
            if (prev) prev.textContent = currentFileName();
        }
    }

    function onFormClick(e) {
        if (!form) return;
        if (e.target.classList.contains("inv-scrim")) return; // never lose a half-filled invoice to a stray tap
        const btn = e.target.closest("[data-inv-action]");
        if (!btn || btn.disabled) return;
        const a = btn.dataset.invAction;
        if (a === "cancel") closeForm();
        else if (a === "add-files") document.getElementById("invoiceFormFileInput").click();
        else if (a === "camera") { hideForm(); form.opts.onAddFromCamera(); }
        else if (a === "remove-page") {
            const i = Number(btn.dataset.index);
            const p = form.pages[i];
            if (p && p.url) URL.revokeObjectURL(p.url);
            form.pages.splice(i, 1);
            renderForm();
        }
        else if (a === "pick-vendor") { form.view = "vendor"; renderForm(); }
        else if (a === "vendor-back") { form.view = "form"; renderForm(); }
        else if (a === "choose-vendor") {
            const v = (form.vendors || []).find(x => x.id === btn.dataset.vendorId);
            if (v) form.vendor = v;
            form.view = "form";
            form.vendorQuery = "";
            renderForm();
        }
        else if (a === "paid" || a === "unpaid") { form.paid = a === "paid"; renderForm(); }
        else if (a === "save") save();
    }

    async function save() {
        const isAdd = form.mode === "add";
        const total = parseMoney(form.totalDue);
        const number = String(form.invoiceNumber || "").trim();
        let problem = "";
        if (isAdd && !form.pages.length) problem = "Add at least one photo or PDF of the invoice.";
        else if (form.isHardware && !form.storeName.trim()) problem = "Enter the name of the hardware store.";
        else if (!form.isHardware && !form.vendor) problem = "Choose the vendor.";
        else if (!number) problem = form.isHardware ? "Enter the receipt or invoice number." : "Enter the invoice number.";
        else if (!Number.isFinite(total)) problem = "Enter the total due as a number, like 1250.00.";
        else if (!form.invoiceDate) problem = "Enter the invoice date.";
        if (problem) { form.error = problem; renderForm(); return; }

        form.error = "";
        form.saving = true;
        renderForm();
        const f = form;
        const vendor = f.isHardware ? { id: null, name: f.storeName.trim() } : f.vendor;
        const description = f.isHardware ? f.description.trim() : "";
        try {
            let saved;
            if (isAdd) {
                saved = await createInvoice({
                    project: f.opts.project, vendor, invoiceNumber: number, isHardware: f.isHardware, description,
                    totalDue: total, invoiceDate: f.invoiceDate, paid: f.paid,
                    files: f.pages.map(p => p.file)
                });
            } else {
                saved = await updateInvoice(f.opts.invoice, f.opts.project, {
                    vendor, isHardware: f.isHardware, description, invoiceNumber: number, totalDue: total, invoiceDate: f.invoiceDate, paid: f.paid
                });
            }
            const onSaved = f.opts.onSaved;
            if (form === f) closeForm();
            if (onSaved) onSaved(saved);
        } catch (err) {
            console.error("Invoice save failed:", err);
            if (form !== f) return;
            f.saving = false;
            f.error = (err && err.message) ? err.message : "Couldn't save the invoice. Please try again.";
            renderForm();
        }
    }

    window.ProjectInvoices = {
        FOLDER_LABEL,
        DEFAULT_MANAGE_ROLES,
        fileNameFor,
        formatMoney,
        formatDate,
        canManage,
        loadSettings,
        saveSettings,
        loadApprovedVendors,
        buildPdf,
        loadInvoices,
        createInvoice,
        updateInvoice,
        deleteInvoice,
        signedUrl,
        openForm,
        hideForm,
        resumeForm,
        closeForm
    };
})();
