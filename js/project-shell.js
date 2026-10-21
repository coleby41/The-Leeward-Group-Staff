/* ===========================================================
   PROJECT DASHBOARD SHELL (shared by projects.html, project-files.html,
   project-timeline.html, project-to-do.html, project-accounting.html,
   project-site-plans.html, project-contract.html)

   Handles everything these pages have in common:
     - reads ?id= from the URL and loads that project from public.projects
     - fills in the header project name, breadcrumb, and document title
     - rewrites every sidebar nav link (anything with [data-nav-page]) to
       carry the current project id, and marks the current page's own
       nav item active
     - populates the project-switcher dropdown with every other project
     - wires the sidebar "search everything in this project" box, which
       searches the CURRENT project's own field values (via
       window.ProjectFields) and links each result to wherever that
       field actually lives

   Each page's own inline script listens for the "project-shell:ready"
   event (detail: { project, error }) to render its own main content —
   this file only owns the chrome (header + sidebar), not the page body.

   Requires project-fields.js to be loaded first.
=========================================================== */

(function () {
    "use strict";

    const PF = window.ProjectFields;
    const TIMELINE_TABLE = "project_timeline_items";
    const TODO_ITEMS_TABLE = "project_todo_items";
    const TODO_SUBITEMS_TABLE = "project_todo_subitems";
    const PROJECT_FILES_TABLE = "project_files";
    const PROJECT_EVENTS_TABLE = "project_events";
    const PROJECT_ACTIVITY_TABLE = "project_activity";

    // Search data for every source below, fetched once per project load —
    // see loadSearchData(). The sidebar search box lives on every
    // project-*.html page, not just the page each source "belongs" to, so
    // it can't rely on that page's own script to have loaded this data; it
    // fetches its own copy independently. Populated in the background (not
    // awaited before project-shell:ready fires) since it's a nice-to-have,
    // not something the rest of the page should wait on.
    let searchTimelineData = [];
    let searchTodoItemsData = [];
    let searchTodoSubitemsByItemId = {};
    let searchFilesData = [];    // project_files — every document in All Files, uploaded or form-filed
    let searchEventsData = [];   // project_events — everything on the Overview "Upcoming Events" panel, not just the future/limit-5 slice that panel shows
    let searchActivityData = []; // project_activity — the append-only audit feed behind "Recent Activity"; capped (see loadSearchData) since it only grows
    let rerenderSearchResults = null; // set by wireSidebarSearch — lets loadSearchData refresh results already on screen once it resolves

    function escapeHtmlShell(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function currentFileName() {
        return decodeURIComponent(window.location.pathname.split("/").pop() || "");
    }

    function getProjectIdFromUrl() {
        return new URLSearchParams(window.location.search).get("id");
    }

    function buildPageUrl(fileName, projectId, hash) {
        const params = projectId ? `?id=${encodeURIComponent(projectId)}` : "";
        return `${fileName}${params}${hash ? `#${hash}` : ""}`;
    }

    /* ===========================
       NAV LINKS — carry the id, mark the active tab
    =========================== */

    function wireNavLinks(projectId) {
        document.querySelectorAll(".sidebar-nav a[data-nav-page]").forEach(link => {
            const page = link.dataset.navPage;
            link.href = buildPageUrl(page, projectId);
            // data-nav-page is inconsistent across pages — most items carry
            // a root-relative path ("/pages/project-files.html"), one
            // ("Accounting") carries a bare filename — while
            // currentFileName() always returns just the bare filename.
            // Comparing the raw values against each other meant the
            // "/pages/..." form could never match, so the current page's
            // nav item never actually got its .active highlight. Compare by
            // basename on both sides instead so it works regardless of
            // which form a given item uses.
            const pageFileName = page.split("/").pop();
            link.classList.toggle("active", pageFileName === currentFileName());
        });
    }

    // Bid Invites (beta) tab — only for people who can send or manage bid
    // invites (sql/supabase-bid-invites-setup.sql). Starts hidden in the
    // markup so nobody sees it flash in and back out.
    async function applyBidInvitesNavVisibility() {
        const item = document.getElementById("bidInvitesNavItem");
        if (!item || !window.Permissions) return;
        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (e) { /* ignore */ }
        try { await window.Permissions.initPermissions(); } catch (e) { /* hasPermission fails open */ }
        const allowed = window.Permissions.hasPermission("vendors.send_bid_invites")
            || window.Permissions.hasPermission("projects.manage_bid_invites");
        item.style.display = allowed ? "" : "none";
    }

    /* ===========================
       HEADER — project name, breadcrumb, title
    =========================== */

    function renderHeaderForProject(project) {
        const nameEl = document.getElementById("headerProjectName");
        const crumbEl = document.getElementById("headerProjectBreadcrumb");
        const pageNameEl = document.getElementById("headerPageName");
        const pageName = pageNameEl ? pageNameEl.textContent.trim() : "";

        if (nameEl) nameEl.textContent = project ? (project.name || "Untitled project") : "Select a project";
        if (crumbEl) {
            crumbEl.innerHTML = `<a href="/pages/project-home.html">Home</a> → ${escapeHtmlShell(project ? (project.name || "Untitled project") : "No project selected")}`;
        }

        document.title = project
            ? `${project.name || "Untitled project"} — ${pageName} | The Leeward Group`
            : `Project Dashboard | The Leeward Group`;
    }

    function renderHeaderError() {
        const nameEl = document.getElementById("headerProjectName");
        const crumbEl = document.getElementById("headerProjectBreadcrumb");
        if (nameEl) nameEl.textContent = "No project selected";
        if (crumbEl) crumbEl.innerHTML = `<a href="/pages/project-home.html">Home</a> → Pick a project from Project Overview`;
    }

    /* ===========================
       PROJECT SWITCHER DROPDOWN
    =========================== */

    function wireSwitcherToggle() {
        const switcher = document.getElementById("projectSwitcher");
        const toggle = document.getElementById("projectSwitcherToggle");
        const dropdown = document.getElementById("projectSwitcherDropdown");
        if (!switcher || !toggle || !dropdown) return;

        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            const isOpen = !dropdown.classList.contains("hidden");
            dropdown.classList.toggle("hidden", isOpen);
            switcher.classList.toggle("is-open", !isOpen);
        });

        document.addEventListener("click", (event) => {
            if (!switcher.contains(event.target)) {
                dropdown.classList.add("hidden");
                switcher.classList.remove("is-open");
            }
        });
    }

    async function populateSwitcher(currentProjectId) {
        const dropdown = document.getElementById("projectSwitcherDropdown");
        if (!dropdown || !window.supabaseClient) return;

        const { data, error } = await window.supabaseClient
            .from(PF.PROJECTS_TABLE)
            .select("id, name")
            .order("name", { ascending: true });

        if (error) {
            dropdown.innerHTML = `<p class="project-switcher-empty">Couldn't load other projects.</p>`;
            return;
        }

        if (!data || data.length === 0) {
            dropdown.innerHTML = `<p class="project-switcher-empty">No projects yet.</p>`;
            return;
        }

        dropdown.innerHTML = data.map(p => `
            <button
                type="button"
                class="project-switcher-option ${String(p.id) === String(currentProjectId) ? "is-current" : ""}"
                data-project-id="${p.id}">
                ${escapeHtmlShell(p.name || "Untitled project")}
            </button>
        `).join("");

        dropdown.querySelectorAll(".project-switcher-option").forEach(btn => {
            btn.addEventListener("click", () => {
                window.location.href = buildPageUrl(currentFileName(), btn.dataset.projectId);
            });
        });
    }

    /* ===========================
       SIDEBAR SEARCH — "everything in this project"
       Every project-scoped data source in the app, one box: Project Files
       (All Files — uploads and form-filed documents), Project Timeline
       (phases/tasks/milestones), Project To-Do (big items + checklist
       rows), Events (the Overview "Upcoming Events" panel), Activity (the
       append-only "Recent Activity" audit feed), and the project's own
       field values (site address, dates, budget, etc. — via
       window.ProjectFields). RFIs/Change Orders/Submittals are
       intentionally NOT searched here — those workflow pages were removed
       in favor of All Files (see the Project doc's Phase 3 notes); the
       underlying tables still exist but there's no page left to link a
       result to.

       Ranked, not just matched: every source scores its own results (see
       scoreMatch()) instead of the old "whichever source ran first wins
       the top slots" behavior, so the single most relevant hit — whatever
       source it's from — is always first, and results across all sources
       are merged into one ranked list before the display cap is applied.

       "Complex searching": each source builds one lowercase haystack per
       result (title/label + description + type + status + assignee name +
       formatted dates, depending on the source) and the query is split on
       whitespace into terms that ALL have to appear somewhere in that
       haystack, in any order — so "sarah foundation" finds a task titled
       "Pour foundation" assigned to Sarah Diaz, not just a literal
       "sarah foundation" substring.
    =========================== */

    const SEARCH_RESULTS_LIMIT = 15;

    function queryTerms(query) {
        return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    }

    function escapeRegexShell(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // Every result gets one relevance score instead of a fixed source
    // order: an exact match on the primary field (title/filename/summary)
    // scores highest, a prefix match next, all terms present in the
    // primary field next, and a match that only lands in secondary fields
    // (description, assignee, dates, status, ...) lowest — with a small
    // per-term bonus for how much of the match actually landed in the
    // primary field. Returns null (no push) when the terms don't all
    // appear somewhere in the combined haystack at all.
    function scoreMatch(primaryText, secondaryParts, terms) {
        const primary = (primaryText || "").toLowerCase();
        const haystack = [primaryText, ...secondaryParts].filter(Boolean).join(" ").toLowerCase();
        if (!terms.every(term => haystack.includes(term))) return null;

        const query = terms.join(" ");
        let score;
        if (primary === query) score = 100;
        else if (primary.startsWith(query)) score = 70;
        else if (terms.every(term => primary.includes(term))) score = 40;
        else score = 10;

        terms.forEach(term => { if (primary.includes(term)) score += 3; });
        return score;
    }

    function formatSearchDate(iso) {
        if (!iso) return "";
        return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    // Short form for full timestamps (project_activity.created_at) — the
    // result row already has limited width, and the exact time isn't the
    // point, just "roughly when."
    function formatSearchDateShort(iso) {
        if (!iso) return "";
        try {
            return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        } catch {
            return "";
        }
    }

    function searchProjectFields(project, terms) {
        const results = [];
        PF.WIZARD_STEPS.forEach(step => {
            step.fields.forEach(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                const raw = project[key];
                if (PF.isBlank(raw)) return;

                const value = String(raw);
                const displayValue = field.type === "file" ? value.split("/").pop() : value;
                const score = scoreMatch(displayValue, [field.label], terms);
                if (score === null) return;

                results.push({
                    sectionTitle: step.title,
                    label: field.label,
                    value: displayValue,
                    page: step.page,
                    anchor: `field-${field.name}`,
                    score
                });
            });
        });

        return results;
    }

    // typeLabel below is literally "task"/"phase"/"milestone" (whichever
    // this item actually is) and doubles as the search keyword for that
    // type — searching "task" surfaces task-type items specifically, not
    // phases or milestones too, same as searching "milestone" only
    // surfaces milestones.
    const TIMELINE_STATUS_LABEL = { not_started: "not started", in_progress: "in progress", on_hold: "on hold", completed: "completed" };

    function searchTimelineItems(terms) {
        const today = todayISODateShell();
        const results = [];

        searchTimelineData.forEach(item => {
            const isOverdue = item.status !== "completed" && !!item.end_date && item.end_date < today;
            const statusLabel = isOverdue ? "overdue" : (TIMELINE_STATUS_LABEL[item.status] || item.status || "");
            const typeLabel = item.type || "task";
            const dateText = item.type === "milestone"
                ? formatSearchDate(item.end_date)
                : [formatSearchDate(item.start_date), formatSearchDate(item.end_date)].filter(Boolean).join(" – ");

            const title = item.title || "Untitled";
            const score = scoreMatch(title, [item.description, typeLabel, statusLabel, item.assigned_to_name, dateText], terms);
            if (score === null) return;

            results.push({
                sectionTitle: "Timeline",
                label: `${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)}${statusLabel ? " · " + statusLabel : ""}`,
                value: title,
                page: "/pages/project-timeline.html",
                openItem: item.id,
                score
            });
        });

        return results;
    }

    function searchTodoItems(terms) {
        const results = [];

        searchTodoItemsData.forEach(item => {
            const title = item.title || "Untitled";
            const statusLabel = item.completed ? "complete" : "open";
            const score = scoreMatch(title, ["to-do", "task", statusLabel], terms);
            if (score !== null) {
                results.push({
                    sectionTitle: "To-Do",
                    label: item.completed ? "Completed" : "Open",
                    value: title,
                    page: "/pages/project-todo.html",
                    openItem: item.id,
                    score
                });
            }

            (searchTodoSubitemsByItemId[item.id] || []).forEach(sub => {
                const subLabel = sub.label || "Untitled";
                const subStatusLabel = sub.completed ? "complete" : "open";
                const subScore = scoreMatch(subLabel, [title, sub.assigned_to_name, formatSearchDate(sub.due_date), "to-do", "task", "checklist", subStatusLabel], terms);
                if (subScore === null) return;
                results.push({
                    sectionTitle: "To-Do",
                    label: `${title} · checklist`,
                    value: subLabel,
                    page: "/pages/project-todo.html",
                    openItem: item.id, // opens the parent item's panel, where this checklist row lives
                    score: subScore
                });
            });
        });

        return results;
    }

    // Files — every project_files row, whichever way it got there
    // (manual upload or an auto-filed form submission). Links straight to
    // the folder it's in (project-files.html reads these same params on
    // load and calls selectFolder()), not just the bare All Files page.
    function searchProjectFiles(terms) {
        const results = [];

        searchFilesData.forEach(file => {
            const name = file.file_name || "Untitled file";
            const meta = PF.getFileTypeMeta(name);
            const categoryLabel = PF.fileCategoryLabel(file.category);
            const subfolderLabel = PF.fileSubfolderLabel(file.category, file.subfolder);
            // A folder inside a folder (e.g. Back Charges - BC / BC With
            // Signature) — most files have no third level at all, in which
            // case this is just null and the label/link both collapse back
            // to the plain two-level shape, same as before this existed.
            const subSubfolderLabel = file.sub_subfolder
                ? PF.fileSubSubfolderLabel(file.category, file.subfolder, file.sub_subfolder)
                : null;
            const sourceLabel = file.source === "form_submission" ? "form" : "upload";

            const score = scoreMatch(name, [
                categoryLabel, subfolderLabel, subSubfolderLabel, meta.kind, sourceLabel,
                file.uploaded_by_name, formatSearchDate((file.created_at || "").slice(0, 10))
            ], terms);
            if (score === null) return;

            results.push({
                sectionTitle: "Files",
                label: subSubfolderLabel
                    ? `${categoryLabel} / ${subfolderLabel} / ${subSubfolderLabel}`
                    : `${categoryLabel} / ${subfolderLabel}`,
                value: name,
                page: "/pages/project-files.html",
                extraParams: subSubfolderLabel
                    ? { category: file.category, subfolder: file.subfolder, sub_subfolder: file.sub_subfolder }
                    : { category: file.category, subfolder: file.subfolder },
                score
            });
        });

        return results;
    }

    // Events — the full list, not just the future/limit-5 slice the
    // Overview "Upcoming Events" panel shows; search should find a past
    // event too ("when did we do the site walk"), not only upcoming ones.
    // No per-event page/anchor exists, so results land on the Overview
    // page itself, same as Activity below.
    function searchProjectEvents(terms) {
        const results = [];

        searchEventsData.forEach(event => {
            const title = event.title || "Untitled event";
            const typeLabel = (event.event_type || "other").replace(/_/g, " ");
            const dateText = formatSearchDate(event.event_date);

            const score = scoreMatch(title, [typeLabel, dateText, "event"], terms);
            if (score === null) return;

            results.push({
                sectionTitle: "Events",
                label: `${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)} · ${dateText}`,
                value: title,
                page: "/pages/projects.html",
                score
            });
        });

        return results;
    }

    // Activity — the append-only audit feed (RFI/change order/submittal/
    // task changes, per Phase 2). Capped in loadSearchData() since it's
    // the one source here that only ever grows over a project's life;
    // most recent 200 is plenty for "did someone touch X recently."
    function searchProjectActivity(terms) {
        const results = [];

        searchActivityData.forEach(entry => {
            const summary = entry.summary || "";
            if (!summary) return;
            const dateText = formatSearchDateShort(entry.created_at);

            const score = scoreMatch(summary, [entry.actor_name, dateText, "activity"], terms);
            if (score === null) return;

            results.push({
                sectionTitle: "Activity",
                label: `${entry.actor_name || "Someone"} · ${dateText}`,
                value: summary,
                page: "/pages/projects.html",
                score
            });
        });

        return results;
    }

    function todayISODateShell() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    async function loadSearchData(projectId) {
        if (!window.supabaseClient) return;

        const [timelineResult, todoItemsResult, todoSubitemsResult, filesResult, eventsResult, activityResult] = await Promise.all([
            window.supabaseClient
                .from(TIMELINE_TABLE)
                .select("id, type, title, description, status, start_date, end_date, assigned_to_name")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(TODO_ITEMS_TABLE)
                .select("id, title, completed")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(TODO_SUBITEMS_TABLE)
                .select("id, todo_item_id, label, assigned_to_name, due_date, completed")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(PROJECT_FILES_TABLE)
                .select("id, category, subfolder, sub_subfolder, file_name, source, uploaded_by_name, created_at")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(PROJECT_EVENTS_TABLE)
                .select("id, title, event_date, event_type")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(PROJECT_ACTIVITY_TABLE)
                .select("id, actor_name, summary, created_at")
                .eq("project_id", projectId)
                .order("created_at", { ascending: false })
                .limit(200)
        ]);

        if (!timelineResult.error) searchTimelineData = timelineResult.data || [];
        if (!todoItemsResult.error) searchTodoItemsData = todoItemsResult.data || [];
        if (!filesResult.error) searchFilesData = filesResult.data || [];
        if (!eventsResult.error) searchEventsData = eventsResult.data || [];
        if (!activityResult.error) searchActivityData = activityResult.data || [];

        searchTodoSubitemsByItemId = {};
        if (!todoSubitemsResult.error) {
            (todoSubitemsResult.data || []).forEach(sub => {
                (searchTodoSubitemsByItemId[sub.todo_item_id] = searchTodoSubitemsByItemId[sub.todo_item_id] || []).push(sub);
            });
        }

        // If the user already typed a query before this resolved, refresh
        // whatever's currently on screen rather than making them retype.
        if (rerenderSearchResults) rerenderSearchResults();
    }

    // result.extraParams (Files' category/subfolder, so the destination
    // page can jump straight to that folder) rides alongside the existing
    // openItem (Timeline/To-Do) and anchor (field results) mechanisms —
    // all three compose into one query string.
    function buildResultUrl(result, projectId) {
        const params = new URLSearchParams();
        params.set("id", projectId);
        if (result.openItem) params.set("openItem", result.openItem);
        if (result.extraParams) {
            Object.entries(result.extraParams).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== "") params.set(key, value);
            });
        }
        const hash = result.anchor ? `#${result.anchor}` : "";
        return `${result.page}?${params.toString()}${hash}`;
    }

    // Wraps every occurrence of any search term in <mark> so a scan of the
    // results list actually shows *why* each row matched, not just that it
    // did — text is HTML-escaped first, then the highlight markup is
    // layered on top of the now-safe string (terms can't contain raw HTML
    // at that point, so this can't reopen an XSS hole).
    function highlightMatches(text, terms) {
        const escaped = escapeHtmlShell(text ?? "");
        if (!terms.length) return escaped;
        const pattern = new RegExp(`(${terms.map(escapeRegexShell).join("|")})`, "gi");
        return escaped.replace(pattern, '<mark class="sidebar-search-match">$1</mark>');
    }

    function wireSidebarSearch(project) {
        const input = document.getElementById("sidebarSearchInput");
        const resultsEl = document.getElementById("sidebarSearchResults");
        const hintEl = document.getElementById("sidebarSearchShortcutHint");
        if (!input || !resultsEl) return;

        let currentResults = []; // last rendered, ranked results (URL pre-built) — what keyboard nav/Enter operates on
        let activeIndex = -1;

        function updateHintVisibility() {
            if (hintEl) hintEl.classList.toggle("is-hidden", input.value.trim().length > 0);
        }
        input.addEventListener("input", updateHintVisibility);

        function applyActiveHighlight() {
            resultsEl.querySelectorAll(".sidebar-search-result").forEach((el, i) => {
                const isActive = i === activeIndex;
                el.classList.toggle("is-active", isActive);
                if (isActive) el.scrollIntoView({ block: "nearest" });
            });
        }

        function renderResults() {
            const query = input.value;
            activeIndex = -1;

            if (!query.trim()) {
                resultsEl.classList.add("hidden");
                resultsEl.innerHTML = "";
                currentResults = [];
                return;
            }

            if (!project) {
                resultsEl.classList.remove("hidden");
                resultsEl.innerHTML = `<p class="sidebar-search-empty">Select a project first.</p>`;
                currentResults = [];
                return;
            }

            const terms = queryTerms(query);

            // Every source scores its own matches; merge and re-rank
            // together so the single best result — whichever source it
            // came from — always lands first, instead of one source's
            // results silently crowding out a more relevant hit from
            // another just because it ran earlier.
            const allResults = [
                ...searchProjectFiles(terms),
                ...searchTimelineItems(terms),
                ...searchTodoItems(terms),
                ...searchProjectEvents(terms),
                ...searchProjectActivity(terms),
                ...searchProjectFields(project, terms)
            ].sort((a, b) => b.score - a.score);

            const shown = allResults.slice(0, SEARCH_RESULTS_LIMIT);
            currentResults = shown.map(r => ({ ...r, url: buildResultUrl(r, project.id) }));

            resultsEl.classList.remove("hidden");

            if (!shown.length) {
                resultsEl.innerHTML = `<p class="sidebar-search-empty">No matches for "${escapeHtmlShell(query.trim())}" in this project.</p>`;
                return;
            }

            const rowsHtml = currentResults.map(r => `
                <a class="sidebar-search-result" href="${r.url}">
                    <span class="sidebar-search-result-label">${escapeHtmlShell(r.sectionTitle)} · ${highlightMatches(r.label, terms)}</span>
                    <span class="sidebar-search-result-value">${highlightMatches(r.value, terms)}</span>
                </a>
            `).join("");

            const countHtml = allResults.length > shown.length
                ? `<p class="sidebar-search-count">Showing ${shown.length} of ${allResults.length} matches — keep typing to narrow it down</p>`
                : "";

            resultsEl.innerHTML = rowsHtml + countHtml;
        }

        input.addEventListener("input", renderResults);
        input.addEventListener("focus", renderResults);
        rerenderSearchResults = renderResults;

        // Up/Down to move through results, Enter to go to the highlighted
        // one (or the top result if nothing's been highlighted yet),
        // Escape to dismiss — the same keyboard model as every other
        // command-bar-style search (Spotlight, Notion's ⌘K, ...).
        input.addEventListener("keydown", (event) => {
            if (resultsEl.classList.contains("hidden") || !currentResults.length) return;

            if (event.key === "ArrowDown") {
                event.preventDefault();
                activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
                applyActiveHighlight();
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
                applyActiveHighlight();
            } else if (event.key === "Enter") {
                const target = currentResults[activeIndex] || currentResults[0];
                if (target) {
                    event.preventDefault();
                    window.location.href = target.url;
                }
            } else if (event.key === "Escape") {
                resultsEl.classList.add("hidden");
                input.blur();
            }
        });

        document.addEventListener("click", (event) => {
            if (!event.target.closest(".sidebar-search-wrap")) {
                resultsEl.classList.add("hidden");
            }
        });
    }

    // If we arrived via a #field-xxx link, scroll to it and briefly
    // highlight it once the page's own content has rendered.
    function highlightHashTarget() {
        const hash = window.location.hash.replace("#", "");
        if (!hash) return;
        // Give the page's own render listener a tick to build the DOM.
        setTimeout(() => {
            const el = document.getElementById(hash);
            if (!el) return;
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("is-highlighted");
            setTimeout(() => el.classList.remove("is-highlighted"), 2500);
        }, 150);
    }

    /* ===========================
       ⌘F / CTRL+F -> SIDEBAR SEARCH
       Intercepts the browser's native "Find in page" shortcut and
       redirects it to the sidebar search box instead (Vercel-style
       command bar behavior). Wired at document level so it works
       regardless of what's currently focused on the page.
    =========================== */

    // Shared by the ⌘F/Ctrl+F shortcut below and the collapsed-rail search
    // icon (initSidebarSearchCollapsedButton()) — both need to expand the
    // sidebar back out of its icon-only rail before the real search input
    // is usable/focusable again.
    function expandSidebarIfCollapsed() {
        if (!document.body.classList.contains("sidebar-collapsed")) return;
        document.body.classList.remove("sidebar-collapsed");
        const collapseToggle = document.getElementById("sidebarCollapseToggle");
        if (collapseToggle) {
            collapseToggle.classList.remove("is-collapsed");
            collapseToggle.setAttribute("aria-label", "Collapse navigation");
        }
    }

    function initSearchShortcut() {
        document.addEventListener("keydown", (event) => {
            const key = event.key ? event.key.toLowerCase() : "";
            const isFindShortcut = (event.metaKey || event.ctrlKey) && key === "f";
            if (!isFindShortcut) return;

            const input = document.getElementById("sidebarSearchInput");
            if (!input) return;

            event.preventDefault();
            expandSidebarIfCollapsed();
            input.focus();
            input.select();
        });
    }

    /* ===========================
       COLLAPSED-RAIL SEARCH ICON
       .sidebar-search-wrap's real input/hint/results hide once the sidebar
       collapses to its 68px icon-only rail (styles.css), which previously
       left no visible way to search at all short of already knowing the
       ⌘F/Ctrl+F shortcut above. #sidebarSearchCollapsedBtn (in each page's
       own HTML, alongside the search box) takes that slot instead and
       reuses the exact same expand-then-focus behavior.
    =========================== */

    function initSidebarSearchCollapsedButton() {
        const btn = document.getElementById("sidebarSearchCollapsedBtn");
        const input = document.getElementById("sidebarSearchInput");
        if (!btn || !input) return;

        btn.addEventListener("click", () => {
            expandSidebarIfCollapsed();
            input.focus();
            input.select();
        });
    }

    /* ===========================
       SIDEBAR COLLAPSE TOGGLE
       A small round tab straddling the sidebar's right edge, vertically
       centered on the first nav item (Overview) — replaces the old
       hamburger menu on this page family. Collapses to an icon-only rail
       rather than hiding the sidebar entirely.

       `left` is CSS-driven (styles.css: left: var(--sidebar-width), same
       transition duration/easing as .sidebar's own width) so the toggle
       tracks the sidebar's animating edge every frame, not just at two
       JS-sampled instants. positionToggle() here only computes `top`,
       which depends on the first nav item's layout, not on
       --sidebar-width, and so never needs to move during the collapse
       animation itself.

       This used to also JS-compute `left` from sidebar.getBoundingClient-
       Rect(), read once synchronously right on click and again on the
       width transition's `transitionend`. That meant the toggle jumped
       straight to its POST-transition position immediately on click and
       then just sat there for the ~200ms the sidebar was still visually
       animating toward it underneath — confirmed by extracting and
       comparing frames from Coleby's screen recording of the toggle being
       clicked. Letting CSS drive `left` off the same custom property the
       sidebar's width already animates from fixes that without any JS
       polling loop.
    =========================== */

    function initSidebarCollapse() {
        const sidebar = document.getElementById("sidebar");
        if (!sidebar || document.getElementById("sidebarCollapseToggle")) return;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.id = "sidebarCollapseToggle";
        toggle.className = "sidebar-collapse-toggle";
        toggle.setAttribute("aria-label", "Collapse navigation");
        toggle.innerHTML = `<span class="sidebar-collapse-toggle-icon">&lsaquo;</span>`;
        document.body.appendChild(toggle);

        function positionToggle() {
            const firstItem = sidebar.querySelector(".sidebar-nav .nav-item");
            const anchorRect = (firstItem || sidebar).getBoundingClientRect();
            toggle.style.top = `${anchorRect.top + anchorRect.height / 2}px`;
        }

        // The arrow itself never changes character — it just rotates 180°
        // via CSS, which reads as a smooth flip rather than a hard swap.
        function setCollapsed(collapsed) {
            document.body.classList.toggle("sidebar-collapsed", collapsed);
            toggle.classList.toggle("is-collapsed", collapsed);
            toggle.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
        }

        toggle.addEventListener("click", () => {
            setCollapsed(!document.body.classList.contains("sidebar-collapsed"));
        });

        // top never changes during the collapse animation itself (it's
        // driven by the first nav item's position, not --sidebar-width),
        // but the viewport resizing could still shift that row's position.
        window.addEventListener("resize", positionToggle);

        positionToggle();
    }

    /* ===========================
       INIT
    =========================== */

    async function initProjectShell() {
        if (!window.supabaseClient) {
            setTimeout(initProjectShell, 150);
            return;
        }

        const projectId = getProjectIdFromUrl();
        wireNavLinks(projectId);
        applyBidInvitesNavVisibility(); // background — not awaited
        wireSwitcherToggle();

        if (!projectId) {
            renderHeaderError();
            wireSidebarSearch(null);
            window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: null, error: null } }));
            return;
        }

        // Reads go through PROJECTS_READ_VIEW, not the base table — it masks
        // the financial fields per-row for anyone without financial access
        // on this project (see supabase-rls-lockdown.sql). Writes elsewhere
        // in this app family still target PF.PROJECTS_TABLE directly.
        const { data, error } = await window.supabaseClient
            .from(PF.PROJECTS_READ_VIEW)
            .select("*")
            .eq("id", projectId)
            .maybeSingle();

        if (error || !data) {
            renderHeaderError();
            wireSidebarSearch(null);
            window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: null, error: error || new Error("Project not found") } }));
            return;
        }

        renderHeaderForProject(data);
        wireSidebarSearch(data);
        populateSwitcher(projectId);
        loadSearchData(projectId); // background — not awaited, see loadSearchData's own comment

        window.dispatchEvent(new CustomEvent("project-shell:ready", { detail: { project: data, error: null } }));

        highlightHashTarget();
    }

    document.addEventListener("DOMContentLoaded", () => {
        initSidebarCollapse();
        initSearchShortcut();
        initSidebarSearchCollapsedButton();
        initProjectShell();
    });

})();
