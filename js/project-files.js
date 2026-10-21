/* ===========================================================
   PROJECT FILES — "All Files" (project-files.html)

   A single project-scoped index (public.project_files) of every document
   filed under the fixed 11-category folder taxonomy
   (window.ProjectFields.PROJECT_FILE_CATEGORIES — single source of truth,
   also used by form-builder.js's "file into a project folder?" pickers).
   Two ways a row gets here:
     - source = 'upload'          — a plain file, uploaded directly on this
       page, stored in the project-documents bucket (same bucket/path
       convention/RLS as every other project file — see uploadFile() below).
     - source = 'form_submission' — a form template with a folder mapping
       (default_category/default_subfolder) was filled out; the matching
       project_files row is created automatically by a database trigger
       (file_form_submission() — see SQL FILES/
       supabase-project-files-schema.sql) the moment the submission is
       inserted. This page never writes those rows itself, only reads them.

   Waits for "project-shell:ready" (project-shell.js) to know which project
   we're on, same as every other project-*.html page.
=========================================================== */

(function () {
    "use strict";

    const PROJECT_FILES_TABLE = "project_files";
    const FORM_TEMPLATES_TABLE = "form_templates";
    const PROJECT_DOCS_BUCKET = "project-documents";
    const FORM_SUBMISSIONS_BUCKET = "form-submissions";

    let currentProject = null;
    let myProjectRole = null;        // via project_role() RPC — gates the Delete button the same way the RLS policy does
    let allFiles = [];               // project_files rows for this project, every folder
    let projectForms = [];           // form_templates rows with a folder mapping (default_category/default_subfolder set)
    let selectedCategory = null;
    let selectedSubfolder = null;
    let selectedSubSubfolder = null; // a folder inside a folder — see PROJECT_FILE_CATEGORIES' optional per-subfolder `subfolders` array ("back_charges" and "vpo" both have one)
    let expandedCategory = null;     // which category's subfolder list is open in the tree (List view)
    let expandedSubfolder = null;    // "categoryKey::subfolderKey" — which subfolder-with-children's own child list is open in the tree ("back_charges" and "vpo" both have children)
    let currentView = "list";        // "list" | "folders" — two ways to browse to the same folder
    let folderBrowseCategory = null; // Folders view drill state: null = showing the 11 category tiles, else showing that category's subfolder tiles
    let pendingDeleteFile = null;
    let pendingRenameFile = null;
    let pendingPreviewFile = null;
    let filesCurrentPage = 1;        // pagination over the currently-selected folder's file list — same component/behavior as project-home.html's project list pagination
    let filesPageSize = 10;

    /* ---------- file list column layout (resize + reorder) ----------
       Coleby: "In the project file let me able to adjust the columns" —
       both dragging a column's right edge to resize it, and dragging a
       column heading to reorder it. The Actions ("⋯") column stays pinned
       last — it's not a data column, so there's nothing to resize/reorder
       about it. Saved to localStorage (per-browser, like everything else
       client-side in this app) so the layout sticks across visits. */
    const PF_COLUMNS_STORAGE_KEY = "projectFilesColumnLayoutV1";
    const PF_COLUMN_DEFS = {
        name:     { label: "Name",      minWidth: 200, defaultWidth: 260 },
        kind:     { label: "Kind",      minWidth: 80,  defaultWidth: 170 },
        addedBy:  { label: "Added By",  minWidth: 80,  defaultWidth: 150 },
        uploaded: { label: "Uploaded",  minWidth: 80,  defaultWidth: 170 },
    };
    const PF_DEFAULT_COLUMN_ORDER = ["name", "kind", "addedBy", "uploaded"];

    function loadColumnLayout() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(PF_COLUMNS_STORAGE_KEY) || "null"); } catch { saved = null; }

        const widths = {};
        Object.keys(PF_COLUMN_DEFS).forEach(key => {
            const savedWidth = saved?.widths?.[key];
            widths[key] = (typeof savedWidth === "number" && savedWidth >= PF_COLUMN_DEFS[key].minWidth)
                ? savedWidth
                : PF_COLUMN_DEFS[key].defaultWidth;
        });

        // Defensive against a stale/corrupt saved order (missing a key,
        // or one that no longer exists) — falls back to the default order
        // rather than rendering a broken/incomplete header.
        let order = Array.isArray(saved?.order) ? saved.order.filter(k => PF_COLUMN_DEFS[k]) : [];
        PF_DEFAULT_COLUMN_ORDER.forEach(k => { if (!order.includes(k)) order.push(k); });

        return { order, widths };
    }

    let columnLayout = loadColumnLayout();

    function saveColumnLayout() {
        try { localStorage.setItem(PF_COLUMNS_STORAGE_KEY, JSON.stringify(columnLayout)); } catch { /* best-effort */ }
    }

    // Builds the grid-template-columns string shared by the header row and
    // every file row, in the CURRENT column order, so a reorder or resize
    // only ever has to touch this one string (applyColumnLayout() below
    // writes it onto both).
    function columnGridTemplate() {
        return columnLayout.order.map(key =>
            key === "name" ? `minmax(${columnLayout.widths.name}px, 1fr)` : `${columnLayout.widths[key]}px`
        ).join(" ") + " 40px";
    }

    // Below 860px the stylesheet collapses the list to just Name + Actions
    // (see the @media block in styles.css) — an inline style always wins
    // over a stylesheet rule regardless of a matching @media query, so this
    // has to step aside down there and let that rule apply, rather than
    // pinning the desktop column widths onto a phone-width screen.
    function applyColumnLayout() {
        const isNarrow = window.matchMedia("(max-width: 860px)").matches;
        const template = isNarrow ? "" : columnGridTemplate();
        const header = document.querySelector(".all-files-list-header");
        if (header) header.style.gridTemplateColumns = template;
        document.querySelectorAll(".all-files-file-row").forEach(row => { row.style.gridTemplateColumns = template; });
    }

    // Keeps the layout correct if the window is resized across the 860px
    // breakpoint without an intervening re-render (pagination, upload,
    // etc.) — cheap to just recompute on every resize since this only
    // touches a couple of style properties, no DOM rebuild.
    window.addEventListener("resize", () => {
        if (document.querySelector(".all-files-list-header")) applyColumnLayout();
    });

    // Column reordering (drag a header cell onto another) + resizing (drag
    // its right-edge handle) — reattached every render since renderMainPanel()
    // rebuilds the header from scratch each time. A reorder commits
    // immediately (saves + re-renders on drop); a resize updates the grid
    // template live while dragging and only saves once the drag ends, so a
    // mid-drag resize doesn't spam localStorage with every pixel of motion.
    function wireColumnHeaderInteractions(listEl) {
        const header = listEl.querySelector(".all-files-list-header");
        if (!header) return;

        let dragKey = null;
        header.querySelectorAll(".all-files-list-header-cell").forEach(cell => {
            cell.addEventListener("dragstart", (event) => {
                dragKey = cell.dataset.col;
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                cell.classList.add("is-dragging");
            });
            cell.addEventListener("dragend", () => {
                cell.classList.remove("is-dragging");
                dragKey = null;
            });
            cell.addEventListener("dragover", (event) => {
                if (!dragKey || dragKey === cell.dataset.col) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            });
            cell.addEventListener("drop", (event) => {
                event.preventDefault();
                const targetKey = cell.dataset.col;
                if (!dragKey || dragKey === targetKey) return;

                const order = columnLayout.order.slice();
                const fromIndex = order.indexOf(dragKey);
                const toIndex = order.indexOf(targetKey);
                if (fromIndex === -1 || toIndex === -1) return;
                order.splice(fromIndex, 1);
                order.splice(toIndex, 0, dragKey);
                columnLayout.order = order;
                saveColumnLayout();
                renderMainPanel();
            });
        });

        header.querySelectorAll(".pf-col-resize-handle").forEach(handle => {
            // Not draggable itself — it lives inside a draggable header
            // cell, so without this a resize-drag would also fire that
            // cell's own reorder dragstart.
            handle.addEventListener("dragstart", (event) => event.preventDefault());

            handle.addEventListener("mousedown", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const key = handle.dataset.resizeCol;
                const startX = event.clientX;
                const startWidth = columnLayout.widths[key];
                const minWidth = PF_COLUMN_DEFS[key].minWidth;

                function onMove(moveEvent) {
                    const delta = moveEvent.clientX - startX;
                    columnLayout.widths[key] = Math.max(minWidth, Math.round(startWidth + delta));
                    applyColumnLayout();
                }
                function onUp() {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    saveColumnLayout();
                }
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            });
        });
    }

    /* ---------- helpers ---------- */

    function escapeHtmlFiles(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getFilesStaffProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    function getFilesStaffName() {
        const profile = getFilesStaffProfile();
        return (profile && (profile.full_name || profile.username)) || "Staff";
    }

    function getFilesStaffId() {
        const profile = getFilesStaffProfile();
        return profile?.id || profile?.uid || null;
    }

    function setFilesPageMessage(text, type) {
        const el = document.getElementById("filesPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
        if (type === "success") setTimeout(() => { el.style.display = "none"; }, 4000);
    }

    function formatFileDate(isoString) {
        try {
            return new Date(isoString).toLocaleString(undefined, {
                month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
            });
        } catch {
            return isoString;
        }
    }

    function canManageFiles() {
        return myProjectRole === "project_admin" || myProjectRole === "project_manager";
    }

    function canDeleteFile(file) {
        return canManageFiles() || String(file.uploaded_by) === String(getFilesStaffId());
    }

    // getFileTypeMeta() moved to project-fields.js (window.ProjectFields)
    // so project-shell.js's sidebar search can show the same Kind label
    // for a file result as the All Files page itself, without a second
    // copy of the extension table to keep in sync.
    const getFileTypeMeta = window.ProjectFields.getFileTypeMeta;

    // Splits "Report.pdf" into { base: "Report", ext: ".pdf" } (ext keeps
    // the leading dot, or is "" for a file with no extension). A leading
    // dot with nothing before it (".gitignore"-style) is treated as having
    // no extension rather than an empty base name. Used by the rename
    // modal to keep the extension out of the editable field entirely.
    function splitFileNameExt(fileName) {
        const name = String(fileName || "");
        const idx = name.lastIndexOf(".");
        if (idx <= 0) return { base: name, ext: "" };
        return { base: name.slice(0, idx), ext: name.slice(idx) };
    }

    // Which extensions the Preview modal will attempt to render inline as
    // an <img>. HEIC/HEIF is included here even though it's not
    // universally decodable — Safari (macOS/iOS) renders it natively,
    // Chrome/Firefox/Edge generally don't — because previewFile() below
    // wires an onerror fallback on the <img> itself, so a browser that
    // can't decode it just falls through to the same "can't preview this"
    // + Download message every other unsupported type gets, instead of a
    // silently broken image icon. Anything not in this set and not "pdf"
    // skips straight to that fallback (see getPreviewKind()).
    const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif"]);

    function getPreviewKind(fileName) {
        const ext = splitFileNameExt(fileName).ext.replace(/^\./, "").toLowerCase();
        if (PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) return "image";
        if (ext === "pdf") return "pdf";
        return "none";
    }

    // A source='form_submission' row is always a real PDF (the form-filling
    // pipeline only ever produces a merged PDF, per mergeSubmissionAttachments()
    // in form-builder.js) — but its file_name comes from whatever the
    // submitter typed in "Name this file", and older submissions (saved
    // before form-builder.js started enforcing a .pdf suffix there) can be
    // missing the extension entirely. Rather than rely on that name being
    // right, treat it as known-PDF from the source field and only fall back
    // to guessing by extension for plain uploads. Same idea for the name
    // actually offered to the browser on download, so a legacy row still
    // saves with a real .pdf extension instead of none at all.
    function previewKindFor(file) {
        return file.source === "form_submission" ? "pdf" : getPreviewKind(file.file_name);
    }

    function downloadNameFor(file) {
        if (file.source === "form_submission" && !/\.pdf$/i.test(file.file_name || "")) {
            return `${file.file_name}.pdf`;
        }
        return file.file_name;
    }

    /* ---------- load ---------- */

    async function loadMyProjectRole(projectId) {
        const { data, error } = await window.supabaseClient.rpc("project_role", { p_project_id: projectId });
        if (error) { console.error("Failed to resolve project role:", error); myProjectRole = null; return; }
        myProjectRole = data;
    }

    async function loadFiles(projectId) {
        // form_submissions(form_title) rides along via the form_submission_id
        // foreign key, purely so a form-filed row's badge can say
        // "Form: <template title>" without a second query per row.
        const { data, error } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .select("*, form_submissions(form_title)")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Failed to load project files:", error);
            setFilesPageMessage("Couldn't load this project's files. Please try again.", "error");
            allFiles = [];
            return;
        }

        allFiles = data || [];
    }

    async function loadProjectForms() {
        const { data, error } = await window.supabaseClient
            .from(FORM_TEMPLATES_TABLE)
            .select("id, title, default_category, default_subfolder")
            .not("default_category", "is", null)
            .not("default_subfolder", "is", null);

        if (error) {
            console.error("Failed to load project-mapped form templates:", error);
            projectForms = [];
            return;
        }

        projectForms = data || [];
    }

    /* ---------- folder tree (left) ---------- */

    // subSubfolderKey is optional. Files filed directly in a subfolder that
    // HAS children (sub_subfolder left null, e.g. an old upload from before
    // "back_charges" gained its own subfolders) still show up here when
    // called with no third argument — a folder can hold both loose files
    // and child folders at once, same as any normal file explorer.
    function filesInFolder(categoryKey, subfolderKey, subSubfolderKey) {
        const wantSubSub = subSubfolderKey || null;
        return allFiles.filter(f => f.category === categoryKey && f.subfolder === subfolderKey && (f.sub_subfolder || null) === wantSubSub);
    }

    function filesInCategory(categoryKey) {
        return allFiles.filter(f => f.category === categoryKey);
    }

    // Coleby: "there should be no files in Back Charges - BC it should be
    // in one of the new folders" — once a subfolder has its own children,
    // it's a router only, never a place files sit directly. Governs both
    // whether renderMainPanel() shows an upload control/file list at that
    // level and whether uploadFiles()/the drop handler will actually
    // accept a file there. Any subfolder without children (the overwhelming
    // majority) is unaffected either way.
    function folderAcceptsFiles(categoryKey, subfolderKey, subSubfolderKey) {
        if (!categoryKey || !subfolderKey) return false;
        if (subSubfolderKey) return true; // the innermost level always accepts files
        const subfolder = window.ProjectFields.findFileSubfolder(categoryKey, subfolderKey);
        return !(subfolder?.subfolders?.length);
    }

    // The count badge shown ON a subfolder that has children reads as
    // "everything filed under here" (direct files + every child's files),
    // not just whatever's sitting loose at that exact level — matches what
    // filesInCategory() already does one level up for a category's badge.
    function filesInSubfolderTree(categoryKey, subfolderKey) {
        const subfolder = window.ProjectFields.findFileSubfolder(categoryKey, subfolderKey);
        const direct = filesInFolder(categoryKey, subfolderKey).length;
        const children = subfolder?.subfolders || [];
        if (!children.length) return direct;
        return direct + children.reduce((sum, child) => sum + filesInFolder(categoryKey, subfolderKey, child.key).length, 0);
    }

    function renderTree() {
        const treeEl = document.getElementById("filesTree");
        if (!treeEl) return;

        const categories = (window.ProjectFields && window.ProjectFields.PROJECT_FILE_CATEGORIES) || [];

        treeEl.innerHTML = categories.map(category => {
            const isExpanded = expandedCategory === category.key;
            const categoryCount = filesInCategory(category.key).length;

            const subfoldersHtml = category.subfolders.map(subfolder => {
                const children = subfolder.subfolders || [];
                const hasChildren = children.length > 0;
                const groupKey = `${category.key}::${subfolder.key}`;
                const isSubExpanded = hasChildren && expandedSubfolder === groupKey;

                // A subfolder with no children is selectable exactly as
                // before. One WITH children is a router, not a destination
                // (see folderAcceptsFiles() — Coleby: "there should be no
                // files in Back Charges - BC"), so it's no longer
                // individually selected here — Coleby then asked for it to
                // "feel like" the top-level category row while staying put
                // under its own category: bold label, a caret, and the same
                // pill highlight while expanded, expanding/collapsing in
                // place rather than opening a page of its own.
                const isSelected = !hasChildren && selectedCategory === category.key && selectedSubfolder === subfolder.key && !selectedSubSubfolder;
                const count = hasChildren ? filesInSubfolderTree(category.key, subfolder.key) : filesInFolder(category.key, subfolder.key).length;

                const childrenHtml = hasChildren ? `
                    <div class="all-files-subsubfolder-list${isSubExpanded ? "" : " is-collapsed"}">
                        ${children.map(child => {
                            const childSelected = selectedCategory === category.key && selectedSubfolder === subfolder.key && selectedSubSubfolder === child.key;
                            const childCount = filesInFolder(category.key, subfolder.key, child.key).length;
                            return `
                                <button type="button" class="all-files-subfolder-btn all-files-subsubfolder-btn${childSelected ? " is-selected" : ""}"
                                        data-category="${escapeHtmlFiles(category.key)}" data-subfolder="${escapeHtmlFiles(subfolder.key)}" data-subsubfolder="${escapeHtmlFiles(child.key)}">
                                    <span class="all-files-subfolder-label">${escapeHtmlFiles(child.label)}</span>
                                    <span class="all-files-folder-count${childCount ? "" : " all-files-folder-count--zero"}">${childCount}</span>
                                </button>
                            `;
                        }).join("")}
                    </div>
                ` : "";

                const groupClass = hasChildren ? ` all-files-subfolder-btn--group${isSubExpanded ? " is-expanded" : ""}` : "";
                return `
                    <button type="button" class="all-files-subfolder-btn${isSelected ? " is-selected" : ""}${groupClass}"
                            data-category="${escapeHtmlFiles(category.key)}" data-subfolder="${escapeHtmlFiles(subfolder.key)}"${hasChildren ? ' data-has-children="1"' : ""}>
                        ${hasChildren ? `<span class="all-files-subfolder-caret">${isSubExpanded ? "⌄" : "›"}</span>` : ""}
                        <span class="all-files-subfolder-label">${escapeHtmlFiles(subfolder.label)}</span>
                        <span class="all-files-folder-count${count ? "" : " all-files-folder-count--zero"}">${count}</span>
                    </button>
                    ${childrenHtml}
                `;
            }).join("");

            return `
                <div class="all-files-category${isExpanded ? " is-expanded" : ""}">
                    <button type="button" class="all-files-category-btn" data-category="${escapeHtmlFiles(category.key)}">
                        <span class="all-files-category-caret">${isExpanded ? "⌄" : "›"}</span>
                        <span class="all-files-category-label">${escapeHtmlFiles(category.number)} — ${escapeHtmlFiles(category.label)}</span>
                        <span class="all-files-folder-count${categoryCount ? "" : " all-files-folder-count--zero"}">${categoryCount}</span>
                    </button>
                    <div class="all-files-subfolder-list">${subfoldersHtml}</div>
                </div>
            `;
        }).join("");

        treeEl.querySelectorAll(".all-files-category-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.category;
                expandedCategory = expandedCategory === key ? null : key;
                renderTree();
            });
        });

        // .all-files-subsubfolder-btn carries .all-files-subfolder-btn too
        // (shares its styling), so this one selector wires both levels —
        // dataset.subsubfolder is only present on the child buttons.
        // dataset.hasChildren marks the router row itself (e.g. "Back
        // Charges - BC"): clicking it just expands/collapses its own
        // children in place, like a category caret, rather than
        // navigating anywhere — it has nothing of its own to open.
        treeEl.querySelectorAll(".all-files-subfolder-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                if (btn.dataset.hasChildren) {
                    const key = `${btn.dataset.category}::${btn.dataset.subfolder}`;
                    expandedSubfolder = expandedSubfolder === key ? null : key;
                    renderTree();
                    return;
                }
                selectFolder(btn.dataset.category, btn.dataset.subfolder, btn.dataset.subsubfolder);
            });
        });
    }

    // Selecting a folder is shared by both views (the tree's subfolder
    // buttons and the Folders view's subfolder tiles both call this), so
    // List and Folders always agree on what's currently open.
    function selectFolder(categoryKey, subfolderKey, subSubfolderKey) {
        selectedCategory = categoryKey;
        selectedSubfolder = subfolderKey;
        selectedSubSubfolder = subSubfolderKey || null;
        expandedCategory = categoryKey;
        folderBrowseCategory = categoryKey;
        // Arriving at a subfolder-with-children (or one of its own
        // children) via any path other than the tree's own caret — a
        // Folders-view tile, a search result, a deep link — should still
        // auto-open it in the tree, same as expandedCategory above.
        const subfolder = window.ProjectFields.findFileSubfolder(categoryKey, subfolderKey);
        if (subfolder?.subfolders?.length) {
            expandedSubfolder = `${categoryKey}::${subfolderKey}`;
        }
        filesCurrentPage = 1; // switching folders always starts back on page 1 of the new list
        render();
    }

    /* ---------- main panel (right) ---------- */

    function renderMainPanel() {
        const titleEl = document.getElementById("filesCurrentFolderTitle");
        const actionsEl = document.getElementById("filesFolderActions");
        const hintEl = document.getElementById("filesNoFolderHint");
        const emptyEl = document.getElementById("filesFolderEmpty");
        const listEl = document.getElementById("filesFolderList");
        const childGridEl = document.getElementById("filesPanelChildGrid");
        if (!titleEl || !actionsEl || !listEl) return;

        if (!selectedCategory || !selectedSubfolder) {
            titleEl.textContent = "Select a folder";
            actionsEl.innerHTML = "";
            if (hintEl) hintEl.style.display = "block";
            if (emptyEl) emptyEl.style.display = "none";
            if (childGridEl) { childGridEl.style.display = "none"; childGridEl.innerHTML = ""; }
            listEl.innerHTML = "";
            renderFilesPagination(0);
            return;
        }

        if (hintEl) hintEl.style.display = "none";

        // Reset to the normal "no files yet" copy on every render — the
        // router-only branch below overwrites this text, and without
        // resetting it here first that override would stick even after
        // navigating away to an ordinary folder.
        if (emptyEl) emptyEl.innerHTML = `<p>No files in this folder yet. Drag and drop files here, or use Upload File(s) above.</p>`;

        const category = window.ProjectFields.findFileCategory(selectedCategory);
        const subfolder = window.ProjectFields.findFileSubfolder(selectedCategory, selectedSubfolder);
        const subSubfolder = selectedSubSubfolder
            ? window.ProjectFields.findFileSubSubfolder(selectedCategory, selectedSubfolder, selectedSubSubfolder)
            : null;

        const titleParts = [category?.label, subfolder?.label, subSubfolder?.label].filter(Boolean);
        titleEl.textContent = titleParts.length ? titleParts.join(" / ") : "Folder";

        // A folder inside a folder: the selected subfolder has its own
        // children and none is picked yet — show them as tiles, same
        // .all-files-folder-tile look as the Folders view's own grid, right
        // above whatever's filed loose in this subfolder itself.
        const children = (!selectedSubSubfolder && subfolder?.subfolders) || [];
        if (childGridEl) {
            if (children.length) {
                childGridEl.style.display = "grid";
                childGridEl.innerHTML = "";
                children.forEach(child => {
                    childGridEl.appendChild(folderIconTile({
                        key: child.key,
                        label: child.label,
                        count: filesInFolder(selectedCategory, selectedSubfolder, child.key).length,
                        onClick: () => selectFolder(selectedCategory, selectedSubfolder, child.key)
                    }));
                });
            } else {
                childGridEl.style.display = "none";
                childGridEl.innerHTML = "";
            }
        }

        // A subfolder with children is a router only — no upload control,
        // no fill-a-form links, and no file list of its own. Coleby:
        // "there should be no files in Back Charges - BC it should be in
        // one of the new folder[s]". Stop here once the child tiles above
        // are in place; folderAcceptsFiles() enforces the same rule against
        // uploadFiles()/drag-and-drop so this can't be bypassed either.
        if (children.length) {
            actionsEl.innerHTML = "";
            listEl.innerHTML = "";
            if (emptyEl) {
                emptyEl.style.display = "block";
                emptyEl.innerHTML = `<p>This folder just organizes the folders above — choose one to view or upload files.</p>`;
            }
            renderFilesPagination(0);
            return;
        }

        // A project form's default_subfolder only ever names a subfolder,
        // never a sub-subfolder, so these only show at that middle level —
        // once you're inside a specific sub-subfolder there's nothing here
        // to match against (deliberate: no form template targets a
        // sub-subfolder today).
        const matchingForms = selectedSubSubfolder
            ? []
            : projectForms.filter(f => f.default_category === selectedCategory && f.default_subfolder === selectedSubfolder);

        actionsEl.innerHTML = `
            <button type="button" class="workbook-btn workbook-btn--preview" id="filesUploadBtn">+ Upload File(s)</button>
            ${matchingForms.map(f => `
                <a class="workbook-btn workbook-btn--edit" href="/pages/form-template.html?project=${encodeURIComponent(currentProject.id)}&template=${encodeURIComponent(f.id)}">+ Fill ${escapeHtmlFiles(f.title)}</a>
            `).join("")}
        `;

        document.getElementById("filesUploadBtn")?.addEventListener("click", () => {
            document.getElementById("filesUploadInput")?.click();
        });

        const files = filesInFolder(selectedCategory, selectedSubfolder, selectedSubSubfolder);

        if (!files.length) {
            if (emptyEl) emptyEl.style.display = "block";
            listEl.innerHTML = "";
            renderFilesPagination(0);
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        // Paginate the same way project-home.html's project list does —
        // same component (.project-pagination/.project-page-btn/
        // .project-page-number, reused as-is) and the same
        // clamp-then-slice pattern, just keyed off this folder's file
        // count instead of the filtered project count. Clamping here
        // (rather than only in the click handlers) means a delete/upload
        // that shrinks the list below the current page can't strand the
        // view on an empty page.
        const totalPages = Math.max(1, Math.ceil(files.length / filesPageSize));
        if (filesCurrentPage > totalPages) filesCurrentPage = totalPages;
        if (filesCurrentPage < 1) filesCurrentPage = 1;
        const startIndex = (filesCurrentPage - 1) * filesPageSize;
        const pageFiles = files.slice(startIndex, startIndex + filesPageSize);

        // Finder-style list: a header row (Name / Kind / Added By /
        // Uploaded) followed by one row per file with a real file-type
        // icon, matching the macOS Finder list view the folder-mapping
        // design was modeled on. Open/Rename/Copy link/Delete are
        // consolidated behind a single "⋯" menu instead of one button per
        // action, same "overflow menu" shape used elsewhere in the app
        // (.project-edit-icon on project cards).
        // One cell-builder per data column key, so the header and every row
        // can be assembled in whatever order columnLayout.order currently
        // says (see the column-layout block above) instead of a fixed
        // Name/Kind/Added By/Uploaded sequence.
        function fileCellHtml(key, file, meta, isFormFiled) {
            if (key === "name") {
                return `
                    <div class="all-files-file-name-cell">
                        <span class="file-type-icon file-type-icon--${meta.type}"></span>
                        <div class="all-files-file-name-text">
                            <div class="all-files-file-name-main">${escapeHtmlFiles(file.file_name)}</div>
                            ${isFormFiled ? `
                                <div class="all-files-file-name-sub">
                                    <span class="chip chip--info">Form: ${escapeHtmlFiles(file.form_submissions?.form_title || "submission")}</span>
                                </div>
                            ` : ""}
                        </div>
                    </div>
                `;
            }
            if (key === "kind") return `<div class="all-files-file-kind-cell">${escapeHtmlFiles(meta.kind)}</div>`;
            if (key === "addedBy") return `<div class="all-files-file-added-by-cell">${escapeHtmlFiles(file.uploaded_by_name || "Staff")}</div>`;
            return `<div class="all-files-file-date-cell">${escapeHtmlFiles(formatFileDate(file.created_at))}</div>`; // "uploaded"
        }

        const rowsHtml = pageFiles.map(file => {
            const isFormFiled = file.source === "form_submission";
            // Same "uploader or leadership" policy gates both rename and delete.
            // Invoice files always show both so the popup can explain they're
            // managed on the Accounting page.
            const canManage = file.source === "invoice" || canDeleteFile(file);
            const meta = getFileTypeMeta(file.file_name);

            const dataCellsHtml = columnLayout.order.map(key => fileCellHtml(key, file, meta, isFormFiled)).join("");

            return `
                <div class="all-files-file-row" data-file-id="${file.id}">
                    ${dataCellsHtml}
                    <div class="all-files-file-actions-cell">
                        <button type="button" class="all-files-file-menu-btn" data-action="menu" aria-label="File actions" aria-haspopup="true" aria-expanded="false">
                            <span class="all-files-file-menu-icon"></span>
                        </button>
                        <div class="all-files-file-menu-dropdown">
                            <button type="button" class="all-files-file-menu-item" data-action="preview">Preview</button>
                            <button type="button" class="all-files-file-menu-item" data-action="download">Download</button>
                            ${canManage ? `<button type="button" class="all-files-file-menu-item" data-action="rename">Rename</button>` : ""}
                            <button type="button" class="all-files-file-menu-item" data-action="copy-link">Copy link</button>
                            ${canManage ? `
                                <div class="all-files-file-menu-divider"></div>
                                <button type="button" class="all-files-file-menu-item all-files-file-menu-item--danger" data-action="delete">Delete</button>
                            ` : ""}
                        </div>
                    </div>
                </div>
            `;
        }).join("");

        const headerCellsHtml = columnLayout.order.map(key => `
            <span class="all-files-list-header-cell" draggable="true" data-col="${key}">
                ${escapeHtmlFiles(PF_COLUMN_DEFS[key].label)}
                <span class="pf-col-resize-handle" data-resize-col="${key}"></span>
            </span>
        `).join("");

        listEl.innerHTML = `
            <div class="all-files-list">
                <div class="all-files-list-header">
                    ${headerCellsHtml}
                    <span></span>
                </div>
                ${rowsHtml}
            </div>
        `;

        applyColumnLayout();
        wireColumnHeaderInteractions(listEl);

        listEl.querySelectorAll(".all-files-file-row").forEach(row => {
            const file = files.find(f => String(f.id) === row.dataset.fileId);
            if (!file) return;

            const menuBtn = row.querySelector('[data-action="menu"]');
            const dropdown = row.querySelector(".all-files-file-menu-dropdown");

            menuBtn?.addEventListener("click", (event) => {
                event.stopPropagation();
                toggleFileRowMenu(menuBtn, dropdown);
            });

            // Right-click anywhere on the row opens this same "⋯" menu
            // instead of the browser's native context menu, positioned
            // right at the cursor (event.clientX/Y) rather than the "⋯"
            // button's usual spot.
            row.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                event.stopPropagation();
                openFileRowMenu(menuBtn, dropdown, { x: event.clientX, y: event.clientY });
            });

            row.querySelector('[data-action="preview"]')?.addEventListener("click", () => { closeAllFileMenus(); previewFile(file); });
            row.querySelector('[data-action="download"]')?.addEventListener("click", () => { closeAllFileMenus(); downloadFile(file); });
            row.querySelector('[data-action="rename"]')?.addEventListener("click", () => { closeAllFileMenus(); openRenameFileModal(file); });
            row.querySelector('[data-action="copy-link"]')?.addEventListener("click", () => { closeAllFileMenus(); copyFileLink(file); });
            row.querySelector('[data-action="delete"]')?.addEventListener("click", () => { closeAllFileMenus(); openDeleteFileConfirm(file); });
        });

        renderFilesPagination(files.length);
    }

    // Same component/behavior as project-home.html's project-list
    // pagination (renderProjectPagination() in projects-page.js) — reuses
    // its exact CSS classes (.project-pagination/.project-page-btn/
    // .project-page-number/...) so it's visually identical, just wired to
    // this folder's file count/page state instead of the project grid's.
    // Clicking a page number or the size select only needs to re-run
    // renderMainPanel() (not the full tree/breadcrumb render()), since
    // pagination never changes which folder is selected.
    function renderFilesPagination(totalCount) {
        const wrap = document.getElementById("filesPagination");
        const summary = document.getElementById("filesPaginationSummary");
        const pageNumbers = document.getElementById("filesPageNumbers");
        const prevBtn = document.getElementById("filesPrevPageBtn");
        const nextBtn = document.getElementById("filesNextPageBtn");
        if (!wrap || !summary || !pageNumbers || !prevBtn || !nextBtn) return;

        if (!totalCount) {
            wrap.style.display = "none";
            return;
        }
        wrap.style.display = "flex";

        const totalPages = Math.max(1, Math.ceil(totalCount / filesPageSize));
        const startIndex = (filesCurrentPage - 1) * filesPageSize;
        const endIndex = Math.min(totalCount, startIndex + filesPageSize);

        summary.textContent = `Showing ${startIndex + 1} to ${endIndex} of ${totalCount} files`;

        prevBtn.disabled = filesCurrentPage <= 1;
        nextBtn.disabled = filesCurrentPage >= totalPages;

        pageNumbers.innerHTML = "";
        for (let page = 1; page <= totalPages; page++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `project-page-number ${page === filesCurrentPage ? "active" : ""}`;
            btn.textContent = String(page);
            btn.addEventListener("click", () => {
                filesCurrentPage = page;
                renderMainPanel();
            });
            pageNumbers.appendChild(btn);
        }
    }

    // Opens a specific row's "⋯" menu (closing any other open one first —
    // only one at a time). Shared by the menu button's click handler and
    // the row's contextmenu handler.
    //
    // `atPoint` (optional {x, y} in viewport coordinates) is how the
    // right-click path makes the menu appear at the cursor instead of its
    // usual spot below the "⋯" button: the dropdown normally relies on
    // CSS (position: absolute; top/right) anchored to
    // .all-files-file-actions-cell, so landing it at the cursor means
    // switching it to position: fixed with inline top/left for just this
    // opening, then clearing those inline styles again for a plain "⋯"
    // click (the `else` branch) so it falls back to its normal
    // CSS-anchored position.
    function openFileRowMenu(menuBtn, dropdown, atPoint) {
        closeAllFileMenus();
        if (!dropdown || !menuBtn) return;
        dropdown.classList.add("is-open");
        menuBtn.classList.add("is-open");
        menuBtn.setAttribute("aria-expanded", "true");

        if (atPoint) {
            dropdown.style.position = "fixed";
            dropdown.style.right = "auto";
            dropdown.style.left = `${atPoint.x}px`;
            dropdown.style.top = `${atPoint.y}px`;

            // Nudge back on-screen if the cursor was near the right/bottom
            // edge — getBoundingClientRect() here forces the layout the
            // menu just got from adding "is-open", so this reads its real
            // rendered size rather than a stale (display:none) one.
            const rect = dropdown.getBoundingClientRect();
            const overflowX = rect.right - window.innerWidth;
            const overflowY = rect.bottom - window.innerHeight;
            if (overflowX > 0) dropdown.style.left = `${Math.max(4, atPoint.x - overflowX)}px`;
            if (overflowY > 0) dropdown.style.top = `${Math.max(4, atPoint.y - overflowY)}px`;
        } else {
            dropdown.style.position = "";
            dropdown.style.right = "";
            dropdown.style.left = "";
            dropdown.style.top = "";
        }
    }

    // Click toggles: if this row's menu is already open, clicking "⋯"
    // again closes it instead of re-opening it.
    function toggleFileRowMenu(menuBtn, dropdown) {
        const isOpen = dropdown?.classList.contains("is-open");
        if (isOpen) { closeAllFileMenus(); return; }
        openFileRowMenu(menuBtn, dropdown);
    }

    // Closes every open "⋯" menu across the list — called before opening a
    // different one (only one open at a time), on any outside click, and
    // on Escape.
    function closeAllFileMenus() {
        document.querySelectorAll(".all-files-file-menu-dropdown.is-open").forEach(d => d.classList.remove("is-open"));
        document.querySelectorAll(".all-files-file-menu-btn.is-open").forEach(b => {
            b.classList.remove("is-open");
            b.setAttribute("aria-expanded", "false");
        });
    }

    /* ---------- folder view (blue folder-icon tiles) ---------- */

    function folderIconTile({ key, label, count, onClick }) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "all-files-folder-tile";
        btn.dataset.key = key;
        btn.innerHTML = `
            <span class="all-files-folder-icon"></span>
            <span class="all-files-folder-tile-label">${escapeHtmlFiles(label)}</span>
            <span class="all-files-folder-count${count ? "" : " all-files-folder-count--zero"}">${count}</span>
        `;
        btn.addEventListener("click", onClick);
        return btn;
    }

    function renderFolderBreadcrumb() {
        const el = document.getElementById("filesFolderBreadcrumb");
        if (!el) return;

        const category = folderBrowseCategory ? window.ProjectFields.findFileCategory(folderBrowseCategory) : null;
        const subfolder = (category && selectedSubfolder && selectedCategory === folderBrowseCategory)
            ? window.ProjectFields.findFileSubfolder(folderBrowseCategory, selectedSubfolder)
            : null;
        // A folder inside a folder — only reachable when subfolder itself
        // has children (see PROJECT_FILE_CATEGORIES) and one is selected.
        const subSubfolder = (subfolder && selectedSubSubfolder)
            ? window.ProjectFields.findFileSubSubfolder(folderBrowseCategory, selectedSubfolder, selectedSubSubfolder)
            : null;

        const crumbs = [];
        crumbs.push(category
            ? `<button type="button" class="all-files-folder-breadcrumb-link" data-crumb="root">All Files</button>`
            : `<span class="all-files-folder-breadcrumb-current">All Files</span>`);

        if (category) {
            crumbs.push(`<span class="all-files-folder-breadcrumb-sep">/</span>`);
            crumbs.push(subfolder
                ? `<button type="button" class="all-files-folder-breadcrumb-link" data-crumb="category">${escapeHtmlFiles(category.label)}</button>`
                : `<span class="all-files-folder-breadcrumb-current">${escapeHtmlFiles(category.label)}</span>`);
        }

        if (subfolder) {
            crumbs.push(`<span class="all-files-folder-breadcrumb-sep">/</span>`);
            crumbs.push(subSubfolder
                ? `<button type="button" class="all-files-folder-breadcrumb-link" data-crumb="subfolder">${escapeHtmlFiles(subfolder.label)}</button>`
                : `<span class="all-files-folder-breadcrumb-current">${escapeHtmlFiles(subfolder.label)}</span>`);
        }

        if (subSubfolder) {
            crumbs.push(`<span class="all-files-folder-breadcrumb-sep">/</span>`);
            crumbs.push(`<span class="all-files-folder-breadcrumb-current">${escapeHtmlFiles(subSubfolder.label)}</span>`);
        }

        el.innerHTML = crumbs.join("");

        el.querySelector('[data-crumb="root"]')?.addEventListener("click", () => {
            folderBrowseCategory = null;
            selectedCategory = null;
            selectedSubfolder = null;
            selectedSubSubfolder = null;
            render();
        });
        el.querySelector('[data-crumb="category"]')?.addEventListener("click", () => {
            selectedCategory = null;
            selectedSubfolder = null;
            selectedSubSubfolder = null;
            render();
        });
        // Steps back up from a sub-subfolder to its parent subfolder's own
        // level — selectedCategory/selectedSubfolder stay set, so
        // renderMainPanel() shows that subfolder's child tiles again
        // instead of falling all the way back to the category grid.
        el.querySelector('[data-crumb="subfolder"]')?.addEventListener("click", () => {
            selectedSubSubfolder = null;
            render();
        });
    }

    // Renders whichever level of the Folders view is currently open — the
    // 11 category tiles, a category's subfolder tiles, or (once a subfolder
    // is picked) nothing here at all, since placeMainPanel() swaps in the
    // shared file-list panel instead.
    function renderFolderView() {
        const gridEl = document.getElementById("filesFolderGrid");
        if (!gridEl) return;

        renderFolderBreadcrumb();

        const categories = (window.ProjectFields && window.ProjectFields.PROJECT_FILE_CATEGORIES) || [];
        gridEl.innerHTML = "";

        const inFolder = Boolean(selectedCategory && selectedSubfolder);
        if (inFolder) return; // placeMainPanel() shows the file panel instead of this grid

        if (folderBrowseCategory) {
            const category = window.ProjectFields.findFileCategory(folderBrowseCategory);
            if (!category) { folderBrowseCategory = null; return renderFolderView(); }
            category.subfolders.forEach(subfolder => {
                // Same "everything under here" aggregate as the tree's own
                // badge for a subfolder with children — see
                // filesInSubfolderTree().
                const count = subfolder.subfolders?.length
                    ? filesInSubfolderTree(category.key, subfolder.key)
                    : filesInFolder(category.key, subfolder.key).length;
                gridEl.appendChild(folderIconTile({
                    key: subfolder.key,
                    label: subfolder.label,
                    count,
                    onClick: () => selectFolder(category.key, subfolder.key)
                }));
            });
        } else {
            categories.forEach(category => {
                gridEl.appendChild(folderIconTile({
                    key: category.key,
                    label: `${category.number} — ${category.label}`,
                    count: filesInCategory(category.key).length,
                    onClick: () => { folderBrowseCategory = category.key; render(); }
                }));
            });
        }
    }

    // Moves the single #filesMainPanel instance into whichever view is
    // active, and (in Folders view) toggles between the drill-down grid and
    // the panel depending on whether a subfolder is actually selected.
    function placeMainPanel() {
        const panel = document.getElementById("filesMainPanel");
        const listSlot = document.getElementById("filesListMainSlot");
        const folderSlot = document.getElementById("filesFolderMainSlot");
        const gridEl = document.getElementById("filesFolderGrid");
        if (!panel || !listSlot || !folderSlot) return;

        const inFolder = Boolean(selectedCategory && selectedSubfolder);

        if (currentView === "list") {
            listSlot.appendChild(panel);
            panel.style.display = "";
        } else {
            folderSlot.appendChild(panel);
            panel.style.display = inFolder ? "" : "none";
            if (gridEl) gridEl.style.display = inFolder ? "none" : "grid";
        }
    }

    function switchView(view) {
        currentView = view;
        document.querySelectorAll(".all-files-view-toggle-btn").forEach(btn => {
            btn.classList.toggle("is-active", btn.dataset.view === view);
        });
        const listViewEl = document.getElementById("filesListView");
        const folderViewEl = document.getElementById("filesFolderView");
        if (listViewEl) listViewEl.style.display = view === "list" ? "flex" : "none";
        if (folderViewEl) folderViewEl.style.display = view === "folders" ? "block" : "none";
        render();
    }

    function render() {
        renderTree();
        renderMainPanel();
        renderFolderView();
        placeMainPanel();
    }

    /* ---------- open / upload / delete ---------- */

    // "Download" — signed with { download: file_name } so Supabase Storage
    // sends Content-Disposition: attachment and the browser saves the file
    // instead of navigating to/rendering it, regardless of file type.
    async function downloadFile(file) {
        const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;

        const { data, error } = await window.supabaseClient
            .storage
            .from(bucket)
            .createSignedUrl(file.storage_path, 60 * 5, { download: downloadNameFor(file) });

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for file:", error);
            setFilesPageMessage("Couldn't download that file. Please try again.", "error");
            return;
        }

        // Signed with download → the browser saves it; no new tab.
        window.FilePreview ? window.FilePreview.download(data.signedUrl, downloadNameFor(file)) : (window.location.href = data.signedUrl);
    }

    // "Preview" — opens #filePreviewModalOverlay and renders the file
    // in-place: images via <img>, PDFs via <iframe>, everything else falls
    // back to a message + a Download button rather than attempting an
    // inline preview the browser can't actually render.
    async function previewFile(file) {
        pendingPreviewFile = file;
        const overlay = document.getElementById("filePreviewModalOverlay");
        const titleEl = document.getElementById("filePreviewTitle");
        const bodyEl = document.getElementById("filePreviewBody");
        if (!overlay || !bodyEl) return;

        if (titleEl) titleEl.textContent = file.file_name;
        bodyEl.innerHTML = `<div class="file-preview-loading">Loading preview…</div>`;
        overlay.classList.remove("hidden");

        const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;
        const { data, error } = await window.supabaseClient
            .storage
            .from(bucket)
            .createSignedUrl(file.storage_path, 60 * 5);

        // The person may have closed the modal (or opened a different
        // file's preview) while this signed-URL request was in flight —
        // don't stomp whatever's showing now.
        if (pendingPreviewFile !== file) return;

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for preview:", error);
            bodyEl.innerHTML = `<div class="file-preview-error">Couldn't load a preview for this file.</div>`;
            return;
        }

        const kind = previewKindFor(file);
        if (kind === "image") {
            // No src in the initial markup — set it after wiring the
            // error listener below, so a decode failure (e.g. HEIC in a
            // browser that can't render it) is always caught rather than
            // racing an instant cache hit.
            bodyEl.innerHTML = `<img class="file-preview-image" id="filePreviewImg" alt="${escapeHtmlFiles(file.file_name)}">`;
            const imgEl = document.getElementById("filePreviewImg");
            imgEl?.addEventListener("error", () => {
                // Only replace the body if this is still the file being
                // previewed (guards the same race as the signed-URL fetch
                // above, if the person switched files in between).
                if (pendingPreviewFile !== file) return;
                renderUnsupportedPreview(file, bodyEl, "Your browser can't display this image. This is common for HEIC/HEIF photos outside Safari.");
            }, { once: true });
            if (imgEl) imgEl.src = data.signedUrl;
        } else if (kind === "pdf") {
            bodyEl.innerHTML = `<iframe class="file-preview-frame" src="${escapeHtmlFiles(data.signedUrl)}" title="${escapeHtmlFiles(file.file_name)}"></iframe>`;
        } else {
            renderUnsupportedPreview(file, bodyEl, "Preview isn't available for this file type.");
        }
    }

    // Shared fallback for both "no inline preview exists for this
    // extension" and "we tried to render it but the browser couldn't" —
    // a short message plus a Download button so the person isn't stuck.
    function renderUnsupportedPreview(file, bodyEl, message) {
        bodyEl.innerHTML = `
            <div class="file-preview-unsupported">
                <p>${escapeHtmlFiles(message)}</p>
                <button type="button" class="workbook-btn workbook-btn--preview" id="filePreviewDownloadBtn">Download instead</button>
            </div>
        `;
        document.getElementById("filePreviewDownloadBtn")?.addEventListener("click", () => downloadFile(file));
    }

    function closeFilePreviewModal() {
        document.getElementById("filePreviewModalOverlay")?.classList.add("hidden");
        const bodyEl = document.getElementById("filePreviewBody");
        if (bodyEl) bodyEl.innerHTML = ""; // stop a <video>/<iframe> from continuing to load/play in the background
        pendingPreviewFile = null;
    }

    // "Copy link" — a signed URL, same mechanism as Open, just copied to
    // the clipboard instead of opened. Long enough (1 hour) to actually
    // paste somewhere (Slack, an email) rather than expiring immediately.
    async function copyFileLink(file) {
        const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;

        const { data, error } = await window.supabaseClient
            .storage
            .from(bucket)
            .createSignedUrl(file.storage_path, 60 * 60);

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for file:", error);
            setFilesPageMessage("Couldn't create a link for that file. Please try again.", "error");
            return;
        }

        try {
            await navigator.clipboard.writeText(data.signedUrl);
            setFilesPageMessage("Link copied — it expires in 1 hour.", "success");
        } catch (err) {
            console.error("Failed to copy link to clipboard:", err);
            setFilesPageMessage("Couldn't copy the link. Please try again.", "error");
        }
    }

    /* ---------- upload status widget (bottom-right, Drive-style) ---------- */

    // Kept flat rather than per-batch — a new upload while the tray is
    // still showing an earlier batch's results just appends, same as
    // Google Drive's tray does, instead of replacing it. Cleared only when
    // the person closes the tray.
    let uploadStatusItems = []; // { id, name, status: "uploading" | "done" | "error" }
    let uploadStatusIdSeq = 0;

    function renderUploadStatusWidget() {
        const widget = document.getElementById("uploadStatusWidget");
        const listEl = document.getElementById("uploadStatusList");
        const titleEl = document.getElementById("uploadStatusTitle");
        if (!widget || !listEl || !titleEl) return;

        if (!uploadStatusItems.length) {
            widget.classList.add("hidden");
            return;
        }

        widget.classList.remove("hidden");

        const total = uploadStatusItems.length;
        const inProgress = uploadStatusItems.filter(i => i.status === "uploading").length;
        const failed = uploadStatusItems.filter(i => i.status === "error").length;

        if (inProgress > 0) {
            const doneSoFar = total - inProgress;
            titleEl.textContent = total === 1 ? "Uploading 1 file…" : `Uploading ${doneSoFar + 1} of ${total}…`;
        } else if (failed > 0) {
            titleEl.textContent = failed === total
                ? (total === 1 ? "Couldn't upload 1 file" : `Couldn't upload ${failed} files`)
                : `${total - failed} of ${total} uploaded — ${failed} failed`;
        } else {
            titleEl.textContent = total === 1 ? "1 upload complete" : `${total} uploads complete`;
        }

        listEl.innerHTML = uploadStatusItems.map(item => {
            const meta = getFileTypeMeta(item.name);
            const statusHtml = item.status === "uploading"
                ? `<span class="upload-status-item-spinner"></span>`
                : item.status === "error"
                    ? `<span class="upload-status-item-icon upload-status-item-icon--error" title="Upload failed">✕</span>`
                    : `<span class="upload-status-item-icon upload-status-item-icon--done">✓</span>`;

            return `
                <div class="upload-status-item upload-status-item--${item.status}">
                    <span class="file-type-icon file-type-icon--${meta.type} upload-status-item-file-icon"></span>
                    <span class="upload-status-item-name">${escapeHtmlFiles(item.name)}</span>
                    ${statusHtml}
                </div>
            `;
        }).join("");
    }

    // Shared by both the file-picker input and drag-and-drop — uploads any
    // number of files, one at a time (simpler error handling/progress
    // messaging than parallel, and avoids hammering Storage with a big
    // batch all at once). One failure doesn't stop the rest; the bottom-
    // right tray tracks per-file status live, and a page-message summary
    // at the end says how many made it and names anything that didn't.
    async function uploadFiles(fileList) {
        const files = Array.from(fileList || []).filter(Boolean);
        if (!files.length || !currentProject || !selectedCategory || !selectedSubfolder) return;

        if (!folderAcceptsFiles(selectedCategory, selectedSubfolder, selectedSubSubfolder)) {
            setFilesPageMessage("Choose one of the folders inside this one before uploading.", "error");
            return;
        }

        const total = files.length;
        let succeeded = 0;
        const failedNames = [];

        document.getElementById("uploadStatusWidget")?.classList.remove("is-collapsed");
        const batchItems = files.map(file => {
            const item = { id: ++uploadStatusIdSeq, name: file.name, status: "uploading" };
            uploadStatusItems.push(item);
            return item;
        });
        renderUploadStatusWidget();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            setFilesPageMessage(total > 1 ? `Uploading ${i + 1} of ${total}…` : "Uploading…", "");

            try {
                // pathSegments' .filter(Boolean) (in project-fields.js's
                // uploadFile()) already drops selectedSubSubfolder when
                // it's null, so this works the same for every subfolder
                // whether or not it has children.
                const path = await window.ProjectFields.uploadFile(currentProject.id, file, null, {
                    pathSegments: [selectedCategory, selectedSubfolder, selectedSubSubfolder]
                });

                const { data: inserted, error } = await window.supabaseClient
                    .from(PROJECT_FILES_TABLE)
                    .insert({
                        project_id: currentProject.id,
                        category: selectedCategory,
                        subfolder: selectedSubfolder,
                        sub_subfolder: selectedSubSubfolder,
                        bucket: PROJECT_DOCS_BUCKET,
                        storage_path: path,
                        file_name: file.name,
                        source: "upload",
                        uploaded_by_name: getFilesStaffName()
                    })
                    .select("*, form_submissions(form_title)")
                    .single();

                if (error) throw error;

                allFiles.unshift(inserted);
                succeeded++;
                batchItems[i].status = "done";
            } catch (error) {
                console.error(`Failed to upload "${file.name}":`, error);
                failedNames.push(file.name);
                batchItems[i].status = "error";
            }

            renderUploadStatusWidget();
        }

        filesCurrentPage = 1; // newly uploaded files land at the front of the list (see allFiles.unshift above) — jump back to page 1 so they're actually visible
        render();

        if (!failedNames.length) {
            setFilesPageMessage(succeeded === 1 ? `"${files[0].name}" was uploaded.` : `${succeeded} files were uploaded.`, "success");
        } else if (succeeded) {
            setFilesPageMessage(`${succeeded} of ${total} uploaded. Couldn't upload: ${failedNames.join(", ")}.`, "error");
        } else {
            setFilesPageMessage("Something went wrong uploading. Please try again.", "error");
        }
    }

    async function handleUploadInputChange(event) {
        // event.target.files is a *live* FileList — resetting .value below
        // clears that same list in place, so it has to be copied into a
        // real, independent array first. (The earlier single-file version
        // of this only ever read files[0] before the reset, which is a
        // real File object and unaffected by clearing the input — that
        // safety got lost when this became a FileList for multi-upload.)
        const files = Array.from(event.target.files || []);
        event.target.value = ""; // so picking the same file(s) again still fires "change"
        await uploadFiles(files);
    }

    function dragCarriesFiles(event) {
        return !!(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files"));
    }

    // Typing the file's own name to confirm (same pattern used for project
    // deletion) -- cheap insurance against a one-click delete landing on the
    // wrong file, which is otherwise unrecoverable.
    function deleteFileConfirmNameMatches() {
        const expected = (pendingDeleteFile && pendingDeleteFile.file_name) || "";
        const typed = document.getElementById("deleteFileConfirmNameInput").value;
        return expected.length > 0 && typed.trim() === expected;
    }

    function deleteFileConfirmReady() {
        return deleteFileConfirmNameMatches()
            && document.getElementById("deleteFileConfirmUnderstandCheckbox").checked;
    }

    function updateDeleteFileConfirmBtnState() {
        document.getElementById("confirmDeleteFileBtn").disabled = !deleteFileConfirmReady();
    }

    // Invoice PDFs are managed on the Accounting page (their file name and the
    // invoice row stay in sync there), so they can't be renamed or deleted here.
    function showInvoiceFileLockedPopup(action) {
        let overlay = document.getElementById("invoiceFileLockedOverlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.className = "popup-overlay hidden";
            overlay.id = "invoiceFileLockedOverlay";
            overlay.innerHTML = `
                <div class="popup" role="alertdialog" aria-modal="true" aria-labelledby="invoiceFileLockedTitle">
                    <h2 id="invoiceFileLockedTitle">This is an invoice</h2>
                    <p class="auth-inline-copy" id="invoiceFileLockedText"></p>
                    <div class="popup-buttons">
                        <button type="button" class="auth-button auth-button--secondary" id="invoiceFileLockedOkBtn">OK</button>
                        <a class="auth-button" id="invoiceFileLockedGoBtn" href="#">Go to Accounting</a>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const close = () => overlay.classList.add("hidden");
            overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
            overlay.querySelector("#invoiceFileLockedOkBtn").addEventListener("click", close);
            document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
        }
        overlay.querySelector("#invoiceFileLockedText").textContent =
            `Invoice files can't be ${action} on the Files page. Open the Accounting page's Invoices tab to edit or delete this invoice — deleting it there removes the file too.`;
        overlay.querySelector("#invoiceFileLockedGoBtn").href =
            `/pages/project-accounting.html?id=${encodeURIComponent(currentProject ? currentProject.id : "")}#invoices`;
        overlay.classList.remove("hidden");
    }

    function openDeleteFileConfirm(file) {
        if (file && file.source === "invoice") { showInvoiceFileLockedPopup("deleted"); return; }
        pendingDeleteFile = file;
        document.getElementById("deleteFileConfirmName").textContent = file.file_name || "this file";
        const input = document.getElementById("deleteFileConfirmNameInput");
        input.value = "";
        document.getElementById("deleteFileConfirmUnderstandCheckbox").checked = false;
        const messageEl = document.getElementById("deleteFileConfirmMessage");
        if (messageEl) messageEl.textContent = "";
        document.getElementById("deleteFileConfirmOverlay")?.classList.remove("hidden");
        updateDeleteFileConfirmBtnState();
        input.focus();
    }

    function closeDeleteFileConfirm() {
        document.getElementById("deleteFileConfirmOverlay")?.classList.add("hidden");
        pendingDeleteFile = null;
    }

    async function confirmDeleteFile() {
        if (!pendingDeleteFile) return;
        if (!deleteFileConfirmReady()) return;
        const file = pendingDeleteFile;
        const messageEl = document.getElementById("deleteFileConfirmMessage");
        const confirmBtn = document.getElementById("confirmDeleteFileBtn");

        if (confirmBtn) confirmBtn.disabled = true;
        if (messageEl) { messageEl.textContent = "Deleting…"; messageEl.className = "auth-message"; }

        try {
            const { error } = await window.supabaseClient
                .from(PROJECT_FILES_TABLE)
                .delete()
                .eq("id", file.id);
            if (error) throw error;

            // Best-effort — the project_files row (what actually makes the
            // file discoverable/RLS-gated) is already gone either way.
            const bucket = file.bucket === FORM_SUBMISSIONS_BUCKET ? FORM_SUBMISSIONS_BUCKET : PROJECT_DOCS_BUCKET;
            window.supabaseClient.storage.from(bucket).remove([file.storage_path])
                .catch(err => console.warn("Couldn't remove file from storage:", err));

            allFiles = allFiles.filter(f => f.id !== file.id);
            closeDeleteFileConfirm();
            render();
            setFilesPageMessage("File deleted.", "success");
        } catch (error) {
            console.error("Failed to delete file:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong deleting this file. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (confirmBtn) confirmBtn.disabled = false;
        }
    }

    function openRenameFileModal(file) {
        if (file && file.source === "invoice") { showInvoiceFileLockedPopup("renamed"); return; }
        pendingRenameFile = file;
        const { base, ext } = splitFileNameExt(file.file_name);
        const input = document.getElementById("renameFileInput");
        const extEl = document.getElementById("renameFileExtSuffix");
        const messageEl = document.getElementById("renameFileMessage");
        if (input) input.value = base;
        if (extEl) extEl.textContent = ext;
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
        document.getElementById("renameFileModalOverlay")?.classList.remove("hidden");
        input?.focus();
        input?.select();
    }

    function closeRenameFileModal() {
        document.getElementById("renameFileModalOverlay")?.classList.add("hidden");
        pendingRenameFile = null;
    }

    async function confirmRenameFile(event) {
        event.preventDefault();
        if (!pendingRenameFile) return;

        const file = pendingRenameFile;
        const input = document.getElementById("renameFileInput");
        const messageEl = document.getElementById("renameFileMessage");
        const submitBtn = document.getElementById("confirmRenameFileBtn");
        const newBase = (input?.value || "").trim();

        if (!newBase) {
            if (messageEl) { messageEl.textContent = "Enter a file name."; messageEl.className = "auth-message error"; }
            return;
        }

        // The extension always comes from the original file, never from
        // the input — the input only ever holds the base name (see
        // openRenameFileModal()/#renameFileExtSuffix), so there's no path
        // by which this ends up with a different extension than it
        // started with.
        const { ext } = splitFileNameExt(file.file_name);
        const newName = `${newBase}${ext}`;

        if (newName === file.file_name) {
            closeRenameFileModal();
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        if (messageEl) { messageEl.textContent = "Renaming…"; messageEl.className = "auth-message"; }

        try {
            const updatePayload = { file_name: newName };

            if (file.source === "upload") {
                // Uploads are the only files whose storage key actually
                // encodes the filename (see uploadFile() in
                // project-fields.js: <project>/<category>/<subfolder>/
                // <timestamp>-<safeName>) — so a real rename here means
                // actually moving the object, not just relabeling the row.
                // A fresh timestamp keeps the new path unique even if
                // another file in the same folder already has this exact
                // name. Same sanitization as uploadFile() so the storage
                // key stays consistent with every other path in the bucket.
                const dir = file.storage_path.includes("/")
                    ? file.storage_path.slice(0, file.storage_path.lastIndexOf("/") + 1)
                    : "";
                const safeName = newName.replace(/[^a-zA-Z0-9_.-]/g, "_");
                const newStoragePath = `${dir}${Date.now()}-${safeName}`;

                const { error: moveError } = await window.supabaseClient
                    .storage
                    .from(PROJECT_DOCS_BUCKET)
                    .move(file.storage_path, newStoragePath);
                if (moveError) throw moveError;

                updatePayload.storage_path = newStoragePath;
            }
            // Form-filed PDFs (source === "form_submission") are keyed by
            // <form_id>/<submissionId>.pdf, not by filename — the filename
            // was never part of the storage key, so there's no object to
            // move. Full consistency for those means syncing the name on
            // both places it's stored instead (project_files.file_name
            // here, and form_submissions.file_name below, so form-
            // builder.js's own Responses list doesn't disagree with what
            // All Files shows).

            const { data: updated, error } = await window.supabaseClient
                .from(PROJECT_FILES_TABLE)
                .update(updatePayload)
                .eq("id", file.id)
                .select("*, form_submissions(form_title)")
                .single();
            if (error) throw error;

            if (file.source === "form_submission" && file.form_submission_id) {
                const { error: subError } = await window.supabaseClient
                    .from("form_submissions")
                    .update({ file_name: newName })
                    .eq("id", file.form_submission_id);
                if (subError) console.warn("Renamed in All Files, but couldn't sync form_submissions.file_name:", subError);
            }

            const idx = allFiles.findIndex(f => f.id === file.id);
            if (idx !== -1) allFiles[idx] = updated;

            closeRenameFileModal();
            render();
            setFilesPageMessage("File renamed.", "success");
        } catch (error) {
            console.error("Failed to rename file:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong renaming this file. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    /* ---------- wire up ---------- */

    document.getElementById("filesUploadInput")?.addEventListener("change", handleUploadInputChange);

    // Upload status widget — close discards the batch history (a fresh
    // upload afterward starts a new tray from empty); the toggle (and
    // clicking the header itself, Drive-style) just collapses/expands the
    // list without losing it.
    document.getElementById("uploadStatusCloseBtn")?.addEventListener("click", (event) => {
        event.stopPropagation();
        uploadStatusItems = [];
        renderUploadStatusWidget();
    });
    document.getElementById("uploadStatusToggleBtn")?.addEventListener("click", (event) => {
        event.stopPropagation();
        document.getElementById("uploadStatusWidget")?.classList.toggle("is-collapsed");
    });
    document.getElementById("uploadStatusHeader")?.addEventListener("click", () => {
        document.getElementById("uploadStatusWidget")?.classList.toggle("is-collapsed");
    });

    // Drag-and-drop, straight onto the file panel — #filesMainPanel is the
    // one shared panel instance (see placeMainPanel()), so wiring this
    // once here covers it in both List and Folders view rather than
    // needing to re-wire on every render(). dragCounter handles the
    // "dragenter/dragleave fire for every child element too" browser
    // quirk so the drop-zone highlight doesn't flicker while dragging
    // over rows inside the panel.
    const filesMainPanel = document.getElementById("filesMainPanel");
    let dragCounter = 0;

    filesMainPanel?.addEventListener("dragover", (event) => {
        if (!dragCarriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    });

    filesMainPanel?.addEventListener("dragenter", (event) => {
        if (!dragCarriesFiles(event)) return;
        event.preventDefault();
        dragCounter++;
        if (selectedCategory && selectedSubfolder && folderAcceptsFiles(selectedCategory, selectedSubfolder, selectedSubSubfolder)) filesMainPanel.classList.add("is-drag-over");
    });

    filesMainPanel?.addEventListener("dragleave", (event) => {
        if (!dragCarriesFiles(event)) return;
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) filesMainPanel.classList.remove("is-drag-over");
    });

    filesMainPanel?.addEventListener("drop", async (event) => {
        if (!dragCarriesFiles(event)) return;
        event.preventDefault();
        dragCounter = 0;
        filesMainPanel.classList.remove("is-drag-over");

        if (!selectedCategory || !selectedSubfolder) {
            setFilesPageMessage("Pick a folder first, then drop files to upload them.", "error");
            return;
        }
        if (!folderAcceptsFiles(selectedCategory, selectedSubfolder, selectedSubSubfolder)) {
            setFilesPageMessage("Choose one of the folders inside this one before uploading.", "error");
            return;
        }

        await uploadFiles(event.dataTransfer.files);
    });

    document.getElementById("cancelDeleteFileBtn")?.addEventListener("click", closeDeleteFileConfirm);
    document.getElementById("confirmDeleteFileBtn")?.addEventListener("click", confirmDeleteFile);
    document.getElementById("deleteFileConfirmOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeDeleteFileConfirm();
    });
    document.getElementById("deleteFileConfirmNameInput")?.addEventListener("input", updateDeleteFileConfirmBtnState);
    document.getElementById("deleteFileConfirmUnderstandCheckbox")?.addEventListener("change", updateDeleteFileConfirmBtnState);

    document.getElementById("renameFileForm")?.addEventListener("submit", confirmRenameFile);
    document.getElementById("cancelRenameFileBtn")?.addEventListener("click", closeRenameFileModal);
    document.getElementById("renameFileModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeRenameFileModal();
    });

    document.getElementById("filePreviewCloseBtn")?.addEventListener("click", closeFilePreviewModal);
    document.getElementById("filePreviewModalOverlay")?.addEventListener("click", function (e) {
        if (e.target === this) closeFilePreviewModal();
    });

    // Close any open "⋯" menu on an outside click or Escape — same pattern
    // as the header notification bell / project switcher dropdowns.
    // Escape also closes the Preview modal, matching Delete/Rename's own
    // overlay-click-to-close behavior.
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".all-files-file-actions-cell")) closeAllFileMenus();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeAllFileMenus();
            if (!document.getElementById("filePreviewModalOverlay")?.classList.contains("hidden")) {
                closeFilePreviewModal();
            }
        }
    });

    document.querySelectorAll(".all-files-view-toggle-btn").forEach(btn => {
        btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("filesPrevPageBtn")?.addEventListener("click", () => {
        if (filesCurrentPage > 1) { filesCurrentPage--; renderMainPanel(); }
    });
    document.getElementById("filesNextPageBtn")?.addEventListener("click", () => {
        filesCurrentPage++;
        renderMainPanel();
    });
    document.getElementById("filesPageSizeSelect")?.addEventListener("change", (event) => {
        filesPageSize = Number(event.target.value) || 10;
        filesCurrentPage = 1;
        renderMainPanel();
    });

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        if (error || !project) {
            setFilesPageMessage("No project selected. Pick one from Project Overview.", "error");
            document.getElementById("filesLoadingState").style.display = "none";
            return;
        }

        await Promise.all([
            loadMyProjectRole(project.id),
            loadFiles(project.id),
            loadProjectForms()
        ]);

        document.getElementById("filesLoadingState").style.display = "none";
        document.getElementById("filesBody").style.display = "block";

        // Arrived via a sidebar search result (project-shell.js links a
        // file match to project-files.html?...&category=X&subfolder=Y[&sub_subfolder=Z])
        // — jump straight to that folder instead of landing on "Select a
        // folder". selectFolder() already calls render() itself.
        const urlParams = new URLSearchParams(window.location.search);
        const categoryParam = urlParams.get("category");
        const subfolderParam = urlParams.get("subfolder");
        const subSubfolderParam = urlParams.get("sub_subfolder");
        // A stale/renamed sub_subfolder key just falls back to landing on
        // the subfolder itself, same "never disappears, worst case less
        // precise" spirit as fileSubfolderLabel()'s own fallback.
        const validSubSubfolder = subSubfolderParam && window.ProjectFields.findFileSubSubfolder(categoryParam, subfolderParam, subSubfolderParam)
            ? subSubfolderParam
            : null;
        if (categoryParam && subfolderParam && window.ProjectFields.findFileSubfolder(categoryParam, subfolderParam)) {
            selectFolder(categoryParam, subfolderParam, validSubSubfolder);
        } else {
            render();
        }
    });

})();
