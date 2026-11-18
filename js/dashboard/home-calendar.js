/* ============================================================================
   home-calendar.js — linking a calendar on Home › Today (2026-11-18)
   Replaces dashboard/calendar-card.js on pages/dashboard.html (that file is
   left as is). Talks to the "calendar" Edge Function with the person's own
   sign-in, so nobody can link, sync or disconnect someone else's calendar.

   - Link calendar  → Outlook / Microsoft 365 or Google (sign in with them),
                      or Apple iCloud (Apple ID + app-specific password)
   - Manage ›       → status, account, last sync, Sync now, Reconnect, Disconnect
   - Rows view      → your next 4 events (the month view is home-today.js)
   - Syncs quietly in the background when the last sync is over 15 minutes old.
   Tables: calendar_providers, calendar_connections_status, calendar_events_cache
   (sql/supabase-calendar-sync-setup.sql).
============================================================================ */
(function () {
  "use strict";
  const DS = window.DashboardShared;
  const FN = "calendar";
  const MAX_ROWS = 4;
  const STALE_MS = 15 * 60000;
  let conn = null;
  let staffId = null;

  const esc = (s) => DS.escapeHtml(s);

  async function call(body) {
    const sb = window.supabaseClient;
    const { data: { session } } = await sb.auth.getSession();
    const cfg = window.SUPABASE_CONFIG || {};
    const res = await fetch(`${cfg.url}/functions/v1/${FN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey || "", Authorization: `Bearer ${session ? session.access_token : cfg.anonKey}` },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The calendar service returned ${res.status}.`);
    return data;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const listEl = document.getElementById("calendarEventsList");
    if (!listEl || !DS) return;
    const profile = await DS.getStaffProfile();
    staffId = DS.getUserId(profile);
    if (!staffId) { listEl.innerHTML = '<p class="card-subtitle">Sign in to see your calendar.</p>'; return; }

    afterRedirect();
    document.getElementById("linkCalendarLink")?.addEventListener("click", (e) => { e.preventDefault(); openLink(); });
    document.getElementById("manageCalendarLink")?.addEventListener("click", (e) => { e.preventDefault(); openManage(); });
    await refresh();

    // Background sync when it's been a while.
    if (conn && conn.status === "connected" && (!conn.last_synced_at || Date.now() - new Date(conn.last_synced_at).getTime() > STALE_MS)) {
      call({ action: "sync" }).then(() => refresh(true)).catch(err => console.warn("calendar: background sync failed", err));
    }
  });

  function afterRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("calendar_connected")) return;
    const ok = params.get("calendar_connected") === "1";
    const msg = ok ? "Calendar connected." : `Couldn't connect your calendar${params.get("calendar_detail") ? ": " + params.get("calendar_detail") : "."}`;
    if (typeof window.showToast === "function") window.showToast(msg, { type: ok ? "success" : "error" });
    else {
      const banner = document.createElement("div");
      banner.className = `workbook-page-message ${ok ? "success" : "error"}`;
      banner.textContent = msg;
      document.querySelector(".main-content")?.prepend(banner);
      setTimeout(() => banner.remove(), 6000);
    }
    params.delete("calendar_connected"); params.delete("calendar_detail");
    window.history.replaceState({}, "", window.location.pathname + (params.toString() ? `?${params}` : ""));
  }

  async function refresh(synced) {
    const listEl = document.getElementById("calendarEventsList");
    const linkEl = document.getElementById("linkCalendarLink");
    const manageEl = document.getElementById("manageCalendarLink");
    const { data } = await DS.safeQuery("calendar status", window.supabaseClient.from("calendar_connections_status").select("*"));
    conn = (data && data[0]) || null;
    if (linkEl) linkEl.style.display = conn ? "none" : "";
    if (manageEl) manageEl.style.display = conn ? "" : "none";
    if (synced) window.dispatchEvent(new CustomEvent("calendar:synced"));

    if (!conn) { listEl.innerHTML = '<p class="card-subtitle">No calendar linked yet. Use "Link calendar" to connect Outlook, Google or iCloud.</p>'; return; }
    if (conn.status === "error") { listEl.innerHTML = `<p class="card-subtitle">Your calendar needs attention${conn.last_error ? ": " + esc(conn.last_error) : "."} Open "Manage" to reconnect.</p>`; return; }

    const { data: events, error } = await DS.safeQuery("calendar rows", window.supabaseClient.from("calendar_events_cache")
      .select("id, title, start_time, end_time, location, all_day").gte("end_time", new Date().toISOString()).order("start_time").limit(MAX_ROWS));
    if (error) { listEl.innerHTML = '<p class="card-subtitle">Couldn\'t load your events.</p>'; return; }
    if (!events || !events.length) { listEl.innerHTML = '<p class="card-subtitle">Nothing on your calendar in the next few weeks.</p>'; return; }
    listEl.innerHTML = events.map(ev => {
      const s = new Date(ev.start_time), en = new Date(ev.end_time || ev.start_time);
      const day = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const when = ev.all_day ? `${day} · All day` : `${day} · ${s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} – ${en.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      return `<div class="info-item"><div><h3>${esc(ev.title || "Busy")}</h3><p>${esc(when)}${ev.location ? " · " + esc(ev.location) : ""}</p></div></div>`;
    }).join("");
  }

  /* ---------- Link calendar ---------- */

  async function openLink() {
    const { data: providers } = await DS.safeQuery("calendar providers", window.supabaseClient.from("calendar_providers").select("*").eq("is_active", true).order("sort_order"));
    const overlay = DS.buildPopup("homeLinkCalendar", `
      <h2>Link a calendar</h2>
      <p class="card-subtitle">Pick the calendar you use. The portal only reads it — it never changes anything.</p>
      <div class="hm-cal-providers" id="hmCalProviders"></div>
      <form id="hmCalIcloud" class="auth-form auth-form--compact" hidden>
        <p class="auth-inline-copy">Apple needs an <strong>app-specific password</strong> for this (not your normal one):
          go to <a class="auth-link" href="https://account.apple.com/account/manage" target="_blank" rel="noopener">account.apple.com</a> ›
          Sign-In and Security › App-Specific Passwords, make one called "Leeward portal", and paste it here.</p>
        <label class="auth-field">Apple ID email<input type="email" id="hmCalAppleId" autocomplete="username" required></label>
        <label class="auth-field">App-specific password<input type="text" id="hmCalApplePw" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="off" required></label>
        <p class="auth-message" id="hmCalIcloudMsg"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="hmCalIcloudBack">Back</button>
          <button type="submit" class="auth-button" id="hmCalIcloudGo">Connect iCloud</button>
        </div>
      </form>
      <p class="auth-message" id="hmCalLinkMsg"></p>
      <div class="popup-buttons" id="hmCalLinkClose"><button type="button" class="auth-button auth-button--secondary sheet-close" aria-label="Close">Close</button></div>`,
      { extraClass: "hm-cal-popup" });
    const list = overlay.querySelector("#hmCalProviders");
    const msg = overlay.querySelector("#hmCalLinkMsg");
    const form = overlay.querySelector("#hmCalIcloud");
    list.innerHTML = (providers || []).map(p => `
      <button type="button" class="hm-cal-provider" data-id="${esc(p.id)}" data-type="${esc(p.auth_type)}">
        <span class="hm-cal-logo hm-cal-logo--${esc(p.id)}" aria-hidden="true"></span>
        <span><strong>${esc(p.label)}</strong><small>${p.auth_type === "oauth2" ? "Sign in and allow read-only access" : "Apple ID + app-specific password"}</small></span>
        <span class="hm-cal-go" aria-hidden="true">›</span>
      </button>`).join("") || '<p class="card-subtitle">No calendars are set up yet. Run sql/supabase-calendar-sync-setup.sql.</p>';
    list.querySelectorAll(".hm-cal-provider").forEach(b => b.addEventListener("click", async () => {
      if (b.dataset.type === "caldav") { list.hidden = true; form.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = true; overlay.querySelector("#hmCalAppleId").focus(); return; }
      b.disabled = true;
      DS.setFormMessage(msg, "Opening sign-in…", "");
      try { const r = await call({ action: "oauth_start", provider: b.dataset.id }); window.location.href = r.url; }
      catch (err) { b.disabled = false; DS.setFormMessage(msg, err.message, "error"); }
    }));
    overlay.querySelector("#hmCalIcloudBack").addEventListener("click", () => { form.hidden = true; list.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = false; });
    overlay.querySelector("#hmCalLinkClose button").addEventListener("click", () => DS.closePopup(overlay));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fmsg = overlay.querySelector("#hmCalIcloudMsg");
      const go = overlay.querySelector("#hmCalIcloudGo");
      go.disabled = true;
      DS.setFormMessage(fmsg, "Connecting to iCloud…", "");
      try {
        const r = await call({ action: "caldav_connect", username: overlay.querySelector("#hmCalAppleId").value.trim(), app_password: overlay.querySelector("#hmCalApplePw").value.trim() });
        DS.closePopup(overlay);
        if (typeof window.showToast === "function") window.showToast(`iCloud connected — ${r.count || 0} events synced.`, { type: "success" });
        refresh(true);
      } catch (err) { DS.setFormMessage(fmsg, err.message, "error"); }
      finally { go.disabled = false; }
    });
    DS.openPopup(overlay);
  }

  /* ---------- Manage ---------- */

  function openManage() {
    if (!conn) return;
    const when = conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not yet";
    const overlay = DS.buildPopup("homeManageCalendar", `
      <h2>Your calendar</h2>
      <div class="hm-cal-account">
        <span class="hm-cal-logo hm-cal-logo--${esc(conn.provider_id)}" aria-hidden="true"></span>
        <span><strong>${esc(conn.external_account_email || conn.provider_label)}</strong><small>${esc(conn.provider_label)} · Last synced ${esc(when)}</small></span>
        <span class="hm-cal-status hm-cal-status--${conn.status === "error" ? "error" : "ok"}">${conn.status === "error" ? "Needs attention" : "Connected"}</span>
      </div>
      ${conn.status === "error" && conn.last_error ? `<p class="auth-message error">${esc(conn.last_error)}</p>` : ""}
      <p class="auth-message" id="hmCalManageMsg"></p>
      <div class="popup-buttons">
        <button type="button" class="auth-button auth-button--secondary" id="hmCalSync">Sync now</button>
        <button type="button" class="auth-button" id="hmCalReconnect">${conn.status === "error" ? "Reconnect" : "Switch calendar"}</button>
      </div>
      <button type="button" class="hm-cal-disconnect" id="hmCalDisconnect">Disconnect this calendar</button>
      <button type="button" class="sheet-close" aria-label="Close" hidden></button>`,
      { extraClass: "hm-cal-popup" });
    const msg = overlay.querySelector("#hmCalManageMsg");
    overlay.querySelector(".sheet-close").addEventListener("click", () => DS.closePopup(overlay));
    overlay.querySelector("#hmCalSync").addEventListener("click", async (e) => {
      e.target.disabled = true; DS.setFormMessage(msg, "Syncing…", "");
      try {
        const r = await call({ action: "sync" });
        const s = (r.synced || [])[0] || {};
        if (s.status === "error") DS.setFormMessage(msg, s.message || "Sync failed.", "error");
        else DS.setFormMessage(msg, `Synced — ${s.count || 0} events.`, "success");
        refresh(true);
      } catch (err) { DS.setFormMessage(msg, err.message, "error"); }
      finally { e.target.disabled = false; }
    });
    overlay.querySelector("#hmCalReconnect").addEventListener("click", () => { DS.closePopup(overlay); openLink(); });
    overlay.querySelector("#hmCalDisconnect").addEventListener("click", async () => {
      if (!window.confirm("Disconnect this calendar? Its events will disappear from Home until you link it again.")) return;
      DS.setFormMessage(msg, "Disconnecting…", "");
      try { await call({ action: "disconnect" }); DS.closePopup(overlay); refresh(true); }
      catch (err) { DS.setFormMessage(msg, err.message, "error"); }
    });
    DS.openPopup(overlay);
  }
})();
