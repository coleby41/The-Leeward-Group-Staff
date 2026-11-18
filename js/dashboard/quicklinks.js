/* ============================================================================
   quicklinks-card.js — "Quick Links" dashboard card
   Requires: dashboard-shared.js loaded first, and this markup in dashboard.html:

     <div class="card">
       <div class="card-header">
         <h2 class="card-title">Quick Links</h2>
       </div>
       <div id="quickLinksGrid" class="quick-links-grid"></div>
       <a href="#" id="editShortcutsLink" class="auth-link">Edit shortcuts</a>
     </div>

   Tables: public.quick_link_types (catalog, extensible), public.user_quick_links
   (each user's picks, max 6, enforced here in JS).

   ADDING A NEW SHORTCUT TYPE LATER: insert a row into quick_link_types (SQL).
   If it needs a bespoke glyph, add an entry to the ICONS map and a matching
   keyword rule to LABEL_ICON_RULES below (or set icon_class to an existing
   ICONS key) — no other code changes required. Unmatched types fall back to
   ICONS.default. That's the "future expansion" path the spec asked for.
============================================================================ */

(function () {
  "use strict";

  const DS = window.DashboardShared;
  const MAX_SHORTCUTS = 12;

  // Inline SVG glyphs, styled dark green on a light green block via
  // .quick-link-icon / .quick-link-icon svg in styles.css. Looked up by
  // resolveIcon() below, which checks icon_class first, then falls back to
  // matching keywords in the shortcut's label. Add a new key + keyword rule
  // when a new shortcut type needs a bespoke glyph; anything unmatched falls
  // back to ICONS.default (a link icon), so no other code changes required.
  const ICON_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    expense: `<svg ${ICON_SVG_ATTRS}><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path><rect x="9" y="11" width="6" height="4" rx="1" fill="currentColor" stroke="none"></rect></svg>`,
    timesheet: `<svg ${ICON_SVG_ATTRS}><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    docs: `<svg ${ICON_SVG_ATTRS}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" stroke="none"></path></svg>`,
    vendor: `<svg ${ICON_SVG_ATTRS}><circle cx="8.5" cy="8" r="3.5" fill="currentColor" stroke="none"></circle><path d="M2 20v-1.5A4.5 4.5 0 0 1 6.5 14h4A4.5 4.5 0 0 1 15 18.5V20z" fill="currentColor" stroke="none"></path><circle cx="17" cy="7" r="3" fill="currentColor" stroke="none" opacity="0.85"></circle><path d="M14.5 13.2A4.5 4.5 0 0 1 20 17.5V19h-3" fill="currentColor" stroke="none" opacity="0.85"></path></svg>`,
    ithelp: `<svg ${ICON_SVG_ATTRS}><path d="M4 13v-1a8 8 0 0 1 16 0v1"></path><rect x="2" y="13" width="5" height="7" rx="2" fill="currentColor" stroke="none"></rect><rect x="17" y="13" width="5" height="7" rx="2" fill="currentColor" stroke="none"></rect><path d="M19 20a4 4 0 0 1-4 2h-2"></path></svg>`,
    site: `<svg ${ICON_SVG_ATTRS}><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
    project: `<svg ${ICON_SVG_ATTRS}><path d="M3 21h18"></path><path d="M5 21V8l7-5 7 5v13"></path><path d="M9 21v-6h6v6"></path></svg>`,
    todo: `<svg ${ICON_SVG_ATTRS}><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M8 12l3 3 5-6"></path></svg>`,
    page: `<svg ${ICON_SVG_ATTRS}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M14 3v6h6"></path><path d="M8 13h8M8 17h5"></path></svg>`,
    home: `<svg ${ICON_SVG_ATTRS}><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h14V10"></path></svg>`,
    incident: `<svg ${ICON_SVG_ATTRS}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4M12 17h.01"></path></svg>`,
    money: `<svg ${ICON_SVG_ATTRS}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>`,
    default: `<svg ${ICON_SVG_ATTRS}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  };

  // label keyword -> ICONS key. Checked in order; first match wins.
  const LABEL_ICON_RULES = [
    [/expense/i, "expense"],
    [/time\s*sheet|timesheet/i, "timesheet"],
    [/doc/i, "docs"],
    [/vendor|contact/i, "vendor"],
    [/it\s*help|support|help\s*desk/i, "ithelp"],
    [/site|website/i, "site"],
  ];

  // If a shortcut's label doesn't match any rule above (unknown/custom
  // type), it cycles through this pool instead of every unmatched shortcut
  // showing the same glyph. Keeps unmatched icons visually distinct from
  // each other even without knowing the real label ahead of time.
  const FALLBACK_ICONS = [
    `<svg ${ICON_SVG_ATTRS}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`, // link
    `<svg ${ICON_SVG_ATTRS}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`, // star
    `<svg ${ICON_SVG_ATTRS}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`, // bookmark
    `<svg ${ICON_SVG_ATTRS}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>`, // flag
    `<svg ${ICON_SVG_ATTRS}><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>`, // compass
    `<svg ${ICON_SVG_ATTRS}><path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12.01V2h10.01l8.58 8.58a2 2 0 0 1 0 2.83z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`, // tag
  ];
  ICONS.default = FALLBACK_ICONS[0];

  // Portal addresses → icon (checked before the label rules).
  const URL_ICON_RULES = [
    [/project-timeline/i, "timesheet"],
    [/project-todo/i, "todo"],
    [/project-files/i, "docs"],
    [/project-accounting/i, "money"],
    [/project-accounts|project-bid-invites/i, "vendor"],
    [/project-form-logs/i, "page"],
    [/projects\.html\?id=|project-[a-z-]+\.html\?id=/i, "project"],
    [/project-home/i, "project"],
    [/dashboard\.html/i, "home"],
    [/timesheet/i, "timesheet"],
    [/vendor/i, "vendor"],
    [/incident/i, "incident"],
    [/account-activity|invoice|expense|payroll/i, "money"],
  ];

  function resolveIcon(display, index) {
    if (display.iconClass && ICONS[display.iconClass]) return ICONS[display.iconClass];
    const byUrl = URL_ICON_RULES.find(([pattern]) => pattern.test(display.url || ""));
    if (byUrl) return ICONS[byUrl[1]];
    const label = display.label || "";
    const rule = LABEL_ICON_RULES.find(([pattern]) => pattern.test(label));
    if (rule) return ICONS[rule[1]];
    return FALLBACK_ICONS[index % FALLBACK_ICONS.length];
  }

  let currentProfile = null;
  let typeCatalog = []; // public.quick_link_types rows
  let userLinks = [];   // public.user_quick_links rows (joined)

  document.addEventListener("DOMContentLoaded", async () => {
    const gridEl = document.getElementById("quickLinksGrid");
    const editLink = document.getElementById("editShortcutsLink");
    if (!gridEl) return;

    currentProfile = await DS.getStaffProfile();

    const { data: types } = await DS.safeQuery(
      "load quick_link_types",
      window.supabaseClient
        .from("quick_link_types")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
    );
    typeCatalog = types || [];

    await loadUserLinks();

    if (editLink) {
      editLink.addEventListener("click", (e) => {
        e.preventDefault();
        openEditShortcutsModal();
      });
    }
  });

  async function loadUserLinks() {
    const gridEl = document.getElementById("quickLinksGrid");
    if (!currentProfile) {
      gridEl.innerHTML = `<p class="card-subtitle quick-links-empty">Sign in to see your shortcuts.</p>`;
      return;
    }

    const { data, error } = await DS.safeQuery(
      "load user_quick_links",
      window.supabaseClient
        .from("user_quick_links")
        .select("*")
        .eq("user_id", DS.getUserId(currentProfile))
        .order("sort_order", { ascending: true })
        .limit(MAX_SHORTCUTS)
    );

    if (error) {
      gridEl.innerHTML = `<p class="card-subtitle quick-links-empty">Couldn't load shortcuts.</p>`;
      return;
    }

    userLinks = data || [];
    renderGrid();
  }

  function resolveLinkDisplay(link) {
    const type = typeCatalog.find((t) => t.id === link.shortcut_type);
    if (!type) return null;

    if (type.requires_custom_url) {
      return {
        label: link.custom_label || "Custom Link",
        url: link.custom_url || "#",
        iconClass: type.icon_class,
      };
    }
    return {
      label: type.label,
      url: type.default_url,
      iconClass: type.icon_class,
    };
  }

  function renderGrid() {
    const gridEl = document.getElementById("quickLinksGrid");

    if (userLinks.length === 0) {
      gridEl.innerHTML = `<p class="card-subtitle quick-links-empty">No shortcuts yet. Use "Edit" to add up to ${MAX_SHORTCUTS}.</p>`;
      return;
    }

    gridEl.innerHTML = userLinks
      .slice(0, MAX_SHORTCUTS)
      .map((link, index) => {
        const display = resolveLinkDisplay(link);
        if (!display) return "";
        const isExternal = /^https?:\/\//i.test(display.url || "");
        return `
          <a class="quick-link-item" href="${DS.escapeHtml(display.url || "#")}" ${isExternal ? 'target="_blank" rel="noopener"' : ""}>
            <div class="quick-link-icon">${resolveIcon(display, index)}</div>
            <div class="quick-link-text">${DS.escapeHtml(display.label)}</div>
          </a>
        `;
      })
      .join("");
  }

  /* ------------------------------------------------------------------- */

  /* ---------- Edit popup: your links + add from Portal pages / Projects / Custom ---------- */

  let addTab = "portal";
  let projectsCache = null;
  const esc = (v) => DS.escapeHtml(v == null ? "" : String(v));
  const sameUrl = (a, b) => String(a || "").replace(/\/+$/, "").toLowerCase() === String(b || "").replace(/\/+$/, "").toLowerCase();

  // Every page in the side menu this person can see (nav-access hides the rest).
  function portalPages() {
    const seen = new Set();
    const out = [];
    document.querySelectorAll(".sidebar a[href^='/pages/']").forEach((a) => {
      const group = a.closest(".nav-item-group");
      if (a.style.display === "none" || (group && group.style.display === "none")) return;
      const url = a.getAttribute("href");
      const label = (a.querySelector(".nav-text") || a).textContent.replace(/\s+/g, " ").trim();
      if (!label || seen.has(url)) return;
      seen.add(url);
      const parent = group && group.querySelector(".nav-parent .nav-text");
      out.push({ label, url, sub: parent && !a.classList.contains("nav-parent") ? parent.textContent.trim() : "Portal page" });
    });
    // Built-in shortcut types (company tools, outside sites).
    typeCatalog.filter((t) => !t.requires_custom_url).forEach((t) => {
      if (out.some((p) => sameUrl(p.url, t.default_url))) return;
      out.push({ label: t.label, url: t.default_url, sub: t.default_url && /^https?:/i.test(t.default_url) ? "Company tool" : "Portal page", typeId: t.id, iconClass: t.icon_class });
    });
    return out;
  }

  // The pages inside a project (same as the project side menu).
  const PROJECT_PAGES = [
    ["Overview", "/pages/projects.html"],
    ["Project Files", "/pages/project-files.html"],
    ["Form Logs", "/pages/project-form-logs.html"],
    ["Bid Invites", "/pages/project-bid-invites.html"],
    ["Project Timeline", "/pages/project-timeline.html"],
    ["To-do", "/pages/project-todo.html"],
    ["Accounts / Contacts", "/pages/project-accounts.html"],
    ["Accounting", "/pages/project-accounting.html"],
  ];
  const openProjects = new Set();

  async function loadProjects() {
    if (projectsCache) return projectsCache;
    const { data } = await DS.safeQuery("quick link projects",
      window.supabaseClient.from("projects").select("id, name, status").neq("status", "archived").order("name"));
    projectsCache = (data || []).map((p) => ({
      id: p.id, label: p.name, url: `/pages/projects.html?id=${encodeURIComponent(p.id)}`, sub: "Project",
      pages: PROJECT_PAGES.slice(1).map(([name, page]) => ({
        label: `${p.name} · ${name}`, name, url: `${page}?id=${encodeURIComponent(p.id)}`, sub: name,
      })),
    }));
    return projectsCache;
  }

  function openEditShortcutsModal() {
    addTab = "portal";
    const overlay = DS.buildPopup(
      "editShortcutsModal",
      `
      <header class="ql-head">
        <div>
          <h2>Quick links</h2>
          <p id="qlCount" class="ql-count"></p>
        </div>
        <button type="button" class="ql-x sheet-close" aria-label="Close">×</button>
      </header>
      <div class="ql-body">
        <p class="ql-label">Your quick links</p>
        <div id="currentShortcutsList" class="ql-list"></div>

        <p class="ql-label ql-label--add">Add a quick link</p>
        <div class="ql-tabs" role="tablist">
          <button type="button" role="tab" data-tab="portal">Portal pages</button>
          <button type="button" role="tab" data-tab="projects">Projects</button>
          <button type="button" role="tab" data-tab="custom">Custom link</button>
        </div>
        <input type="search" id="qlSearch" class="ql-search" placeholder="Search…" autocomplete="off">
        <div id="qlOptions" class="ql-list ql-options"></div>
        <form id="addShortcutForm" class="ql-custom" hidden>
          <label class="auth-field">Name<input type="text" id="customLabelInput" maxlength="60" placeholder="e.g. Procore"></label>
          <label class="auth-field">Web address<input type="url" id="customUrlInput" placeholder="https://"></label>
          <button type="submit" class="auth-button" id="addShortcutBtn">Add link</button>
        </form>
      </div>
      <footer class="ql-foot">
        <p id="shortcutMessage" class="auth-message"></p>
        <button type="button" class="auth-button" id="closeEditShortcutsBtn">Done</button>
      </footer>
      `,
      { extraClass: "ql-popup" }
    );

    renderCurrentShortcuts(overlay);
    renderOptions(overlay);
    DS.openPopup(overlay);

    const close = () => DS.closePopup(overlay);
    overlay.querySelector("#closeEditShortcutsBtn").addEventListener("click", close);
    overlay.querySelector(".ql-x").addEventListener("click", close);
    overlay.querySelectorAll(".ql-tabs [data-tab]").forEach((btn) => btn.addEventListener("click", () => {
      addTab = btn.dataset.tab;
      overlay.querySelector("#qlSearch").value = "";
      renderOptions(overlay);
    }));
    overlay.querySelector("#qlSearch").addEventListener("input", () => renderOptions(overlay));
    overlay.querySelector("#addShortcutForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const label = overlay.querySelector("#customLabelInput").value.trim();
      let url = overlay.querySelector("#customUrlInput").value.trim();
      if (!label || !url) { DS.setFormMessage(overlay.querySelector("#shortcutMessage"), "Enter a name and a web address.", "error"); return; }
      if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) url = `https://${url}`;
      if (await addShortcut(overlay, { label, url })) overlay.querySelector("#addShortcutForm").reset();
    });
  }

  async function renderOptions(overlay) {
    overlay.querySelectorAll(".ql-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === addTab)));
    const search = overlay.querySelector("#qlSearch");
    const box = overlay.querySelector("#qlOptions");
    const form = overlay.querySelector("#addShortcutForm");
    const custom = addTab === "custom";
    search.hidden = custom; box.hidden = custom; form.hidden = !custom;
    if (custom) return;

    search.placeholder = addTab === "projects" ? "Search projects or pages (e.g. \"oleander to-do\")…" : "Search pages…";
    if (addTab === "projects" && !projectsCache) box.innerHTML = '<p class="ql-empty">Loading projects…</p>';
    const all = addTab === "projects" ? await loadProjects() : portalPages();
    if (addTab !== (overlay.querySelector('.ql-tabs [aria-selected="true"]') || {}).dataset?.tab) return; // switched while loading
    const q = search.value.trim().toLowerCase();
    const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, "");   // "to-do" = "todo"
    const words = norm(q).split(/\s+/).filter(Boolean);
    const hit = (text) => { const t = norm(text); return words.every((w) => t.includes(w)); };
    const added = userLinks.map(resolveLinkDisplay).filter(Boolean);
    const full = userLinks.length >= MAX_SHORTCUTS;
    const flat = [];   // every addable option shown, by index
    const row = (o, extra = "", sub = false) => {
      const i = flat.push(o) - 1;
      const isAdded = added.some((d) => sameUrl(d.url, o.url));
      return `<div class="ql-row${sub ? " ql-row--sub" : ""}">
          <span class="ql-icon">${resolveIcon(o, i)}</span>
          <span class="ql-text"><strong>${esc(sub ? o.name : o.label)}</strong><small>${esc(sub ? "Project page" : o.sub || "")}</small></span>
          ${extra}
          <button type="button" class="ql-add${isAdded ? " is-added" : ""}" data-i="${i}" ${isAdded || full ? "disabled" : ""}>${isAdded ? "✓ Added" : "+ Add"}</button>
        </div>`;
    };

    let html = "";
    if (addTab === "projects") {
      for (const p of all) {
        const nameHit = !words.length || hit(p.label);
        // "oleander todo" finds that project's To-do page.
        const pageHits = words.length ? p.pages.filter((pg) => hit(`${p.label} ${pg.name}`)) : [];
        if (!nameHit && !pageHits.length) continue;
        const open = openProjects.has(p.id) || (words.length && pageHits.length && !nameHit) || (words.length > 1 && pageHits.length);
        const toggle = `<button type="button" class="ql-pages" data-pid="${esc(p.id)}" aria-expanded="${!!open}">Pages <span aria-hidden="true">${open ? "▴" : "▾"}</span></button>`;
        html += row(p, toggle);
        if (open) html += (pageHits.length && !nameHit ? pageHits : (words.length > 1 && pageHits.length ? pageHits : p.pages)).map((pg) => row(pg, "", true)).join("");
      }
    } else {
      all.filter((o) => !words.length || hit(`${o.label} ${o.sub || ""}`)).forEach((o) => { html += row(o); });
    }
    box.innerHTML = html || `<p class="ql-empty">${q ? "Nothing matches that search." : addTab === "projects" ? "No active projects." : "No pages found."}</p>`;

    box.querySelectorAll(".ql-pages").forEach((btn) => btn.addEventListener("click", () => {
      const id = btn.dataset.pid;
      if (btn.getAttribute("aria-expanded") === "true") {
        openProjects.delete(id);
        if (!openProjects.has(id) && search.value) search.value = "";   // it was open because of the search
      } else openProjects.add(id);
      renderOptions(overlay);
    }));
    box.querySelectorAll(".ql-add:not([disabled])").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      await addShortcut(overlay, flat[Number(btn.dataset.i)]);
    }));
  }

  function renderCurrentShortcuts(overlay) {
    const listEl = overlay.querySelector("#currentShortcutsList");
    const countEl = overlay.querySelector("#qlCount");
    if (countEl) countEl.textContent = `${userLinks.length} of ${MAX_SHORTCUTS} used`;

    listEl.innerHTML = userLinks.length ? userLinks.map((link, index) => {
      const d = resolveLinkDisplay(link);
      if (!d) return "";
      return `<div class="ql-row">
          <span class="ql-icon">${resolveIcon(d, index)}</span>
          <span class="ql-text"><strong>${esc(d.label)}</strong><small>${esc(d.url || "")}</small></span>
          <span class="ql-acts">
            <button type="button" class="ql-btn" data-move="up" data-index="${index}" aria-label="Move ${esc(d.label)} left" ${index === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="ql-btn" data-move="down" data-index="${index}" aria-label="Move ${esc(d.label)} right" ${index === userLinks.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="ql-btn ql-btn--remove" data-remove="${link.id}" aria-label="Remove ${esc(d.label)}">×</button>
          </span>
        </div>`;
    }).join("") : '<p class="ql-empty">No quick links yet. Add some below.</p>';

    const addBtn = overlay.querySelector("#addShortcutBtn");
    if (addBtn) addBtn.disabled = userLinks.length >= MAX_SHORTCUTS;

    listEl.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", () => removeShortcut(overlay, btn.dataset.remove)));
    listEl.querySelectorAll("[data-move]").forEach((btn) => btn.addEventListener("click", () =>
      reorderShortcut(overlay, parseInt(btn.dataset.index, 10), btn.dataset.move)));
  }

  // Saves a built-in type (option.typeId) or any page / project / web address
  // (stored on the catalog's custom-link type with its own name + address).
  async function addShortcut(overlay, option) {
    const messageEl = overlay.querySelector("#shortcutMessage");
    if (userLinks.length >= MAX_SHORTCUTS) {
      DS.setFormMessage(messageEl, `You can have up to ${MAX_SHORTCUTS} quick links. Remove one first.`, "error");
      return false;
    }
    const customType = typeCatalog.find((t) => t.requires_custom_url);
    const payload = {
      user_id: DS.getUserId(currentProfile),
      sort_order: userLinks.length,
      shortcut_type: option.typeId || (customType && customType.id),
      custom_label: option.typeId ? null : option.label,
      custom_url: option.typeId ? null : option.url,
    };
    if (!payload.shortcut_type) { DS.setFormMessage(messageEl, "Custom links aren't set up (no custom type in quick_link_types).", "error"); return false; }

    const { error } = await DS.safeQuery("add shortcut", window.supabaseClient.from("user_quick_links").insert(payload));
    if (error) { DS.setFormMessage(messageEl, "Couldn't add that quick link.", "error"); return false; }
    DS.setFormMessage(messageEl, "", "");
    window.showToast?.(`${option.label} added.`);
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
    renderOptions(overlay);
    return true;
  }

  async function removeShortcut(overlay, linkId) {
    const { error } = await DS.safeQuery(
      "remove shortcut",
      window.supabaseClient.from("user_quick_links").delete().eq("id", linkId)
    );
    if (!error) window.showToast?.("Quick link removed."); // shared bottom-right popup (js/toast.js)
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
    renderOptions(overlay);
  }

  async function reorderShortcut(overlay, index, direction) {
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= userLinks.length) return;

    const a = userLinks[index];
    const b = userLinks[swapWith];

    await Promise.all([
      DS.safeQuery(
        "reorder shortcut",
        window.supabaseClient.from("user_quick_links").update({ sort_order: swapWith }).eq("id", a.id)
      ),
      DS.safeQuery(
        "reorder shortcut",
        window.supabaseClient.from("user_quick_links").update({ sort_order: index }).eq("id", b.id)
      ),
    ]);

    await loadUserLinks();
    renderCurrentShortcuts(overlay);
  }
})();