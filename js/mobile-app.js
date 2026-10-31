/* ===========================
   MOBILE APP BAR (phones only)

   Adds an app-style bottom tab bar on phone-width screens (styles.css
   hides it above 768px, so desktop and tablets never see it). Loaded on
   every page that has the sidebar, right after script.js.

   The tabs are built FROM the sidebar's own links rather than hardcoded
   URLs, so:
     - a tab only shows if its sidebar link exists and isn't hidden by
       nav-access.js / permissions (same visibility rules, no duplication)
     - project pages keep their ?id=... automatically, because
       project-shell.js has already rewritten those sidebar hrefs
   "More" opens a bottom sheet (see MORE SHEET below) listing every page
   this person can see, again read live from the sidebar. On company pages
   its "Customize tab bar" link lets each person pick their own 4 tabs
   (saved on that device; see CUSTOMIZE below).
=========================== */
(function () {
    "use strict";

    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const isProjectPage = Boolean(document.getElementById("projectSwitcher"));

    // Default company bar, in order. Up to 4 tabs + More. The `fallback`
    // ones only show if one of the main ones is hidden for this person.
    // Anyone can replace this with their own pick (CUSTOMIZE below).
    const COMPANY_TABS = [
        { page: "dashboard.html", label: "Home" },
        { page: "project-home.html", label: "Projects" },
        { page: "incident-report.html", label: "Report" },
        { page: "timesheet.html", label: "Time" },
        { page: "vendors.html", label: "Vendors", fallback: true },
        { page: "account-activity.html", label: "Activity", fallback: true },
    ];

    // Short tab-bar labels (the sidebar's names are too long for a tab).
    const SHORT_LABELS = {
        "dashboard": "Home",
        "project-home": "Projects",
        "incident-report": "Report",
        "timesheet": "Time",
        "vendors": "Vendors",
        "account-activity": "Activity",
        "payroll-tools": "Payroll",
        "manage-employees": "Employees",
        "excel-workbook": "Workbooks",
        "form-template": "Forms",
        "admin-users": "New User",
        "staff-users": "Staff",
        "workgroups": "Groups",
    };

    const CUSTOM_TABS_KEY = "mobileTabbarCustom"; // JSON array of page names, e.g. ["dashboard","vendors"]

    function loadCustomTabs() {
        try {
            const list = JSON.parse(localStorage.getItem(CUSTOM_TABS_KEY) || "null");
            return Array.isArray(list) && list.length ? list.slice(0, 4).map(String) : null;
        } catch { return null; }
    }

    function saveCustomTabs(list) {
        try {
            if (list && list.length) localStorage.setItem(CUSTOM_TABS_KEY, JSON.stringify(list.slice(0, 4)));
            else localStorage.removeItem(CUSTOM_TABS_KEY);
        } catch { /* private browsing etc.: the bar just stays default */ }
    }

    const PROJECT_TABS = [
        { page: "projects.html", label: "Overview" },
        { page: "project-files.html", label: "Files" },
        { page: "project-form-logs.html", label: "Logs" },
        { page: "project-todo.html", label: "To-Do" },
        { page: "project-accounts.html", label: "Contacts", fallback: true },
    ];

    const MAX_TABS = 4;

    function baseName(path) {
        return String(path || "").split("?")[0].split("#")[0].split("/").pop().replace(/\.html$/i, "");
    }

    const currentPage = baseName(window.location.pathname) || "index";

    // The sidebar link for a page (top-level or inside a group like Company
    // docs / IT Tools), keyed by page basename.
    function findSidebarLink(page) {
        const want = baseName(page);
        return [...sidebar.querySelectorAll("a.nav-item:not(.nav-parent), a.subnav-item")].find(a => {
            const target = a.dataset.navPage || a.getAttribute("href") || "";
            return baseName(target) === want;
        }) || null;
    }

    // A grouped link has no icon of its own; use its group's.
    function groupParentOf(link) {
        return link.closest(".nav-item-group")?.querySelector(".nav-parent") || null;
    }

    // nav-access.js hides links with display:none on the link or a parent
    // group; walk up to the sidebar checking for that.
    function isLinkVisible(link) {
        for (let el = link; el && el !== sidebar; el = el.parentElement) {
            if (el.hidden || getComputedStyle(el).display === "none") return false;
        }
        return true;
    }

    let tabPages = new Set();

    // Is the current page one of the sidebar's links, i.e. a page the More
    // sheet covers? Covers grouped links (Company docs, IT Tools) too.
    // Deliberately ignores visibility: if you're ON the page, it counts,
    // even while a permission script still has its link hidden.
    function isInMoreSheet() {
        return [...sidebar.querySelectorAll("a.nav-item:not(.nav-parent), a.subnav-item")].some(a =>
            baseName(a.dataset.navPage || a.getAttribute("href")) === currentPage);
    }

    const bar = document.createElement("nav");
    bar.className = "mobile-tabbar";
    bar.setAttribute("aria-label", "Main");
    document.body.appendChild(bar);
    document.body.classList.add("has-mobile-tabbar");

    function render() {
        const custom = isProjectPage ? null : loadCustomTabs();
        const defs = isProjectPage
            ? PROJECT_TABS
            : custom
                ? custom.map(page => ({ page, label: null }))
                : COMPANY_TABS;
        const picked = [];

        // Fallback tabs are listed last, so they only ever fill slots a
        // hidden main tab left empty.
        for (const def of defs) {
            if (picked.length >= MAX_TABS) break;
            const link = findSidebarLink(def.page);
            if (!link || !isLinkVisible(link)) continue;
            picked.push({ def, link });
        }
        const tabs = picked;
        tabPages = new Set(tabs.map(t => baseName(t.def.page)));

        const html = tabs.map(({ def, link }) => {
            const iconClass = linkIconClass(link, groupParentOf(link));
            const label = def.label || tabLabel(link);
            const active = baseName(def.page) === currentPage;
            // href read live from the sidebar link (project pages rewrite it).
            return `<a class="mobile-tab${active ? " is-active" : ""}" href="${link.getAttribute("href") || "#"}"${active ? ' aria-current="page"' : ""}>
                <span class="mobile-tab-icon ${iconClass}" aria-hidden="true"></span>
                <span class="mobile-tab-label">${esc(label)}</span>
            </a>`;
        }).join("");

        // On a page that's reached through the More sheet (not on the bar),
        // More gets the active bubble instead of nothing being highlighted.
        const onTabPage = tabs.some(({ def }) => baseName(def.page) === currentPage);
        const moreActive = !onTabPage && isInMoreSheet();

        bar.innerHTML = html + `
            <button type="button" class="mobile-tab mobile-tab--more${moreActive ? " is-active" : ""}" aria-label="More pages"${moreActive ? ' aria-current="page"' : ""}>
                <span class="mobile-tab-icon mobile-tab-icon--more" aria-hidden="true"></span>
                <span class="mobile-tab-label">More</span>
            </button>`;

        bar.querySelector(".mobile-tab--more").addEventListener("click", openSheet);
    }

    /* ===========================
       MORE SHEET
       Slides up from the bottom over a blurred (not darkened) page.
       - Company pages: who you are, then every visible sidebar page that
         isn't already on the tab bar as a list, grouped the same way the
         sidebar groups them (Company docs, IT Tools...), then the
         Customize tab bar link and the version.
       - Project pages: the current project with a Switch button, the
         project pages not on the tab bar as a list, then links back out to
         the company side.
       Built fresh on every open, so it always matches what nav-access.js
       currently shows and the current ?id= hrefs.
       Closes on: ✕, tapping the blurred area, Escape, swiping it down.
    =========================== */

    function esc(str) {
        return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function tabLabel(link) {
        const page = baseName(link.dataset.navPage || link.getAttribute("href"));
        return SHORT_LABELS[page] || linkLabel(link).split(" ")[0];
    }

    function linkLabel(link) {
        return (link.querySelector(".nav-text")?.textContent || link.textContent || "").replace(/\s+/g, " ").trim();
    }

    function linkIconClass(link, fallbackLink) {
        const icon = link.querySelector('span[class$="-nav-icon"], span[class*="-nav-icon "]')
            || fallbackLink?.querySelector('span[class$="-nav-icon"], span[class*="-nav-icon "]');
        return icon ? icon.className : "docs-nav-icon";
    }

    function linkBadge(link) {
        const badge = link.querySelector(".nav-item-badge");
        if (!badge || getComputedStyle(badge).display === "none") return "";
        const n = badge.textContent.trim();
        return n ? `<span class="mobile-sheet-badge">${esc(n)}</span>` : "";
    }

    function linkTarget(link) {
        return link.getAttribute("target") === "_blank" ? ' target="_blank" rel="noopener"' : "";
    }

    // "Version 1.0.1-RC-BETA": read from the sidebar footer so the menu
    // always shows whatever the sidebar does.
    // "Version x - Report Bug": the version text plus the sidebar's own
    // Report Bug link (if the page has one).
    function versionHtml() {
        const el = sidebar.querySelector(".version");
        if (!el) return "";
        // Every footer link (Release Notes, Report Bug), each keeping its
        // own target — Release Notes stays in the portal, Report Bug opens Tally.
        const links = Array.from(el.querySelectorAll("a[href]"));
        const clone = el.cloneNode(true);
        clone.querySelectorAll("a").forEach(a => a.remove());
        const text = clone.textContent.replace(/\s+/g, " ").replace(/[\s-]+$/, "").trim();
        if (!text) return "";
        const linkHtml = links.map(link =>
            ` - <a class="mobile-sheet-version-link" href="${esc(link.getAttribute("href"))}"${linkTarget(link)}>${esc(link.textContent.trim())}</a>`
        ).join("");
        return `<div class="mobile-sheet-version">${esc(text)}${linkHtml}</div>`;
    }

    function getProfile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; }
    }

    const scrim = document.createElement("div");
    scrim.className = "mobile-sheet-scrim";
    scrim.setAttribute("aria-hidden", "true");

    const sheet = document.createElement("section");
    sheet.className = "mobile-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "More pages");
    sheet.setAttribute("aria-hidden", "true");

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>`;
    const CHEVRON = `<svg class="mobile-sheet-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;

    const EXTERNAL = `<svg class="mobile-sheet-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4l-9 9"></path><path d="M18 14v6H4V6h6"></path></svg>`;

    // One sidebar link as a list row (icon, label, badge, chevron).
    // Subnav items have no icon of their own, so they borrow their group's.
    function linkRow(link, iconFrom) {
        const href = link.getAttribute("href") || "#";
        const active = baseName(href) === currentPage;
        const external = link.getAttribute("target") === "_blank";
        return `<a class="mobile-sheet-row${active ? " is-active" : ""}" href="${esc(href)}"${linkTarget(link)}>
            <span class="mobile-sheet-row-icon"><span class="${linkIconClass(link, iconFrom)}" aria-hidden="true"></span></span>
            <span class="mobile-sheet-row-label">${esc(linkLabel(link))}</span>
            ${linkBadge(link)}
            ${external ? EXTERNAL : CHEVRON}
        </a>`;
    }

    function row(href, label, iconClass, extra, opts = {}) {
        const active = baseName(href) === currentPage;
        return `<a class="mobile-sheet-row${opts.muted ? " mobile-sheet-row--muted" : ""}${active ? " is-active" : ""}" href="${esc(href)}">
            <span class="mobile-sheet-row-icon"><span class="${iconClass}" aria-hidden="true"></span></span>
            <span class="mobile-sheet-row-label">${esc(label)}</span>
            ${extra || CHEVRON}
        </a>`;
    }

    // "Install the app" row (js/install-app.js decides if it applies:
    // phones only, and hidden once installed / running as the app).
    function installRow() {
        const show = !!(window.LeewardInstall && window.LeewardInstall.available());
        return `<button type="button" class="mobile-sheet-row mobile-sheet-row--install" data-install-app data-action="install"${show ? "" : " hidden"}>
            <span class="mobile-sheet-row-icon"><span class="install-nav-icon" aria-hidden="true"></span></span>
            <span class="mobile-sheet-row-label">Install the app</span>
            ${CHEVRON}
        </button>`;
    }

    function buildCompanySheet() {
        const profile = getProfile();
        const name = profile?.full_name || profile?.username || "Signed in";
        const groups = Array.isArray(profile?.workgroup) ? profile.workgroup.join(" · ") : (profile?.workgroup || "");
        const initials = (document.getElementById("brandInitials")?.textContent || name.split(/\s+/).map(w => w[0]).join("").slice(0, 2)).trim();

        // Walk the sidebar in order: loose links collect into "Pages";
        // each collapsible group (Company docs, IT Tools...) is its own section.
        const nav = sidebar.querySelector(".sidebar-nav") || sidebar;
        const sections = [];
        const loose = [];
        for (const el of nav.children) {
            if (el.matches("a.nav-item")) {
                if (!isLinkVisible(el)) continue;
                loose.push(linkRow(el));
            } else if (el.matches(".nav-item-group") && isLinkVisible(el)) {
                const parent = el.querySelector(".nav-parent");
                const items = [...el.querySelectorAll("a.subnav-item")].filter(isLinkVisible).map(a => linkRow(a, parent));
                if (items.length) sections.push({ title: parent ? linkLabel(parent) : "", items });
            }
        }
        if (loose.length) sections.unshift({ title: "Pages", items: loose });

        return `
            <div class="mobile-sheet-handle"><span></span></div>
            <div class="mobile-sheet-head">
                <div class="mobile-sheet-avatar">${esc(initials)}</div>
                <div class="mobile-sheet-who">
                    <div class="mobile-sheet-name">${esc(name)}</div>
                    ${groups ? `<div class="mobile-sheet-sub">${esc(groups)}</div>` : ""}
                </div>
                <button type="button" class="mobile-sheet-close" aria-label="Close menu">${CLOSE_ICON}</button>
            </div>
            <div class="mobile-sheet-body">
                ${installRow()}
                ${sections.map(sec => `
                    ${sec.title ? `<div class="mobile-sheet-section">${esc(sec.title)}</div>` : ""}
                    ${sec.items.join("")}
                `).join("")}
                <div class="mobile-sheet-customize-link-wrap">
                    <button type="button" class="mobile-sheet-customize-link" data-action="customize">Customize tab bar</button>
                </div>
                ${versionHtml()}
            </div>`;
    }

    /* ===========================
       CUSTOMIZE (company tab bar)
       Tap pages in the order you want them (up to 4); More always stays
       last. Saved per device in localStorage. Only pages this person can
       see are offered, and a saved page that later gets hidden by
       permissions simply drops off the bar.
    =========================== */

    let customDraft = [];

    // Every page that can be a tab: visible sidebar links, in sidebar order,
    // minus external sites (Company site opens a new tab).
    function customizablePages() {
        return [...sidebar.querySelectorAll("a.nav-item:not(.nav-parent), a.subnav-item")]
            .filter(a => isLinkVisible(a) && a.getAttribute("target") !== "_blank")
            .map(a => ({ page: baseName(a.dataset.navPage || a.getAttribute("href")), link: a }))
            .filter((p, i, all) => p.page && all.findIndex(q => q.page === p.page) === i);
    }

    function currentTabPages() {
        return [...tabPages];
    }

    function buildCustomizeSheet() {
        const options = customizablePages();
        const rows = options.map(({ page, link }) => {
            const pos = customDraft.indexOf(page);
            const picked = pos !== -1;
            return `<button type="button" class="mobile-sheet-row mobile-sheet-pick${picked ? " is-picked" : ""}" data-action="pick" data-page="${esc(page)}" aria-pressed="${picked}">
                <span class="mobile-sheet-row-icon"><span class="${linkIconClass(link, groupParentOf(link))}" aria-hidden="true"></span></span>
                <span class="mobile-sheet-row-label">${esc(linkLabel(link))}<small>${esc(SHORT_LABELS[page] || linkLabel(link).split(" ")[0])} on the bar</small></span>
                <span class="mobile-sheet-pick-mark">${picked ? pos + 1 : ""}</span>
            </button>`;
        }).join("");

        const preview = customDraft.map(page => {
            const opt = options.find(o => o.page === page);
            return opt ? `<span class="mobile-sheet-preview-tab">${esc(tabLabel(opt.link))}</span>` : "";
        }).join("") + `<span class="mobile-sheet-preview-tab mobile-sheet-preview-tab--more">More</span>`;

        return `
            <div class="mobile-sheet-handle"><span></span></div>
            <div class="mobile-sheet-head">
                <button type="button" class="mobile-sheet-back" data-action="back" aria-label="Back to menu">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
                </button>
                <div class="mobile-sheet-who">
                    <div class="mobile-sheet-name">Customize tab bar</div>
                    <div class="mobile-sheet-sub">Tap up to 4, in order.</div>
                </div>
                <button type="button" class="mobile-sheet-close" aria-label="Close menu">${CLOSE_ICON}</button>
            </div>
            <div class="mobile-sheet-preview" aria-label="Preview">${preview}</div>
            <div class="mobile-sheet-body">${rows}</div>
            <div class="mobile-sheet-foot">
                <button type="button" class="mobile-sheet-btn" data-action="reset">Reset to default</button>
                <button type="button" class="mobile-sheet-btn mobile-sheet-btn--primary" data-action="save"${customDraft.length ? "" : " disabled"}>Save</button>
            </div>`;
    }

    function showCustomize() {
        customDraft = loadCustomTabs() || currentTabPages();
        sheet.innerHTML = buildCustomizeSheet();
        setSheetHeight("full", true);
    }

    function redrawCustomize() {
        const scroll = sheet.querySelector(".mobile-sheet-body")?.scrollTop || 0;
        sheet.innerHTML = buildCustomizeSheet();
        const body = sheet.querySelector(".mobile-sheet-body");
        if (body) body.scrollTop = scroll;
    }

    function buildProjectSheet() {
        const projectName = (document.getElementById("headerProjectName")?.textContent || "Project").trim();
        const nav = sidebar.querySelector(".sidebar-nav") || sidebar;
        const rows = [...nav.querySelectorAll("a.nav-item")]
            .filter(a => isLinkVisible(a))
            .map(a => {
                const page = baseName(a.dataset.navPage || a.getAttribute("href"));
                // The schedule is desktop-only on phones (see project-timeline.html).
                const extra = page === "project-timeline" ? `<span class="mobile-sheet-pill">Desktop</span>` : "";
                return row(a.getAttribute("href") || "#", linkLabel(a), linkIconClass(a), extra);
            });

        return `
            <div class="mobile-sheet-handle"><span></span></div>
            <div class="mobile-sheet-head mobile-sheet-head--project">
                <div class="mobile-sheet-project">
                    <span class="mobile-sheet-avatar mobile-sheet-avatar--project"><span class="projects-nav-icon" aria-hidden="true"></span></span>
                    <div class="mobile-sheet-who">
                        <div class="mobile-sheet-sub mobile-sheet-eyebrow">Current project</div>
                        <div class="mobile-sheet-name">${esc(projectName)}</div>
                    </div>
                    <button type="button" class="mobile-sheet-switch" data-action="switch">Switch</button>
                </div>
                <button type="button" class="mobile-sheet-close" aria-label="Close menu">${CLOSE_ICON}</button>
            </div>
            <div class="mobile-sheet-body">
                ${rows.join("")}
                <div class="mobile-sheet-divider"></div>
                ${row("/pages/dashboard.html", "Company Dashboard", "home-nav-icon", "", { muted: true })}
                ${row("/pages/project-home.html", "All Projects", "projects-nav-icon", "", { muted: true })}
                ${installRow()}
                ${versionHtml()}
            </div>`;
    }

    let lastFocus = null;

    function openSheet() {
        sheet.innerHTML = isProjectPage ? buildProjectSheet() : buildCompanySheet();
        setSheetHeight("half", false);
        lastFocus = document.activeElement;
        document.getElementById("notificationDropdown")?.classList.remove("active");
        document.body.classList.add("mobile-sheet-open");
        sheet.setAttribute("aria-hidden", "false");
        sheet.style.transform = "";
        sheet.querySelector(".mobile-sheet-close")?.focus({ preventScroll: true });
    }

    function closeSheet() {
        if (!document.body.classList.contains("mobile-sheet-open")) return;
        document.body.classList.remove("mobile-sheet-open");
        sheet.setAttribute("aria-hidden", "true");
        sheet.style.transform = "";
        lastFocus?.focus?.({ preventScroll: true });
    }

    scrim.addEventListener("click", closeSheet);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

    sheet.addEventListener("click", e => {
        if (e.target.closest(".mobile-sheet-close")) return closeSheet();
        const action = e.target.closest("[data-action]")?.dataset.action;
        if (action === "password") {
            closeSheet();
            if (typeof window.openChangePasswordModal === "function") window.openChangePasswordModal();
            else document.getElementById("changePasswordBtn")?.click();
        } else if (action === "signout") {
            if (typeof window.signOutUser === "function") window.signOutUser();
        } else if (action === "install") {
            closeSheet();
        } else if (action === "customize") {
            showCustomize();
        } else if (action === "back") {
            sheet.innerHTML = buildCompanySheet();
        } else if (action === "pick") {
            const page = e.target.closest("[data-page]")?.dataset.page;
            if (!page) return;
            const i = customDraft.indexOf(page);
            if (i !== -1) customDraft.splice(i, 1);
            else if (customDraft.length < MAX_TABS) customDraft.push(page);
            else {
                // Full: nudge instead of silently ignoring the tap.
                const sub = sheet.querySelector(".mobile-sheet-head .mobile-sheet-sub");
                if (sub) { sub.textContent = "4 tabs max. Tap one to remove it first."; sub.classList.add("is-warning"); }
                return;
            }
            redrawCustomize();
        } else if (action === "reset") {
            saveCustomTabs(null);
            render();
            customDraft = currentTabPages();
            redrawCustomize();
        } else if (action === "save") {
            if (!customDraft.length) return;
            saveCustomTabs(customDraft);
            render();
            closeSheet();
        } else if (action === "switch") {
            closeSheet();
            // Let this tap finish first, or project-shell.js's "click outside
            // closes it" handler would shut the dropdown right away.
            setTimeout(() => document.getElementById("projectSwitcherToggle")?.click(), 0);
        }
    });

    /* ---------- Sheet height: half / full, drag the handle to resize ----------
       Opens at half the screen and scrolls inside. Dragging the handle (or
       the header) resizes it live; letting go snaps to half or full, and
       dragging well below half closes it. Tapping the handle toggles
       half <-> full. */
    let sheetMode = "half";

    function sheetHeights() {
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        return { half: Math.round(vh * 0.5), full: Math.round(vh * 0.92) };
    }

    function setSheetHeight(mode, animate) {
        sheetMode = mode;
        sheet.classList.toggle("is-dragging", !animate);
        sheet.style.height = `${sheetHeights()[mode]}px`;
        sheet.classList.toggle("is-full", mode === "full");
        if (!animate) requestAnimationFrame(() => sheet.classList.remove("is-dragging"));
    }

    let drag = null; // { startY, startH, moved }

    sheet.addEventListener("touchstart", e => {
        if (!e.target.closest(".mobile-sheet-handle, .mobile-sheet-head")) return;
        // Let buttons in the header (close, back, Switch) stay tappable.
        if (e.target.closest("button")) return;
        drag = { startY: e.touches[0].clientY, startH: sheet.getBoundingClientRect().height, moved: false };
        sheet.classList.add("is-dragging");
    }, { passive: true });

    sheet.addEventListener("touchmove", e => {
        if (!drag) return;
        const dy = e.touches[0].clientY - drag.startY;
        if (Math.abs(dy) > 4) drag.moved = true;
        const { full } = sheetHeights();
        const h = Math.max(80, Math.min(full, drag.startH - dy));
        sheet.style.height = `${h}px`;
    }, { passive: true });

    sheet.addEventListener("touchend", e => {
        if (!drag) return;
        const wasTap = !drag.moved && e.target.closest(".mobile-sheet-handle");
        const h = sheet.getBoundingClientRect().height;
        drag = null;
        sheet.classList.remove("is-dragging");

        if (wasTap) {
            setSheetHeight(sheetMode === "half" ? "full" : "half", true);
            return;
        }
        const { half, full } = sheetHeights();
        if (h < half * 0.65) closeSheet();
        else setSheetHeight(h > (half + full) / 2 ? "full" : "half", true);
    });

    // Keyboard / mouse: clicking the handle also toggles half <-> full.
    sheet.addEventListener("click", e => {
        if (e.target.closest(".mobile-sheet-handle") && e.detail !== 0 && !("ontouchstart" in window)) {
            setSheetHeight(sheetMode === "half" ? "full" : "half", true);
        }
    });

    // Rotating/resizing up past phone width while it's open: just close it.
    window.addEventListener("resize", () => { if (window.innerWidth > 768) closeSheet(); });

    /* ===========================
       SCROLL LOCK (phones)
       While the More sheet, the notification panel, or any popup is open,
       the page behind must not move. iPhone Safari ignores overflow:hidden
       on <body> for touch scrolling, so the reliable way is to pin <body>
       with position:fixed at the current scroll offset, then put the page
       back exactly where it was on close. Scrolling INSIDE the sheet /
       panel / popup still works (they're their own scroll areas).
    =========================== */
    let lockedScrollY = null;

    function setScrollLocked(locked) {
        const body = document.body;
        if (locked && lockedScrollY === null) {
            lockedScrollY = window.scrollY;
            body.style.position = "fixed";
            body.style.top = `-${lockedScrollY}px`;
            body.style.left = "0";
            body.style.right = "0";
            body.style.width = "100%";
            document.documentElement.classList.add("is-scroll-locked");
        } else if (!locked && lockedScrollY !== null) {
            const y = lockedScrollY;
            lockedScrollY = null;
            body.style.position = "";
            body.style.top = "";
            body.style.left = "";
            body.style.right = "";
            body.style.width = "";
            document.documentElement.classList.remove("is-scroll-locked");
            window.scrollTo(0, y);
        }
    }

    function syncScrollLock() {
        const body = document.body;
        const somethingOpen =
            body.classList.contains("mobile-sheet-open") ||
            body.classList.contains("popup-active") ||
            body.classList.contains("photo-menu-open") ||
            body.classList.contains("photo-sheet-open") ||
            body.classList.contains("inv-form-open") ||
            body.classList.contains("acct-search-open") ||
            Boolean(document.querySelector(".notification-dropdown.active"));
        setScrollLocked(somethingOpen && window.innerWidth <= 768);
    }

    const lockObserver = new MutationObserver(syncScrollLock);
    lockObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const notifDropdown = document.getElementById("notificationDropdown");
    if (notifDropdown) lockObserver.observe(notifDropdown, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", syncScrollLock);

    // Re-render when the sidebar changes (nav-access.js hiding items after
    // permissions load, project-shell.js filling in ?id= hrefs). Debounced so
    // a burst of changes only rebuilds once.
    let pending = null;
    const observer = new MutationObserver(() => {
        clearTimeout(pending);
        pending = setTimeout(render, 60);
    });
    observer.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ["style", "class", "href", "hidden"] });

    render();
})();
