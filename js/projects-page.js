/* ===========================================================
   PROJECT OVERVIEW PAGE (project-home.html)
   Reads/writes public.projects in Supabase (see
   SQL FILES/supabase-projects-setup.sql — must be run once before this
   page will load or save anything).

   Custom auth model: no auth.uid(), RLS is open to anon, access control
   is app-level. This page itself is gated by nav-access.js under the
   "project_overview" nav key — grant it to workgroups from the
   Workgroups admin page.

   Displays projects as a workbook-style card grid (same visual language
   as excel-workbook.html / venders.html) and drives the "+ New Project
   Onboard" wizard: every section is skippable, with Back/Next/Skip
   and a Save & Finish Later option so partial progress is never lost.
=========================================================== */

// Field/section config now lives in project-fields.js (shared with the
// per-project dashboard pages) — make sure that script tag loads before
// this one.
const PROJECTS_TABLE = window.ProjectFields.PROJECTS_TABLE;
// Reads use this view (masks financial fields per-row); writes below still
// target PROJECTS_TABLE directly — see project-fields.js.
const PROJECTS_READ_VIEW = window.ProjectFields.PROJECTS_READ_VIEW;
const PROJECT_DOCS_BUCKET = window.ProjectFields.PROJECT_DOCS_BUCKET;
const WIZARD_STEPS = window.ProjectFields.WIZARD_STEPS;
const storagePathFromPublicUrl = window.ProjectFields.storagePathFromPublicUrl;

let allProjects = [];
let projectWizardState = null; // { id, stepIndex, values: {...}, pendingFiles: {} }

function projectsCan(permissionKey) {
    return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
}

async function applyProjectPermissionsToUI() {
    if (window.Permissions) {
        try { await window.Permissions.initPermissions(); } catch { /* hasPermission() fails open regardless */ }
    }
    const addBtn = document.getElementById("addProjectBtn");
    if (addBtn) addBtn.classList.toggle("hidden", !projectsCan("projects.create"));
}

/* ===========================
   STATUS / TRACKING (added for the redesigned stats header, badges,
   card+list toggle, tabs, and pagination — see
   SQL FILES/supabase-projects-status-fields-setup.sql for the columns
   this reads/writes: status, project_manager_name, contract_value,
   progress_percent, due_date, updated_by_name.)
=========================== */

// Built from window.ProjectFields.PROJECT_STATUSES — the same list drives
// the wizard's Status dropdown, so labels/colors can't drift out of sync
// between the wizard and the cards/tabs/stats header.
function tabCountElementId(statusValue) {
    return "projectTabCount" + statusValue.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join("");
}

const PROJECT_STATUS_META = {};
window.ProjectFields.PROJECT_STATUSES.forEach(status => {
    PROJECT_STATUS_META[status.value] = {
        label: status.label,
        chip: status.chip,
        tabCountId: tabCountElementId(status.value)
    };
});

let projectActiveTab = "all";
let projectCurrentPage = 1;
let projectPageSize = 6;
let projectQuickEditId = null;

/* ===========================
   ADDRESS AUTOCOMPLETE (Mailing address, Step 1)
   Free, no API key: OpenStreetMap's Nominatim search API. Debounced to
   respect their ~1 request/second usage policy, and results carry the
   required "Search by OpenStreetMap" attribution.
=========================== */

let addressAutocompleteTimer = null;

// Wires up whichever field in the CURRENTLY VISIBLE step is flagged
// addressLookup (today just owner_address on Step 1). Safe to call on
// every render — no-op if no such field is on screen.
function attachAddressAutocomplete() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const field = step.fields.find(f => f.addressLookup);
    if (!field) return;

    const input = document.querySelector(`#projectWizardStepBody input[name="${field.name}"]`);
    const dropdown = document.getElementById(`addressSuggestions-${field.name}`);
    if (!input || !dropdown) return;

    input.addEventListener("input", () => {
        clearTimeout(addressAutocompleteTimer);
        const query = input.value.trim();

        if (query.length < 4) {
            dropdown.classList.add("hidden");
            dropdown.innerHTML = "";
            return;
        }

        addressAutocompleteTimer = setTimeout(() => fetchAddressSuggestions(query, input, dropdown), 450);
    });

    input.addEventListener("focus", () => {
        if (dropdown.innerHTML.trim()) dropdown.classList.remove("hidden");
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".address-autocomplete-field") && !event.target.closest(".address-suggestions")) {
            dropdown.classList.add("hidden");
        }
    });
}

async function fetchAddressSuggestions(query, input, dropdown) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(`Nominatim request failed: ${res.status}`);
        const results = await res.json();

        if (!results.length) {
            dropdown.classList.remove("hidden");
            dropdown.innerHTML = `<p class="address-suggestion-empty">No matches found.</p>`;
            return;
        }

        dropdown.classList.remove("hidden");
        dropdown.innerHTML = results.map(r => `
            <button type="button" class="address-suggestion-option" data-value="${escapeHtmlProject(r.display_name)}">
                ${escapeHtmlProject(r.display_name)}
            </button>
        `).join("") + `<p class="address-suggestion-attribution">Search by OpenStreetMap</p>`;

        dropdown.querySelectorAll(".address-suggestion-option").forEach(btn => {
            btn.addEventListener("click", () => {
                input.value = btn.dataset.value;
                if (projectWizardState) projectWizardState.values[input.name] = btn.dataset.value;
                dropdown.classList.add("hidden");
                dropdown.innerHTML = "";
            });
        });

    } catch (error) {
        console.warn("Address autocomplete failed:", error);
        dropdown.classList.add("hidden");
    }
}

/* ===========================
   HELPERS
=========================== */

function escapeHtmlProject(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function isBlankProjectValue(value) {
    return window.ProjectFields.isBlank(value);
}

function currentStaffInfo() {
    const profile = window.currentSupabaseProfile
        || JSON.parse(localStorage.getItem("staffProfile") || "null");
    return {
        id: profile && (profile.id ?? profile.uid) != null ? String(profile.id ?? profile.uid) : null,
        name: (profile && (profile.full_name || profile.username)) || "Staff Portal"
    };
}

function setProjectPageMessage(text, type) {
    const el = document.getElementById("projectMessage");
    if (!el) return;
    if (!text) { el.style.display = "none"; return; }
    el.textContent = text;
    el.className = `workbook-page-message ${type || ""}`.trim();
    el.style.display = "block";
}

function setWizardMessage(text, type) {
    const el = document.getElementById("projectWizardMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = `auth-message ${type || ""}`.trim();
}

function formatSiteAddress(project) {
    const line2 = [project.site_city, project.site_state].filter(Boolean).join(", ");
    const full = [line2, project.site_zip].filter(Boolean).join(" ");
    return [project.site_address, full].filter(Boolean).join(" · ");
}

function formatProjectValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    if (Number.isNaN(num)) return "—";
    if (Math.abs(num) >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
    if (Math.abs(num) >= 1000) return `$${(num / 1000).toFixed(1)}k`;
    return `$${num.toLocaleString()}`;
}

function formatProjectDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Returns { text, subtext, subClass } for the due-date row — "X days left",
// "X days overdue", or just "Completed" once the project is marked done.
function computeDueDateInfo(project) {
    const formatted = formatProjectDate(project.due_date);
    if (!formatted) return { text: "No due date set", subtext: "", subClass: "" };

    if (project.status === "completed") {
        return { text: formatted, subtext: "Completed", subClass: "" };
    }

    const due = new Date(project.due_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / 86400000);

    if (diffDays < 0) {
        return { text: formatted, subtext: `${Math.abs(diffDays)} days overdue`, subClass: "project-due-overdue" };
    }
    if (diffDays <= 7) {
        return { text: formatted, subtext: `${diffDays} days left`, subClass: "project-due-soon" };
    }
    return { text: formatted, subtext: `${diffDays} days left`, subClass: "" };
}

// Schedule-pace badge shown over the cover photo — "Behind" / "On Time" /
// "Ahead of Schedule". Only meaningful for projects actively being worked
// (active/onboarding) with a due date set; there's nothing useful to say
// for on-hold/completed/archived projects or ones with no due date, so
// this returns null (badge hidden) for those.
//
// There's no dedicated "start date" column, so created_at stands in for
// one: expected progress = how much of the created_at→due_date window has
// elapsed. Actual progress more than ~10 points ahead/behind that pace is
// "Ahead of Schedule"/"Behind"; anything closer is "On Time". Being past
// the due date and not yet complete is always "Behind", regardless of the
// pace math.
function computeSchedulePace(project) {
    const statusKey = project.status || "onboarding";
    if (statusKey !== "active" && statusKey !== "onboarding") return null;
    if (!project.due_date) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${project.due_date}T00:00:00`);
    if (Number.isNaN(due.getTime())) return null;

    const progress = Math.max(0, Math.min(100, Number(project.progress_percent) || 0));

    if (due < today && progress < 100) {
        return { label: "Behind", cls: "behind" };
    }

    const created = project.created_at ? new Date(project.created_at) : null;
    if (!created || Number.isNaN(created.getTime())) {
        return due < today ? { label: "Behind", cls: "behind" } : { label: "On Time", cls: "on-time" };
    }
    created.setHours(0, 0, 0, 0);

    const totalDays = (due - created) / 86400000;
    const elapsedDays = (today - created) / 86400000;

    if (totalDays <= 0) {
        return due < today ? { label: "Behind", cls: "behind" } : { label: "On Time", cls: "on-time" };
    }

    const expectedProgress = Math.max(0, Math.min(100, (elapsedDays / totalDays) * 100));
    const delta = progress - expectedProgress;

    if (delta >= 10) return { label: "Ahead of Schedule", cls: "ahead" };
    if (delta <= -10) return { label: "Behind", cls: "behind" };
    return { label: "On Time", cls: "on-time" };
}

function projectManagerInitials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "—";
    return words.length >= 2
        ? `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
        : words[0].substring(0, 2).toUpperCase();
}

// How many of the 10 sections have at least one field filled in — shown on
// the card so staff can see onboarding progress at a glance.
function computeProjectCompleteness(project) {
    return window.ProjectFields.computeCompleteness(project);
}

function anyProjectOverlayOpen() {
    return [
        "projectWizardModalOverlay",
        "deleteProjectConfirmOverlay",
        "projectQuickEditOverlay"
    ].some(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains("hidden");
    });
}

/* ===========================
   LOAD + RENDER GRID
=========================== */

async function loadProjects() {
    const loadingState = document.getElementById("projectLoadingState");
    const emptyState = document.getElementById("projectEmptyState");
    const grid = document.getElementById("projectsGrid");

    if (!window.supabaseClient) {
        console.error("Supabase client not ready yet");
        return;
    }

    if (loadingState) loadingState.style.display = "block";
    if (emptyState) emptyState.style.display = "none";

    const { data, error } = await window.supabaseClient
        .from(PROJECTS_READ_VIEW)
        .select("*")
        .order("name", { ascending: true });

    if (loadingState) loadingState.style.display = "none";

    if (error) {
        console.error("Failed to load projects:", error);
        setProjectPageMessage("Couldn't load projects. The projects table may not be set up yet — run SQL FILES/supabase-projects-setup.sql (and supabase-projects-status-fields-setup.sql) in Supabase, then refresh.", "error");
        return;
    }

    allProjects = data || [];

    if (allProjects.length === 0) {
        if (emptyState) emptyState.style.display = "block";
        if (grid) grid.innerHTML = "";
        renderProjectStatsBar([]);
        renderProjectTabCounts([]);
        renderProjectPagination(0);
        return;
    }

    refreshProjectsView();
}

/* ===========================
   STATS BAR — always reflects ALL projects, independent of the
   search box / active tab (matches how the reference design's header
   numbers stay put while the grid below filters).
=========================== */

function renderProjectStatsBar(projects) {
    const byStatus = (key) => projects.filter(p => (p.status || "onboarding") === key).length;
    // "Total Projects" mirrors the "All Projects" tab, which excludes
    // archived projects (they're tucked away under their own Archived tab
    // instead) — so the header number always matches what's on screen.
    const nonArchived = projects.filter(p => (p.status || "onboarding") !== "archived");
    const totalValue = nonArchived.reduce((sum, p) => sum + (Number(p.contract_value) || 0), 0);

    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    setText("projectStatTotal", String(nonArchived.length));
    setText("projectStatActive", String(byStatus("active")));
    setText("projectStatOnboarding", String(byStatus("onboarding")));
    setText("projectStatCompleted", String(byStatus("completed")));
    setText("projectStatValue", formatProjectValue(totalValue));
}

function renderProjectTabCounts(projects) {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };

    // Same as the grid itself: "All Projects" leaves archived out, so the
    // Archived tab is the only place their count/status shows.
    setText("projectTabCountAll", String(projects.filter(p => (p.status || "onboarding") !== "archived").length));
    Object.entries(PROJECT_STATUS_META).forEach(([key, meta]) => {
        setText(meta.tabCountId, String(projects.filter(p => (p.status || "onboarding") === key).length));
    });
}

/* ===========================
   FILTER + SORT + PAGINATE + RENDER
=========================== */

function filterProjectsForGrid() {
    const searchInput = document.getElementById("projectSearchInput");
    const query = (searchInput ? searchInput.value.trim().toLowerCase() : "");

    return allProjects.filter(project => {
        const status = project.status || "onboarding";
        // "All Projects" hides archived projects — they stay in the system
        // and are still fully visible under their own Archived tab, just
        // out of the way of the default/working view.
        if (projectActiveTab === "all") {
            if (status === "archived") return false;
        } else if (status !== projectActiveTab) {
            return false;
        }
        if (!query) return true;
        const haystack = [
            project.name, project.site_address, project.site_city, project.site_state,
            project.gc_name, project.project_manager_name
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(query);
    });
}

// Due date ascending, projects with no due date sink to the bottom.
function sortProjectsByDueDate(projects) {
    return [...projects].sort((a, b) => {
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return new Date(a.due_date) - new Date(b.due_date);
    });
}

function refreshProjectsView() {
    renderProjectStatsBar(allProjects);
    renderProjectTabCounts(allProjects);

    const filtered = sortProjectsByDueDate(filterProjectsForGrid());
    const noResultsState = document.getElementById("projectNoResultsState");

    const totalPages = Math.max(1, Math.ceil(filtered.length / projectPageSize));
    if (projectCurrentPage > totalPages) projectCurrentPage = totalPages;
    if (projectCurrentPage < 1) projectCurrentPage = 1;

    const startIndex = (projectCurrentPage - 1) * projectPageSize;
    const pageItems = filtered.slice(startIndex, startIndex + projectPageSize);

    renderProjectCards(pageItems);
    renderProjectPagination(filtered.length);

    if (noResultsState) {
        noResultsState.style.display = (allProjects.length > 0 && filtered.length === 0) ? "block" : "none";
    }
}

function renderProjectCards(projects) {
    const grid = document.getElementById("projectsGrid");
    if (!grid) return;

    grid.innerHTML = "";

    projects.forEach(project => {
        const address = formatSiteAddress(project);
        const statusKey = project.status || "onboarding";
        const statusMeta = PROJECT_STATUS_META[statusKey] || PROJECT_STATUS_META.onboarding;
        const progress = Math.max(0, Math.min(100, Number(project.progress_percent) || 0));
        const dueInfo = computeDueDateInfo(project);
        const updatedDate = formatProjectDate(project.updated_at) || "—";
        const updatedBy = project.updated_by_name || project.created_by_name || "Staff Portal";
        const pmName = project.project_manager_name || "Unassigned";
        const pace = computeSchedulePace(project);

        const card = document.createElement("div");
        card.className = `workbook-card project-card project-card--${statusKey}`;
        card.dataset.projectId = project.id;

        const coverStyle = project.cover_photo_url
            ? ` style="background-image:url('${project.cover_photo_url.replace(/'/g, "%27")}')"`
            : "";

        card.innerHTML = `
            <div class="workbook-cover project-cover ${project.cover_photo_url ? "" : "project-cover--placeholder"}"${coverStyle}>
                ${project.cover_photo_url ? "" : `<span class="project-cover-placeholder-icon"></span>`}
                ${pace ? `<span class="project-schedule-badge project-schedule-badge--${pace.cls}">${escapeHtmlProject(pace.label)}</span>` : ""}
            </div>

            <div class="company-card-body">

                <button
                    type="button"
                    class="company-edit-btn project-edit-btn ${projectsCan("projects.edit") ? "" : "hidden"}"
                    data-id="${project.id}"
                    aria-label="Edit project">
                    <span class="project-edit-icon"></span>
                </button>

                <div class="project-card-header">
                    <h3 class="company-card-name">
                        ${escapeHtmlProject(project.name || "Untitled project")}
                        ${project.project_code ? `<span class="chip chip--muted project-code-chip">${escapeHtmlProject(project.project_code)}</span>` : ""}
                    </h3>
                    <button type="button" class="chip chip--dot ${statusMeta.chip} project-status-badge" data-id="${project.id}" title="Update status">
                        ${escapeHtmlProject(statusMeta.label)}
                    </button>
                </div>

                <div class="company-card-address">
                    ${address ? `<p>${escapeHtmlProject(address)}</p>` : `<p class="company-card-muted">No site address on file</p>`}
                </div>

                <div class="project-card-stats-row">

                    <div class="project-card-stat">
                        <p class="project-card-stat-label">Value</p>
                        <p class="project-card-stat-value">${formatProjectValue(project.contract_value)}</p>
                    </div>

                    <div class="project-card-stat">
                        <p class="project-card-stat-label">Progress</p>
                        <p class="project-card-stat-value">${progress}%</p>
                        <div class="project-progress-track"><span class="project-progress-fill project-progress-fill--${statusKey}" style="width:${progress}%"></span></div>
                    </div>

                    <div class="project-card-stat">
                        <p class="project-card-stat-label">Due date</p>
                        <p class="project-card-stat-value">${escapeHtmlProject(dueInfo.text)}</p>
                        ${dueInfo.subtext ? `<p class="project-card-stat-sub ${dueInfo.subClass}">${escapeHtmlProject(dueInfo.subtext)}</p>` : ""}
                    </div>

                </div>

                <div class="project-card-divider"></div>

                <div class="project-card-footer">

                    <div class="project-card-pm">
                        <span class="project-pm-avatar">${projectManagerInitials(project.project_manager_name)}</span>
                        <div>
                            <p class="project-pm-name">${escapeHtmlProject(pmName)}</p>
                            <p class="project-pm-role">Project Manager</p>
                        </div>
                    </div>

                    <div class="project-card-updated">
                        <p class="project-updated-label">Updated</p>
                        <p class="project-updated-value">${updatedDate}</p>
                        <p class="project-updated-by">by ${escapeHtmlProject(updatedBy)}</p>
                    </div>

                </div>

            </div>
        `;

        grid.appendChild(card);
    });

    grid.querySelectorAll(".project-card").forEach(card => {
        card.addEventListener("click", (event) => {
            if (event.target.closest(".project-edit-btn") || event.target.closest(".project-status-badge")) return;
            const id = card.dataset.projectId;
            if (id) window.location.href = `/pages/projects.html?id=${encodeURIComponent(id)}`;
        });
    });

    grid.querySelectorAll(".project-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const project = allProjects.find(p => String(p.id) === String(id));
            if (project) openProjectWizard(project);
        });
    });

    grid.querySelectorAll(".project-status-badge").forEach(btn => {
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            const id = btn.dataset.id;
            const project = allProjects.find(p => String(p.id) === String(id));
            if (project) openProjectQuickEdit(project);
        });
    });
}

/* ===========================
   PAGINATION
=========================== */

function renderProjectPagination(filteredCount) {
    const wrap = document.getElementById("projectPagination");
    const summary = document.getElementById("projectPaginationSummary");
    const pageNumbers = document.getElementById("projectPageNumbers");
    const prevBtn = document.getElementById("projectPrevPageBtn");
    const nextBtn = document.getElementById("projectNextPageBtn");
    if (!wrap || !summary || !pageNumbers || !prevBtn || !nextBtn) return;

    if (filteredCount === 0) {
        wrap.style.display = "none";
        return;
    }
    wrap.style.display = "flex";

    const totalPages = Math.max(1, Math.ceil(filteredCount / projectPageSize));
    const startIndex = (projectCurrentPage - 1) * projectPageSize;
    const endIndex = Math.min(filteredCount, startIndex + projectPageSize);

    summary.textContent = `Showing ${startIndex + 1} to ${endIndex} of ${filteredCount} projects`;

    prevBtn.disabled = projectCurrentPage <= 1;
    nextBtn.disabled = projectCurrentPage >= totalPages;

    pageNumbers.innerHTML = "";
    for (let page = 1; page <= totalPages; page++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `project-page-number ${page === projectCurrentPage ? "active" : ""}`;
        btn.textContent = String(page);
        btn.addEventListener("click", () => {
            projectCurrentPage = page;
            refreshProjectsView();
        });
        pageNumbers.appendChild(btn);
    }
}

/* ===========================
   VIEW TOGGLE (Card / List) — same pattern as venders.html's
   companyViewToggle: the grid/list classes just reflow the same markup.
=========================== */

function initProjectViewToggle() {
    const grid = document.getElementById("projectsGrid");
    const toggle = document.getElementById("projectViewToggle");
    const cardBtn = document.getElementById("projectCardViewBtn");
    const listBtn = document.getElementById("projectListViewBtn");
    if (!grid || !toggle || !cardBtn || !listBtn) return;

    function setView(view) {
        const isList = view === "list";
        grid.classList.toggle("workbook-grid--list", isList);
        toggle.classList.toggle("view-toggle--list", isList);
        cardBtn.classList.toggle("active", !isList);
        listBtn.classList.toggle("active", isList);
        cardBtn.setAttribute("aria-pressed", String(!isList));
        listBtn.setAttribute("aria-pressed", String(isList));
    }

    cardBtn.addEventListener("click", () => setView("card"));
    listBtn.addEventListener("click", () => setView("list"));
}

/* ===========================
   TABS
=========================== */

function initProjectTabs() {
    const tabsWrap = document.getElementById("projectTabs");
    if (!tabsWrap) return;

    tabsWrap.querySelectorAll(".dash-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            tabsWrap.querySelectorAll(".dash-tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            projectActiveTab = btn.dataset.status;
            projectCurrentPage = 1;
            refreshProjectsView();
        });
    });
}

/* ===========================
   QUICK STATUS/TRACKING EDIT (separate from the 10-step wizard —
   status, PM, value, progress, and due date get updated far more often
   than the onboarding fields, so they shouldn't require the full wizard.)
=========================== */

function openProjectQuickEdit(project) {
    // Silent no-op for the same reason as openProjectWizard above -- the
    // status badge that triggers this is also a plain status display, so
    // it isn't hidden outright for users without projects.edit.
    if (!projectsCan("projects.edit")) return;

    projectQuickEditId = project.id;

    document.getElementById("projectQuickEditName").textContent = project.name || "Untitled project";
    document.getElementById("projectQuickEditStatus").value = project.status || "onboarding";
    document.getElementById("projectQuickEditPm").value = project.project_manager_name || "";
    document.getElementById("projectQuickEditValue").value = project.contract_value ?? "";
    document.getElementById("projectQuickEditProgress").value = project.progress_percent ?? 0;
    document.getElementById("projectQuickEditDueDate").value = project.due_date || "";

    const messageEl = document.getElementById("projectQuickEditMessage");
    if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

    document.getElementById("projectQuickEditOverlay").classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeProjectQuickEdit() {
    document.getElementById("projectQuickEditOverlay").classList.add("hidden");
    projectQuickEditId = null;
    if (!anyProjectOverlayOpen()) document.body.classList.remove("popup-active");
}

async function saveProjectQuickEdit() {
    if (!projectQuickEditId) return;

    const saveBtn = document.getElementById("projectQuickEditSaveBtn");
    const messageEl = document.getElementById("projectQuickEditMessage");

    if (!projectsCan("projects.edit")) {
        if (messageEl) { messageEl.textContent = "You don't have permission to do this."; messageEl.className = "auth-message error"; }
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (messageEl) { messageEl.textContent = "Saving…"; messageEl.className = "auth-message"; }

    const staff = currentStaffInfo();
    const progressRaw = Number(document.getElementById("projectQuickEditProgress").value);
    const valueRaw = document.getElementById("projectQuickEditValue").value;

    const payload = {
        status: document.getElementById("projectQuickEditStatus").value,
        project_manager_name: document.getElementById("projectQuickEditPm").value.trim() || null,
        contract_value: valueRaw === "" ? null : Number(valueRaw),
        progress_percent: Number.isNaN(progressRaw) ? 0 : Math.max(0, Math.min(100, progressRaw)),
        due_date: document.getElementById("projectQuickEditDueDate").value || null,
        updated_by_id: staff.id,
        updated_by_name: staff.name
    };

    try {
        const { error } = await window.supabaseClient
            .from(PROJECTS_TABLE)
            .update(payload)
            .eq("id", projectQuickEditId);

        if (error) throw error;

        closeProjectQuickEdit();
        setProjectPageMessage("Project updated.", "success");
        await loadProjects();

    } catch (error) {
        console.error("Failed to save project tracking info:", error);
        if (messageEl) { messageEl.textContent = "Something went wrong saving this. Please try again."; messageEl.className = "auth-message error"; }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

/* ===========================
   WIZARD — FIELD RENDERING
=========================== */

// `value || ""` treats a legitimate 0 (progress %, etc.) as blank — this is
// the null-safe version used everywhere a field's current value is echoed
// back into an input/textarea.
function fieldDisplayValue(value) {
    return (value === null || value === undefined) ? "" : value;
}

function wizardFieldHtml(field, state) {
    const value = state.values[field.name];

    if (field.type === "textarea") {
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <textarea name="${field.name}" placeholder="${escapeHtmlProject(field.placeholder || "")}" autocomplete="off" data-lpignore="true" data-1p-ignore autocorrect="off" spellcheck="false">${escapeHtmlProject(fieldDisplayValue(value))}</textarea>
            </label>
        `;
    }

    if (field.type === "select") {
        // Options are either plain strings (existing site/permit-status
        // fields) or {value,label} objects (e.g. project status, where the
        // stored value is a snake_case key but the label is human-readable).
        const options = field.options.map(opt => {
            const optValue = typeof opt === "object" ? opt.value : opt;
            const optLabel = typeof opt === "object" ? opt.label : opt;
            return `<option value="${escapeHtmlProject(optValue)}" ${value === optValue ? "selected" : ""}>${escapeHtmlProject(optLabel)}</option>`;
        }).join("");
        // noBlankOption: fields backed by a NOT NULL column (like status)
        // can't be allowed to submit as "" — there's always a real value.
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <select name="${field.name}" autocomplete="off">
                    ${field.noBlankOption ? "" : `<option value="" ${!value ? "selected" : ""}>—</option>`}
                    ${options}
                </select>
            </label>
        `;
    }

    if (field.type === "file") {
        const existingPath = state.values[field.pathField];
        const pendingFile = state.pendingFiles[field.name];
        let note = "";
        if (pendingFile) {
            note = `<p class="wizard-file-existing-note">Selected: ${escapeHtmlProject(pendingFile.name)} (will upload on save)</p>`;
        } else if (existingPath) {
            // Public-bucket files (cover photo) store the full URL already —
            // link straight to it. Private-bucket files (site/permit plans)
            // store just a storage path and need a signed URL on click.
            if (field.publicBucket) {
                const fileName = existingPath.split("/").pop();
                note = `<p class="wizard-file-existing-note">On file: <a href="#" class="wizard-preview-url-link" data-url="${escapeHtmlProject(existingPath)}" data-name="${escapeHtmlProject(fileName)}">${escapeHtmlProject(fileName)}</a>. Choosing a new file replaces it.</p>`;
            } else {
                const fileName = existingPath.split("/").pop();
                note = `<p class="wizard-file-existing-note">On file: ${escapeHtmlProject(fileName)} — <a href="#" class="wizard-view-file-link" data-path="${escapeHtmlProject(existingPath)}">view</a>. Choosing a new file replaces it.</p>`;
            }
        }
        return `
            <label class="auth-field">
                ${escapeHtmlProject(field.label)}
                <input type="file" name="${field.name}" accept="${field.accept || ""}">
            </label>
            ${note}
        `;
    }

    // text / tel / email / number / date — autocomplete="off" plus a couple
    // of extra attributes Safari/iOS respects better than autocomplete alone
    // (data-lpignore/data-1p-ignore also happen to quiet 1Password/LastPass).
    const extraAttrs = [
        field.maxlength ? `maxlength="${field.maxlength}"` : "",
        field.uppercase ? `style="text-transform:uppercase;"` : ""
    ].filter(Boolean).join(" ");

    const noAutofillAttrs = `autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore`;

    if (field.addressLookup) {
        return `
            <label class="auth-field address-autocomplete-field">
                ${escapeHtmlProject(field.label)}
                <input type="text" name="${field.name}" value="${escapeHtmlProject(fieldDisplayValue(value))}" placeholder="${escapeHtmlProject(field.placeholder || "")}" ${noAutofillAttrs} ${extraAttrs}>
                <div class="address-suggestions hidden" id="addressSuggestions-${field.name}"></div>
            </label>
        `;
    }

    return `
        <label class="auth-field">
            ${escapeHtmlProject(field.label)}
            <input type="${field.type}" name="${field.name}" value="${escapeHtmlProject(fieldDisplayValue(value))}" placeholder="${escapeHtmlProject(field.placeholder || "")}" ${noAutofillAttrs} ${extraAttrs}>
        </label>
    `;
}

function renderWizardStep() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const isFirst = state.stepIndex === 0;
    const isLast = state.stepIndex === WIZARD_STEPS.length - 1;

    document.getElementById("projectWizardTitle").textContent = state.id ? "Edit Project" : "New Project Onboarding";
    document.getElementById("projectWizardStepLabel").textContent = `Step ${state.stepIndex + 1} of ${WIZARD_STEPS.length}`;

    const bodyEl = document.getElementById("projectWizardStepBody");
    const fieldsHtml = step.fields.map(field => wizardFieldHtml(field, state)).join("");
    // The 4 contact-style steps (owner_contact/gc/poc/county_city) render as
    // one grouped card labeled with the step's own title, instead of the
    // step title sitting alone above a plain field list — see
    // project-fields.js's layout: "contact" and .wizard-contact-block in
    // styles.css. Every other step gets a plain responsive field grid.
    const fieldsBlock = step.layout === "contact"
        ? `<div class="wizard-contact-block"><div class="wizard-contact-block-label">${escapeHtmlProject(step.title)}</div>${fieldsHtml}</div>`
        : `<div class="wizard-field-grid">${fieldsHtml}</div>`;

    bodyEl.innerHTML = `
        <div class="wizard-step-header">
            <span class="wizard-step-number">${state.stepIndex + 1}</span>
            <div>
                <h3 class="wizard-step-header-title">${escapeHtmlProject(step.title)}</h3>
                ${step.hint ? `<p class="wizard-step-header-hint">${escapeHtmlProject(step.hint)}</p>` : ""}
            </div>
        </div>
        ${fieldsBlock}
    `;

    bodyEl.querySelectorAll(".wizard-view-file-link").forEach(link => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            viewProjectFile(link.dataset.path);
        });
    });
    bodyEl.querySelectorAll(".wizard-preview-url-link").forEach(link => {
        link.addEventListener("click", (event) => {
            event.preventDefault();
            window.FilePreview.open({ name: link.dataset.name, url: link.dataset.url });
        });
    });

    attachAddressAutocomplete();

    // Progress dots -- Coleby, 2026-09-08: "can we add where i hover over
    // the pills at the top and go to that steps... when you hover over it
    // the pills to the left are lightly grade out and then press it and go
    // stright to that step." Each pill is now a real step-jump control:
    // click to go straight there, hover to preview which pills sit to its
    // left (dimmed). Free jump to any step (forward or back) mirrors the
    // freedom the existing Skip button already allows -- no per-step
    // required-field gate exists in this wizard to break by allowing it.
    const progressEl = document.getElementById("projectWizardProgress");
    progressEl.innerHTML = WIZARD_STEPS.map((wizardStep, i) => {
        const cls = i < state.stepIndex ? "is-complete" : (i === state.stepIndex ? "is-current" : "");
        return `<div
            class="wizard-progress-dot ${cls}"
            data-step-index="${i}"
            role="button"
            tabindex="0"
            title="Step ${i + 1}: ${escapeHtmlProject(wizardStep.title)}"
        ></div>`;
    }).join("");

    progressEl.querySelectorAll(".wizard-progress-dot").forEach(dot => {
        const targetIndex = Number(dot.dataset.stepIndex);

        dot.addEventListener("click", () => wizardGoToStep(targetIndex));

        dot.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            wizardGoToStep(targetIndex);
        });

        // Lightly dim every pill to the LEFT of the one being hovered, so
        // hovering step 4's pill previews "you're about to jump past 1-3."
        dot.addEventListener("mouseenter", () => {
            progressEl.querySelectorAll(".wizard-progress-dot").forEach(other => {
                other.classList.toggle(
                    "wizard-progress-dot--dimmed",
                    Number(other.dataset.stepIndex) < targetIndex
                );
            });
        });

        dot.addEventListener("mouseleave", () => {
            progressEl.querySelectorAll(".wizard-progress-dot").forEach(other => {
                other.classList.remove("wizard-progress-dot--dimmed");
            });
        });
    });

    // Step 1: top-left link is "Cancel" (nothing to go back to yet).
    // Step 2+: it becomes "Go back" instead — Cancel only makes sense
    // before any progress has been made.
    document.getElementById("projectWizardCancelBtn").style.display = isFirst ? "" : "none";
    document.getElementById("projectWizardBackBtn").style.display = isFirst ? "none" : "";
    document.getElementById("projectWizardNextBtn").textContent = isLast ? "Finish" : "Next";
    document.getElementById("deleteProjectBtn").style.display = (state.id && projectsCan("projects.delete")) ? "block" : "none";

    setWizardMessage("", "");
}

// Reads whatever's currently typed in #projectWizardStepBody into
// projectWizardState, WITHOUT advancing the step. Used by Back/Next/Save.
function collectCurrentStepInputs() {
    const state = projectWizardState;
    if (!state) return;

    const step = WIZARD_STEPS[state.stepIndex];
    const bodyEl = document.getElementById("projectWizardStepBody");

    step.fields.forEach(field => {
        if (field.type === "file") {
            const input = bodyEl.querySelector(`[name="${field.name}"]`);
            if (input && input.files && input.files.length) {
                state.pendingFiles[field.name] = input.files[0];
            }
            return;
        }

        const input = bodyEl.querySelector(`[name="${field.name}"]`);
        if (!input) return;

        let value = input.value.trim();
        if (field.uppercase) value = value.toUpperCase();
        state.values[field.name] = value || null;
    });
}

/* ===========================
   WIZARD — OPEN / CLOSE / NAVIGATE
=========================== */

function openProjectWizard(project) {
    // Defense in depth -- the entry points (addProjectBtn, each card's edit
    // button) are already hidden when the relevant permission is missing,
    // so this silently no-ops rather than trying to show an error against a
    // modal that isn't open yet.
    if (!projectsCan(project ? "projects.edit" : "projects.create")) return;

    const values = {};
    WIZARD_STEPS.forEach(step => {
        step.fields.forEach(field => {
            if (field.type === "file") {
                values[field.pathField] = project ? project[field.pathField] ?? null : null;
            } else {
                // New projects (project === null) start from the field's
                // declared default instead of always null — matters for
                // NOT NULL columns like status/progress_percent, which would
                // otherwise get submitted as null if this step is skipped.
                const fallback = field.default !== undefined ? field.default : null;
                values[field.name] = project ? project[field.name] ?? fallback : fallback;
            }
        });
    });

    projectWizardState = {
        id: project ? project.id : null,
        stepIndex: 0,
        values,
        pendingFiles: {}
    };

    renderWizardStep();

    document.getElementById("projectWizardModalOverlay").classList.remove("hidden");
    document.body.classList.add("popup-active");
}

function closeProjectWizard() {
    document.getElementById("projectWizardModalOverlay").classList.add("hidden");
    projectWizardState = null;
    if (!anyProjectOverlayOpen()) document.body.classList.remove("popup-active");
}

function wizardGoBack() {
    if (!projectWizardState || projectWizardState.stepIndex === 0) return;
    collectCurrentStepInputs();
    projectWizardState.stepIndex--;
    renderWizardStep();
}

// Jumps straight to any step by index -- wired to a click (or Enter/Space)
// on that step's progress pill. Always collects whatever's currently typed
// first, same as Back/Next, so nothing typed on the step you're leaving is
// lost, whichever direction the jump goes.
function wizardGoToStep(index) {
    if (!projectWizardState) return;
    if (index < 0 || index >= WIZARD_STEPS.length) return;
    if (index === projectWizardState.stepIndex) return;
    collectCurrentStepInputs();
    projectWizardState.stepIndex = index;
    renderWizardStep();
}

function wizardSkipStep() {
    if (!projectWizardState) return;
    // Deliberately does NOT collect this step's inputs — "skip" discards
    // whatever's currently typed here rather than saving it.
    if (projectWizardState.stepIndex === WIZARD_STEPS.length - 1) {
        finishProjectWizard();
        return;
    }
    projectWizardState.stepIndex++;
    renderWizardStep();
}

function wizardGoNext() {
    if (!projectWizardState) return;
    collectCurrentStepInputs();
    if (projectWizardState.stepIndex === WIZARD_STEPS.length - 1) {
        finishProjectWizard();
        return;
    }
    projectWizardState.stepIndex++;
    renderWizardStep();
}

async function wizardSaveAndFinishLater() {
    if (!projectWizardState) return;
    collectCurrentStepInputs();
    await saveProjectFromWizard("Project saved. Pick up where you left off anytime from its card.");
}

async function finishProjectWizard() {
    await saveProjectFromWizard(projectWizardState.id ? "Project updated." : "Project created.");
}

/* ===========================
   WIZARD — SAVE (insert/update + file uploads)
=========================== */

// Upload + signed-URL logic actually lives in project-fields.js now
// (window.ProjectFields.uploadFile) so the onboarding wizard here and the
// All Files page (project-files.html) share one implementation instead of
// duplicating the storage-path convention. Kept as a thin wrapper so every
// existing call site in this file keeps working unchanged.
async function uploadProjectFile(projectId, file, existingValue, options = {}) {
    return window.ProjectFields.uploadFile(projectId, file, existingValue, options);
}

async function viewProjectFile(filePath) {
    if (!window.supabaseClient || !filePath) return;
    // Opens in the portal (FilePreview), never a new tab.
    window.FilePreview.open({
        name: String(filePath).split("/").pop().replace(/^\d{10,}-/, ""),
        getUrl: async () => {
            const { data, error } = await window.supabaseClient.storage.from(PROJECT_DOCS_BUCKET).createSignedUrl(filePath, 60 * 5);
            if (error || !data?.signedUrl) throw error || new Error("no url");
            return data.signedUrl;
        },
    });
}

async function saveProjectFromWizard(successMessage) {
    const state = projectWizardState;
    if (!state) return;

    const nextBtn = document.getElementById("projectWizardNextBtn");
    const saveLaterBtn = document.getElementById("projectWizardSaveLaterBtn");

    if (!projectsCan(state.id ? "projects.edit" : "projects.create")) {
        setWizardMessage("You don't have permission to do this.", "error");
        return;
    }

    [nextBtn, saveLaterBtn].forEach(btn => { if (btn) btn.disabled = true; });
    setWizardMessage("Saving…", "");

    try {
        const staff = currentStaffInfo();

        // Build the payload from every non-file column tracked by the wizard.
        const payload = { ...state.values };
        if (!payload.name) payload.name = "Untitled Project";

        let savedId = state.id;

        if (savedId) {
            const { error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .update(payload)
                .eq("id", savedId);
            if (error) throw error;
        } else {
            payload.created_by_id = staff.id;
            payload.created_by_name = staff.name;
            const { data, error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .insert(payload)
                .select()
                .single();
            if (error) throw error;
            savedId = data.id;
            state.id = savedId;
        }

        // Upload any newly-selected files, then patch just those columns.
        const fileUpdates = {};
        for (const step of WIZARD_STEPS) {
            for (const field of step.fields) {
                if (field.type !== "file") continue;
                const file = state.pendingFiles[field.name];
                if (!file) continue;
                const newValue = await uploadProjectFile(savedId, file, state.values[field.pathField], {
                    bucket: field.bucket,
                    publicBucket: field.publicBucket
                });
                fileUpdates[field.pathField] = newValue;
                state.values[field.pathField] = newValue;
            }
        }

        if (Object.keys(fileUpdates).length) {
            const { error } = await window.supabaseClient
                .from(PROJECTS_TABLE)
                .update(fileUpdates)
                .eq("id", savedId);
            if (error) throw error;
        }

        closeProjectWizard();
        setProjectPageMessage(successMessage, "success");
        await loadProjects();

    } catch (error) {
        console.error("Failed to save project:", error);
        setWizardMessage("Something went wrong saving this project. Please try again.", "error");
    } finally {
        [nextBtn, saveLaterBtn].forEach(btn => { if (btn) btn.disabled = false; });
    }
}

/* ===========================
   DELETE
=========================== */

// Typing the project's own name to confirm (same pattern GitHub uses for
// "delete this repo") -- cheap insurance against the one-click "Delete" +
// "Delete" confirm dialog getting fat-fingered on the wrong project, which
// is otherwise unrecoverable (see the popup's own warning box).
function deleteProjectConfirmNameMatches() {
    const expected = (projectWizardState && projectWizardState.values && projectWizardState.values.name) || "";
    const typed = document.getElementById("deleteProjectConfirmNameInput").value;
    // Exact match, but forgiving of leading/trailing whitespace the user
    // didn't mean to type -- the project name itself is compared as-is
    // (case-sensitive), same as GitHub's own version of this pattern.
    return expected.length > 0 && typed.trim() === expected;
}

// Both the typed name AND the "I understand" checkbox have to be satisfied
// -- two independent, cheap confirmations rather than relying on either one
// alone to catch every "clicked through too fast" scenario.
function deleteProjectConfirmReady() {
    return deleteProjectConfirmNameMatches()
        && document.getElementById("deleteProjectConfirmUnderstandCheckbox").checked;
}

function updateDeleteProjectConfirmBtnState() {
    document.getElementById("confirmDeleteProjectBtn").disabled = !deleteProjectConfirmReady();
}

function openDeleteProjectConfirm() {
    if (!projectWizardState || !projectWizardState.id) return;
    if (!projectsCan("projects.delete")) return;
    const name = (projectWizardState.values && projectWizardState.values.name) || "this project";
    document.getElementById("deleteProjectConfirmName").textContent = name;
    const input = document.getElementById("deleteProjectConfirmNameInput");
    input.value = "";
    document.getElementById("deleteProjectConfirmUnderstandCheckbox").checked = false;
    document.getElementById("deleteProjectConfirmMessage").textContent = "";
    document.getElementById("deleteProjectConfirmOverlay").classList.remove("hidden");
    updateDeleteProjectConfirmBtnState();
    input.focus();
}

function closeDeleteProjectConfirm() {
    document.getElementById("deleteProjectConfirmOverlay").classList.add("hidden");
    if (!anyProjectOverlayOpen()) document.body.classList.remove("popup-active");
}

async function confirmDeleteProject() {
    if (!projectWizardState || !projectWizardState.id) return;
    if (!projectsCan("projects.delete")) return;
    // Belt-and-suspenders: the button is only ever enabled once both
    // conditions are met (see updateDeleteProjectConfirmBtnState), but
    // re-check here too rather than trust button state alone as the only
    // gate on an unrecoverable delete.
    if (!deleteProjectConfirmReady()) return;

    const confirmBtn = document.getElementById("confirmDeleteProjectBtn");
    confirmBtn.disabled = true;

    try {
        const projectId = projectWizardState.id;

        // Group file cleanup by bucket — private docs (project-documents)
        // store a bare path, the public cover photo (project-covers) stores
        // a full URL that needs the path pulled back out of it.
        const filesByBucket = {};
        WIZARD_STEPS.flatMap(step => step.fields).filter(f => f.type === "file").forEach(field => {
            const rawValue = projectWizardState.values[field.pathField];
            if (!rawValue) return;
            const bucket = field.bucket || PROJECT_DOCS_BUCKET;
            const path = field.publicBucket ? storagePathFromPublicUrl(rawValue, bucket) : rawValue;
            if (!path) return;
            (filesByBucket[bucket] = filesByBucket[bucket] || []).push(path);
        });

        const { error } = await window.supabaseClient
            .from(PROJECTS_TABLE)
            .delete()
            .eq("id", projectId);

        if (error) throw error;

        Object.entries(filesByBucket).forEach(([bucket, paths]) => {
            window.supabaseClient.storage.from(bucket).remove(paths)
                .catch(err => console.warn(`Couldn't remove project files from ${bucket}:`, err));
        });

        closeDeleteProjectConfirm();
        closeProjectWizard();
        setProjectPageMessage("Project deleted.", "success");
        await loadProjects();

    } catch (error) {
        // Log as a flat string, not the raw error object — Chrome's console
        // collapses a logged object into an unexpandable "Object" placeholder
        // when the text gets copy-pasted out of devtools (rather than
        // expanded and copied field-by-field), which makes the underlying
        // Postgres/PostgREST error (code/message/details/hint) impossible to
        // read back later. A single readable line survives copy-paste.
        const code = error && error.code;
        const message = (error && error.message) || String(error);
        const details = error && error.details;
        console.error(`Failed to delete project: [${code || "?"}] ${message}${details ? " — " + details : ""}`);

        // A 23503 (foreign_key_violation) means some other table still has
        // rows pointing at this project that neither cascade-delete nor
        // null-out on a project delete. Pull the blocking table's name
        // straight out of Postgres's own "Key is still referenced from
        // table "X"." detail text so the message tells us (and Coleby)
        // exactly what to go fix, instead of a generic dead end.
        const refTableMatch = details && details.match(/table "([^"]+)"/);
        document.getElementById("deleteProjectConfirmMessage").textContent = refTableMatch
            ? `Can't delete this project — it still has related records in "${refTableMatch[1]}" that are blocking the delete (error ${code}).`
            : "Something went wrong deleting this project. Please try again.";
        document.getElementById("deleteProjectConfirmMessage").className = "auth-message error";
    } finally {
        confirmBtn.disabled = false;
    }
}

/* ===========================
   WIRE UP
=========================== */

document.addEventListener("DOMContentLoaded", () => {

    applyProjectPermissionsToUI();

    const addBtn = document.getElementById("addProjectBtn");
    if (addBtn) addBtn.addEventListener("click", () => openProjectWizard(null));

    const searchInput = document.getElementById("projectSearchInput");
    if (searchInput) searchInput.addEventListener("input", () => {
        projectCurrentPage = 1;
        refreshProjectsView();
    });

    initProjectViewToggle();
    initProjectTabs();

    const prevPageBtn = document.getElementById("projectPrevPageBtn");
    if (prevPageBtn) prevPageBtn.addEventListener("click", () => {
        if (projectCurrentPage > 1) { projectCurrentPage--; refreshProjectsView(); }
    });

    const nextPageBtn = document.getElementById("projectNextPageBtn");
    if (nextPageBtn) nextPageBtn.addEventListener("click", () => {
        projectCurrentPage++;
        refreshProjectsView();
    });

    const pageSizeSelect = document.getElementById("projectPageSizeSelect");
    if (pageSizeSelect) pageSizeSelect.addEventListener("change", () => {
        projectPageSize = Number(pageSizeSelect.value) || 6;
        projectCurrentPage = 1;
        refreshProjectsView();
    });

    const quickEditCancelBtn = document.getElementById("projectQuickEditCancelBtn");
    if (quickEditCancelBtn) quickEditCancelBtn.addEventListener("click", closeProjectQuickEdit);

    const quickEditSaveBtn = document.getElementById("projectQuickEditSaveBtn");
    if (quickEditSaveBtn) quickEditSaveBtn.addEventListener("click", saveProjectQuickEdit);

    const quickEditOverlay = document.getElementById("projectQuickEditOverlay");
    if (quickEditOverlay) {
        quickEditOverlay.addEventListener("click", (event) => {
            if (event.target === quickEditOverlay) closeProjectQuickEdit();
        });
    }

    const cancelBtn = document.getElementById("projectWizardCancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeProjectWizard);

    const wizardOverlay = document.getElementById("projectWizardModalOverlay");
    if (wizardOverlay) {
        wizardOverlay.addEventListener("click", (event) => {
            if (event.target === wizardOverlay) closeProjectWizard();
        });
    }

    const backBtn = document.getElementById("projectWizardBackBtn");
    if (backBtn) backBtn.addEventListener("click", wizardGoBack);

    const skipBtn = document.getElementById("projectWizardSkipBtn");
    if (skipBtn) skipBtn.addEventListener("click", wizardSkipStep);

    const nextBtn = document.getElementById("projectWizardNextBtn");
    if (nextBtn) nextBtn.addEventListener("click", wizardGoNext);

    const saveLaterBtn = document.getElementById("projectWizardSaveLaterBtn");
    if (saveLaterBtn) saveLaterBtn.addEventListener("click", wizardSaveAndFinishLater);

    const deleteBtn = document.getElementById("deleteProjectBtn");
    if (deleteBtn) deleteBtn.addEventListener("click", openDeleteProjectConfirm);

    const cancelDeleteBtn = document.getElementById("cancelDeleteProjectBtn");
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteProjectConfirm);

    const confirmDeleteBtn = document.getElementById("confirmDeleteProjectBtn");
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", confirmDeleteProject);

    const deleteNameInput = document.getElementById("deleteProjectConfirmNameInput");
    if (deleteNameInput) deleteNameInput.addEventListener("input", updateDeleteProjectConfirmBtnState);

    const deleteUnderstandCheckbox = document.getElementById("deleteProjectConfirmUnderstandCheckbox");
    if (deleteUnderstandCheckbox) deleteUnderstandCheckbox.addEventListener("change", updateDeleteProjectConfirmBtnState);

    loadProjects().then(() => {
        // Deep link from projects.html's "Edit Project" button
        // (project-home.html?openWizard=ID) — open that project straight
        // into the edit wizard, then clean the URL so a refresh doesn't
        // reopen it.
        const openWizardId = new URLSearchParams(window.location.search).get("openWizard");
        if (!openWizardId) return;

        const project = allProjects.find(p => String(p.id) === String(openWizardId));
        if (project) openProjectWizard(project);

        const url = new URL(window.location.href);
        url.searchParams.delete("openWizard");
        window.history.replaceState({}, "", url);
    });
});
