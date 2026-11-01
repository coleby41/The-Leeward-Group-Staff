/* ===========================
   APP SPLASH (phones only)

   Leeward logo load-in animation, shown once each time the app is opened
   on a phone (once per browser/app session, via sessionStorage), not on
   every page change. Loaded in <head> right after styles.css so the
   splash covers the page before anything paints.

   Sequence (styles.css, "Phone: app splash"):
     sail rises in -> waves sweep in left to right -> name fades in ->
     whole splash fades away.
   Desktop/tablet (> 768px) never sees it.
=========================== */
(function () {
    "use strict";

    const KEY = "leewardSplashShown";
    try {
        if (!window.matchMedia("(max-width: 768px)").matches) return;
        if (sessionStorage.getItem(KEY)) return;
        sessionStorage.setItem(KEY, "1");
    } catch (e) { return; }

    const splash = document.createElement("div");
    splash.className = "app-splash";
    splash.setAttribute("aria-hidden", "true");
    splash.innerHTML =
        '<div class="app-splash-logo">' +
            '<img class="app-splash-sail" src="/assets/logos/splash-sail.png" alt="">' +
            '<img class="app-splash-waves" src="/assets/logos/splash-waves.png" alt="">' +
        '</div>' +
        '<div class="app-splash-name">The Leeward Group</div>';

    // <body> doesn't exist yet (we're in <head>), so hang it off <html>.
    document.documentElement.appendChild(splash);

    const SHOW_MS = 1700;   // let the animation play out
    const started = Date.now();

    function hide() {
        const wait = Math.max(0, SHOW_MS - (Date.now() - started));
        setTimeout(() => {
            splash.classList.add("is-leaving");
            setTimeout(() => splash.remove(), 400);
        }, wait);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hide, { once: true });
    else hide();
    setTimeout(() => splash.remove(), 4000); // safety net
})();
