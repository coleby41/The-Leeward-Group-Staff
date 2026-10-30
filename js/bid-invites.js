/* ===========================================================
   BID INVITES (beta) — Vendors page wizard
   More Actions › Generate A Invite Bid

   First page: two cards (same look as Generate A Report) —
           "Start A New Invite Bid" runs the 3 steps below;
           "Continue With An Invite" picks a project, then one of its open
           invites, and goes straight to picking vendors to add to it.
           An invite belongs to a project (one bid_packages row); the
           vendors are just who it's sent to (bid_invites rows).

   Step 1  Bid details: project, package name, trade tag, scope, dates,
           contact person (who vendors' questions go to), plans & specs (picked
           from the project's files or uploaded — uploads are saved to the
           project in 05 Contracts & Procurement › Bids).
   Step 2  Pick vendors: the trade tag pre-selects matching vendors. Only
           Approved vendors (same rule as the vendor cards' Status chip,
           missingVendorRequirements() in companies.js) with a contact
           email can be picked.
   Step 3  Review & send: the real email (rendered by the bid-invites Edge
           Function), reminder settings, Send.

   Saving: bid_packages + bid_package_files + bid_invites rows (see
   sql/supabase-bid-invites-setup.sql), then the bid-invites Edge
   Function emails each vendor. Responses, logged bids and awarding live
   on the project's Bid Invites tab (pages/project-bid-invites.html).

   Opens automatically with ?invite=1&project=<id> (the "+ New Invite"
   button on a project's Bid Invites tab links here that way).

   Uses companies.js's already-loaded vendor data (allCompanies, tags,
   contacts) and its approval rule, so it always agrees with the cards.
=========================================================== */
(function () {
    "use strict";

    const SEND_PERMISSION = "vendors.send_bid_invites";
    const BIDS_CATEGORY = "contracts_procurement";
    const BIDS_SUBFOLDER = "bids";
    const CONTACT_STORAGE_KEY = "bidInviteContact";
    const STEP_LABELS = { 1: "Bid details", 2: "Pick vendors", 3: "Review & send" };
    const CONTINUE_LABELS = { 2: "Add vendors", 3: "Review & send" };
    const START_COPY = "Here you can start a new invite bid for a project or continue with an invite you've already sent.";
    const PICK_COPY = "Pick the project, then the invite you want to add vendors to. Vendors already invited stay as they are.";

    const $ = id => document.getElementById(id);

    let step = 1;
    let projects = [];
    let projectFiles = [];          // this project's project_files rows (for the picker)
    let chosenFiles = [];           // [{ kind: "project", file }, { kind: "upload", file: File, key }]
    let tagFilters = [];            // vendor_tags ids
    let selected = new Map();       // company id (string) -> contact id (string)
    let autoSelectedForTag = null;  // so going back/forward doesn't re-tick vendors you un-ticked
    let sending = false;
    let doneProjectId = null;
    let mode = "new";               // "new" or "continue" (adding vendors to an existing invite)
    let existingPkg = null;         // the bid_packages row being continued
    let alreadyInvited = new Set(); // company ids (string) already on existingPkg
    let allPackages = [];           // bid_packages rows for the Continue list
    let packageInviteCounts = {};   // package id -> vendors invited

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

    function can(permission) {
        return window.Permissions ? window.Permissions.hasPermission(permission) : true;
    }

    function setMessage(text, type) {
        const el = $("bidInviteMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    function vendors() { return (typeof allCompanies !== "undefined" && Array.isArray(allCompanies)) ? allCompanies : []; }
    function tags() { return (typeof allTags !== "undefined" && Array.isArray(allTags)) ? allTags : []; }
    function categories() { return (typeof allTagCategories !== "undefined" && Array.isArray(allTagCategories)) ? allTagCategories : []; }
    function vendorTags(companyId) { return typeof tagsForCompany === "function" ? tagsForCompany(companyId) : []; }
    function vendorContacts(companyId) { return typeof contactsForCompany === "function" ? contactsForCompany(companyId) : []; }
    function vendorMissing(company) { return typeof missingVendorRequirements === "function" ? missingVendorRequirements(company) : []; }

    function emailContacts(companyId) {
        return vendorContacts(companyId).filter(c => isEmail(c.Email));
    }

    function isEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
    }

    function projectSiteAddress(project) {
        if (!project) return "";
        const cityState = [project.site_city, project.site_state].filter(Boolean).join(", ");
        return [project.site_address, cityState, project.site_zip].filter(Boolean).join(" ").trim();
    }

    // "2026-10-30" + "14:00" in the browser's time zone → ISO string.
    function toIso(dateStr, timeStr) {
        if (!dateStr) return null;
        const d = new Date(`${dateStr}T${timeStr || "00:00"}`);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    function localToIso(value) {
        if (!value) return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    // Calls the bid-invites Edge Function and always comes back with
    // { data } or { error: "readable message" }.
    async function callBidFunction(body) {
        try {
            const { data, error } = await client().functions.invoke("bid-invites", { body });
            if (error) {
                let message = error.message || "The bid service didn't respond.";
                try {
                    const payload = error.context && typeof error.context.json === "function" ? await error.context.json() : null;
                    if (payload && payload.error) message = payload.error;
                } catch (e) { /* keep the generic message */ }
                return { error: message };
            }
            if (data && data.ok === false) return { error: data.error || "Something went wrong." };
            return { data };
        } catch (err) {
            return { error: err && err.message ? err.message : "The bid service didn't respond." };
        }
    }

    /* ---------- open / close ---------- */

    function resetForm() {
        step = 1;
        chosenFiles = [];
        tagFilters = [];
        selected = new Map();
        autoSelectedForTag = null;
        sending = false;
        doneProjectId = null;
        projectFiles = [];
        mode = "new";
        existingPkg = null;
        alreadyInvited = new Set();

        $("bidInviteForm").reset();
        $("bidDueTime").value = "14:00";
        $("bidWalkthroughLocation").value = "Project site";
        $("bidWalkthroughFields").classList.add("hidden");
        $("bidFilePicker").classList.add("hidden");
        $("bidVendorSearch").value = "";
        $("bidRemindNoResponse").checked = true;
        $("bidRemindBeforeDue").checked = true;

        // Contact person: whoever sent the last invite from this browser, else you.
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(CONTACT_STORAGE_KEY) || "null"); } catch (e) { saved = null; }
        $("bidContactName").value = (saved && saved.name) || staffName();
        $("bidContactEmail").value = (saved && saved.email) || "";
        $("bidContactPhone").value = (saved && saved.phone) || "";

        setMessage("");
        renderFiles();
    }

    async function openWizard(preselectProjectId) {
        if (!can(SEND_PERMISSION)) return;
        resetForm();
        $("bidInviteOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        // The project tab's "+ New Invite" link skips the first page.
        showStep(preselectProjectId ? 1 : "start");

        await Promise.all([loadProjects(), ensureVendorData()]);
        populateTradeTags();
        if (preselectProjectId && projects.some(p => String(p.id) === String(preselectProjectId))) {
            $("bidProjectSelect").value = String(preselectProjectId);
            onProjectChange();
        }
    }

    /* ---------- first page + Continue With An Invite ---------- */

    function startNew() {
        resetForm();
        populateTradeTags();
        showStep(1);
    }

    function fmtDue(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + ", " +
            d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }

    // ISO -> values for <input type="date">, "time" and "datetime-local" (local time).
    function isoToLocalParts(iso) {
        if (!iso) return { date: "", time: "", local: "" };
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return { date, time, local: `${date}T${time}` };
    }

    async function startContinue() {
        resetForm();
        populateTradeTags();
        mode = "continue";
        showStep("pick");
        const select = $("bidContinueProjectSelect");
        const list = $("bidContinueList");
        select.innerHTML = `<option value="">Loading…</option>`;
        list.innerHTML = "";

        const { data, error } = await client()
            .from("bid_packages")
            .select("id, project_id, name, status, due_at, created_at")
            .order("created_at", { ascending: false });
        if (error) {
            console.error("bid-invites: couldn't load invites", error);
            select.innerHTML = `<option value="">Couldn't load invites</option>`;
            return;
        }
        allPackages = data || [];
        packageInviteCounts = {};
        if (allPackages.length) {
            const { data: inv } = await client().from("bid_invites").select("package_id").in("package_id", allPackages.map(p => p.id));
            (inv || []).forEach(r => { packageInviteCounts[r.package_id] = (packageInviteCounts[r.package_id] || 0) + 1; });
        }
        if (!projects.length) await loadProjects();

        // Only projects that have an invite.
        const withInvites = projects.filter(p => allPackages.some(pkg => String(pkg.project_id) === String(p.id)));
        if (!withInvites.length) {
            select.innerHTML = `<option value="">No invites yet</option>`;
            list.innerHTML = `<div class="empty-state">No invites have been sent yet. Go back and choose <strong>Start A New Invite Bid</strong>.</div>`;
            return;
        }
        select.innerHTML = `<option value="">Choose a project</option>` + withInvites.map(p => {
            const n = allPackages.filter(pkg => String(pkg.project_id) === String(p.id)).length;
            return `<option value="${esc(p.id)}">${esc(p.name || "Untitled project")}${p.project_code ? ` (${esc(p.project_code)})` : ""} · ${n} invite${n === 1 ? "" : "s"}</option>`;
        }).join("");
        if (withInvites.length === 1) select.value = String(withInvites[0].id);
        renderContinueList();
    }

    function packageBlocker(pkg) {
        if (pkg.status === "awarded") return "Awarded";
        if (pkg.status === "closed") return "Closed";
        if (pkg.due_at && new Date(pkg.due_at).getTime() <= Date.now()) return "Bids already due";
        return "";
    }

    function renderContinueList() {
        const projectId = $("bidContinueProjectSelect").value;
        const list = $("bidContinueList");
        if (!projectId) { list.innerHTML = ""; return; }
        const pkgs = allPackages.filter(p => String(p.project_id) === String(projectId));
        list.innerHTML = pkgs.map(pkg => {
            const blocked = packageBlocker(pkg);
            const n = packageInviteCounts[pkg.id] || 0;
            return `
            <div class="bid-continue-item${blocked ? " is-disabled" : ""}">
                <div class="bid-continue-item-text">
                    <strong>${esc(pkg.name)}</strong>
                    <span class="bid-cell-sub">Bids due ${esc(fmtDue(pkg.due_at))} · ${n} vendor${n === 1 ? "" : "s"} invited</span>
                </div>
                ${blocked
                    ? `<span class="chip chip--muted">${esc(blocked)}</span>`
                    : `<button type="button" class="auth-button auth-button--secondary" data-continue-pkg="${esc(pkg.id)}">Add Vendors</button>`}
            </div>`;
        }).join("");
    }

    async function choosePackage(packageId) {
        setMessage("Loading the invite…", "");
        const [pkgRes, filesRes, invRes] = await Promise.all([
            client().from("bid_packages").select("*").eq("id", packageId).single(),
            client().from("bid_package_files").select("sort_order, project_files(id, file_name)").eq("package_id", packageId).order("sort_order", { ascending: true }),
            client().from("bid_invites").select("company_id").eq("package_id", packageId),
        ]);
        if (pkgRes.error || !pkgRes.data) {
            setMessage(`Couldn't load the invite: ${pkgRes.error ? pkgRes.error.message : "not found"}.`, "error");
            return;
        }
        const pkg = pkgRes.data;
        const blocked = packageBlocker(pkg);
        if (blocked) { setMessage(`This invite can't take more vendors (${blocked.toLowerCase()}).`, "error"); return; }

        existingPkg = pkg;
        alreadyInvited = new Set((invRes.data || []).map(r => String(r.company_id)).filter(id => id && id !== "null"));
        chosenFiles = (filesRes.data || []).filter(r => r.project_files).map(r => ({ kind: "project", file: r.project_files }));

        // Fill the (hidden) step 1 fields from the invite so the email
        // preview and draft() read exactly what was sent before.
        $("bidProjectSelect").value = String(pkg.project_id);
        $("bidPackageName").value = pkg.name || "";
        $("bidTradeTag").value = pkg.trade_tag_id ? String(pkg.trade_tag_id) : "";
        $("bidScope").value = pkg.scope || "";
        $("bidLocation").value = pkg.location || "";
        const due = isoToLocalParts(pkg.due_at);
        $("bidDueDate").value = due.date;
        $("bidDueTime").value = due.time;
        $("bidQuestionsDue").value = isoToLocalParts(pkg.questions_due_at).local;
        $("bidWalkthroughToggle").checked = !!pkg.walkthrough_at;
        $("bidWalkthroughFields").classList.toggle("hidden", !pkg.walkthrough_at);
        $("bidWalkthroughAt").value = isoToLocalParts(pkg.walkthrough_at).local;
        $("bidWalkthroughLocation").value = pkg.walkthrough_location || "Project site";
        $("bidContactName").value = pkg.contact_name || "";
        $("bidContactEmail").value = pkg.contact_email || "";
        $("bidContactPhone").value = pkg.contact_phone || "";
        $("bidRemindNoResponse").checked = pkg.remind_no_response !== false;
        $("bidRemindBeforeDue").checked = pkg.remind_before_due !== false;
        renderFiles();

        showStep(2);
        enterVendorStep();
    }

    function closeWizard() {
        if (sending) return;
        $("bidInviteOverlay").classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    async function ensureVendorData() {
        // companies.js loads these on page start; if the wizard is opened
        // before that finished, wait for it rather than loading twice.
        for (let i = 0; i < 50 && (!vendors().length || !categories().length); i++) {
            await new Promise(r => setTimeout(r, 120));
        }
    }

    async function loadProjects() {
        const select = $("bidProjectSelect");
        // Read the projects table itself (like the Incident Report form does):
        // the projects_overview view doesn't include project_code.
        const query = cols => client().from("projects").select(cols).order("name", { ascending: true });
        let { data, error } = await query("id, name, project_code, site_address, site_city, site_state, site_zip, is_active");
        if (error && error.code === "42703") {
            // Older database without project_code — still list the projects.
            ({ data, error } = await query("id, name, site_address, site_city, site_state, site_zip, is_active"));
        }
        if (error) {
            console.error("bid-invites: couldn't load projects", error);
            select.innerHTML = `<option value="">Couldn't load projects</option>`;
            return;
        }
        projects = (data || []).filter(p => p.is_active !== false);
        select.innerHTML = `<option value="">Choose a project</option>` + projects.map(p =>
            `<option value="${esc(p.id)}">${esc(p.name || "Untitled project")}${p.project_code ? ` (${esc(p.project_code)})` : ""}</option>`
        ).join("");
    }

    function populateTradeTags() {
        const select = $("bidTradeTag");
        const groups = categories().map(cat => {
            const inCat = tags().filter(t => String(t.category_id) === String(cat.id));
            if (!inCat.length) return "";
            return `<optgroup label="${esc(cat.name)}">${inCat.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>`;
        }).join("");
        select.innerHTML = `<option value="">None</option>${groups}`;
    }

    function currentProject() {
        const id = $("bidProjectSelect").value;
        return projects.find(p => String(p.id) === String(id)) || null;
    }

    async function onProjectChange() {
        const project = currentProject();
        // Files picked from the previous project don't belong to this one.
        chosenFiles = chosenFiles.filter(f => f.kind === "upload");
        renderFiles();
        $("bidFilePicker").classList.add("hidden");
        projectFiles = [];
        if (!project) return;
        if (!$("bidLocation").value.trim() || $("bidLocation").dataset.auto === "1") {
            $("bidLocation").value = projectSiteAddress(project);
            $("bidLocation").dataset.auto = "1";
        }
        const { data, error } = await client()
            .from("project_files")
            .select("id, file_name, category, subfolder, sub_subfolder, bucket, storage_path, created_at")
            .eq("project_id", project.id)
            .order("created_at", { ascending: false });
        if (error) { console.error("bid-invites: couldn't load project files", error); return; }
        if (String($("bidProjectSelect").value) === String(project.id)) projectFiles = data || [];
        renderFilePicker();
    }

    /* ---------- step 1: files ---------- */

    function folderLabel(file) {
        const PF = window.ProjectFields;
        if (!PF || !PF.fileCategoryLabel) return file.category;
        return `${PF.fileCategoryLabel(file.category)} › ${PF.fileSubfolderLabel(file.category, file.subfolder)}`;
    }

    function renderFiles() {
        const list = $("bidFileList");
        if (!chosenFiles.length) {
            list.innerHTML = `<p class="bid-file-empty">No plans or specs attached yet (optional).</p>`;
            return;
        }
        list.innerHTML = chosenFiles.map((f, i) => `
            <div class="bid-file-row">
                <span class="bid-file-row-name" title="${esc(fileName(f))}">${esc(fileName(f))}</span>
                <span class="bid-file-row-source">${f.kind === "upload" ? "Uploading on send" : esc(folderLabel(f.file))}</span>
                <button type="button" class="bid-file-row-remove" data-remove-file="${i}" aria-label="Remove ${esc(fileName(f))}">✕</button>
            </div>`).join("");
    }

    function fileName(f) { return f.kind === "upload" ? f.file.name : f.file.file_name; }

    function renderFilePicker() {
        const listEl = $("bidFilePickerList");
        if (!listEl) return;
        if (!currentProject()) {
            listEl.innerHTML = `<p class="bid-file-empty">Choose a project first.</p>`;
            return;
        }
        const q = $("bidFilePickerSearch").value.trim().toLowerCase();
        const chosenIds = new Set(chosenFiles.filter(f => f.kind === "project").map(f => String(f.file.id)));
        const shown = projectFiles.filter(f => !q || `${f.file_name} ${folderLabel(f)}`.toLowerCase().includes(q));
        if (!shown.length) {
            listEl.innerHTML = `<p class="bid-file-empty">${projectFiles.length ? "No files match." : "This project doesn't have any files yet — use Upload file."}</p>`;
            return;
        }
        listEl.innerHTML = shown.slice(0, 200).map(f => `
            <label class="bid-file-picker-item">
                <input type="checkbox" data-pick-file="${esc(f.id)}" ${chosenIds.has(String(f.id)) ? "checked" : ""}>
                <span>${esc(f.file_name)}</span>
                <small>${esc(folderLabel(f))}</small>
            </label>`).join("");
    }

    /* ---------- step 2: vendors ---------- */

    function tagName(tagId) {
        const tag = tags().find(t => String(t.id) === String(tagId));
        return tag ? tag.name : "Tag";
    }

    function renderTagFilters() {
        $("bidTagChips").innerHTML = tagFilters.map(id =>
            `<button type="button" class="chip chip--tag bid-filter-chip" data-remove-tag="${esc(id)}" aria-label="Remove tag filter ${esc(tagName(id))}">${esc(tagName(id))} ✕</button>`
        ).join("");
        const available = tags().filter(t => !tagFilters.includes(String(t.id)));
        const groups = categories().map(cat => {
            const inCat = available.filter(t => String(t.category_id) === String(cat.id));
            return inCat.length ? `<optgroup label="${esc(cat.name)}">${inCat.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>` : "";
        }).join("");
        $("bidAddTagSelect").innerHTML = `<option value="">+ Filter by tag</option>${groups}`;
    }

    // Approved + has an email contact = can be invited.
    function vendorState(company) {
        if (alreadyInvited.has(String(company.id))) return { ok: false, invited: true, label: "Already invited", detail: "" };
        const missing = vendorMissing(company);
        if (missing.length) return { ok: false, label: "Not Approved", detail: `Missing: ${missing.join(", ")}` };
        if (!emailContacts(company.id).length) return { ok: false, label: "No email", detail: "Add a contact with an email on the vendor's card" };
        return { ok: true, label: "Approved", detail: "" };
    }

    function shownVendors() {
        const q = $("bidVendorSearch").value.trim().toLowerCase();
        return vendors().filter(company => {
            const id = String(company.id);
            if (selected.has(id)) return true; // never hide something that's ticked
            const companyTagIds = vendorTags(company.id).map(t => String(t.id));
            const tagOk = !tagFilters.length || tagFilters.some(t => companyTagIds.includes(t));
            if (q) {
                const hay = [company.Name, ...vendorTags(company.id).map(t => t.name), ...vendorContacts(company.id).map(c => `${c.Name || ""} ${c.Email || ""}`)].join(" ").toLowerCase();
                // A search looks across every vendor, not just the tag filter.
                return hay.includes(q);
            }
            return tagOk;
        }).sort((a, b) => {
            const sa = selected.has(String(a.id)) ? 0 : 1, sb = selected.has(String(b.id)) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            const oa = vendorState(a).ok ? 0 : 1, ob = vendorState(b).ok ? 0 : 1;
            if (oa !== ob) return oa - ob;
            return String(a.Name || "").localeCompare(String(b.Name || ""));
        });
    }

    function renderVendors() {
        const rows = shownVendors();
        const body = $("bidVendorTableBody");
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="4"><div class="empty-state">${tagFilters.length || $("bidVendorSearch").value.trim() ? "No vendors match. Try another tag or search." : "No vendors yet."}</div></td></tr>`;
        } else {
            body.innerHTML = rows.map(company => {
                const id = String(company.id);
                const state = vendorState(company);
                const contacts = emailContacts(company.id);
                const chosenContact = selected.get(id) || (contacts[0] ? String(contacts[0].id) : "");
                const tagNames = vendorTags(company.id).map(t => t.name).slice(0, 3).join(", ");
                return `
                <tr class="${state.ok ? "" : "is-disabled"}">
                    <td><input type="checkbox" data-vendor="${esc(id)}" ${selected.has(id) ? "checked" : ""} ${state.ok ? "" : "disabled"} aria-label="Invite ${esc(company.Name)}"></td>
                    <td><strong>${esc(company.Name || "Unnamed vendor")}</strong>${tagNames ? `<span class="bid-cell-sub">${esc(tagNames)}</span>` : ""}</td>
                    <td>${contacts.length
                        ? `<select data-vendor-contact="${esc(id)}" aria-label="Who at ${esc(company.Name)} gets the email" ${state.ok ? "" : "disabled"}>
                               ${contacts.map(c => `<option value="${esc(c.id)}" ${String(c.id) === chosenContact ? "selected" : ""}>${esc(c.Name || "Contact")} · ${esc(c.Email)}</option>`).join("")}
                           </select>`
                        : `<span class="bid-cell-sub">No contact email</span>`}</td>
                    <td><span class="chip ${state.ok ? "chip--success" : state.invited ? "chip--muted" : "chip--danger"}" title="${esc(state.detail)}">${esc(state.label)}</span>${state.ok || state.invited ? "" : `<span class="bid-cell-sub">${esc(state.detail)}</span>`}</td>
                </tr>`;
            }).join("");
        }

        const invitable = rows.filter(c => vendorState(c).ok);
        const all = $("bidSelectAll");
        all.disabled = !invitable.length;
        all.checked = invitable.length > 0 && invitable.every(c => selected.has(String(c.id)));

        const notOk = rows.filter(c => { const st = vendorState(c); return !st.ok && !st.invited; }).length;
        $("bidVendorHint").textContent = notOk
            ? `${notOk} vendor${notOk === 1 ? "" : "s"} shown can't be invited until they're Approved and have a contact email.`
            : "";
        updateSelectedCount();
    }

    function updateSelectedCount() {
        const el = $("bidSelectedCount");
        el.textContent = `${selected.size} vendor${selected.size === 1 ? "" : "s"} selected`;
        el.classList.toggle("hidden", step !== 2 && step !== 3);
        if (step === 3) $("bidInviteNextBtn").textContent = `Send ${selected.size} Invite${selected.size === 1 ? "" : "s"}`;
    }

    function enterVendorStep() {
        const trade = $("bidTradeTag").value;
        // First time here with this trade tag: filter by it and tick every
        // vendor that can be invited.
        if (autoSelectedForTag !== trade) {
            autoSelectedForTag = trade;
            if (trade) {
                tagFilters = [String(trade)];
                if (mode === "continue") { renderTagFilters(); renderVendors(); return; }
                vendors().forEach(company => {
                    const hasTag = vendorTags(company.id).some(t => String(t.id) === String(trade));
                    if (hasTag && vendorState(company).ok && !selected.has(String(company.id))) {
                        selected.set(String(company.id), String(emailContacts(company.id)[0].id));
                    }
                });
            }
        }
        renderTagFilters();
        renderVendors();
    }

    /* ---------- step 3: review ---------- */

    function draft() {
        const project = currentProject();
        return {
            project_id: project ? project.id : null,
            name: $("bidPackageName").value.trim(),
            scope: $("bidScope").value.trim() || null,
            location: $("bidLocation").value.trim() || null,
            due_at: toIso($("bidDueDate").value, $("bidDueTime").value),
            walkthrough_at: $("bidWalkthroughToggle").checked ? localToIso($("bidWalkthroughAt").value) : null,
            walkthrough_location: $("bidWalkthroughToggle").checked ? ($("bidWalkthroughLocation").value.trim() || null) : null,
            questions_due_at: localToIso($("bidQuestionsDue").value),
            contact_name: $("bidContactName").value.trim(),
            contact_email: $("bidContactEmail").value.trim(),
            contact_phone: $("bidContactPhone").value.trim() || null,
        };
    }

    function selectedInvites() {
        return Array.from(selected.entries()).map(([companyId, contactId]) => {
            const company = vendors().find(c => String(c.id) === companyId);
            const contact = vendorContacts(companyId).find(c => String(c.id) === String(contactId)) || emailContacts(companyId)[0];
            return company && contact ? { company, contact } : null;
        }).filter(Boolean).sort((a, b) => String(a.company.Name).localeCompare(String(b.company.Name)));
    }

    async function enterReviewStep() {
        const d = draft();
        const invites = selectedInvites();
        $("bidSendingList").innerHTML = invites.map(i =>
            `<li><strong>${esc(i.company.Name)}</strong><span class="bid-cell-sub">${esc(i.contact.Name || "")} · ${esc(i.contact.Email)}</span></li>`
        ).join("");
        $("bidPreviewReplyTo").textContent = `${d.contact_name} <${d.contact_email}>`;
        const project = currentProject();
        $("bidPreviewSubject").textContent = `Invitation to Bid – ${project ? project.name : ""} – ${d.name}`;

        const frame = $("bidEmailPreviewFrame");
        const fallback = $("bidEmailPreviewFallback");
        frame.classList.remove("hidden");
        fallback.classList.add("hidden");
        frame.srcdoc = `<p style="font-family:Arial,sans-serif;color:#5f6e7d;padding:20px;">Loading preview…</p>`;

        const first = invites[0];
        const { data, error } = await callBidFunction({
            action: "preview",
            draft: {
                ...d,
                file_names: chosenFiles.map(fileName),
                sample_company_name: first ? first.company.Name : "Vendor Name",
                sample_contact_name: first ? first.contact.Name : null,
            },
        });
        if (step !== 3) return;
        if (error) {
            frame.classList.add("hidden");
            fallback.classList.remove("hidden");
            fallback.textContent = `Couldn't load the email preview (${error}). You can still send — or check that the bid-invites function is deployed.`;
            return;
        }
        if (data.subject) $("bidPreviewSubject").textContent = data.subject;
        frame.srcdoc = data.html;
    }

    /* ---------- validation + navigation ---------- */

    function validateStep1() {
        const d = draft();
        if (!d.project_id) return "Choose a project.";
        if (!d.name) return "Give the bid package a name (e.g. Windows & Glazing).";
        if (!$("bidDueDate").value || !$("bidDueTime").value || !d.due_at) return "Set when bids are due.";
        if (new Date(d.due_at).getTime() <= Date.now()) return "The bid due date has to be in the future.";
        if ($("bidWalkthroughToggle").checked && !d.walkthrough_at) return "Set the walkthrough date and time, or turn the walkthrough off.";
        if (d.walkthrough_at && new Date(d.walkthrough_at) > new Date(d.due_at)) return "The walkthrough is after bids are due.";
        if (d.questions_due_at && new Date(d.questions_due_at) > new Date(d.due_at)) return "Questions are due after bids are due.";
        if (!d.contact_name) return "Add the contact person's name.";
        if (!isEmail(d.contact_email)) return "Add a valid email for the contact person — vendors' questions go to it.";
        return "";
    }

    function showStep(next) {
        step = next;
        document.querySelectorAll("#bidInviteForm [data-bid-step]").forEach(section => {
            section.hidden = String(section.dataset.bidStep) !== String(next);
        });
        const isMenu = next === "start" || next === "pick";
        const cont = mode === "continue";
        const dots = document.querySelectorAll("#bidInviteProgress .wizard-progress-dot");
        $("bidInviteProgress").classList.toggle("hidden", isMenu);
        // Continuing skips bid details, so it's a 2-step flow.
        if (dots[0]) dots[0].style.display = cont ? "none" : "";
        const n = next === "done" ? 4 : next;
        dots.forEach((dot, i) => {
            dot.classList.toggle("is-complete", i + 1 < n);
            dot.classList.toggle("is-current", i + 1 === n);
        });
        $("bidInviteStepLabel").textContent =
            next === "start" ? START_COPY
            : next === "pick" ? PICK_COPY
            : next === "done" ? "Sent"
            : cont ? `Step ${next - 1} of 2 · ${CONTINUE_LABELS[next]}`
            : `Step ${next} of 3 · ${STEP_LABELS[next]}`;
        $("bidVendorStepNumber").textContent = cont ? "1" : "2";
        $("bidReviewStepNumber").textContent = cont ? "2" : "3";
        $("bidVendorStepTitle").textContent = cont && existingPkg ? `Add vendors to ${existingPkg.name}` : "Pick vendors";
        $("bidInviteBackBtn").style.display = next === "pick" || next === 1 || next === 2 || next === 3 ? "" : "none";
        $("bidInviteCancelBtn").style.display = next === "done" ? "none" : "";
        $("bidOpenTrackerBtn").classList.toggle("hidden", next !== "done");
        const nextBtn = $("bidInviteNextBtn");
        nextBtn.classList.toggle("hidden", isMenu);
        nextBtn.disabled = false;
        nextBtn.textContent = next === "done" ? "Close" : next === 3 ? "Send" : "Next";
        setMessage("");
        updateSelectedCount();
        const popup = document.querySelector("#bidInviteOverlay .popup");
        if (popup) popup.scrollTop = 0;
    }

    async function onNext() {
        if (sending) return;
        if (step === "done") { closeWizard(); return; }
        if (step === 1) {
            const problem = validateStep1();
            if (problem) { setMessage(problem, "error"); return; }
            showStep(2);
            enterVendorStep();
            return;
        }
        if (step === 2) {
            if (!selected.size) { setMessage("Pick at least one vendor to invite.", "error"); return; }
            showStep(3);
            enterReviewStep();
            return;
        }
        if (step === 3) await send();
    }

    function onBack() {
        if (sending) return;
        if (step === "pick" || step === 1) { resetForm(); showStep("start"); }
        else if (step === 2 && mode === "continue") { existingPkg = null; alreadyInvited = new Set(); showStep("pick"); renderContinueList(); }
        else if (step === 2) showStep(1);
        else if (step === 3) { showStep(2); renderTagFilters(); renderVendors(); }
    }

    /* ---------- send ---------- */

    async function uploadNewFiles(project) {
        const uploads = chosenFiles.filter(f => f.kind === "upload");
        const created = []; // { projectFileId, path }
        for (const f of uploads) {
            const path = await window.ProjectFields.uploadFile(project.id, f.file, null, { pathSegments: [BIDS_CATEGORY, BIDS_SUBFOLDER] });
            const { data, error } = await client().from("project_files").insert({
                project_id: project.id,
                category: BIDS_CATEGORY,
                subfolder: BIDS_SUBFOLDER,
                sub_subfolder: null,
                bucket: "project-documents",
                storage_path: path,
                file_name: f.file.name,
                source: "bid",
                uploaded_by_name: staffName(),
            }).select("id").single();
            if (error) {
                client().storage.from("project-documents").remove([path]).catch(() => {});
                throw error;
            }
            created.push({ projectFileId: data.id, path });
        }
        return created;
    }

    async function cleanup(packageId, uploaded) {
        if (packageId) await client().from("bid_packages").delete().eq("id", packageId).then(() => {}, () => {});
        if (uploaded.length) {
            await client().from("project_files").delete().in("id", uploaded.map(u => u.projectFileId)).then(() => {}, () => {});
            await client().storage.from("project-documents").remove(uploaded.map(u => u.path)).catch(() => {});
        }
    }

    async function sendMore() {
        const invites = selectedInvites().filter(i => !alreadyInvited.has(String(i.company.id)));
        if (!invites.length) { showStep(2); enterVendorStep(); setMessage("Pick at least one vendor to add.", "error"); return; }
        if (packageBlocker(existingPkg)) { setMessage("Bids for this invite are already due, so no more vendors can be added.", "error"); return; }

        const pkg = existingPkg;
        const nextBtn = $("bidInviteNextBtn");
        sending = true;
        nextBtn.disabled = true;
        nextBtn.textContent = "Sending…";
        setMessage("Adding vendors to the invite…", "");

        const remind = { remind_no_response: $("bidRemindNoResponse").checked, remind_before_due: $("bidRemindBeforeDue").checked };
        if (remind.remind_no_response !== (pkg.remind_no_response !== false) || remind.remind_before_due !== (pkg.remind_before_due !== false)) {
            await client().from("bid_packages").update(remind).eq("id", pkg.id).then(() => {}, () => {});
        }

        const { error: invitesError } = await client().from("bid_invites").insert(invites.map(i => ({
            package_id: pkg.id,
            company_id: i.company.id,
            company_name: String(i.company.Name || "").trim() || "Vendor",
            contact_name: i.contact.Name || null,
            contact_email: String(i.contact.Email).trim(),
        })));
        if (invitesError) {
            console.error("bid-invites: adding vendors failed", invitesError);
            sending = false;
            nextBtn.disabled = false;
            updateSelectedCount();
            setMessage(`Couldn't add the vendors: ${invitesError.message || invitesError}. Nothing was sent.`, "error");
            return;
        }

        setMessage(`Emailing ${invites.length} vendor${invites.length === 1 ? "" : "s"}…`, "");
        // "send" only emails this invite's pending/failed vendors, so the
        // ones already sent don't get it twice.
        const { data, error } = await callBidFunction({ action: "send", package_id: pkg.id });
        sending = false;
        finishSend(pkg.project_id, pkg.name, data, error);
    }

    function finishSend(projectId, packageName, data, error) {
        doneProjectId = projectId;
        $("bidOpenTrackerBtn").href = `/pages/project-bid-invites.html?id=${encodeURIComponent(projectId)}`;
        const summary = $("bidDoneSummary");
        const failuresEl = $("bidDoneFailures");
        failuresEl.innerHTML = "";
        showStep("done");

        if (error) {
            summary.classList.add("is-warning");
            summary.textContent = `The invite was saved, but the emails didn't go out: ${error}. Use "Retry" on the project's Bid Invites tab once that's fixed.`;
            return;
        }
        const failed = data.failed || [];
        summary.classList.toggle("is-warning", failed.length > 0);
        summary.textContent = failed.length
            ? `Sent to ${data.sent} of ${data.sent + failed.length} vendors. These didn't go out — fix the email and retry from the Bid Invites tab:`
            : `Invitation to Bid sent to ${data.sent} vendor${data.sent === 1 ? "" : "s"} for ${packageName}.`;
        failuresEl.innerHTML = failed.map(f => `<li><strong>${esc(f.company_name)}</strong> — ${esc(f.error)}</li>`).join("");
        if (!failed.length && typeof window.showToast === "function") window.showToast("Bid invites sent");
    }

    async function send() {
        if (mode === "continue") { await sendMore(); return; }
        const problem = validateStep1();
        if (problem) { showStep(1); setMessage(problem, "error"); return; }
        const invites = selectedInvites();
        if (!invites.length) { showStep(2); enterVendorStep(); setMessage("Pick at least one vendor to invite.", "error"); return; }

        const project = currentProject();
        const d = draft();
        const nextBtn = $("bidInviteNextBtn");
        sending = true;
        nextBtn.disabled = true;
        nextBtn.textContent = "Sending…";
        setMessage("Saving the invite…", "");

        let packageId = null;
        let uploaded = [];
        try {
            uploaded = await uploadNewFiles(project);

            const tradeTagId = $("bidTradeTag").value || null;
            const { data: pkg, error: pkgError } = await client().from("bid_packages").insert({
                ...d,
                trade_tag_id: tradeTagId,
                trade_tag_name: tradeTagId ? tagName(tradeTagId) : null,
                remind_no_response: $("bidRemindNoResponse").checked,
                remind_before_due: $("bidRemindBeforeDue").checked,
                    created_by_name: staffName(),
            }).select("id").single();
            if (pkgError) throw pkgError;
            packageId = pkg.id;

            const fileIds = [
                ...chosenFiles.filter(f => f.kind === "project").map(f => f.file.id),
                ...uploaded.map(u => u.projectFileId),
            ];
            if (fileIds.length) {
                const { error: filesError } = await client().from("bid_package_files").insert(
                    fileIds.map((id, i) => ({ package_id: packageId, project_file_id: id, sort_order: i }))
                );
                if (filesError) throw filesError;
            }

            const { error: invitesError } = await client().from("bid_invites").insert(invites.map(i => ({
                package_id: packageId,
                company_id: i.company.id,
                company_name: String(i.company.Name || "").trim() || "Vendor",
                contact_name: i.contact.Name || null,
                contact_email: String(i.contact.Email).trim(),
            })));
            if (invitesError) throw invitesError;
        } catch (err) {
            console.error("bid-invites: saving failed", err);
            await cleanup(packageId, uploaded);
            sending = false;
            nextBtn.disabled = false;
            updateSelectedCount();
            setMessage(`Couldn't save the invite: ${err && err.message ? err.message : err}. Nothing was sent.`, "error");
            return;
        }

        try {
            localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify({ name: d.contact_name, email: d.contact_email, phone: d.contact_phone }));
        } catch (e) { /* best effort */ }

        setMessage(`Emailing ${invites.length} vendor${invites.length === 1 ? "" : "s"}…`, "");
        const { data, error } = await callBidFunction({ action: "send", package_id: packageId });
        sending = false;
        finishSend(project.id, d.name, data, error);
    }

    /* ---------- wiring ---------- */

    function wire() {
        const openBtn = $("inviteBidBtn");
        if (!openBtn || !$("bidInviteOverlay")) return;

        openBtn.addEventListener("click", () => openWizard());
        $("bidInviteCancelBtn").addEventListener("click", closeWizard);
        $("bidInviteBackBtn").addEventListener("click", onBack);
        $("bidInviteNextBtn").addEventListener("click", onNext);
        $("bidInviteForm").addEventListener("submit", e => e.preventDefault());
        $("bidStartNewBtn").addEventListener("click", startNew);
        $("bidContinueBtn").addEventListener("click", startContinue);
        $("bidContinueProjectSelect").addEventListener("change", renderContinueList);
        $("bidContinueList").addEventListener("click", e => {
            const btn = e.target.closest("[data-continue-pkg]");
            if (btn) choosePackage(btn.dataset.continuePkg);
        });
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && !$("bidInviteOverlay").classList.contains("hidden")) closeWizard();
        });

        $("bidProjectSelect").addEventListener("change", onProjectChange);
        $("bidLocation").addEventListener("input", () => { $("bidLocation").dataset.auto = "0"; });
        $("bidWalkthroughToggle").addEventListener("change", e => {
            $("bidWalkthroughFields").classList.toggle("hidden", !e.target.checked);
        });

        $("bidPickFilesBtn").addEventListener("click", () => {
            const picker = $("bidFilePicker");
            picker.classList.toggle("hidden");
            if (!picker.classList.contains("hidden")) { renderFilePicker(); $("bidFilePickerSearch").focus(); }
        });
        $("bidFilePickerSearch").addEventListener("input", renderFilePicker);
        $("bidFilePickerList").addEventListener("change", e => {
            const id = e.target.dataset.pickFile;
            if (!id) return;
            if (e.target.checked) {
                const file = projectFiles.find(f => String(f.id) === String(id));
                if (file) chosenFiles.push({ kind: "project", file });
            } else {
                chosenFiles = chosenFiles.filter(f => !(f.kind === "project" && String(f.file.id) === String(id)));
            }
            renderFiles();
        });
        $("bidUploadInput").addEventListener("change", e => {
            Array.from(e.target.files || []).forEach(file => chosenFiles.push({ kind: "upload", file }));
            e.target.value = "";
            renderFiles();
        });
        $("bidFileList").addEventListener("click", e => {
            const btn = e.target.closest("[data-remove-file]");
            if (!btn) return;
            chosenFiles.splice(Number(btn.dataset.removeFile), 1);
            renderFiles();
            renderFilePicker();
        });

        $("bidAddTagSelect").addEventListener("change", e => {
            const id = e.target.value;
            if (id && !tagFilters.includes(id)) tagFilters.push(id);
            renderTagFilters();
            renderVendors();
        });
        $("bidTagChips").addEventListener("click", e => {
            const btn = e.target.closest("[data-remove-tag]");
            if (!btn) return;
            tagFilters = tagFilters.filter(id => id !== btn.dataset.removeTag);
            renderTagFilters();
            renderVendors();
        });
        $("bidVendorSearch").addEventListener("input", renderVendors);
        $("bidVendorTableBody").addEventListener("change", e => {
            const vendorId = e.target.dataset.vendor;
            const contactFor = e.target.dataset.vendorContact;
            if (vendorId) {
                if (e.target.checked) {
                    const select = document.querySelector(`[data-vendor-contact="${CSS.escape(vendorId)}"]`);
                    const contactId = select ? select.value : String((emailContacts(vendorId)[0] || {}).id || "");
                    if (contactId) selected.set(vendorId, contactId);
                } else {
                    selected.delete(vendorId);
                }
                renderVendors();
            } else if (contactFor && selected.has(contactFor)) {
                selected.set(contactFor, e.target.value);
            } else if (contactFor) {
                // Picking a contact on an unticked row ticks it.
                selected.set(contactFor, e.target.value);
                renderVendors();
            }
        });
        $("bidSelectAll").addEventListener("change", e => {
            const invitable = shownVendors().filter(c => vendorState(c).ok);
            invitable.forEach(company => {
                const id = String(company.id);
                if (e.target.checked) {
                    if (!selected.has(id)) selected.set(id, String(emailContacts(company.id)[0].id));
                } else {
                    selected.delete(id);
                }
            });
            renderVendors();
        });

        applyPermission();
    }

    async function applyPermission() {
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch (e) { /* hasPermission fails open */ }
        }
        const allowed = can(SEND_PERMISSION);
        $("inviteBidBtn").classList.toggle("hidden", !allowed);
        const divider = $("inviteBidDivider");
        if (divider) divider.classList.toggle("hidden", !allowed);

        // Deep link from a project's Bid Invites tab: ?invite=1&project=<id>
        const params = new URLSearchParams(window.location.search);
        if (allowed && params.get("invite") === "1") {
            const projectId = params.get("project");
            history.replaceState(null, "", window.location.pathname);
            openWizard(projectId);
        }
    }

    // Permissions load after the profile does; wait for both like the rest of the page.
    function start() {
        if (!window.supabaseClient) { setTimeout(start, 150); return; }
        const profileReady = window.supabaseInitialProfilePromise || Promise.resolve();
        profileReady.then(wire, wire);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
