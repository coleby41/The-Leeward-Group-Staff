/* ===========================================================
   COMPANIES PAGE
   Reads/writes public."Companies" in Supabase.
   Custom auth model: no auth.uid(), RLS is open to anon,
   access control is app-level (see supabase-companies-setup.sql).
=========================================================== */

const COMPANIES_TABLE = "Companies";
const W9_BUCKET = "company-w9s";
const COI_BUCKET = "company-cois";

// A COI within this many days of its expiration date shows as "Expiring
// soon" (amber) instead of a plain "On file" (green) -- Coleby asked to
// track a real expiration date specifically so an expired/soon-to-expire
// COI stands out, not just "on file vs. missing".
const COI_EXPIRING_SOON_DAYS = 30;

/* ===========================
   VENDOR TAGS (Supabase)
   Tables: vendor_tag_categories, vendor_tags, company_tags
   (see supabase-vendor-tags-setup.sql). Categories are data-driven rather
   than hardcoded, so a new category can be added from the Manage Tags
   popup without touching any code.
=========================== */

const TAG_CATEGORIES_TABLE = "vendor_tag_categories";
const TAGS_TABLE = "vendor_tags";
const COMPANY_TAGS_TABLE = "company_tags";

let allTagCategories = []; // [{ id, name, sort_order }]
let allTags = [];          // [{ id, category_id, name }]
let allCompanyTags = [];   // [{ id, company_id, tag_id }]

let allCompanies = [];

// All contacts for every vendor, loaded once up front (same "load
// everything, filter in memory" pattern as allCompanyTags above) so the
// vendor list's search box can match on a contact's name/phone/email
// without a separate query per card. Keyed by company_id (string) ->
// array of contact rows. See contactsForCompany() below.
let allContactsByCompanyId = new Map();

/* ===========================
   HELPERS
=========================== */

function escapeHtmlCompanies(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

// Shows only the last 4 characters of SSN/FID on the card.
function maskSsnFid(value) {
    if (!value) return "—";
    const digitsOnly = String(value).replace(/[^0-9A-Za-z]/g, "");
    if (digitsOnly.length <= 4) return String(value);
    const last4 = digitsOnly.slice(-4);
    return `•••-••-${last4}`;
}

function formatAddress(company) {
    const cityStateZip = [company.City, company.State]
        .filter(Boolean)
        .join(", ");

    const line2 = [cityStateZip, company.Zip]
        .filter(Boolean)
        .join(" ");

    return {
        street: company.Street || "",
        line2: line2 || ""
    };
}

/* ===========================
   DOCUMENT STATUS BADGE (W9 + COI)
   Shared by both documents so their card/list-view treatment always stays
   visually identical -- see the "VENDOR DOCUMENT STATUS BADGE" comment
   block in styles.css for the full reasoning behind the markup/CSS this
   builds. type is "w9" or "coi".
=========================== */

// Formats a stored date/timestamp as e.g. "8/15/2026". dateOnly=true for a
// plain `date` column (COIExpiresOn) -- appending T00:00:00 so it's read
// as local midnight instead of UTC midnight, which can otherwise print a
// day early in timezones behind UTC (same trick project-shell.js uses for
// its own due-date column).
function formatDocDate(value, dateOnly) {
    if (!value) return "";
    const d = dateOnly ? new Date(`${value}T00:00:00`) : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

function daysUntil(dateOnlyValue) {
    if (!dateOnlyValue) return null;
    const target = new Date(`${dateOnlyValue}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// Returns everything a doc badge needs to render: whether the document is
// on file, which visual state it's in, the label shown on the trigger
// button, and the meta line shown inside the dropdown.
function getDocStatus(company, type) {
    if (type === "coi") {
        // Since 2026-10-21 the COI *date* is what counts: a vendor with an
        // expiration date that hasn't passed is good to go. The PDF is only
        // requested once they're awarded a job, so it may not be on file.
        const filePath = company.COIFilePath || null;
        const hasDate = !isBlank(company.COIExpiresOn);
        if (!hasDate && !filePath) return { hasFile: false, hasDate: false, state: "missing", label: "Missing", meta: "" };
        if (!hasDate) return { hasFile: true, hasDate: false, state: "nodate", label: "No date", meta: "No expiration date on file", filePath };

        const remaining = daysUntil(company.COIExpiresOn);
        let state = "onfile";
        let label = "Valid";
        if (remaining !== null) {
            if (remaining < 0) { state = "expired"; label = "Expired"; }
            else if (remaining <= COI_EXPIRING_SOON_DAYS) { state = "expiring"; label = "Expiring soon"; }
        }
        const meta = `Expires ${formatDocDate(company.COIExpiresOn, true)}${filePath ? "" : " · no PDF yet (requested when awarded)"}`;
        return { hasFile: Boolean(filePath), hasDate: true, state, label, meta, filePath };
    }

    // w9
    const filePath = company.W9FilePath || null;
    if (!filePath) return { hasFile: false, state: "missing", label: "Missing", meta: "" };
    const meta = company.W9UpdatedAt ? `Updated ${formatDocDate(company.W9UpdatedAt, false)}` : "";
    return { hasFile: true, state: "onfile", label: "On file", meta, filePath };
}

// Builds the whole .doc-badge component (trigger button + dropdown) for
// one document on one company. docLabel is the human label shown inside
// the dropdown ("W9" / "Certificate of Insurance").
function buildDocBadgeHtml(company, type, docLabel) {
    const status = getDocStatus(company, type);
    const stateClass = (status.state === "missing" || status.state === "nodate") ? "doc-badge-trigger--missing"
        : status.state === "expired" ? "doc-badge-trigger--expired"
        : status.state === "expiring" ? "doc-badge-trigger--expiring"
        : "";

    if (!status.hasFile) {
        // No PDF: a COI with just a date still shows its status (hover for the date).
        return `
            <div class="doc-badge">
                <button type="button" class="doc-badge-trigger ${stateClass}" disabled ${status.meta ? `title="${escapeHtmlCompanies(status.meta)}"` : ""}>
                    <span class="doc-badge-label">${escapeHtmlCompanies(status.label || "Missing")}</span>
                </button>
            </div>
        `;
    }

    return `
        <div class="doc-badge">
            <button
                type="button"
                class="doc-badge-trigger ${stateClass} doc-badge-toggle-btn"
                data-id="${company.id}"
                data-doc-type="${type}"
                aria-haspopup="true"
                aria-expanded="false">
                <span class="doc-badge-label">${escapeHtmlCompanies(status.label)}</span>
                <span class="doc-badge-chevron"></span>
            </button>
            <div class="doc-badge-dropdown" data-id="${company.id}" data-doc-type="${type}" data-file-path="${escapeHtmlCompanies(status.filePath)}">
                <span class="chip ${status.state === "expired" ? "chip--danger" : status.state === "expiring" ? "chip--warning" : ""}">${escapeHtmlCompanies(status.label)}</span>
                ${status.meta ? `<p class="doc-badge-dropdown-meta">${escapeHtmlCompanies(status.meta)}</p>` : ""}
                <div class="doc-badge-dropdown-divider"></div>
                <button type="button" class="doc-badge-dropdown-action doc-badge-view-btn" data-id="${company.id}" data-doc-type="${type}">View Document</button>
                <button type="button" class="doc-badge-dropdown-action doc-badge-download-btn" data-id="${company.id}" data-doc-type="${type}" data-doc-label="${escapeHtmlCompanies(docLabel)}">Download</button>
            </div>
        </div>
    `;
}

// Same position: fixed + JS-computed-coordinates pattern used for
// .form-response-menu-dropdown (see form-builder.js's
// positionResponseMenuDropdown) and for the same reason: .workbook-card
// has overflow: hidden, which would clip an absolutely-positioned
// dropdown the moment a badge sits near a card's edge.
function positionDocBadgeDropdown(trigger, dropdown) {
    const margin = 4;
    const btnRect = trigger.getBoundingClientRect();
    const dropRect = dropdown.getBoundingClientRect();

    let left = btnRect.left;
    if (left + dropRect.width > window.innerWidth - margin) {
        left = window.innerWidth - dropRect.width - margin;
    }
    if (left < margin) left = margin;

    let top = btnRect.bottom + margin;
    if (top + dropRect.height > window.innerHeight - margin) {
        top = btnRect.top - dropRect.height - margin;
    }
    if (top < margin) top = margin;

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
}

function closeAllDocBadges() {
    document.querySelectorAll(".doc-badge-dropdown.is-open").forEach(d => d.classList.remove("is-open"));
    document.querySelectorAll(".doc-badge-toggle-btn.is-open").forEach(b => {
        b.classList.remove("is-open");
        b.setAttribute("aria-expanded", "false");
    });
}

function toggleDocBadge(trigger, dropdown) {
    const isOpen = dropdown.classList.contains("is-open");
    closeAllDocBadges();
    if (isOpen) return;
    dropdown.classList.add("is-open");
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    positionDocBadgeDropdown(trigger, dropdown);
}

// Wires the doc badges rendered into `container` (either #companyGrid or
// the vendor profile modal, though the profile modal currently uses a
// simpler chip + button instead of the full dropdown -- see the comment
// above .doc-badge in styles.css).
function wireDocBadges(container) {
    container.querySelectorAll(".doc-badge-toggle-btn").forEach(btn => {
        const dropdown = btn.parentElement.querySelector(".doc-badge-dropdown");
        if (!dropdown) return;
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleDocBadge(btn, dropdown);
        });
    });

    container.querySelectorAll(".doc-badge-view-btn").forEach(btn => {
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            closeAllDocBadges();
            const id = btn.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (!company) return;
            const filePath = btn.dataset.docType === "coi" ? company.COIFilePath : company.W9FilePath;
            if (filePath) viewDocFile(btn.dataset.docType === "coi" ? COI_BUCKET : W9_BUCKET, filePath);
        });
    });

    container.querySelectorAll(".doc-badge-download-btn").forEach(btn => {
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            closeAllDocBadges();
            const id = btn.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (!company) return;
            const filePath = btn.dataset.docType === "coi" ? company.COIFilePath : company.W9FilePath;
            if (filePath) downloadDocFile(btn.dataset.docType === "coi" ? COI_BUCKET : W9_BUCKET, filePath, `${company.Name || "vendor"} - ${btn.dataset.docLabel}.pdf`);
        });
    });
}

function showCompanyMessage(text, type) {
    const el = document.getElementById("companyMessage");
    if (!el) return;
    el.textContent = text;
    el.className = `workbook-page-message ${type}`;
    el.style.display = "block";
    if (type === "success") window.showToast?.(text); // shared bottom-right popup (js/toast.js)
}

function hideCompanyMessage() {
    const el = document.getElementById("companyMessage");
    if (!el) return;
    el.style.display = "none";
}

function setFormMessage(text, type) {
    const el = document.getElementById("companyFormMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

/* ===========================
   VENDOR TAGS — load + lookup helpers
=========================== */

async function loadVendorTagData() {

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    const [categoriesRes, tagsRes, companyTagsRes] = await Promise.all([
        window.supabaseClient.from(TAG_CATEGORIES_TABLE).select("*").order("sort_order", { ascending: true }),
        window.supabaseClient.from(TAGS_TABLE).select("*").order("name", { ascending: true }),
        window.supabaseClient.from(COMPANY_TAGS_TABLE).select("*")
    ]);

    if (categoriesRes.error) console.error("Failed to load tag categories:", categoriesRes.error);
    if (tagsRes.error) console.error("Failed to load tags:", tagsRes.error);
    if (companyTagsRes.error) console.error("Failed to load company tags:", companyTagsRes.error);

    allTagCategories = categoriesRes.data || [];
    allTags = tagsRes.data || [];
    allCompanyTags = companyTagsRes.data || [];
}

// All tags currently assigned to a vendor, each annotated with its category.
function tagsForCompany(companyId) {
    const tagIds = new Set(
        allCompanyTags
            .filter(ct => String(ct.company_id) === String(companyId))
            .map(ct => String(ct.tag_id))
    );
    return allTags.filter(tag => tagIds.has(String(tag.id)));
}

/* ===========================
   VENDOR CONTACTS — load + lookup helpers
   Used by the vendor list's search box (Coleby, 2026-09-08: "make sure on
   vendor page that i can search ... persons that in that vendor ... and
   phone number") so a contact's name/phone/email/title/role can find the
   vendor card they're attached to, even though contacts themselves aren't
   shown on the card. Not a new access boundary -- any signed-in staff
   member could already see this by clicking "View Contact Info" on the
   card; this just loads it a little earlier so it's searchable.
=========================== */

async function loadAllContacts() {

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    const { data, error } = await window.supabaseClient
        .from(CONTACTS_TABLE)
        .select("*");

    if (error) {
        console.error("Failed to load vendor contacts:", error);
        return;
    }

    allContactsByCompanyId = new Map();
    (data || []).forEach(contact => {
        const key = String(contact.company_id);
        if (!allContactsByCompanyId.has(key)) allContactsByCompanyId.set(key, []);
        allContactsByCompanyId.get(key).push(contact);
    });
}

function contactsForCompany(companyId) {
    return allContactsByCompanyId.get(String(companyId)) || [];
}

// Groups a flat list of tags by category, in category sort order. Returns
// [{ category, tags }] — every category is included even if empty, so
// callers (profile popup, tag picker) can show "None assigned" / render
// checkboxes for categories with nothing selected yet.
function groupTagsByCategory(tagList) {
    const byCategory = new Map();
    allTagCategories.forEach(cat => byCategory.set(String(cat.id), { category: cat, tags: [] }));
    tagList.forEach(tag => {
        const group = byCategory.get(String(tag.category_id));
        if (group) group.tags.push(tag);
    });
    return Array.from(byCategory.values());
}

/* ===========================
   VENDOR APPROVAL STATUS
   Fully derived from other fields — no DB column, no manual override.
   A vendor is "Approved" only once it has: Name, Street, City, State, Zip,
   SSN/FID, a W9 on file, a COI expiration date that hasn't passed (or COI
   exempt), AND at least one tag from every existing tag
   category (currently Asset Specialty + Trade — this stays correct even if
   a category is added or removed later, since it loops allTagCategories).
=========================== */

function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === "";
}

// Returns the list of human-readable things this vendor is missing.
// Empty array = approved.
function missingVendorRequirements(company) {
    if (!company) return ["Vendor name", "Street", "City", "State", "Zip", "SSN / FID", "W9", "Valid COI date"];

    const missing = [];
    if (isBlank(company.Name)) missing.push("Vendor name");
    if (isBlank(company.Street)) missing.push("Street");
    if (isBlank(company.City)) missing.push("City");
    if (isBlank(company.State)) missing.push("State");
    if (isBlank(company.Zip)) missing.push("Zip");
    if (isBlank(company["SSN/FID"])) missing.push("SSN / FID");
    if (!company.W9FilePath) missing.push("W9");

    // COI (Coleby, 2026-10-21): approved as long as there's a COI
    // expiration date and it hasn't passed. The PDF isn't needed for
    // approval -- Leeward asks for it when the vendor is awarded a job.
    if (!company.COIExempt) {
        const coiStatus = getDocStatus(company, "coi");
        if (!coiStatus.hasDate || coiStatus.state === "expired") missing.push("Valid COI date");
    }

    if (allTagCategories.length === 0) {
        missing.push("Tags");
    } else {
        const companyTags = tagsForCompany(company.id);
        allTagCategories.forEach(cat => {
            const hasOneFromCategory = companyTags.some(tag => String(tag.category_id) === String(cat.id));
            if (!hasOneFromCategory) missing.push(`${cat.name} tag`);
        });
    }

    return missing;
}

function isVendorApproved(company) {
    return missingVendorRequirements(company).length === 0;
}

/* ===========================
   LOAD + RENDER
=========================== */

async function loadCompanies() {

    const loadingState = document.getElementById("companyLoadingState");
    const emptyState = document.getElementById("companyEmptyState");
    const grid = document.getElementById("companyGrid");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    if (loadingState) loadingState.style.display = "block";
    if (emptyState) emptyState.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(COMPANIES_TABLE)
        .select("*")
        .order("Name", { ascending: true });

    if (loadingState) loadingState.style.display = "none";

    if (error) {
        console.error("Failed to load companies:", error);
        showCompanyMessage("Couldn't load companies. Please refresh and try again.", "error");
        return;
    }

    allCompanies = data || [];

    if (allCompanies.length === 0) {
        if (emptyState) emptyState.style.display = "block";
        if (grid) grid.innerHTML = "";
        return;
    }

    renderCompanies(allCompanies);
}

// Builds a visually-hidden span carrying everything about this vendor
// that the search box on the vendors page should be able to match but
// that the card itself doesn't show in full -- the unmasked SSN/FID (the
// card only ever shows the last 4 digits), every tag (the card only shows
// the first two plus a "+N more" chip), and every contact person's name,
// title, phone numbers, email, and role (contacts live in their own "View
// Contact Info" popup, not on the card). Coleby, 2026-09-08: "make sure on
// vendor page that i can search SSN / FID address and persons that in
// that vendor name and phone number or anything else." Name/address are
// already full-text on the card itself, so nothing needed here for those.
// `.hidden` is `display:none !important` -- invisible, but its text still
// counts toward card.textContent, which is exactly what the vendors page's
// existing search box (initCompanyListControls() in vendors.html) already
// matches against, so no change was needed there at all.
function buildCardSearchDataHtml(company, companyTags, companyContacts) {
    const parts = [
        company["SSN/FID"] || "",
        ...companyTags.map(tag => tag.name || ""),
        ...companyContacts.flatMap(contact => [
            contact.Name, contact.Title, contact.WorkPhone,
            contact.MobilePhone, contact.Email, contact.Role
        ])
    ].filter(Boolean);

    if (!parts.length) return "";

    return `<span class="hidden company-card-search-data">${escapeHtmlCompanies(parts.join(" • "))}</span>`;
}

function renderCompanies(companies) {

    const grid = document.getElementById("companyGrid");
    if (!grid) return;

    grid.innerHTML = "";

    companies.forEach(company => {

        const address = formatAddress(company);
        const companyTags = tagsForCompany(company.id);
        const companyContacts = contactsForCompany(company.id);
        const approved = isVendorApproved(company);

        const card = document.createElement("div");
        card.className = "workbook-card company-card";
        card.dataset.companyId = company.id;

        card.innerHTML = `
            <div class="company-card-body">

                <button
                    type="button"
                    class="company-edit-btn ${vendorsCan("vendors.add_edit_vendor") ? "" : "hidden"}"
                    data-id="${company.id}"
                    aria-label="Edit Vendor">
                    <span class="company-edit-icon"></span>
                </button>

                <h3 class="company-card-name">${escapeHtmlCompanies(company.Name || "Unnamed company")}</h3>

                <div class="company-card-address">
                    ${address.street ? `<p>${escapeHtmlCompanies(address.street)}</p>` : ""}
                    ${address.line2 ? `<p>${escapeHtmlCompanies(address.line2)}</p>` : ""}
                    ${(!address.street && !address.line2) ? `<p class="company-card-muted">No address on file</p>` : ""}
                </div>

                ${companyTags.length ? `
                <div class="company-card-tags">
                    ${companyTags.slice(0, 2).map(tag => `<span class="chip chip--tag">${escapeHtmlCompanies(tag.name)}</span>`).join("")}
                    ${companyTags.length > 2 ? `<span class="chip chip--muted">+${companyTags.length - 2} more</span>` : ""}
                </div>` : ""}

                <div class="company-card-row company-card-row--status">
                    <span class="company-card-label">Status</span>
                    <span class="chip ${approved ? "chip--success" : "chip--danger"}">${approved ? "Approved" : "Not Approved"}</span>
                </div>

                <div class="company-card-row company-card-row--ssn">
                    <span class="company-card-label">SSN / FID</span>
                    <span class="company-card-value">${escapeHtmlCompanies(maskSsnFid(company["SSN/FID"]))}</span>
                </div>

                <div class="company-card-row company-card-row--w9">
                    <span class="company-card-label">W9</span>
                    ${buildDocBadgeHtml(company, "w9", "W9")}
                </div>

                ${company.COIExempt ? "" : `
                <div class="company-card-row company-card-row--coi">
                    <span class="company-card-label">COI</span>
                    ${buildDocBadgeHtml(company, "coi", "Certificate of Insurance")}
                </div>`}

                <a href="/pages/vendor.html?id=${encodeURIComponent(company.id)}" class="company-view-contacts-link" data-id="${company.id}">View Vendor ›</a>

                ${buildCardSearchDataHtml(company, companyTags, companyContacts)}

            </div>
        `;

        grid.appendChild(card);
    });

    // Card click (anywhere except an interactive element) opens the
    // vendor's own page (pages/vendor.html) -- Coleby, 2026-10-19: "when
    // someone clicks the card on the vendor page ... open to this and not
    // the popup". The old profile popup is still in the markup, unused.
    grid.querySelectorAll(".company-card").forEach(card => {
        card.style.cursor = "pointer";
        card.addEventListener("click", (event) => {
            if (event.target.closest(".company-edit-btn, .doc-badge, .company-view-contacts-link")) return;
            window.location.href = `/pages/vendor.html?id=${encodeURIComponent(card.dataset.companyId)}`;
        });
    });

    // Edit buttons
    grid.querySelectorAll(".company-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const company = allCompanies.find(c => String(c.id) === String(id));
            if (company) openCompanyModal(company);
        });
    });

    // W9 / COI status badges (trigger + dropdown, and the View/Download
    // actions inside each dropdown).
    wireDocBadges(grid);

    // "View Vendor ›" is a plain link to the vendor page (contacts live there now).
}

/* ===========================
   VIEW / DOWNLOAD DOCUMENT (signed URL, buckets are private)
=========================== */

async function createDocSignedUrl(bucket, filePath) {
    if (!window.supabaseClient) return null;

    const { data, error } = await window.supabaseClient
        .storage
        .from(bucket)
        .createSignedUrl(filePath, 60 * 5); // 5 minute link

    if (error || !data?.signedUrl) {
        console.error(`Failed to create signed URL (${bucket}):`, error);
        return null;
    }

    return data.signedUrl;
}

async function viewDocFile(bucket, filePath) {
    const url = await createDocSignedUrl(bucket, filePath);
    if (!url) {
        showCompanyMessage("Couldn't open that file. Please try again.", "error");
        return;
    }
    window.open(url, "_blank", "noopener");
}

// Unlike viewDocFile (which just opens the signed URL in a new tab), this
// fetches the file itself and triggers a real download -- Supabase's
// signed URLs don't set Content-Disposition: attachment, so opening one
// directly just previews the PDF/image instead of downloading it.
async function downloadDocFile(bucket, filePath, filename) {
    const url = await createDocSignedUrl(bucket, filePath);
    if (!url) {
        showCompanyMessage("Couldn't download that file. Please try again.", "error");
        return;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename || "document";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
    } catch (error) {
        console.error("Failed to download file:", error);
        showCompanyMessage("Couldn't download that file. Please try again.", "error");
    }
}

// Kept as a thin wrapper -- other pages/older code may still call viewW9
// by name.
async function viewW9(filePath) {
    return viewDocFile(W9_BUCKET, filePath);
}

/* ===========================
   VENDOR PROFILE (read-only popup, opened by clicking a card)
=========================== */

let currentProfileCompany = null;

function openVendorProfileModal(company) {

    currentProfileCompany = company;

    const overlay = document.getElementById("vendorProfileModalOverlay");
    const address = formatAddress(company);
    const hasW9 = Boolean(company.W9FilePath);
    const hasCoi = Boolean(company.COIFilePath);

    document.getElementById("vendorProfileName").textContent = company.Name || "Unnamed company";

    const addressEl = document.getElementById("vendorProfileAddress");
    addressEl.innerHTML = (address.street || address.line2)
        ? `${address.street ? `<p>${escapeHtmlCompanies(address.street)}</p>` : ""}${address.line2 ? `<p>${escapeHtmlCompanies(address.line2)}</p>` : ""}`
        : `<p class="company-card-muted">No address on file</p>`;

    const missing = missingVendorRequirements(company);
    const approved = missing.length === 0;
    const statusEl = document.getElementById("vendorProfileApprovalStatus");
    statusEl.innerHTML = `
        <span class="chip ${approved ? "chip--success" : "chip--danger"}">${approved ? "Approved" : "Not Approved"}</span>
        ${!approved ? `<p class="vendor-profile-missing">Missing: ${escapeHtmlCompanies(missing.join(", "))}</p>` : ""}
    `;

    document.getElementById("vendorProfileSsnFid").textContent = maskSsnFid(company["SSN/FID"]);

    const w9StatusEl = document.getElementById("vendorProfileW9Status");
    w9StatusEl.innerHTML = hasW9
        ? `<span class="chip">On file</span> <button type="button" class="workbook-btn workbook-btn--preview" id="vendorProfileViewW9Btn">View W9</button>`
        : `<span class="chip chip--muted">Missing</span>`;

    const viewW9Btn = document.getElementById("vendorProfileViewW9Btn");
    if (viewW9Btn) {
        viewW9Btn.addEventListener("click", () => viewDocFile(W9_BUCKET, company.W9FilePath));
    }

    // COI -- same plain chip + "View" button as W9 above (deliberately not
    // the interactive dropdown badge used on the grid; see the comment
    // above .doc-badge in styles.css for why). Exempt vendors don't show a
    // COI section at all here, matching the card/list grid.
    const coiSectionEl = document.getElementById("vendorProfileCoiSection");
    if (coiSectionEl) coiSectionEl.style.display = company.COIExempt ? "none" : "";

    if (!company.COIExempt) {
        const coiStatus = getDocStatus(company, "coi");
        const coiStatusEl = document.getElementById("vendorProfileCoiStatus");
        coiStatusEl.innerHTML = hasCoi
            ? `<span class="chip ${coiStatus.state === "expired" ? "chip--danger" : coiStatus.state === "expiring" ? "chip--warning" : ""}">${escapeHtmlCompanies(coiStatus.label)}</span>
               ${coiStatus.meta ? `<span class="company-card-muted">${escapeHtmlCompanies(coiStatus.meta)}</span>` : ""}
               <button type="button" class="workbook-btn workbook-btn--preview" id="vendorProfileViewCoiBtn">View COI</button>`
            : `<span class="chip chip--muted">Missing</span>`;

        const viewCoiBtn = document.getElementById("vendorProfileViewCoiBtn");
        if (viewCoiBtn) {
            viewCoiBtn.addEventListener("click", () => viewDocFile(COI_BUCKET, company.COIFilePath));
        }
    }

    const groups = groupTagsByCategory(tagsForCompany(company.id));
    const tagGroupsEl = document.getElementById("vendorProfileTagGroups");
    tagGroupsEl.innerHTML = groups.map(({ category, tags }) => `
        <div class="vendor-profile-section">
            <span class="company-card-label">${escapeHtmlCompanies(category.name)}</span>
            <div class="vendor-profile-tag-list">
                ${tags.length
                    ? tags.map(tag => `<span class="chip chip--tag">${escapeHtmlCompanies(tag.name)}</span>`).join("")
                    : `<span class="company-card-muted">None assigned</span>`
                }
            </div>
        </div>
    `).join("");

    const notesInput = document.getElementById("vendorProfileNotesInput");
    if (notesInput) notesInput.value = company.Notes || "";
    const notesMessageEl = document.getElementById("vendorProfileNotesMessage");
    if (notesMessageEl) { notesMessageEl.textContent = ""; notesMessageEl.className = "auth-message"; }

    const canEditVendor = vendorsCan("vendors.add_edit_vendor");
    const editBtn = document.getElementById("vendorProfileEditBtn");
    if (editBtn) editBtn.classList.toggle("hidden", !canEditVendor);

    const canSaveNotes = vendorsCan("vendors.save_notes");
    const saveNotesBtn = document.getElementById("vendorProfileSaveNotesBtn");
    if (saveNotesBtn) saveNotesBtn.classList.toggle("hidden", !canSaveNotes);
    if (notesInput) notesInput.disabled = !canSaveNotes;

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

// Saves the free-text Notes field for whichever vendor is currently open in
// the profile popup. Reachable via the "Save Notes" button or by pressing
// Enter in the textarea (Shift+Enter inserts a newline instead -- see the
// keydown listener wired in initCompanyEventListeners()). Editable by
// anyone who can already open a vendor's profile, same access as every
// other vendor field -- no separate masking/RLS on Companies.Notes.
async function saveVendorNotes() {
    if (!currentProfileCompany) return;

    const textarea = document.getElementById("vendorProfileNotesInput");
    const messageEl = document.getElementById("vendorProfileNotesMessage");
    const btn = document.getElementById("vendorProfileSaveNotesBtn");
    const notes = (textarea?.value || "").trim();

    if (btn) btn.disabled = true;
    if (messageEl) { messageEl.textContent = "Saving…"; messageEl.className = "auth-message"; }

    const { error } = await window.supabaseClient
        .from(COMPANIES_TABLE)
        .update({ Notes: notes || null })
        .eq("id", currentProfileCompany.id);

    if (btn) btn.disabled = false;

    if (error) {
        console.error("Failed to save vendor notes:", error);
        if (messageEl) { messageEl.textContent = "Couldn't save notes. Try again."; messageEl.className = "auth-message error"; }
        return;
    }

    currentProfileCompany.Notes = notes || null;
    // Keep the in-memory list in sync too, so reopening this (or another)
    // vendor's profile without a refetch still reflects the saved value.
    const cached = allCompanies.find(c => String(c.id) === String(currentProfileCompany.id));
    if (cached) cached.Notes = notes || null;

    if (messageEl) { messageEl.textContent = "Saved."; messageEl.className = "auth-message success"; }
    window.showToast?.("Notes saved."); // shared bottom-right popup (js/toast.js)
}

function closeVendorProfileModal() {
    document.getElementById("vendorProfileModalOverlay").classList.add("hidden");
    document.body.classList.remove("popup-active");
    currentProfileCompany = null;
}

/* ===========================
   TAG PICKER (inside Add/Edit Vendor form)
=========================== */

// Renders one checkbox group per category into #companyTagsFieldWrap, with
// a search box per group (most useful for the long Trade list). Groups with
// no tags yet (e.g. a brand new category) still render, just with an empty
// "no tags in this category yet" note.
function renderTagPicker(selectedTagIds) {
    const wrap = document.getElementById("companyTagsFieldWrap");
    if (!wrap) return;

    const selected = selectedTagIds || new Set();
    const groups = groupTagsByCategory(allTags);

    wrap.innerHTML = groups.map(({ category, tags }) => `
        <div class="tag-picker-group" data-category-id="${category.id}">
            <div class="tag-picker-group-title">${escapeHtmlCompanies(category.name)}</div>
            ${tags.length > 6 ? `<input type="text" class="tag-picker-search" placeholder="Search ${escapeHtmlCompanies(category.name)}…">` : ""}
            <div class="tag-picker-options">
                ${tags.length ? tags.map(tag => `
                    <label class="tag-picker-option">
                        <input type="checkbox" value="${tag.id}" ${selected.has(String(tag.id)) ? "checked" : ""}>
                        <span>${escapeHtmlCompanies(tag.name)}</span>
                    </label>
                `).join("") : `<p class="company-card-muted">No tags in this category yet — add some from Manage Tags.</p>`}
            </div>
        </div>
    `).join("");

    // Per-group search filter
    wrap.querySelectorAll(".tag-picker-group").forEach(group => {
        const search = group.querySelector(".tag-picker-search");
        if (!search) return;
        search.addEventListener("input", () => {
            const query = search.value.trim().toLowerCase();
            group.querySelectorAll(".tag-picker-option").forEach(option => {
                const text = option.textContent.trim().toLowerCase();
                option.style.display = (!query || text.includes(query)) ? "" : "none";
            });
        });
    });
}

function collectSelectedTagIds() {
    const wrap = document.getElementById("companyTagsFieldWrap");
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

async function saveCompanyTags(companyId, selectedTagIds) {
    const existing = allCompanyTags
        .filter(ct => String(ct.company_id) === String(companyId))
        .map(ct => String(ct.tag_id));

    const selectedSet = new Set(selectedTagIds.map(String));
    const existingSet = new Set(existing);

    const toAdd = selectedTagIds.filter(id => !existingSet.has(String(id)));
    const toRemove = existing.filter(id => !selectedSet.has(id));

    if (toAdd.length) {
        const { error } = await window.supabaseClient
            .from(COMPANY_TAGS_TABLE)
            .insert(toAdd.map(tagId => ({ company_id: companyId, tag_id: tagId })));
        if (error) console.error("Failed to add vendor tags:", error);
    }

    if (toRemove.length) {
        const { error } = await window.supabaseClient
            .from(COMPANY_TAGS_TABLE)
            .delete()
            .eq("company_id", companyId)
            .in("tag_id", toRemove);
        if (error) console.error("Failed to remove vendor tags:", error);
    }

    await loadVendorTagData();
}

/* ===========================
   ADD / EDIT MODAL
=========================== */

// Checking "Exempt from COI requirement" hides the whole COI upload
// section below it -- nothing to fill in for a vendor that doesn't need
// one on file. Wired both on the checkbox's change event and on modal
// open (see openCompanyModal), since opening the form for a vendor that's
// already exempt needs the section hidden immediately, not just after a
// click.
function updateCoiSectionVisibility() {
    const exempt = document.getElementById("companyCoiExemptInput")?.checked;
    const section = document.getElementById("companyCoiSection");
    if (section) section.style.display = exempt ? "none" : "";
}

function openCompanyModal(company) {

    if (!vendorsCan("vendors.add_edit_vendor")) {
        showCompanyMessage("You don't have permission to add or edit vendors.", "error");
        return;
    }

    const overlay = document.getElementById("companyModalOverlay");
    const title = document.getElementById("companyModalTitle");
    const subtitle = document.getElementById("companyModalSubtitle");
    const deleteBtn = document.getElementById("deleteCompanyBtn");
    const existingW9Note = document.getElementById("companyExistingW9Note");
    const existingCoiNote = document.getElementById("companyExistingCoiNote");

    document.getElementById("companyIdInput").value = company?.id ?? "";
    document.getElementById("companyExistingW9PathInput").value = company?.W9FilePath ?? "";
    document.getElementById("companyExistingCoiPathInput").value = company?.COIFilePath ?? "";
    document.getElementById("companyNameInput").value = company?.Name ?? "";
    const friendlyInput = document.getElementById("companyFriendlyNameInput");
    if (friendlyInput) friendlyInput.value = company?.FriendlyName ?? "";
    document.getElementById("companyStreetInput").value = company?.Street ?? "";
    document.getElementById("companyCityInput").value = company?.City ?? "";
    document.getElementById("companyStateInput").value = company?.State ?? "";
    document.getElementById("companyZipInput").value = company?.Zip ?? "";
    document.getElementById("companySsnFidInput").value = company?.["SSN/FID"] ?? "";
    document.getElementById("companyW9Input").value = "";
    document.getElementById("companyCoiInput").value = "";
    document.getElementById("companyCoiExpiresInput").value = company?.COIExpiresOn ?? "";
    document.getElementById("companyCoiExemptInput").checked = Boolean(company?.COIExempt);
    updateCoiSectionVisibility();

    const selectedTagIds = new Set(
        company?.id ? tagsForCompany(company.id).map(tag => String(tag.id)) : []
    );
    renderTagPicker(selectedTagIds);

    setFormMessage("", "");

    if (company?.id) {
        title.textContent = "Edit Vendor";
        subtitle.textContent = "Update the vendor's details, or delete it below.";
        deleteBtn.style.display = "block";

        if (company.W9FilePath) {
            existingW9Note.style.display = "block";
            existingW9Note.textContent = "A W9 is already on file. Uploading a new one will replace it.";
        } else {
            existingW9Note.style.display = "none";
        }

        if (company.COIFilePath) {
            existingCoiNote.style.display = "block";
            existingCoiNote.textContent = "A COI is already on file. Uploading a new one will replace it.";
        } else {
            existingCoiNote.style.display = "none";
        }
    } else {
        title.textContent = "Add Vendor";
        subtitle.textContent = "Enter the Vendor's details below.";
        deleteBtn.style.display = "none";
        existingW9Note.style.display = "none";
        existingCoiNote.style.display = "none";
    }

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeCompanyModal() {
    const overlay = document.getElementById("companyModalOverlay");
    overlay.classList.add("hidden");
    document.body.classList.remove("popup-active");
}

async function handleCompanyFormSubmit(event) {

    event.preventDefault();

    if (!vendorsCan("vendors.add_edit_vendor")) {
        setFormMessage("You don't have permission to add or edit vendors.", "error");
        return;
    }

    const submitBtn = document.getElementById("submitCompanyBtn");
    const id = document.getElementById("companyIdInput").value;
    const existingW9Path = document.getElementById("companyExistingW9PathInput").value;
    const existingCoiPath = document.getElementById("companyExistingCoiPathInput").value;

    const payload = {
        Name: document.getElementById("companyNameInput").value.trim(),
        FriendlyName: (document.getElementById("companyFriendlyNameInput")?.value || "").trim() || null,
        Street: document.getElementById("companyStreetInput").value.trim() || null,
        City: document.getElementById("companyCityInput").value.trim() || null,
        State: document.getElementById("companyStateInput").value.trim().toUpperCase() || null,
        Zip: document.getElementById("companyZipInput").value.trim()
            ? Number(document.getElementById("companyZipInput").value.trim())
            : null,
        "SSN/FID": document.getElementById("companySsnFidInput").value.trim() || null,
        COIExpiresOn: document.getElementById("companyCoiExpiresInput").value || null,
        COIExempt: document.getElementById("companyCoiExemptInput").checked
    };

    if (!payload.Name) {
        setFormMessage("Company name is required.", "error");
        return;
    }

    submitBtn.disabled = true;
    setFormMessage("Saving…", "");

    try {

        const w9File = document.getElementById("companyW9Input").files[0];

        if (w9File) {
            const uploadedPath = await uploadW9(w9File, existingW9Path);
            payload.W9FilePath = uploadedPath;
            // Set automatically, not something staff fill in -- see the
            // comment on the W9UpdatedAt column in
            // sql/supabase-vendor-coi-setup.sql for why it exists.
            payload.W9UpdatedAt = new Date().toISOString();
        }

        const coiFile = document.getElementById("companyCoiInput").files[0];

        if (coiFile) {
            const uploadedPath = await uploadCoi(coiFile, existingCoiPath);
            payload.COIFilePath = uploadedPath;
        }

        let saveError;
        let savedCompanyId = id;

        if (id) {
            const { error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .update(payload)
                .eq("id", id);
            saveError = error;
        } else {
            const { data, error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .insert(payload)
                .select()
                .single();
            saveError = error;
            savedCompanyId = data?.id;
        }

        if (saveError) throw saveError;

        if (savedCompanyId) {
            await saveCompanyTags(savedCompanyId, collectSelectedTagIds());
        }

        closeCompanyModal();
        showCompanyMessage(id ? "Company updated." : "Company added.", "success");
        await loadCompanies();

    } catch (error) {
        console.error("Failed to save company:", error);
        setFormMessage(
            error?.message?.startsWith("You don't have permission")
                ? error.message
                : "Something went wrong saving this company. Please try again.",
            "error"
        );
    } finally {
        submitBtn.disabled = false;
    }
}

async function uploadW9(file, existingPath) {

    if (!vendorsCan("vendors.upload_w9")) {
        throw new Error("You don't have permission to upload W9 files.");
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = `${Date.now()}-${safeName}`;

    const { error: uploadError } = await window.supabaseClient
        .storage
        .from(W9_BUCKET)
        .upload(path, file, { upsert: false });

    if (uploadError) throw uploadError;

    // Best-effort cleanup of the old file — don't block the save on this.
    if (existingPath) {
        window.supabaseClient
            .storage
            .from(W9_BUCKET)
            .remove([existingPath])
            .catch(err => console.warn("Couldn't remove old W9 file:", err));
    }

    return path;
}

// Mirrors uploadW9() above exactly, just against the company-cois bucket.
async function uploadCoi(file, existingPath) {

    if (!vendorsCan("vendors.upload_coi")) {
        throw new Error("You don't have permission to upload COI files.");
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const path = `${Date.now()}-${safeName}`;

    const { error: uploadError } = await window.supabaseClient
        .storage
        .from(COI_BUCKET)
        .upload(path, file, { upsert: false });

    if (uploadError) throw uploadError;

    if (existingPath) {
        window.supabaseClient
            .storage
            .from(COI_BUCKET)
            .remove([existingPath])
            .catch(err => console.warn("Couldn't remove old COI file:", err));
    }

    return path;
}

/* ===========================
   DELETE (shared by companies + contacts)
=========================== */

let pendingDeleteType = null; // "company" | "contact"
let pendingDeleteId = null;
let pendingDeleteW9Path = null;
let pendingDeleteCoiPath = null;
let pendingDeleteName = "";

// Typing the record's own name to confirm (same pattern used for project
// deletion) -- cheap insurance against a one-click delete landing on the
// wrong vendor or contact, which is otherwise unrecoverable. This modal is
// shared between the vendor and contact delete flows, so the expected name
// is tracked in pendingDeleteName rather than read from a fixed field.
function deleteConfirmNameMatches() {
    const typed = document.getElementById("deleteConfirmNameInput").value;
    return pendingDeleteName.length > 0 && typed.trim() === pendingDeleteName;
}

function deleteConfirmReady() {
    return deleteConfirmNameMatches()
        && document.getElementById("deleteConfirmUnderstandCheckbox").checked;
}

function updateDeleteConfirmBtnState() {
    document.getElementById("confirmDeleteBtn").disabled = !deleteConfirmReady();
}

function resetDeleteConfirmFields() {
    const input = document.getElementById("deleteConfirmNameInput");
    input.value = "";
    document.getElementById("deleteConfirmUnderstandCheckbox").checked = false;
    document.getElementById("deleteConfirmMessage").textContent = "";
    updateDeleteConfirmBtnState();
    input.focus();
}

function openDeleteConfirm() {
    if (!vendorsCan("vendors.delete_vendor")) {
        setFormMessage("You don't have permission to delete vendors.", "error");
        return;
    }

    const id = document.getElementById("companyIdInput").value;
    const w9Path = document.getElementById("companyExistingW9PathInput").value;
    const coiPath = document.getElementById("companyExistingCoiPathInput").value;

    if (!id) return;

    pendingDeleteType = "company";
    pendingDeleteId = id;
    pendingDeleteW9Path = w9Path || null;
    pendingDeleteCoiPath = coiPath || null;
    pendingDeleteName = document.getElementById("companyNameInput").value.trim() || "";

    document.getElementById("deleteConfirmTitle").textContent = "Delete this vendor?";
    document.getElementById("deleteConfirmName").textContent = pendingDeleteName || "this vendor";
    document.getElementById("deleteConfirmText").textContent =
        "This will permanently remove the vendor record and its W9/COI files. This can't be undone.";
    document.getElementById("deleteConfirmOverlay").classList.remove("hidden");
    resetDeleteConfirmFields();
}

function openContactDeleteConfirm() {
    if (!vendorsCan("vendors.manage_contacts")) {
        setContactFormMessage("You don't have permission to delete vendor contacts.", "error");
        return;
    }

    const id = document.getElementById("contactIdInput").value;

    if (!id) return;

    pendingDeleteType = "contact";
    pendingDeleteId = id;
    pendingDeleteW9Path = null;
    pendingDeleteCoiPath = null;
    pendingDeleteName = document.getElementById("contactNameInput").value.trim() || "";

    document.getElementById("deleteConfirmTitle").textContent = "Delete this contact?";
    document.getElementById("deleteConfirmName").textContent = pendingDeleteName || "this contact";
    document.getElementById("deleteConfirmText").textContent =
        "This will permanently remove this contact. This can't be undone.";
    document.getElementById("deleteConfirmOverlay").classList.remove("hidden");
    resetDeleteConfirmFields();
}

function closeDeleteConfirm() {
    document.getElementById("deleteConfirmOverlay").classList.add("hidden");
    pendingDeleteType = null;
    pendingDeleteId = null;
    pendingDeleteW9Path = null;
    pendingDeleteCoiPath = null;
    pendingDeleteName = "";
}

async function confirmDelete() {

    if (!pendingDeleteId || !pendingDeleteType) return;
    if (!deleteConfirmReady()) return;

    // Defense in depth -- openDeleteConfirm()/openContactDeleteConfirm()
    // already check this before the modal even opens, but this is the one
    // function that actually performs the delete, so it checks again too.
    const requiredPermission = pendingDeleteType === "company" ? "vendors.delete_vendor" : "vendors.manage_contacts";
    if (!vendorsCan(requiredPermission)) {
        document.getElementById("deleteConfirmMessage").textContent = "You don't have permission to do this.";
        document.getElementById("deleteConfirmMessage").className = "auth-message error";
        return;
    }

    const confirmBtn = document.getElementById("confirmDeleteBtn");
    confirmBtn.disabled = true;

    try {

        if (pendingDeleteType === "company") {

            const { error } = await window.supabaseClient
                .from(COMPANIES_TABLE)
                .delete()
                .eq("id", pendingDeleteId);

            if (error) throw error;

            if (pendingDeleteW9Path) {
                window.supabaseClient
                    .storage
                    .from(W9_BUCKET)
                    .remove([pendingDeleteW9Path])
                    .catch(err => console.warn("Couldn't remove W9 file:", err));
            }

            if (pendingDeleteCoiPath) {
                window.supabaseClient
                    .storage
                    .from(COI_BUCKET)
                    .remove([pendingDeleteCoiPath])
                    .catch(err => console.warn("Couldn't remove COI file:", err));
            }

            closeDeleteConfirm();
            closeCompanyModal();
            showCompanyMessage("Vendor deleted.", "success");
            await loadCompanies();

        } else if (pendingDeleteType === "contact") {

            const companyId = document.getElementById("contactCompanyIdInput").value;

            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .delete()
                .eq("id", pendingDeleteId);

            if (error) throw error;

            closeDeleteConfirm();
            closeContactFormModal();
            await refreshContactsList(companyId);

            // Same reasoning as the save path above -- keep the vendor
            // list's search index in sync with the contact that was just
            // deleted.
            await loadAllContacts();
            renderCompanies(allCompanies);

        }

    } catch (error) {
        console.error("Failed to delete:", error);
        document.getElementById("deleteConfirmMessage").textContent =
            "Something went wrong deleting this. Please try again.";
        document.getElementById("deleteConfirmMessage").className = "auth-message error";
    } finally {
        confirmBtn.disabled = false;
    }
}

/* ===========================
   CONTACTS
=========================== */

const CONTACTS_TABLE = "Contacts";

function setContactFormMessage(text, type) {
    const el = document.getElementById("contactFormMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

async function openContactsModal(company) {

    const overlay = document.getElementById("contactsModalOverlay");
    const titleEl = document.getElementById("contactsModalTitle");

    document.getElementById("contactsModalCompanyId").value = company.id;
    titleEl.textContent = `Contacts — ${company.Name || "Company"}`;
    titleEl.dataset.companyName = company.Name || "";

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");

    await refreshContactsList(company.id);
}

function closeContactsModal() {
    document.getElementById("contactsModalOverlay").classList.add("hidden");
    if (document.getElementById("contactModalOverlay").classList.contains("hidden")) {
        document.body.classList.remove("popup-active");
    }
}

async function refreshContactsList(companyId) {

    const body = document.getElementById("contactsListBody");
    body.innerHTML = `<p class="workbook-preview-loading">Loading contacts…</p>`;

    const { data, error } = await window.supabaseClient
        .from(CONTACTS_TABLE)
        .select("*")
        .eq("company_id", companyId)
        .order("Name", { ascending: true });

    if (error) {
        console.error("Failed to load contacts:", error);
        body.innerHTML = `<p class="workbook-preview-empty">Couldn't load contacts. Please try again.</p>`;
        return;
    }

    renderContactList(data || [], companyId);
}

function renderContactList(contacts, companyId) {

    const body = document.getElementById("contactsListBody");

    if (!contacts.length) {
        body.innerHTML = `<p class="workbook-preview-empty">No contacts on file for this company yet.</p>`;
        return;
    }

    const companyName = document.getElementById("contactsModalTitle").dataset.companyName || "";

    body.innerHTML = `
        <div class="contact-list">
            ${contacts.map(contact => `
                <div class="contact-item">

                    <button
                        type="button"
                        class="company-edit-btn contact-edit-btn ${vendorsCan("vendors.manage_contacts") ? "" : "hidden"}"
                        data-id="${contact.id}"
                        aria-label="Edit contact">
                        <span class="company-edit-icon"></span>
                    </button>

                    <h4 class="contact-item-name">${escapeHtmlCompanies(contact.Name || "Unnamed contact")}</h4>
                    ${contact.Title ? `<p class="contact-item-title">${escapeHtmlCompanies(contact.Title)}</p>` : ""}

                    <div class="contact-item-details">
                        ${contact.WorkPhone ? `<p><span class="company-card-label">Work</span> ${escapeHtmlCompanies(contact.WorkPhone)}</p>` : ""}
                        ${contact.MobilePhone ? `<p><span class="company-card-label">Mobile</span> ${escapeHtmlCompanies(contact.MobilePhone)}</p>` : ""}
                        ${contact.Email ? `<p><span class="company-card-label">Email</span> ${escapeHtmlCompanies(contact.Email)}</p>` : ""}
                        ${contact.Role ? `<p><span class="company-card-label">Role</span> ${escapeHtmlCompanies(contact.Role)}</p>` : ""}
                    </div>

                </div>
            `).join("")}
        </div>
    `;

    body.querySelectorAll(".contact-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const contact = contacts.find(c => String(c.id) === String(btn.dataset.id));
            if (contact) openContactFormModal(contact, companyId, companyName);
        });
    });
}

function openContactFormModal(contact, companyId, companyName) {

    // Defense in depth -- the buttons that call this (the contacts list's
    // own "+ Add Contact" and per-row edit icon) are already hidden by
    // renderContactList()/applyVendorPermissionsToUI() when this permission
    // is missing, so there's no visible trigger left to show an error
    // message against; this silently no-ops instead.
    if (!vendorsCan("vendors.manage_contacts")) return;

    const overlay = document.getElementById("contactModalOverlay");
    const title = document.getElementById("contactModalTitle");
    const deleteBtn = document.getElementById("deleteContactBtn");

    document.getElementById("contactIdInput").value = contact?.id ?? "";
    document.getElementById("contactCompanyIdInput").value = companyId;
    document.getElementById("contactNameInput").value = contact?.Name ?? "";
    document.getElementById("contactTitleInput").value = contact?.Title ?? "";
    document.getElementById("contactWorkPhoneInput").value = contact?.WorkPhone ?? "";
    document.getElementById("contactMobilePhoneInput").value = contact?.MobilePhone ?? "";
    document.getElementById("contactEmailInput").value = contact?.Email ?? "";
    document.getElementById("contactRoleInput").value = contact?.Role ?? "";

    title.textContent = contact?.id
        ? `Edit Contact — ${companyName || "Company"}`
        : `Add Contact — ${companyName || "Company"}`;

    deleteBtn.style.display = contact?.id ? "block" : "none";

    setContactFormMessage("", "");

    overlay.classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeContactFormModal() {
    document.getElementById("contactModalOverlay").classList.add("hidden");
    if (document.getElementById("contactsModalOverlay").classList.contains("hidden")) {
        document.body.classList.remove("popup-active");
    }
}

async function handleContactFormSubmit(event) {

    event.preventDefault();

    const submitBtn = document.getElementById("submitContactBtn");
    const id = document.getElementById("contactIdInput").value;
    const companyId = document.getElementById("contactCompanyIdInput").value;

    const payload = {
        company_id: companyId,
        Name: document.getElementById("contactNameInput").value.trim(),
        Title: document.getElementById("contactTitleInput").value.trim() || null,
        WorkPhone: document.getElementById("contactWorkPhoneInput").value.trim() || null,
        MobilePhone: document.getElementById("contactMobilePhoneInput").value.trim() || null,
        Email: document.getElementById("contactEmailInput").value.trim() || null,
        Role: document.getElementById("contactRoleInput").value.trim() || null
    };

    if (!payload.Name) {
        setContactFormMessage("Contact name is required.", "error");
        return;
    }

    submitBtn.disabled = true;
    setContactFormMessage("Saving…", "");

    try {

        let saveError;

        if (id) {
            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .update(payload)
                .eq("id", id);
            saveError = error;
        } else {
            const { error } = await window.supabaseClient
                .from(CONTACTS_TABLE)
                .insert(payload);
            saveError = error;
        }

        if (saveError) throw saveError;

        closeContactFormModal();
        await refreshContactsList(companyId);

        // Keep the vendor list's search index (see buildCardSearchDataHtml)
        // current -- otherwise a contact just added/renamed wouldn't be
        // findable from the search box until the page was reloaded.
        await loadAllContacts();
        renderCompanies(allCompanies);

    } catch (error) {
        console.error("Failed to save contact:", error);
        setContactFormMessage("Something went wrong saving this contact. Please try again.", "error");
    } finally {
        submitBtn.disabled = false;
    }
}

/* ===========================
   MANAGE TAGS (add/rename/delete categories + tags)
=========================== */

function setManageTagsMessage(text, type) {
    const el = document.getElementById("manageTagsMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
    if (type === "success") window.showToast?.(text); // shared bottom-right popup (js/toast.js)
}

function openManageTagsModal() {
    // Defense in depth -- the toolbar's "Manage Tags" entry point is already
    // hidden by applyVendorPermissionsToUI() when this permission is missing,
    // so there's no visible trigger left; this silently no-ops instead of
    // trying to show a message against a modal that isn't open yet.
    if (!vendorsCan("vendors.manage_tags")) return;
    renderManageTagsCategories();
    setManageTagsMessage("", "");
    document.getElementById("manageTagsModalOverlay").classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeManageTagsModal() {
    document.getElementById("manageTagsModalOverlay").classList.add("hidden");
    document.body.classList.remove("popup-active");
    // Also end the "?" walkthrough, if it was left running, so it doesn't
    // reappear already in progress the next time this modal is opened.
    closeManageTagsTour();
}

/* ===========================
   MANAGE TAGS "?" WALKTHROUGH

   Coleby, after seeing a first version that was just a small static
   popover: "make it bigger and make it inline with the cancel[,] and then
   make it work by having a popup... write instructions and kind of go over
   the pop up so they know how to do these things." -- a spotlight
   walkthrough: dim the screen, cut a highlighted window around the real
   "New tag name" box, explain it, then step to the real "New category
   name" box and explain that one, rather than a single static text box.
=========================== */

const MANAGE_TAGS_TOUR_STEPS = [
    {
        selector: "#manageTagsCategories .tag-admin-add-tag",
        html: "<strong>Add a tag:</strong> type a name here, under whichever category it belongs in, then click <strong>+ Add Tag</strong>."
    },
    {
        selector: "#manageTagsModalOverlay .tag-admin-add-category",
        html: "<strong>Add a category:</strong> type a name here, then click <strong>+ Add Category</strong>. Categories group related tags together, like “Asset Specialty” or “Trade.”"
    }
];

let manageTagsTourStepIndex = 0;

function findManageTagsTourStep(index) {
    const step = MANAGE_TAGS_TOUR_STEPS[index];
    if (!step) return null;
    const target = document.querySelector(step.selector);
    if (!target) return null; // e.g. no categories exist yet to point at
    return { html: step.html, target };
}

function positionManageTagsTourStep(target) {
    const highlight = document.getElementById("manageTagsTourHighlight");
    const tooltip = document.getElementById("manageTagsTourTooltip");
    if (!highlight || !tooltip) return;

    const pad = 8;
    const rect = target.getBoundingClientRect();

    highlight.style.top = `${rect.top - pad}px`;
    highlight.style.left = `${rect.left - pad}px`;
    highlight.style.width = `${rect.width + pad * 2}px`;
    highlight.style.height = `${rect.height + pad * 2}px`;

    // Prefer the tooltip below the highlighted box; if there isn't room
    // before the bottom of the screen, put it above instead.
    const tooltipHeight = tooltip.offsetHeight || 140;
    const tooltipWidth = tooltip.offsetWidth || 300;
    const gap = 12;

    let top = rect.bottom + pad + gap;
    if (top + tooltipHeight > window.innerHeight - 12) {
        top = rect.top - pad - gap - tooltipHeight;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - tooltipHeight - 12));

    let left = Math.max(12, Math.min(rect.left, window.innerWidth - tooltipWidth - 12));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
}

function handleManageTagsTourReposition() {
    const overlay = document.getElementById("manageTagsTourOverlay");
    if (!overlay || overlay.classList.contains("hidden")) return;
    const step = findManageTagsTourStep(manageTagsTourStepIndex);
    if (step) positionManageTagsTourStep(step.target);
}

function showManageTagsTourStep(index) {
    const step = findManageTagsTourStep(index);
    if (!step) {
        // Nothing to point at (e.g. no categories yet) -- don't get stuck
        // showing an empty step, just end the walkthrough.
        closeManageTagsTour();
        return;
    }

    manageTagsTourStepIndex = index;

    if (step.target.scrollIntoView) {
        step.target.scrollIntoView({ block: "center", behavior: "auto" });
    }
    // scrollIntoView can take a frame to settle before the new position
    // shows up in getBoundingClientRect().
    requestAnimationFrame(() => positionManageTagsTourStep(step.target));

    document.getElementById("manageTagsTourText").innerHTML = step.html;

    const isLastStep = index === MANAGE_TAGS_TOUR_STEPS.length - 1;
    const nextBtn = document.getElementById("manageTagsTourNextBtn");
    if (nextBtn) nextBtn.textContent = isLastStep ? "Done" : "Next";

    const stepCount = document.getElementById("manageTagsTourStepCount");
    if (stepCount) stepCount.textContent = `${index + 1} of ${MANAGE_TAGS_TOUR_STEPS.length}`;

    document.getElementById("manageTagsTourOverlay").classList.remove("hidden");
}

function openManageTagsTour() {
    showManageTagsTourStep(0);
    window.addEventListener("resize", handleManageTagsTourReposition);
    // capture: true so this also catches scrolling inside the modal itself,
    // not just the window -- either way the highlighted box needs to move.
    window.addEventListener("scroll", handleManageTagsTourReposition, true);
}

function advanceManageTagsTour() {
    const isLastStep = manageTagsTourStepIndex === MANAGE_TAGS_TOUR_STEPS.length - 1;
    if (isLastStep) {
        closeManageTagsTour();
    } else {
        showManageTagsTourStep(manageTagsTourStepIndex + 1);
    }
}

function closeManageTagsTour() {
    const overlay = document.getElementById("manageTagsTourOverlay");
    if (overlay) overlay.classList.add("hidden");
    manageTagsTourStepIndex = 0;
    window.removeEventListener("resize", handleManageTagsTourReposition);
    window.removeEventListener("scroll", handleManageTagsTourReposition, true);
}

function renderManageTagsCategories() {
    const wrap = document.getElementById("manageTagsCategories");
    if (!wrap) return;

    const groups = groupTagsByCategory(allTags);

    wrap.innerHTML = groups.map(({ category, tags }) => `
        <div class="tag-admin-category" data-category-id="${category.id}">
            <div class="tag-admin-category-header">
                <h3>${escapeHtmlCompanies(category.name)}</h3>
                <div class="tag-admin-category-actions">
                    <button type="button" class="workbook-btn workbook-btn--preview tag-admin-rename-cat" data-id="${category.id}">Rename</button>
                    <button type="button" class="workbook-btn workbook-btn--danger tag-admin-delete-cat" data-id="${category.id}">Delete</button>
                </div>
            </div>
            <div class="tag-admin-tag-list">
                ${tags.length ? tags.map(tag => `
                    <div class="tag-admin-tag-row" data-tag-id="${tag.id}">
                        <span>${escapeHtmlCompanies(tag.name)}</span>
                        <div class="tag-admin-tag-actions">
                            <button type="button" class="tag-admin-rename-tag" data-id="${tag.id}">Rename</button>
                            <button type="button" class="tag-admin-delete-tag" data-id="${tag.id}">Delete</button>
                        </div>
                    </div>
                `).join("") : `<p class="company-card-muted">No tags yet.</p>`}
            </div>
            <div class="tag-admin-add-tag">
                <input type="text" class="tag-admin-new-tag-input" data-category-id="${category.id}" placeholder="New tag name">
                <button type="button" class="workbook-btn workbook-btn--preview tag-admin-add-tag-btn" data-category-id="${category.id}">+ Add Tag</button>
            </div>
        </div>
    `).join("");
}

// After any tag/category mutation: reload the underlying data, then
// re-render everything that shows tags (vendor cards, the manage-tags
// list, and the tag picker if the Add/Edit Vendor form happens to be open).
async function refreshAfterTagAdminChange() {
    await loadVendorTagData();
    renderCompanies(allCompanies);
    renderManageTagsCategories();

    const companyModalOverlay = document.getElementById("companyModalOverlay");
    if (companyModalOverlay && !companyModalOverlay.classList.contains("hidden")) {
        const id = document.getElementById("companyIdInput").value;
        const selectedTagIds = new Set(
            id ? tagsForCompany(id).map(tag => String(tag.id)) : []
        );
        renderTagPicker(selectedTagIds);
    }
}

async function addTagCategory() {
    if (!vendorsCan("vendors.manage_tags")) return;
    const input = document.getElementById("newTagCategoryInput");
    const name = input.value.trim();
    if (!name) return;

    const nextSortOrder = allTagCategories.reduce((max, cat) => Math.max(max, cat.sort_order || 0), 0) + 1;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .insert({ name, sort_order: nextSortOrder });

    if (error) {
        console.error("Failed to add tag category:", error);
        setManageTagsMessage("Couldn't add that category — it may already exist.", "error");
        return;
    }

    input.value = "";
    setManageTagsMessage("Category added.", "success");
    await refreshAfterTagAdminChange();
}

async function renameTagCategory(categoryId) {
    if (!vendorsCan("vendors.manage_tags")) return;
    const category = allTagCategories.find(c => String(c.id) === String(categoryId));
    if (!category) return;

    const newName = prompt("Rename category:", category.name);
    if (!newName || !newName.trim() || newName.trim() === category.name) return;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .update({ name: newName.trim() })
        .eq("id", categoryId);

    if (error) {
        console.error("Failed to rename category:", error);
        setManageTagsMessage("Couldn't rename that category.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function deleteTagCategory(categoryId) {
    if (!vendorsCan("vendors.manage_tags")) return;
    const category = allTagCategories.find(c => String(c.id) === String(categoryId));
    if (!category) return;

    if (!confirm(`Delete "${category.name}" and every tag in it? This removes those tags from all vendors that have them. This can't be undone.`)) return;

    const { error } = await window.supabaseClient
        .from(TAG_CATEGORIES_TABLE)
        .delete()
        .eq("id", categoryId);

    if (error) {
        console.error("Failed to delete category:", error);
        setManageTagsMessage("Couldn't delete that category.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function addTagToCategory(categoryId, inputEl) {
    if (!vendorsCan("vendors.manage_tags")) return;
    const name = inputEl.value.trim();
    if (!name) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .insert({ category_id: categoryId, name });

    if (error) {
        console.error("Failed to add tag:", error);
        setManageTagsMessage("Couldn't add that tag — it may already exist in this category.", "error");
        return;
    }

    setManageTagsMessage("Tag added.", "success");
    await refreshAfterTagAdminChange();
}

async function renameTag(tagId) {
    if (!vendorsCan("vendors.manage_tags")) return;
    const tag = allTags.find(t => String(t.id) === String(tagId));
    if (!tag) return;

    const newName = prompt("Rename tag:", tag.name);
    if (!newName || !newName.trim() || newName.trim() === tag.name) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .update({ name: newName.trim() })
        .eq("id", tagId);

    if (error) {
        console.error("Failed to rename tag:", error);
        setManageTagsMessage("Couldn't rename that tag.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

async function deleteTag(tagId) {
    if (!vendorsCan("vendors.manage_tags")) return;
    const tag = allTags.find(t => String(t.id) === String(tagId));
    if (!tag) return;

    if (!confirm(`Delete "${tag.name}"? This removes it from every vendor that has it. This can't be undone.`)) return;

    const { error } = await window.supabaseClient
        .from(TAGS_TABLE)
        .delete()
        .eq("id", tagId);

    if (error) {
        console.error("Failed to delete tag:", error);
        setManageTagsMessage("Couldn't delete that tag.", "error");
        return;
    }

    await refreshAfterTagAdminChange();
}

/* ===========================
   REPORT: VENDORS BY APPROVAL STATUS
   Builds a real .pdf client-side (pdfmake, loaded via CDN in venders.html)
   from whatever is currently in allCompanies — no server round trip, so
   the report is always current as of the last page load.

   Layout matches the "Vender Approval Report.docx" template Coleby
   provided: letterhead header (logo + gray title + blue rule), gray
   metadata block (Report ID / Generated / Prepared by), an Executive
   Summary + Vender Criteria section, then bulleted Approve Venders /
   Unapproved Venders lists. Spelling ("Vender") is kept consistent with
   the template and the rest of this page.
=========================== */

const REPORT_META_COLOR = "#6B7280";
const REPORT_HEADER_TITLE_COLOR = "#595959";
const REPORT_RULE_COLOR = "#1E76BD";
const REPORT_LOGO_PATH = "/assets/logos/leewaed-logo.png"; // already used site-wide (favicon, login, index)

// Fetches the existing site logo as a data URL so it can be embedded in
// the PDF header. Returns null (not a throw) if it can't be loaded, so a
// missing logo never blocks the whole report from generating.
async function loadReportLogoDataUrl() {
    try {
        const res = await fetch(REPORT_LOGO_PATH);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        console.warn("Couldn't load report logo:", err);
        return null;
    }
}

function reportId(prefix = "VAR") {
    const stamp = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${prefix}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
}

function currentStaffName() {
    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");
    return (profile && (profile.full_name || profile.username)) || "Staff Portal";
}

// Logs a row to the generated_reports table so a report can be looked up
// later by its Report ID (the one printed at the top of the PDF). This is
// metadata only — the PDF itself isn't stored, just who generated it, when,
// and a few counts/filters for context. Never blocks or fails report
// generation: if the insert errors (or Supabase isn't configured), this
// just logs to the console and the report still downloads normally.
const GENERATED_REPORTS_TABLE = "generated_reports";

async function logGeneratedReport(reportIdText, reportType, details = {}) {
    if (!window.supabaseClient) return;

    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");

    try {
        const { error } = await window.supabaseClient.from(GENERATED_REPORTS_TABLE).insert({
            report_id: reportIdText,
            report_type: reportType,
            staff_id: profile && (profile.id ?? profile.uid) != null ? String(profile.id ?? profile.uid) : null,
            staff_name: currentStaffName(),
            details,
        });
        if (error) console.error("Failed to log generated report:", error);
    } catch (err) {
        console.error("Failed to log generated report:", err);
    }
}

// The gray "Report ID / Generated / Prepared by" block — appears at the
// top of every vendor report, matching the template. Takes the already-
// computed report ID string (rather than a prefix) so the same ID can also
// be logged via logGeneratedReport().
function reportMetadataBlock(generatedOn, staffName, reportIdText) {
    return {
        fontSize: 8.5,
        color: REPORT_META_COLOR,
        margin: [0, 0, 0, 10],
        text: [
            `Report ID: ${reportIdText}\n`,
            `Generated: ${generatedOn}\n`,
            `Prepared by: ${staffName}`,
        ],
    };
}

function reportHeading(text) {
    return { text, bold: true, fontSize: 14, margin: [0, 0, 0, 4] };
}

function reportSubheading(text) {
    return { text, bold: true, fontSize: 12, margin: [0, 6, 0, 2] };
}

function reportBodyItalic(text) {
    return { text, italics: true, margin: [20, 0, 0, 8] };
}

function reportVendorNameList(companies) {
    if (!companies.length) {
        return { text: "None.", italics: true };
    }
    return { ul: companies.map(c => c.Name || "Unnamed company"), italics: true, margin: [0, 0, 0, 4] };
}

// Letterhead header shared by every vendor report: logo top-left +
// "The Leeward Group, LLC" in gray bold, underlined by a 3pt blue rule —
// repeats on every page.
function buildReportLetterheadHeader(logoDataUrl) {
    const headerTitle = { text: "The Leeward Group, LLC", bold: true, fontSize: 20, color: REPORT_HEADER_TITLE_COLOR, alignment: "center" };
    return {
        margin: [50, 22, 50, 0],
        stack: [
            logoDataUrl
                ? { columns: [
                      { image: logoDataUrl, width: 55, height: 25 },
                      { ...headerTitle, margin: [0, 12, 55, 0] },
                  ] }
                : headerTitle,
            { canvas: [{ type: "line", x1: 0, y1: 8, x2: 495, y2: 8, lineWidth: 2.5, lineColor: REPORT_RULE_COLOR }] },
        ],
    };
}

// Footer shared by every vendor report: report title on the left, live
// "Page X of Y" on the right.
function buildReportFooter(titleText) {
    return (currentPage, pageCount) => ({
        margin: [50, 10, 50, 0],
        columns: [
            { text: titleText, fontSize: 9, color: "#333333" },
            { text: `Page ${currentPage} of ${pageCount}`, fontSize: 9, color: "#333333", alignment: "right" },
        ],
    });
}

// Builds the report as a PDF Blob (does NOT download it — that's a
// separate step so the caller can preview it first). Returns
// { ok, blob, fileName, approvedCount, notApprovedCount } on success,
// or { ok: false, error } on failure.
async function buildApprovalStatusReportPdf() {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const companies = [...allCompanies].sort((a, b) =>
        (a.Name || "").localeCompare(b.Name || "")
    );

    const approved = companies.filter(isVendorApproved);
    const notApproved = companies.filter(c => !isVendorApproved(c));

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VAR");

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Approval Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Approval Report", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),

            reportHeading("1. Executive Summary:"),
            reportBodyItalic(
                `During this report, a total of ${companies.length} vendors were evaluated in our Leeward Group Data base. ` +
                `Of those reviewed, ${approved.length} vendors are approve venders, while ${notApproved.length} vendors were not approved based ` +
                `on the organization's evaluation criteria. See 1.a for vender criteria*.`
            ),
            {
                text: "This report supports ongoing efforts to maintain quality, manage risk, and ensure vendor performance aligns with organizational expectations.",
                italics: true,
                margin: [0, 0, 0, 8],
            },

            reportHeading("1.a. Vender Criteria:"),
            reportBodyItalic(
                "To be an Approve Vender in the Leeward Group database, then the following* must be met. Failure to do so will be flagged " +
                "automatically in our system, resulting in not being automatically selected in the bid process."
            ),
            {
                ul: ["Submitted W-9", "Valid COI", "Valid SSN / FID", "Valid Address", "Proper internal tags", "Asset Specialty", "Trade code specialty"],
                italics: true,
                margin: [0, 0, 0, 10],
            },

            { text: "Approve Venders", bold: true, fontSize: 14, pageBreak: "before", margin: [0, 0, 0, 4] },
            reportVendorNameList(approved),

            { text: "Unapproved Venders", bold: true, fontSize: 14, margin: [0, 10, 0, 4] },
            reportVendorNameList(notApproved),
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "approval", {
            approvedCount: approved.length,
            notApprovedCount: notApproved.length,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Approval-Report-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: approved.length,
            notApprovedCount: notApproved.length,
        };
    } catch (err) {
        console.error("Failed to build approval status report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

/* ===========================
   REPORT: VENDORS BY SPECIALTY
   Two flavors, both approved-vendors-only:
     - General: one flat, alphabetical list of every approved vendor
       (bold name) with all of its tags listed underneath — no category
       grouping.
     - Custom: driven by the wizard's selections, { [categoryId]: [tagId,...] }.
       Only categories with at least one selected tag get a section; within
       each, only the selected tags are shown, each with the approved
       vendors that carry it.
   Unapproved vendors are left out entirely from both, not shown with a
   status marker.
=========================== */

// Builds the "General" specialty report as a PDF Blob (does NOT download
// it — same preview-first pattern as the approval report). Returns
// { ok, blob, fileName, approvedCount } on success, or { ok: false, error }.
async function buildGeneralSpecialtyReportPdf() {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const approved = [...allCompanies]
        .filter(isVendorApproved)
        .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VSR");

    const bodyContent = approved.length
        ? approved.flatMap(company => {
            const tags = tagsForCompany(company.id).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            return [
                { text: company.Name || "Unnamed company", bold: true, fontSize: 13, margin: [0, 8, 0, 2] },
                tags.length
                    ? { ul: tags.map(t => t.name), italics: true, margin: [0, 0, 0, 0] }
                    : { text: "No tags assigned.", italics: true },
            ];
        })
        : [{ text: "No approved vendors to report.", italics: true }];

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Specialty Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Specialty Report", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),
            {
                text: "This report lists The Leeward Group's approved vendors along with all of their assigned specialty tags. " +
                    "Only approved vendors are included below.",
                italics: true,
                margin: [0, 0, 0, 10],
            },
            ...bodyContent,
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "specialty_general", {
            approvedCount: approved.length,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Specialty-Report-general-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: approved.length,
        };
    } catch (err) {
        console.error("Failed to build general specialty report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

// Builds the "Custom" specialty report from the wizard's selections —
// { [categoryId]: [tagId, ...] }. A vendor must carry at least one selected
// tag from EVERY category that had a selection (so checking "Flex Space"
// in Asset Specialty and "1010 - Temporary Electric" in Trade only returns
// vendors that have both — categories with no selection just aren't used
// as a filter). If nothing was selected anywhere, the report still
// generates with a "No tags selected." body. If selections were made but
// no approved vendor matches all of them, NO PDF is built at all — this
// returns { ok: false, error, noMatches: true } so the wizard can show a
// message instead of opening a preview. Returns
// { ok, blob, fileName, approvedCount } on success, or { ok: false, error }.
async function buildCustomSpecialtyReportPdf(selections) {

    if (typeof pdfMake === "undefined") {
        console.error("pdfmake failed to load");
        return { ok: false, error: "Report library failed to load. Refresh and try again." };
    }

    const approved = [...allCompanies].filter(isVendorApproved);

    const sortedCategories = [...allTagCategories].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    const activeCategories = sortedCategories
        .map(category => {
            const selectedTagIds = new Set(((selections && selections[category.id]) || []).map(String));
            const tags = allTags
                .filter(t => String(t.category_id) === String(category.id) && selectedTagIds.has(String(t.id)))
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            return { category, tags };
        })
        .filter(group => group.tags.length > 0);

    let matchedVendors = [];

    if (activeCategories.length) {
        // A vendor qualifies if, for every category with a selection, it
        // carries at least one of that category's selected tags (OR within
        // a category, AND across categories).
        matchedVendors = approved
            .filter(company => {
                const companyTags = tagsForCompany(company.id);
                return activeCategories.every(group =>
                    group.tags.some(tag => companyTags.some(t => String(t.id) === String(tag.id)))
                );
            })
            .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));

        if (!matchedVendors.length) {
            return {
                ok: false,
                noMatches: true,
                error: "No approved vendor matches all of the selected tags.",
            };
        }
    }

    const generatedOn = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const staffName = currentStaffName();
    const logoDataUrl = await loadReportLogoDataUrl();
    const reportIdText = reportId("VSR");

    const bodyContent = [];

    if (!activeCategories.length) {
        bodyContent.push({ text: "No tags selected.", italics: true });
    } else {
        const filterDescription = activeCategories
            .map(group => `${group.category.name}: ${group.tags.map(t => t.name).join(" or ")}`);

        bodyContent.push({
            text: "Matching all of the following:",
            bold: true,
            fontSize: 12,
            margin: [0, 0, 0, 2],
        });
        bodyContent.push({ ul: filterDescription, margin: [0, 0, 0, 10] });
        bodyContent.push(reportSubheading("Matching Venders"));
        bodyContent.push(reportVendorNameList(matchedVendors));
    }

    const docDefinition = {
        pageMargins: [50, 110, 50, 60],
        header: buildReportLetterheadHeader(logoDataUrl),
        footer: buildReportFooter("Vender Specialty Report"),
        defaultStyle: { fontSize: 12 },

        content: [
            { text: "Vender Specialty Report — Custom", bold: true, fontSize: 18, alignment: "center", margin: [0, 0, 0, 10] },
            reportMetadataBlock(generatedOn, staffName, reportIdText),
            {
                text: "This report includes only approved vendors matching the specialty tags selected when it was generated.",
                italics: true,
                margin: [0, 0, 0, 10],
            },
            ...bodyContent,
        ],
    };

    try {
        const blob = await pdfMake.createPdf(docDefinition).getBlob();
        const dateStamp = new Date().toISOString().slice(0, 10);

        await logGeneratedReport(reportIdText, "specialty_custom", {
            approvedCount: matchedVendors.length,
            selections,
        });

        return {
            ok: true,
            blob,
            fileName: `Vender-Specialty-Report-custom-${dateStamp}.pdf`,
            reportId: reportIdText,
            approvedCount: matchedVendors.length,
        };
    } catch (err) {
        console.error("Failed to build custom specialty report:", err);
        return { ok: false, error: "Couldn't build the report file." };
    }
}

/* ===========================
   COI NOTIFICATIONS (IT / Super Admin only)
   Settings for the employee-facing COI expiration email reminders --
   who gets notified for each of the four phases. The actual daily
   check/send happens server-side (see supabase/functions/send-
   coi-reminders); this is just the recipient-list editor. Recipients are
   plain typed email addresses, not staff accounts, since staff_users has
   no real deliverable email column today (auth_email is a synthetic,
   never-shown address used only for Supabase Auth login -- see
   migrate-staff-to-auth.ts). Table: coi_notification_settings, RLS-gated
   to has_coi_notification_access() (IT or Super Admin) -- see
   sql/supabase-coi-notifications-setup.sql.
=========================== */

const COI_NOTIFICATION_TABLE = "coi_notification_settings";

const COI_NOTIFICATION_PHASES = [
    { key: "60_day", label: "60 Days Before Expiration" },
    { key: "30_day", label: "30 Days Before Expiration" },
    { key: "7_day_daily", label: "Expiring Within 7 Days (sent daily)" },
    { key: "expired_daily", label: "COI Expired (sent daily)" },
];

// phase -> array of email strings, mutated in place while the modal is
// open, only written back to Supabase on Save.
let coiNotificationDraft = {};

// Snapshot of what was actually loaded from Supabase when the modal opened
// (or last saved successfully) -- compared against coiNotificationDraft on
// Save so only the phase(s) someone actually edited get written. Without
// this, Save always upserted all four phase rows every time (even the
// three nobody touched), which -- because coi_notification_settings has an
// "after update of recipient_emails" trigger that emails changed
// recipients -- could fire the added/removed-recipient notice for more
// rows than the person actually changed. Scoping the write to real changes
// only is the fix, not the trigger's own diff logic.
let coiNotificationOriginal = {};

function isEmailLike(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

/* ===========================
   PERMISSIONS (vendors.*, see js/permissions.js + claude/permissions-audit.md)

   2026-09-21: this page used to gate everything beyond viewing the tab at
   all -- add/edit/delete a vendor, manage tags, manage a vendor's contacts,
   save notes, generate reports were all open to anyone who could see the
   page. This wires those up to the real per-workgroup permission table
   instead. Same as every other permission check in the app: fails open
   (returns true) if Permissions hasn't loaded yet or the migration hasn't
   been run, so a half-deployed migration can never lock anyone out.

   These are client-side checks, same caliber as this app's other
   action-level gates (canManageForms(), canManageProject(), etc.) -- they
   are not backed by new Supabase RLS, so this doesn't change what's
   possible via a direct API call, only what the UI lets you do. Only
   vendors.manage_coi_notifications has a real RLS backstop (unchanged by
   this edit -- see the comment on COI_NOTIFICATION_TABLE's policies).
=========================== */
function vendorsCan(permissionKey) {
    return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
}

// Called once on page init (see window.initCompaniesPage below). Hides the
// three toolbar "More Actions" items a workgroup doesn't have, and the COI
// Notifications item (replacing the old hardcoded IT/Super-Admin-only
// check with the real permission, which is seeded to the same IT/Super
// Admin set so behavior is unchanged for everyone today).
async function applyVendorPermissionsToUI() {
    if (window.Permissions) {
        try { await window.Permissions.initPermissions(); } catch { /* hasPermission() fails open regardless */ }
    }

    const addBtn = document.getElementById("addCompanyBtn");
    if (addBtn) addBtn.classList.toggle("hidden", !vendorsCan("vendors.add_edit_vendor"));

    const manageTagsBtn = document.getElementById("manageTagsBtn");
    if (manageTagsBtn) manageTagsBtn.classList.toggle("hidden", !vendorsCan("vendors.manage_tags"));

    const startReportBtn = document.getElementById("startReportBtn");
    if (startReportBtn) startReportBtn.classList.toggle("hidden", !vendorsCan("vendors.generate_reports"));

    const coiBtn = document.getElementById("coiNotificationsBtn");
    if (coiBtn) coiBtn.classList.toggle("hidden", !vendorsCan("vendors.manage_coi_notifications"));
}

function showCoiNotificationsMessage(text, isError) {
    const el = document.getElementById("coiNotificationsMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${isError ? "error" : "success"}`;
    if (!isError && text) window.showToast?.(text); // shared bottom-right popup (js/toast.js)
}

function renderCoiNotificationSections() {
    const container = document.getElementById("coiNotificationPhases");
    if (!container) return;

    container.innerHTML = COI_NOTIFICATION_PHASES.map(({ key, label }) => {
        const emails = coiNotificationDraft[key] || [];
        const chips = emails.length
            ? emails.map((email) => `
                <span class="coi-notif-chip" data-phase="${key}" data-email="${escapeHtmlCompanies(email)}">
                    ${escapeHtmlCompanies(email)}
                    <button type="button" class="coi-notif-chip-remove" data-action="remove-coi-recipient" data-phase="${key}" data-email="${escapeHtmlCompanies(email)}" aria-label="Remove ${escapeHtmlCompanies(email)}">✕</button>
                </span>`).join("")
            : `<span class="coi-notif-chip-empty">No one added yet</span>`;

        return `
            <p class="coi-notif-section-title">${escapeHtmlCompanies(label)}</p>
            <div class="coi-notif-chip-list">${chips}</div>
            <div class="coi-notif-add-row">
                <input type="email" placeholder="Input email" data-phase-input="${key}">
                <button type="button" class="auth-button auth-button--secondary auth-button--sm" data-action="add-coi-recipient" data-phase="${key}">+ Add</button>
            </div>`;
    }).join("");
}

function addCoiNotificationRecipient(phase) {
    const input = document.querySelector(`[data-phase-input="${phase}"]`);
    if (!input) return;
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    if (!isEmailLike(email)) {
        showCoiNotificationsMessage(`"${email}" doesn't look like a valid email address.`, true);
        return;
    }
    const current = coiNotificationDraft[phase] || (coiNotificationDraft[phase] = []);
    if (current.includes(email)) {
        showCoiNotificationsMessage(`${email} is already on this list.`, true);
        return;
    }
    current.push(email);
    input.value = "";
    showCoiNotificationsMessage("", false);
    renderCoiNotificationSections();
}

function removeCoiNotificationRecipient(phase, email) {
    coiNotificationDraft[phase] = (coiNotificationDraft[phase] || []).filter((e) => e !== email);
    renderCoiNotificationSections();
}

async function openCoiNotificationsModal() {
    const overlay = document.getElementById("coiNotificationsModalOverlay");
    if (!overlay) return;

    if (!vendorsCan("vendors.manage_coi_notifications")) {
        // Shouldn't normally be reachable (the button is hidden), but RLS
        // is the real gate -- if someone gets here anyway the Supabase
        // read below will just come back empty/denied.
        return;
    }

    showCoiNotificationsMessage("Loading...", false);
    overlay.classList.remove("hidden");

    const { data, error } = await window.supabaseClient
        .from(COI_NOTIFICATION_TABLE)
        .select("phase, recipient_emails");

    coiNotificationDraft = {};
    coiNotificationOriginal = {};
    for (const { key } of COI_NOTIFICATION_PHASES) {
        coiNotificationDraft[key] = [];
        coiNotificationOriginal[key] = [];
    }
    if (!error && data) {
        for (const row of data) {
            coiNotificationDraft[row.phase] = [...(row.recipient_emails || [])];
            coiNotificationOriginal[row.phase] = [...(row.recipient_emails || [])];
        }
    }

    renderCoiNotificationSections();
    showCoiNotificationsMessage(error ? "Couldn't load current settings -- starting from an empty list." : "", Boolean(error));
}

function closeCoiNotificationsModal() {
    const overlay = document.getElementById("coiNotificationsModalOverlay");
    if (overlay) overlay.classList.add("hidden");
}

// Two arrays are "the same list" for save purposes regardless of the order
// emails were added/removed in -- only membership matters.
function coiRecipientListsMatch(a, b) {
    const left = [...(a || [])].sort();
    const right = [...(b || [])].sort();
    if (left.length !== right.length) return false;
    return left.every((email, i) => email === right[i]);
}

async function saveCoiNotificationSettings() {
    const saveBtn = document.getElementById("saveCoiNotificationsBtn");
    if (saveBtn) saveBtn.disabled = true;
    showCoiNotificationsMessage("Saving...", false);

    // Only write the phase(s) someone actually changed -- see the comment
    // on coiNotificationOriginal above. Re-upserting every phase on every
    // save was harmless for the data itself, but the recipient-change
    // email trigger fires off of "recipient_emails was part of this row's
    // update," so touching rows nobody actually edited risked notifying
    // more people than the one real change warranted.
    const changedPhases = COI_NOTIFICATION_PHASES.filter(
        ({ key }) => !coiRecipientListsMatch(coiNotificationDraft[key], coiNotificationOriginal[key])
    );

    if (changedPhases.length === 0) {
        if (saveBtn) saveBtn.disabled = false;
        showCoiNotificationsMessage("Saved.", false);
        setTimeout(closeCoiNotificationsModal, 700);
        return;
    }

    const staffId = window.currentSupabaseProfile?.id || null;
    const rows = changedPhases.map(({ key }) => ({
        phase: key,
        recipient_emails: coiNotificationDraft[key] || [],
        updated_at: new Date().toISOString(),
        updated_by: staffId,
    }));

    const { error } = await window.supabaseClient
        .from(COI_NOTIFICATION_TABLE)
        .upsert(rows, { onConflict: "phase" });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error("Failed to save COI notification settings:", error);
        showCoiNotificationsMessage("Something went wrong saving these settings. Please try again.", true);
        return;
    }

    // Move the snapshot forward so a second Save in the same modal visit
    // (e.g. add one more email, then Save again) only diffs against what's
    // now actually in the database, not the state from when the modal
    // first opened.
    for (const { key } of changedPhases) {
        coiNotificationOriginal[key] = [...(coiNotificationDraft[key] || [])];
    }

    showCoiNotificationsMessage("Saved.", false);
    setTimeout(closeCoiNotificationsModal, 700);
}

/* ===========================
   INIT
=========================== */

window.initCompaniesPage = async function () {

    await Promise.all([loadVendorTagData(), loadAllContacts()]);
    await loadCompanies();

    // pages/vendor.html's "Edit Vendor" button links back here with
    // ?edit=<id> so the same edit popup (W-9/COI uploads, tags) is used.
    const editId = new URLSearchParams(window.location.search).get("edit");
    if (editId) {
        const company = allCompanies.find(c => String(c.id) === String(editId));
        if (company) {
            try { await window.Permissions?.initPermissions?.(); } catch (e) { /* fail open */ }
            openCompanyModal(company);
        }
    }

    // Close any open W9/COI doc badge dropdown on an outside click, Escape,
    // or the page scrolling/resizing (same pattern as the Manage Tags "?"
    // tour's reposition-on-scroll, and the same reasoning as All Files'
    // per-file "⋯" menu / Form Responses' row menu: a fixed-position
    // dropdown doesn't auto-close on scroll the way an absolutely
    // positioned one effectively would, so it has to be closed by hand).
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".doc-badge")) closeAllDocBadges();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAllDocBadges();
    });
    window.addEventListener("scroll", closeAllDocBadges, true);
    window.addEventListener("resize", closeAllDocBadges);

    // Vendor Profile popup
    const closeVendorProfileBtn = document.getElementById("closeVendorProfileBtn");
    if (closeVendorProfileBtn) closeVendorProfileBtn.addEventListener("click", closeVendorProfileModal);

    const vendorProfileOverlay = document.getElementById("vendorProfileModalOverlay");
    if (vendorProfileOverlay) {
        vendorProfileOverlay.addEventListener("click", (event) => {
            if (event.target === vendorProfileOverlay) closeVendorProfileModal();
        });
    }

    const vendorProfileViewContactsBtn = document.getElementById("vendorProfileViewContactsBtn");
    if (vendorProfileViewContactsBtn) {
        vendorProfileViewContactsBtn.addEventListener("click", () => {
            if (!currentProfileCompany) return;
            const company = currentProfileCompany;
            closeVendorProfileModal();
            openContactsModal(company);
        });
    }

    const vendorProfileEditBtn = document.getElementById("vendorProfileEditBtn");
    if (vendorProfileEditBtn) {
        vendorProfileEditBtn.addEventListener("click", () => {
            if (!currentProfileCompany) return;
            const company = currentProfileCompany;
            closeVendorProfileModal();
            openCompanyModal(company);
        });
    }

    const vendorProfileSaveNotesBtn = document.getElementById("vendorProfileSaveNotesBtn");
    if (vendorProfileSaveNotesBtn) vendorProfileSaveNotesBtn.addEventListener("click", saveVendorNotes);

    const vendorProfileNotesInput = document.getElementById("vendorProfileNotesInput");
    if (vendorProfileNotesInput) {
        // Enter alone saves (matches a chat-style quick-entry box); Shift+Enter
        // still inserts a normal newline for a multi-line note.
        vendorProfileNotesInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                saveVendorNotes();
            }
        });
    }

    // Hide/show the toolbar menu items this workgroup doesn't have --
    // Add Vendor, Manage Tags, Generate A Report, COI Notifications.
    applyVendorPermissionsToUI();

    const coiNotificationsBtn = document.getElementById("coiNotificationsBtn");
    if (coiNotificationsBtn) coiNotificationsBtn.addEventListener("click", openCoiNotificationsModal);

    const cancelCoiNotificationsBtn = document.getElementById("cancelCoiNotificationsBtn");
    if (cancelCoiNotificationsBtn) cancelCoiNotificationsBtn.addEventListener("click", closeCoiNotificationsModal);

    const saveCoiNotificationsBtn = document.getElementById("saveCoiNotificationsBtn");
    if (saveCoiNotificationsBtn) saveCoiNotificationsBtn.addEventListener("click", saveCoiNotificationSettings);

    const coiNotificationsOverlay = document.getElementById("coiNotificationsModalOverlay");
    if (coiNotificationsOverlay) {
        coiNotificationsOverlay.addEventListener("click", (event) => {
            if (event.target === coiNotificationsOverlay) closeCoiNotificationsModal();
        });
        // Delegated so it keeps working as renderCoiNotificationSections()
        // rebuilds the add/remove buttons on every add/remove.
        coiNotificationsOverlay.addEventListener("click", (event) => {
            const addBtn = event.target.closest('[data-action="add-coi-recipient"]');
            if (addBtn) { addCoiNotificationRecipient(addBtn.dataset.phase); return; }
            const removeBtn = event.target.closest('[data-action="remove-coi-recipient"]');
            if (removeBtn) removeCoiNotificationRecipient(removeBtn.dataset.phase, removeBtn.dataset.email);
        });
        coiNotificationsOverlay.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            const input = event.target.closest("[data-phase-input]");
            if (!input) return;
            event.preventDefault();
            addCoiNotificationRecipient(input.dataset.phaseInput);
        });
    }

    // Manage Tags popup
    const manageTagsBtn = document.getElementById("manageTagsBtn");
    if (manageTagsBtn) manageTagsBtn.addEventListener("click", openManageTagsModal);

    const cancelManageTagsBtn = document.getElementById("cancelManageTagsBtn");
    if (cancelManageTagsBtn) cancelManageTagsBtn.addEventListener("click", closeManageTagsModal);

    const manageTagsOverlay = document.getElementById("manageTagsModalOverlay");
    if (manageTagsOverlay) {
        manageTagsOverlay.addEventListener("click", (event) => {
            if (event.target === manageTagsOverlay) closeManageTagsModal();
        });
    }

    // "?" walkthrough button on the Manage Tags modal (see the
    // MANAGE TAGS "?" WALKTHROUGH block above for the actual logic).
    const manageTagsHelpBtn = document.getElementById("manageTagsHelpBtn");
    if (manageTagsHelpBtn) manageTagsHelpBtn.addEventListener("click", openManageTagsTour);

    const manageTagsTourNextBtn = document.getElementById("manageTagsTourNextBtn");
    if (manageTagsTourNextBtn) manageTagsTourNextBtn.addEventListener("click", advanceManageTagsTour);

    const manageTagsTourSkipBtn = document.getElementById("manageTagsTourSkipBtn");
    if (manageTagsTourSkipBtn) manageTagsTourSkipBtn.addEventListener("click", closeManageTagsTour);

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const tourOverlay = document.getElementById("manageTagsTourOverlay");
        if (tourOverlay && !tourOverlay.classList.contains("hidden")) closeManageTagsTour();
    });

    const addTagCategoryBtn = document.getElementById("addTagCategoryBtn");
    if (addTagCategoryBtn) addTagCategoryBtn.addEventListener("click", addTagCategory);

    const newTagCategoryInput = document.getElementById("newTagCategoryInput");
    if (newTagCategoryInput) {
        newTagCategoryInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); addTagCategory(); }
        });
    }

    // Event delegation for everything inside the categories list, since it's
    // fully re-rendered after every add/rename/delete.
    const manageTagsCategories = document.getElementById("manageTagsCategories");
    if (manageTagsCategories) {
        manageTagsCategories.addEventListener("click", (event) => {
            const renameCatBtn = event.target.closest(".tag-admin-rename-cat");
            if (renameCatBtn) { renameTagCategory(renameCatBtn.dataset.id); return; }

            const deleteCatBtn = event.target.closest(".tag-admin-delete-cat");
            if (deleteCatBtn) { deleteTagCategory(deleteCatBtn.dataset.id); return; }

            const renameTagBtn = event.target.closest(".tag-admin-rename-tag");
            if (renameTagBtn) { renameTag(renameTagBtn.dataset.id); return; }

            const deleteTagBtn = event.target.closest(".tag-admin-delete-tag");
            if (deleteTagBtn) { deleteTag(deleteTagBtn.dataset.id); return; }

            const addTagBtn = event.target.closest(".tag-admin-add-tag-btn");
            if (addTagBtn) {
                const categoryId = addTagBtn.dataset.categoryId;
                const input = manageTagsCategories.querySelector(`.tag-admin-new-tag-input[data-category-id="${categoryId}"]`);
                if (input) addTagToCategory(categoryId, input);
                return;
            }
        });

        manageTagsCategories.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            const input = event.target.closest(".tag-admin-new-tag-input");
            if (!input) return;
            event.preventDefault();
            addTagToCategory(input.dataset.categoryId, input);
        });
    }

    const addBtn = document.getElementById("addCompanyBtn");
    if (addBtn) addBtn.addEventListener("click", () => openCompanyModal(null));

    const cancelBtn = document.getElementById("cancelCompanyBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeCompanyModal);

    const overlay = document.getElementById("companyModalOverlay");
    if (overlay) {
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closeCompanyModal();
        });
    }

    const form = document.getElementById("companyForm");
    if (form) form.addEventListener("submit", handleCompanyFormSubmit);

    const coiExemptInput = document.getElementById("companyCoiExemptInput");
    if (coiExemptInput) coiExemptInput.addEventListener("change", updateCoiSectionVisibility);

    const deleteBtn = document.getElementById("deleteCompanyBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", openDeleteConfirm);

    const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteConfirm);

    const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDelete);

    const deleteOverlay = document.getElementById("deleteConfirmOverlay");
    if (deleteOverlay) {
        deleteOverlay.addEventListener("click", (event) => {
            if (event.target === deleteOverlay) closeDeleteConfirm();
        });
    }

    document.getElementById("deleteConfirmNameInput")?.addEventListener("input", updateDeleteConfirmBtnState);
    document.getElementById("deleteConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteConfirmBtnState);

    // Contacts list modal
    const closeContactsBtn = document.getElementById("closeContactsBtn");
    if (closeContactsBtn) closeContactsBtn.addEventListener("click", closeContactsModal);

    const contactsOverlay = document.getElementById("contactsModalOverlay");
    if (contactsOverlay) {
        contactsOverlay.addEventListener("click", (event) => {
            if (event.target === contactsOverlay) closeContactsModal();
        });
    }

    const addContactBtn = document.getElementById("addContactBtn");
    if (addContactBtn) {
        addContactBtn.addEventListener("click", () => {
            const companyId = document.getElementById("contactsModalCompanyId").value;
            const companyName = document.getElementById("contactsModalTitle").dataset.companyName || "";
            openContactFormModal(null, companyId, companyName);
        });
    }

    // Contact add/edit modal
    const cancelContactBtn = document.getElementById("cancelContactBtn");
    if (cancelContactBtn) cancelContactBtn.addEventListener("click", closeContactFormModal);

    const contactFormOverlay = document.getElementById("contactModalOverlay");
    if (contactFormOverlay) {
        contactFormOverlay.addEventListener("click", (event) => {
            if (event.target === contactFormOverlay) closeContactFormModal();
        });
    }

    const contactForm = document.getElementById("contactForm");
    if (contactForm) contactForm.addEventListener("submit", handleContactFormSubmit);

    const deleteContactBtn = document.getElementById("deleteContactBtn");
    if (deleteContactBtn) deleteContactBtn.addEventListener("click", openContactDeleteConfirm);

    hideCompanyMessage();
};