/* ==========================================================================
   siri-setup.js — "Add to Siri" pill + setup sheet
   --------------------------------------------------------------------------
   Drop <span data-siri-pill></span> anywhere and include this script after
   supabase-auth.js. Tapping the pill opens a sheet that:
     1. makes the employee a personal Siri code (only its hash is stored in
        siri_tokens; the function retires their old code on first use),
     2. on "Set up", copies the code and opens the shared iCloud shortcut,
        which asks them to paste it when they tap Add Shortcut.
   ========================================================================== */
(function () {
    // Paste the iCloud link from Shortcuts › Share › Copy iCloud Link here.
    const SIRI_SHORTCUT_URL = "https://www.icloud.com/shortcuts/6cee6b7e74e2427c8382956c2223bffb";

    const SPARKLE = `<svg class="siri-pill__icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c.4 3.9 2.1 6.6 5 8 .6.3 1.3.5 2 .7-3.9.9-6.3 3.3-7 7.3-.7-4-3.1-6.4-7-7.3 3.9-.9 6.3-3.3 7-8.7zM19 15c.2 1.6.9 2.6 2.5 3-1.6.4-2.3 1.4-2.5 3-.2-1.6-.9-2.6-2.5-3 1.6-.4 2.3-1.4 2.5-3z"/></svg>`;

    let code = null;          // plain code for this sheet session
    let preparing = null;     // in-flight promise

    function profile() {
        return window.currentSupabaseProfile ||
            (() => { try { return JSON.parse(localStorage.getItem("staffProfile")); } catch { return null; } })();
    }

    async function sha256(s) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    // Make + register a new code. Old codes keep working until this one is used.
    async function prepareCode() {
        const p = profile();
        if (!p?.id) throw new Error("Not signed in");
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const c = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
        const { error } = await window.supabaseClient.from("siri_tokens").insert({
            staff_user_id: p.id,
            staff_name: p.full_name || p.username || null,
            token_hash: await sha256(c),
        });
        if (error) throw error;
        return c;
    }

    function buildSheet() {
        const overlay = document.createElement("div");
        overlay.className = "popup-overlay hidden siri-setup-overlay";
        overlay.id = "siriSetupOverlay";
        overlay.innerHTML = `
            <div class="popup siri-setup">
                <div class="siri-setup__orb" aria-hidden="true"></div>
                <h3>Update the timeline with Siri</h3>
                <p class="siri-setup__lead">Say <strong>“Hey Siri, Update Timeline”</strong>, then the project and the change.</p>
                <ol class="siri-setup__steps">
                    <li>Tap <strong>Set up</strong> — your personal code is copied.</li>
                    <li>In Shortcuts, tap <strong>Add Shortcut</strong> and paste the code when asked.</li>
                </ol>
                <p class="siri-setup__examples">Try: “push framing back 5 days” · “mark drywall done” · “add inspection on November 20” · “undo”</p>
                <p class="siri-setup__status" id="siriSetupStatus"></p>
                <div class="popup-buttons">
                    <button type="button" class="auth-button auth-button--secondary siri-setup__cancel" id="siriSetupCancel">Cancel</button>
                    <button type="button" class="auth-button" id="siriSetupGo" disabled>Preparing…</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
        overlay.querySelector("#siriSetupCancel").addEventListener("click", close);
        overlay.querySelector("#siriSetupGo").addEventListener("click", go);
        return overlay;
    }

    function sheet() { return document.getElementById("siriSetupOverlay") || buildSheet(); }
    function close() { sheet().classList.add("hidden"); }
    function setStatus(t) { sheet().querySelector("#siriSetupStatus").textContent = t || ""; }

    function open() {
        const s = sheet();
        const btn = s.querySelector("#siriSetupGo");
        s.classList.remove("hidden");
        setStatus("");

        if (!SIRI_SHORTCUT_URL) {
            btn.disabled = true; btn.textContent = "Coming soon";
            setStatus("The Siri shortcut link hasn't been added yet.");
            return;
        }
        if (code) { btn.disabled = false; btn.textContent = "Set up"; return; }

        btn.disabled = true; btn.textContent = "Preparing…";
        preparing = preparing || prepareCode()
            .then((c) => { code = c; btn.disabled = false; btn.textContent = "Set up"; })
            .catch((e) => { console.error("[siri-setup]", e); btn.textContent = "Try again"; btn.disabled = false; setStatus("Couldn't create your code."); })
            .finally(() => { preparing = null; });
    }

    // Runs straight from the tap so iOS allows the clipboard write + opening Shortcuts.
    function go() {
        if (!code) { open(); return; }
        const fallback = () => setStatus(`Copy this code: ${code}`);
        try { navigator.clipboard.writeText(code).catch(fallback); } catch { fallback(); }
        if (window.showToast) window.showToast("Siri code copied — paste it in Shortcuts", "success");
        const w = window.open(SIRI_SHORTCUT_URL, "_blank");
        if (!w) window.location.href = SIRI_SHORTCUT_URL;
    }

    function mountPills() {
        document.querySelectorAll("[data-siri-pill]:not([data-siri-ready])").forEach((el) => {
            el.dataset.siriReady = "1";
            el.innerHTML = `<button type="button" class="siri-pill">${SPARKLE}<span>Add to Siri</span></button>`;
            el.querySelector("button").addEventListener("click", open);
        });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountPills);
    else mountPills();
})();
