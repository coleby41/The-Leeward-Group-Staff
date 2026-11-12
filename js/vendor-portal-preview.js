/* ===========================================================
   VENDOR PORTAL PREVIEW (pages/vendor-portal-preview.html, 2026-11-12)

   Staff with vendors.view_as_vendor pick a vendor and see the Vendor Portal
   exactly as that vendor's account holder does, inside this page.

   vendor-admin "view_as" makes a read-only Vendor Portal session (1 hour,
   never renews); the portal opens in the frame at …/invites.html#preview=<token>
   and shows a "Staff preview · View only" banner. vendor-api refuses every
   change on that session, and opening an invite there doesn't mark it viewed.
   The Vendor Portal's vercel.json allows only this staff site to frame it.
   ?company=<id> preselects a vendor (vendor page's "View as vendor" button).
=========================================================== */
(function () {
    "use strict";
    const PERMISSION = "vendors.view_as_vendor";
    const $ = id => document.getElementById(id);
    const client = () => window.supabaseClient;
    let current = null;   // { portal_url, token, company_name, as_name, expires_at }

    function esc(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }
    function message(text, type) {
        const el = $("vppMessage");
        el.textContent = text || "";
        el.className = `auth-message ${type || ""} ${text ? "" : "hidden"}`;
    }

    async function callAdmin(body) {
        try {
            const { data, error } = await client().functions.invoke("vendor-admin", { body });
            if (error) {
                let msg = error.message || "The vendor service didn't respond.";
                try { const p = error.context && typeof error.context.json === "function" ? await error.context.json() : null; if (p && p.error) msg = p.error; } catch (e) { /* keep */ }
                return { error: msg };
            }
            if (data && data.ok === false) return { error: data.error || "Something went wrong." };
            return { data };
        } catch (err) { return { error: err?.message || "The vendor service didn't respond." }; }
    }

    async function loadVendors() {
        // Vendors with an active Vendor Portal login.
        const { data, error } = await client().from("vendor_users")
            .select("company_id, Companies(id, Name, FriendlyName)")
            .eq("status", "active").not("company_id", "is", null);
        const sel = $("vppVendor");
        if (error) { sel.innerHTML = `<option value="">Couldn't load vendors</option>`; message(`Couldn't load vendors: ${error.message}`, "error"); return; }
        const byId = new Map();
        (data || []).forEach(r => {
            const c = Array.isArray(r.Companies) ? r.Companies[0] : r.Companies;
            if (c && !byId.has(c.id)) byId.set(c.id, c.FriendlyName || c.Name || `Vendor ${c.id}`);
        });
        const list = [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
        sel.innerHTML = list.length
            ? `<option value="">Choose a vendor…</option>` + list.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("")
            : `<option value="">No vendors have a portal login yet</option>`;
        sel.disabled = !list.length;
        $("vppGo").disabled = !list.length;
        const want = new URLSearchParams(location.search).get("company");
        if (want && byId.has(Number(want))) { sel.value = want; open(Number(want)); }
    }

    async function open(companyId) {
        if (!companyId) { message("Choose a vendor first.", "error"); return; }
        message("");
        $("vppGo").disabled = true;
        $("vppGo").textContent = "Opening…";
        const { data, error } = await callAdmin({ action: "view_as", company_id: companyId });
        $("vppGo").disabled = false;
        $("vppGo").textContent = "View as vendor";
        if (error) { message(error, "error"); return; }
        current = data;
        show();
        const url = new URL(location.href);
        url.searchParams.set("company", String(companyId));
        history.replaceState(null, "", url);
    }

    function show() {
        const wrap = $("vppFrameWrap");
        wrap.innerHTML = "";
        const frame = document.createElement("iframe");
        frame.className = "vpp-frame";
        frame.title = `Vendor Portal as ${current.company_name}`;
        frame.referrerPolicy = "no-referrer";
        frame.src = `${current.portal_url}/invites.html#preview=${encodeURIComponent(current.token)}`;
        wrap.appendChild(frame);
        const until = new Date(current.expires_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        $("vppAs").textContent = `Viewing as ${current.company_name}`;
        $("vppAsSub").textContent = `· signed in as ${current.as_name} (account holder) · view only · until ${until}`;
        $("vppBar").classList.remove("hidden");
    }

    function end() {
        current = null;
        $("vppBar").classList.add("hidden");
        $("vppFrameWrap").innerHTML = `<div class="vpp-empty"><p>Preview ended.</p><p class="card-subtitle">Pick a vendor above to open another preview.</p></div>`;
        const url = new URL(location.href);
        url.searchParams.delete("company");
        history.replaceState(null, "", url);
    }

    async function init() {
        try { await window.Permissions?.initPermissions(); } catch (e) { /* checked below */ }
        if (!window.Permissions || !window.Permissions.hasPermission(PERMISSION)) {
            $("vppForm").classList.add("hidden");
            $("vppFrameWrap").innerHTML = `<div class="vpp-empty"><p>You don't have access to Vendor Portal Preview.</p><p class="card-subtitle">Ask IT to turn on <strong>View Vendor Portal as a Vendor</strong> for your workgroup on the Workgroups page.</p></div>`;
            return;
        }
        $("vppForm").addEventListener("submit", e => { e.preventDefault(); open(Number($("vppVendor").value)); });
        // Reload = a fresh 1-hour session (the old one may have expired).
        $("vppReload").addEventListener("click", () => { if (current) open(Number($("vppVendor").value) || null); });
        $("vppEnd").addEventListener("click", end);
        loadVendors();
    }

    // Wait for supabase-auth.js to set up the client.
    (function wait(n) {
        if (window.supabaseClient) init();
        else if (n < 100) setTimeout(() => wait(n + 1), 100);
    })(0);
})();
