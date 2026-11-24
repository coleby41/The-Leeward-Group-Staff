/* ===========================================================
   PROJECT BID LEVELING (pages/project-bid-leveling.html)

   The portal version of the V2026 Bid Workbook. Guide for staff:
   pages/bid-leveling-help.html. SQL: sql/supabase-bid-leveling-setup.sql.

   - Buildings (bid_areas): each building type with how many buildings,
     building #s, units, GBSF and leasable SF, plus the site-wide sections
     (Site Work, Hardscape & Landscape, Amenities). Set up once in the
     "Set up buildings" popup; changing a building count never needs a
     re-bid because every price is per building.
   - One tab per building type / section, plus Summary.
   - Each line = area + cost code. Bids come from bid_invite_prices (vendors
     enter one price per building in the Vendor Portal, or staff add one with
     Review › Add bid). Budget, estimate and the negotiation reduction are on
     bid_lines.
   - Award stays per invite package: Review › Award sets the vendor's
     awarded_amount (their total after reductions) and hands off to the
     Bid Invites page's own award popup (COI template check + emails).

   View: vendors.send_bid_invites or projects.manage_bid_invites.
   Change anything: projects.manage_bid_invites. The database enforces it.
=========================================================== */
(function () {
    "use strict";

    const SEND = "vendors.send_bid_invites";
    const MANAGE = "projects.manage_bid_invites";
    const SECTIONS = [
        { kind: "site_work", name: "Site Work" },
        { kind: "hardscape", name: "Hardscape & Landscape" },
        { kind: "amenities", name: "Amenities" },
    ];
    const WAITING = ["sent", "viewed", "bidding"];
    const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

    const $ = id => document.getElementById(id);

    let project = null;
    let canManage = false;
    let codes = [];            // bid_cost_codes
    let codeMap = new Map();   // code -> row
    let areas = [];            // bid_areas (sorted)
    let lines = [];            // bid_lines
    let packages = [];         // bid_packages (not drafts)
    let invites = [];          // bid_invites for those packages
    let prices = [];           // bid_invite_prices for those invites
    let proposals = new Map(); // project_files id -> row
    let activeTab = null;      // area id or "summary"
    let filter = "all";        // "all" | "needs"
    let search = "";
    let reviewKey = null;      // "areaId|code"

    /* ---------- helpers ---------- */

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function client() { return window.supabaseClient; }

    function profile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch (e) { return null; }
    }

    function staffName() {
        const p = profile();
        return (p && (p.full_name || p.username)) || "Staff";
    }

    function can(key) { return window.Permissions ? window.Permissions.hasPermission(key) : true; }

    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
        else setMessage(text, type === "error" ? "error" : "success");
    }

    function setMessage(text, type) {
        const el = $("blPageMessage");
        el.textContent = text || "";
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = text ? "block" : "none";
    }

    function num(v) {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function money(v) {
        const n = num(v);
        if (n === null) return "—";
        return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function money2(v) {
        const n = num(v);
        if (n === null) return "—";
        return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function signed(v) {
        const n = num(v);
        if (n === null) return "—";
        if (Math.round(n) === 0) return "$0";
        return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
    }

    // "$1,234.50", "1234.5", "" -> number | null. Negative not allowed.
    function parseMoney(text) {
        const cleaned = String(text ?? "").replace(/[$,\s]/g, "");
        if (cleaned === "") return null;
        if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
        return Number(cleaned);
    }

    function parseCount(text) {
        const cleaned = String(text ?? "").replace(/[,\s]/g, "");
        if (cleaned === "") return 0;
        if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
        return Number(cleaned);
    }

    function fmtCount(v) {
        const n = num(v);
        return n === null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }

    function openOverlay(id) {
        $(id).classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeOverlay(id) {
        $(id).classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }

    function lineKey(areaId, code) { return `${areaId}|${code}`; }

    function areaLabel(a) { return a.name || "Untitled"; }

    function isSection(a) { return a.kind !== "building"; }

    function shownAreas() { return areas.filter(a => a.enabled !== false); }

    function codeLabel(code) {
        const c = codeMap.get(code);
        return c ? c.description : "";
    }

    function codeSort(a, b) {
        const ca = codeMap.get(a), cb = codeMap.get(b);
        const sa = ca ? ca.sort_order : 1e9, sb = cb ? cb.sort_order : 1e9;
        return sa - sb || String(a).localeCompare(String(b), "en", { numeric: true });
    }

    function divisionOf(code) {
        const c = codeMap.get(code);
        return c ? `${c.division_code} ${c.division_name}` : "Other";
    }

    /* ---------- data ---------- */

    async function load() {
        $("blLoading").style.display = "block";
        try {
            const [codeRes, areaRes, lineRes, pkgRes] = await Promise.all([
                client().from("bid_cost_codes").select("*").eq("active", true).order("sort_order"),
                client().from("bid_areas").select("*").eq("project_id", project.id).order("sort_order").order("created_at"),
                client().from("bid_lines").select("*").eq("project_id", project.id),
                client().from("bid_packages").select("id, name, status, cost_codes, area_ids, due_at, awarded_invite_id").eq("project_id", project.id).neq("status", "draft"),
            ]);
            for (const r of [codeRes, areaRes, lineRes, pkgRes]) if (r.error) throw r.error;
            codes = codeRes.data || [];
            codeMap = new Map(codes.map(c => [c.code, c]));
            areas = sortAreas(areaRes.data || []);
            lines = lineRes.data || [];
            packages = pkgRes.data || [];

            invites = []; prices = []; proposals = new Map();
            const pkgIds = packages.map(p => p.id);
            if (pkgIds.length) {
                const { data, error } = await client().from("bid_invites")
                    .select("id, package_id, company_id, company_name, contact_email, status, bid_amount, awarded_amount, bid_notes, bid_source, proposal_file_id")
                    .in("package_id", pkgIds);
                if (error) throw error;
                invites = data || [];
            }
            const invIds = invites.map(i => i.id);
            if (invIds.length) {
                const { data, error } = await client().from("bid_invite_prices").select("*").in("invite_id", invIds);
                if (error) throw error;
                prices = data || [];
                const fileIds = invites.map(i => i.proposal_file_id).filter(Boolean);
                if (fileIds.length) {
                    const { data: files } = await client().from("project_files").select("id, file_name, bucket, storage_path").in("id", fileIds);
                    (files || []).forEach(f => proposals.set(String(f.id), f));
                }
            }
        } catch (err) {
            $("blLoading").style.display = "none";
            const missing = /relation .* does not exist|bid_areas|bid_cost_codes/i.test(String(err && err.message));
            setMessage(missing
                ? "Bid Leveling isn't set up in the database yet. Run sql/supabase-bid-leveling-setup.sql in Supabase › SQL Editor."
                : `Couldn't load Bid Leveling: ${err && err.message ? err.message : err}`, "error");
            return;
        }
        $("blLoading").style.display = "none";
        if (!activeTab || (activeTab !== "summary" && !shownAreas().some(a => a.id === activeTab))) {
            activeTab = shownAreas()[0] ? shownAreas()[0].id : null;
        }
        render();
        if (reviewKey && !$("blReviewOverlay").classList.contains("hidden")) renderReview();
    }

    function sortAreas(rows) {
        const order = { building: 0, site_work: 1, hardscape: 2, amenities: 3 };
        return rows.slice().sort((a, b) => (order[a.kind] - order[b.kind]) || (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
    }

    /* ---------- model ---------- */

    const inviteById = () => new Map(invites.map(i => [i.id, i]));
    const packageById = () => new Map(packages.map(p => [p.id, p]));

    // Every line for an area: budget rows, priced codes, and codes an open
    // invite covers (so invited lines show before any price comes in).
    function areaLines(area) {
        const set = new Set();
        lines.filter(l => l.area_id === area.id).forEach(l => set.add(l.cost_code));
        prices.filter(p => p.area_id === area.id).forEach(p => set.add(p.cost_code));
        packages.forEach(pkg => {
            if (!Array.isArray(pkg.cost_codes) || !Array.isArray(pkg.area_ids) || !pkg.area_ids.includes(area.id)) return;
            pkg.cost_codes.forEach(c => set.add(c));
        });
        return Array.from(set).sort(codeSort).map(code => lineInfo(area, code));
    }

    function lineInfo(area, code) {
        const invs = inviteById();
        const pkgs = packageById();
        const row = lines.find(l => l.area_id === area.id && l.cost_code === code) || null;
        const bids = prices
            .filter(p => p.area_id === area.id && p.cost_code === code)
            .map(p => ({ price: p, invite: invs.get(p.invite_id) }))
            .filter(b => b.invite && b.invite.status !== "not_bidding")
            .map(b => ({ ...b, pkg: pkgs.get(b.invite.package_id) || null, amount: Number(b.price.amount) }))
            .sort((a, b) => a.amount - b.amount);
        const waiting = invites.filter(inv => {
            if (!WAITING.includes(inv.status)) return false;
            const pkg = pkgs.get(inv.package_id);
            return pkg && Array.isArray(pkg.cost_codes) && pkg.cost_codes.includes(code)
                && Array.isArray(pkg.area_ids) && pkg.area_ids.includes(area.id)
                && !bids.some(b => b.invite.id === inv.id);
        });
        const awarded = bids.find(b => b.invite.status === "awarded") || null;
        const best = bids[0] || null;
        const budget = row ? num(row.budget) : null;
        const reduction = row ? num(row.reduction) || 0 : 0;
        // Once awarded, the awarded vendor's price is the one that counts.
        const chosen = awarded || best;
        const target = chosen ? chosen.amount - reduction : null;
        return {
            area, code, row, bids, waiting, awarded, best, chosen, budget, reduction, target,
            estimate: row ? num(row.estimate) : null,
            diff: chosen && budget !== null ? chosen.amount - budget : null,
        };
    }

    function areaTotals(area) {
        const ls = areaLines(area);
        const t = { budget: 0, best: 0, target: 0, awarded: 0, lineCount: ls.length, hasBudget: false, hasBest: false };
        ls.forEach(l => {
            if (l.budget !== null) { t.budget += l.budget; t.hasBudget = true; }
            if (l.chosen) { t.best += l.chosen.amount; t.hasBest = true; }
            if (l.target !== null) t.target += l.target;
            if (l.awarded) t.awarded += 1;
        });
        return { lines: ls, ...t };
    }

    /* ---------- render ---------- */

    function render() {
        const hasAreas = areas.length > 0;
        $("blSetupEmpty").style.display = hasAreas ? "none" : "block";
        $("blBody").style.display = hasAreas ? "block" : "none";
        $("blAddLineBtn").classList.toggle("hidden", !canManage || activeTab === "summary" || !hasAreas);
        if (!hasAreas) return;
        renderTabs();
        if (activeTab === "summary") renderSummary();
        else renderArea(areas.find(a => a.id === activeTab));
    }

    function renderTabs() {
        const tabs = shownAreas().map(a => `<button type="button" role="tab" class="bl-tab ${activeTab === a.id ? "is-active" : ""}" aria-selected="${activeTab === a.id}" data-tab="${esc(a.id)}">${esc(areaLabel(a))}</button>`);
        tabs.push(`<button type="button" role="tab" class="bl-tab ${activeTab === "summary" ? "is-active" : ""}" aria-selected="${activeTab === "summary"}" data-tab="summary">Summary</button>`);
        $("blTabs").innerHTML = tabs.join("");
    }

    function buildingNumbers(a) {
        const parts = String(a.building_numbers || "").split(/\s*,\s*/).filter(Boolean);
        return parts.length ? ` (#${parts.join(", #")})` : "";
    }

    function areaFacts(a) {
        if (isSection(a)) return "Priced once for the whole site";
        const bits = [`${a.building_count} building${a.building_count === 1 ? "" : "s"}${buildingNumbers(a)}`];
        if (num(a.units)) bits.push(`${fmtCount(a.units)} units each`);
        if (num(a.gbsf)) bits.push(`${fmtCount(a.gbsf)} GBSF`);
        if (num(a.leasable_sf)) bits.push(`${fmtCount(a.leasable_sf)} leasable SF`);
        return bits.join(" · ");
    }

    function renderArea(area) {
        if (!area) return;
        const t = areaTotals(area);
        const perLabel = isSection(area) ? "" : " per building";
        $("blFacts").innerHTML = `${esc(areaFacts(area))}${canManage ? ` · <button type="button" class="bl-link-btn" data-act="setup">Edit buildings</button>` : ""}`;
        $("blFilters").style.display = "";
        const diff = t.hasBudget && t.hasBest ? t.best - t.budget : null;
        $("blStats").innerHTML = `
            <div class="bl-stat"><span>Budget${perLabel}</span><strong>${t.hasBudget ? esc(money(t.budget)) : "—"}</strong></div>
            <div class="bl-stat"><span>Best or awarded bids${perLabel}</span><strong>${t.hasBest ? esc(money(t.best)) : "—"}</strong></div>
            <div class="bl-stat"><span>Difference</span><strong class="${diff > 0 ? "bl-over" : ""}">${diff === null ? "—" : esc(diff > 0 ? `${money(diff)} over` : `${money(Math.abs(diff))} under`)}</strong></div>
            <div class="bl-stat"><span>Awarded</span><strong>${t.awarded} of ${t.lineCount}</strong></div>`;

        const q = search.trim().toLowerCase();
        const shown = t.lines.filter(l => {
            if (filter === "needs" && l.awarded) return false;
            if (!q) return true;
            const hay = [l.code, codeLabel(l.code), ...l.bids.map(b => b.invite.company_name)].join(" ").toLowerCase();
            return hay.includes(q);
        });

        if (!t.lines.length) {
            $("blTable").innerHTML = `<div class="bl-empty"><p>No lines on ${esc(areaLabel(area))} yet.</p><p>Lines show up here when you invite vendors to price this ${isSection(area) ? "section" : "building type"}${canManage ? ", or add one with <strong>+ Add line</strong> to set a budget first" : ""}.</p></div>`;
            return;
        }

        let html = `
            <div class="bl-row bl-row--head">
                <div>Item</div><div class="bl-num">Budget</div><div>Best bid</div><div class="bl-num">vs budget</div><div>Bids</div><div></div>
            </div>`;
        let lastDiv = null;
        shown.forEach(l => {
            const div = divisionOf(l.code);
            if (div !== lastDiv) { html += `<div class="bl-division">${esc(div)}</div>`; lastDiv = div; }
            const bidsText = `${l.bids.length} bid${l.bids.length === 1 ? "" : "s"}${l.waiting.length ? ` · ${l.waiting.length} waiting` : ""}`;
            const shownBid = l.chosen;
            const action = l.awarded
                ? `<span class="bl-awarded"><span class="bl-check" aria-hidden="true"></span>Awarded</span>`
                : `<button type="button" class="bl-review-btn" data-act="review" data-area="${esc(area.id)}" data-code="${esc(l.code)}">Review</button>`;
            html += `
                <div class="bl-row" data-act="review" data-area="${esc(area.id)}" data-code="${esc(l.code)}">
                    <div class="bl-item"><span class="bl-code">${esc(l.code)}</span><span class="bl-desc">${esc(codeLabel(l.code) || l.code)}</span></div>
                    <div class="bl-num bl-soft">${esc(money(l.budget))}</div>
                    <div class="bl-best">${shownBid ? `<strong>${esc(money(shownBid.amount))}</strong><span>${esc(shownBid.invite.company_name)}</span>` : `<span class="bl-soft">No bids yet</span>`}</div>
                    <div class="bl-num ${l.diff > 0 ? "bl-over" : "bl-soft"}">${esc(signed(l.diff))}</div>
                    <div class="bl-soft bl-small">${esc(bidsText)}</div>
                    <div class="bl-action">${action}</div>
                </div>`;
        });
        if (!shown.length) html += `<div class="bl-empty"><p>Nothing matches.</p></div>`;
        const mult = isSection(area) ? 1 : (area.building_count || 0);
        const totalDiff = t.hasBudget && t.hasBest ? t.best - t.budget : null;
        html += `
            <div class="bl-row bl-row--total">
                <div>Total${isSection(area) ? "" : " per building"}</div>
                <div class="bl-num">${t.hasBudget ? esc(money(t.budget)) : "—"}</div>
                <div>${t.hasBest ? esc(money(t.best)) : "—"}</div>
                <div class="bl-num ${totalDiff > 0 ? "bl-over" : ""}">${esc(signed(totalDiff))}</div>
                <div class="bl-total-mult">${isSection(area) ? "" : `× ${mult} building${mult === 1 ? "" : "s"} = ${esc(money(t.best * mult))}`}</div>
                <div></div>
            </div>`;
        $("blTable").innerHTML = html;
    }

    function summaryRows() {
        const byCode = new Map();
        shownAreas().forEach(a => {
            const mult = isSection(a) ? 1 : (a.building_count || 0);
            areaLines(a).forEach(l => {
                if (!byCode.has(l.code)) byCode.set(l.code, { code: l.code, perArea: new Map(), budget: 0, hasBudget: false, total: 0, hasTotal: false, vendors: new Set(), lines: 0, awarded: 0 });
                const r = byCode.get(l.code);
                r.lines += 1;
                if (l.target !== null) {
                    r.perArea.set(a.id, l.target * mult);
                    r.total += l.target * mult;
                    r.hasTotal = true;
                }
                if (l.budget !== null) { r.budget += l.budget * mult; r.hasBudget = true; }
                if (l.awarded) { r.awarded += 1; r.vendors.add(l.awarded.invite.company_name); }
            });
        });
        return Array.from(byCode.values()).sort((a, b) => codeSort(a.code, b.code));
    }

    function renderSummary() {
        const shown = shownAreas();
        $("blFacts").innerHTML = `Every cost code across all building types and site-wide sections. Building types are multiplied by their number of buildings.${canManage ? ` · <button type="button" class="bl-link-btn" data-act="setup">Edit buildings</button>` : ""}`;
        $("blFilters").style.display = "none";
        const rows = summaryRows();
        let budget = 0, total = 0, awardedAmt = 0, awardedCodes = 0, budgetPriced = 0;
        rows.forEach(r => {
            budget += r.budget; total += r.total;
            if (r.hasTotal) budgetPriced += r.budget;
            if (r.lines && r.awarded === r.lines) { awardedCodes += 1; awardedAmt += r.total; }
        });
        // Difference only counts lines that have a price, so unpriced lines
        // don't look like savings.
        const diff = total - budgetPriced;
        $("blStats").innerHTML = `
            <div class="bl-stat"><span>Project budget</span><strong>${esc(money(budget))}</strong></div>
            <div class="bl-stat"><span>Best or awarded total</span><strong>${esc(money(total))}</strong></div>
            <div class="bl-stat"><span>Difference on priced lines</span><strong class="${diff > 0 ? "bl-over" : ""}">${esc(diff > 0 ? `${money(diff)} over` : `${money(Math.abs(diff))} under`)}</strong></div>
            <div class="bl-stat"><span>Awarded</span><strong>${awardedCodes} of ${rows.length}</strong></div>`;
        if (!rows.length) {
            $("blTable").innerHTML = `<div class="bl-empty"><p>Nothing to sum up yet.</p></div>`;
            return;
        }
        const cols = `minmax(200px, 1.4fr) repeat(${shown.length}, minmax(110px, 1fr)) 120px 120px 110px`;
        let html = `<div class="bl-sum" style="--bl-sum-cols:${cols}">
            <div class="bl-sum-row bl-row--head"><div>Item</div>${shown.map(a => `<div class="bl-num">${esc(areaLabel(a))}${isSection(a) ? "" : `<span class="bl-sum-mult">× ${a.building_count}</span>`}</div>`).join("")}<div class="bl-num">Total</div><div class="bl-num">Budget</div><div class="bl-num">vs budget</div></div>`;
        rows.forEach(r => {
            const d = r.hasBudget && r.hasTotal ? r.total - r.budget : null;
            const vendor = r.vendors.size ? Array.from(r.vendors).join(", ") : "Not awarded";
            html += `<div class="bl-sum-row">
                <div class="bl-item"><span class="bl-code">${esc(r.code)}</span><span><span class="bl-desc">${esc(codeLabel(r.code) || r.code)}</span><span class="bl-sum-vendor ${r.vendors.size ? "" : "bl-soft"}">${esc(vendor)}</span></span></div>
                ${shown.map(a => `<div class="bl-num">${r.perArea.has(a.id) ? esc(money(r.perArea.get(a.id))) : `<span class="bl-soft">—</span>`}</div>`).join("")}
                <div class="bl-num">${r.hasTotal ? `<strong>${esc(money(r.total))}</strong>` : `<span class="bl-soft">No bids</span>`}</div>
                <div class="bl-num bl-soft">${r.hasBudget ? esc(money(r.budget)) : "—"}</div>
                <div class="bl-num ${d > 0 ? "bl-over" : "bl-soft"}">${esc(signed(d))}</div>
            </div>`;
        });
        const perAreaTotals = shown.map(a => rows.reduce((s, r) => s + (r.perArea.get(a.id) || 0), 0));
        html += `<div class="bl-sum-row bl-row--total"><div>Project total</div>${perAreaTotals.map(v => `<div class="bl-num">${esc(money(v))}</div>`).join("")}<div class="bl-num">${esc(money(total))}</div><div class="bl-num">${esc(money(budget))}</div><div class="bl-num ${diff > 0 ? "bl-over" : ""}">${esc(signed(diff))}</div></div></div>`;
        $("blTable").innerHTML = html;
    }

    /* ---------- set up buildings ---------- */

    let setupRows = [];   // [{ id?, name, building_count, building_numbers, units, gbsf, leasable_sf }]

    function openSetup() {
        if (!canManage) return;
        setupRows = areas.filter(a => a.kind === "building").map(a => ({
            id: a.id, name: a.name, building_count: String(a.building_count ?? 1), building_numbers: a.building_numbers || "",
            units: fmtCount(a.units), gbsf: fmtCount(a.gbsf), leasable_sf: fmtCount(a.leasable_sf),
        }));
        if (!setupRows.length) setupRows.push(blankBuilding());
        SECTIONS.forEach(s => {
            const row = areas.find(a => a.kind === s.kind);
            $(`blSection_${s.kind}`).checked = row ? row.enabled !== false : true;
        });
        $("blSetupMessage").textContent = "";
        $("blSetupSaveBtn").disabled = false;
        renderSetupRows();
        openOverlay("blSetupOverlay");
    }

    function blankBuilding() { return { name: "", building_count: "1", building_numbers: "", units: "", gbsf: "", leasable_sf: "" }; }

    function readSetupRows() {
        document.querySelectorAll("#blSetupRows [data-setup-row]").forEach(el => {
            const r = setupRows[Number(el.dataset.setupRow)];
            if (!r) return;
            el.querySelectorAll("[data-field]").forEach(input => { r[input.dataset.field] = input.value; });
        });
    }

    function renderSetupRows() {
        $("blSetupRows").innerHTML = setupRows.map((r, i) => `
            <div class="bl-setup-row" data-setup-row="${i}">
                <label class="bl-setup-field bl-setup-name"><span>Name</span><input type="text" data-field="name" maxlength="80" value="${esc(r.name)}" placeholder="e.g. 24 Unit 1BR &amp; 2BR"></label>
                <label class="bl-setup-field"><span>Buildings</span><input type="text" inputmode="numeric" data-field="building_count" value="${esc(r.building_count)}"></label>
                <label class="bl-setup-field"><span>Building #s</span><input type="text" data-field="building_numbers" maxlength="80" value="${esc(r.building_numbers)}" placeholder="3, 4, 5"></label>
                <label class="bl-setup-field"><span>Units / bldg</span><input type="text" inputmode="numeric" data-field="units" value="${esc(r.units)}"></label>
                <label class="bl-setup-field"><span>GBSF / bldg</span><input type="text" inputmode="decimal" data-field="gbsf" value="${esc(r.gbsf)}"></label>
                <label class="bl-setup-field"><span>Leasable SF</span><input type="text" inputmode="decimal" data-field="leasable_sf" value="${esc(r.leasable_sf)}"></label>
                <button type="button" class="bl-icon-btn" data-act="remove-building" data-index="${i}" aria-label="Remove ${esc(r.name || "this building type")}"><span class="bl-trash" aria-hidden="true"></span></button>
            </div>`).join("");
        renderSetupTotals();
    }

    function renderSetupTotals() {
        let b = 0, u = 0, g = 0, l = 0;
        setupRows.forEach(r => {
            const n = parseCount(r.building_count) || 0;
            b += n; u += n * (parseCount(r.units) || 0); g += n * (parseCount(r.gbsf) || 0); l += n * (parseCount(r.leasable_sf) || 0);
        });
        $("blSetupTotals").innerHTML = `<span>Total buildings <strong>${fmtCount(b)}</strong></span><span>Total units <strong>${fmtCount(u)}</strong></span><span>Total GBSF <strong>${fmtCount(g)}</strong></span><span>Total leasable SF <strong>${fmtCount(l)}</strong></span>`;
    }

    function hasActivity(areaId) {
        return prices.some(p => p.area_id === areaId) || lines.some(l => l.area_id === areaId);
    }

    async function saveSetup(event) {
        event.preventDefault();
        readSetupRows();
        const msg = $("blSetupMessage");
        const rows = setupRows.filter(r => r.id || r.name.trim() || r.building_numbers.trim());
        for (const r of rows) {
            if (!r.name.trim()) { msg.textContent = "Give every building type a name."; msg.className = "auth-message error"; return; }
            const n = parseCount(r.building_count);
            if (!Number.isInteger(n) || n < 0) { msg.textContent = `"${r.name}": Buildings has to be a whole number.`; msg.className = "auth-message error"; return; }
            for (const f of ["units", "gbsf", "leasable_sf"]) {
                if (Number.isNaN(parseCount(r[f]))) { msg.textContent = `"${r.name}": check the numbers (no letters).`; msg.className = "auth-message error"; return; }
            }
            if (!Number.isInteger(parseCount(r.units))) { msg.textContent = `"${r.name}": Units has to be a whole number.`; msg.className = "auth-message error"; return; }
        }
        const keptIds = new Set(rows.filter(r => r.id).map(r => r.id));
        const removed = areas.filter(a => a.kind === "building" && !keptIds.has(a.id));
        const removedWithData = removed.filter(a => hasActivity(a.id));
        if (removedWithData.length && !confirm(`${removedWithData.map(a => a.name).join(", ")} already ${removedWithData.length === 1 ? "has" : "have"} bids or budgets. Removing ${removedWithData.length === 1 ? "it" : "them"} deletes those too. Remove anyway?`)) return;

        $("blSetupSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        msg.className = "auth-message";
        try {
            for (const [i, r] of rows.entries()) {
                const patch = {
                    project_id: project.id, kind: "building", name: r.name.trim(),
                    building_count: parseCount(r.building_count), building_numbers: r.building_numbers.trim() || null,
                    units: parseCount(r.units), gbsf: parseCount(r.gbsf), leasable_sf: parseCount(r.leasable_sf),
                    enabled: true, sort_order: i,
                };
                const res = r.id
                    ? await client().from("bid_areas").update(patch).eq("id", r.id).select("id")
                    : await client().from("bid_areas").insert(patch).select("id");
                if (res.error) throw res.error;
                if (!res.data || !res.data.length) throw new Error("You don't have permission to change buildings.");
            }
            if (removed.length) {
                const { error } = await client().from("bid_areas").delete().in("id", removed.map(a => a.id));
                if (error) throw error;
            }
            for (const [i, s] of SECTIONS.entries()) {
                const on = $(`blSection_${s.kind}`).checked;
                const row = areas.find(a => a.kind === s.kind);
                if (row) {
                    if ((row.enabled !== false) !== on) {
                        const { error } = await client().from("bid_areas").update({ enabled: on }).eq("id", row.id);
                        if (error) throw error;
                    }
                } else if (on) {
                    const { error } = await client().from("bid_areas").insert({ project_id: project.id, kind: s.kind, name: s.name, building_count: 1, enabled: true, sort_order: 100 + i });
                    if (error) throw error;
                }
            }
        } catch (err) {
            msg.textContent = `Couldn't save: ${err && err.message ? err.message : err}`;
            msg.className = "auth-message error";
            $("blSetupSaveBtn").disabled = false;
            await load();
            return;
        }
        closeOverlay("blSetupOverlay");
        toast("Buildings saved");
        await load();
    }

    /* ---------- review a line ---------- */

    function openReview(areaId, code) {
        reviewKey = lineKey(areaId, code);
        renderReview();
        openOverlay("blReviewOverlay");
    }

    function currentReview() {
        if (!reviewKey) return null;
        const [areaId, code] = reviewKey.split("|");
        const area = areas.find(a => a.id === areaId);
        return area ? lineInfo(area, code) : null;
    }

    function renderReview() {
        const l = currentReview();
        if (!l) { closeOverlay("blReviewOverlay"); return; }
        const a = l.area;
        const mult = isSection(a) ? 1 : (a.building_count || 0);
        $("blReviewEyebrow").textContent = `${divisionOf(l.code)} · ${areaLabel(a)}`;
        $("blReviewTitle").textContent = `${l.code} · ${codeLabel(l.code) || l.code}`;
        $("blReviewFacts").textContent = isSection(a) ? "Priced once for the whole site" : `${mult} building${mult === 1 ? "" : "s"}${buildingNumbers(a)}`;

        const pkgAwarded = b => b.pkg && b.pkg.status === "awarded";
        const bidsHtml = l.bids.map((b, i) => {
            const file = b.invite.proposal_file_id ? proposals.get(String(b.invite.proposal_file_id)) : null;
            const diff = b.amount - l.bids[0].amount;
            const isAwarded = b.invite.status === "awarded";
            const status = isAwarded ? `<span class="bl-chip bl-chip--done">Awarded</span>`
                : pkgAwarded(b) ? `<span class="bl-chip">Package awarded to someone else</span>` : "";
            const canAward = canManage && !isAwarded && b.pkg && b.pkg.status === "open";
            return `
                <div class="bl-bid ${i === 0 ? "is-best" : ""}">
                    <div class="bl-bid-top">
                        <div class="bl-bid-name"><strong>${esc(b.invite.company_name)}</strong>
                            <span class="bl-soft bl-small">${esc(b.invite.bid_source === "portal" ? "Vendor portal" : "Added by staff")}${b.pkg ? ` · ${esc(b.pkg.name)}` : ""}</span></div>
                        <div class="bl-bid-amount"><strong>${esc(money(b.amount))}</strong><span class="bl-soft bl-small">${isSection(a) ? "" : "per building"}</span></div>
                    </div>
                    <div class="bl-bid-meta">
                        <span class="${i === 0 ? "bl-best-tag" : "bl-soft"}">${i === 0 ? (l.budget !== null ? `Lowest · ${signed(b.amount - l.budget)} vs budget` : "Lowest") : `+${money(diff)} vs lowest`}</span>
                        ${status}
                    </div>
                    ${b.invite.bid_notes ? `<p class="bl-bid-notes"><strong>Exclusions / notes:</strong> ${esc(b.invite.bid_notes)}</p>` : ""}
                    <div class="bl-bid-actions">
                        ${file ? `<button type="button" class="bl-link-btn" data-act="proposal" data-file="${esc(file.id)}">${esc(file.file_name)}</button>` : `<span class="bl-soft bl-small">No proposal file</span>`}
                        <span class="bl-bid-buttons">
                            ${canManage && b.pkg && b.pkg.status === "open" ? `<button type="button" class="bl-link-btn" data-act="edit-bid" data-invite="${esc(b.invite.id)}">Edit price</button>` : ""}
                            ${canAward ? `<button type="button" class="auth-button auth-button--sm" data-act="award" data-invite="${esc(b.invite.id)}">Award ${esc(b.invite.company_name)}</button>` : ""}
                        </span>
                    </div>
                </div>`;
        }).join("");
        const waitingHtml = l.waiting.length
            ? `<p class="bl-soft bl-small">Still waiting on: ${l.waiting.map(w => esc(w.company_name)).join(", ")}</p>` : "";
        $("blReviewBids").innerHTML = (bidsHtml || `<p class="bl-soft">No bids yet.</p>`) + waitingHtml;
        $("blReviewAddBidBtn").classList.toggle("hidden", !canManage);

        const row = l.row || {};
        $("blReviewBudget").value = row.budget != null ? money2(row.budget).replace(/\.00$/, "") : "";
        $("blReviewEstimate").value = row.estimate != null ? money2(row.estimate).replace(/\.00$/, "") : "";
        $("blReviewReduction").value = row.reduction != null ? money2(row.reduction).replace(/\.00$/, "") : "";
        $("blReviewNotes").value = row.notes || "";
        ["blReviewBudget", "blReviewEstimate", "blReviewReduction", "blReviewNotes"].forEach(id => { $(id).disabled = !canManage; });
        $("blReviewSaveBtn").classList.toggle("hidden", !canManage);
        $("blReviewMessage").textContent = "";
        renderReviewTarget();
    }

    function renderReviewTarget() {
        const l = currentReview();
        if (!l) return;
        const a = l.area;
        const chosen = l.awarded || l.best;
        const red = parseMoney($("blReviewReduction").value);
        const reduction = Number.isFinite(red) ? red || 0 : 0;
        if (!chosen) { $("blReviewTarget").innerHTML = `<span class="bl-soft">The target shows once a bid is in.</span>`; return; }
        const target = chosen.amount - reduction;
        const bits = [`<strong>${esc(money(target))}</strong>${isSection(a) ? "" : " per building"}`];
        if (!isSection(a) && num(a.units)) bits.push(`${esc(money(target / a.units))} / unit`);
        if (!isSection(a) && num(a.gbsf)) bits.push(`${esc(money2(target / a.gbsf))} / SF`);
        const mult = isSection(a) ? 1 : (a.building_count || 0);
        $("blReviewTarget").innerHTML = `Target bid (${esc(chosen.invite.company_name)}): ${bits.join(" · ")}${mult > 1 ? `<br><span class="bl-soft">× ${mult} buildings = ${esc(money(target * mult))}</span>` : ""}`;
    }

    async function saveLine(event) {
        event.preventDefault();
        const l = currentReview();
        if (!l || !canManage) return;
        const msg = $("blReviewMessage");
        const values = {};
        for (const [field, id] of [["budget", "blReviewBudget"], ["estimate", "blReviewEstimate"], ["reduction", "blReviewReduction"]]) {
            const v = parseMoney($(id).value);
            if (Number.isNaN(v)) { msg.textContent = "Amounts have to be numbers, like 312000 or $312,000."; msg.className = "auth-message error"; return; }
            values[field] = v;
        }
        values.notes = $("blReviewNotes").value.trim() || null;
        $("blReviewSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        msg.className = "auth-message";
        const patch = { ...values, updated_by_name: staffName() };
        const res = l.row
            ? await client().from("bid_lines").update(patch).eq("id", l.row.id).select("id")
            : await client().from("bid_lines").insert({ ...patch, project_id: project.id, area_id: l.area.id, cost_code: l.code }).select("id");
        $("blReviewSaveBtn").disabled = false;
        if (res.error || !res.data || !res.data.length) {
            msg.textContent = `Couldn't save: ${res.error ? res.error.message : "permission denied"}`;
            msg.className = "auth-message error";
            return;
        }
        msg.textContent = "Saved.";
        msg.className = "auth-message success";
        await load();
    }

    // Award stays per package. Work out the vendor's total after the
    // negotiation reductions, store it on the invite, then let the Bid
    // Invites page do the actual award (COI template check + emails).
    async function award(inviteId) {
        const inv = invites.find(i => i.id === inviteId);
        if (!inv || !canManage) return;
        const pkg = packages.find(p => p.id === inv.package_id);
        const mine = prices.filter(p => p.invite_id === inviteId);
        let total = 0, reductions = 0;
        mine.forEach(p => {
            const a = areas.find(x => x.id === p.area_id);
            if (!a) return;
            const mult = isSection(a) ? 1 : (a.building_count || 0);
            const row = lines.find(l => l.area_id === p.area_id && l.cost_code === p.cost_code);
            const red = row ? num(row.reduction) || 0 : 0;
            total += Number(p.amount) * mult;
            reductions += Math.min(red, Number(p.amount)) * mult;
        });
        const awardedAmount = Math.round((total - reductions) * 100) / 100;
        const covers = Array.from(new Set(mine.map(p => p.cost_code))).sort(codeSort).map(c => `${c} ${codeLabel(c)}`).join(", ");
        const ok = confirm(`Award ${pkg ? `"${pkg.name}"` : "this package"} to ${inv.company_name}?\n\nCovers: ${covers || "their whole bid"}\nTheir bid: ${money(total)}${reductions ? `\nAfter negotiation: ${money(awardedAmount)}` : ""}\n\nNext you'll confirm on the Bid Invites page (award email, COI request).`);
        if (!ok) return;
        const { data, error } = await client().from("bid_invites").update({ awarded_amount: reductions ? awardedAmount : null }).eq("id", inviteId).select("id");
        if (error || !data || !data.length) { toast(`Couldn't award: ${error ? error.message : "permission denied"}`, "error"); return; }
        window.location.href = `/pages/project-bid-invites.html?id=${encodeURIComponent(project.id)}&award=${encodeURIComponent(inviteId)}`;
    }

    function openProposal(fileId) {
        const file = proposals.get(String(fileId));
        if (!file || !window.FilePreview) return;
        window.FilePreview.open({
            name: file.file_name,
            getUrl: async () => {
                const { data, error } = await client().storage.from(file.bucket || "project-documents").createSignedUrl(file.storage_path, 600);
                if (error || !data?.signedUrl) throw error || new Error("no url");
                return data.signedUrl;
            },
        });
    }

    /* ---------- add / edit a bid by hand ---------- */

    let bidTarget = null;   // { areaId, code, inviteId? }

    function openAddBid(inviteId) {
        const l = currentReview();
        if (!l || !canManage) return;
        bidTarget = { areaId: l.area.id, code: l.code, inviteId: inviteId || null };
        const openPkgs = packages.filter(p => p.status === "open");
        // Packages covering this cost code first.
        openPkgs.sort((a, b) => Number((b.cost_codes || []).includes(l.code)) - Number((a.cost_codes || []).includes(l.code)));
        $("blBidTitle").textContent = inviteId ? "Edit price" : "Add bid";
        $("blBidSubtitle").textContent = `${l.code} · ${codeLabel(l.code)} · ${areaLabel(l.area)}`;
        $("blBidMessage").textContent = "";
        $("blBidSaveBtn").disabled = false;
        const existing = inviteId ? prices.find(p => p.invite_id === inviteId && p.area_id === l.area.id && p.cost_code === l.code) : null;
        $("blBidAmount").value = existing ? money2(existing.amount).replace(/\.00$/, "") : "";
        $("blBidAmountLabel").textContent = isSection(l.area) ? "Price" : "Price per building";

        if (inviteId) {
            const inv = invites.find(i => i.id === inviteId);
            $("blBidVendorRow").classList.add("hidden");
            $("blBidSubtitle").textContent += ` · ${inv ? inv.company_name : ""}`;
        } else {
            $("blBidVendorRow").classList.remove("hidden");
            if (!openPkgs.length) {
                $("blBidMessage").textContent = "There's no open invite package on this project. Send an invite first (+ Invite vendors), then add bids to it.";
                $("blBidMessage").className = "auth-message error";
                $("blBidSaveBtn").disabled = true;
            }
            $("blBidPackage").innerHTML = openPkgs.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${(p.cost_codes || []).includes(l.code) ? "" : " (doesn't list this cost code)"}</option>`).join("");
            fillBidVendors();
        }
        openOverlay("blBidOverlay");
    }

    let allVendors = null;   // [{ id, Name, email }] approved or not, for vendors that weren't invited
    async function loadVendors() {
        if (allVendors) return allVendors;
        const [{ data: cos }, { data: contacts }] = await Promise.all([
            client().from("Companies").select("id, Name").order("Name"),
            client().from("Contacts").select("company_id, Email, Name").not("Email", "is", null),
        ]);
        const emailBy = new Map();
        (contacts || []).forEach(c => { if (c.Email && !emailBy.has(c.company_id)) emailBy.set(c.company_id, { email: c.Email, name: c.Name }); });
        allVendors = (cos || []).map(c => ({ id: c.id, Name: c.Name, contact: emailBy.get(c.id) || null }));
        return allVendors;
    }

    async function fillBidVendors() {
        const pkgId = $("blBidPackage").value;
        const inPkg = invites.filter(i => i.package_id === pkgId && i.status !== "awarded");
        const vendorsList = await loadVendors();
        const invited = new Set(inPkg.map(i => String(i.company_id)));
        const opts = inPkg.map(i => `<option value="inv:${esc(i.id)}">${esc(i.company_name)} (invited)</option>`);
        vendorsList.filter(v => !invited.has(String(v.id))).forEach(v => opts.push(`<option value="co:${esc(v.id)}">${esc(v.Name)}</option>`));
        $("blBidVendor").innerHTML = `<option value="">Choose a vendor…</option>${opts.join("")}`;
    }

    async function saveBid(event) {
        event.preventDefault();
        if (!bidTarget) return;
        const msg = $("blBidMessage");
        const amount = parseMoney($("blBidAmount").value);
        if (amount === null || Number.isNaN(amount)) { msg.textContent = "Enter the price, like 298400 or $298,400."; msg.className = "auth-message error"; return; }
        $("blBidSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        msg.className = "auth-message";
        try {
            let inviteId = bidTarget.inviteId;
            if (!inviteId) {
                const pick = $("blBidVendor").value;
                const pkgId = $("blBidPackage").value;
                if (!pick || !pkgId) throw new Error("Choose the invite package and the vendor.");
                if (pick.startsWith("inv:")) inviteId = pick.slice(4);
                else {
                    // A vendor who wasn't invited: add them to the package as a
                    // bid that came in by email (no invite email is sent).
                    const co = (allVendors || []).find(v => String(v.id) === pick.slice(3));
                    if (!co) throw new Error("Vendor not found.");
                    if (!co.contact) throw new Error(`${co.Name} has no contact with an email. Add one on their vendor page first.`);
                    const { data, error } = await client().from("bid_invites").insert({
                        package_id: pkgId, company_id: co.id, company_name: co.Name,
                        contact_name: co.contact.name || null, contact_email: co.contact.email,
                        status: "bid_received", bid_source: "staff", bid_received_on: new Date().toISOString().slice(0, 10),
                        logged_by_name: staffName(), logged_at: new Date().toISOString(),
                    }).select("id").single();
                    if (error) throw error;
                    inviteId = data.id;
                }
            }
            const { error } = await client().from("bid_invite_prices").upsert(
                { invite_id: inviteId, area_id: bidTarget.areaId, cost_code: bidTarget.code, amount },
                { onConflict: "invite_id,area_id,cost_code" }
            );
            if (error) throw error;
            const inv = invites.find(i => i.id === inviteId);
            if (inv && WAITING.concat(["not_bidding"]).includes(inv.status)) {
                await client().from("bid_invites").update({
                    status: "bid_received", bid_source: inv.bid_source || "staff", decline_reason: null, decline_note: null,
                    bid_received_on: new Date().toISOString().slice(0, 10), logged_by_name: staffName(), logged_at: new Date().toISOString(),
                }).eq("id", inviteId);
            }
        } catch (err) {
            msg.textContent = `Couldn't save: ${err && err.message ? err.message : err}`;
            msg.className = "auth-message error";
            $("blBidSaveBtn").disabled = false;
            return;
        }
        closeOverlay("blBidOverlay");
        toast("Bid saved");
        bidTarget = null;
        await load();
    }

    /* ---------- add a line (budget before bids) ---------- */

    function openAddLine() {
        const area = areas.find(a => a.id === activeTab);
        if (!area || !canManage) return;
        $("blLineSubtitle").textContent = areaLabel(area);
        const used = new Set(areaLines(area).map(l => l.code));
        let lastDiv = null;
        const opts = [];
        codes.forEach(c => {
            if (used.has(c.code)) return;
            const div = `${c.division_code} ${c.division_name}`;
            if (div !== lastDiv) { if (lastDiv !== null) opts.push("</optgroup>"); opts.push(`<optgroup label="${esc(div)}">`); lastDiv = div; }
            opts.push(`<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.description)}</option>`);
        });
        if (lastDiv !== null) opts.push("</optgroup>");
        $("blLineCode").innerHTML = `<option value="">Choose a cost code…</option>${opts.join("")}<option value="__new">+ New cost code…</option>`;
        $("blLineNewFields").classList.add("hidden");
        $("blLineNewCode").value = "";
        $("blLineNewDesc").value = "";
        $("blLineBudget").value = "";
        $("blLineBudgetLabel").textContent = isSection(area) ? "Budget" : "Budget per building";
        $("blLineMessage").textContent = "";
        $("blLineSaveBtn").disabled = false;
        openOverlay("blLineOverlay");
    }

    async function saveLineNew(event) {
        event.preventDefault();
        const area = areas.find(a => a.id === activeTab);
        if (!area) return;
        const msg = $("blLineMessage");
        let code = $("blLineCode").value;
        const budget = parseMoney($("blLineBudget").value);
        if (Number.isNaN(budget)) { msg.textContent = "The budget has to be a number."; msg.className = "auth-message error"; return; }
        $("blLineSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        msg.className = "auth-message";
        try {
            if (code === "__new") {
                code = $("blLineNewCode").value.trim();
                const desc = $("blLineNewDesc").value.trim();
                if (!/^\d{3,6}$/.test(code)) throw new Error("A cost code is 3–6 digits, like 13001.");
                if (!desc) throw new Error("Describe the new cost code.");
                if (codeMap.has(code)) throw new Error(`${code} already exists (${codeLabel(code)}).`);
                const divCode = code.slice(0, -3).padStart(2, "0");
                const sibling = codes.find(c => c.division_code === divCode);
                const { error } = await client().from("bid_cost_codes").insert({
                    code, description: desc, division_code: divCode, division_name: sibling ? sibling.division_name : `Division ${divCode}`,
                    sort_order: (codes.reduce((m, c) => Math.max(m, c.sort_order), 0) || 0) + 10,
                });
                if (error) throw error;
            }
            if (!code) throw new Error("Choose a cost code.");
            const { error } = await client().from("bid_lines").insert({ project_id: project.id, area_id: area.id, cost_code: code, budget, updated_by_name: staffName() });
            if (error) throw error;
        } catch (err) {
            msg.textContent = `Couldn't add: ${err && err.message ? err.message : err}`;
            msg.className = "auth-message error";
            $("blLineSaveBtn").disabled = false;
            return;
        }
        closeOverlay("blLineOverlay");
        toast("Line added");
        await load();
    }

    /* ---------- Excel export (workbook layout) ---------- */

    let xlsxPromise = null;
    function loadXlsx() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (!xlsxPromise) {
            xlsxPromise = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = XLSX_URL;
                s.onload = () => resolve(window.XLSX);
                s.onerror = () => { xlsxPromise = null; reject(new Error("Couldn't load the Excel library. Check your connection.")); };
                document.head.appendChild(s);
            });
        }
        return xlsxPromise;
    }

    async function exportExcel() {
        let XLSX;
        try { XLSX = await loadXlsx(); } catch (err) { toast(err.message, "error"); return; }
        const wb = XLSX.utils.book_new();
        const safe = s => String(s || "Sheet").replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
        const used = new Set();
        const uniqueName = s => { let n = safe(s), i = 2; while (used.has(n)) n = safe(`${s} ${i++}`); used.add(n); return n; };

        shownAreas().forEach(a => {
            const ls = areaLines(a);
            const head = [
                [project.name || ""],
                [`${areaLabel(a)} · Bids/Budget`],
                [areaFacts(a)],
                [],
                ["Code", "Description", "Budget", "Bid #1", "Vendor #1", "Bid #2", "Vendor #2", "Bid #3", "Vendor #3", "More bids", "Estimate", "Lowest", "Variance $", "Variance %", "Reduction", "Target bid", "$ / Unit", "$ / GBSF", "Awarded vendor", "Comments"],
            ];
            const rows = ls.map(l => {
                const b = l.bids;
                return [
                    l.code, codeLabel(l.code), l.budget,
                    b[0] ? b[0].amount : null, b[0] ? b[0].invite.company_name : "",
                    b[1] ? b[1].amount : null, b[1] ? b[1].invite.company_name : "",
                    b[2] ? b[2].amount : null, b[2] ? b[2].invite.company_name : "",
                    b.length > 3 ? b.slice(3).map(x => `${x.invite.company_name} ${money(x.amount)}`).join("; ") : "",
                    l.estimate, l.best ? l.best.amount : null, l.best && l.budget !== null ? l.best.amount - l.budget : null, l.best && l.budget ? (l.best.amount - l.budget) / l.budget : null,
                    l.reduction || null, l.target,
                    l.target !== null && !isSection(a) && num(a.units) ? Math.round(l.target / a.units) : null,
                    l.target !== null && !isSection(a) && num(a.gbsf) ? Math.round(l.target / a.gbsf * 100) / 100 : null,
                    l.awarded ? l.awarded.invite.company_name : "", l.row && l.row.notes ? l.row.notes : "",
                ];
            });
            const t = areaTotals(a);
            const mult = isSection(a) ? 1 : (a.building_count || 0);
            rows.push([]);
            rows.push(["", isSection(a) ? "Total" : "Total per building", t.budget, null, "", null, "", null, "", "", null, t.best, t.hasBudget && t.hasBest ? t.best - t.budget : null, null, null, t.target]);
            if (!isSection(a)) rows.push(["", `× ${mult} buildings`, t.budget * mult, null, "", null, "", null, "", "", null, t.best * mult, null, null, null, t.target * mult]);
            const ws = XLSX.utils.aoa_to_sheet(head.concat(rows));
            ws["!cols"] = [8, 30, 12, 12, 18, 12, 18, 12, 18, 24, 12, 12, 12, 10, 12, 12, 10, 10, 20, 30].map(w => ({ wch: w }));
            XLSX.utils.book_append_sheet(wb, ws, uniqueName(areaLabel(a)));
        });

        const shown = shownAreas();
        const sum = [
            [project.name || ""],
            ["Bid Summary by Cost Code"],
            [],
            ["Code", "Description", "Awarded vendor", ...shown.map(a => isSection(a) ? areaLabel(a) : `${areaLabel(a)} (× ${a.building_count})`), "Total", "Budget", "Variance"],
        ];
        summaryRows().forEach(r => sum.push([
            r.code, codeLabel(r.code), Array.from(r.vendors).join(", "),
            ...shown.map(a => r.perArea.has(a.id) ? r.perArea.get(a.id) : null),
            r.hasTotal ? r.total : null, r.hasBudget ? r.budget : null, r.hasBudget && r.hasTotal ? r.total - r.budget : null,
        ]));
        const wsSum = XLSX.utils.aoa_to_sheet(sum);
        wsSum["!cols"] = [8, 30, 22, ...shown.map(() => 16), 14, 14, 14].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, wsSum, uniqueName("Bid Summary"));

        const fname = `${String(project.name || "Project").replace(/[\\/:*?"<>|]+/g, "-")} - Bid Leveling - ${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, fname);
    }

    /* ---------- wiring ---------- */

    function onClick(event) {
        const el = event.target.closest("[data-act], [data-tab]");
        if (!el) return;
        if (el.dataset.tab) {
            activeTab = el.dataset.tab;
            render();
            return;
        }
        const act = el.dataset.act;
        if (act === "review") openReview(el.dataset.area, el.dataset.code);
        else if (act === "setup") openSetup();
        else if (act === "proposal") openProposal(el.dataset.file);
        else if (act === "award") award(el.dataset.invite);
        else if (act === "edit-bid") openAddBid(el.dataset.invite);
        else if (act === "remove-building") {
            readSetupRows();
            setupRows.splice(Number(el.dataset.index), 1);
            if (!setupRows.length) setupRows.push(blankBuilding());
            renderSetupRows();
        }
    }

    function wire() {
        document.addEventListener("click", event => {
            if (event.target.closest("#blTabs, #blTable, #blFacts, #blSetupEmpty, #blReviewOverlay, #blSetupRows")) onClick(event);
        });
        $("blSetupForm").addEventListener("submit", saveSetup);
        $("blSetupCancelBtn").addEventListener("click", () => closeOverlay("blSetupOverlay"));
        $("blSetupCloseBtn").addEventListener("click", () => closeOverlay("blSetupOverlay"));
        $("blSetupAddBtn").addEventListener("click", () => { readSetupRows(); setupRows.push(blankBuilding()); renderSetupRows(); });
        $("blSetupRows").addEventListener("input", () => { readSetupRows(); renderSetupTotals(); });

        $("blReviewForm").addEventListener("submit", saveLine);
        $("blReviewCloseBtn").addEventListener("click", () => { closeOverlay("blReviewOverlay"); reviewKey = null; });
        $("blReviewReduction").addEventListener("input", renderReviewTarget);
        $("blReviewAddBidBtn").addEventListener("click", () => openAddBid(null));

        $("blBidForm").addEventListener("submit", saveBid);
        $("blBidCancelBtn").addEventListener("click", () => closeOverlay("blBidOverlay"));
        $("blBidPackage").addEventListener("change", fillBidVendors);

        $("blAddLineBtn").addEventListener("click", openAddLine);
        $("blLineForm").addEventListener("submit", saveLineNew);
        $("blLineCancelBtn").addEventListener("click", () => closeOverlay("blLineOverlay"));
        $("blLineCode").addEventListener("change", () => $("blLineNewFields").classList.toggle("hidden", $("blLineCode").value !== "__new"));

        $("blExportBtn").addEventListener("click", exportExcel);
        $("blSearch").addEventListener("input", e => { search = e.target.value; render(); });
        document.querySelectorAll("[data-filter]").forEach(btn => btn.addEventListener("click", () => {
            filter = btn.dataset.filter;
            document.querySelectorAll("[data-filter]").forEach(b => {
                b.classList.toggle("is-active", b === btn);
                b.setAttribute("aria-checked", String(b === btn));
            });
            render();
        }));
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            ["blBidOverlay", "blLineOverlay", "blSetupOverlay", "blReviewOverlay"].some(id => {
                if ($(id).classList.contains("hidden")) return false;
                closeOverlay(id);
                if (id === "blReviewOverlay") reviewKey = null;
                return true;
            });
        });
    }

    window.addEventListener("project-shell:ready", async (e) => {
        const detail = e.detail || {};
        if (!detail.project) {
            $("blLoading").style.display = "none";
            setMessage("Couldn't load this project.", "error");
            return;
        }
        project = detail.project;
        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (err) { /* ignore */ }
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch (err) { /* fails open */ }
        }
        canManage = can(MANAGE);
        if (!canManage && !can(SEND)) {
            $("blLoading").style.display = "none";
            $("blNoAccess").style.display = "block";
            return;
        }
        $("blKicker").textContent = `${project.name || "Project"} · Bids`;
        $("blHelpBtn").href = `/pages/bid-leveling-help.html?id=${encodeURIComponent(project.id)}`;
        // The popups' "?" links go to their section of the guide.
        document.querySelectorAll(".bl-help-round").forEach(a => {
            const hash = (a.getAttribute("href") || "").split("#")[1];
            a.href = `/pages/bid-leveling-help.html?id=${encodeURIComponent(project.id)}${hash ? `#${hash}` : ""}`;
        });
        const inviteBtn = $("blInviteBtn");
        if (can(SEND)) {
            inviteBtn.href = `/pages/vendors.html?invite=1&project=${encodeURIComponent(project.id)}`;
            inviteBtn.classList.remove("hidden");
        }
        load();
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
