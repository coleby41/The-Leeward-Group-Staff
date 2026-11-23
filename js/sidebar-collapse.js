/* ===========================
   SHARED SIDEBAR COLLAPSE (every page with #sidebar)
   - Same 3D round tab project pages already had (.sidebar-collapse-toggle,
     styles.css) — now on every page, not just the project family.
   - Desktop pages load COLLAPSED (icon-only rail). The body class is
     already added by the one-line inline script right before each page's
     <aside class="sidebar">, so the page never paints expanded first and
     then animates shut. This file just syncs the tab to that state.
   - Hovering an icon while collapsed shows its tab name in a tooltip.
   - Phones (<= 820px, script.js SIDEBAR_MOBILE_BREAKPOINT) keep the
     drawer + ☰ button and are never collapsed.
   project-shell.js's own initSidebarCollapse() sees #sidebarCollapseToggle
   already exists and bows out, so there's only ever one tab.
=========================== */
(function () {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || document.getElementById("sidebarCollapseToggle")) return;

    const desktopQuery = window.matchMedia("(min-width: 821px)");

    // Hover label element (see "Hover tooltip" below) — created first because
    // setCollapsed() hides it, and setCollapsed() runs during init.
    const tooltip = document.createElement("div");
    tooltip.className = "sidebar-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);

    /* ---------- Toggle tab ---------- */
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "sidebarCollapseToggle";
    toggle.className = "sidebar-collapse-toggle";
    toggle.innerHTML = `<span class="sidebar-collapse-toggle-icon">&lsaquo;</span>`;
    document.body.appendChild(toggle);

    function isCollapsed() {
        return document.body.classList.contains("sidebar-collapsed");
    }

    function positionToggle() {
        const firstItem = sidebar.querySelector(".sidebar-nav .nav-item");
        const rect = (firstItem || sidebar).getBoundingClientRect();
        toggle.style.top = `${rect.top + rect.height / 2}px`;
    }

    function setCollapsed(collapsed) {
        document.body.classList.toggle("sidebar-collapsed", collapsed);
        toggle.classList.toggle("is-collapsed", collapsed);
        toggle.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
        hideTooltip();
    }

    toggle.addEventListener("click", () => setCollapsed(!isCollapsed()));

    // Desktop starts collapsed (inline script already set the class);
    // phones never are.
    setCollapsed(desktopQuery.matches);

    // Crossing the phone breakpoint: drawer on phones, collapsed rail back
    // on desktop.
    desktopQuery.addEventListener("change", (e) => setCollapsed(e.matches));

    window.addEventListener("resize", positionToggle);
    positionToggle();

    /* ---------- Hover tooltip (collapsed only) ----------
       One fixed-position element on <body> rather than a CSS ::after on
       each link — the sidebar's overflow-y:auto would clip anything that
       sticks out past its 68px edge. */
    function labelFor(el) {
        const text = el.querySelector(".nav-text");
        return (text ? text.textContent : el.getAttribute("aria-label") || el.title || "").trim();
    }

    function showTooltip(el) {
        const label = labelFor(el);
        if (!label) return;
        tooltip.textContent = label;
        const rect = el.getBoundingClientRect();
        tooltip.style.top = `${rect.top + rect.height / 2}px`;
        tooltip.style.left = `${sidebar.getBoundingClientRect().right + 30}px`;
        tooltip.classList.add("is-visible");
    }

    function hideTooltip() {
        tooltip.classList.remove("is-visible");
    }

    const hoverTargets = ".nav-item, .sidebar-search-collapsed-btn";

    sidebar.addEventListener("mouseover", (e) => {
        if (!isCollapsed()) return;
        const el = e.target.closest(hoverTargets);
        if (el && sidebar.contains(el)) showTooltip(el);
    });

    sidebar.addEventListener("mouseout", (e) => {
        const el = e.target.closest(hoverTargets);
        if (el && !el.contains(e.relatedTarget)) hideTooltip();
    });

    sidebar.addEventListener("scroll", hideTooltip, { passive: true });

    /* ---------- Dropdown groups (Company docs, IT Tools) ----------
       Their sub-links are text only, so they're hidden on the rail.
       Clicking the group icon while collapsed opens the sidebar with that
       group expanded. Capture phase so this runs before the link's inline
       onclick="toggleSubnav(...)". */
    sidebar.addEventListener("click", (e) => {
        if (!isCollapsed()) return;
        const parent = e.target.closest(".nav-parent");
        if (!parent) return;
        setCollapsed(false);
        if (parent.classList.contains("expanded")) {
            // Already open — keep it open instead of letting toggleSubnav shut it.
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
})();
