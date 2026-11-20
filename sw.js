/* Leeward Staff Portal — service worker (2026-11-20).
   Only shows push notifications (js/push-notifications.js, push-send Edge
   Function). It does NOT cache pages or files, so deploys show up exactly
   as before. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
    const title = data.title || "The Leeward Group";
    const work = [
        self.registration.showNotification(title, {
            body: data.body || "",
            icon: "/assets/icons/icon-192.png",
            badge: "/assets/icons/icon-192.png",
            tag: data.tag || undefined,
            data: { url: data.url || "/pages/notifications" }
        })
    ];
    // App icon badge = unread count (where the device supports it).
    if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
        work.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {}));
    }
    event.waitUntil(Promise.all(work));
});

self.addEventListener("notificationclick", event => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || "/pages/notifications", self.location.origin);
    // Always open it in this portal (a link saved with another portal address keeps its page).
    const url = self.location.origin + target.pathname + target.search + target.hash;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const w of windows) {
            if ("focus" in w) {
                await w.focus();
                if ("navigate" in w) { try { await w.navigate(url); } catch { /* cross-scope */ } }
                return;
            }
        }
        await self.clients.openWindow(url);
    })());
});
