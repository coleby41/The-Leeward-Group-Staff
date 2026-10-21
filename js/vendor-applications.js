/* ===========================================================
   VENDOR APPLICATIONS (pages/vendors.html › More Actions)

   Companies that filled out the Vendor Portal's "New Vendor Portal Access
   Request" form (vendor_applications, status 'pending'). Approving runs the
   vendor-admin Edge Function, which creates the vendor (Companies) and its
   contact, turns on the applicant's portal login as the account holder,
   and emails them a sign-in link. Rejecting emails them (with the reason,
   if one is given).

   Needs vendors.approve_applications (sql/supabase-vendor-portal-setup.sql)
   — the menu item stays hidden without it, and the database refuses too.
   ?applications=1 (the link in the "New vendor application" notification)
   opens this popup straight away.
=========================================================== */
(function () {
    "use strict";

    const PERMISSION = "vendors.approve_applications";
    const $ = id => document.getElementById(id);

    let applications = [];
    let selectedId = null;
    let busy = false;
    let revealed = false;

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }
    const client = () => window.supabaseClient;
    const can = () => (window.Permissions ? window.Permissions.hasPermission(PERMISSION) : false);

    function shortDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    function maskTaxId(value) {
        const raw = String(value || "").replace(/[^0-9A-Za-z]/g, "");
        return raw ? `•••••${raw.slice(-4)}` : "—";
    }

    function setMessage(text, type) {
        const el = $("vendorAppMessage");
        el.textContent = text || "";
        el.className = `auth-message ${type || ""}`.trim();
    }

    async function callAdmin(body) {
        try {
            const { data, error } = await client().functions.invoke("vendor-admin", { body });
            if (error) {
                let message = error.message || "The vendor service didn't respond.";
                try {
                    const payload = error.context && typeof error.context.json === "function" ? await error.context.json() : null;
                    if (payload && payload.error) message = payload.error;
                } catch (e) { /* keep the generic message */ }
                return { error: message };
            }
            if (data && data.ok === false) return { error: data.error || "Something went wrong." };
            return { data };
        } catch (err) {
            return { error: err && err.message ? err.message : "The vendor service didn't respond." };
        }
    }

    /* ---------- load + render ---------- */

    async function load() {
        const { data, error } = await client()
            .from("vendor_applications")
            .select("*")
            .eq("status", "pending")
            .order("created_at", { ascending: true });
        if (error) {
            console.error("Couldn't load vendor applications:", error);
            applications = [];
            return false;
        }
        applications = data || [];
        return true;
    }

    function updateCount() {
        const count = $("vendorAppsCount");
        if (!count) return;
        count.textContent = String(applications.length);
        count.classList.toggle("hidden", applications.length === 0);
    }

    function render() {
        $("vendorAppsLoading").classList.add("hidden");
        $("vendorAppsEmpty").classList.toggle("hidden", applications.length > 0);
        $("vendorAppsTableWrap").classList.toggle("hidden", applications.length === 0);
        if (!applications.some(a => a.id === selectedId)) selectedId = applications[0]?.id || null;

        $("vendorAppsTableBody").innerHTML = applications.map(a => `
            <tr data-app="${esc(a.id)}" class="vendor-app-row ${a.id === selectedId ? "is-selected" : ""}" tabindex="0">
                <td><strong>${esc(a.legal_name)}</strong><span class="bid-cell-sub">${esc([a.city, a.state].filter(Boolean).join(", "))}</span></td>
                <td>${esc(a.contact_name)}<span class="bid-cell-sub">${esc(a.contact_email)}</span></td>
                <td>${a.w9_path ? `<span class="chip chip--success">On file</span>` : `<span class="chip chip--danger">Missing</span>`}</td>
                <td>${esc(shortDate(a.created_at))}</td>
            </tr>`).join("");

        renderDetail();
        updateCount();
    }

    function renderDetail() {
        const app = applications.find(a => a.id === selectedId);
        $("vendorAppDetail").classList.toggle("hidden", !app);
        if (!app) return;
        $("vendorAppDetailName").textContent = app.legal_name;
        const rows = [
            ["Friendly name", esc(app.friendly_name || "—")],
            ["Address", esc([app.street, [app.city, app.state].filter(Boolean).join(", "), app.zip].filter(Boolean).join(" ") || "—")],
            ["Contact", esc([app.contact_name, app.contact_title, app.contact_email, app.contact_phone].filter(Boolean).join(" · "))],
            ["SSN / FID", `${esc(revealed ? app.ssn_fid : maskTaxId(app.ssn_fid))} <button type="button" class="bid-link-btn" id="vendorAppRevealBtn">${revealed ? "Hide" : "Reveal"}</button>`],
            ["W-9", app.w9_path ? `<button type="button" class="bid-link-btn" id="vendorAppW9Btn">View W-9</button>` : "Missing"],
            ["COI expires", esc(app.coi_expires_on ? new Date(`${app.coi_expires_on}T00:00:00`).toLocaleDateString("en-US") : "Not given (COIs are collected per vendor later)")],
            ["Language", app.language === "es" ? "Spanish" : "English"],
            ["Applied", esc(new Date(app.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }))],
        ];
        $("vendorAppDetailList").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
        $("vendorAppRevealBtn").addEventListener("click", () => { revealed = !revealed; renderDetail(); });
        const w9Btn = $("vendorAppW9Btn");
        if (w9Btn) w9Btn.addEventListener("click", () => viewW9(app));
    }

    async function viewW9(app) {
        // In the portal's preview, never a new tab.
        window.FilePreview.open({
            name: `${app.legal_name || "Applicant"} - W-9.pdf`,
            kind: "pdf",
            getUrl: async () => {
                const { data, error } = await callAdmin({ action: "w9_url", application_id: app.id });
                if (error || !data?.url) throw new Error(error || "no link");
                return data.url;
            },
        });
    }

    /* ---------- open / close ---------- */

    async function open() {
        if (!can()) return;
        $("vendorAppsOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        $("vendorAppsLoading").classList.remove("hidden");
        $("vendorAppsEmpty").classList.add("hidden");
        $("vendorAppsTableWrap").classList.add("hidden");
        $("vendorAppDetail").classList.add("hidden");
        resetReview();
        const ok = await load();
        if (!ok) {
            $("vendorAppsLoading").textContent = "Couldn't load applications. Make sure sql/supabase-vendor-portal-setup.sql has been run, then try again.";
            return;
        }
        render();
    }

    function close() {
        if (busy) return;
        $("vendorAppsOverlay").classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    function resetReview() {
        revealed = false;
        $("vendorAppRejectBox").classList.add("hidden");
        $("vendorAppRejectReason").value = "";
        $("vendorAppRejectBtn").textContent = "Reject";
        $("vendorAppApproveBtn").classList.remove("hidden");
        setMessage("");
    }

    /* ---------- approve / reject ---------- */

    function setBusy(on) {
        busy = on;
        $("vendorAppApproveBtn").disabled = on;
        $("vendorAppRejectBtn").disabled = on;
    }

    async function approve() {
        const app = applications.find(a => a.id === selectedId);
        if (!app || busy) return;
        setBusy(true);
        setMessage("Approving…");
        const { data, error } = await callAdmin({ action: "approve", application_id: app.id });
        setBusy(false);
        if (error) { setMessage(`Couldn't approve: ${error}`, "error"); return; }
        window.showToast?.(data.emailed ? `${app.legal_name} approved — sign-in link sent` : `${app.legal_name} approved, but the email didn't send`);
        if (!data.emailed) console.warn("Approval email failed:", data.email_error);
        await afterReview();
        // New vendor: refresh the vendor list underneath.
        if (typeof window.initCompaniesPage === "function" && typeof loadCompanies === "function") {
            try { await loadAllContacts(); await loadCompanies(); } catch (e) { /* the list refreshes on reload */ }
        }
    }

    async function reject() {
        const app = applications.find(a => a.id === selectedId);
        if (!app || busy) return;
        const box = $("vendorAppRejectBox");
        if (box.classList.contains("hidden")) {
            // First click opens the reason box; the second click confirms.
            box.classList.remove("hidden");
            $("vendorAppRejectBtn").textContent = "Reject & Email Applicant";
            $("vendorAppApproveBtn").classList.add("hidden");
            $("vendorAppRejectReason").focus();
            return;
        }
        setBusy(true);
        setMessage("Rejecting…");
        const { data, error } = await callAdmin({ action: "reject", application_id: app.id, reason: $("vendorAppRejectReason").value.trim() });
        setBusy(false);
        if (error) { setMessage(`Couldn't reject: ${error}`, "error"); return; }
        window.showToast?.(data.emailed ? `${app.legal_name} rejected — applicant emailed` : `${app.legal_name} rejected, but the email didn't send`);
        await afterReview();
    }

    async function afterReview() {
        resetReview();
        await load();
        render();
    }

    /* ---------- wiring ---------- */

    async function start() {
        if (!window.supabaseClient) { setTimeout(start, 150); return; }
        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (e) { /* ignore */ }
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch (e) { /* hasPermission fails open */ }
        }
        const btn = $("vendorAppsBtn");
        if (!btn || !$("vendorAppsOverlay")) return;
        const allowed = can();
        btn.classList.toggle("hidden", !allowed);
        $("vendorAppsDivider")?.classList.toggle("hidden", !allowed);
        if (!allowed) return;

        btn.addEventListener("click", open);
        $("vendorAppsCloseBtn").addEventListener("click", close);
        $("vendorAppsOverlay").addEventListener("click", e => { if (e.target === $("vendorAppsOverlay")) close(); });
        document.addEventListener("keydown", e => {
            if (e.key === "Escape" && !$("vendorAppsOverlay").classList.contains("hidden")) close();
        });
        $("vendorAppsTableBody").addEventListener("click", e => {
            const row = e.target.closest("[data-app]");
            if (!row || busy) return;
            selectedId = row.dataset.app;
            resetReview();
            render();
        });
        $("vendorAppsTableBody").addEventListener("keydown", e => {
            if (e.key === "Enter") e.target.closest("[data-app]")?.click();
        });
        $("vendorAppApproveBtn").addEventListener("click", approve);
        $("vendorAppRejectBtn").addEventListener("click", reject);

        // Count on the menu item.
        if (await load()) updateCount();

        if (new URLSearchParams(window.location.search).get("applications") === "1") {
            history.replaceState(null, "", window.location.pathname);
            open();
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
