/* ===========================================================
   VENDOR PAGE (pages/vendor.html?id=<Companies.id>)

   Opened by clicking a vendor card on the Vendors page (it replaced the old
   profile popup — Coleby, 2026-10-19). Two sections:

     Company info  Company details (legal + friendly name, address,
                   approval, tags by category), Tax information (W-9 +
                   SSN/FID), Notes, Projects (where they've been awarded a
                   bid or invoiced, with the vendor's COI — one COI per
                   vendor, same expiration on every project).
     Account info  Contacts, with who has a Vendor Portal login ("Vendor
                   Dashboard User"; the "Account Holder" is the one who can
                   add/remove their teammates in the portal). Save a contact
                   — or all of them — to your phone (.vcf). Contacts that
                   look like the same person are flagged so they can be
                   merged (e.g. Leeward added someone, then the vendor gave
                   them a portal login under a different email).

   Editing the vendor itself (W-9/COI uploads, tags) still happens in the
   Vendors page's Edit Vendor popup — the button here links to it
   (vendors.html?edit=<id>).

   Permissions (same keys the Vendors page uses): vendors.add_edit_vendor,
   vendors.save_notes, vendors.manage_contacts.
=========================================================== */
(function () {
    "use strict";

    const W9_BUCKET = "company-w9s";
    const COI_BUCKET = "company-cois";
    const COI_EXPIRING_SOON_DAYS = 30;

    const $ = id => document.getElementById(id);
    const client = () => window.supabaseClient;

    let company = null;
    let contacts = [];
    let logins = [];          // vendor_users for this company
    let tags = [];            // this company's tags [{id, name, category_id}]
    let categories = [];      // all tag categories
    let projects = [];
    let projectCoiFiles = new Map();
    let duplicatePairs = [];  // [[contactA, contactB], ...]
    let revealTax = false;
    let mergePair = null;

    /* ---------- helpers ---------- */

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function can(key) {
        return window.Permissions ? window.Permissions.hasPermission(key) : true;
    }

    function initials(name) {
        const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
        return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
    }

    function maskTaxId(value) {
        const raw = String(value || "").replace(/[^0-9A-Za-z]/g, "");
        return raw ? `•••••${raw.slice(-4)}` : "—";
    }

    function dateOnly(value) {
        if (!value) return "";
        const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    function daysUntil(value) {
        if (!value) return null;
        const target = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return Math.round((target - today) / 86400000);
    }

    function digits(value) { return String(value || "").replace(/\D/g, ""); }
    function normName(value) { return String(value || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
    function normEmail(value) { return String(value || "").trim().toLowerCase(); }

    function telHref(value) { return `tel:${digits(value)}`; }

    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, type);
    }

    /* ---------- approval (same rules as the Vendors page) ---------- */

    function coiState() {
        if (company.COIExempt) return { state: "exempt", label: "COI exempt" };
        // The COI date is what counts (2026-10-21); the PDF is requested on award.
        if (!company.COIExpiresOn) return { state: "missing", label: "No COI date" };
        const left = daysUntil(company.COIExpiresOn);
        if (left !== null && left < 0) return { state: "expired", label: "COI expired" };
        if (left !== null && left <= COI_EXPIRING_SOON_DAYS) return { state: "expiring", label: "COI expiring soon" };
        return { state: "ok", label: company.COIFilePath ? "COI valid" : "COI valid · no PDF yet" };
    }

    function missingRequirements() {
        const blank = v => v === null || v === undefined || String(v).trim() === "";
        const missing = [];
        if (blank(company.Name)) missing.push("Vendor name");
        if (blank(company.Street)) missing.push("Street");
        if (blank(company.City)) missing.push("City");
        if (blank(company.State)) missing.push("State");
        if (blank(company.Zip)) missing.push("Zip");
        if (blank(company["SSN/FID"]) && !company.W9Exempt) missing.push("SSN / FID");
        if (!company.W9FilePath && !company.W9Exempt) missing.push("W9");
        if (!company.COIExempt) {
            const s = coiState().state;
            if (s === "missing" || s === "expired") missing.push("Valid COI date");
        }
        if (!categories.length) missing.push("Tags");
        categories.forEach(cat => {
            if (!tags.some(t => String(t.category_id) === String(cat.id))) missing.push(`${cat.name} tag`);
        });
        return missing;
    }

    /* ---------- load ---------- */

    async function load(id) {
        const db = client();
        const [{ data: co, error }, contactsRes, loginsRes, catsRes, companyTagsRes, projectsRes] = await Promise.all([
            db.from("Companies").select("*").eq("id", id).maybeSingle(),
            db.from("Contacts").select("*").eq("company_id", id).order("Name", { ascending: true }),
            db.from("vendor_users").select("id, email, name, role, status, added_by, contact_id, last_sign_in_at").eq("company_id", id),
            db.from("vendor_tag_categories").select("*").order("sort_order", { ascending: true }),
            db.from("company_tags").select("tag_id, vendor_tags(id, name, category_id)").eq("company_id", id),
            db.rpc("vendor_projects", { p_company_id: Number(id) }),
        ]);
        if (error) throw error;
        if (!co) return false;
        company = co;
        contacts = contactsRes.data || [];
        // vendor_users only exists once sql/supabase-vendor-portal-setup.sql has run.
        logins = (loginsRes.error ? [] : loginsRes.data || []).filter(l => l.status === "active" || l.status === "pending");
        categories = catsRes.data || [];
        tags = (companyTagsRes.data || []).map(r => (Array.isArray(r.vendor_tags) ? r.vendor_tags[0] : r.vendor_tags)).filter(Boolean);
        const seen = new Set();
        projects = (projectsRes.error ? [] : projectsRes.data || []).filter(p => !seen.has(p.project_id) && seen.add(p.project_id));
        // Each awarded project's COI PDF (filed in that project's Contracts & Procurement › Vendors).
        const fileIds = projects.map(p => p.coi_file_id).filter(Boolean);
        projectCoiFiles = new Map();
        if (fileIds.length) {
            const { data: files } = await db.from("project_files").select("id, file_name, bucket, storage_path").in("id", fileIds);
            (files || []).forEach(f => projectCoiFiles.set(String(f.id), f));
        }
        return true;
    }

    function loginFor(contact) {
        return logins.find(l => l.contact_id != null && String(l.contact_id) === String(contact.id))
            || logins.find(l => normEmail(l.email) && (normEmail(l.email) === normEmail(contact.Email) || normEmail(l.email) === normEmail(contact.Email2)))
            || null;
    }

    /* ---------- render: header + company info ---------- */

    function renderHeader() {
        document.title = `The Leeward Group | ${company.FriendlyName || company.Name || "Vendor"}`;
        $("vdCrumbName").textContent = company.Name || "Vendor";
        $("vdName").textContent = company.Name || "Unnamed vendor";

        const approved = missingRequirements().length === 0;
        const status = $("vdHeadStatus");
        status.textContent = approved ? "Approved" : "Not Approved";
        status.className = `vd-status ${approved ? "vd-status--ok" : "vd-status--bad"}`;

        const firstCategory = categories[0];
        const tradeTags = firstCategory ? tags.filter(t => String(t.category_id) === String(firstCategory.id)) : [];
        const meta = [`<span>Vendor ID <strong>V-${esc(String(company.id).padStart(4, "0"))}</strong></span>`];
        if (tradeTags.length) {
            const extra = tradeTags.slice(1).map(t => t.name).join(", ");
            meta.push(`<span>${esc(firstCategory.name)} <strong>${esc(tradeTags[0].name)}</strong>${tradeTags.length > 1 ? ` <span class="vd-more" title="Also: ${esc(extra)}">+${tradeTags.length - 1}</span>` : ""}</span>`);
        }
        const place = [company.City, company.State].filter(Boolean).join(", ");
        if (place) meta.push(`<span>${esc(place)}</span>`);
        if (company.W9UpdatedAt) meta.push(`<span>W-9 updated ${esc(dateOnly(company.W9UpdatedAt))}</span>`);
        $("vdHeadMeta").innerHTML = meta.join("");

        const editBtn = $("vdEditBtn");
        editBtn.href = `/pages/vendors.html?edit=${encodeURIComponent(company.id)}`;
        editBtn.classList.toggle("hidden", !can("vendors.add_edit_vendor"));
    }

    function renderDetails() {
        const missing = missingRequirements();
        const address = [company.Street, [[company.City, company.State].filter(Boolean).join(", "), company.Zip].filter(Boolean).join(" ")].filter(Boolean);
        const rows = [
            ["Legal name", esc(company.Name || "—")],
            ["Friendly name", esc(company.FriendlyName || "—")],
            ["Address", address.length ? address.map(esc).join("<br>") : `<span class="vd-muted">No address on file</span>`],
            ["Approval", missing.length
                ? `<span class="vd-status vd-status--bad">Not Approved</span><span class="vd-sub">Missing: ${esc(missing.join(", "))}</span>`
                : `<span class="vd-status vd-status--ok">Approved</span>`],
        ];
        categories.forEach(cat => {
            const inCat = tags.filter(t => String(t.category_id) === String(cat.id));
            rows.push([cat.name, inCat.length
                ? `<div class="vd-tags">${inCat.map(t => `<span class="vd-tag">${esc(t.name)}</span>`).join("")}</div>`
                : `<span class="vd-muted">None assigned</span>`]);
        });
        $("vdDetails").innerHTML = rows.map(([k, v]) => `<div class="vd-dl__row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("");
    }

    function renderTax() {
        const hasW9 = Boolean(company.W9FilePath);
        const tax = company["SSN/FID"];
        $("vdTaxBody").innerHTML = `
            <tr>
                <td class="vd-td-main"><strong>W-9</strong></td>
                <td data-label="Status">${hasW9 ? `<span class="vd-status vd-status--ok">On file</span>` : company.W9Exempt ? `<span class="vd-status vd-status--ok">Exempt</span>` : `<span class="vd-status vd-status--bad">Missing</span>`}</td>
                <td data-label="SSN / FID">${tax
                    ? `<span class="vd-mask">${esc(revealTax ? tax : maskTaxId(tax))}</span> &nbsp;<button type="button" class="vd-link" data-act="reveal-tax">${revealTax ? "Hide" : "Reveal"}</button>`
                    : company.W9Exempt ? `<span class="vd-muted">Exempt</span>` : `<span class="vd-muted">—</span>`}</td>
                <td data-label="Uploaded">${esc(company.W9UpdatedAt ? dateOnly(company.W9UpdatedAt) : hasW9 ? "On file" : "—")}</td>
                <td class="is-right">${hasW9 ? `<a href="#" data-act="view-doc" data-doc="w9">View</a> &nbsp;·&nbsp; <a href="#" data-act="download-doc" data-doc="w9">Download</a>` : ""}</td>
            </tr>`;
    }

    function renderNotes() {
        const notes = (company.Notes || "").trim();
        const text = $("vdNotesText");
        text.textContent = notes || "No notes yet.";
        text.classList.toggle("vd-notes-text", Boolean(notes));
        const btn = $("vdNotesEditBtn");
        btn.textContent = notes ? "Edit" : "+ Add Note";
        btn.classList.toggle("hidden", !can("vendors.save_notes"));
    }

    // One company COI date (approval) + a COI PDF per awarded project.
    function projectCoi(p) {
        if (company.COIExempt) return { cls: "vd-status--ok", label: "COI exempt", file: null };
        const file = p.coi_file_id ? projectCoiFiles.get(String(p.coi_file_id)) : null;
        // Either on file or not (Coleby, 2026-10-21).
        if (file) return { cls: "vd-status--ok", label: "COI on file", file, when: dateOnly(String(p.coi_received_at || "").slice(0, 10)) };
        if (p.source === "awarded") return { cls: "vd-status--bad", label: "COI not on file", file: null };
        return { cls: "", label: "", file: null };
    }

    function renderProjects() {
        const coi = coiState();
        const expires = company.COIExpiresOn ? `Company COI expires ${dateOnly(company.COIExpiresOn)}` : coi.state === "exempt" ? "Exempt from the COI requirement" : "No COI expiration on file";
        const dateCls = coi.state === "ok" || coi.state === "exempt" ? "vd-status--ok" : coi.state === "expiring" ? "vd-status--warn" : "vd-status--bad";
        $("vdProjectsCount").textContent = String(projects.length);
        const head = `<div class="vd-proj__meta" style="padding-bottom:8px;"><span class="vd-status ${dateCls}">${esc(expires)}</span></div>`;
        $("vdProjects").innerHTML = head + (projects.length
            ? projects.map(p => {
                const pc = projectCoi(p);
                const links = pc.file
                    ? `<span class="vd-proj__links"><a href="#" data-act="view-proj-coi" data-file="${esc(pc.file.id)}">View</a>·<a href="#" data-act="download-proj-coi" data-file="${esc(pc.file.id)}">Download</a></span>`
                    : "";
                return `
                <div class="vd-proj">
                    <div class="vd-proj__top"><a class="vd-proj__name" href="/pages/project-home.html?id=${encodeURIComponent(p.project_id)}">${esc(p.project_name || "Project")}</a>${pc.label ? `<span class="vd-status ${pc.cls}">${esc(pc.label)}</span>` : ""}</div>
                    <div class="vd-proj__meta"><span>${esc(pc.file ? `COI PDF · uploaded ${pc.when}` : p.source === "awarded" ? "Project COI PDF" : "Invoice on this project")}</span>${links}</div>
                </div>`;
            }).join("")
            : `<p class="vd-empty">No projects yet — projects show here once this vendor is awarded a bid or has an invoice on a project.</p>`);
    }

    async function openProjectCoi(fileId, download) {
        const f = projectCoiFiles.get(String(fileId));
        if (!f) return;
        const sign = async dl => {
            const { data, error } = await client().storage.from(f.bucket || "project-documents").createSignedUrl(f.storage_path, 600, dl ? { download: f.file_name } : undefined);
            if (error || !data?.signedUrl) throw error || new Error("no url");
            return data.signedUrl;
        };
        if (!download) { window.FilePreview.open({ name: f.file_name, getUrl: () => sign(false), getDownloadUrl: () => sign(true) }); return; }
        try { window.FilePreview.download(await sign(true), f.file_name); }
        catch (err) { toast("Couldn't open that file. Try again.", "error"); }
    }

    /* ---------- render: contacts ---------- */

    function findDuplicates() {
        const pairs = [];
        for (let i = 0; i < contacts.length; i++) {
            for (let j = i + 1; j < contacts.length; j++) {
                const a = contacts[i], b = contacts[j];
                const sameName = normName(a.Name) && normName(a.Name) === normName(b.Name);
                const emailsA = [a.Email, a.Email2].map(normEmail).filter(Boolean);
                const sameEmail = [b.Email, b.Email2].map(normEmail).filter(Boolean).some(e => emailsA.includes(e));
                const phonesA = [a.WorkPhone, a.MobilePhone].map(digits).filter(d => d.length >= 7);
                const samePhone = [b.WorkPhone, b.MobilePhone].map(digits).filter(d => d.length >= 7).some(d => phonesA.includes(d));
                if (sameName || sameEmail || samePhone) pairs.push([a, b]);
            }
        }
        return pairs;
    }

    function isDuplicate(contact) {
        return duplicatePairs.some(p => p[0].id === contact.id || p[1].id === contact.id);
    }

    function pairFor(contact) {
        return duplicatePairs.find(p => p[0].id === contact.id || p[1].id === contact.id) || null;
    }

    const ICON_SAVE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="8" r="4"></circle><path d="M2 21a8 8 0 0 1 13-6"></path><path d="M19 15v6M16 18h6"></path></svg>`;
    const ICON_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>`;

    function renderContacts() {
        duplicatePairs = findDuplicates();
        const canManage = can("vendors.manage_contacts");
        $("vdContactsCount").textContent = String(contacts.length);
        $("vdAddContactBtn").classList.toggle("hidden", !canManage);
        $("vdSaveAllBtn").classList.toggle("hidden", !contacts.length);
        $("vdContactsEmpty").classList.toggle("hidden", contacts.length > 0);

        // The notice above the table.
        const bar = $("vdDupBar");
        if (duplicatePairs.length && canManage) {
            const [a, b] = duplicatePairs[0];
            const loginContact = [a, b].find(c => loginFor(c));
            const otherContact = loginContact ? (loginContact === a ? b : a) : null;
            const vendorName = company.FriendlyName || company.Name;
            const story = loginContact && otherContact && loginFor(loginContact)?.added_by === "vendor"
                ? `${esc(otherContact.Name || "This person")} was added by Leeward, as a vendor contact, then again by ${esc(vendorName)} when they gave them a dashboard login.`
                : `${esc(a.Name || "Two contacts")} ${a.Name === b.Name ? "is listed twice" : `and ${esc(b.Name || "another contact")} look like the same person`}.`;
            bar.innerHTML = `<span><strong>${duplicatePairs.length} possible duplicate${duplicatePairs.length === 1 ? "" : "s"}.</strong> ${story}</span><button type="button" class="vd-link" data-act="merge" data-contact="${esc(a.id)}">Review &amp; merge ›</button>`;
            bar.classList.remove("hidden");
        } else {
            bar.classList.add("hidden");
        }

        $("vdContactsBody").innerHTML = contacts.map(c => {
            const login = loginFor(c);
            const dup = canManage && isDuplicate(c);
            const holder = login && login.role === "holder" && login.status === "active";
            const loginPill = login
                ? (login.status === "pending"
                    ? `<span class="vd-pill vd-pill--none">Dashboard login pending approval</span>`
                    : `<span class="vd-pill vd-pill--portal" title="${esc(login.last_sign_in_at ? `Last signed in ${dateOnly(login.last_sign_in_at)}` : "Hasn't signed in yet")}">Vendor Dashboard User</span>`)
                : `<span class="vd-pill vd-pill--none">No dashboard login</span>`;
            const email2 = c.Email2 ? `<span class="vd-sub"><a href="mailto:${esc(c.Email2)}">${esc(c.Email2)}</a></span>` : "";
            return `
                <tr data-contact-row="${esc(c.id)}">
                    <td class="vd-td-main"><div class="vd-name"><span class="vd-avatar">${esc(initials(c.Name))}</span><div class="vd-name__text">
                        <div class="vd-name__line">${esc(c.Name || "Unnamed contact")}${holder ? `<span class="vd-pill vd-pill--holder">Account Holder</span>` : ""}${dup ? `<span class="vd-pill vd-pill--dup">Possible duplicate</span>` : ""}</div>
                        <div>${loginPill}</div></div></div></td>
                    <td data-label="Title">${esc(c.Title || c.Role || "—")}</td>
                    <td data-label="Email">${c.Email ? `<a href="mailto:${esc(c.Email)}">${esc(c.Email)}</a>` : `<span class="vd-muted">—</span>`}${email2}</td>
                    <td data-label="Work phone">${c.WorkPhone ? `<a href="${esc(telHref(c.WorkPhone))}">${esc(c.WorkPhone)}</a>` : `<span class="vd-muted">—</span>`}</td>
                    <td data-label="Mobile phone">${c.MobilePhone ? `<a href="${esc(telHref(c.MobilePhone))}">${esc(c.MobilePhone)}</a>` : `<span class="vd-muted">—</span>`}</td>
                    <td class="is-right">${dup ? `<button type="button" class="vd-merge-btn" data-act="merge" data-contact="${esc(c.id)}">Merge</button>` : ""}<button type="button" class="vd-icon-btn" data-act="vcf" data-contact="${esc(c.id)}" title="Save to Contacts (.vcf)" aria-label="Save ${esc(c.Name || "contact")} to Contacts">${ICON_SAVE}</button>${canManage ? `<button type="button" class="vd-icon-btn" data-act="edit-contact" data-contact="${esc(c.id)}" title="Edit contact" aria-label="Edit ${esc(c.Name || "contact")}">${ICON_EDIT}</button>` : ""}</td>
                </tr>`;
        }).join("");
    }

    function renderAll() {
        renderHeader();
        renderDetails();
        renderTax();
        renderNotes();
        renderProjects();
        renderContacts();
    }

    /* ---------- documents ---------- */

    // View opens in the portal (FilePreview); Download saves the file. Never a new tab.
    async function openDoc(kind, download) {
        const bucket = kind === "coi" ? COI_BUCKET : W9_BUCKET;
        const path = kind === "coi" ? company.COIFilePath : company.W9FilePath;
        if (!path) return;
        const name = `${company.Name || "Vendor"} - ${kind === "coi" ? "COI" : "W-9"}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
        const sign = async dl => {
            const { data, error } = await client().storage.from(bucket).createSignedUrl(path, 600, dl ? { download: name } : undefined);
            if (error || !data?.signedUrl) throw error || new Error("no url");
            return data.signedUrl;
        };
        if (!download) { window.FilePreview.open({ name, kind: "pdf", getUrl: () => sign(false), getDownloadUrl: () => sign(true) }); return; }
        try { window.FilePreview.download(await sign(true), name); }
        catch (err) { toast("Couldn't open that file. Try again.", "error"); }
    }

    /* ---------- vCard (.vcf) ---------- */

    function vcfEscape(value) {
        return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
    }

    function vcardFor(c) {
        const name = String(c.Name || "").trim();
        const parts = name.split(/\s+/).filter(Boolean);
        const last = parts.length > 1 ? parts[parts.length - 1] : "";
        const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : name;
        const lines = [
            "BEGIN:VCARD",
            "VERSION:3.0",
            `N:${vcfEscape(last)};${vcfEscape(first)};;;`,
            `FN:${vcfEscape(name || company.Name)}`,
            `ORG:${vcfEscape(company.Name || "")}`,
        ];
        if (c.Title || c.Role) lines.push(`TITLE:${vcfEscape(c.Title || c.Role)}`);
        if (c.Email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${vcfEscape(c.Email)}`);
        if (c.Email2) lines.push(`EMAIL;TYPE=INTERNET:${vcfEscape(c.Email2)}`);
        if (c.WorkPhone) lines.push(`TEL;TYPE=WORK,VOICE:${vcfEscape(c.WorkPhone)}`);
        if (c.MobilePhone) lines.push(`TEL;TYPE=CELL:${vcfEscape(c.MobilePhone)}`);
        if (company.Street || company.City) {
            lines.push(`ADR;TYPE=WORK:;;${vcfEscape(company.Street)};${vcfEscape(company.City)};${vcfEscape(company.State)};${vcfEscape(company.Zip)};USA`);
        }
        const note = [company.FriendlyName && company.FriendlyName !== company.Name ? `Also known as ${company.FriendlyName}` : "", "Vendor — The Leeward Group"].filter(Boolean).join(". ");
        lines.push(`NOTE:${vcfEscape(note)}`);
        lines.push("END:VCARD");
        return lines.join("\r\n");
    }

    function downloadVcf(text, fileName) {
        const blob = new Blob([text + "\r\n"], { type: "text/vcard;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName.replace(/[\\/:*?"<>|]+/g, "-");
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /* ---------- notes ---------- */

    function openNotesEditor() {
        $("vdNotesInput").value = company.Notes || "";
        $("vdNotesEditor").classList.remove("hidden");
        $("vdNotesText").classList.add("hidden");
        $("vdNotesEditBtn").classList.add("hidden");
        $("vdNotesMessage").textContent = "";
        $("vdNotesInput").focus();
    }

    function closeNotesEditor() {
        $("vdNotesEditor").classList.add("hidden");
        $("vdNotesText").classList.remove("hidden");
        renderNotes();
    }

    async function saveNotes() {
        const notes = $("vdNotesInput").value.trim();
        $("vdNotesSaveBtn").disabled = true;
        $("vdNotesMessage").textContent = "Saving…";
        const { error } = await client().from("Companies").update({ Notes: notes || null }).eq("id", company.id);
        $("vdNotesSaveBtn").disabled = false;
        if (error) {
            $("vdNotesMessage").textContent = "Couldn't save. Try again.";
            $("vdNotesMessage").className = "auth-message error";
            return;
        }
        company.Notes = notes || null;
        closeNotesEditor();
        toast("Notes saved.");
    }

    /* ---------- add / edit contact ---------- */

    function openContactForm(contact) {
        if (!can("vendors.manage_contacts")) return;
        const login = contact ? loginFor(contact) : null;
        $("vdContactTitle").textContent = contact ? "Edit Contact" : "Add Contact";
        $("vdContactId").value = contact ? contact.id : "";
        $("vdContactName").value = contact?.Name || "";
        $("vdContactTitleInput").value = contact?.Title || "";
        $("vdContactEmail").value = contact?.Email || "";
        $("vdContactEmail2").value = contact?.Email2 || "";
        $("vdContactWork").value = contact?.WorkPhone || "";
        $("vdContactMobile").value = contact?.MobilePhone || "";
        $("vdContactRole").value = contact?.Role || "";
        // The portal login is tied to this email.
        const locked = Boolean(login && normEmail(login.email) === normEmail(contact?.Email));
        $("vdContactEmail").readOnly = locked;
        $("vdContactLoginNote").classList.toggle("hidden", !locked);
        $("vdContactDeleteBtn").classList.toggle("hidden", !contact || Boolean(login));
        $("vdContactMessage").textContent = "";
        $("vdContactMessage").className = "auth-message";
        $("vdContactOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        $("vdContactName").focus();
    }

    function closeContactForm() {
        $("vdContactOverlay").classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    async function saveContact(event) {
        event.preventDefault();
        const id = $("vdContactId").value;
        const payload = {
            company_id: company.id,
            Name: $("vdContactName").value.trim(),
            Title: $("vdContactTitleInput").value.trim() || null,
            Email: $("vdContactEmail").value.trim() || null,
            Email2: $("vdContactEmail2").value.trim() || null,
            WorkPhone: $("vdContactWork").value.trim() || null,
            MobilePhone: $("vdContactMobile").value.trim() || null,
            Role: $("vdContactRole").value.trim() || null,
        };
        const msg = $("vdContactMessage");
        if (!payload.Name) { msg.textContent = "Name is required."; msg.className = "auth-message error"; return; }
        $("vdContactSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        const query = id
            ? client().from("Contacts").update(payload).eq("id", id)
            : client().from("Contacts").insert(payload);
        const { error } = await query;
        $("vdContactSaveBtn").disabled = false;
        if (error) {
            // Older databases don't have Email2 yet (sql/supabase-vendor-portal-setup.sql adds it).
            msg.textContent = /Email2/.test(error.message || "") ? "Run sql/supabase-vendor-portal-setup.sql to save a second email." : "Couldn't save this contact. Try again.";
            msg.className = "auth-message error";
            return;
        }
        closeContactForm();
        await refresh();
        toast(id ? "Contact saved." : "Contact added.");
    }

    async function deleteContact() {
        const id = $("vdContactId").value;
        if (!id) return;
        const btn = $("vdContactDeleteBtn");
        if (btn.dataset.confirm !== "1") {
            btn.dataset.confirm = "1";
            btn.textContent = "Click again to delete";
            setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "Delete"; }, 4000);
            return;
        }
        btn.dataset.confirm = "";
        btn.textContent = "Delete";
        const { error } = await client().from("Contacts").delete().eq("id", id);
        if (error) { $("vdContactMessage").textContent = "Couldn't delete this contact."; $("vdContactMessage").className = "auth-message error"; return; }
        closeContactForm();
        await refresh();
        toast("Contact deleted.");
    }

    /* ---------- merge duplicates ---------- */

    const MERGE_FIELDS = [
        { key: "Name", label: "Name" },
        { key: "Title", label: "Title" },
        { key: "Email", label: "Email" },
        { key: "WorkPhone", label: "Work phone" },
        { key: "MobilePhone", label: "Mobile phone" },
        { key: "Role", label: "Role" },
    ];

    function openMerge(contactId) {
        const contact = contacts.find(c => String(c.id) === String(contactId));
        const pair = contact && pairFor(contact);
        if (!pair) return;
        // Left: the record without a login (Leeward's); right: the one with
        // the login (kept, so the login keeps working).
        let [a, b] = pair;
        if (loginFor(a) && !loginFor(b)) [a, b] = [b, a];
        mergePair = { left: a, right: b, choice: {} };
        const loginA = loginFor(a), loginB = loginFor(b);
        const vendorName = company.FriendlyName || company.Name;
        const head = c => loginFor(c)
            ? `Added by ${esc(loginFor(c).added_by === "vendor" ? vendorName : loginFor(c).added_by === "application" ? `${vendorName} (application)` : "Leeward")} <span class="vd-pill vd-pill--portal">Has login</span>`
            : "Added by Leeward";

        const cells = [`<div class="vd-merge__h vd-merge__corner"></div><div class="vd-merge__h">${head(a)}</div><div class="vd-merge__h">${head(b)}</div>`];
        MERGE_FIELDS.forEach(f => {
            const va = (a[f.key] || "").trim(), vb = (b[f.key] || "").trim();
            if (!va && !vb) return;
            const loginEmailSide = f.key === "Email" ? (loginB ? "right" : loginA ? "left" : null) : null;
            const defaultSide = loginEmailSide || (vb && !va ? "right" : "left");
            mergePair.choice[f.key] = defaultSide;
            const cell = (side, value) => {
                if (!value) return `<span class="vd-opt vd-opt--empty">—</span>`;
                if (loginEmailSide) {
                    return side === loginEmailSide
                        ? `<span class="vd-opt vd-opt--locked" title="This is their Vendor Portal login">🔒 ${esc(value)}</span>`
                        : `<span class="vd-opt vd-opt--empty">${esc(value)}<br>(kept as a 2nd email)</span>`;
                }
                return `<label class="vd-opt"><input type="radio" name="merge-${f.key}" value="${side}" ${defaultSide === side ? "checked" : ""}>${esc(value)}</label>`;
            };
            cells.push(`<div class="vd-merge__f">${esc(f.label === "Email" && loginEmailSide ? "Login email" : f.label)}</div>${cell("left", va)}${cell("right", vb)}`);
        });
        $("vdMergeGrid").innerHTML = cells.join("");

        const both = loginA && loginB;
        $("vdMergeNote").innerHTML = both
            ? `<span><strong>Both have a Vendor Portal login.</strong> One of them has to be removed from the vendor's team in the portal (by their account holder) before these can be merged.</span>`
            : `<span><strong>${loginA || loginB ? "Keeps their Vendor Dashboard login." : "Combines the two records."}</strong> ${loginA || loginB ? "They sign in the same way as before." : ""}</span><span>The second email is kept, and the other record is removed. This can't be undone.</span>`;
        $("vdMergeConfirmBtn").disabled = Boolean(both);
        $("vdMergeMessage").textContent = "";
        $("vdMergeOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeMerge() {
        $("vdMergeOverlay").classList.add("hidden");
        document.body.classList.remove("popup-active");
        mergePair = null;
    }

    async function confirmMerge() {
        if (!mergePair) return;
        const { left, right } = mergePair;
        const keepRight = Boolean(loginFor(right)) || !loginFor(left); // keep the one with the login (default right)
        const keep = keepRight ? right : left;
        const drop = keepRight ? left : right;

        const picked = {};
        MERGE_FIELDS.forEach(f => {
            const radio = document.querySelector(`input[name="merge-${f.key}"]:checked`);
            const side = radio ? radio.value : mergePair.choice[f.key];
            const value = side === "right" ? right[f.key] : left[f.key];
            picked[f.key] = (value || "").trim() || (keep[f.key] || "").trim() || (drop[f.key] || "").trim() || null;
        });
        // Emails: the kept record's login email stays; anything else becomes Email2.
        const login = loginFor(keep);
        const allEmails = [keep.Email, keep.Email2, drop.Email, drop.Email2].map(e => (e || "").trim()).filter(Boolean);
        const primary = login ? (allEmails.find(e => normEmail(e) === normEmail(login.email)) || login.email) : (picked.Email || allEmails[0] || null);
        const secondary = allEmails.find(e => normEmail(e) !== normEmail(primary)) || null;
        picked.Email = primary;
        picked.Email2 = secondary;

        $("vdMergeConfirmBtn").disabled = true;
        $("vdMergeMessage").textContent = "Merging…";
        try {
            const { error: updateError } = await client().from("Contacts").update(picked).eq("id", keep.id);
            if (updateError) throw updateError;
            // A login pointing at the removed record moves to the kept one.
            const dropLogin = loginFor(drop);
            if (dropLogin && !login) {
                const { error } = await client().from("vendor_users").update({ contact_id: keep.id }).eq("id", dropLogin.id);
                if (error) throw error;
            }
            const { error: deleteError } = await client().from("Contacts").delete().eq("id", drop.id);
            if (deleteError) throw deleteError;
        } catch (err) {
            $("vdMergeConfirmBtn").disabled = false;
            $("vdMergeMessage").textContent = `Couldn't merge: ${err && err.message ? err.message : err}`;
            $("vdMergeMessage").className = "auth-message error";
            return;
        }
        closeMerge();
        await refresh();
        toast("Contacts merged.");
    }

    /* ---------- wiring ---------- */

    async function refresh() {
        await load(company.id);
        renderAll();
    }

    function wire() {
        document.addEventListener("click", e => {
            const el = e.target.closest("[data-act]");
            if (!el || !company) return;
            const act = el.dataset.act;
            if (act === "reveal-tax") { revealTax = !revealTax; renderTax(); }
            else if (act === "view-doc" || act === "download-doc") { e.preventDefault(); openDoc(el.dataset.doc, act === "download-doc"); }
            else if (act === "view-proj-coi" || act === "download-proj-coi") { e.preventDefault(); openProjectCoi(el.dataset.file, act === "download-proj-coi"); }
            else if (act === "vcf") {
                const c = contacts.find(x => String(x.id) === String(el.dataset.contact));
                if (c) downloadVcf(vcardFor(c), `${c.Name || "Contact"}.vcf`);
            }
            else if (act === "edit-contact") openContactForm(contacts.find(x => String(x.id) === String(el.dataset.contact)));
            else if (act === "merge") openMerge(el.dataset.contact);
        });
        $("vdSaveAllBtn").addEventListener("click", () => {
            if (contacts.length) downloadVcf(contacts.map(vcardFor).join("\r\n"), `${company.FriendlyName || company.Name || "Vendor"} contacts.vcf`);
        });
        $("vdAddContactBtn").addEventListener("click", () => openContactForm(null));
        $("vdContactCloseBtn").addEventListener("click", closeContactForm);
        $("vdContactForm").addEventListener("submit", saveContact);
        $("vdContactDeleteBtn").addEventListener("click", deleteContact);
        $("vdNotesEditBtn").addEventListener("click", openNotesEditor);
        $("vdNotesCancelBtn").addEventListener("click", closeNotesEditor);
        $("vdNotesSaveBtn").addEventListener("click", saveNotes);
        $("vdMergeCloseBtn").addEventListener("click", closeMerge);
        $("vdMergeCancelBtn").addEventListener("click", closeMerge);
        $("vdMergeConfirmBtn").addEventListener("click", confirmMerge);
        ["vdContactOverlay", "vdMergeOverlay"].forEach(id => {
            $(id).addEventListener("click", e => { if (e.target === $(id)) (id === "vdMergeOverlay" ? closeMerge : closeContactForm)(); });
        });
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            if (!$("vdMergeOverlay").classList.contains("hidden")) closeMerge();
            else if (!$("vdContactOverlay").classList.contains("hidden")) closeContactForm();
        });
    }

    function showError(text) {
        $("vdLoading").classList.add("hidden");
        const el = $("vdError");
        el.textContent = text;
        el.classList.remove("hidden");
    }

    window.initVendorDetailPage = async function () {
        if (!window.supabaseClient) { setTimeout(window.initVendorDetailPage, 150); return; }
        const id = new URLSearchParams(window.location.search).get("id");
        if (!id || !/^\d+$/.test(id)) { showError("No vendor picked. Go back to Vendors and click one."); return; }
        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (e) { /* ignore */ }
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch (e) { /* hasPermission fails open */ }
        }
        try {
            const found = await load(id);
            if (!found) { showError("That vendor doesn't exist anymore."); return; }
        } catch (err) {
            console.error("Couldn't load vendor:", err);
            showError("Couldn't load this vendor. Refresh to try again.");
            return;
        }
        wire();
        renderAll();
        $("vdLoading").classList.add("hidden");
        $("vdContent").classList.remove("hidden");
    };
})();
