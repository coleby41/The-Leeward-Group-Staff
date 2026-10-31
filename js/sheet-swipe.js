/* ===========================
   SWIPE DOWN TO CLOSE (phones only)

   On phones every popup is a bottom sheet, so it closes the native way:
   drag it down and let go. The X / Close / Cancel-in-the-header buttons
   are hidden on phones (styles.css, "Phone: swipe-down sheets") — they're
   still in the page, and this script clicks the hidden one when a sheet
   is swiped away, so each page's own close logic (resetting forms,
   stopping the camera, etc.) still runs exactly as before.

   Covers:
     - every .popup-overlay > .popup
     - the photo sheet (project-photos.js), the invoice sheet
       (project-invoices.js) and the invoice search sheet
       (project-accounting.js)
   The "More" sheet (mobile-app.js) already has its own drag-to-close.

   A drag only starts when the sheet is scrolled to the top and the finger
   moves mostly downward, so scrolling inside a sheet, horizontal tables,
   inputs and signature canvases keep working normally. If a sheet can't
   be closed right now (no close control, a disabled one, mid-upload, or
   data-no-swipe on the sheet/overlay) it just springs back.
=========================== */
(function () {
    "use strict";

    const phone = window.matchMedia("(max-width: 768px)");

    // Close buttons inside .popup (same list styles.css hides on phones).
    const POPUP_CLOSE = ".sheet-close, .file-preview-close-btn, .pav-close-btn, .permission-editor-close, button[aria-label^='Close']";

    const SHEETS = [
        {
            sel: ".popup-overlay > .popup",
            close: POPUP_CLOSE,
            isOpen: s => {
                const o = s.parentElement;
                return !o.classList.contains("hidden") && getComputedStyle(o).display !== "none";
            }
        },
        { sel: ".photo-sheet", close: ".photo-sheet-cancel", isOpen: () => document.body.classList.contains("photo-sheet-open") },
        { sel: ".inv-sheet", close: ".inv-head-cancel", isOpen: s => Boolean(s.closest(".inv-overlay.is-open")) },
        { sel: ".acct-search-sheet", close: ".acct-search-cancel", isOpen: () => document.body.classList.contains("acct-search-open") }
    ];

    const NO_DRAG = "input, textarea, select, canvas, [contenteditable], [data-no-swipe]";

    let drag = null; // { sheet, info, startX, startY, dy, lastY, lastT, v, active }

    function findSheet(target) {
        for (const info of SHEETS) {
            const sheet = target.closest(info.sel);
            if (sheet) return { sheet, info };
        }
        return null;
    }

    // True if the finger is inside something that's scrolled down (so a
    // downward drag should scroll it back up, not move the sheet).
    function insideScrolled(el, sheet) {
        for (let n = el; n; n = n.parentElement) {
            if (n.scrollTop > 0) {
                const oy = getComputedStyle(n).overflowY;
                if (oy === "auto" || oy === "scroll") return true;
            }
            if (n === sheet) break;
        }
        return false;
    }

    function closeControl(sheet, info) {
        let btn = sheet.querySelector(info.close);
        // Popups with no X: fall back to a plain "Cancel" (never anything
        // that saves/deletes).
        if (!btn && info.close === POPUP_CLOSE) {
            btn = [...sheet.querySelectorAll("button")].find(b => b.textContent.trim().toLowerCase() === "cancel") || null;
        }
        return btn;
    }

    function canClose(sheet, info) {
        if (sheet.closest("[data-no-swipe]") || sheet.classList.contains("is-uploading")) return false;
        const btn = closeControl(sheet, info);
        if (btn) return !btn.disabled;
        // No button: only the backdrop-tap handler can close it (popups only).
        return info.close === POPUP_CLOSE;
    }

    function setY(sheet, y, animate) {
        sheet.style.transition = animate ? "transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
        sheet.style.transform = y ? `translateY(${y}px)` : "";
    }

    function clearStyles(sheet) {
        sheet.style.transition = "none";
        sheet.style.transform = "";
        requestAnimationFrame(() => { sheet.style.transition = ""; });
    }

    function springBack(sheet) {
        setY(sheet, 0, true);
        setTimeout(() => { sheet.style.transition = ""; }, 220);
    }

    function dismiss(sheet, info) {
        setY(sheet, sheet.offsetHeight + 40, true);
        setTimeout(() => {
            const btn = closeControl(sheet, info);
            if (btn) btn.click();
            else sheet.parentElement.dispatchEvent(new MouseEvent("click", { bubbles: true })); // backdrop tap
            if (info.isOpen(sheet)) springBack(sheet); // page refused to close it
            else clearStyles(sheet);
        }, 200);
    }

    document.addEventListener("touchstart", e => {
        drag = null;
        if (!phone.matches || e.touches.length !== 1) return;
        const hit = findSheet(e.target);
        if (!hit || !hit.info.isOpen(hit.sheet)) return;
        if (e.target.closest(NO_DRAG)) return;
        if (insideScrolled(e.target, hit.sheet)) return;
        const t = e.touches[0];
        drag = { ...hit, startX: t.clientX, startY: t.clientY, dy: 0, lastY: t.clientY, lastT: e.timeStamp, v: 0, active: false };
    }, { passive: true });

    document.addEventListener("touchmove", e => {
        if (!drag) return;
        const t = e.touches[0];
        const dx = t.clientX - drag.startX;
        const dy = t.clientY - drag.startY;

        if (!drag.active) {
            if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
            // Up or sideways: not ours, let it scroll.
            if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { drag = null; return; }
            drag.active = true;
        }

        e.preventDefault(); // stop the page/sheet rubber-banding under the finger
        const dt = Math.max(1, e.timeStamp - drag.lastT);
        drag.v = (t.clientY - drag.lastY) / dt;
        drag.lastY = t.clientY;
        drag.lastT = e.timeStamp;
        drag.dy = Math.max(0, dy);
        setY(drag.sheet, drag.dy, false);
    }, { passive: false });

    function end() {
        if (!drag) return;
        const { sheet, info, dy, v, active } = drag;
        drag = null;
        if (!active) return;
        const far = dy > Math.min(120, sheet.offsetHeight * 0.25);
        const flick = v > 0.6 && dy > 40;
        if ((far || flick) && canClose(sheet, info)) dismiss(sheet, info);
        else springBack(sheet);
    }

    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", () => { if (drag && drag.active) springBack(drag.sheet); drag = null; });
})();
