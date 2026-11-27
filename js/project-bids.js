/* ===========================================================
   PROJECT BIDS (pages/project-bids.html) — Bids v2, 2026-11-26

   One tab for all bidding on a project. Replaces Bid Invites and Bid
   Leveling (those pages now redirect here). Guide: pages/bids-help.html.

     List      every bid package (trade) on the project: due, bids in, best
               total, budget, status. Buildings line + Set up buildings.
               COI template + Vendor Paperwork cards (from Bid Invites).
     New       + New bid package: 2 steps, What (name, cost codes,
               buildings, due date; extras under More options) and Who
               (approved vendors, pre-picked from who priced these cost
               codes before). Save draft or Send.
     Package   vendors side by side per building type + cost code, budget
               next to them (click to edit). Lowest price is picked as the
               winner of each line; change any winner to split the package.
               Award picks -> one confirm -> bid-invites "award_split".
               Old packages without cost codes: one total per vendor,
               awarded with the original "award" action.
     Sheet     Invite Sheet (?sheet=1): every cost code with the vendors tagged
               for it; check who to invite and Send (one package per code).
               Codes a job doesn't need can be hidden for that project.
     Export    Export for QuickBooks (Desktop): IIF (vendors + the job) and
               Excel (budgets, awarded contract amounts) until the
               QuickBooks Web Connector bridge exists.

   SQL: supabase-vendor-portal-setup.sql, supabase-bid-leveling-setup.sql,
        supabase-bids-v2-setup.sql.
   Access: see with vendors.send_bid_invites or projects.manage_bid_invites;
   send with vendors.send_bid_invites; change / award with
   projects.manage_bid_invites. The database enforces the same.
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
    const HAS_BID = ["bid_received", "awarded", "not_selected"];
    const CONTACT_STORAGE_KEY = "bidInviteContact"; // shared with the Vendors page wizard
    const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    const STATUS = {
        pending: "Not sent", failed: "Email failed", sent: "Sent", viewed: "Opened", bidding: "Bidding",
        not_bidding: "Not bidding", bid_received: "Bid in", awarded: "Awarded", not_selected: "Not selected",
    };

    const $ = id => document.getElementById(id);

    let project = null;
    let canManage = false;
    let canSend = false;
    let codes = [], codeMap = new Map();
    let areas = [], lines = [], packages = [], invites = [], prices = [];
    let files = new Map();           // project_files id -> row (proposals)
    let pkgFiles = new Map();        // package id -> [project_files]
    let openPkgId = null;            // package view
    let picks = new Map();           // "areaId|code" -> invite id (package view, unsaved)
    let coiTemplate = null;
    let hiddenCodes = new Set();     // cost codes hidden on this project (Invite Sheet)
    let sheetReady = true;           // false until sql/supabase-bid-invite-sheet-setup.sql is run
    let paperwork = null;
    const busy = new Set();

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
    function staffName() { const p = profile(); return (p && (p.full_name || p.username)) || "Staff"; }
    function can(key) { return window.Permissions ? window.Permissions.hasPermission(key) : true; }
    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
        else setMessage(text, type === "error" ? "error" : "success");
    }
    function setMessage(text, type) {
        const el = $("bdPageMessage");
        el.textContent = text || "";
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = text ? "block" : "none";
    }
    function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
    function money(v) {
        const n = num(v);
        if (n === null) return "—";
        return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    function signed(v) {
        const n = num(v);
        if (n === null) return "—";
        if (Math.round(n) === 0) return "$0";
        return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
    }
    function parseMoney(text) {
        const cleaned = String(text ?? "").replace(/[$,\s]/g, "");
        if (cleaned === "") return null;
        if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
        return Number(cleaned);
    }
    // Lenient on purpose (2026-11-27): "12,500 sf", "$0", "N/A" and "-" are
    // all fine. Blank / N/A means "doesn't apply" (a church has no units).
    function parseCount(text) {
        const raw = String(text ?? "").trim().toLowerCase();
        if (/^(n\/?a|none|-+|—|–)$/.test(raw)) return 0;
        const cleaned = raw.replace(/sq\.?\s*ft\.?|sqft|sf|units?|bldgs?|buildings?|[$,\s]/g, "");
        if (cleaned === "") return 0;
        if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
        return Number(cleaned);
    }
    function fmtCount(v) { const n = num(v); return n === null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
    function plainAmount(v) { const n = num(v); return n === null ? "" : String(Math.round(n * 100) / 100); }
    function shortDate(iso) {
        if (!iso) return "";
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    function dateTime(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
    }
    function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim()); }
    function openOverlay(id) { $(id).classList.remove("hidden"); document.body.classList.add("popup-active"); }
    function closeOverlay(id) {
        $(id).classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }
    function formMsg(id, text, type) { const el = $(id); el.textContent = text || ""; el.className = `auth-message ${type || ""}`.trim(); }

    const isSection = a => a.kind !== "building";
    const mult = a => (isSection(a) ? 1 : (Number(a.building_count) || 0));
    const shownAreas = () => areas.filter(a => a.enabled !== false);
    const codeLabel = c => (codeMap.get(c) ? codeMap.get(c).description : c);
    const codeSort = (a, b) => ((codeMap.get(a)?.sort_order ?? 1e9) - (codeMap.get(b)?.sort_order ?? 1e9)) || String(a).localeCompare(String(b), "en", { numeric: true });
    const lineKey = (areaId, code) => `${areaId}|${code}`;
    const hasLines = pkg => Array.isArray(pkg.cost_codes) && pkg.cost_codes.length && Array.isArray(pkg.area_ids) && pkg.area_ids.length;
    const pkgInvites = pkg => invites.filter(i => i.package_id === pkg.id);
    const areaFacts = a => {
        if (isSection(a)) return a.name;
        const nums = String(a.building_numbers || "").split(/\s*,\s*/).filter(Boolean);
        return `${a.name} × ${a.building_count}${nums.length ? ` (#${nums.join(", #")})` : ""}`;
    };

    async function callBidFunction(body) {
        try {
            const { data, error } = await client().functions.invoke("bid-invites", { body });
            if (error) {
                let message = error.message || "The bid service didn't respond.";
                let code = null;
                try {
                    const payload = error.context && typeof error.context.json === "function" ? await error.context.json() : null;
                    if (payload && payload.error) message = payload.error;
                    if (payload && payload.code) code = payload.code;
                } catch (e) { /* keep generic */ }
                return { error: message, code };
            }
            if (data && data.ok === false) return { error: data.error || "Something went wrong.", code: data.code || null };
            return { data };
        } catch (err) {
            return { error: err && err.message ? err.message : "The bid service didn't respond." };
        }
    }

    function openFile(file) {
        if (!file || !file.storage_path || !window.FilePreview) return;
        window.FilePreview.open({
            name: file.file_name,
            getUrl: async () => {
                const { data, error } = await client().storage.from(file.bucket || "project-documents").createSignedUrl(file.storage_path, 600);
                if (error || !data?.signedUrl) throw error || new Error("no url");
                return data.signedUrl;
            },
        });
    }

    /* ---------- data ---------- */

    async function load() {
        $("bdLoading").style.display = "block";
        try {
            const [codeRes, areaRes, lineRes, pkgRes] = await Promise.all([
                client().from("bid_cost_codes").select("*").eq("active", true).order("sort_order"),
                client().from("bid_areas").select("*").eq("project_id", project.id).order("sort_order"),
                client().from("bid_lines").select("*").eq("project_id", project.id),
                client().from("bid_packages").select("*").eq("project_id", project.id).order("created_at", { ascending: false }),
            ]);
            for (const r of [codeRes, areaRes, lineRes, pkgRes]) if (r.error) throw r.error;
            codes = codeRes.data || [];
            codeMap = new Map(codes.map(c => [c.code, c]));
            const order = { building: 0, site_work: 1, hardscape: 2, amenities: 3 };
            areas = (areaRes.data || []).slice().sort((a, b) => (order[a.kind] - order[b.kind]) || (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at)));
            lines = lineRes.data || [];
            packages = pkgRes.data || [];
            invites = []; prices = []; files = new Map(); pkgFiles = new Map();
            const ids = packages.map(p => p.id);
            if (ids.length) {
                const [invRes, linkRes] = await Promise.all([
                    client().from("bid_invites").select("*").in("package_id", ids).order("company_name"),
                    client().from("bid_package_files").select("package_id, sort_order, project_files(id, file_name, bucket, storage_path)").in("package_id", ids).order("sort_order"),
                ]);
                if (invRes.error) throw invRes.error;
                invites = invRes.data || [];
                (linkRes.data || []).forEach(l => {
                    const f = Array.isArray(l.project_files) ? l.project_files[0] : l.project_files;
                    if (!f) return;
                    if (!pkgFiles.has(l.package_id)) pkgFiles.set(l.package_id, []);
                    pkgFiles.get(l.package_id).push(f);
                });
            }
            const invIds = invites.map(i => i.id);
            if (invIds.length) {
                const { data, error } = await client().from("bid_invite_prices").select("*").in("invite_id", invIds);
                if (error) throw error;
                prices = data || [];
                const fileIds = invites.map(i => i.proposal_file_id).filter(Boolean);
                if (fileIds.length) {
                    const { data: f } = await client().from("project_files").select("id, file_name, bucket, storage_path").in("id", fileIds);
                    (f || []).forEach(x => files.set(String(x.id), x));
                }
            }
        } catch (err) {
            $("bdLoading").style.display = "none";
            const missing = /bid_areas|bid_cost_codes|bid_lines|winner_invite_id|does not exist/i.test(String(err && err.message));
            setMessage(missing
                ? "Bids isn't set up in the database yet. Run sql/supabase-bid-leveling-setup.sql and sql/supabase-bids-v2-setup.sql in Supabase › SQL Editor."
                : `Couldn't load bids: ${err && err.message ? err.message : err}`, "error");
            return;
        }
        coiTemplate = window.CoiTemplate ? await window.CoiTemplate.load(project.id) : null;
        const hid = await client().from("bid_project_hidden_codes").select("cost_code").eq("project_id", project.id);
        sheetReady = !hid.error;
        hiddenCodes = new Set((hid.data || []).map(r => r.cost_code));
        $("bdLoading").style.display = "none";
        render();
    }

    /* ---------- package math ---------- */

    // Lines of a package: [{ area, code, bids: [{ invite, amount }], budget, winnerId }]
    function packageLines(pkg) {
        if (!hasLines(pkg)) return [];
        const inv = new Map(pkgInvites(pkg).map(i => [i.id, i]));
        const out = [];
        shownAreas().filter(a => pkg.area_ids.includes(a.id)).forEach(a => {
            pkg.cost_codes.slice().sort(codeSort).forEach(code => {
                const row = lines.find(l => l.area_id === a.id && l.cost_code === code) || null;
                const bids = prices
                    .filter(p => p.area_id === a.id && p.cost_code === code && inv.has(p.invite_id))
                    .map(p => ({ invite: inv.get(p.invite_id), amount: Number(p.amount) }))
                    .filter(b => b.invite.status !== "not_bidding")
                    .sort((x, y) => x.amount - y.amount);
                const saved = row && row.winner_invite_id && inv.has(row.winner_invite_id) ? row.winner_invite_id : null;
                out.push({ area: a, code, row, bids, budget: row ? num(row.budget) : null, winnerId: saved });
            });
        });
        return out;
    }

    function currentWinner(pkg, l) {
        if (l.winnerId) return l.winnerId;
        const key = lineKey(l.area.id, l.code);
        if (picks.has(key)) return picks.get(key);
        return l.bids[0] ? l.bids[0].invite.id : "";
    }

    function packageTotals(pkg) {
        const invs = pkgInvites(pkg);
        const t = { invited: invs.filter(i => i.status !== "pending").length, bids: invs.filter(i => HAS_BID.includes(i.status)).length, waiting: invs.filter(i => WAITING.includes(i.status)).length, best: null, budget: null, awarded: invs.filter(i => i.status === "awarded") };
        if (hasLines(pkg)) {
            packageLines(pkg).forEach(l => {
                const m = mult(l.area);
                if (l.bids.length) t.best = (t.best || 0) + l.bids[0].amount * m;
                if (l.budget !== null) t.budget = (t.budget || 0) + l.budget * m;
            });
        } else {
            const amounts = invs.filter(i => HAS_BID.includes(i.status) && i.bid_amount != null).map(i => Number(i.bid_amount));
            if (amounts.length) t.best = Math.min(...amounts);
        }
        return t;
    }

    function statusChip(pkg, t) {
        if (pkg.status === "draft") return `<span class="bd-chip bd-chip--warn">Draft</span>`;
        if (pkg.status === "awarded") return `<span class="bd-chip bd-chip--done">Awarded · ${esc(t.awarded.map(i => i.company_name).join(", "))}</span>`;
        if (pkg.status === "closed") return `<span class="bd-chip">Closed</span>`;
        if (t.bids && (!t.waiting || (pkg.due_at && new Date(pkg.due_at) < new Date()))) return `<span class="bd-chip bd-chip--done">Ready to award</span>`;
        return `<span class="bd-chip">Bidding${t.waiting ? ` · ${t.waiting} waiting` : ""}</span>`;
    }

    /* ---------- render: list ---------- */

    function render() {
        const params = new URLSearchParams(window.location.search);
        openPkgId = params.get("package");
        const pkg = openPkgId ? packages.find(p => p.id === openPkgId && p.status !== "draft") : null;
        const sheet = !pkg && params.get("sheet") === "1" && canSend;
        $("bdListView").classList.toggle("hidden", !!pkg || sheet);
        $("bdPackageView").classList.toggle("hidden", !pkg);
        $("bdSheetView").classList.toggle("hidden", !sheet);
        if (pkg) renderPackage(pkg);
        else if (sheet) renderSheet();
        else renderList();
    }

    function renderList() {
        $("bdNewBtn").classList.toggle("hidden", !canSend);
        $("bdSheetBtn").classList.toggle("hidden", !canSend);
        const shown = shownAreas();
        $("bdBuildings").innerHTML = areas.length
            ? `Buildings: ${shown.map(a => esc(areaFacts(a))).join(" · ")}${canManage ? ` · <button type="button" class="bl-link-btn" data-act="setup">Edit</button>` : ""}`
            : `No buildings set up yet.${canManage ? ` <button type="button" class="bl-link-btn" data-act="setup">Set up buildings</button>` : ""} Bid packages with cost codes need them.`;

        let ready = 0, bidsIn = 0, invited = 0, waiting = 0, awardedAmt = 0, awardedPk = 0, diff = 0, hasDiff = false;
        const live = packages.filter(p => p.status !== "draft");
        live.forEach(p => {
            const t = packageTotals(p);
            bidsIn += t.bids; invited += t.invited; waiting += t.waiting;
            if (p.status === "open" && t.bids && (!t.waiting || (p.due_at && new Date(p.due_at) < new Date()))) ready += 1;
            if (p.status === "awarded") { awardedPk += 1; t.awarded.forEach(i => { awardedAmt += Number(i.awarded_amount ?? i.bid_amount ?? 0); }); }
            if (t.best !== null && t.budget !== null) { diff += t.best - t.budget; hasDiff = true; }
        });
        $("bdStats").innerHTML = `
            <div class="bl-stat"><span>Bid packages</span><strong>${live.length}</strong><em>${ready} ready to award</em></div>
            <div class="bl-stat"><span>Bids in</span><strong>${bidsIn} of ${invited}</strong><em class="${waiting ? "bd-warn" : ""}">${waiting} still waiting</em></div>
            <div class="bl-stat"><span>Awarded</span><strong>${esc(money(awardedAmt))}</strong><em>${awardedPk} of ${live.length} packages</em></div>
            <div class="bl-stat"><span>Best bids vs budget</span><strong class="${diff > 0 ? "bl-over" : ""}">${hasDiff ? esc(diff > 0 ? `${money(diff)} over` : `${money(Math.abs(diff))} under`) : "—"}</strong><em>on packages with bids and budgets</em></div>`;

        if (!packages.length) {
            $("bdTable").innerHTML = `<div class="bl-empty"><p><strong>No bid packages yet.</strong></p><p>${canSend ? "Click <strong>+ New bid package</strong> to send your first one." : "Nothing has been sent for this project yet."}</p></div>`;
        } else {
            let html = `<div class="bd-row bd-row--head"><div>Package</div><div>Due</div><div>Bids</div><div class="bl-num">Best total</div><div class="bl-num">Budget</div><div class="bl-num">vs budget</div><div>Status</div><div></div></div>`;
            packages.forEach(p => {
                const t = packageTotals(p);
                const d = t.best !== null && t.budget !== null ? t.best - t.budget : null;
                const sub = hasLines(p) ? `Cost codes ${p.cost_codes.slice().sort(codeSort).join(", ")}` : "One total per vendor";
                const action = p.status === "draft"
                    ? (canSend ? `<button type="button" class="bl-review-btn" data-act="continue" data-pkg="${esc(p.id)}">Continue</button>` : "")
                    : `<button type="button" class="bl-review-btn" data-act="open" data-pkg="${esc(p.id)}">Open</button>`;
                html += `
                    <div class="bd-row" data-act="${p.status === "draft" ? "continue" : "open"}" data-pkg="${esc(p.id)}">
                        <div class="bd-pkg"><strong>${esc(p.name)}</strong><span>${esc(sub)}</span></div>
                        <div class="bl-soft bl-small">${p.status === "awarded" ? `Awarded ${esc(shortDate(p.awarded_at))}` : p.due_at ? `Due ${esc(shortDate(p.due_at))}` : "—"}</div>
                        <div class="bl-small">${p.status === "draft" ? "—" : `${t.bids} of ${t.invited}`}</div>
                        <div class="bl-num"><strong>${esc(money(t.best))}</strong></div>
                        <div class="bl-num bl-soft">${esc(money(t.budget))}</div>
                        <div class="bl-num ${d > 0 ? "bl-over" : "bl-soft"}">${esc(signed(d))}</div>
                        <div>${statusChip(p, t)}</div>
                        <div class="bl-action">${action}</div>
                    </div>`;
            });
            $("bdTable").innerHTML = html;
        }

        // Cards carried over from Bid Invites.
        if (window.CoiTemplate && !$("bdCoiTemplate").dataset.mounted) {
            $("bdCoiTemplate").dataset.mounted = "1";
            window.CoiTemplate.mount($("bdCoiTemplate"), { project, canManage });
        }
        if (window.VendorPaperwork) {
            if (!paperwork) paperwork = window.VendorPaperwork.mount($("bdPaperwork"), { project, canManage, call: callBidFunction });
            else paperwork.reload();
        }
    }

    /* ---------- render: one package ---------- */

    function go(pkgId, opts) {
        const params = new URLSearchParams(window.location.search);
        if (pkgId) params.set("package", pkgId); else params.delete("package");
        if (opts && opts.sheet) params.set("sheet", "1"); else params.delete("sheet");
        history.pushState(null, "", `${window.location.pathname}?${params.toString()}`);
        picks = new Map();
        render();
        window.scrollTo(0, 0);
    }

    function renderPackage(pkg) {
        const t = packageTotals(pkg);
        const invs = pkgInvites(pkg);
        const open = pkg.status === "open";
        $("bdPkgKicker").textContent = `${t.bids} of ${t.invited} bids in${pkg.due_at ? ` · due ${dateTime(pkg.due_at)}` : ""}${hasLines(pkg) ? " · prices are per building" : ""}`;
        $("bdPkgTitle").textContent = pkg.name;
        $("bdAddBidBtn").classList.toggle("hidden", !(canManage && open));
        $("bdAwardBtn").classList.toggle("hidden", !(canManage && open && t.bids));
        $("bdRemindBtn").classList.toggle("hidden", !(canManage && open && t.waiting));
        $("bdRemindBtn").textContent = `Remind waiting (${t.waiting})`;
        const plans = pkgFiles.get(pkg.id) || [];
        $("bdPkgMeta").innerHTML = [
            pkg.scope ? `<span>${esc(pkg.scope)}</span>` : "",
            plans.length ? `<span>Plans: ${plans.map((f, i) => `<button type="button" class="bl-link-btn" data-act="plan" data-index="${i}">${esc(f.file_name)}</button>`).join(", ")}</span>` : "",
        ].filter(Boolean).join("");

        if (hasLines(pkg)) renderMatrix(pkg, invs, open);
        else renderTotals(pkg, invs, open);
        renderVendors(pkg, invs, open);
    }

    function vendorHead(inv) {
        const file = inv.proposal_file_id ? files.get(String(inv.proposal_file_id)) : null;
        const status = HAS_BID.includes(inv.status) ? (file ? `<button type="button" class="bl-link-btn" data-act="proposal" data-file="${esc(file.id)}">Proposal</button>` : "") : `<span class="bd-head-status">${esc(STATUS[inv.status] || inv.status)}</span>`;
        return `<div class="bl-num bd-vhead"><strong>${esc(inv.company_name)}</strong>${status}</div>`;
    }

    function renderMatrix(pkg, invs, open) {
        const ls = packageLines(pkg);
        const cols = invs.filter(i => i.status !== "pending" && i.status !== "failed");
        const template = `minmax(220px, 1.5fr) 120px ${cols.map(() => "minmax(120px, 1fr)").join(" ")} 180px`;
        let html = `<div class="bd-matrix" style="--bd-cols:${template}">
            <div class="bd-mrow bd-row--head"><div>Cost code</div><div class="bl-num">Budget</div>${cols.map(vendorHead).join("")}<div>Winner</div></div>`;
        let lastArea = null;
        ls.forEach(l => {
            if (l.area.id !== lastArea) {
                lastArea = l.area.id;
                html += `<div class="bd-area">${esc(l.area.name)} <span>${isSection(l.area) ? "whole site" : `× ${l.area.building_count} building${l.area.building_count === 1 ? "" : "s"}`}</span></div>`;
            }
            const low = l.bids[0] ? l.bids[0].amount : null;
            const winner = currentWinner(pkg, l);
            const cells = cols.map(inv => {
                const b = l.bids.find(x => x.invite.id === inv.id);
                if (!b) return `<div class="bl-num bl-soft bd-np">${HAS_BID.includes(inv.status) ? "Not priced" : "—"}</div>`;
                return `<div class="bl-num ${b.amount === low ? "bd-low" : ""}">${esc(money(b.amount))}</div>`;
            }).join("");
            let winCell;
            if (!open || !canManage) {
                const w = l.bids.find(b => b.invite.id === l.winnerId);
                winCell = w ? `<span class="bl-awarded"><span class="bl-check" aria-hidden="true"></span>${esc(w.invite.company_name)}</span>` : `<span class="bl-soft">—</span>`;
            } else if (!l.bids.length) {
                winCell = `<span class="bl-soft bl-small">No bids yet</span>`;
            } else {
                winCell = `<select class="bd-winner" aria-label="Winner for ${esc(l.code)} on ${esc(l.area.name)}" data-key="${esc(lineKey(l.area.id, l.code))}">
                    ${l.bids.map(b => `<option value="${esc(b.invite.id)}" ${b.invite.id === winner ? "selected" : ""}>${esc(b.invite.company_name)}</option>`).join("")}
                    <option value="" ${winner === "" ? "selected" : ""}>No award</option></select>`;
            }
            const budget = canManage && open
                ? `<button type="button" class="bd-budget" data-act="budget" data-area="${esc(l.area.id)}" data-code="${esc(l.code)}" title="Edit budget">${esc(l.budget === null ? "Add" : money(l.budget))}</button>`
                : esc(money(l.budget));
            html += `<div class="bd-mrow">
                <div class="bl-item"><span class="bl-code">${esc(l.code)}</span><span class="bl-desc">${esc(codeLabel(l.code))}</span></div>
                <div class="bl-num bl-soft">${budget}</div>${cells}<div>${winCell}</div></div>`;
        });
        // Vendor totals (all buildings)
        const tot = cols.map(inv => {
            let s = 0, any = false, missing = false;
            ls.forEach(l => { const b = l.bids.find(x => x.invite.id === inv.id); if (b) { s += b.amount * mult(l.area); any = true; } else missing = true; });
            return `<div class="bl-num">${any ? esc(money(s)) : "—"}${any && missing ? `<span class="bd-partial">partial</span>` : ""}</div>`;
        }).join("");
        const budgetAll = ls.reduce((s, l) => s + (l.budget || 0) * mult(l.area), 0);
        html += `<div class="bd-mrow bd-row--total"><div>Vendor total, all buildings</div><div class="bl-num bl-soft">${esc(money(budgetAll || null))}</div>${tot}<div></div></div></div>`;
        $("bdMatrix").innerHTML = html;
        renderPicks(pkg);
    }

    function renderTotals(pkg, invs, open) {
        const bids = invs.filter(i => HAS_BID.includes(i.status) && i.bid_amount != null).sort((a, b) => Number(a.bid_amount) - Number(b.bid_amount));
        const winner = picks.get("single") || (bids.find(i => i.status === "awarded") || bids[0] || {}).id || "";
        if (!picks.has("single") && winner) picks.set("single", winner);
        let html = `<div class="bd-matrix" style="--bd-cols:minmax(200px,1.5fr) 160px 1fr 140px"><div class="bd-mrow bd-row--head"><div>Vendor</div><div class="bl-num">Bid total</div><div>Notes</div><div>Winner</div></div>`;
        if (!bids.length) html += `<div class="bl-empty"><p>No bids yet.</p></div>`;
        bids.forEach((i, n) => {
            const file = i.proposal_file_id ? files.get(String(i.proposal_file_id)) : null;
            html += `<div class="bd-mrow"><div><strong>${esc(i.company_name)}</strong>${file ? ` · <button type="button" class="bl-link-btn" data-act="proposal" data-file="${esc(file.id)}">Proposal</button>` : ""}</div>
                <div class="bl-num ${n === 0 ? "bd-low" : ""}">${esc(money(i.bid_amount))}</div>
                <div class="bl-soft bl-small">${esc(i.bid_notes || "")}</div>
                <div>${open && canManage ? `<label class="bd-radio"><input type="radio" name="bdSingle" value="${esc(i.id)}" ${i.id === winner ? "checked" : ""}> Winner</label>` : (i.status === "awarded" ? `<span class="bl-awarded"><span class="bl-check" aria-hidden="true"></span>Awarded</span>` : "")}</div></div>`;
        });
        html += `</div>`;
        $("bdMatrix").innerHTML = html;
        renderPicks(pkg);
    }

    // { inviteId: { invite, amount, what: [labels] } } for the current picks.
    function computePicks(pkg) {
        const out = new Map();
        if (hasLines(pkg)) {
            packageLines(pkg).forEach(l => {
                const id = currentWinner(pkg, l);
                if (!id) return;
                const b = l.bids.find(x => x.invite.id === id);
                if (!b) return;
                if (!out.has(id)) out.set(id, { invite: b.invite, amount: 0, budget: 0, what: [], lines: [] });
                const o = out.get(id);
                o.amount += b.amount * mult(l.area);
                o.budget += (l.budget || 0) * mult(l.area);
                o.lines.push({ area_id: l.area.id, cost_code: l.code, invite_id: id });
                const label = `${l.code} ${codeLabel(l.code)}`;
                if (!o.what.includes(label)) o.what.push(label);
            });
        } else {
            const id = picks.get("single");
            const inv = invites.find(i => i.id === id);
            if (inv) out.set(id, { invite: inv, amount: Number(inv.bid_amount), budget: 0, what: [pkg.name], lines: [] });
        }
        return out;
    }

    function renderPicks(pkg) {
        const bar = $("bdPicks");
        const open = pkg.status === "open";
        const chosen = computePicks(pkg);
        if (!chosen.size) { bar.classList.add("hidden"); return; }
        bar.classList.remove("hidden");
        let total = 0, budget = 0;
        const items = Array.from(chosen.values()).map(o => {
            const amt = open ? o.amount : Number(o.invite.awarded_amount ?? o.amount);
            total += amt; budget += o.budget;
            return `<div class="bl-stat"><span>${esc(o.invite.company_name)} · ${esc(o.what.map(w => w.replace(/^\d+\s/, "")).join(", "))}</span><strong>${esc(money(amt))}</strong></div>`;
        }).join("");
        const d = budget ? total - budget : null;
        $("bdPicksBody").innerHTML = `${items}<div class="bl-stat"><span>${open ? "Your picks total" : "Awarded total"}</span><strong>${esc(money(total))}${d !== null ? ` <small class="${d > 0 ? "bl-over" : ""}">${esc(d > 0 ? `${money(d)} over budget` : `${money(Math.abs(d))} under budget`)}</small>` : ""}</strong></div>`;
        $("bdPicksAwardBtn").classList.toggle("hidden", !(open && canManage));
        $("bdPkgNote").classList.toggle("hidden", !(open && canManage));
    }

    function renderVendors(pkg, invs, open) {
        const rows = invs.map(inv => {
            const acts = [];
            if (canManage && open) {
                if (inv.status === "pending" || inv.status === "failed") acts.push(`<button type="button" class="bl-link-btn" data-act="retry" data-invite="${esc(inv.id)}">Send again</button>`);
                if (WAITING.includes(inv.status)) acts.push(`<button type="button" class="bl-link-btn" data-act="remind" data-invite="${esc(inv.id)}" ${busy.has(inv.id) ? "disabled" : ""}>${busy.has(inv.id) ? "Sending…" : "Remind"}</button>`);
            }
            if (canManage && inv.status === "awarded") {
                const label = busy.has(inv.id) ? "Sending…" : inv.coi_requested_at && !inv.coi_received_at ? "Re-send COI request" : inv.coi_received_at ? "" : "Request COI";
                if (label) acts.push(`<button type="button" class="bl-link-btn" data-act="coi" data-invite="${esc(inv.id)}" ${busy.has(inv.id) || !coiTemplate ? "disabled" : ""}>${label}</button>`);
            }
            const extra = inv.status === "failed" && inv.send_error ? ` · ${inv.send_error}` : inv.status === "not_bidding" && inv.decline_note ? ` · ${inv.decline_note}` : inv.status === "awarded" ? ` · ${money(inv.awarded_amount ?? inv.bid_amount)}${inv.coi_received_at ? " · COI on file" : ""}` : "";
            return `<div class="bd-vrow"><div><strong>${esc(inv.company_name)}</strong><span class="bl-soft bl-small">${esc(inv.contact_email || "")}</span></div>
                <div class="bl-small">${esc(STATUS[inv.status] || inv.status)}${esc(extra)}</div><div class="bd-vacts">${acts.join("")}</div></div>`;
        }).join("");
        $("bdVendors").innerHTML = rows || `<p class="bl-soft">No vendors on this package.</p>`;
    }

    /* ---------- budget (inline) ---------- */

    async function editBudget(areaId, code, btn) {
        const l = lines.find(x => x.area_id === areaId && x.cost_code === code);
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "bd-budget-input";
        input.value = l && l.budget != null ? plainAmount(l.budget) : "";
        input.setAttribute("aria-label", `Budget per building for ${code}`);
        btn.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = async save => {
            if (done) return;
            done = true;
            if (!save) { render(); return; }
            const v = parseMoney(input.value);
            if (Number.isNaN(v)) { toast("The budget has to be a number, like 312000.", "error"); render(); return; }
            const res = l
                ? await client().from("bid_lines").update({ budget: v, updated_by_name: staffName() }).eq("id", l.id).select("id")
                : await client().from("bid_lines").insert({ project_id: project.id, area_id: areaId, cost_code: code, budget: v, updated_by_name: staffName() }).select("id");
            if (res.error || !res.data || !res.data.length) { toast(`Couldn't save the budget: ${res.error ? res.error.message : "permission denied"}`, "error"); }
            await load();
        };
        input.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
        input.addEventListener("blur", () => finish(true));
    }

    /* ---------- award ---------- */

    function openAward() {
        const pkg = packages.find(p => p.id === openPkgId);
        if (!pkg || !canManage) return;
        const chosen = computePicks(pkg);
        if (!chosen.size) { toast("Pick at least one winner.", "error"); return; }
        const winnerIds = new Set(chosen.keys());
        const losers = pkgInvites(pkg).filter(i => i.status === "bid_received" && !winnerIds.has(i.id));
        $("bdAwardTitle").textContent = `Award ${pkg.name}`;
        $("bdAwardWinners").innerHTML = Array.from(chosen.entries()).map(([id, o]) => `
            <div class="bd-winner-card">
                <div class="bd-winner-top"><strong>${esc(o.invite.company_name)}</strong><span>${esc(money(o.amount))}</span></div>
                <span class="bl-soft bl-small">${esc(o.what.join(", "))}</span>
                <label class="bd-neg">Negotiated contract amount <em>(optional)</em>
                    <span class="bid-money-input"><span>$</span><input type="text" inputmode="decimal" data-neg="${esc(id)}" placeholder="${esc(plainAmount(o.amount))}" autocomplete="off"></span></label>
            </div>`).join("");
        $("bdAwardLosers").textContent = losers.length ? `Not selected: ${losers.map(i => i.company_name).join(", ")}` : "";
        const names = Array.from(chosen.values()).map(o => o.invite.company_name);
        $("bdAwardNotifyWinnerLabel").textContent = `Email ${names.join(" and ")} the award and ask for their COI`;
        $("bdAwardNotifyWinner").checked = true;
        $("bdAwardNotifyOthersRow").classList.toggle("hidden", !losers.length);
        $("bdAwardNotifyOthersLabel").textContent = `Email ${losers.map(i => i.company_name).join(", ")} a "not selected" note`;
        $("bdAwardNotifyOthers").checked = losers.length > 0;
        $("bdAwardConfirmBtn").textContent = `Award ${chosen.size === 1 ? names[0] : `${chosen.size} vendors`}`;
        $("bdAwardConfirmBtn").disabled = false;
        $("bdAwardCoiTpl").classList.add("hidden");
        formMsg("bdAwardMessage", "");
        openOverlay("bdAwardOverlay");
    }

    async function confirmAward(event) {
        event.preventDefault();
        const pkg = packages.find(p => p.id === openPkgId);
        if (!pkg) return;
        const chosen = computePicks(pkg);
        const amounts = {};
        for (const input of document.querySelectorAll("#bdAwardWinners [data-neg]")) {
            const v = parseMoney(input.value);
            if (Number.isNaN(v)) { formMsg("bdAwardMessage", "Negotiated amounts have to be numbers, like 925000.", "error"); return; }
            if (v) amounts[input.dataset.neg] = v;
        }
        $("bdAwardConfirmBtn").disabled = true;
        formMsg("bdAwardMessage", "Awarding…");
        const notify = { notify_winner: $("bdAwardNotifyWinner").checked, notify_others: $("bdAwardNotifyOthers").checked };
        let result;
        if (hasLines(pkg)) {
            const picked = [];
            chosen.forEach(o => picked.push(...o.lines));
            result = await callBidFunction({ action: "award_split", package_id: pkg.id, lines: picked, amounts, ...notify });
        } else {
            const [id] = chosen.keys();
            if (amounts[id]) {
                const { error } = await client().from("bid_invites").update({ awarded_amount: amounts[id] }).eq("id", id);
                if (error) { formMsg("bdAwardMessage", `Couldn't save the amount: ${error.message}`, "error"); $("bdAwardConfirmBtn").disabled = false; return; }
            }
            result = await callBidFunction({ action: "award", package_id: pkg.id, invite_id: id, ...notify });
        }
        if (result.error) {
            if (result.code === "no_template" && window.CoiTemplate) {
                const box = $("bdAwardCoiTpl");
                box.classList.remove("hidden");
                if (!box.dataset.mounted) {
                    box.dataset.mounted = "1";
                    window.CoiTemplate.mount(box, { project, canManage, intro: "Post this project's COI template first. The award email asks for the vendor's COI, and they can't upload it without the template." });
                }
            }
            formMsg("bdAwardMessage", `Couldn't award: ${result.error}`, "error");
            $("bdAwardConfirmBtn").disabled = false;
            return;
        }
        closeOverlay("bdAwardOverlay");
        const data = result.data || {};
        const failed = data.failed || [];
        toast(failed.length
            ? `Awarded, but ${failed.length} email${failed.length === 1 ? "" : "s"} didn't send (${failed.map(f => f.company_name).join(", ")}).`
            : `Awarded${data.emailed ? ` · ${data.emailed} email${data.emailed === 1 ? "" : "s"} sent` : ""}. Generate contracts from the Accounts page.`, failed.length ? "error" : "success");
        picks = new Map();
        await load();
    }

    /* ---------- vendor actions ---------- */

    async function remind(ids, label) {
        ids.forEach(id => busy.add(id));
        render();
        const { data, error } = await callBidFunction({ action: "remind", invite_ids: ids });
        ids.forEach(id => busy.delete(id));
        if (error) toast(`Couldn't send reminders: ${error}`, "error");
        else toast(`Reminder sent to ${label}${data && data.failed && data.failed.length ? ` (${data.failed.length} failed)` : ""}`);
        await load();
    }

    async function retry(inv) {
        busy.add(inv.id);
        render();
        const { data, error } = await callBidFunction({ action: "send", package_id: inv.package_id, invite_ids: [inv.id] });
        busy.delete(inv.id);
        if (error || (data && data.failed && data.failed.length)) toast(`Didn't send: ${error || data.failed[0].error}`, "error");
        else toast(`Invite sent to ${inv.company_name}`);
        await load();
    }

    async function requestCoi(inv) {
        busy.add(inv.id);
        render();
        const { error } = await callBidFunction({ action: "request_coi", invite_id: inv.id });
        busy.delete(inv.id);
        if (error) toast(`Couldn't request the COI: ${error}`, "error");
        else toast(`COI requested from ${inv.company_name}`);
        await load();
    }

    /* ---------- add a bid by hand ---------- */

    let vendorCache = null; // { companies, contacts: Map, tags, categories, companyTags }
    async function loadVendorData() {
        if (vendorCache) return vendorCache;
        const [cos, contacts, cats, tags, ctags] = await Promise.all([
            client().from("Companies").select("*").order("Name"),
            client().from("Contacts").select("*"),
            client().from("vendor_tag_categories").select("*").order("sort_order"),
            client().from("vendor_tags").select("*").order("name"),
            client().from("company_tags").select("*"),
        ]);
        const byCo = new Map();
        (contacts.data || []).forEach(c => {
            const k = String(c.company_id);
            if (!byCo.has(k)) byCo.set(k, []);
            byCo.get(k).push(c);
        });
        vendorCache = { companies: cos.data || [], contacts: byCo, categories: cats.data || [], tags: tags.data || [], companyTags: ctags.data || [] };
        return vendorCache;
    }

    function emailContacts(v, companyId) { return (v.contacts.get(String(companyId)) || []).filter(c => isEmail(c.Email)); }

    // Same rule as the Vendors page (js/companies.js missingVendorRequirements).
    function missingRequirements(v, co) {
        const blank = x => x === null || x === undefined || String(x).trim() === "";
        const miss = [];
        if (blank(co.Street) || blank(co.City) || blank(co.State) || blank(co.Zip)) miss.push("address");
        if (blank(co["SSN/FID"]) && !co.W9Exempt) miss.push("SSN / FID");
        if (!co.W9FilePath && !co.W9Exempt) miss.push("W-9");
        if (!co.COIExempt) {
            if (blank(co.COIExpiresOn)) miss.push("COI date");
            else if (new Date(`${String(co.COIExpiresOn).slice(0, 10)}T23:59:59`) < new Date()) miss.push("COI expired");
        }
        const mine = new Set(v.companyTags.filter(t => String(t.company_id) === String(co.id)).map(t => String(t.tag_id)));
        const tagCats = new Set(v.tags.filter(t => mine.has(String(t.id))).map(t => String(t.category_id)));
        if (!v.categories.length || v.categories.some(c => !tagCats.has(String(c.id)))) miss.push("tags");
        return miss;
    }

    let bidPkg = null;
    async function openAddBid() {
        const pkg = packages.find(p => p.id === openPkgId);
        if (!pkg || !canManage) return;
        bidPkg = pkg;
        $("bdBidSubtitle").textContent = pkg.name;
        formMsg("bdBidMessage", "");
        $("bdBidSaveBtn").disabled = false;
        const v = await loadVendorData();
        const inPkg = pkgInvites(pkg).filter(i => i.status !== "awarded");
        const invited = new Set(inPkg.map(i => String(i.company_id)));
        $("bdBidVendor").innerHTML = `<option value="">Choose a vendor…</option>`
            + inPkg.map(i => `<option value="inv:${esc(i.id)}">${esc(i.company_name)} (invited)</option>`).join("")
            + v.companies.filter(c => !invited.has(String(c.id))).map(c => `<option value="co:${esc(c.id)}">${esc(c.Name)}</option>`).join("");
        renderBidLines();
        openOverlay("bdBidOverlay");
    }

    function renderBidLines() {
        const pkg = bidPkg;
        const pick = $("bdBidVendor").value;
        const inviteId = pick.startsWith("inv:") ? pick.slice(4) : null;
        if (!hasLines(pkg)) {
            const inv = inviteId ? invites.find(i => i.id === inviteId) : null;
            $("bdBidLines").innerHTML = `<label class="auth-field">Bid total <span class="bid-money-input"><span>$</span><input type="text" inputmode="decimal" data-total value="${esc(inv && inv.bid_amount != null ? plainAmount(inv.bid_amount) : "")}"></span></label>`;
            return;
        }
        let html = "", last = null;
        packageLines(pkg).forEach(l => {
            if (l.area.id !== last) { last = l.area.id; html += `<p class="bd-bid-area">${esc(l.area.name)} <span>${isSection(l.area) ? "whole site" : `price per building · × ${l.area.building_count}`}</span></p>`; }
            const existing = inviteId ? prices.find(p => p.invite_id === inviteId && p.area_id === l.area.id && p.cost_code === l.code) : null;
            html += `<label class="bd-bid-line"><span><span class="bl-code">${esc(l.code)}</span> ${esc(codeLabel(l.code))}</span>
                <span class="bid-money-input"><span>$</span><input type="text" inputmode="decimal" data-line="${esc(lineKey(l.area.id, l.code))}" value="${esc(existing ? plainAmount(existing.amount) : "")}" placeholder="Not priced"></span></label>`;
        });
        $("bdBidLines").innerHTML = html;
    }

    async function saveBid(event) {
        event.preventDefault();
        const pkg = bidPkg;
        const pick = $("bdBidVendor").value;
        if (!pick) { formMsg("bdBidMessage", "Choose the vendor.", "error"); return; }
        const values = [];
        let total = null;
        if (hasLines(pkg)) {
            for (const input of document.querySelectorAll("#bdBidLines [data-line]")) {
                const v = parseMoney(input.value);
                if (Number.isNaN(v)) { formMsg("bdBidMessage", "Prices have to be numbers, like 298400.", "error"); return; }
                const [area_id, cost_code] = input.dataset.line.split("|");
                values.push({ area_id, cost_code, amount: v });
            }
            if (!values.some(x => x.amount)) { formMsg("bdBidMessage", "Enter at least one price.", "error"); return; }
        } else {
            total = parseMoney(document.querySelector("#bdBidLines [data-total]").value);
            if (!total) { formMsg("bdBidMessage", "Enter the bid total.", "error"); return; }
        }
        $("bdBidSaveBtn").disabled = true;
        formMsg("bdBidMessage", "Saving…");
        try {
            let inviteId = pick.startsWith("inv:") ? pick.slice(4) : null;
            const now = new Date().toISOString();
            if (!inviteId) {
                const v = await loadVendorData();
                const co = v.companies.find(c => String(c.id) === pick.slice(3));
                const contact = co ? emailContacts(v, co.id)[0] : null;
                if (!co) throw new Error("Vendor not found.");
                if (!contact) throw new Error(`${co.Name} has no contact with an email. Add one on their vendor page first.`);
                const { data, error } = await client().from("bid_invites").insert({
                    package_id: pkg.id, company_id: co.id, company_name: co.Name, contact_name: contact.Name || null, contact_email: contact.Email,
                    status: "bid_received", bid_source: "staff", bid_received_on: now.slice(0, 10), logged_by_name: staffName(), logged_at: now,
                    ...(total ? { bid_amount: total } : {}),
                }).select("id").single();
                if (error) throw error;
                inviteId = data.id;
            } else {
                const inv = invites.find(i => i.id === inviteId);
                const { error } = await client().from("bid_invites").update({
                    status: "bid_received", bid_source: inv && inv.bid_source ? inv.bid_source : "staff", decline_reason: null, decline_note: null,
                    bid_received_on: now.slice(0, 10), logged_by_name: staffName(), logged_at: now, ...(total ? { bid_amount: total } : {}),
                }).eq("id", inviteId);
                if (error) throw error;
            }
            if (values.length) {
                const keep = values.filter(x => x.amount !== null);
                const drop = values.filter(x => x.amount === null);
                if (keep.length) {
                    const { error } = await client().from("bid_invite_prices").upsert(keep.map(x => ({ invite_id: inviteId, ...x })), { onConflict: "invite_id,area_id,cost_code" });
                    if (error) throw error;
                }
                for (const x of drop) {
                    await client().from("bid_invite_prices").delete().eq("invite_id", inviteId).eq("area_id", x.area_id).eq("cost_code", x.cost_code);
                }
            }
        } catch (err) {
            formMsg("bdBidMessage", `Couldn't save: ${err && err.message ? err.message : err}`, "error");
            $("bdBidSaveBtn").disabled = false;
            return;
        }
        closeOverlay("bdBidOverlay");
        toast("Bid saved");
        await load();
    }

    /* ---------- buildings ---------- */

    let setupRows = [];
    let afterSetup = null; // reopen New bid package after first-time setup

    function blankBuilding() { return { name: "", building_count: "1", building_numbers: "", units: "", gbsf: "", leasable_sf: "" }; }

    function openSetup(then) {
        if (!canManage) { toast("Ask someone with Manage Bid Invites to set up the buildings.", "error"); return; }
        afterSetup = then || null;
        setupRows = areas.filter(a => a.kind === "building").map(a => ({
            id: a.id, name: a.name, building_count: String(a.building_count ?? 1), building_numbers: a.building_numbers || "",
            units: fmtCount(a.units), gbsf: fmtCount(a.gbsf), leasable_sf: fmtCount(a.leasable_sf),
        }));
        if (!setupRows.length) setupRows.push(blankBuilding());
        SECTIONS.forEach(s => {
            const row = areas.find(a => a.kind === s.kind);
            $(`bdSection_${s.kind}`).checked = row ? row.enabled !== false : false;
        });
        formMsg("bdSetupMessage", "");
        $("bdSetupSaveBtn").disabled = false;
        renderSetupRows();
        openOverlay("bdSetupOverlay");
    }

    function readSetupRows() {
        document.querySelectorAll("#bdSetupRows [data-setup-row]").forEach(el => {
            const r = setupRows[Number(el.dataset.setupRow)];
            if (r) el.querySelectorAll("[data-field]").forEach(input => { r[input.dataset.field] = input.value; });
        });
    }

    function renderSetupRows() {
        $("bdSetupRows").innerHTML = setupRows.map((r, i) => `
            <div class="bl-setup-row" data-setup-row="${i}">
                <label class="bl-setup-field bl-setup-name"><span>Name</span><input type="text" data-field="name" maxlength="80" value="${esc(r.name)}" placeholder="e.g. 24 Unit 1BR &amp; 2BR"></label>
                <label class="bl-setup-field"><span>Buildings</span><input type="text" inputmode="numeric" data-field="building_count" value="${esc(r.building_count)}"></label>
                <label class="bl-setup-field"><span>Building #s</span><input type="text" data-field="building_numbers" maxlength="80" value="${esc(r.building_numbers)}" placeholder="3, 4, 5"></label>
                <label class="bl-setup-field"><span>Units / bldg</span><input type="text" inputmode="numeric" data-field="units" value="${esc(r.units)}" placeholder="Optional"></label>
                <label class="bl-setup-field"><span>GBSF / bldg</span><input type="text" inputmode="decimal" data-field="gbsf" value="${esc(r.gbsf)}" placeholder="Optional"></label>
                <label class="bl-setup-field"><span>Leasable SF</span><input type="text" inputmode="decimal" data-field="leasable_sf" value="${esc(r.leasable_sf)}" placeholder="Optional"></label>
                <button type="button" class="bl-icon-btn" data-act="remove-building" data-index="${i}" aria-label="Remove ${esc(r.name || "this building type")}"><span class="bl-trash" aria-hidden="true"></span></button>
            </div>`).join("");
    }

    async function saveSetup(event) {
        event.preventDefault();
        readSetupRows();
        const rows = setupRows.filter(r => r.id || r.name.trim());
        if (!rows.length) { formMsg("bdSetupMessage", "Add at least one building type.", "error"); return; }
        for (const r of rows) {
            if (!r.name.trim()) { formMsg("bdSetupMessage", "Give every building type a name.", "error"); return; }
            const n = parseCount(r.building_count);
            if (!Number.isInteger(n) || n < 1) { formMsg("bdSetupMessage", `"${r.name}": Buildings has to be a whole number, 1 or more.`, "error"); return; }
            const units = parseCount(r.units);
            if (Number.isNaN(units) || !Number.isInteger(units)) {
                formMsg("bdSetupMessage", `"${r.name}": Units has to be a whole number, like 24. Leave it blank if the building has no units (a church or an office).`, "error"); return;
            }
            const badSf = [["gbsf", "GBSF"], ["leasable_sf", "Leasable SF"]].find(([f]) => Number.isNaN(parseCount(r[f])));
            if (badSf) {
                formMsg("bdSetupMessage", `"${r.name}": ${badSf[1]} has to be a number, like 12500. Leave it blank if you don't know it.`, "error"); return;
            }
        }
        const kept = new Set(rows.filter(r => r.id).map(r => r.id));
        const removed = areas.filter(a => a.kind === "building" && !kept.has(a.id));
        const withData = removed.filter(a => prices.some(p => p.area_id === a.id) || lines.some(l => l.area_id === a.id));
        if (withData.length && !confirm(`${withData.map(a => a.name).join(", ")} already ${withData.length === 1 ? "has" : "have"} bids or budgets. Removing deletes those too. Remove anyway?`)) return;
        $("bdSetupSaveBtn").disabled = true;
        formMsg("bdSetupMessage", "Saving…");
        try {
            for (const [i, r] of rows.entries()) {
                const patch = { project_id: project.id, kind: "building", name: r.name.trim(), building_count: parseCount(r.building_count), building_numbers: r.building_numbers.trim() || null, units: parseCount(r.units), gbsf: parseCount(r.gbsf), leasable_sf: parseCount(r.leasable_sf), enabled: true, sort_order: i };
                const res = r.id ? await client().from("bid_areas").update(patch).eq("id", r.id).select("id") : await client().from("bid_areas").insert(patch).select("id");
                if (res.error) throw res.error;
                if (!res.data || !res.data.length) throw new Error("You don't have permission to change buildings.");
            }
            if (removed.length) {
                const { error } = await client().from("bid_areas").delete().in("id", removed.map(a => a.id));
                if (error) throw error;
            }
            for (const [i, s] of SECTIONS.entries()) {
                const on = $(`bdSection_${s.kind}`).checked;
                const row = areas.find(a => a.kind === s.kind);
                if (row && (row.enabled !== false) !== on) {
                    const { error } = await client().from("bid_areas").update({ enabled: on }).eq("id", row.id);
                    if (error) throw error;
                } else if (!row && on) {
                    const { error } = await client().from("bid_areas").insert({ project_id: project.id, kind: s.kind, name: s.name, building_count: 1, enabled: true, sort_order: 100 + i });
                    if (error) throw error;
                }
            }
        } catch (err) {
            formMsg("bdSetupMessage", `Couldn't save: ${err && err.message ? err.message : err}`, "error");
            $("bdSetupSaveBtn").disabled = false;
            await load();
            return;
        }
        closeOverlay("bdSetupOverlay");
        toast("Buildings saved");
        await load();
        if (afterSetup) { const fn = afterSetup; afterSetup = null; fn(); }
    }

    /* ---------- new bid package: What + Who ---------- */

    let np = null; // { draftId, codes:Set, areas:Set, vendors: Map(companyId -> contactId), files:Set, step }

    async function openNew(draft) {
        if (!canSend) return;
        if (!areas.length) { openSetup(() => openNew(draft)); return; }
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(CONTACT_STORAGE_KEY) || "null"); } catch (e) { saved = null; }
        const me = profile() || {};
        np = {
            draftId: draft ? draft.id : null,
            codes: new Set(draft && Array.isArray(draft.cost_codes) ? draft.cost_codes : []),
            areas: new Set(draft && Array.isArray(draft.area_ids) ? draft.area_ids : shownAreas().map(a => a.id)),
            vendors: new Map((draft && Array.isArray(draft.draft_vendors) ? draft.draft_vendors : []).map(v => [String(v.company_id), String(v.contact_id || "")])),
            files: new Set((draft ? pkgFiles.get(draft.id) || [] : []).map(f => String(f.id))),
            prepicked: !!draft,
        };
        $("bdNewName").value = draft ? draft.name || "" : "";
        const due = draft && draft.due_at ? new Date(draft.due_at) : null;
        $("bdNewDueDate").value = due ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}` : "";
        $("bdNewDueTime").value = due ? `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}` : "14:00";
        $("bdNewScope").value = draft ? draft.scope || "" : "";
        $("bdNewLocation").value = draft && draft.location ? draft.location : [project.site_address, [project.site_city, project.site_state].filter(Boolean).join(", "), project.site_zip].filter(Boolean).join(" ");
        const walk = draft && draft.walkthrough_at ? new Date(draft.walkthrough_at) : null;
        $("bdNewWalk").value = walk ? toLocalInput(walk) : "";
        $("bdNewWalkLocation").value = draft && draft.walkthrough_location ? draft.walkthrough_location : "Project site";
        $("bdNewQuestions").value = draft && draft.questions_due_at ? toLocalInput(new Date(draft.questions_due_at)) : "";
        $("bdNewContactName").value = (draft && draft.contact_name) || (saved && saved.name) || staffName();
        $("bdNewContactEmail").value = (draft && draft.contact_email) || (saved && saved.email) || me.email || "";
        $("bdNewContactPhone").value = (draft && draft.contact_phone) || (saved && saved.phone) || "";
        $("bdNewRemindNo").checked = draft ? draft.remind_no_response !== false : true;
        $("bdNewRemindDue").checked = draft ? draft.remind_before_due !== false : true;
        $("bdNewCodeSearch").value = "";
        $("bdNewMore").open = false;
        formMsg("bdNewMessage", "");
        renderNewAreas();
        renderNewCodes();
        loadPlanFiles();
        newStep(1);
        openOverlay("bdNewOverlay");
    }

    function toLocalInput(d) {
        const p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function newStep(n) {
        np.step = n;
        document.querySelectorAll("[data-np-step]").forEach(el => { el.hidden = String(el.dataset.npStep) !== String(n); });
        document.querySelectorAll("[data-np-dot]").forEach(el => {
            const i = Number(el.dataset.npDot);
            el.classList.toggle("is-active", i === n);
            el.classList.toggle("is-done", i < n);
        });
        $("bdNewBackBtn").textContent = n === 1 ? "Cancel" : "Back";
        $("bdNewNextBtn").textContent = n === 1 ? "Next: Who" : `Send to ${np.vendors.size} vendor${np.vendors.size === 1 ? "" : "s"}`;
        $("bdNewHelp").href = `/pages/bids-help.html?id=${encodeURIComponent(project.id)}#${n === 1 ? "what" : "who"}`;
    }

    function renderNewAreas() {
        $("bdNewAreas").innerHTML = shownAreas().map(a => `
            <label class="bd-pick ${np.areas.has(a.id) ? "is-on" : ""}"><input type="checkbox" data-np-area="${esc(a.id)}" ${np.areas.has(a.id) ? "checked" : ""}>
            <span>${esc(a.name)}${isSection(a) ? "" : ` × ${esc(a.building_count)}`}</span></label>`).join("")
            + (canManage ? `<button type="button" class="bl-link-btn" data-act="setup-from-new">Edit buildings</button>` : "");
    }

    function renderNewCodes() {
        $("bdNewChips").innerHTML = Array.from(np.codes).sort(codeSort).map(c => `
            <span class="bd-code-chip"><span>${esc(c)}</span>${esc(codeLabel(c))}<button type="button" data-np-remove="${esc(c)}" aria-label="Remove ${esc(codeLabel(c))}">✕</button></span>`).join("");
        const q = $("bdNewCodeSearch").value.trim().toLowerCase();
        const list = $("bdNewCodeList");
        if (!q) { list.innerHTML = ""; list.classList.add("hidden"); return; }
        const hits = codes.filter(c => !np.codes.has(c.code) && !hiddenCodes.has(c.code) && `${c.code} ${c.description} ${c.division_name}`.toLowerCase().includes(q)).slice(0, 12);
        list.classList.remove("hidden");
        list.innerHTML = hits.length
            ? hits.map(c => `<button type="button" class="bd-code-hit" data-np-add="${esc(c.code)}"><span class="bl-code">${esc(c.code)}</span>${esc(c.description)}<span class="bl-soft bl-small">${esc(c.division_name)}</span></button>`).join("")
            : `<p class="bl-soft bl-small" style="margin:8px 10px">No cost codes match.</p>`;
    }

    let planFiles = [];
    async function loadPlanFiles() {
        const { data } = await client().from("project_files").select("id, file_name, category, subfolder, created_at").eq("project_id", project.id).order("created_at", { ascending: false });
        planFiles = data || [];
        renderPlanFiles();
    }
    function renderPlanFiles() {
        const q = ($("bdNewFileSearch").value || "").trim().toLowerCase();
        const shown = planFiles.filter(f => np.files.has(String(f.id)) || !q || String(f.file_name).toLowerCase().includes(q)).slice(0, q ? 40 : 8);
        $("bdNewFiles").innerHTML = shown.length
            ? shown.map(f => `<label class="bd-file-pick"><input type="checkbox" data-np-file="${esc(f.id)}" ${np.files.has(String(f.id)) ? "checked" : ""}><span>${esc(f.file_name)}</span></label>`).join("")
            : `<p class="bl-soft bl-small">${planFiles.length ? "No files match." : "No files in this project yet. Upload plans in Project Files first."}</p>`;
    }

    function validateWhat() {
        if (!$("bdNewName").value.trim()) return "Name the package (e.g. Concrete).";
        if (!np.codes.size) return "Add at least one cost code.";
        if (!np.areas.size) return "Check at least one building.";
        const due = dueIso();
        if (!due) return "Set when bids are due.";
        if (new Date(due) <= new Date()) return "The due date has to be in the future.";
        if (!$("bdNewContactName").value.trim() || !isEmail($("bdNewContactEmail").value)) return "Add the contact's name and email under More options (vendors' questions go there).";
        const walk = $("bdNewWalk").value ? new Date($("bdNewWalk").value) : null;
        if (walk && walk > new Date(due)) return "The walkthrough is after bids are due.";
        return "";
    }

    function dueIso() {
        const d = $("bdNewDueDate").value, t = $("bdNewDueTime").value || "14:00";
        if (!d) return null;
        const dt = new Date(`${d}T${t}`);
        return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
    }

    function packageRow(status) {
        const local = v => (v ? new Date(v).toISOString() : null);
        return {
            project_id: project.id,
            name: $("bdNewName").value.trim(),
            scope: $("bdNewScope").value.trim() || null,
            location: $("bdNewLocation").value.trim() || null,
            due_at: dueIso(),
            walkthrough_at: local($("bdNewWalk").value),
            walkthrough_location: $("bdNewWalk").value ? ($("bdNewWalkLocation").value.trim() || null) : null,
            questions_due_at: local($("bdNewQuestions").value),
            contact_name: $("bdNewContactName").value.trim() || null,
            contact_email: $("bdNewContactEmail").value.trim() || null,
            contact_phone: $("bdNewContactPhone").value.trim() || null,
            remind_no_response: $("bdNewRemindNo").checked,
            remind_before_due: $("bdNewRemindDue").checked,
            cost_codes: Array.from(np.codes),
            area_ids: Array.from(np.areas),
            status,
            draft_vendors: status === "draft" ? Array.from(np.vendors.entries()).map(([company_id, contact_id]) => ({ company_id, contact_id })) : null,
        };
    }

    async function savePackage(status) {
        const row = packageRow(status);
        let id = np.draftId;
        if (id) {
            const { error } = await client().from("bid_packages").update(row).eq("id", id).eq("status", "draft");
            if (error) throw error;
        } else {
            const { data, error } = await client().from("bid_packages").insert({ ...row, created_by_name: staffName() }).select("id").single();
            if (error) throw error;
            id = data.id;
            np.draftId = id;
        }
        const { error: delErr } = await client().from("bid_package_files").delete().eq("package_id", id);
        if (delErr) throw delErr;
        const fileIds = Array.from(np.files);
        if (fileIds.length) {
            const { error } = await client().from("bid_package_files").insert(fileIds.map((f, i) => ({ package_id: id, project_file_id: f, sort_order: i })));
            if (error) throw error;
        }
        return id;
    }

    async function saveDraft() {
        if (!$("bdNewName").value.trim()) { formMsg("bdNewMessage", "Name the package before saving a draft.", "error"); return; }
        formMsg("bdNewMessage", "Saving…");
        try { await savePackage("draft"); } catch (err) { formMsg("bdNewMessage", `Couldn't save: ${err.message || err}`, "error"); return; }
        closeOverlay("bdNewOverlay");
        toast("Draft saved");
        await load();
    }

    // Who: approved vendors; pre-pick the ones that priced these cost codes
    // before (on any project), or were invited to a package with them.
    async function enterWho() {
        $("bdNewWhoList").innerHTML = `<p class="bl-soft">Loading vendors…</p>`;
        const v = await loadVendorData();
        if (!np.prepicked) {
            np.prepicked = true;
            // Vendors tagged with these cost codes (Trade tags like
            // "3002 - Foundations - Turn-Key" are the cost codes, 2026-11-27).
            const tagCode = name => { const m = String(name || "").trim().match(/^"?(\d{3,6})\b/); return m ? m[1] : null; };
            const codeTagIds = new Set(v.tags.filter(t => np.codes.has(tagCode(t.name))).map(t => String(t.id)));
            const taggedCos = new Set(v.companyTags.filter(ct => codeTagIds.has(String(ct.tag_id))).map(ct => String(ct.company_id)));
            const { data: past } = await client().from("bid_invite_prices").select("invite_id").in("cost_code", Array.from(np.codes)).limit(2000);
            const pastInvites = Array.from(new Set((past || []).map(p => p.invite_id)));
            let pastCos = new Set();
            if (pastInvites.length) {
                const { data } = await client().from("bid_invites").select("company_id").in("id", pastInvites.slice(0, 500));
                pastCos = new Set((data || []).map(r => String(r.company_id)));
            }
            const { data: pkgs } = await client().from("bid_packages").select("id").overlaps("cost_codes", Array.from(np.codes)).limit(200);
            if (pkgs && pkgs.length) {
                const { data } = await client().from("bid_invites").select("company_id").in("package_id", pkgs.map(p => p.id));
                (data || []).forEach(r => pastCos.add(String(r.company_id)));
            }
            v.companies.forEach(co => {
                if (!(taggedCos.has(String(co.id)) || pastCos.has(String(co.id))) || missingRequirements(v, co).length) return;
                const c = emailContacts(v, co.id)[0];
                if (c) np.vendors.set(String(co.id), String(c.id));
            });
        }
        renderWho();
    }

    function renderWho() {
        const v = vendorCache;
        const q = $("bdNewVendorSearch").value.trim().toLowerCase();
        const tagId = $("bdNewTrade").value;
        if ($("bdNewTrade").options.length <= 1) {
            $("bdNewTrade").innerHTML = `<option value="">All trades</option>` + v.categories.map(cat => {
                const inCat = v.tags.filter(t => String(t.category_id) === String(cat.id));
                return inCat.length ? `<optgroup label="${esc(cat.name)}">${inCat.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>` : "";
            }).join("");
        }
        const tagged = tagId ? new Set(v.companyTags.filter(t => String(t.tag_id) === String(tagId)).map(t => String(t.company_id))) : null;
        const rows = v.companies.filter(co => {
            if (np.vendors.has(String(co.id))) return true;
            if (tagged && !tagged.has(String(co.id))) return false;
            if (q && !String(co.Name || "").toLowerCase().includes(q)) return false;
            return !!(q || tagged);
        }).sort((a, b) => Number(np.vendors.has(String(b.id))) - Number(np.vendors.has(String(a.id))) || String(a.Name).localeCompare(String(b.Name)));
        $("bdNewWhoCount").textContent = `${np.vendors.size} picked`;
        $("bdNewWhoList").innerHTML = rows.map(co => {
            const miss = missingRequirements(v, co);
            const contacts = emailContacts(v, co.id);
            const on = np.vendors.has(String(co.id));
            const blocked = miss.length || !contacts.length;
            const why = !contacts.length ? "No email contact" : miss.length ? `Not approved: ${miss.join(", ")}` : "Approved";
            const contactSel = on && contacts.length > 1
                ? `<select data-np-contact="${esc(co.id)}" aria-label="Contact for ${esc(co.Name)}">${contacts.map(c => `<option value="${esc(c.id)}" ${String(c.id) === np.vendors.get(String(co.id)) ? "selected" : ""}>${esc(c.Name || c.Email)} · ${esc(c.Email)}</option>`).join("")}</select>`
                : `<span class="bl-soft bl-small">${esc(contacts[0] ? `${contacts[0].Name || ""} · ${contacts[0].Email}` : "")}</span>`;
            return `<label class="bd-who ${blocked ? "is-blocked" : ""}"><input type="checkbox" data-np-vendor="${esc(co.id)}" ${on ? "checked" : ""} ${blocked && !on ? "disabled" : ""}>
                <span class="bd-who-main"><strong>${esc(co.Name)}</strong>${contactSel}</span>
                <span class="bd-chip ${blocked ? "bd-chip--warn" : "bd-chip--done"}">${esc(why)}</span></label>`;
        }).join("") || `<p class="bl-soft">Search for a vendor or pick a trade to add more.</p>`;
        $("bdNewNextBtn").textContent = `Send to ${np.vendors.size} vendor${np.vendors.size === 1 ? "" : "s"}`;
    }

    async function sendNew() {
        if (!np.vendors.size) { formMsg("bdNewMessage", "Pick at least one vendor.", "error"); return; }
        const v = vendorCache;
        const picked = Array.from(np.vendors.entries()).map(([coId, contactId]) => {
            const co = v.companies.find(c => String(c.id) === coId);
            const contact = emailContacts(v, coId).find(c => String(c.id) === contactId) || emailContacts(v, coId)[0];
            return co && contact ? { co, contact } : null;
        }).filter(Boolean);
        $("bdNewNextBtn").disabled = true;
        formMsg("bdNewMessage", "Saving…");
        let pkgId;
        try {
            pkgId = await savePackage("open");
            const { error } = await client().from("bid_invites").insert(picked.map(p => ({
                package_id: pkgId, company_id: p.co.id, company_name: String(p.co.Name || "").trim() || "Vendor",
                contact_name: p.contact.Name || null, contact_email: String(p.contact.Email).trim(),
            })));
            if (error) throw error;
        } catch (err) {
            if (pkgId) await client().from("bid_packages").update({ status: "draft" }).eq("id", pkgId).then(() => {}, () => {});
            formMsg("bdNewMessage", `Couldn't save: ${err.message || err}. Nothing was sent; it's saved as a draft.`, "error");
            $("bdNewNextBtn").disabled = false;
            return;
        }
        try {
            localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify({ name: $("bdNewContactName").value.trim(), email: $("bdNewContactEmail").value.trim(), phone: $("bdNewContactPhone").value.trim() }));
        } catch (e) { /* best effort */ }
        formMsg("bdNewMessage", `Emailing ${picked.length} vendor${picked.length === 1 ? "" : "s"}…`);
        const { data, error } = await callBidFunction({ action: "send", package_id: pkgId });
        $("bdNewNextBtn").disabled = false;
        closeOverlay("bdNewOverlay");
        if (error) toast(`Saved, but the emails didn't go out: ${error}. Use "Send again" on each vendor.`, "error");
        else if (data && data.failed && data.failed.length) toast(`Sent to ${data.sent}; ${data.failed.length} failed (${data.failed.map(f => f.company_name).join(", ")}).`, "error");
        else toast(`Sent to ${picked.length} vendor${picked.length === 1 ? "" : "s"}`);
        await load();
        go(pkgId);
    }

    async function onNewNext() {
        if (np.step === 1) {
            const problem = validateWhat();
            if (problem) { formMsg("bdNewMessage", problem, "error"); if (/contact/.test(problem)) $("bdNewMore").open = true; return; }
            formMsg("bdNewMessage", "");
            newStep(2);
            await enterWho();
            return;
        }
        await sendNew();
    }

    /* ---------- Invite Sheet (2026-11-27) ----------
       One row per cost code (the numbered Trade tags), with the approved
       vendors tagged for it. Check who to invite, set the due date once,
       Send: every code with checked vendors becomes its own bid package
       (one package per code), or the new vendors are added to that code's
       open package. Codes this job doesn't need can be hidden here
       (bid_project_hidden_codes). Checked boxes are kept in this browser
       until they're sent, so the sheet can be filled in over time. */

    const SHEET_KEY = () => `bidInviteSheet:${project.id}`;
    let sheet = null; // { sel: Map(code -> Set(companyId)), extra: Map(code -> Set(companyId)), showHidden }

    function sheetLoad() {
        if (sheet && sheet.projectId === project.id) return sheet;
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(SHEET_KEY()) || "null"); } catch (e) { saved = null; }
        const toMap = o => new Map(Object.entries(o || {}).map(([k, v]) => [k, new Set((v || []).map(String))]));
        sheet = { projectId: project.id, sel: toMap(saved && saved.sel), extra: toMap(saved && saved.extra), showHidden: false, sending: false };
        return sheet;
    }
    function sheetSave() {
        const toObj = m => Object.fromEntries(Array.from(m.entries()).filter(([, v]) => v.size).map(([k, v]) => [k, Array.from(v)]));
        try { localStorage.setItem(SHEET_KEY(), JSON.stringify({ sel: toObj(sheet.sel), extra: toObj(sheet.extra) })); } catch (e) { /* best effort */ }
    }

    const tagCodeOf = name => { const m = String(name || "").trim().match(/^"?(\d{3,6})\b/); return m ? m[1] : null; };

    // The open (or awarded) one-code package for a cost code, if there is one.
    function packageForCode(code) {
        return packages.find(p => p.status !== "closed" && Array.isArray(p.cost_codes) && p.cost_codes.length === 1 && p.cost_codes[0] === code) || null;
    }

    async function renderSheet() {
        const st = sheetLoad();
        $("bdSheetKicker").textContent = `${project.name || "Project"} · Bids`;
        $("bdSheetSetupNote").classList.toggle("hidden", sheetReady);
        if (!$("bdSheetDueDate").value) {
            const d = new Date(); d.setDate(d.getDate() + 14);
            $("bdSheetDueDate").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        }
        if (!$("bdSheetContactEmail").value) {
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(CONTACT_STORAGE_KEY) || "null"); } catch (e) { saved = null; }
            const me = profile() || {};
            $("bdSheetContactName").value = (saved && saved.name) || staffName();
            $("bdSheetContactEmail").value = (saved && saved.email) || me.email || "";
        }
        $("bdSheetTable").innerHTML = `<p class="bl-soft" style="padding:18px">Loading vendors…</p>`;
        const v = await loadVendorData();
        // division filter options (once)
        if ($("bdSheetDivision").options.length <= 1) {
            const divs = [];
            codes.forEach(c => { if (!divs.some(d => d[0] === c.division_code)) divs.push([c.division_code, c.division_name]); });
            $("bdSheetDivision").innerHTML = `<option value="">All divisions</option>` + divs.map(([dc, dn]) => `<option value="${esc(dc)}">${esc(dc)} · ${esc(dn)}</option>`).join("");
        }
        const q = $("bdSheetSearch").value.trim().toLowerCase();
        const div = $("bdSheetDivision").value;
        const onlyPicked = $("bdSheetOnlyPicked").checked;

        // company id -> Set(codes it's tagged with)
        const tagCodes = new Map(v.tags.map(t => [String(t.id), tagCodeOf(t.name)]).filter(([, c]) => c));
        const vendorsByCode = new Map();
        v.companyTags.forEach(ct => {
            const code = tagCodes.get(String(ct.tag_id));
            if (!code) return;
            if (!vendorsByCode.has(code)) vendorsByCode.set(code, new Set());
            vendorsByCode.get(code).add(String(ct.company_id));
        });
        const coById = new Map(v.companies.map(c => [String(c.id), c]));
        const approvedWithEmail = v.companies.filter(co => !missingRequirements(v, co).length && emailContacts(v, co.id).length);

        let rows = codes.slice().sort((a, b) => codeSort(a.code, b.code));
        const hiddenCount = rows.filter(c => hiddenCodes.has(c.code)).length;
        $("bdSheetShowHidden").textContent = st.showHidden ? "Hide hidden codes" : `Show hidden codes${hiddenCount ? ` (${hiddenCount})` : ""}`;
        $("bdSheetShowHidden").classList.toggle("hidden", !hiddenCount && !st.showHidden);
        rows = rows.filter(c => st.showHidden || !hiddenCodes.has(c.code));
        if (div) rows = rows.filter(c => c.division_code === div);
        if (q) rows = rows.filter(c => `${c.code} ${c.description} ${c.division_name}`.toLowerCase().includes(q)
            || Array.from(vendorsByCode.get(c.code) || []).some(id => String(coById.get(id)?.Name || "").toLowerCase().includes(q)));
        if (onlyPicked) rows = rows.filter(c => (st.sel.get(c.code) || new Set()).size);

        let lastDiv = null;
        const html = rows.map(c => {
            const head = c.division_code !== lastDiv ? `<div class="bd-sheet-div">${esc(c.division_code)} · ${esc(c.division_name)}</div>` : "";
            lastDiv = c.division_code;
            const hidden = hiddenCodes.has(c.code);
            const pkg = packageForCode(c.code);
            const invited = new Map((pkg ? pkgInvites(pkg) : []).map(i => [String(i.company_id), i]));
            const sel = st.sel.get(c.code) || new Set();
            const ids = new Set([...(vendorsByCode.get(c.code) || []), ...(st.extra.get(c.code) || []), ...invited.keys()]);
            const chips = Array.from(ids).map(id => coById.get(id)).filter(Boolean)
                .sort((a, b) => String(a.Name).localeCompare(String(b.Name)))
                .map(co => {
                    const id = String(co.id);
                    const inv = invited.get(id);
                    if (inv) return `<span class="bd-sheet-chip is-sent" title="${esc(STATUS[inv.status] || inv.status)}"><span class="bl-check" aria-hidden="true"></span>${esc(co.Name)}<em>${esc(STATUS[inv.status] || inv.status)}</em></span>`;
                    const miss = missingRequirements(v, co);
                    const noEmail = !emailContacts(v, co.id).length;
                    if (miss.length || noEmail) return `<span class="bd-sheet-chip is-blocked" title="${esc(noEmail ? "No contact with an email" : `Not approved: ${miss.join(", ")}`)}">${esc(co.Name)}<em>${noEmail ? "No email" : "Not approved"}</em></span>`;
                    const extra = (st.extra.get(c.code) || new Set()).has(id);
                    return `<label class="bd-sheet-chip ${sel.has(id) ? "is-on" : ""}"><input type="checkbox" data-sheet-pick="${esc(c.code)}" value="${esc(id)}" ${sel.has(id) ? "checked" : ""} ${hidden || st.sending ? "disabled" : ""}>${esc(co.Name)}${extra ? `<button type="button" class="bd-sheet-x" data-sheet-unextra="${esc(c.code)}" data-id="${esc(id)}" aria-label="Remove ${esc(co.Name)}">✕</button>` : ""}</label>`;
                }).join("");
            const addable = approvedWithEmail.filter(co => !ids.has(String(co.id)));
            const add = hidden || st.sending ? "" : `<select class="bd-sheet-add" data-sheet-add="${esc(c.code)}" aria-label="Add a vendor to ${esc(c.code)}"><option value="">+ Add vendor</option>${addable.map(co => `<option value="${esc(co.id)}">${esc(co.Name)}</option>`).join("")}</select>`;
            let status = `<span class="bl-soft">—</span>`;
            if (pkg) {
                const t = packageTotals(pkg);
                status = pkg.status === "draft" ? `<span class="bd-chip bd-chip--warn">Draft</span>`
                    : `<button type="button" class="bl-link-btn" data-sheet-open="${esc(pkg.id)}">${pkg.status === "awarded" ? "Awarded" : `Sent · ${t.bids} of ${t.invited} bids`}</button>`;
            }
            const hideBtn = `<button type="button" class="bl-link-btn bd-sheet-hide" data-sheet-hide="${esc(c.code)}">${hidden ? "Show" : "Hide"}</button>`;
            return `${head}<div class="bd-sheet-row ${hidden ? "is-hidden" : ""}">
                <div class="bd-sheet-code"><span class="bl-code">${esc(c.code)}</span><span>${esc(c.description)}</span>${hidden ? `<em>Hidden on this project</em>` : ""}</div>
                <div class="bd-sheet-vendors">${chips || (hidden ? "" : `<span class="bl-soft bl-small">No vendors tagged with this code.</span>`)}${add}</div>
                <div class="bd-sheet-status">${status}</div>
                <div class="bd-sheet-act">${hideBtn}</div>
            </div>`;
        }).join("");
        $("bdSheetTable").innerHTML = `<div class="bd-sheet-row bd-row--head"><div>Cost code</div><div>Vendors to invite</div><div>Status</div><div></div></div>`
            + (html || `<div class="bl-empty"><p>No cost codes match.</p></div>`);
        sheetCounts();
    }

    function sheetCounts() {
        const st = sheet;
        let codesN = 0, invitesN = 0;
        st.sel.forEach((set, code) => { if (set.size && !hiddenCodes.has(code)) { codesN += 1; invitesN += set.size; } });
        $("bdSheetCount").textContent = invitesN
            ? `${invitesN} invite${invitesN === 1 ? "" : "s"} · ${codesN} cost code${codesN === 1 ? "" : "s"}`
            : "Check vendors to invite";
        $("bdSheetSendBtn").disabled = !invitesN || st.sending;
        $("bdSheetSendBtn").textContent = st.sending ? "Sending…" : `Send ${invitesN || ""} invite${invitesN === 1 ? "" : "s"}`.replace("  ", " ");
        $("bdSheetClearBtn").classList.toggle("hidden", !invitesN || st.sending);
    }

    async function sheetToggleHidden(code) {
        if (!sheetReady) { toast("Run sql/supabase-bid-invite-sheet-setup.sql in Supabase first.", "error"); return; }
        const hide = !hiddenCodes.has(code);
        const res = hide
            ? await client().from("bid_project_hidden_codes").insert({ project_id: project.id, cost_code: code, hidden_by_name: staffName() })
            : await client().from("bid_project_hidden_codes").delete().eq("project_id", project.id).eq("cost_code", code);
        if (res.error) { toast(`Couldn't ${hide ? "hide" : "show"} ${code}: ${res.error.message}`, "error"); return; }
        if (hide) { hiddenCodes.add(code); sheet.sel.delete(code); sheetSave(); } else hiddenCodes.delete(code);
        toast(hide ? `${code} hidden on this project` : `${code} is back on this project`);
        renderSheet();
    }

    async function sheetSend() {
        const st = sheet;
        const v = await loadVendorData();
        const due = (() => { const d = $("bdSheetDueDate").value, t = $("bdSheetDueTime").value || "14:00"; if (!d) return null; const x = new Date(`${d}T${t}`); return Number.isNaN(x.getTime()) ? null : x.toISOString(); })();
        const msg = (text, type) => formMsg("bdSheetMessage", text, type);
        if (!due) { msg("Set when bids are due.", "error"); return; }
        if (new Date(due) <= new Date()) { msg("The due date has to be in the future.", "error"); return; }
        const cName = $("bdSheetContactName").value.trim(), cEmail = $("bdSheetContactEmail").value.trim();
        if (!cName || !isEmail(cEmail)) { msg("Add your name and email (vendors' questions go there).", "error"); return; }
        if (!shownAreas().length) { msg(""); openSetup(() => go(null, { sheet: true })); return; }
        const jobs = Array.from(st.sel.entries()).filter(([code, set]) => set.size && !hiddenCodes.has(code));
        const total = jobs.reduce((n, [, set]) => n + set.size, 0);
        if (!total) return;
        if (!confirm(`Send ${total} invite${total === 1 ? "" : "s"} for ${jobs.length} cost code${jobs.length === 1 ? "" : "s"}? Each vendor gets an email right away.`)) return;
        try { localStorage.setItem(CONTACT_STORAGE_KEY, JSON.stringify({ name: cName, email: cEmail, phone: "" })); } catch (e) { /* fine */ }
        st.sending = true; sheetCounts(); renderSheet();
        const areaIds = shownAreas().map(a => a.id);
        const location = [project.site_address, [project.site_city, project.site_state].filter(Boolean).join(", "), project.site_zip].filter(Boolean).join(" ") || null;
        let sent = 0; const failed = [];
        for (const [i, [code, set]] of jobs.entries()) {
            msg(`Sending ${i + 1} of ${jobs.length}: ${code} ${codeLabel(code)}…`);
            try {
                let pkg = packageForCode(code);
                if (pkg && pkg.status !== "open") pkg = null;
                if (!pkg) {
                    const { data, error } = await client().from("bid_packages").insert({
                        project_id: project.id, name: `${code} ${codeLabel(code)}`, location, due_at: due,
                        contact_name: cName, contact_email: cEmail, remind_no_response: true, remind_before_due: true,
                        cost_codes: [code], area_ids: areaIds, status: "open", created_by_name: staffName(),
                    }).select("*").single();
                    if (error) throw error;
                    pkg = data; packages.unshift(pkg);
                }
                const already = new Set(pkgInvites(pkg).map(x => String(x.company_id)));
                const rows = Array.from(set).filter(id => !already.has(id)).map(id => {
                    const co = v.companies.find(c => String(c.id) === id);
                    const contact = co ? emailContacts(v, co.id)[0] : null;
                    return co && contact ? { package_id: pkg.id, company_id: co.id, company_name: String(co.Name || "").trim() || "Vendor", contact_name: contact.Name || null, contact_email: String(contact.Email).trim() } : null;
                }).filter(Boolean);
                if (rows.length) {
                    const { data: ins, error } = await client().from("bid_invites").insert(rows).select("id");
                    if (error) throw error;
                    const { data, error: sendErr } = await callBidFunction({ action: "send", package_id: pkg.id, invite_ids: (ins || []).map(r => r.id) });
                    if (sendErr) throw new Error(sendErr);
                    sent += (data && data.sent) || rows.length;
                    if (data && data.failed && data.failed.length) data.failed.forEach(f => failed.push(`${f.company_name} (${code})`));
                }
                st.sel.delete(code); st.extra.delete(code); sheetSave();
            } catch (err) {
                failed.push(`${code}: ${err && err.message ? err.message : err}`);
            }
        }
        st.sending = false;
        msg(failed.length ? `Didn't send: ${failed.join("; ")}` : "", failed.length ? "error" : "");
        toast(failed.length ? `Sent ${sent}; ${failed.length} didn't go out.` : `Sent ${sent} invite${sent === 1 ? "" : "s"}`, failed.length ? "error" : "success");
        await load();
    }

    function wireSheet() {
        $("bdSheetBtn").addEventListener("click", () => go(null, { sheet: true }));
        $("bdSheetBackBtn").addEventListener("click", e => { e.preventDefault(); go(null); });
        ["bdSheetSearch", "bdSheetDivision", "bdSheetOnlyPicked"].forEach(id => $(id).addEventListener(id === "bdSheetSearch" ? "input" : "change", () => renderSheet()));
        $("bdSheetShowHidden").addEventListener("click", () => { sheet.showHidden = !sheet.showHidden; renderSheet(); });
        $("bdSheetSendBtn").addEventListener("click", sheetSend);
        $("bdSheetClearBtn").addEventListener("click", () => { if (!confirm("Uncheck every vendor on the sheet?")) return; sheet.sel.clear(); sheetSave(); renderSheet(); });
        $("bdSheetTable").addEventListener("change", e => {
            const t = e.target;
            if (t.dataset.sheetPick) {
                const code = t.dataset.sheetPick;
                if (!sheet.sel.has(code)) sheet.sel.set(code, new Set());
                if (t.checked) sheet.sel.get(code).add(t.value); else sheet.sel.get(code).delete(t.value);
                t.closest(".bd-sheet-chip").classList.toggle("is-on", t.checked);
                sheetSave(); sheetCounts();
            }
            if (t.dataset.sheetAdd && t.value) {
                const code = t.dataset.sheetAdd;
                if (!sheet.extra.has(code)) sheet.extra.set(code, new Set());
                if (!sheet.sel.has(code)) sheet.sel.set(code, new Set());
                sheet.extra.get(code).add(t.value); sheet.sel.get(code).add(t.value);
                sheetSave(); renderSheet();
            }
        });
        $("bdSheetTable").addEventListener("click", e => {
            const hide = e.target.closest("[data-sheet-hide]");
            if (hide) { sheetToggleHidden(hide.dataset.sheetHide); return; }
            const open = e.target.closest("[data-sheet-open]");
            if (open) { go(open.dataset.sheetOpen); return; }
            const x = e.target.closest("[data-sheet-unextra]");
            if (x) {
                e.preventDefault();
                const code = x.dataset.sheetUnextra, id = x.dataset.id;
                sheet.extra.get(code)?.delete(id); sheet.sel.get(code)?.delete(id);
                sheetSave(); renderSheet();
            }
        });
    }

    /* ---------- Export for QuickBooks (Desktop) ---------- */

    let xlsxPromise = null;
    function loadXlsx() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (!xlsxPromise) xlsxPromise = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = XLSX_URL;
            s.onload = () => resolve(window.XLSX);
            s.onerror = () => { xlsxPromise = null; reject(new Error("Couldn't load the Excel library. Check your connection.")); };
            document.head.appendChild(s);
        });
        return xlsxPromise;
    }

    function download(name, blob) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    async function exportQuickBooks() {
        const safe = s => String(s || "").replace(/[\t\r\n"]+/g, " ").trim();
        const fname = String(project.name || "Project").replace(/[\\/:*?"<>|]+/g, "-");
        const stamp = new Date().toISOString().slice(0, 10);
        const v = await loadVendorData();
        const awardedInv = invites.filter(i => i.status === "awarded");
        const vendorIds = Array.from(new Set(awardedInv.map(i => String(i.company_id))));

        // IIF: the project as a job, and every awarded vendor. Tax IDs are
        // left out on purpose; add them in QuickBooks.
        const iif = [
            "!CUST\tNAME\tJOBDESC",
            `CUST\t${safe(project.name)}\t${safe([project.site_address, project.site_city, project.site_state].filter(Boolean).join(", "))}`,
            "!VEND\tNAME\tADDR1\tADDR2\tADDR3\tEMAIL\tPHONE1",
            ...vendorIds.map(id => {
                const co = v.companies.find(c => String(c.id) === id) || {};
                const contact = emailContacts(v, id)[0] || {};
                return `VEND\t${safe(co.Name)}\t${safe(co.Name)}\t${safe(co.Street)}\t${safe([co.City, co.State, co.Zip].filter(Boolean).join(" "))}\t${safe(contact.Email)}\t${safe(contact.MobilePhone || contact.Phone)}`;
            }),
        ].join("\r\n") + "\r\n";
        download(`${fname} - QuickBooks vendors and job - ${stamp}.iif`, new Blob([iif], { type: "text/plain" }));

        let XLSX;
        try { XLSX = await loadXlsx(); } catch (err) { toast(err.message, "error"); return; }
        const wb = XLSX.utils.book_new();
        const budget = [["Cost code", "Description", "Building type", "Buildings", "Budget per building", "Budget total", "Winner", "Winner price per building", "Winner total"]];
        lines.slice().sort((a, b) => codeSort(a.cost_code, b.cost_code)).forEach(l => {
            const a = areas.find(x => x.id === l.area_id);
            if (!a) return;
            const w = l.winner_invite_id ? invites.find(i => i.id === l.winner_invite_id) : null;
            const wp = w ? prices.find(p => p.invite_id === w.id && p.area_id === a.id && p.cost_code === l.cost_code) : null;
            budget.push([l.cost_code, codeLabel(l.cost_code), a.name, mult(a), num(l.budget), l.budget != null ? Number(l.budget) * mult(a) : null, w ? w.company_name : "", wp ? Number(wp.amount) : null, wp ? Number(wp.amount) * mult(a) : null]);
        });
        const contracts = [["Vendor", "Bid package", "Cost codes won", "Contract amount", "Awarded on"]];
        awardedInv.forEach(i => {
            const pkg = packages.find(p => p.id === i.package_id) || {};
            const won = lines.filter(l => l.winner_invite_id === i.id).map(l => l.cost_code);
            contracts.push([i.company_name, pkg.name || "", Array.from(new Set(won)).sort(codeSort).join(", ") || (pkg.cost_codes || []).join(", "), Number(i.awarded_amount ?? i.bid_amount ?? 0), pkg.awarded_at ? String(pkg.awarded_at).slice(0, 10) : ""]);
        });
        const ws1 = XLSX.utils.aoa_to_sheet(budget);
        ws1["!cols"] = [10, 30, 22, 10, 16, 16, 20, 18, 16].map(w => ({ wch: w }));
        const ws2 = XLSX.utils.aoa_to_sheet(contracts);
        ws2["!cols"] = [24, 30, 24, 16, 12].map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws1, "Budgets");
        XLSX.utils.book_append_sheet(wb, ws2, "Contracts");
        XLSX.writeFile(wb, `${fname} - QuickBooks budgets and contracts - ${stamp}.xlsx`);
        toast("Downloaded the IIF (vendors, job) and Excel (budgets, contracts) files");
    }

    /* ---------- wiring ---------- */

    function onClick(e) {
        const el = e.target.closest("[data-act]");
        if (!el) return;
        const act = el.dataset.act;
        if (act === "open") { if (!e.target.closest("select, input")) go(el.dataset.pkg); }
        else if (act === "continue") openNew(packages.find(p => p.id === el.dataset.pkg));
        else if (act === "setup") openSetup();
        else if (act === "setup-from-new") { closeOverlay("bdNewOverlay"); openSetup(() => { renderNewAreas(); openOverlay("bdNewOverlay"); }); }
        else if (act === "budget") editBudget(el.dataset.area, el.dataset.code, el);
        else if (act === "proposal") openFile(files.get(String(el.dataset.file)));
        else if (act === "plan") openFile((pkgFiles.get(openPkgId) || [])[Number(el.dataset.index)]);
        else if (act === "remind") { const inv = invites.find(i => i.id === el.dataset.invite); if (inv) remind([inv.id], inv.company_name); }
        else if (act === "retry") { const inv = invites.find(i => i.id === el.dataset.invite); if (inv) retry(inv); }
        else if (act === "coi") { const inv = invites.find(i => i.id === el.dataset.invite); if (inv) requestCoi(inv); }
        else if (act === "remove-building") { readSetupRows(); setupRows.splice(Number(el.dataset.index), 1); if (!setupRows.length) setupRows.push(blankBuilding()); renderSetupRows(); }
    }

    function wire() {
        document.addEventListener("click", e => {
            if (e.target.closest("#bdListView, #bdPackageView, #bdSetupOverlay, #bdNewOverlay")) onClick(e);
        });
        window.addEventListener("popstate", () => { picks = new Map(); render(); });
        $("bdBackBtn").addEventListener("click", e => { e.preventDefault(); go(null); });
        $("bdMatrix").addEventListener("change", e => {
            const pkg = packages.find(p => p.id === openPkgId);
            if (!pkg) return;
            if (e.target.matches(".bd-winner")) { picks.set(e.target.dataset.key, e.target.value); renderPicks(pkg); }
            if (e.target.name === "bdSingle") { picks.set("single", e.target.value); renderPicks(pkg); }
        });
        $("bdAwardBtn").addEventListener("click", openAward);
        $("bdPicksAwardBtn").addEventListener("click", openAward);
        $("bdAwardForm").addEventListener("submit", confirmAward);
        $("bdAwardCancelBtn").addEventListener("click", () => closeOverlay("bdAwardOverlay"));
        $("bdRemindBtn").addEventListener("click", () => {
            const pkg = packages.find(p => p.id === openPkgId);
            const ids = pkg ? pkgInvites(pkg).filter(i => WAITING.includes(i.status)).map(i => i.id) : [];
            if (ids.length) remind(ids, `${ids.length} vendor${ids.length === 1 ? "" : "s"}`);
        });
        $("bdAddBidBtn").addEventListener("click", openAddBid);
        $("bdBidVendor").addEventListener("change", renderBidLines);
        $("bdBidForm").addEventListener("submit", saveBid);
        $("bdBidCancelBtn").addEventListener("click", () => closeOverlay("bdBidOverlay"));

        $("bdSetupForm").addEventListener("submit", saveSetup);
        $("bdSetupCancelBtn").addEventListener("click", () => { afterSetup = null; closeOverlay("bdSetupOverlay"); });
        $("bdSetupAddBtn").addEventListener("click", () => { readSetupRows(); setupRows.push(blankBuilding()); renderSetupRows(); });

        $("bdNewBtn").addEventListener("click", () => openNew(null));
        $("bdNewBackBtn").addEventListener("click", () => { if (np && np.step === 2) { formMsg("bdNewMessage", ""); newStep(1); } else closeOverlay("bdNewOverlay"); });
        $("bdNewNextBtn").addEventListener("click", onNewNext);
        $("bdNewDraftBtn").addEventListener("click", saveDraft);
        $("bdNewCodeSearch").addEventListener("input", renderNewCodes);
        $("bdNewFileSearch").addEventListener("input", renderPlanFiles);
        $("bdNewVendorSearch").addEventListener("input", renderWho);
        $("bdNewTrade").addEventListener("change", renderWho);
        $("bdNewOverlay").addEventListener("change", e => {
            const t = e.target;
            if (t.dataset.npArea) { if (t.checked) np.areas.add(t.dataset.npArea); else np.areas.delete(t.dataset.npArea); renderNewAreas(); }
            if (t.dataset.npFile) { if (t.checked) np.files.add(t.dataset.npFile); else np.files.delete(t.dataset.npFile); }
            if (t.dataset.npVendor) {
                const v = vendorCache;
                if (t.checked) { const c = emailContacts(v, t.dataset.npVendor)[0]; if (c) np.vendors.set(String(t.dataset.npVendor), String(c.id)); }
                else np.vendors.delete(String(t.dataset.npVendor));
                renderWho();
            }
            if (t.dataset.npContact) np.vendors.set(String(t.dataset.npContact), t.value);
        });
        $("bdNewOverlay").addEventListener("click", e => {
            const add = e.target.closest("[data-np-add]");
            if (add) { np.codes.add(add.dataset.npAdd); $("bdNewCodeSearch").value = ""; renderNewCodes(); $("bdNewCodeSearch").focus(); return; }
            const rm = e.target.closest("[data-np-remove]");
            if (rm) { np.codes.delete(rm.dataset.npRemove); renderNewCodes(); }
        });
        $("bdNewCodeSearch").addEventListener("keydown", e => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const first = $("bdNewCodeList").querySelector("[data-np-add]");
            if (first) first.click();
        });
        $("bdExportBtn").addEventListener("click", exportQuickBooks);
        wireSheet();
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            ["bdAwardOverlay", "bdBidOverlay", "bdSetupOverlay", "bdNewOverlay"].some(id => {
                if ($(id).classList.contains("hidden")) return false;
                closeOverlay(id);
                return true;
            });
        });
        window.addEventListener("coi-template:changed", e => {
            if (project && String(e.detail.projectId) === String(project.id)) coiTemplate = e.detail.template;
        });
    }

    window.addEventListener("project-shell:ready", async e => {
        const detail = e.detail || {};
        if (!detail.project) {
            $("bdLoading").style.display = "none";
            setMessage("Couldn't load this project.", "error");
            return;
        }
        project = detail.project;
        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (err) { /* ignore */ }
        if (window.Permissions) { try { await window.Permissions.initPermissions(); } catch (err) { /* fails open */ } }
        canSend = can(SEND);
        canManage = can(MANAGE);
        if (!canSend && !canManage) {
            $("bdLoading").style.display = "none";
            $("bdNoAccess").style.display = "block";
            return;
        }
        $("bdKicker").textContent = `${project.name || "Project"} · Bids`;
        document.querySelectorAll("[data-help]").forEach(a => {
            a.href = `/pages/bids-help.html?id=${encodeURIComponent(project.id)}${a.dataset.help ? `#${a.dataset.help}` : ""}`;
        });
        load();
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
