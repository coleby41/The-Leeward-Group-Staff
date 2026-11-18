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

  function resolveIcon(display, index) {
    if (display.iconClass && ICONS[display.iconClass]) return ICONS[display.iconClass];
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
      gridEl.innerHTML = `<p class="card-subtitle quick-links-empty">No shortcuts yet. Use "Edit shortcuts" to add up to ${MAX_SHORTCUTS}.</p>`;
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

  function openEditShortcutsModal() {
    const overlay = DS.buildPopup(
      "editShortcutsModal",
      `
      <h2>Edit shortcuts</h2>
      <p class="card-subtitle">Choose up to ${MAX_SHORTCUTS} shortcuts for your dashboard.</p>
      <div id="currentShortcutsList" class="equipment-list" style="margin:14px 0;"></div>

      <div class="auth-divider"></div>

      <form id="addShortcutForm" class="auth-form auth-form--compact">
        <h3>Add a shortcut</h3>
        <label class="auth-field">
          Type
          <select id="shortcutTypeSelect"></select>
        </label>
        <div id="customUrlFields" style="display:none;">
          <label class="auth-field">
            Label
            <input type="text" id="customLabelInput" maxlength="60" placeholder="e.g. Fleet Tracker" />
          </label>
          <label class="auth-field">
            URL
            <input type="url" id="customUrlInput" placeholder="https://" />
          </label>
        </div>
        <p id="shortcutMessage" class="auth-message"></p>
        <div class="popup-buttons">
          <button type="button" class="auth-button auth-button--secondary" id="closeEditShortcutsBtn">Done</button>
          <button type="submit" class="auth-button" id="addShortcutBtn">Add</button>
        </div>
      </form>
      `,
      { extraClass: "workbook-popup" }
    );

    populateTypeSelect(overlay);
    renderCurrentShortcuts(overlay);
    DS.openPopup(overlay);

    overlay.querySelector("#closeEditShortcutsBtn").addEventListener("click", () => DS.closePopup(overlay));

    overlay.querySelector("#shortcutTypeSelect").addEventListener("change", (e) => {
      const type = typeCatalog.find((t) => t.id === e.target.value);
      overlay.querySelector("#customUrlFields").style.display = type && type.requires_custom_url ? "block" : "none";
    });

    overlay.querySelector("#addShortcutForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleAddShortcut(overlay);
    });
  }

  function populateTypeSelect(overlay) {
    const select = overlay.querySelector("#shortcutTypeSelect");
    select.innerHTML = typeCatalog
      .map((t) => `<option value="${t.id}">${DS.escapeHtml(t.label)}</option>`)
      .join("");
  }

  function renderCurrentShortcuts(overlay) {
    const listEl = overlay.querySelector("#currentShortcutsList");
    const addBtn = overlay.querySelector("#addShortcutBtn");

    if (userLinks.length === 0) {
      listEl.innerHTML = `<p class="card-subtitle">No shortcuts saved yet.</p>`;
    } else {
      listEl.innerHTML = userLinks
        .map((link, index) => {
          const display = resolveLinkDisplay(link);
          if (!display) return "";
          return `
            <div class="equipment-item">
              <div>
                <h3>${DS.escapeHtml(display.label)}</h3>
                <p>${DS.escapeHtml(display.url || "")}</p>
              </div>
              <div style="display:flex; gap:6px;">
                <button type="button" class="workbook-btn workbook-btn--preview" data-move="up" data-index="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="workbook-btn workbook-btn--preview" data-move="down" data-index="${index}" ${index === userLinks.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" class="workbook-btn" style="background:var(--danger-soft); color:var(--danger);" data-remove="${link.id}">Remove</button>
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (addBtn) addBtn.disabled = userLinks.length >= MAX_SHORTCUTS;

    listEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeShortcut(overlay, btn.dataset.remove));
    });
    listEl.querySelectorAll("[data-move]").forEach((btn) => {
      btn.addEventListener("click", () =>
        reorderShortcut(overlay, parseInt(btn.dataset.index, 10), btn.dataset.move)
      );
    });
  }

  async function handleAddShortcut(overlay) {
    const messageEl = overlay.querySelector("#shortcutMessage");

    if (userLinks.length >= MAX_SHORTCUTS) {
      DS.setFormMessage(messageEl, `You can only have ${MAX_SHORTCUTS} shortcuts. Remove one first.`, "error");
      return;
    }

    const typeId = overlay.querySelector("#shortcutTypeSelect").value;
    const type = typeCatalog.find((t) => t.id === typeId);
    if (!type) return;

    const payload = {
      user_id: DS.getUserId(currentProfile),
      shortcut_type: typeId,
      sort_order: userLinks.length,
      custom_label: null,
      custom_url: null,
    };

    if (type.requires_custom_url) {
      const label = overlay.querySelector("#customLabelInput").value.trim();
      const url = overlay.querySelector("#customUrlInput").value.trim();
      if (!label || !url) {
        DS.setFormMessage(messageEl, "Label and URL are required for a custom shortcut.", "error");
        return;
      }
      payload.custom_label = label;
      payload.custom_url = url;
    }

    const { error } = await DS.safeQuery(
      "add shortcut",
      window.supabaseClient.from("user_quick_links").insert(payload)
    );

    if (error) {
      DS.setFormMessage(messageEl, "Couldn't add that shortcut.", "error");
      return;
    }

    DS.setFormMessage(messageEl, "", "");
    window.showToast?.("Shortcut added."); // shared bottom-right popup (js/toast.js)
    overlay.querySelector("#addShortcutForm").reset();
    overlay.querySelector("#customUrlFields").style.display = "none";
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
  }

  async function removeShortcut(overlay, linkId) {
    const { error } = await DS.safeQuery(
      "remove shortcut",
      window.supabaseClient.from("user_quick_links").delete().eq("id", linkId)
    );
    if (!error) window.showToast?.("Shortcut removed."); // shared bottom-right popup (js/toast.js)
    await loadUserLinks();
    renderCurrentShortcuts(overlay);
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