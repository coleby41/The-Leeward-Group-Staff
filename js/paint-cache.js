/* ===========================
   PAINT CACHE (instant pages)

   Pages fill most cards in after they open (Supabase queries), so on every
   page change things flashed: stats showing 0 then jumping to the real
   numbers, Quick Links empty then popping in and pushing Weather down,
   "Loading Vendors…", etc.

   Fix: any element marked data-paint-cache="name" remembers what it looked
   like last time (sessionStorage, per signed-in user, per page). On the
   next visit it starts out showing that, and the page's own script then
   quietly swaps in fresh data when it arrives -- usually identical, so
   nothing visibly changes. Stays out of the way otherwise:
     - nothing cached yet (first visit this session) -> normal behavior
     - sessionStorage only: cleared when the app/tab is closed
     - keyed by user id, so a different sign-in never sees someone else's
   While a restored copy is showing, the element has .paint-cached, which
   hides the sibling "Loading…" box (styles.css).

   Also restores the bell's unread count from last time, so the badge
   doesn't blink in/out on every page (notifications.js saves it).

   Load right after the page markup, before the Supabase CDN script, so
   the restore happens before the first paint.
=========================== */
(function () {
    "use strict";

    let uid = "";
    try { uid = (JSON.parse(localStorage.getItem("staffProfile") || "null") || {}).id || ""; } catch (e) {}
    if (!uid) return;

    const page = location.pathname.replace(/\.html$/, "");
    const MAX = 300000; // don't cache anything huge

    function read(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
    function write(key, val) { try { sessionStorage.setItem(key, val); } catch (e) {} }

    // ---- bell badge ----
    const count = read(`notifCount:${uid}`);
    const countEl = document.querySelector(".notification-count");
    if (countEl && count !== null) {
        const n = Number(count) || 0;
        countEl.textContent = n > 9 ? "9+" : String(n);
        countEl.style.display = n > 0 ? "inline-flex" : "none";
    }

    // ---- cached sections ----
    document.querySelectorAll("[data-paint-cache]").forEach(el => {
        const key = `paint:${uid}:${page}:${el.dataset.paintCache}`;
        const saved = read(key);
        if (saved) {
            el.innerHTML = saved;
            el.classList.add("paint-cached");
        }

        let timer = null;
        new MutationObserver(() => {
            // The page has written its own content now.
            el.classList.remove("paint-cached");
            clearTimeout(timer);
            // Save once it settles, so in-between states aren't remembered.
            timer = setTimeout(() => {
                const html = el.innerHTML;
                if (html.trim() && html.length < MAX) write(key, html);
            }, 500);
        }).observe(el, { childList: true, subtree: true, characterData: true });
    });
})();
