/* ===========================
   PHONE PUSH NOTIFICATIONS — 2026-11-20

   Everything in the notification center also goes to the devices where
   this person tapped "Turn on phone notifications". Works on:
     - iPhone / iPad (iOS 16.4+) ONLY from the portal saved to the Home
       Screen (Share › Add to Home Screen) — not from a Safari tab
     - Android and desktop browsers
   Loaded by notifications.js on every page with the bell.

   - registers /sw.js (shows the push, opens its link when tapped)
   - Notifications page: a "Phone notifications" panel (turn on / off, test)
   - Bell dropdown: a "Turn on" row while it's off on a device that can
   - keeps the app icon badge = unread count
   Server: supabase/functions/push-send + sql/supabase-push-notifications-setup.sql
=========================== */
(function () {
    "use strict";
    if (window.PushNotifications) return;

    const FN = "push-send";
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    let registration = null;
    let busy = false;

    function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

    async function call(action) {
        const { data, error } = await window.supabaseClient.functions.invoke(FN, { body: { action } });
        if (error) {
            let message = error.message;
            try { const b = await error.context?.json?.(); if (b?.error) message = b.error; } catch { /* keep */ }
            throw new Error(message);
        }
        if (data && data.ok === false) throw new Error(data.error || "Something went wrong.");
        return data;
    }

    async function getRegistration() {
        if (registration) return registration;
        registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        return registration;
    }

    // 'needs-install' | 'unsupported' | 'blocked' | 'on' | 'off'
    async function state() {
        if (isIos && !standalone) return "needs-install";
        if (!supported) return "unsupported";
        if (Notification.permission === "denied") return "blocked";
        try {
            const reg = await getRegistration();
            const sub = await reg.pushManager.getSubscription();
            return sub && Notification.permission === "granted" ? "on" : "off";
        } catch { return "unsupported"; }
    }

    function keyBytes(base64url) {
        const pad = "=".repeat((4 - base64url.length % 4) % 4);
        const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    }

    async function save(sub) {
        const j = sub.toJSON();
        const { error } = await window.supabaseClient.rpc("claim_push_subscription", {
            p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent
        });
        if (error) throw error;
    }

    // Must run from a tap (iOS only asks for permission after one).
    async function enable() {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error(permission === "denied"
            ? "Notifications are blocked for the portal. Turn them on in your phone's Settings › Notifications."
            : "Notifications weren't allowed.");
        const reg = await getRegistration();
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const { key } = await call("public_key");
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        }
        await save(sub);
    }

    async function disable() {
        const reg = await getRegistration();
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await window.supabaseClient.from("push_subscriptions").delete().eq("endpoint", endpoint);
    }

    /* ---------- Notifications page panel ---------- */

    async function renderPanel() {
        const list = document.getElementById("ncList");
        if (!list) return;
        const card = list.closest(".card") || list.parentNode;
        let panel = document.getElementById("pushPanel");
        if (!panel) {
            panel = document.createElement("div");
            panel.id = "pushPanel";
            panel.className = "push-panel";
            card.parentNode.insertBefore(panel, card);
            panel.addEventListener("click", onPanelClick);
        }
        const s = await state();
        const copy = {
            "needs-install": ["Get notifications on your iPhone", "Open the portal from your Home Screen to turn these on. In Safari tap Share › Add to Home Screen, then open the Leeward Staff icon and come back here."],
            unsupported: ["Phone notifications", "This browser can't receive notifications from the portal."],
            blocked: ["Notifications are blocked", "Turn them back on in your device's Settings › Notifications › Leeward Staff (or your browser's site settings), then reload."],
            on: ["Notifications are on for this device", "Everything in your notification center also shows up here, even when the portal is closed."],
            off: ["Get notifications on this device", "Everything in your notification center will also show up on this device, even when the portal is closed."]
        }[s];
        const actions = s === "on"
            ? `<button type="button" class="mark-read-btn" data-push="test">Send a test</button>
               <button type="button" class="mark-read-btn" data-push="off">Turn off</button>`
            : s === "off" ? `<button type="button" class="auth-button" data-push="on">Turn on notifications</button>` : "";
        panel.innerHTML = `
            <div class="push-panel-text"><strong>${esc(copy[0])}</strong><span>${esc(copy[1])}</span></div>
            ${actions ? `<div class="push-panel-actions">${actions}</div>` : ""}
            <p class="push-panel-msg" id="pushPanelMsg" role="status"></p>`;
        panel.dataset.state = s;
    }

    function panelMsg(text, type) {
        const el = document.getElementById("pushPanelMsg");
        if (!el) { if (text) window.showToast?.(text); return; }
        el.textContent = text || "";
        el.className = `push-panel-msg ${type || ""}`.trim();
    }

    async function onPanelClick(e) {
        const b = e.target.closest("[data-push]");
        if (!b || busy) return;
        busy = true;
        b.disabled = true;
        try {
            if (b.dataset.push === "on") { await enable(); await renderPanel(); panelMsg("Notifications are on. Tap Send a test to try it.", "success"); refreshBellRow(); }
            else if (b.dataset.push === "off") { await disable(); await renderPanel(); panelMsg("Notifications are off for this device."); refreshBellRow(); }
            else if (b.dataset.push === "test") { await call("test"); panelMsg("Test sent. It should show up in a few seconds.", "success"); }
        } catch (err) {
            panelMsg(err?.message || "Something went wrong.", "error");
        } finally {
            busy = false;
            if (document.body.contains(b)) b.disabled = false;
        }
    }

    /* ---------- Bell dropdown row ---------- */

    async function refreshBellRow() {
        const dropdown = document.getElementById("notificationDropdown");
        const list = document.getElementById("notificationList");
        if (!dropdown || !list) return;
        let row = dropdown.querySelector(".push-bell-row");
        const s = await state();
        if (s !== "off" || document.getElementById("pushPanel")) { row?.remove(); return; }
        if (!row) {
            row = document.createElement("div");
            row.className = "push-bell-row";
            row.innerHTML = `<span>Get these on this device, even when the portal is closed.</span>
                <button type="button" class="mark-read-btn" data-push-bell>Turn on</button>`;
            list.parentNode.insertBefore(row, list);
            row.querySelector("[data-push-bell]").addEventListener("click", async ev => {
                ev.stopPropagation();
                if (busy) return;
                busy = true;
                const btn = ev.currentTarget;
                btn.disabled = true;
                try { await enable(); row.remove(); window.showToast?.("Notifications are on for this device."); }
                catch (err) { window.showToast?.(err?.message || "Couldn't turn on notifications."); btn.disabled = false; }
                finally { busy = false; }
            });
        }
    }

    /* ---------- app icon badge ---------- */

    function syncBadge() {
        if (!("setAppBadge" in navigator)) return;
        try {
            // currentNotifications = unread list from notifications.js
            const n = typeof currentNotifications !== "undefined" ? currentNotifications.length : 0;
            (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
        } catch { /* ignore */ }
    }
    if (typeof window.renderNotifications === "function") {
        const original = window.renderNotifications;
        window.renderNotifications = function () {
            const r = original.apply(this, arguments);
            syncBadge();
            return r;
        };
    }

    /* ---------- start ---------- */

    async function start(attempts = 0) {
        if (!window.supabaseClient) { if (attempts < 50) setTimeout(() => start(attempts + 1), 200); return; }
        const s = await state();
        // Keep this device's subscription saved under whoever is signed in now.
        if (s === "on") {
            try { const reg = await getRegistration(); const sub = await reg.pushManager.getSubscription(); if (sub) await save(sub); }
            catch (err) { console.warn("Couldn't refresh the push subscription:", err); }
        }
        renderPanel();
        refreshBellRow();
    }

    if (supported) getRegistration().catch(err => console.warn("Service worker didn't register:", err));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start());
    else start();

    window.PushNotifications = { state, enable, disable };
})();
