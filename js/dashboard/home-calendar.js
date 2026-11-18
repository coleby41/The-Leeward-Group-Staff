/* ============================================================================
   home-calendar.js — linking a calendar on Home › Today (2026-11-18)
   Replaces dashboard/calendar-card.js on pages/dashboard.html (that file is
   left as is). Talks to the "calendar" Edge Function with the person's own
   sign-in, so nobody can link, sync or disconnect someone else's calendar.

   - Link calendar  → Outlook / Microsoft 365, Google or Apple iCloud: pick one,
                      follow the short how-to, paste its private ICS link
                      (sign-in / app-password paths stay for later use)
   - Manage ›       → every linked calendar (up to 8): color, name, last sync,
                      Rename / Reconnect / Remove, Sync now, Add another calendar
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
  let conns = [];          // the person's linked calendars, oldest first
  let staffId = null;

  // One color per linked calendar (by the order they were linked). home-today.js uses this too.
  const PALETTE = ["#12a08a", "#e0702b", "#c2418f", "#7a8c1e", "#0e8fb5", "#b8860b", "#8a5cc4", "#5a6878"];
  window.HomeCalendarColor = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

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
    if (conns.some(c => c.status === "connected" && (!c.last_synced_at || Date.now() - new Date(c.last_synced_at).getTime() > STALE_MS))) {
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
    const { data } = await DS.safeQuery("calendar status", window.supabaseClient.from("calendar_connections_status").select("*").order("created_at"));
    conns = data || [];
    if (linkEl) linkEl.style.display = conns.length ? "none" : "";
    if (manageEl) manageEl.style.display = conns.length ? "" : "none";
    if (synced) window.dispatchEvent(new CustomEvent("calendar:synced"));

    if (!conns.length) { listEl.innerHTML = '<p class="card-subtitle">No calendar linked yet. Use "Link calendar" to connect Outlook, Google or iCloud.</p>'; return; }
    const broken = conns.filter(c => c.status === "error");
    const warn = broken.length ? `<p class="card-subtitle">${esc(broken.map(c => c.external_account_email || c.provider_label).join(", "))} needs attention. Open "Manage" to fix it.</p>` : "";

    const { data: events, error } = await DS.safeQuery("calendar rows", window.supabaseClient.from("calendar_events_cache")
      .select("id, title, start_time, end_time, location, all_day, account_id").gte("end_time", new Date().toISOString()).order("start_time").limit(MAX_ROWS));
    if (error) { listEl.innerHTML = warn + '<p class="card-subtitle">Couldn\'t load your events.</p>'; return; }
    if (!events || !events.length) { listEl.innerHTML = warn + '<p class="card-subtitle">Nothing on your calendars in the next few weeks.</p>'; return; }
    const byId = new Map(conns.map((c, i) => [c.id, { name: c.external_account_email || c.provider_label, color: window.HomeCalendarColor(i) }]));
    listEl.innerHTML = warn + events.map(ev => {
      const s = new Date(ev.start_time), en = new Date(ev.end_time || ev.start_time);
      const day = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const when = ev.all_day ? `${day} · All day` : `${day} · ${s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} – ${en.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      const cal = byId.get(ev.account_id);
      const tag = conns.length > 1 && cal ? `<span class="hm-cal-tag"><i style="background:${cal.color}"></i>${esc(cal.name)}</span>` : "";
      return `<div class="info-item"><div><h3>${esc(ev.title || "Busy")}</h3><p>${esc(when)}${ev.location ? " · " + esc(ev.location) : ""}</p>${tag}</div></div>`;
    }).join("");
  }

  /* ---------- Link calendar ---------- */

  // Where each calendar keeps its private subscribe (ICS) link.
  const HOW_TO = {
    microsoft: `<ol class="hm-cal-steps">
        <li>Open <a class="auth-link" href="https://outlook.office.com/calendar" target="_blank" rel="noopener">Outlook on the web</a> (not the desktop app).</li>
        <li>Settings ⚙ › <strong>Calendar</strong> › <strong>Shared calendars</strong>.</li>
        <li>Under <strong>Publish a calendar</strong>, pick your calendar and <strong>Can view all details</strong>, then <strong>Publish</strong>.</li>
        <li>Copy the <strong>ICS</strong> link and paste it below.</li></ol>
      <p class="hm-cal-note">Don't see "Publish a calendar"? Your company's Microsoft 365 admin has it turned off. Outlook can take a few hours to show new events here.</p>`,
    google: `<ol class="hm-cal-steps">
        <li>Open <a class="auth-link" href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noopener">Google Calendar settings</a> on a computer.</li>
        <li>On the left under <strong>Settings for my calendars</strong>, click your calendar.</li>
        <li>Scroll to <strong>Integrate calendar</strong> and copy <strong>Secret address in iCal format</strong>.</li>
        <li>Paste it below.</li></ol>`,
    icloud: `<ol class="hm-cal-steps">
        <li>On your iPhone, open <strong>Calendar</strong> › <strong>Calendars</strong>.</li>
        <li>Tap ⓘ next to your calendar and turn on <strong>Public Calendar</strong>.</li>
        <li>Tap <strong>Share Link…</strong> › <strong>Copy</strong>, and paste it below (the webcal:// link is fine).</li></ol>
      <p class="hm-cal-note">On a Mac: Calendar app › right-click the calendar › Share Calendar › tick Public Calendar.</p>`
  };

  async function openLink(replaceId) {
    const { data: providers } = await DS.safeQuery("calendar providers", window.supabaseClient.from("calendar_providers").select("*").eq("is_active", true).order("sort_order"));
    const overlay = DS.buildPopup("homeLinkCalendar", `
      <h2>${replaceId ? "Reconnect calendar" : conns.length ? "Add another calendar" : "Link a calendar"}</h2>
      <p class="card-subtitle">Pick the calendar you use. The portal only reads it — it never changes anything.</p>
      <div class="hm-cal-providers" id="hmCalProviders"></div>
      <form id="hmCalIcs" class="auth-form auth-form--compact" hidden>
        <div id="hmCalIcsHow"></div>
        <label class="auth-field">Calendar link<input type="url" id="hmCalIcsUrl" placeholder="https://… or webcal://…" autocomplete="off" required></label>
        <label class="auth-field">Name it <span class="hm-cal-optional">(optional)</span><input type="text" id="hmCalIcsName" maxlength="80" placeholder="e.g. Coleby's Work" autocomplete="off"></label>
        <p class="hm-cal-note">Leave blank to use the calendar's own name.</p>
        <p class="hm-cal-note">Keep this link private — anyone who has it can see your calendar. The portal stores it encrypted.</p>
        <p class="auth-message" id="hmCalIcsMsg"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="hmCalIcsBack">Back</button>
          <button type="submit" class="auth-button" id="hmCalIcsGo">Connect</button>
        </div>
      </form>
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
    const icsForm = overlay.querySelector("#hmCalIcs");
    let icsProvider = null;
    list.innerHTML = (providers || []).map(p => `
      <button type="button" class="hm-cal-provider" data-id="${esc(p.id)}" data-type="${esc(p.auth_type)}">
        <span class="hm-cal-logo hm-cal-logo--${esc(p.id)}" aria-hidden="true"></span>
        <span><strong>${esc(p.label)}</strong><small>${p.auth_type === "ics" ? "Paste your calendar's private link" : p.auth_type === "oauth2" ? "Sign in and allow read-only access" : "Apple ID + app-specific password"}</small></span>
        <span class="hm-cal-go" aria-hidden="true">›</span>
      </button>`).join("") || '<p class="card-subtitle">No calendars are set up yet. Run sql/supabase-calendar-sync-setup.sql.</p>';
    list.querySelectorAll(".hm-cal-provider").forEach(b => b.addEventListener("click", async () => {
      if (b.dataset.type === "ics") {
        icsProvider = b.dataset.id;
        overlay.querySelector("#hmCalIcsHow").innerHTML = HOW_TO[icsProvider] || "";
        list.hidden = true; icsForm.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = true;
        DS.setFormMessage(overlay.querySelector("#hmCalIcsMsg"), "", "");
        overlay.querySelector("#hmCalIcsUrl").focus();
        return;
      }
      if (b.dataset.type === "caldav") { list.hidden = true; form.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = true; overlay.querySelector("#hmCalAppleId").focus(); return; }
      b.disabled = true;
      DS.setFormMessage(msg, "Opening sign-in…", "");
      try { const r = await call({ action: "oauth_start", provider: b.dataset.id, account_id: replaceId || null }); window.location.href = r.url; }
      catch (err) { b.disabled = false; DS.setFormMessage(msg, err.message, "error"); }
    }));
    overlay.querySelector("#hmCalIcloudBack").addEventListener("click", () => { form.hidden = true; list.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = false; });
    overlay.querySelector("#hmCalLinkClose button").addEventListener("click", () => DS.closePopup(overlay));
    overlay.querySelector("#hmCalIcsBack").addEventListener("click", () => { icsForm.hidden = true; list.hidden = false; overlay.querySelector("#hmCalLinkClose").hidden = false; });
    icsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fmsg = overlay.querySelector("#hmCalIcsMsg");
      const go = overlay.querySelector("#hmCalIcsGo");
      go.disabled = true;
      DS.setFormMessage(fmsg, "Checking your calendar link…", "");
      try {
        const r = await call({ action: "ics_connect", account_id: replaceId || null, provider: icsProvider, url: overlay.querySelector("#hmCalIcsUrl").value.trim(), name: overlay.querySelector("#hmCalIcsName").value.trim() });
        if (r.status === "error") throw new Error(r.message || "Couldn't read that calendar.");
        DS.closePopup(overlay);
        if (typeof window.showToast === "function") window.showToast(`Calendar connected — ${r.count || 0} events synced.`, { type: "success" });
        refresh(true);
      } catch (err) { DS.setFormMessage(fmsg, err.message, "error"); }
      finally { go.disabled = false; }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fmsg = overlay.querySelector("#hmCalIcloudMsg");
      const go = overlay.querySelector("#hmCalIcloudGo");
      go.disabled = true;
      DS.setFormMessage(fmsg, "Connecting to iCloud…", "");
      try {
        const r = await call({ action: "caldav_connect", account_id: replaceId || null, username: overlay.querySelector("#hmCalAppleId").value.trim(), app_password: overlay.querySelector("#hmCalApplePw").value.trim() });
        DS.closePopup(overlay);
        if (typeof window.showToast === "function") window.showToast(`iCloud connected — ${r.count || 0} events synced.`, { type: "success" });
        refresh(true);
      } catch (err) { DS.setFormMessage(fmsg, err.message, "error"); }
      finally { go.disabled = false; }
    });
    DS.openPopup(overlay);
  }

  /* ---------- Manage (all linked calendars) ---------- */

  function openManage() {
    if (!conns.length) return;
    const fmt = (t) => t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not yet";
    const rows = conns.map((c, i) => `
      <div class="hm-cal-account" data-id="${esc(c.id)}">
        <i class="hm-cal-swatch" style="background:${window.HomeCalendarColor(i)}" aria-hidden="true"></i>
        <span><strong>${esc(c.external_account_email || c.provider_label)}</strong><small>${esc(c.provider_label)} · Last synced ${esc(fmt(c.last_synced_at))}</small>
          ${c.status === "error" && c.last_error ? `<small class="hm-cal-err">${esc(c.last_error)}</small>` : ""}</span>
        <span class="hm-cal-acts">
          ${c.status === "error" ? '<button type="button" class="hm-cal-act" data-act="reconnect">Reconnect</button>' : ""}
          <button type="button" class="hm-cal-act" data-act="rename">Rename</button>
          <button type="button" class="hm-cal-act hm-cal-act--danger" data-act="remove">Remove</button>
        </span>
      </div>`).join("");
    const overlay = DS.buildPopup("homeManageCalendar", `
      <h2>Your calendars</h2>
      <div class="hm-cal-accounts">${rows}</div>
      <p class="auth-message" id="hmCalManageMsg"></p>
      <div class="popup-buttons">
        <button type="button" class="auth-button auth-button--secondary" id="hmCalSync">Sync now</button>
        <button type="button" class="auth-button" id="hmCalAdd">+ Add another calendar</button>
      </div>
      <button type="button" class="sheet-close" aria-label="Close" hidden></button>`,
      { extraClass: "hm-cal-popup" });
    const msg = overlay.querySelector("#hmCalManageMsg");
    overlay.querySelector(".sheet-close").addEventListener("click", () => DS.closePopup(overlay));
    const reopen = async () => { DS.closePopup(overlay); await refresh(true); if (conns.length) openManage(); };

    overlay.querySelector("#hmCalSync").addEventListener("click", async (e) => {
      e.target.disabled = true; DS.setFormMessage(msg, "Syncing…", "");
      try {
        const r = await call({ action: "sync" });
        const bad = (r.synced || []).filter(x => x.status === "error");
        const total = (r.synced || []).reduce((n, x) => n + (x.count || 0), 0);
        if (bad.length) DS.setFormMessage(msg, bad.map(x => x.message).join(" "), "error");
        else DS.setFormMessage(msg, `Synced — ${total} events.`, "success");
        refresh(true);
      } catch (err) { DS.setFormMessage(msg, err.message, "error"); }
      finally { e.target.disabled = false; }
    });
    overlay.querySelector("#hmCalAdd").addEventListener("click", () => { DS.closePopup(overlay); openLink(); });

    overlay.querySelectorAll(".hm-cal-account").forEach(row => {
      const id = row.dataset.id;
      const c = conns.find(x => x.id === id);
      row.querySelectorAll(".hm-cal-act").forEach(btn => btn.addEventListener("click", async () => {
        const act = btn.dataset.act;
        if (act === "reconnect") { DS.closePopup(overlay); openLink(id); return; }
        if (act === "rename") {
          const name = window.prompt("Name this calendar:", c.external_account_email || "");
          if (name === null || !name.trim()) return;
          DS.setFormMessage(msg, "Saving…", "");
          try { await call({ action: "rename", account_id: id, name: name.trim() }); await reopen(); }
          catch (err) { DS.setFormMessage(msg, err.message, "error"); }
          return;
        }
        if (act === "remove") {
          if (!window.confirm(`Remove "${c.external_account_email || c.provider_label}"? Its events will disappear from Home.`)) return;
          DS.setFormMessage(msg, "Removing…", "");
          try { await call({ action: "disconnect", account_id: id }); await reopen(); }
          catch (err) { DS.setFormMessage(msg, err.message, "error"); }
        }
      }));
    });
    DS.openPopup(overlay);
  }
})();
