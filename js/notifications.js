/* ===========================
   NOTIFICATIONS (Supabase) — shared across every page with the bell icon.
   Uses window.supabaseClient, exposed globally by supabase-auth.js.

   This used to be copy-pasted inline into ~8 different pages (dashboard,
   payroll-tools, venders, manage-employees, new-project, excel-workbook,
   form-template, timesheet), plus a couple of pages (my-tasks, projects)
   that had the bell markup but no loading logic wired at all. The
   "Mark as read" button existed on every page but was never actually
   wired to anything anywhere.

   Read state used to live in localStorage (readNotificationIds), which
   meant it didn't follow a person across devices/browsers, and clicking
   the bell just silently marked things read without the button doing
   anything. Both are fixed here:
     - Read state is now tracked server-side in `notification_reads`
       (see supabase-notification-reads-setup.sql), keyed to the signed-in
       staff_users row, so it's consistent everywhere that person signs in.
     - Once something is marked read, it's dropped from `currentNotifications`
       entirely (not just hidden from the badge count) — it won't come back
       on this page or any other until a new notification is created.
=========================== */

let currentNotifications = [];

function notifyEscapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str ?? "";
    return d.innerHTML;
}

function getNotificationsStaffProfile() {
    if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
    try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); }
    catch { return null; }
}

function getNotificationsStaffId() {
    const profile = getNotificationsStaffProfile();
    return profile?.id || profile?.uid || null;
}

async function loadNotifications() {
    if (!window.supabaseClient) { console.error("Supabase client not ready yet"); return; }

    const userId = getNotificationsStaffId();

    let query = window.supabaseClient
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50); // enough for an accurate badge; the dropdown only SHOWS the newest 2

    query = userId
        ? query.or(`user_id.is.null,user_id.eq.${userId}`)
        : query.is("user_id", null);

    const { data, error } = await query;
    if (error) { console.error("Failed to load notifications:", error); return; }

    const all = data || [];

    let readIds = new Set();
    if (userId && all.length) {
        const { data: readRows, error: readError } = await window.supabaseClient
            .from("notification_reads")
            .select("notification_id")
            .eq("staff_user_id", userId)
            .in("notification_id", all.map(n => n.id));

        if (readError) console.error("Failed to load read state:", readError);
        else readIds = new Set((readRows || []).map(r => r.notification_id));
    }

    // Already-read notifications simply don't show up anymore, on any page.
    currentNotifications = all.filter(n => !readIds.has(n.id));
    renderNotifications();
    toastNewNotifications();
}

/* ---------- yellow "new notification" toast (js/toast.js) ----------
   Pops once per notification per browser: IDs that have already been
   toasted are remembered in localStorage, so reloading or changing pages
   doesn't re-pop the same ones. More than 3 new at once collapses into a
   single "You have N new notifications" toast instead of a wall of them. */

const TOASTED_KEY = "toastedNotificationIds";

function toastNewNotifications() {
    if (typeof window.showToast !== "function") return;

    let toasted;
    try { toasted = new Set(JSON.parse(localStorage.getItem(TOASTED_KEY) || "[]")); }
    catch { toasted = new Set(); }

    const fresh = currentNotifications.filter(n => !toasted.has(n.id));
    if (!fresh.length) return;

    // The Good Morning page already lists these in full — count them as
    // seen so they don't pop as toasts there OR on the next page.
    if (window.suppressNotificationToasts) {
        fresh.forEach(n => toasted.add(n.id));
        try { localStorage.setItem(TOASTED_KEY, JSON.stringify([...toasted].slice(-200))); } catch {}
        return;
    }

    if (fresh.length > 3) {
        window.showToast(`You have ${fresh.length} new notifications.`, { type: "notification" });
    } else {
        fresh.forEach(n => window.showToast(n.title || "New notification", {
            type: "notification",
            link: n.link_url || null,
            linkLabel: n.link_label || null
        }));
    }

    fresh.forEach(n => toasted.add(n.id));
    // Keep only the most recent 200 so this never grows forever.
    try { localStorage.setItem(TOASTED_KEY, JSON.stringify([...toasted].slice(-200))); } catch {}
}

const DROPDOWN_LIMIT = 2;

function notifyTimeAgo(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "Just now";
    if (min < 60) return `${min}m ago`;
    if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
    if (min < 60 * 24 * 7) return `${Math.round(min / 1440)}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Picks the round icon on the left from the notification's wording:
// approved/submitted/complete = green check, rejected/denied = red X,
// form/document/file = blue doc, anything else = blue bell.
function notifyIconType(n) {
    const t = `${n.title || ""} ${n.message || ""}`.toLowerCase();
    if (/reject|denied|declin|fail|overdue|expired/.test(t)) return "danger";
    if (/approv|submitted|complete|success|paid/.test(t)) return "success";
    if (/form|document|file|w-?9|w-?2|1099|coi|report/.test(t)) return "doc";
    return "bell";
}

// Blue "Showing your last 2 notifications" banner under the header, which
// links to the notification center. Injected here so the 19 pages that share
// the bell markup don't each need an HTML edit.
function ensureDropdownBanner() {
    const dropdown = document.getElementById("notificationDropdown");
    const list = document.getElementById("notificationList");
    if (!dropdown || !list) return null;

    let banner = dropdown.querySelector(".notif-banner");
    if (!banner) {
        banner = document.createElement("a");
        banner.className = "notif-banner";
        banner.href = "/pages/notifications.html";
        banner.innerHTML = `
            <span class="notif-banner-icon" aria-hidden="true">i</span>
            <span class="notif-banner-text">
                <strong class="notif-banner-title"></strong>
                <span class="notif-banner-copy"></span>
            </span>`;
        list.parentNode.insertBefore(banner, list);
    }
    return banner;
}

function renderNotifications() {
    const banner = ensureDropdownBanner();
    const list = document.getElementById("notificationList");
    const empty = document.getElementById("notificationEmpty");
    const countEl = document.querySelector(".notification-count");
    const total = currentNotifications.length;

    // Remember the count so the next page shows the right badge right away
    // (js/paint-cache.js restores it before the page first paints).
    const staffId = getNotificationsStaffId();
    if (staffId) { try { sessionStorage.setItem(`notifCount:${staffId}`, String(total)); } catch (e) {} }

    if (countEl) {
        if (total > 0) {
            countEl.style.display = "inline-flex";
            countEl.textContent = total > 9 ? "9+" : String(total);
        } else {
            countEl.style.display = "none";
        }
    }

    if (banner) {
        const title = banner.querySelector(".notif-banner-title");
        const copy = banner.querySelector(".notif-banner-copy");
        if (total > DROPDOWN_LIMIT) {
            title.textContent = `Showing your last ${DROPDOWN_LIMIT} notifications`;
            copy.innerHTML = `Only the most recent two are displayed here. You'll see the full list in your <u>notifications page</u>.`;
        } else {
            title.textContent = "Your notifications";
            copy.innerHTML = `See everything, including ones you've read, in your <u>notifications page</u>.`;
        }
    }

    if (!list) return;
    list.innerHTML = "";

    if (total === 0) {
        list.classList.remove("notif-card");
        if (empty) empty.style.display = "block";
        return;
    }
    if (empty) empty.style.display = "none";
    list.classList.add("notif-card");

    // Dropdown only shows the 2 most recent unread — everything else lives in
    // the notification center (pages/notifications.html) via the banner.
    currentNotifications.slice(0, DROPDOWN_LIMIT).forEach(n => {
        const row = document.createElement("div");
        row.className = "notif-row" + (n.link_url ? " notif-row--link" : "");
        const linkHtml = n.link_url
            ? `<a class="notif-row-link" href="${notifyEscapeHtml(n.link_url)}">${notifyEscapeHtml(n.link_label || "View it here")}</a>`
            : "";
        row.innerHTML = `
            <span class="notif-icon notif-icon--${notifyIconType(n)}" aria-hidden="true"></span>
            <div class="notif-row-body">
                <div class="notif-row-top">
                    <strong>${notifyEscapeHtml(n.title)}</strong>
                    <span class="notif-row-time">${notifyTimeAgo(n.created_at)}</span>
                </div>
                <p>${notifyEscapeHtml(n.message)}</p>
                ${linkHtml}
            </div>
            ${n.link_url ? '<span class="notif-chevron" aria-hidden="true"></span>' : ""}
        `;
        // Whole row is clickable (the chevron), not just "View it here".
        if (n.link_url) {
            row.addEventListener("click", function (e) {
                if (e.target.closest("a")) return;
                window.location.href = n.link_url;
            });
        }
        list.appendChild(row);
    });
}

// The actual "Mark as read" button in the dropdown header. Marks everything
// currently shown as read for this staff member and removes it from view.
async function markAllNotificationsRead() {
    if (!currentNotifications.length) return;

    const userId = getNotificationsStaffId();
    if (!userId) {
        console.warn("Can't persist read state — no signed-in staff profile yet.");
        return;
    }

    const rows = currentNotifications.map(n => ({
        notification_id: n.id,
        staff_user_id: userId
    }));

    const { error } = await window.supabaseClient
        .from("notification_reads")
        .upsert(rows, { onConflict: "notification_id,staff_user_id", ignoreDuplicates: true });

    if (error) { console.error("Failed to mark notifications read:", error); return; }

    currentNotifications = [];
    renderNotifications();
}

function wireMarkReadButton() {
    const btn = document.querySelector("#notificationDropdown .mark-read-btn");
    if (!btn) return;
    btn.addEventListener("click", function (event) {
        event.preventDefault();
        markAllNotificationsRead();
    });
}

// Refresh whenever the bell is opened, so read state stays current across
// tabs/devices now that it's server-side instead of per-browser localStorage.
// notificationBell is declared with `const` at the top level of script.js,
// which loads before this file, so it's already in scope here.
function wireBellRefresh() {
    if (typeof notificationBell !== "undefined" && notificationBell) {
        notificationBell.addEventListener("click", function () {
            loadNotifications();
        });
    }
}

// The staff profile loads asynchronously after sign-in, so poll briefly
// (same pattern used elsewhere in this app, e.g. timesheet.js) rather than
// assuming it's ready the instant the DOM is.
function initNotifications(attempts) {
    attempts = attempts || 0;
    const clientReady = !!window.supabaseClient;
    const profileReady = !!getNotificationsStaffProfile();

    if (clientReady && (profileReady || attempts >= 25)) {
        loadNotifications();
        return;
    }
    if (attempts >= 25) {
        if (clientReady) loadNotifications();
        return;
    }
    setTimeout(function () { initNotifications(attempts + 1); }, 200);
}

function startNotifications() {
    ensureDropdownBanner();
    wireMarkReadButton();
    wireBellRefresh();
    initNotifications();
    // Re-check every 60s so new notifications pop up while a page stays open
    // (no Supabase Realtime in this app — same interval as nav-approvals-badge.js).
    setInterval(function () {
        if (window.supabaseClient && getNotificationsStaffProfile()) loadNotifications();
    }, 60000);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startNotifications);
} else {
    startNotifications();
}
