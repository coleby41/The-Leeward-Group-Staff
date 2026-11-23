/* ===========================
   APP SPLASH (phones only)

   Leeward logo load-in animation, shown once each time the app is opened
   on a phone (once per browser/app session, via sessionStorage), not on
   every page change. Loaded in <head> right after styles.css so the
   splash covers the page before anything paints.

   Sequence (styles.css, "Phone: app splash"):
     sail rises in -> waves sweep in left to right -> name fades in -> tagline fades in ->
     whole splash fades away.
   Desktop/tablet (> 768px) never sees it.
=========================== */
(function () {
    "use strict";

    // Christmas season (Nov 20 - Jan 1). Flags <html> on EVERY screen size
    // so the Christmas logo (img[data-seasonal-logo], styles.css) shows on
    // desktop too — the favicon stays the everyday logo. Set here, in
    // <head>, so the everyday logo never flashes first.
    const today = new Date();
    const tm = today.getMonth(), td = today.getDate();
    const isChristmasSeason = (tm === 10 && td >= 20) || tm === 11 || (tm === 0 && td === 1);
    if (isChristmasSeason) document.documentElement.classList.add("is-christmas-season");

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
        '<div class="app-splash-text">' +
            '<div class="app-splash-name">The Leeward Group</div>' +
            '<div class="app-splash-tagline">Your staff portal for everything you need</div>' +
        '</div>';

    // Christmas extras (Nov 20 - Jan 1): Santa hat drops onto the sail tip
    // after the waves sweep in, and frosty snowflakes drift down behind the logo.
    // Outside those dates the splash is unchanged.
    if (isChristmasSeason) {
        splash.classList.add("is-christmas");
        splash.querySelector(".app-splash-logo").insertAdjacentHTML("beforeend",
            '<img class="app-splash-hat" src="/assets/logos/splash-hat.png" alt="">');

        const flake =
            '<svg viewBox="-10 -10 20 20" aria-hidden="true">' +
                '<g stroke="#7FC4EE" stroke-width="2.4" stroke-linecap="round">' +
                    '<line x1="-8" y1="0" x2="8" y2="0"/>' +
                    '<line x1="-4" y1="-6.9" x2="4" y2="6.9"/>' +
                    '<line x1="-4" y1="6.9" x2="4" y2="-6.9"/>' +
                '</g><circle r="2.2" fill="#fff"/></svg>';
        const snow = document.createElement("div");
        snow.className = "app-splash-snow";
        let html = "";
        for (let i = 0; i < 16; i++) {
            const size = 8 + Math.round(Math.random() * 10);           // px
            const left = Math.round(Math.random() * 100);              // vw %
            const delay = (Math.random() * 1.6).toFixed(2);            // s
            const dur = (2.2 + Math.random() * 1.6).toFixed(2);        // s
            const drift = Math.round(Math.random() * 40 - 20);         // px sideways
            html += '<span style="left:' + left + '%;width:' + size + 'px;height:' + size +
                'px;animation-delay:' + delay + 's;animation-duration:' + dur + 's;--drift:' + drift + 'px">' +
                flake + '</span>';
        }
        snow.innerHTML = html;
        splash.insertBefore(snow, splash.firstChild);
    }

    // <body> doesn't exist yet (we're in <head>), so hang it off <html>.
    document.documentElement.appendChild(splash);

    const SHOW_MS = 2600;   // let the animation play out
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
