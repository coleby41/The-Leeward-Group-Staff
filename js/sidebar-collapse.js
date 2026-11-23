/* ===========================
   SHARED SIDEBAR — HOVER TO EXPAND (every page with #sidebar)
   - Desktop pages sit on the 68px icon-only rail (body.sidebar-collapsed).
     The class is already added by the one-line inline script right before
     each page's <aside class="sidebar">, so the page never paints open
     first and then shuts.
   - Hovering the rail opens the full sidebar (body.sidebar-peek) and the
     page slides over with it. Mouse leaves → back to the rail.
   - No collapse tab / half circle anymore. project-shell.js no longer
     creates one either; its ⌘F search + rail search icon call
     window.SidebarRail.open() so the search box is usable.
   - Phones (<= 820px, script.js SIDEBAR_MOBILE_BREAKPOINT) keep the
     drawer + ☰ button and are never collapsed.
=========================== */
(function () {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const desktopQuery = window.matchMedia("(min-width: 821px)");
    const body = document.body;

    // Small delays so just sweeping the mouse past the rail doesn't flap it
    // open/closed.
    const OPEN_DELAY = 120;
    const CLOSE_DELAY = 200;
    let openTimer = null;
    let closeTimer = null;

    function clearTimers() {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
    }

    function open() {
        if (!desktopQuery.matches) return;
        clearTimers();
        body.classList.remove("sidebar-collapsed");
        body.classList.add("sidebar-peek");
    }

    function close() {
        clearTimers();
        if (!desktopQuery.matches) return;
        body.classList.remove("sidebar-peek");
        body.classList.add("sidebar-collapsed");
    }

    function setMode() {
        clearTimers();
        body.classList.remove("sidebar-peek");
        body.classList.toggle("sidebar-collapsed", desktopQuery.matches);
    }

    setMode();
    desktopQuery.addEventListener("change", setMode);

    sidebar.addEventListener("mouseenter", () => {
        if (!desktopQuery.matches) return;
        clearTimeout(closeTimer);
        if (body.classList.contains("sidebar-peek")) return;
        openTimer = setTimeout(open, OPEN_DELAY);
    });

    sidebar.addEventListener("mouseleave", () => {
        if (!desktopQuery.matches) return;
        clearTimeout(openTimer);
        // Don't snap shut while typing in the sidebar search box.
        if (sidebar.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
        closeTimer = setTimeout(close, CLOSE_DELAY);
    });

    // Opened without hovering (⌘F / search icon): close on a click outside
    // or Escape.
    document.addEventListener("click", (e) => {
        if (body.classList.contains("sidebar-peek") && !sidebar.contains(e.target) && !sidebar.matches(":hover")) close();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && body.classList.contains("sidebar-peek")) close();
    });

    window.SidebarRail = { open, close };
})();
