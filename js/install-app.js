/* ===========================
   INSTALL APP BUTTON (phones only)

   Any element with a `data-install-app` attribute becomes an "Install the
   app" button. It only shows on phone-width screens, and only when the
   portal isn't already running as the installed home-screen app.

   - Android / Chrome: the browser's own install prompt (one tap). Chrome
     only offers it once the site qualifies (manifest.webmanifest + icons),
     so the button stays hidden until the `beforeinstallprompt` event says
     it can be installed.
   - iPhone / iPad: Apple doesn't let websites install themselves, so the
     button opens a short "Share -> Add to Home Screen" guide instead.

   Loaded on login.html and every page with the sidebar. js/mobile-app.js
   adds the same button to the More menu via window.LeewardInstall.

   The Dashboard also gets a closable banner at the top (see
   updateBanner()). Once closed it stays closed on that device
   (localStorage), so it never nags.
=========================== */
(function () {
    "use strict";

    var deferredPrompt = null; // Android/Chrome's saved install prompt
    var installed = false;

    var ua = navigator.userAgent || "";
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    function isStandalone() {
        return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
    }

    function isPhoneWidth() {
        return window.matchMedia ? window.matchMedia("(max-width: 768px)").matches : window.innerWidth <= 768;
    }

    function available() {
        if (installed || isStandalone() || !isPhoneWidth()) return false;
        return !!deferredPrompt || isIOS;
    }

    // Get the App page (pages/get-app.html): its button is
    // data-install-app="any" and also works on computers (Edge/Chrome
    // one-click install), not just phones.
    function availableAnyWidth() {
        if (installed || isStandalone()) return false;
        return !!deferredPrompt || isIOS;
    }

    function refresh() {
        var show = available();
        var showAny = availableAnyWidth();
        document.querySelectorAll("[data-install-app]").forEach(function (el) {
            el.hidden = el.getAttribute("data-install-app") === "any" ? !showAny : !show;
        });
        updateBanner(show);
        document.dispatchEvent(new CustomEvent("leeward-install:change"));
    }

    /* ---------- Dashboard banner ---------- */

    var BANNER_DISMISSED_KEY = "installBannerDismissed";
    var banner = null;

    function onDashboard() {
        var page = (window.location.pathname.split("/").pop() || "").replace(/\.html$/i, "");
        return page === "dashboard";
    }

    function bannerDismissed() {
        try { return localStorage.getItem(BANNER_DISMISSED_KEY) === "1"; } catch (e) { return false; }
    }

    function updateBanner(show) {
        if (!onDashboard()) return;
        var wanted = show && !bannerDismissed();
        if (!wanted) {
            if (banner) banner.hidden = true;
            return;
        }
        if (!banner) {
            var main = document.querySelector(".main-content");
            if (!main) return;
            banner = document.createElement("div");
            banner.className = "install-banner";
            banner.setAttribute("role", "region");
            banner.setAttribute("aria-label", "Install the app");
            banner.innerHTML =
                '<img class="install-banner-icon" src="/assets/icons/apple-touch-icon.png" alt="">' +
                '<div class="install-banner-text">' +
                    '<strong>Get the Leeward Staff app</strong>' +
                    '<span>Add it to your home screen.</span>' +
                '</div>' +
                '<button type="button" class="install-banner-btn" data-install-app>Install</button>' +
                '<button type="button" class="install-banner-close" aria-label="Close">' +
                    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>' +
                '</button>';
            banner.querySelector(".install-banner-close").addEventListener("click", function () {
                try { localStorage.setItem(BANNER_DISMISSED_KEY, "1"); } catch (e) {}
                banner.hidden = true;
            });
            main.insertBefore(banner, main.firstChild);
        }
        banner.hidden = false;
        banner.querySelector("[data-install-app]").hidden = false;
    }

    window.addEventListener("beforeinstallprompt", function (event) {
        event.preventDefault(); // keep it for our button instead of Chrome's mini-bar
        deferredPrompt = event;
        refresh();
    });

    window.addEventListener("appinstalled", function () {
        installed = true;
        deferredPrompt = null;
        refresh();
    });

    window.addEventListener("resize", refresh);

    async function install() {
        if (deferredPrompt) {
            var prompt = deferredPrompt;
            deferredPrompt = null; // a prompt can only be used once
            prompt.prompt();
            try {
                var choice = await prompt.userChoice;
                if (choice && choice.outcome === "accepted") installed = true;
            } catch (e) { /* dismissed */ }
            refresh();
            return;
        }
        if (isIOS) openIosGuide();
    }

    /* ---------- iPhone guide ---------- */

    var SHARE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
    var ADD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';

    var guide = null;

    function openIosGuide() {
        if (!guide) {
            guide = document.createElement("div");
            guide.className = "install-guide";
            guide.setAttribute("role", "dialog");
            guide.setAttribute("aria-modal", "true");
            guide.setAttribute("aria-label", "Add Leeward Staff to your Home Screen");
            guide.innerHTML =
                '<div class="install-guide-card">' +
                    '<div class="install-guide-handle"></div>' +
                    '<div class="install-guide-head">' +
                        '<img class="install-guide-icon" src="/assets/icons/apple-touch-icon.png" alt="">' +
                        '<div><strong>Add Leeward Staff to your Home Screen</strong>' +
                        '<span>Opens full screen, like an app.</span></div>' +
                    '</div>' +
                    '<ol class="install-guide-steps">' +
                        '<li><span class="install-guide-step-icon">' + SHARE_ICON + '</span><span>Tap the <b>Share</b> button in Safari\'s toolbar.</span></li>' +
                        '<li><span class="install-guide-step-icon">' + ADD_ICON + '</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>' +
                        '<li><span class="install-guide-step-icon install-guide-step-icon--text">Add</span><span>Tap <b>Add</b> in the top corner.</span></li>' +
                    '</ol>' +
                    '<button type="button" class="install-guide-done">Got it</button>' +
                '</div>';
            guide.addEventListener("click", function (e) {
                if (e.target === guide || e.target.closest(".install-guide-done")) closeIosGuide();
            });
            document.body.appendChild(guide);
        }
        // Next frame, so the slide-up transition runs.
        requestAnimationFrame(function () { guide.classList.add("is-open"); });
        document.body.classList.add("install-guide-open");
    }

    function closeIosGuide() {
        if (!guide) return;
        guide.classList.remove("is-open");
        document.body.classList.remove("install-guide-open");
    }

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeIosGuide(); });

    document.addEventListener("click", function (e) {
        var button = e.target.closest && e.target.closest("[data-install-app]");
        if (!button) return;
        e.preventDefault();
        install();
    });

    window.LeewardInstall = {
        available: available,
        install: install,
        refresh: refresh,
        isInstalled: function () { return installed || isStandalone(); },
        canPrompt: function () { return !!deferredPrompt; }
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh);
    else refresh();
})();
