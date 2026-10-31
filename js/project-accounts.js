/* ===========================================================
   PROJECT › ACCOUNTS (pages/project-accounts.html)
   Redesign, Coleby 2026-10-31. Two tabs:

   Vendors — every vendor tied to this project (awarded a bid, added in
     Manage Projects, has an invoice here, or invited to bid), from the
     project_vendors() SQL function. Each row shows:
       Contract  this job only (project_vendor_contracts). Staff upload it
                 here; the vendor signs it in the Vendor Portal. Staff can
                 also upload an already-signed copy, or mark it not needed.
       W-9       from the vendor record (Companies.W9FilePath) — same on
                 every job.
       COI       this job's COI PDF (bid_invites / vendor_project_assignments
                 coi_file_id) plus the company's COI expiration date.
     Invited-to-bid vendors are grayed out ("Pending award").
     Clicking a row opens the vendor popup (#vendorDocsOverlay).

   Utility Accounts — water, sewer, electric … (project_utility_accounts)
     with account #, phone, service address, meter #, status and dates.

   Needs sql/supabase-project-accounts-vendors-setup.sql.
   Views open in the portal (window.FilePreview), never a new tab.
=========================================================== */
(function () {
    "use strict";

    const UTILITY_ACCOUNTS_TABLE = "project_utility_accounts";
    const CONTRACTS_TABLE = "project_vendor_contracts";
    const PROJECT_FILES_TABLE = "project_files";
    const DOCS_BUCKET = "project-documents";
    const W9_BUCKET = "company-w9s";
    const CONTRACT_CATEGORY = "contracts_procurement";
    const CONTRACT_SUBFOLDER = "vendors";
    const LINK_SECONDS = 60 * 5;

    const UTILITY_TYPES = [
        { key: "water", label: "Water" },
        { key: "sewer", label: "Sewer" },
        { key: "electric", label: "Electric" },
        { key: "gas", label: "Gas" },
        { key: "trash", label: "Trash" },
        { key: "internet", label: "Internet" },
        { key: "cable", label: "Cable" },
        { key: "other", label: "Other" }
    ];
    const UTILITY_STATUS = {
        active: { label: "Active", cls: "pav-status--active" },
        transferred: { label: "Transferred", cls: "pav-status--moved" },
        closed: { label: "Closed", cls: "pav-status--closed" }
    };
    const SOURCE_LABELS = { awarded: "Awarded", assigned: "Manage Projects", invoice: "Invoice only", invited: "Invited to bid" };

    let currentProject = null;
    let vendors = [];          // project_vendors() rows
    let contracts = [];        // project_vendor_contracts rows for this project
    let contractFiles = {};    // project_files rows by id (contract + signed copies)
    let utilityAccounts = [];
    let openVendorId = null;   // company_id shown in the vendor popup
    let busy = false;
    let editingUtilityAccountId = null;
    let pendingDelete = null;
    let pendingDeleteName = "";
    const revealed = new Set(); // utility account ids whose number is shown

    /* ---------- helpers ---------- */

    const $ = id => document.getElementById(id);

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function db() { return window.supabaseClient; }

    function getStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }
    function getStaffName() {
        const p = getStaffProfile();
        return (p && (p.full_name || p.username)) || "Staff";
    }
    function getStaffId() {
        const p = getStaffProfile();
        return p?.id || null;
    }
    function can(key) {
        return window.Permissions ? window.Permissions.hasPermission(key) : true;
    }

    function setPageMessage(text, type) {
        const el = $("accountsPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") {
            setTimeout(() => { el.style.display = "none"; }, 4000);
            window.showToast?.(text);
        }
    }

    function setPopupMessage(text, type) {
        const el = $("vendorDocsMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    // Dates: timestamps → local day; "YYYY-MM-DD" stays that day (no UTC shift).
    function fmtDay(value) {
        if (!value) return "";
        const s = String(value);
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
        if (isNaN(d)) return s;
        return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
    }
    function isPast(dateStr) {
        if (!dateStr) return false;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return new Date(`${String(dateStr).slice(0, 10)}T12:00:00`) < today;
    }

    const chevron = `<svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    // A status badge. tone: ok | missing | warn | bad | na
    function badge(text, tone, withChevron) {
        const cls = {
            ok: "",
            missing: "doc-badge-trigger--missing",
            warn: "doc-badge-trigger--expiring",
            bad: "doc-badge-trigger--expired",
            na: "pav-badge--na"
        }[tone] || "";
        return `<span class="doc-badge-trigger ${cls}">${esc(text)}${withChevron ? chevron : ""}</span>`;
    }

    /* ---------- status for each document ---------- */

    function isPending(v) {
        // Only invited to bid (no award, not added, no invoice) → grayed out.
        return v.sources.length === 1 && v.sources[0] === "invited";
    }
    function needsPaperwork(v) {
        // Contract + COI are asked for once a vendor is actually working the job.
        return v.sources.includes("awarded") || v.sources.includes("assigned");
    }
    function contractFor(v) {
        return contracts.find(c => String(c.company_id) === String(v.company_id)) || null;
    }

    function contractStatus(v) {
        if (isPending(v)) return { text: "Pending", tone: "na", meta: "Not awarded yet" };
        const c = contractFor(v);
        if (c?.not_needed) return { text: "Not needed", tone: "na", meta: "" };
        if (c?.signed_file_id) return { text: "Signed", tone: "ok", meta: `Signed ${fmtDay(c.signed_at)}${c.signed_in_portal ? " in portal" : ""}` };
        if (c?.file_id) return { text: "Waiting on signature", tone: "warn", meta: `Sent ${fmtDay(c.updated_at || c.created_at)}` };
        if (!needsPaperwork(v)) return { text: "Not needed", tone: "na", meta: "" };
        return { text: "Missing", tone: "missing", meta: "Upload contract" };
    }

    function w9Status(v) {
        if (v.w9_exempt) return { text: "Exempt", tone: "na", meta: "" };
        if (v.w9_file_path) return { text: "On file", tone: "ok", meta: v.w9_updated_at ? `Updated ${fmtDay(v.w9_updated_at)}` : "" };
        return { text: "Missing", tone: "missing", meta: "Not on vendor record" };
    }

    function coiStatus(v) {
        const dateNote = v.coi_expires_on ? `${isPast(v.coi_expires_on) ? "Expired" : "Expires"} ${fmtDay(v.coi_expires_on)}` : "No company COI date";
        if (v.coi_exempt) return { text: "Exempt", tone: "na", meta: "" };
        if (isPending(v)) return { text: "Pending", tone: "na", meta: "Not awarded yet" };
        if (v.coi_expires_on && isPast(v.coi_expires_on)) return { text: "Expired", tone: "bad", meta: dateNote };
        if (v.coi_file_id) return { text: "Received", tone: "ok", meta: dateNote };
        if (!needsPaperwork(v)) return { text: "Not needed", tone: "na", meta: v.coi_expires_on ? `Company COI ${dateNote.toLowerCase()}` : "" };
        if (v.coi_requested_at) return { text: "Requested", tone: "warn", meta: `Asked ${fmtDay(v.coi_requested_at)} · ${dateNote.toLowerCase()}` };
        return { text: "Missing", tone: "missing", meta: dateNote };
    }

    function needsAttention(v) {
        if (isPending(v)) return false;
        return [contractStatus(v), w9Status(v), coiStatus(v)].some(s => s.tone === "missing" || s.tone === "bad" || s.tone === "warn");
    }

    /* ---------- load ---------- */

    async function loadVendors() {
        const [vRes, cRes] = await Promise.all([
            db().rpc("project_vendors", { p_project_id: currentProject.id }),
            db().from(CONTRACTS_TABLE).select("*").eq("project_id", currentProject.id)
        ]);
        if (vRes.error) {
            console.error("project_vendors failed:", vRes.error);
            setPageMessage("Couldn't load this project's vendors. (Has sql/supabase-project-accounts-vendors-setup.sql been run?)", "error");
        }
        if (cRes.error) console.error("Failed to load contracts:", cRes.error);
        vendors = (vRes.data || []).map(v => ({ ...v, sources: v.sources || [] }));
        contracts = cRes.data || [];

        const fileIds = [...new Set(contracts.flatMap(c => [c.file_id, c.signed_file_id]).filter(Boolean))];
        contractFiles = {};
        if (fileIds.length) {
            const { data, error } = await db().from(PROJECT_FILES_TABLE).select("id, file_name, bucket, storage_path, created_at, uploaded_by_name").in("id", fileIds);
            if (error) console.error("Failed to load contract files:", error);
            (data || []).forEach(f => { contractFiles[f.id] = f; });
        }
    }

    async function loadUtilities() {
        const { data, error } = await db().from(UTILITY_ACCOUNTS_TABLE).select("*").eq("project_id", currentProject.id).order("created_at", { ascending: true });
        if (error) console.error("Failed to load utility accounts:", error);
        utilityAccounts = data || [];
    }

    /* ---------- Vendors tab ---------- */

    function filteredVendors() {
        const q = ($("vendorsSearchInput")?.value || "").trim().toLowerCase();
        const source = $("vendorsSourceFilter")?.value || "";
        const attention = $("vendorsAttentionFilter")?.value === "attention";
        return vendors.filter(v => {
            if (source && !v.sources.includes(source)) return false;
            if (attention && !needsAttention(v)) return false;
            if (q && !`${v.company_name} ${v.scope || ""}`.toLowerCase().includes(q)) return false;
            return true;
        }).sort((a, b) => Number(isPending(a)) - Number(isPending(b)) || String(a.company_name).localeCompare(String(b.company_name)));
    }

    function renderStats() {
        const active = vendors.filter(v => !isPending(v));
        $("statVendors").textContent = vendors.length;
        $("statContracts").textContent = active.filter(v => ["missing", "warn"].includes(contractStatus(v).tone)).length;
        $("statW9").textContent = active.filter(v => w9Status(v).tone === "missing").length;
        $("statCoi").textContent = active.filter(v => ["missing", "warn", "bad"].includes(coiStatus(v).tone)).length;
        $("vendorsTabCount").textContent = vendors.length;
    }

    function cell(status) {
        return `<div class="pav-cell">${badge(status.text, status.tone, true)}${status.meta ? `<span class="pav-sub">${esc(status.meta)}</span>` : ""}</div>`;
    }

    // "Allowed to be on site" — per vendor, per project (project_vendor_contracts.allowed_on_site).
    function onSiteToggle(v) {
        const yes = Boolean(contractFor(v)?.allowed_on_site);
        return `<button type="button" class="pav-onsite ${yes ? "pav-onsite--yes" : ""}" data-onsite="${esc(v.company_id)}" aria-pressed="${yes}" title="Allowed to be on site — click to change">${yes ? "Yes" : "No"}</button>`;
    }

    async function toggleOnSite(companyId) {
        if (busy) return;
        const v = vendors.find(x => String(x.company_id) === String(companyId));
        if (!v) return;
        busy = true;
        try {
            await upsertContract(v.company_id, { allowed_on_site: !contractFor(v)?.allowed_on_site });
            renderVendors();
        } catch (err) {
            console.error("On site update failed:", err);
            setPageMessage(/allowed_on_site/.test(err?.message || "")
                ? "Re-run sql/supabase-project-accounts-vendors-setup.sql to turn on \"Allowed on site\"."
                : (err?.message || "Couldn't save."), "error");
        } finally { busy = false; }
    }

    function renderVendors() {
        renderStats();
        const rows = filteredVendors();
        $("vendorsEmpty").style.display = rows.length ? "none" : "block";
        if (!vendors.length) $("vendorsEmpty").textContent = "No vendors on this project yet. Vendors show up here once they're awarded a bid, added in Manage Projects on the vendor page, invited to bid, or have an invoice on this job.";
        else if (!rows.length) $("vendorsEmpty").textContent = "No vendors match these filters.";

        $("vendorsList").innerHTML = rows.map(v => {
            const pending = isPending(v);
            const due = pending && v.bid_due_at ? ` · bid due ${fmtDay(v.bid_due_at)}` : "";
            return `
            <div class="all-files-file-row pav-row${pending ? " pav-row--pending" : ""}" data-vendor="${esc(v.company_id)}">
                <div class="pav-cell">
                    <button type="button" class="pav-name-btn" data-open-vendor="${esc(v.company_id)}">${esc(v.company_name)}</button>
                    <span class="pav-sub">${esc((v.scope || "No scope listed") + due)}</span>
                </div>
                <div class="pav-cell">
                    <span class="pav-source">${esc(v.sources.map(s => SOURCE_LABELS[s]).filter(Boolean).join(" · "))}</span>
                    ${pending ? `<span class="pav-status pav-status--closed">Pending award</span>` : ""}
                </div>
                ${cell(contractStatus(v))}
                ${cell(w9Status(v))}
                ${cell(coiStatus(v))}
                <div class="pav-cell">${onSiteToggle(v)}</div>
                <div class="pav-cell pav-cell--end">
                    <button type="button" class="all-files-file-menu-btn" data-open-vendor="${esc(v.company_id)}" aria-label="Open ${esc(v.company_name)}">
                        <span class="all-files-file-menu-icon"></span>
                    </button>
                </div>
            </div>`;
        }).join("");
    }

    /* ---------- vendor popup ---------- */

    function fileRow(file, label, actionsHtml) {
        return `<div class="pav-file">
            <span class="pav-file-name">${esc(label || file?.file_name || "")}${file?.created_at ? `<span class="pav-sub">Uploaded ${esc(fmtDay(file.created_at))}${file.uploaded_by_name ? ` · ${esc(file.uploaded_by_name)}` : ""}</span>` : ""}</span>
            <div class="pav-btn-row">${actionsHtml}</div>
        </div>`;
    }
    function viewBtns(kind, id) {
        return `<button type="button" class="workbook-btn workbook-btn--preview" data-doc-view="${kind}" data-doc-id="${esc(id)}">View</button>
                <button type="button" class="workbook-btn workbook-btn--download" data-doc-download="${kind}" data-doc-id="${esc(id)}">Download</button>`;
    }

    function contractSection(v) {
        const c = contractFor(v);
        const st = contractStatus(v);
        const original = c?.file_id ? contractFiles[c.file_id] : null;
        const signed = c?.signed_file_id ? contractFiles[c.signed_file_id] : null;
        const pending = isPending(v);

        let body = "";
        if (pending) {
            body = `<p class="pav-note">This vendor hasn't been awarded yet. Upload the contract once they're awarded.</p>`;
        } else if (c?.not_needed) {
            body = `<p class="pav-note">Marked as not needed for this vendor.</p>
                <div class="pav-btn-row"><button type="button" class="workbook-btn workbook-btn--preview" data-contract-action="needed">Contract is needed</button></div>`;
        } else {
            if (signed) {
                body += fileRow(signed, signed.file_name, viewBtns("file", signed.id));
                if (c.signed_in_portal) body += `<p class="pav-note">Signed in the Vendor Portal by ${esc(c.signer_name || "")}${c.signer_title ? `, ${esc(c.signer_title)}` : ""} on ${esc(new Date(c.signed_at).toLocaleString("en-US"))}.</p>`;
            } else if (original) {
                body += fileRow(original, original.file_name, viewBtns("file", original.id));
                body += `<p class="pav-note">Waiting on the vendor to sign it in the Vendor Portal. Their project stays locked until it's signed.</p>`;
            }
            body += `
                <form class="pav-upload" id="contractUploadForm">
                    <label class="auth-field pav-upload-field">${original || signed ? "Upload a new contract" : "Contract PDF"}
                        <input type="file" name="file" accept="application/pdf,.pdf">
                    </label>
                    <label class="pav-check"><input type="checkbox" name="already_signed"> This copy is already signed</label>
                    <div class="pav-btn-row">
                        <button type="submit" class="auth-button" id="contractUploadBtn">Upload Contract</button>
                        ${!original && !signed ? `<button type="button" class="workbook-btn workbook-btn--preview" data-contract-action="not_needed">Not needed</button>` : ""}
                    </div>
                </form>`;
        }
        return `<div class="pav-doc">
            <div class="pav-doc-head">
                <div><span class="pav-doc-title">Contract</span><span class="pav-sub">This project only · saves to Files › Contracts &amp; Procurement › Vendors</span></div>
                ${badge(st.text, st.tone)}
            </div>
            ${body}
        </div>`;
    }

    function w9Section(v) {
        const st = w9Status(v);
        return `<div class="pav-doc">
            <div class="pav-doc-head">
                <div><span class="pav-doc-title">W-9</span><span class="pav-sub">From the vendor record · same on every job</span></div>
                ${badge(st.text, st.tone)}
            </div>
            ${v.w9_file_path
                ? fileRow(null, `W-9${v.w9_updated_at ? ` · updated ${fmtDay(v.w9_updated_at)}` : ""}`, viewBtns("w9", v.company_id))
                : `<p class="pav-note">${v.w9_exempt ? "This vendor is W-9 exempt." : "No W-9 on the vendor record. Add it on the vendor page, or the vendor can upload it in the Vendor Portal."}</p>`}
        </div>`;
    }

    function coiSection(v) {
        const st = coiStatus(v);
        const company = v.coi_expires_on ? `Company COI ${isPast(v.coi_expires_on) ? "expired" : "expires"} ${fmtDay(v.coi_expires_on)}` : "No company COI date on file";
        const canRequest = v.awarded_invite_id && can("projects.manage_bid_invites") && !v.coi_exempt;
        let body = "";
        if (v.coi_file_id) {
            body = fileRow(null, v.coi_file_name || "COI", viewBtns("file", v.coi_file_id));
        } else if (v.coi_exempt) {
            body = `<p class="pav-note">This vendor is COI exempt.</p>`;
        } else if (isPending(v)) {
            body = `<p class="pav-note">Asked for once the vendor is awarded.</p>`;
        } else {
            body = `<p class="pav-note">${v.coi_requested_at ? `Asked ${fmtDay(v.coi_requested_at)} · not uploaded yet.` : "Not uploaded yet. The vendor uploads it in the Vendor Portal under My Projects."}</p>`;
        }
        if (canRequest) body += `<div class="pav-btn-row"><button type="button" class="auth-button" data-request-coi="${esc(v.awarded_invite_id)}">${v.coi_requested_at ? "Request COI Again" : "Request COI"}</button></div>`;
        return `<div class="pav-doc">
            <div class="pav-doc-head">
                <div><span class="pav-doc-title">COI</span><span class="pav-sub">PDF for this project · ${esc(company)}</span></div>
                ${badge(st.text, st.tone)}
            </div>
            ${body}
        </div>`;
    }

    function renderVendorPopup() {
        const v = vendors.find(x => String(x.company_id) === String(openVendorId));
        if (!v) { closeVendorPopup(); return; }
        $("vendorDocsTitle").textContent = v.company_name;
        $("vendorDocsSub").textContent = [v.sources.map(s => SOURCE_LABELS[s]).join(" · "), v.scope ? `Scope: ${v.scope}` : ""].filter(Boolean).join(" · ");
        $("vendorDocsVendorLink").href = `/pages/vendor.html?id=${encodeURIComponent(v.company_id)}`;
        $("vendorDocsBody").innerHTML = `<div class="pav-doc-stack">${contractSection(v)}${w9Section(v)}${coiSection(v)}</div>`;
        $("contractUploadForm")?.addEventListener("submit", uploadContract);
    }

    function openVendorPopup(companyId) {
        openVendorId = companyId;
        setPopupMessage("");
        renderVendorPopup();
        $("vendorDocsOverlay").classList.remove("hidden");
    }
    function closeVendorPopup() {
        $("vendorDocsOverlay").classList.add("hidden");
        openVendorId = null;
    }

    /* ---------- contract actions ---------- */

    async function upsertContract(companyId, patch) {
        const existing = contracts.find(c => String(c.company_id) === String(companyId));
        const q = existing
            ? db().from(CONTRACTS_TABLE).update(patch).eq("id", existing.id).select().single()
            : db().from(CONTRACTS_TABLE).insert({ project_id: currentProject.id, company_id: companyId, ...patch }).select().single();
        const { data, error } = await q;
        if (error) throw error;
        contracts = existing ? contracts.map(c => c.id === data.id ? data : c) : [...contracts, data];
        return data;
    }

    async function uploadContract(event) {
        event.preventDefault();
        if (busy) return;
        const v = vendors.find(x => String(x.company_id) === String(openVendorId));
        const form = event.target;
        const file = form.elements.file.files[0];
        const alreadySigned = form.elements.already_signed.checked;
        if (!file) { setPopupMessage("Choose the contract PDF first.", "error"); return; }
        if (!/\.pdf$/i.test(file.name)) { setPopupMessage("The contract has to be a PDF.", "error"); return; }

        busy = true;
        const btn = $("contractUploadBtn");
        btn.disabled = true; btn.textContent = "Uploading…";
        setPopupMessage("");
        try {
            const renamed = new File([file], `contract-${v.company_id}-${file.name}`, { type: file.type || "application/pdf" });
            const path = await window.ProjectFields.uploadFile(currentProject.id, renamed, null, { pathSegments: [CONTRACT_CATEGORY, CONTRACT_SUBFOLDER] });
            const fileName = `${v.company_name} - Contract${alreadySigned ? " (Signed)" : ""} - ${file.name}`.replace(/[\\/]/g, "-").slice(0, 200);
            const { data: fileRowData, error: fileError } = await db().from(PROJECT_FILES_TABLE).insert({
                project_id: currentProject.id, category: CONTRACT_CATEGORY, subfolder: CONTRACT_SUBFOLDER, sub_subfolder: null,
                bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "contract",
                uploaded_by_name: getStaffName()
            }).select("id, file_name, bucket, storage_path, created_at, uploaded_by_name").single();
            if (fileError) throw fileError;
            contractFiles[fileRowData.id] = fileRowData;

            const base = { file_id: fileRowData.id, not_needed: false, uploaded_by: getStaffId(), uploaded_by_name: getStaffName() };
            const patch = alreadySigned
                ? { ...base, signed_file_id: fileRowData.id, signed_at: new Date().toISOString(), signed_in_portal: false,
                    signer_name: null, signer_title: null, signer_email: null, signer_vendor_user_id: null, signer_ip: null }
                : { ...base, signed_file_id: null, signed_at: null, signed_in_portal: false,
                    signer_name: null, signer_title: null, signer_email: null, signer_vendor_user_id: null, signer_ip: null };
            await upsertContract(v.company_id, patch);
            renderVendors();
            renderVendorPopup();
            setPopupMessage(alreadySigned ? "Signed contract saved." : "Contract uploaded. The vendor can sign it in the Vendor Portal.", "success");
        } catch (err) {
            console.error("Contract upload failed:", err);
            setPopupMessage(err?.message || "Couldn't upload the contract.", "error");
        } finally {
            busy = false;
            if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = "Upload Contract"; }
        }
    }

    async function setContractNeeded(needed) {
        if (busy) return;
        busy = true;
        try {
            await upsertContract(openVendorId, { not_needed: !needed });
            renderVendors();
            renderVendorPopup();
        } catch (err) {
            setPopupMessage(err?.message || "Couldn't save.", "error");
        } finally { busy = false; }
    }

    /* ---------- request COI (bid-invites › request_coi) ---------- */

    async function requestCoi(inviteId) {
        if (busy) return;
        busy = true;
        setPopupMessage("Sending…");
        try {
            const { data, error } = await db().functions.invoke("bid-invites", { body: { action: "request_coi", invite_id: inviteId } });
            let message = error?.message;
            if (error) {
                try { const payload = await error.context?.json?.(); if (payload?.error) message = payload.error; } catch { /* keep */ }
            } else if (data && data.ok === false) message = data.error;
            if (message) { setPopupMessage(`COI request didn't send: ${message}`, "error"); return; }
            await loadVendors();
            renderVendors();
            renderVendorPopup();
            setPopupMessage("COI requested.", "success");
        } finally { busy = false; }
    }

    /* ---------- view / download (in-portal preview) ---------- */

    async function signedUrl(kind, id, download) {
        if (kind === "w9") {
            const v = vendors.find(x => String(x.company_id) === String(id));
            const name = `${v.company_name} - W-9.pdf`.replace(/[\\/]/g, "-");
            const { data, error } = await db().storage.from(W9_BUCKET).createSignedUrl(v.w9_file_path, LINK_SECONDS, { download: download ? name : undefined });
            if (error) throw error;
            return { url: data.signedUrl, name };
        }
        let f = contractFiles[id];
        if (!f) {
            const { data, error } = await db().from(PROJECT_FILES_TABLE).select("id, file_name, bucket, storage_path").eq("id", id).maybeSingle();
            if (error || !data) throw error || new Error("File not found");
            f = data;
        }
        const { data, error } = await db().storage.from(f.bucket || DOCS_BUCKET).createSignedUrl(f.storage_path, LINK_SECONDS, { download: download ? f.file_name : undefined });
        if (error) throw error;
        return { url: data.signedUrl, name: f.file_name };
    }

    function openDoc(kind, id, download) {
        if (download) {
            signedUrl(kind, id, true)
                .then(r => window.FilePreview.download(r.url, r.name))
                .catch(err => setPopupMessage(err?.message || "Couldn't download the file.", "error"));
            return;
        }
        const v = kind === "w9" ? vendors.find(x => String(x.company_id) === String(id)) : null;
        const name = kind === "w9" ? `${v?.company_name || "Vendor"} - W-9.pdf` : (contractFiles[id]?.file_name || vendors.find(x => x.coi_file_id === id)?.coi_file_name || "Document.pdf");
        window.FilePreview.open({
            name,
            kind: "pdf",
            getUrl: async () => (await signedUrl(kind, id, false)).url,
            getDownloadUrl: async () => (await signedUrl(kind, id, true)).url
        });
    }

    /* ---------- Utility Accounts tab ---------- */

    const UTILITY_ICONS = {
        water: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
        sewer: "M4 8h10a4 4 0 0 1 4 4v8M4 12h8a2 2 0 0 1 2 2v6M4 6v8",
        electric: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
        gas: "M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-8z",
        trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
        internet: "M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M12 20h.01",
        cable: "M3 7h18v11H3zM8 21h8M12 3l-3 4M12 3l3 4",
        other: "M4 6h16v12H4zM4 10h16"
    };

    function typeLabel(key) { return (UTILITY_TYPES.find(t => t.key === key) || {}).label || "Other"; }
    function maskNumber(n) { return n ? `•••• ${String(n).slice(-4)}` : "—"; }

    function filteredUtilities() {
        const q = ($("utilityAccountsSearchInput")?.value || "").trim().toLowerCase();
        const type = $("utilityAccountsTypeFilter")?.value || "";
        const status = $("utilityAccountsStatusFilter")?.value || "";
        const order = UTILITY_TYPES.map(t => t.key);
        return utilityAccounts.filter(u => {
            if (type && u.utility_type !== type) return false;
            if (status && (u.status || "active") !== status) return false;
            if (q && ![u.provider_name, u.account_number, u.phone, u.service_address, u.meter_number].filter(Boolean).join(" ").toLowerCase().includes(q)) return false;
            return true;
        }).sort((a, b) => order.indexOf(a.utility_type) - order.indexOf(b.utility_type) || String(a.provider_name).localeCompare(String(b.provider_name)));
    }

    function renderUtilities() {
        $("utilitiesTabCount").textContent = utilityAccounts.length;
        const rows = filteredUtilities();
        $("utilityAccountsEmpty").style.display = rows.length ? "none" : "block";
        $("utilityAccountsEmpty").textContent = utilityAccounts.length ? "No utility accounts match these filters." : "No utility accounts on file yet — add one with \"+ Add Utility Account\" above.";
        $("utilityAccountsList").innerHTML = rows.map(u => {
            const st = UTILITY_STATUS[u.status] || UTILITY_STATUS.active;
            const shown = revealed.has(u.id);
            const endLabel = u.status === "transferred" ? "Transferred" : "Close date";
            return `
            <article class="pd-card pav-util-card">
                <div class="pav-util-head">
                    <div class="pav-util-title">
                        <span class="pav-util-icon pav-util-icon--${esc(u.utility_type)}">
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${UTILITY_ICONS[u.utility_type] || UTILITY_ICONS.other}"></path></svg>
                        </span>
                        <div>
                            <span class="pav-util-type">${esc(typeLabel(u.utility_type))}</span>
                            <h3 class="pd-card-title">${esc(u.provider_name)}</h3>
                        </div>
                    </div>
                    <span class="pav-status ${st.cls}">${esc(st.label)}</span>
                </div>
                <dl class="pav-fields">
                    <div><dt>Account #</dt><dd>${esc(shown ? (u.account_number || "—") : maskNumber(u.account_number))}${u.account_number ? ` <button type="button" class="pav-link-btn" data-reveal="${esc(u.id)}">${shown ? "Hide" : "Show"}</button>` : ""}</dd></div>
                    <div><dt>Phone</dt><dd>${u.phone ? `<a class="pav-link" href="tel:${esc(u.phone.replace(/[^0-9+]/g, ""))}">${esc(u.phone)}</a>` : "—"}</dd></div>
                    <div><dt>Service address</dt><dd>${esc(u.service_address || "—")}</dd></div>
                    <div><dt>Meter #</dt><dd>${esc(u.meter_number || "—")}</dd></div>
                    <div><dt>Start date</dt><dd>${esc(fmtDay(u.start_date) || "—")}</dd></div>
                    <div><dt>${endLabel}</dt><dd>${esc(fmtDay(u.close_date) || "—")}</dd></div>
                </dl>
                ${u.notes ? `<p class="pav-note">${esc(u.notes)}</p>` : ""}
                <div class="pav-util-foot">
                    <span class="pav-sub">Added by ${esc(u.created_by_name || "Staff")} · ${esc(fmtDay(u.created_at))}</span>
                    <div class="pav-btn-row">
                        <button type="button" class="workbook-btn workbook-btn--preview" data-util-edit="${esc(u.id)}">Edit</button>
                        <button type="button" class="workbook-btn pav-btn--danger" data-util-delete="${esc(u.id)}">Delete</button>
                    </div>
                </div>
            </article>`;
        }).join("");
    }

    function syncCloseLabel() {
        $("utilityAccountFormCloseLabel").textContent = $("utilityAccountFormStatus").value === "transferred" ? "Transfer date" : "Close date";
    }

    function openUtilityModal(existing) {
        editingUtilityAccountId = existing ? existing.id : null;
        $("utilityAccountModalTitle").textContent = existing ? "Edit Utility Account" : "Add Utility Account";
        $("utilityAccountFormType").value = existing?.utility_type || "water";
        $("utilityAccountFormStatus").value = existing?.status || "active";
        $("utilityAccountFormProvider").value = existing?.provider_name || "";
        $("utilityAccountFormNumber").value = existing?.account_number || "";
        $("utilityAccountFormPhone").value = existing?.phone || "";
        $("utilityAccountFormAddress").value = existing?.service_address || "";
        $("utilityAccountFormMeter").value = existing?.meter_number || "";
        $("utilityAccountFormStart").value = existing?.start_date || "";
        $("utilityAccountFormClose").value = existing?.close_date || "";
        $("utilityAccountFormNotes").value = existing?.notes || "";
        $("utilityAccountFormMessage").textContent = "";
        syncCloseLabel();
        $("utilityAccountModalOverlay").classList.remove("hidden");
        $("utilityAccountFormProvider").focus();
    }
    function closeUtilityModal() {
        $("utilityAccountModalOverlay").classList.add("hidden");
        editingUtilityAccountId = null;
    }

    async function submitUtilityForm(event) {
        event.preventDefault();
        const msg = $("utilityAccountFormMessage");
        const val = id => $(id).value.trim() || null;
        const payload = {
            project_id: currentProject.id,
            utility_type: $("utilityAccountFormType").value,
            status: $("utilityAccountFormStatus").value,
            provider_name: $("utilityAccountFormProvider").value.trim(),
            account_number: val("utilityAccountFormNumber"),
            phone: val("utilityAccountFormPhone"),
            service_address: val("utilityAccountFormAddress"),
            meter_number: val("utilityAccountFormMeter"),
            start_date: val("utilityAccountFormStart"),
            close_date: val("utilityAccountFormClose"),
            notes: val("utilityAccountFormNotes")
        };
        if (!payload.provider_name) { msg.textContent = "Provider name is required."; return; }
        const btn = $("saveUtilityAccountBtn");
        btn.disabled = true;
        const { data, error } = editingUtilityAccountId
            ? await db().from(UTILITY_ACCOUNTS_TABLE).update(payload).eq("id", editingUtilityAccountId).select().single()
            : await db().from(UTILITY_ACCOUNTS_TABLE).insert(payload).select().single();
        btn.disabled = false;
        if (error) { msg.textContent = error.message || "Couldn't save this utility account."; return; }
        utilityAccounts = editingUtilityAccountId ? utilityAccounts.map(u => u.id === data.id ? data : u) : [...utilityAccounts, data];
        closeUtilityModal();
        renderUtilities();
        setPageMessage("Utility account saved.", "success");
    }

    /* ---------- delete confirm (utility accounts) ---------- */

    function deleteReady() {
        const typed = $("deleteRecordConfirmNameInput").value.trim();
        return pendingDeleteName.length > 0 && typed === pendingDeleteName && $("deleteRecordConfirmUnderstandCheckbox").checked;
    }
    function updateDeleteBtn() { $("confirmDeleteRecordBtn").disabled = !deleteReady(); }

    function openDeleteConfirm(id) {
        const u = utilityAccounts.find(x => String(x.id) === String(id));
        if (!u) return;
        pendingDelete = u.id;
        pendingDeleteName = u.provider_name || "";
        $("deleteRecordConfirmName").textContent = pendingDeleteName;
        $("deleteRecordConfirmMessage").textContent = "";
        $("deleteRecordConfirmNameInput").value = "";
        $("deleteRecordConfirmUnderstandCheckbox").checked = false;
        $("deleteRecordConfirmOverlay").classList.remove("hidden");
        updateDeleteBtn();
        $("deleteRecordConfirmNameInput").focus();
    }
    function closeDeleteConfirm() {
        $("deleteRecordConfirmOverlay").classList.add("hidden");
        pendingDelete = null;
        pendingDeleteName = "";
    }
    async function confirmDelete() {
        if (!pendingDelete || !deleteReady()) return;
        const id = pendingDelete;
        const { error } = await db().from(UTILITY_ACCOUNTS_TABLE).delete().eq("id", id);
        if (error) { $("deleteRecordConfirmMessage").textContent = error.message || "Couldn't delete this account."; return; }
        utilityAccounts = utilityAccounts.filter(u => u.id !== id);
        closeDeleteConfirm();
        renderUtilities();
        setPageMessage("Deleted.", "success");
    }

    /* ---------- tabs + wiring ---------- */

    function switchTab(key) {
        document.querySelectorAll("#accountsTabs .dash-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === key));
        document.querySelectorAll(".accounts-tab-panel[data-tab-panel]").forEach(p => p.classList.toggle("hidden", p.dataset.tabPanel !== key));
    }

    function wire() {
        document.querySelectorAll("#accountsTabs .dash-tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

        const typeSel = $("utilityAccountsTypeFilter");
        typeSel.innerHTML = `<option value="">All types</option>` + UTILITY_TYPES.map(t => `<option value="${t.key}">${t.label}</option>`).join("");
        $("utilityAccountFormType").innerHTML = UTILITY_TYPES.map(t => `<option value="${t.key}">${t.label}</option>`).join("");

        ["vendorsSearchInput", "vendorsSourceFilter", "vendorsAttentionFilter"].forEach(id => {
            $(id).addEventListener("input", renderVendors);
            $(id).addEventListener("change", renderVendors);
        });
        ["utilityAccountsSearchInput", "utilityAccountsTypeFilter", "utilityAccountsStatusFilter"].forEach(id => {
            $(id).addEventListener("input", renderUtilities);
            $(id).addEventListener("change", renderUtilities);
        });

        $("addUtilityAccountBtn").addEventListener("click", () => openUtilityModal(null));
        $("utilityAccountForm").addEventListener("submit", submitUtilityForm);
        $("utilityAccountFormStatus").addEventListener("change", syncCloseLabel);
        $("cancelUtilityAccountBtn").addEventListener("click", closeUtilityModal);
        $("utilityAccountModalOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeUtilityModal(); });

        $("closeVendorDocsBtn").addEventListener("click", closeVendorPopup);
        $("doneVendorDocsBtn").addEventListener("click", closeVendorPopup);
        $("vendorDocsOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeVendorPopup(); });

        $("cancelDeleteRecordBtn").addEventListener("click", closeDeleteConfirm);
        $("confirmDeleteRecordBtn").addEventListener("click", confirmDelete);
        $("deleteRecordConfirmOverlay").addEventListener("click", e => { if (e.target === e.currentTarget) closeDeleteConfirm(); });
        $("deleteRecordConfirmNameInput").addEventListener("input", updateDeleteBtn);
        $("deleteRecordConfirmUnderstandCheckbox").addEventListener("change", updateDeleteBtn);

        document.addEventListener("click", e => {
            const os = e.target.closest("[data-onsite]");
            if (os) { toggleOnSite(os.dataset.onsite); return; }
            const open = e.target.closest("[data-open-vendor]");
            if (open) { openVendorPopup(open.dataset.openVendor); return; }
            const row = e.target.closest(".pav-row[data-vendor]");
            if (row && !e.target.closest("button, a")) { openVendorPopup(row.dataset.vendor); return; }

            const view = e.target.closest("[data-doc-view]");
            if (view) { openDoc(view.dataset.docView, view.dataset.docId, false); return; }
            const dl = e.target.closest("[data-doc-download]");
            if (dl) { openDoc(dl.dataset.docDownload, dl.dataset.docId, true); return; }

            const ca = e.target.closest("[data-contract-action]");
            if (ca) { setContractNeeded(ca.dataset.contractAction === "needed"); return; }
            const rc = e.target.closest("[data-request-coi]");
            if (rc) { requestCoi(rc.dataset.requestCoi); return; }

            const rv = e.target.closest("[data-reveal]");
            if (rv) {
                const id = rv.dataset.reveal;
                if (revealed.has(id)) revealed.delete(id); else revealed.add(id);
                renderUtilities();
                return;
            }
            const ed = e.target.closest("[data-util-edit]");
            if (ed) { openUtilityModal(utilityAccounts.find(u => String(u.id) === ed.dataset.utilEdit)); return; }
            const del = e.target.closest("[data-util-delete]");
            if (del) openDeleteConfirm(del.dataset.utilDelete);
        });

        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            if (!$("sharedFilePreviewOverlay") || $("sharedFilePreviewOverlay").classList.contains("hidden")) {
                closeVendorPopup();
                closeUtilityModal();
                closeDeleteConfirm();
            }
        });
    }

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        if (error || !project) {
            setPageMessage("No project selected. Pick one from Project Overview.", "error");
            $("accountsLoadingState").style.display = "none";
            return;
        }
        currentProject = project;
        wire();
        try { await window.Permissions?.initPermissions?.(); } catch { /* fails open */ }
        await Promise.all([loadVendors(), loadUtilities()]);
        renderVendors();
        renderUtilities();
        $("accountsLoadingState").style.display = "none";
        $("accountsBody").style.display = "block";
    });
})();
