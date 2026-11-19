/* ===========================================================
   CONTRACT BUILDER (project Accounts page) — Coleby, 2026-11-19

   Accounts › vendor popup › Contract › "Generate contract" builds Leeward's
   Master Subcontractor Agreement from this project and vendor:
     - Subcontractor info, contacts and SSN/FID from the vendor record
     - scope + amount from the awarded bid (scope can be changed; the amount
       is the approved bid — typed in only when there's no bid invite)
     - retainage %, point of contact and safety representative (vendor's
       contacts) chosen here
     - owner entity, county and lender from the project (onboarding)
     - Exhibits: B Schedule of Values (upload), C plans cover (page 1 of a
       PDF picked from Project Files), D1/D2 lien waivers (filled in), E the
       vendor's proposal, F their W-9
   Anything missing → "Not completed" and it can't be sent.
   Sent → the vendor initials every page and signs in the Vendor Portal →
   the project's Project Manager signs for Leeward here (openSign).

   Server side: supabase/functions/contract-builder (prefill / save / send /
   gc_sign). Popups are injected here; CSS is the cb- block in styles.css.
   Previews open in the portal (window.FilePreview), never a new tab.

   window.ContractBuilder.open(projectId, vendor, onChange)
   window.ContractBuilder.openSign(projectId, vendor, onChange)
=========================================================== */
(function () {
    "use strict";

    const FN = "contract-builder";
    const DOCS_BUCKET = "project-documents";
    const CATEGORY = "contracts_procurement";
    const SUBFOLDER = "vendors";

    let ctx = null;          // { projectId, vendor, onChange, data, fields, dirty, busy }
    let signCtx = null;

    const $ = id => document.getElementById(id);
    const db = () => window.supabaseClient;
    function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
    function staffName() {
        const p = window.currentSupabaseProfile || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
        return (p && (p.full_name || p.username)) || "Staff";
    }

    async function call(action, payload) {
        const { data, error } = await db().functions.invoke(FN, { body: { action, ...payload } });
        if (error) {
            let message = error.message, extra = {};
            try { const body = await error.context?.json?.(); if (body?.error) { message = body.error; extra = body; } } catch { /* keep */ }
            return { ok: false, error: message, ...extra };
        }
        return data || { ok: false, error: "No answer from the server." };
    }

    /* ---------- markup ---------- */

    function inject() {
        if ($("cbOverlay")) return;
        const wrap = document.createElement("div");
        wrap.innerHTML = `
<div class="popup-overlay popup-overlay--blur hidden" id="cbOverlay">
    <div class="popup cb-popup" role="dialog" aria-modal="true" aria-labelledby="cbTitle">
        <div class="pav-popup-head cb-head">
            <div>
                <h2 id="cbTitle">Generate contract</h2>
                <span class="pav-sub" id="cbSub"></span>
            </div>
            <button type="button" class="pav-close-btn" id="cbCloseBtn" aria-label="Close">✕</button>
        </div>
        <div id="cbBody" class="cb-body"><p class="pav-note">Loading…</p></div>
        <p class="auth-message" id="cbMessage" role="status"></p>
        <div class="popup-buttons cb-foot">
            <button type="button" class="auth-button auth-button--secondary sheet-close" id="cbCancelBtn">Cancel</button>
            <div class="cb-foot-actions">
                <button type="button" class="workbook-btn workbook-btn--preview" id="cbPreviewBtn">Preview PDF</button>
                <button type="button" class="workbook-btn workbook-btn--preview" id="cbSaveBtn">Save draft</button>
                <button type="button" class="auth-button" id="cbSendBtn">Send to vendor to sign</button>
            </div>
        </div>
    </div>
</div>
<div class="popup-overlay popup-overlay--blur hidden" id="cbSignOverlay">
    <div class="popup cb-sign-popup" role="dialog" aria-modal="true" aria-labelledby="cbSignTitle">
        <div class="pav-popup-head">
            <div>
                <h2 id="cbSignTitle">Sign for The Leeward Group</h2>
                <span class="pav-sub" id="cbSignSub"></span>
            </div>
            <button type="button" class="pav-close-btn" id="cbSignCloseBtn" aria-label="Close">✕</button>
        </div>
        <form id="cbSignForm" class="cb-sign-form" novalidate>
            <div class="cb-banner cb-banner--ok" id="cbSignVendorNote"></div>
            <p class="pav-note">You're the Project Manager on this job, so you sign for Leeward. Your initials go on the second Init: line of every page, your signature on the signature page, and today becomes the agreement date.</p>
            <div class="pav-form-grid">
                <label class="auth-field">Your initials<input type="text" name="initials" maxlength="6" autocomplete="off"></label>
                <label class="auth-field">Title (optional)<input type="text" name="title" maxlength="120" autocomplete="organization-title"></label>
            </div>
            <div class="auth-field" data-field="signature">
                <span>Signature — draw it with your mouse or finger</span>
                <canvas class="cb-pad" id="cbSignPad" aria-label="Signature pad"></canvas>
                <button type="button" class="pav-link-btn" id="cbSignClear">Clear</button>
            </div>
            <label class="pav-check"><input type="checkbox" name="agree"> I agree this is my signature and initials, and that signing electronically counts the same as signing by hand.</label>
            <p class="auth-message" id="cbSignMessage" role="status"></p>
            <div class="popup-buttons pav-popup-foot">
                <button type="button" class="workbook-btn workbook-btn--preview" id="cbSignPreviewBtn">View vendor-signed copy</button>
                <button type="submit" class="auth-button" id="cbSignSubmit">Initial all pages and sign</button>
            </div>
        </form>
    </div>
</div>`;
        document.body.append(...wrap.children);
        $("cbCloseBtn").addEventListener("click", close);
        $("cbCancelBtn").addEventListener("click", close);
        $("cbOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) close(); });
        $("cbSaveBtn").addEventListener("click", () => save({ toast: true }));
        $("cbPreviewBtn").addEventListener("click", preview);
        $("cbSendBtn").addEventListener("click", send);
        $("cbBody").addEventListener("input", onField);
        $("cbBody").addEventListener("change", onChangeField);
        $("cbBody").addEventListener("click", onBodyClick);
        $("cbSignCloseBtn").addEventListener("click", closeSign);
        $("cbSignOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeSign(); });
        $("cbSignForm").addEventListener("submit", submitSign);
        $("cbSignPreviewBtn").addEventListener("click", () => signCtx?.onViewVendorCopy?.());
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            const previewOpen = $("sharedFilePreviewOverlay") && !$("sharedFilePreviewOverlay").classList.contains("hidden");
            if (previewOpen) return;
            if (!$("cbSignOverlay").classList.contains("hidden")) closeSign();
            else if (!$("cbOverlay").classList.contains("hidden")) close();
        });
    }

    function setMessage(text, type) {
        const el = $("cbMessage");
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    function setBusy(on, label) {
        if (!ctx) return;
        ctx.busy = on;
        ["cbPreviewBtn", "cbSaveBtn", "cbSendBtn"].forEach(id => { $(id).disabled = on; });
        if (on && label) setMessage(label, "");
        if (!on) syncSend();
    }

    /* ---------- open / close ---------- */

    async function open(projectId, vendor, onChange) {
        inject();
        ctx = { projectId, vendor, onChange, data: null, fields: {}, dirty: false, busy: false, status: null, missing: [] };
        $("cbSub").textContent = vendor.company_name || "";
        $("cbBody").innerHTML = `<p class="pav-note">Loading…</p>`;
        setMessage("");
        $("cbOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        setBusy(true);
        const res = await call("prefill", { project_id: projectId, company_id: vendor.company_id });
        if (!ctx) return;
        setBusy(false);
        if (!res.ok) { $("cbBody").innerHTML = ""; setMessage(res.error || "Couldn't load the contract.", "error"); return; }
        ctx.data = res;
        ctx.fields = { ...res.fields };
        ctx.status = res.status;
        ctx.missing = res.missing || [];
        render();
    }

    function close() {
        if (ctx?.busy) return;
        if (ctx?.dirty && !confirm("Close without saving your changes?")) return;
        $("cbOverlay").classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
        const done = ctx?.onChange; const changed = ctx?.changed;
        ctx = null;
        if (changed) done?.();
    }

    /* ---------- render ---------- */

    function fact(label, value, source, missing) {
        return `<div class="cb-field">
            <span class="cb-label"><span>${esc(label)}</span><span class="cb-src">${esc(source)}</span></span>
            <div class="cb-value${missing ? " cb-value--missing" : ""}">${value ? esc(value) : `<em>${esc(missing || "Not set")}</em>`}</div>
        </div>`;
    }

    function contactOptions(selected, placeholder) {
        const list = ctx.data.contacts || [];
        return `<option value="">${esc(placeholder)}</option>` + list.map(c =>
            `<option value="${esc(c.id)}"${String(c.id) === String(selected ?? "") ? " selected" : ""}>${esc(c.name)}${c.title ? ` — ${esc(c.title)}` : ""}</option>`).join("");
    }

    function chip(ok, text) {
        return `<span class="doc-badge-trigger ${ok === true ? "" : ok === "na" ? "pav-badge--na" : ok === "warn" ? "doc-badge-trigger--expiring" : "doc-badge-trigger--expired"}">${esc(text)}</span>`;
    }

    function exhibitRow(letter, title, sub, status, actions, off) {
        return `<div class="cb-ex-row${off ? " cb-ex-row--off" : ""}">
            <span class="cb-letter">${esc(letter)}</span>
            <span class="cb-ex-text"><span class="cb-ex-title">${esc(title)}</span><span class="pav-sub">${sub}</span>${actions ? `<span class="cb-ex-actions">${actions}</span>` : ""}</span>
            ${status}
        </div>`;
    }

    function render() {
        const d = ctx.data, f = ctx.fields, v = d.vendor, p = d.project;
        const poc = (d.contacts || []).find(c => String(c.id) === String(f.poc_contact_id));
        const planName = (d.plan_files || []).find(x => x.id === f.plans_file_id)?.name;
        const pmNames = d.pm?.names?.join(", ");
        const projectHint = "Set on the project (Edit Project › Owner & Lender)";

        const plansSelect = `<label class="cb-inline-select"><span class="visually-hidden">Plans PDF</span>
            <select data-f="plans_file_id"><option value="">Pick the plans PDF…</option>${(d.plan_files || []).map(x =>
                `<option value="${esc(x.id)}"${x.id === f.plans_file_id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>`;

        const w9 = v.w9.on_file ? chip(true, "Ready") : chip(false, "Missing");
        const proposalSub = f.proposal_file_id
            ? `${esc(f.proposal_file_name || "Proposal PDF")}${d.award && f.proposal_file_id === d.award.proposal_file_id ? " · from the bid invite" : " · uploaded by staff"}`
            : d.award ? "The vendor didn't attach a proposal to their bid — upload it" : "No bid invite for this vendor — upload their proposal";

        $("cbBody").innerHTML = `
            ${banner()}
            <div class="cb-grid">
                <div class="cb-col">
                    <section class="cb-sec">
                        <div class="cb-sec-head"><h3>Subcontractor</h3><span class="cb-src">From the vendor record — edit it there</span></div>
                        <div class="cb-fields">
                            <div class="cb-span2">${fact("Name", v.name, "Vendor record")}</div>
                            ${fact("Street", v.street, "Vendor record", "Missing")}
                            ${fact("City, State, Zip", [v.city, [v.state, v.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), "Vendor record", "Missing")}
                            ${fact("SSN/FID#", v.taxid, "Vendor record / W-9", "Missing")}
                            <label class="cb-field"><span class="cb-label"><span>Point of contact</span><span class="cb-src">Vendor contacts</span></span>
                                <select data-f="poc_contact_id">${contactOptions(f.poc_contact_id, "Pick a contact…")}</select></label>
                            <div class="cb-span2 pav-sub">${poc ? esc([poc.email, poc.mobile_phone || poc.work_phone].filter(Boolean).join(" · ")) : (d.contacts || []).length ? "" : "This vendor has no contacts yet — add one on the vendor page."}</div>
                        </div>
                    </section>
                    <section class="cb-sec">
                        <div class="cb-sec-head"><h3>Project and terms</h3><span class="cb-src">Gray = filled in for you</span></div>
                        <div class="cb-fields">
                            ${fact("Project", p.name, "Project")}
                            ${fact("Located in", p.location, "Project", "Missing")}
                            <label class="cb-field cb-span2"><span class="cb-label"><span>Scope of work</span><span class="cb-src">${d.award ? "From the bid invite · you can change it" : "No bid invite · type it"}</span></span>
                                <textarea data-f="scope" rows="2" maxlength="2000">${esc(f.scope || "")}</textarea></label>
                            ${d.award && d.award.amount != null
                                ? `<div class="cb-span2">${fact("Contract sum", money(d.award.amount), `Approved bid · ${d.award.package_name || ""}`)}</div>`
                                : `<label class="cb-field cb-span2"><span class="cb-label"><span>Contract sum ($)</span><span class="cb-src">No approved bid · type the approved amount</span></span>
                                    <input type="number" data-f="amount" min="0" step="0.01" inputmode="decimal" value="${esc(f.amount ?? "")}"></label>`}
                            <label class="cb-field"><span class="cb-label"><span>Retainage %</span><span class="cb-src">This contract</span></span>
                                <input type="number" data-f="retainage" min="0" max="100" step="0.5" inputmode="decimal" value="${esc(f.retainage ?? "")}" placeholder="e.g. 5"></label>
                            <label class="cb-field"><span class="cb-label"><span>Safety representative</span><span class="cb-src">Vendor contacts</span></span>
                                <select data-f="safety_contact_id">${contactOptions(f.safety_contact_id, "Pick a contact…")}</select></label>
                            ${fact("Additional insured (project-owning entity)", p.owner_entity, "Project", projectHint)}
                            ${fact("Agreement date", "Filled in when the Project Manager signs", "Automatic")}
                        </div>
                    </section>
                </div>
                <div class="cb-col">
                    <section class="cb-sec">
                        <div class="cb-sec-head"><h3>Exhibits</h3><span class="cb-src">Header + Int: lines on every page</span></div>
                        ${exhibitRow("A", "Leeward scopes of work", "Optional · on hold", chip("na", "Not used"), "", true)}
                        ${exhibitRow("B", "Schedule of Values",
                            f.sov_file_id ? esc(f.sov_file_name || "Schedule of Values PDF") : "Upload the schedule of values PDF",
                            f.sov_file_id ? chip(true, "Ready") : chip(false, "Missing"),
                            `<button type="button" class="pav-link-btn" data-upload="sov_file_id">${f.sov_file_id ? "Replace" : "Upload PDF"}</button>${f.sov_file_id ? ` <button type="button" class="pav-link-btn" data-view-file="${esc(f.sov_file_id)}">View</button>` : ""}`)}
                        ${exhibitRow("C", "Plans and Specifications", f.plans_file_id ? `Page 1 of ${esc(planName || "the plans PDF")}` : "Pick the plans PDF from Project Files — page 1 (cover sheet) is used",
                            f.plans_file_id ? chip(true, "Ready") : chip(false, "Missing"), plansSelect)}
                        ${exhibitRow("D1", "Monthly Lien Waiver", [p.county ? `${esc(p.county)} County` : "<strong>No county</strong>", p.owner_entity ? `Owner ${esc(p.owner_entity)}` : "<strong>No owner entity</strong>", p.lender ? `Lender ${esc(p.lender)}` : "<strong>No lender</strong>"].join(" · "),
                            p.county && p.owner_entity && p.lender ? chip(true, "Ready") : chip(false, "Needs project info"), "")}
                        ${exhibitRow("D2", "Final Lien Waiver", "Amounts, dates and notary left blank for the vendor",
                            p.county && p.owner_entity ? chip(true, "Ready") : chip(false, "Needs project info"), "")}
                        ${exhibitRow("E", "Proposal", proposalSub,
                            f.proposal_file_id ? chip(true, "Ready") : chip(d.award ? false : "warn", d.award ? "Missing" : "No bid invite"),
                            `<button type="button" class="pav-link-btn" data-upload="proposal_file_id">${f.proposal_file_id ? "Replace" : "Upload PDF"}</button>${f.proposal_file_id ? ` <button type="button" class="pav-link-btn" data-view-file="${esc(f.proposal_file_id)}">View</button>` : ""}`)}
                        ${exhibitRow("F", "W-9", v.w9.on_file ? "From the vendor record" : v.w9.exempt ? "Vendor is W-9 exempt and has no W-9 on file" : "No W-9 on the vendor record — add it on the vendor page", w9, "")}
                        ${exhibitRow("G", "Subcontractor license", "Optional · on hold", chip("na", "Not used"), "", true)}
                    </section>
                    <section class="cb-sec">
                        <div class="cb-sec-head"><h3>Signing order</h3></div>
                        <ol class="cb-steps">
                            <li>Vendor initials every page and signs in the Vendor Portal</li>
                            <li>${pmNames ? `${esc(pmNames)} (Project Manager)` : "<strong>The Project Manager</strong> (none set — add one in Project Members)"} initials and signs for Leeward · sets the agreement date</li>
                        </ol>
                    </section>
                </div>
            </div>
            <input type="file" id="cbFileInput" accept="application/pdf,.pdf" hidden>`;
        syncSend();
    }

    function banner() {
        if (ctx.data.vendor_signed) return `<div class="cb-banner cb-banner--info" role="status"><strong>Signed by the vendor.</strong> <span>Sending a new version replaces their signed copy and they sign again.</span></div>`;
        if (ctx.missing.length) {
            return `<div class="cb-banner cb-banner--bad" role="status"><strong>Not completed</strong><span>This contract can't be sent until these are done:</span>
                <ul>${ctx.missing.map(m => `<li>${esc(m)}</li>`).join("")}</ul></div>`;
        }
        if (ctx.data.sent && ctx.status === "sent") return `<div class="cb-banner cb-banner--info" role="status"><strong>Sent.</strong> <span>Waiting on the vendor to initial and sign. Sending again replaces it with a new version.</span></div>`;
        return `<div class="cb-banner cb-banner--ok" role="status"><strong>Ready to send</strong><span>Everything is filled in. The vendor initials every page and signs first, then the Project Manager signs.</span></div>`;
    }

    function money(n) { return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

    function syncSend() {
        if (!ctx) return;
        const btn = $("cbSendBtn");
        const blocked = !ctx.data || ctx.missing.length > 0 || ctx.busy;
        btn.disabled = blocked;
        btn.title = ctx.missing.length ? "Not completed — see the list at the top" : "";
        btn.textContent = ctx.data?.sent ? "Send new version" : "Send to vendor to sign";
    }

    /* ---------- editing ---------- */

    function onField(e) {
        const el = e.target.closest("[data-f]");
        if (!el || !ctx) return;
        ctx.fields[el.dataset.f] = el.value;
        ctx.dirty = true;
        $("cbSendBtn").disabled = true;            // re-check on save
        $("cbSendBtn").title = "Save first";
    }
    function onChangeField(e) {
        const el = e.target.closest("[data-f]");
        if (!el || !ctx) return;
        ctx.fields[el.dataset.f] = el.value;
        ctx.dirty = true;
        if (el.tagName === "SELECT") save({ quiet: true });   // pick → re-check right away
    }

    function onBodyClick(e) {
        const up = e.target.closest("[data-upload]");
        if (up) { pickFile(up.dataset.upload); return; }
        const vf = e.target.closest("[data-view-file]");
        if (vf) viewProjectFile(vf.dataset.viewFile);
    }

    function pickFile(field) {
        const input = $("cbFileInput");
        input.value = "";
        input.onchange = () => { const file = input.files[0]; if (file) uploadExhibit(field, file); };
        input.click();
    }

    async function uploadExhibit(field, file) {
        if (!/\.pdf$/i.test(file.name)) { setMessage("Exhibits have to be PDFs.", "error"); return; }
        if (ctx.busy) return;
        setBusy(true, "Uploading…");
        try {
            const kind = field === "sov_file_id" ? "Schedule of Values" : "Proposal";
            const renamed = new File([file], `${field === "sov_file_id" ? "sov" : "proposal"}-${ctx.vendor.company_id}-${file.name}`, { type: "application/pdf" });
            const path = await window.ProjectFields.uploadFile(ctx.projectId, renamed, null, { pathSegments: [CATEGORY, SUBFOLDER] });
            const fileName = `${ctx.vendor.company_name} - ${kind} - ${file.name}`.replace(/[\\/]/g, "-").slice(0, 200);
            const { data, error } = await db().from("project_files").insert({
                project_id: ctx.projectId, category: CATEGORY, subfolder: SUBFOLDER, sub_subfolder: null,
                bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "contract", uploaded_by_name: staffName()
            }).select("id, file_name").single();
            if (error) throw error;
            ctx.fields[field] = data.id;
            ctx.fields[field === "sov_file_id" ? "sov_file_name" : "proposal_file_name"] = data.file_name;
            ctx.busy = false;
            await save({ quiet: true });
            setMessage(`${kind} uploaded.`, "success");
        } catch (err) {
            console.error("Exhibit upload failed:", err);
            setMessage(err?.message || "Couldn't upload the file.", "error");
        } finally {
            setBusy(false);
        }
    }

    async function viewProjectFile(id) {
        const { data, error } = await db().from("project_files").select("file_name, bucket, storage_path").eq("id", id).maybeSingle();
        if (error || !data) { setMessage("Couldn't open the file.", "error"); return; }
        const sign = async dl => {
            const { data: s, error: e } = await db().storage.from(data.bucket || DOCS_BUCKET).createSignedUrl(data.storage_path, 300, dl ? { download: data.file_name } : undefined);
            if (e) throw e; return s.signedUrl;
        };
        window.FilePreview.open({ name: data.file_name, kind: "pdf", getUrl: () => sign(false), getDownloadUrl: () => sign(true) });
    }

    function payloadFields() {
        const f = ctx.fields;
        return {
            scope: f.scope ?? "", amount: f.amount ?? "", retainage: f.retainage ?? "",
            poc_contact_id: f.poc_contact_id || null, safety_contact_id: f.safety_contact_id || null,
            sov_file_id: f.sov_file_id || null, plans_file_id: f.plans_file_id || null, proposal_file_id: f.proposal_file_id || null
        };
    }

    // Saves the choices and builds the PDF. Returns the server's answer.
    async function save(opts = {}) {
        if (!ctx || ctx.busy) return null;
        setBusy(true, opts.quiet ? "Checking…" : "Saving…");
        try {
            const res = await call("save", { project_id: ctx.projectId, company_id: ctx.vendor.company_id, fields: payloadFields() });
            if (!ctx) return null;
            if (!res.ok) { setMessage(res.error || "Couldn't save the contract.", "error"); return null; }
            ctx.status = res.status;
            ctx.missing = res.missing || [];
            ctx.dirty = false;
            ctx.changed = true;
            ctx.lastPreview = res;
            render();
            setMessage(opts.toast ? (res.status === "ready" ? "Draft saved — ready to send." : "Draft saved. Still not completed.") : "", opts.toast ? "success" : "");
            if (opts.toast) window.showToast?.("Contract draft saved.");
            return res;
        } finally {
            if (ctx) setBusy(false);
        }
    }

    async function preview() {
        const res = await save({ quiet: true });
        if (!res) return;
        window.FilePreview.open({
            name: res.name || "Contract (Draft).pdf", kind: "pdf",
            getUrl: async () => res.url,
            getDownloadUrl: async () => res.download_url
        });
    }

    async function send() {
        if (!ctx || ctx.busy) return;
        if (ctx.dirty) { const r = await save({ quiet: true }); if (!r) return; }
        if (ctx.missing.length) { setMessage("Not completed — finish the items at the top first.", "error"); return; }
        const again = ctx.data.sent;
        if (!confirm(again
            ? "Send this new version? It replaces the contract the vendor has now, and any signature on it."
            : `Send this contract to ${ctx.vendor.company_name}? They'll initial every page and sign it in the Vendor Portal.`)) return;
        setBusy(true, "Sending…");
        try {
            const res = await call("send", { project_id: ctx.projectId, company_id: ctx.vendor.company_id });
            if (!ctx) return;
            if (!res.ok) {
                if (res.error === "not_completed") { ctx.missing = res.missing || []; render(); setMessage("Not completed — finish the items at the top first.", "error"); }
                else setMessage(res.error || "Couldn't send the contract.", "error");
                return;
            }
            ctx.changed = true;
            ctx.dirty = false;
            ctx.busy = false;
            window.showToast?.("Contract sent. The vendor can sign it in the Vendor Portal.");
            close();
        } finally {
            if (ctx) setBusy(false);
        }
    }

    /* ---------- Project Manager signs ---------- */

    let pad = null;
    function setupPad() {
        const canvas = $("cbSignPad");
        const c2 = canvas.getContext("2d");
        let drawing = false, last = null;
        pad = { drawn: false, canvas };
        const size = () => {
            const r = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.round(r.width * ratio); canvas.height = Math.round(r.height * ratio);
            c2.setTransform(ratio, 0, 0, ratio, 0, 0);
            c2.lineWidth = 2.2; c2.lineCap = "round"; c2.lineJoin = "round"; c2.strokeStyle = "#14263a";
            pad.drawn = false;
        };
        const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        canvas.onpointerdown = e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); };
        canvas.onpointermove = e => {
            if (!drawing) return;
            const p = pos(e);
            c2.beginPath(); c2.moveTo(last.x, last.y); c2.lineTo(p.x, p.y); c2.stroke();
            last = p; pad.drawn = true;
        };
        canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };
        $("cbSignClear").onclick = () => { c2.clearRect(0, 0, canvas.width, canvas.height); pad.drawn = false; };
        requestAnimationFrame(size);
    }

    function openSign(projectId, vendor, onChange, info) {
        inject();
        signCtx = { projectId, vendor, onChange, busy: false, onViewVendorCopy: info?.onViewVendorCopy };
        $("cbSignSub").textContent = `${vendor.company_name} · subcontract`;
        $("cbSignVendorNote").innerHTML = `<strong>Vendor signed</strong> ${esc(info?.vendorNote || "")}`;
        const form = $("cbSignForm");
        form.reset();
        const name = staffName();
        form.elements.initials.value = name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 4).toUpperCase();
        $("cbSignMessage").textContent = "";
        $("cbSignOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        setupPad();
    }

    function closeSign() {
        if (signCtx?.busy) return;
        $("cbSignOverlay").classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
        signCtx = null;
    }

    async function submitSign(e) {
        e.preventDefault();
        if (!signCtx || signCtx.busy) return;
        const form = $("cbSignForm"), msg = $("cbSignMessage");
        const initials = form.elements.initials.value.trim();
        const missing = [!initials ? "your initials" : null, !pad?.drawn ? "your signature" : null, !form.elements.agree.checked ? "the I agree box" : null].filter(Boolean);
        if (missing.length) { msg.textContent = `Please add ${missing.join(", ")}.`; msg.className = "auth-message error"; return; }
        signCtx.busy = true;
        const btn = $("cbSignSubmit");
        btn.disabled = true; btn.textContent = "Signing…";
        msg.textContent = ""; msg.className = "auth-message";
        try {
            const res = await call("gc_sign", {
                project_id: signCtx.projectId, company_id: signCtx.vendor.company_id, initials,
                title: form.elements.title.value.trim(), agree: true, signature_png: pad.canvas.toDataURL("image/png")
            });
            if (!res.ok) { msg.textContent = res.error === "missing_fields" ? "Please fill in everything." : (res.error || "Couldn't sign."); msg.className = "auth-message error"; return; }
            const done = signCtx.onChange;
            signCtx.busy = false;
            closeSign();
            window.showToast?.("Contract signed by both sides.");
            done?.();
        } finally {
            if (signCtx) signCtx.busy = false;
            btn.disabled = false; btn.textContent = "Initial all pages and sign";
        }
    }

    window.ContractBuilder = { open, openSign };
})();
