/* ===========================================================
   ARCHIVED PROJECTS ARE READ ONLY (2026-11-17)

   Coleby: "if a project is on archive then you can't edit anything, and
   just read it ... a popup that states that the project is on archive and
   the project manager will have to open it ... a banner that says ... you
   can't edit the project."

   Loaded on every project page before project-shell.js. The shell calls
   window.ProjectArchived.apply(project) once the project has loaded. For an
   archived project this:
     - shows a banner at the top of the page
     - stops edit buttons (Add / Edit / Delete / Upload / Save …), checkboxes
       and drag-and-drop before they do anything, and shows the popup
     - refuses any save to the database from this page (insert / update /
       upsert / delete, file uploads, write functions) and shows the popup,
       so nothing gets through even if a button isn't caught above
     - gives the project manager (or a Super Admin) a "Reopen project"
       button, which sets the status back to Active

   The database refuses the same writes too — see
   sql/supabase-project-archive-readonly.sql.

   Anything inside [data-archived-ok] is left alone (the offload banner and
   guide on the Overview use this, since saving to a hard drive is allowed).
=========================================================== */

(function () {
    "use strict";

    const MSG = "This project is archived and is read only. The project manager needs to reopen it before anything can be changed.";

    // Buttons whose label starts with one of these are edits.
    const EDIT_WORDS = /^(\+|(add|new|edit|delete|remove|upload|save|create|lock|import|invite|send|resend|mark|assign|move|rename|archive|award|log|submit|approve|reject|duplicate|replace|tag|update|change|sign|request|attach|refill|record|complete|fund|unfund|drop|split|camera|remind|reopen|start draw|take off|retry filing|contract is needed|not needed)\b)/i;
    // …except these, which never change project data.
    const NOT_EDITS = /^(sign out|log ?out|change password|update password|mark as read)\b/i;

    // Left alone: chrome, the offload flow, and this file's own UI.
    const SAFE_ZONES = ".sidebar, .header, header, [data-archived-ok], #povArchiveBanner, #povDriveOverlay, #povArchiveOverlay, .par-banner, #parOverlay";

    // Writes that never belong to the project's data.
    const PASS_TABLES = /(log|activity|audit|notification|_reads?$)/i;

    // Database functions that change data.
    const WRITE_RPCS = new Set([
        "lock_project_plan", "finalize_incident_report_approval", "delete_incident_report_with_cleanup",
        "next_bc_number", "next_vpo_numbering"
    ]);

    let project = null;
    let canReopen = false;
    let lastPopup = 0;

    /* ---------- popup + banner ---------- */

    function esc(s) {
        const d = document.createElement("div");
        d.textContent = s ?? "";
        return d.innerHTML;
    }

    function buildPopup() {
        if (document.getElementById("parOverlay")) return;
        const el = document.createElement("div");
        el.className = "popup-overlay hidden";
        el.id = "parOverlay";
        el.innerHTML = `
            <div class="popup par-popup" role="dialog" aria-modal="true" aria-labelledby="parTitle">
                <div class="par-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>
                </div>
                <h2 id="parTitle">This project is archived</h2>
                <p class="auth-inline-copy" id="parText"></p>
                <p class="auth-message" id="parMessage"></p>
                <div class="popup-buttons">
                    <button type="button" class="auth-button auth-button--secondary" id="parClose">OK</button>
                    <button type="button" class="auth-button" id="parReopen" hidden>Reopen project</button>
                </div>
            </div>`;
        document.body.appendChild(el);
        el.addEventListener("click", e => { if (e.target === el) closePopup(); });
        document.getElementById("parClose").addEventListener("click", closePopup);
        document.getElementById("parReopen").addEventListener("click", onReopenClick);
    }

    function openPopup(mode) {
        buildPopup();
        const reopening = mode === "reopen";
        document.getElementById("parTitle").textContent = reopening ? "Reopen this project?" : "This project is archived";
        document.getElementById("parText").textContent = reopening
            ? `${project.name || "This project"} will move back to Active, and everyone on it can make changes again.`
            : (canReopen
                ? "Archived projects are read only. You can view and download everything, but nothing can be changed. As the project manager, you can reopen it."
                : "Archived projects are read only. You can view and download everything, but nothing can be changed. The project manager will need to reopen it.");
        const msg = document.getElementById("parMessage");
        msg.textContent = ""; msg.className = "auth-message";
        const reopenBtn = document.getElementById("parReopen");
        reopenBtn.hidden = !canReopen;
        reopenBtn.disabled = false;
        reopenBtn.dataset.mode = reopening ? "confirm" : "ask";
        reopenBtn.textContent = reopening ? "Reopen project" : "Reopen project";
        document.getElementById("parClose").textContent = reopening ? "Cancel" : "OK";
        document.getElementById("parOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closePopup() {
        const el = document.getElementById("parOverlay");
        if (el) el.classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }

    // Several blocked things can fire at once (a click, then its save) — one popup.
    function blockedPopup() {
        const now = Date.now();
        if (now - lastPopup < 600) return;
        lastPopup = now;
        openPopup("blocked");
    }

    async function onReopenClick(e) {
        const btn = e.currentTarget;
        if (btn.dataset.mode !== "confirm") { openPopup("reopen"); return; }
        const msg = document.getElementById("parMessage");
        btn.disabled = true;
        msg.textContent = "Reopening…"; msg.className = "auth-message";
        const p = window.currentSupabaseProfile || {};
        const { error } = await origFrom("projects")
            .update({ status: "active", updated_by_id: p.id ?? null, updated_by_name: p.full_name ?? null })
            .eq("id", project.id);
        if (error) {
            console.error("Reopen failed:", error);
            msg.textContent = error.message || "Couldn't reopen the project. Please try again.";
            msg.className = "auth-message error";
            btn.disabled = false;
            return;
        }
        window.location.reload();
    }

    function showBanner() {
        const main = document.querySelector("main") || document.body;
        if (document.getElementById("parBanner")) return;
        const el = document.createElement("div");
        el.className = "par-banner";
        el.id = "parBanner";
        el.setAttribute("role", "status");
        el.innerHTML = `
            <div>
                <strong>This project is archived — it's read only</strong>
                <p>You can view and download everything, but nothing can be changed. ${canReopen ? "You're the project manager, so you can reopen it." : "Only the project manager can reopen it."}</p>
            </div>
            ${canReopen ? '<button type="button" class="auth-button" id="parBannerReopen">Reopen project</button>' : ""}`;
        main.prepend(el);
        const b = document.getElementById("parBannerReopen");
        if (b) b.addEventListener("click", () => openPopup("reopen"));
    }

    /* ---------- stop edits in the page ---------- */

    function labelOf(el) {
        return (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "")
            .replace(/\s+/g, " ").trim();
    }

    function isEditControl(target) {
        if (!target || !target.closest) return false;
        if (target.closest(SAFE_ZONES)) return false;
        if (!target.closest("main, .popup-overlay, .sheet, [role=dialog]")) return false;

        const box = target.closest("input[type=checkbox], input[type=radio], input[type=file]");
        if (box) return !box.closest("[class*=filter], [role=search], [class*=toolbar]");

        const btn = target.closest("button, [role=button], a.auth-button, label[for]");
        if (!btn) return false;
        if (btn.matches("label[for]")) {
            const input = document.getElementById(btn.getAttribute("for"));
            return !!(input && input.type === "file");
        }
        const label = labelOf(btn);
        return EDIT_WORDS.test(label) && !NOT_EDITS.test(label);
    }

    function guardEvent(e) {
        if (!isEditControl(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        blockedPopup();
    }

    function guardDrag(e) {
        if (!e.target.closest || e.target.closest(SAFE_ZONES)) return;
        if (!e.target.closest("main")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === "drop" || e.type === "dragstart") blockedPopup();
    }

    function guardPage() {
        document.addEventListener("click", guardEvent, true);
        document.addEventListener("dragstart", guardDrag, true);
        document.addEventListener("dragover", guardDrag, true);
        document.addEventListener("drop", guardDrag, true);
        // Inline-editable text (e.g. task names) stays put.
        new MutationObserver(() => {
            document.querySelectorAll("main [contenteditable=true]").forEach(n => n.setAttribute("contenteditable", "false"));
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["contenteditable"] });
        document.body.classList.add("project-archived");
    }

    /* ---------- stop saves to the database ---------- */

    let origFrom = null;

    function blockedResult() {
        blockedPopup();
        const res = { data: null, error: { message: MSG, code: "PROJECT_ARCHIVED" }, status: 403, count: null };
        // Chainable like a real query (.eq().select().single()…), resolves to the error.
        const chain = new Proxy(function () {}, {
            get(_t, key) {
                if (key === "then") return (ok, bad) => Promise.resolve(res).then(ok, bad);
                if (key === "catch") return () => Promise.resolve(res);
                if (key === "finally") return f => Promise.resolve(res).finally(f);
                return () => chain;
            },
            apply() { return chain; }
        });
        return chain;
    }

    function guardMethods(obj, names) {
        return new Proxy(obj, {
            get(t, key) {
                if (names.includes(key)) return () => blockedResult();
                const v = t[key];
                return typeof v === "function" ? v.bind(t) : v;
            }
        });
    }

    function guardClient(sb) {
        if (!sb || sb.__parGuarded) return;
        sb.__parGuarded = true;

        origFrom = sb.from.bind(sb);
        sb.from = function (table) {
            const q = origFrom(table);
            // The projects row has its own rules (offload fields, reopen) — the
            // database checks it, so let it through.
            if (table === "projects" || PASS_TABLES.test(table)) return q;
            return guardMethods(q, ["insert", "update", "upsert", "delete"]);
        };

        const origRpc = sb.rpc.bind(sb);
        sb.rpc = function (name, ...rest) {
            if (WRITE_RPCS.has(name)) return blockedResult();
            return origRpc(name, ...rest);
        };

        if (sb.storage && sb.storage.from) {
            const origBucket = sb.storage.from.bind(sb.storage);
            sb.storage.from = function (bucket) {
                return guardMethods(origBucket(bucket), ["upload", "update", "remove", "move", "copy", "uploadToSignedUrl"]);
            };
        }
    }

    /* ---------- entry ---------- */

    async function apply(p) {
        if (!p || (p.status || "") !== "archived") return;
        project = p;
        const sb = window.supabaseClient;
        // Guards go on right away (before the page's own script runs), the
        // banner once we know whether this person can reopen.
        guardClient(sb);
        guardPage();
        buildPopup();
        try {
            const { data } = await sb.rpc("project_can_reopen", { p_project_id: p.id });
            canReopen = data === true;
        } catch (_) { canReopen = false; }
        showBanner();
    }

    window.ProjectArchived = {
        apply,
        isReadOnly: () => !!project,
        popup: blockedPopup
    };
})();
