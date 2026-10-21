/* ===========================================================
   PROJECT BID INVITES (pages/project-bid-invites.html) — beta

   One card per Invitation to Bid sent for this project (bid_packages),
   with a row per vendor (bid_invites):
     Sent → Viewed (opened in the Vendor Portal) → Bidding / Not Bidding →
     Bid Submitted (uploaded in the portal, or logged by staff when a bid
     came in by email instead) → Awarded / Not Selected.

   Actions (projects.manage_bid_invites): Log Bid / Edit Bid, Remind,
   Retry a failed email, Compare Bids, Award. People with only
   vendors.send_bid_invites can see this page but not change anything.
   The database enforces the same (sql/supabase-bid-invites-setup.sql).

   Emails (reminders, award / not-selected) go through the bid-invites
   Edge Function.
=========================================================== */
(function () {
    "use strict";

    const SEND = "vendors.send_bid_invites";
    const MANAGE = "projects.manage_bid_invites";
    const BIDS_CATEGORY = "contracts_procurement";
    const BIDS_SUBFOLDER = "bids";
    const DOCS_BUCKET = "project-documents";

    const STATUS = {
        pending:      { label: "Not Sent",     chip: "chip--muted" },
        failed:       { label: "Send Failed",  chip: "chip--danger" },
        sent:         { label: "Sent",          chip: "chip--muted" },
        viewed:       { label: "Viewed",        chip: "chip--warning" },
        bidding:      { label: "Bidding",       chip: "chip--info" },
        not_bidding:  { label: "Not Bidding",   chip: "chip--muted" },
        bid_received: { label: "Bid Submitted", chip: "chip--success" },
        awarded:      { label: "Awarded",      chip: "chip--success" },
        not_selected: { label: "Not Selected", chip: "chip--muted" },
    };
    const HAS_BID = ["bid_received", "awarded", "not_selected"];
    // Still expected to bid — the ones "Remind Waiting" emails.
    const WAITING = ["sent", "viewed", "bidding"];
    const DECLINE_REASONS = {
        schedule_full: "Schedule is full",
        outside_scope: "Outside our scope",
        too_far: "Project too far",
        other: "Other",
    };

    const $ = id => document.getElementById(id);

    let project = null;
    let packages = [];          // bid_packages rows + .files + .invites
    let canManage = false;
    let canSend = false;
    let logTarget = null;       // { pkg, invite }
    let retryTarget = null;
    let compareTarget = null;   // pkg
    let awardTarget = null;     // { pkg, invite }
    const busy = new Set();     // invite ids with a reminder in flight

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

    function staffId() {
        const p = profile();
        return (p && (p.id || p.uid)) || null;
    }

    function can(key) { return window.Permissions ? window.Permissions.hasPermission(key) : true; }

    function setMessage(text, type) {
        const el = $("bidPageMessage");
        el.textContent = text || "";
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = text ? "block" : "none";
    }

    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
        else setMessage(text, type === "error" ? "error" : "success");
    }

    function money(value) {
        const n = Number(value);
        if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "—";
        return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }

    function dateTime(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
    }

    function shortDate(iso) {
        if (!iso) return "";
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    function todayIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function parseAmount(text) {
        const cleaned = String(text || "").replace(/[$,\s]/g, "");
        if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
        const n = Number(cleaned);
        return n > 0 ? n : null;
    }

    function isEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
    }

    function openOverlay(id) {
        $(id).classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeOverlay(id) {
        $(id).classList.add("hidden");
        if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
    }

    async function callBidFunction(body) {
        try {
            const { data, error } = await client().functions.invoke("bid-invites", { body });
            if (error) {
                let message = error.message || "The bid service didn't respond.";
                try {
                    const payload = error.context && typeof error.context.json === "function" ? await error.context.json() : null;
                    if (payload && payload.error) message = payload.error;
                } catch (e) { /* keep generic */ }
                return { error: message };
            }
            if (data && data.ok === false) return { error: data.error || "Something went wrong." };
            return { data };
        } catch (err) {
            return { error: err && err.message ? err.message : "The bid service didn't respond." };
        }
    }

    async function openFile(file) {
        if (!file || !file.storage_path) return;
        // Open the tab first (pop-up blockers), then point it at the file.
        const tab = window.open("", "_blank");
        const { data, error } = await client().storage.from(file.bucket || DOCS_BUCKET).createSignedUrl(file.storage_path, 60 * 10);
        if (error || !data?.signedUrl) {
            if (tab) tab.close();
            toast(`Couldn't open ${file.file_name}.`, "error");
            return;
        }
        if (tab) tab.location.href = data.signedUrl;
        else window.location.href = data.signedUrl;
    }

    /* ---------- data ---------- */

    async function load() {
        $("bidLoading").style.display = "block";
        const { data: pkgRows, error } = await client()
            .from("bid_packages")
            .select("*")
            .eq("project_id", project.id)
            .order("created_at", { ascending: false });
        if (error) {
            $("bidLoading").style.display = "none";
            setMessage(`Couldn't load bid invites: ${error.message}`, "error");
            return;
        }
        const ids = (pkgRows || []).map(p => p.id);
        let invites = [], fileLinks = [], proposalFiles = [];
        if (ids.length) {
            const [invRes, filesRes] = await Promise.all([
                client().from("bid_invites").select("*").in("package_id", ids).order("company_name", { ascending: true }),
                client().from("bid_package_files").select("package_id, sort_order, project_files(id, file_name, bucket, storage_path)").in("package_id", ids).order("sort_order", { ascending: true }),
            ]);
            if (invRes.error || filesRes.error) {
                $("bidLoading").style.display = "none";
                setMessage(`Couldn't load bid invites: ${(invRes.error || filesRes.error).message}`, "error");
                return;
            }
            invites = invRes.data || [];
            fileLinks = filesRes.data || [];
            const proposalIds = invites.map(i => i.proposal_file_id).filter(Boolean);
            if (proposalIds.length) {
                const { data } = await client().from("project_files").select("id, file_name, bucket, storage_path").in("id", proposalIds);
                proposalFiles = data || [];
            }
        }
        const proposalsById = new Map(proposalFiles.map(f => [String(f.id), f]));
        packages = (pkgRows || []).map(pkg => ({
            ...pkg,
            files: fileLinks.filter(l => l.package_id === pkg.id).map(l => Array.isArray(l.project_files) ? l.project_files[0] : l.project_files).filter(Boolean),
            invites: invites.filter(i => i.package_id === pkg.id).map(i => ({ ...i, proposal: i.proposal_file_id ? proposalsById.get(String(i.proposal_file_id)) || null : null })),
        }));
        $("bidLoading").style.display = "none";
        render();
    }

    /* ---------- render ---------- */

    function activityText(pkg, inv) {
        switch (inv.status) {
            case "pending": return "Not sent yet";
            case "failed": return inv.send_error || "The email didn't send";
            case "sent": return `Sent ${shortDate(inv.sent_at)} · not opened yet${inv.reminder_count ? ` · reminded ${shortDate(inv.last_reminded_at)}` : ""}`;
            case "viewed": return `Opened ${shortDate(inv.viewed_at)}${inv.reminder_count ? ` · reminded ${shortDate(inv.last_reminded_at)}` : ""}`;
            case "bidding": return `Said they're bidding · ${shortDate(inv.responded_at)}${inv.reminder_count ? ` · reminded ${shortDate(inv.last_reminded_at)}` : ""}`;
            case "not_bidding": return [DECLINE_REASONS[inv.decline_reason] || inv.decline_reason || "Not bidding", inv.decline_note].filter(Boolean).join(" — ");
            case "bid_received": return inv.bid_source === "portal"
                ? `Submitted in the Vendor Portal ${shortDate(inv.responded_at || inv.bid_received_on)}`
                : `Logged ${shortDate(inv.bid_received_on || inv.logged_at)}${inv.logged_by_name ? ` by ${inv.logged_by_name}` : ""}`;
            case "awarded": return `Awarded ${shortDate(pkg.awarded_at)}${inv.result_emailed_at ? " · emailed" : ""}${coiText(inv)}`;
            case "not_selected": return `Not selected${inv.result_emailed_at ? " · emailed" : ""}`;
            default: return "";
        }
    }

    // The COI PDF is only asked for once a vendor is awarded the job.
    function coiText(inv) {
        if (inv.coi_received_at) return ` · COI received ${shortDate(inv.coi_received_at)}`;
        if (inv.coi_requested_at) return ` · COI requested ${shortDate(inv.coi_requested_at)}`;
        return "";
    }

    function rowActions(pkg, inv) {
        const out = [];
        const open = pkg.status === "open";
        if (inv.proposal) out.push(`<button type="button" class="workbook-btn" data-act="proposal" data-invite="${esc(inv.id)}">Proposal</button>`);
        if (canManage && open) {
            if (inv.status === "pending" || inv.status === "failed") out.push(`<button type="button" class="workbook-btn" data-act="retry" data-invite="${esc(inv.id)}">Retry</button>`);
            if (WAITING.includes(inv.status)) {
                out.push(`<button type="button" class="workbook-btn" data-act="remind" data-invite="${esc(inv.id)}" ${busy.has(inv.id) ? "disabled" : ""}>${busy.has(inv.id) ? "Sending…" : "Remind"}</button>`);
            }
            if ([...WAITING, "not_bidding"].includes(inv.status)) out.push(`<button type="button" class="workbook-btn" data-act="log" data-invite="${esc(inv.id)}" title="For a bid that came in by email instead of the portal">Log Bid</button>`);
            if (inv.status === "bid_received") out.push(`<button type="button" class="workbook-btn" data-act="log" data-invite="${esc(inv.id)}">Edit Bid</button>`);
        }
        if (canManage && inv.status === "awarded") {
            const label = busy.has(inv.id) ? "Sending…" : inv.coi_requested_at && !inv.coi_received_at ? "Re-send COI Request" : "Request COI";
            out.push(`<button type="button" class="workbook-btn" data-act="request-coi" data-invite="${esc(inv.id)}" ${busy.has(inv.id) ? "disabled" : ""} title="Emails the vendor a link to upload their COI PDF in the Vendor Portal">${label}</button>`);
        }
        return out.join("");
    }

    function packageCard(pkg) {
        const invites = pkg.invites;
        const bids = invites.filter(i => HAS_BID.includes(i.status) && i.bid_amount != null);
        const noResponse = invites.filter(i => WAITING.includes(i.status));
        const pastDue = new Date(pkg.due_at).getTime() < Date.now();
        const winner = invites.find(i => i.id === pkg.awarded_invite_id);

        const statusChip = pkg.status === "awarded"
            ? `<span class="chip chip--success">Awarded</span>`
            : pkg.status === "closed"
                ? `<span class="chip chip--muted">Closed</span>`
                : pastDue ? `<span class="chip chip--warning">Due date passed</span>` : `<span class="chip chip--info">Open</span>`;

        const actions = [];
        if (canManage && pkg.status === "open" && noResponse.length) {
            actions.push(`<button type="button" class="auth-button auth-button--secondary" data-act="remind-all" data-package="${esc(pkg.id)}">Remind Waiting (${noResponse.length})</button>`);
        }
        if (bids.length) {
            actions.push(`<button type="button" class="auth-button" data-act="compare" data-package="${esc(pkg.id)}">Compare Bids (${bids.length})</button>`);
        }

        const meta = [
            pkg.trade_tag_name,
            `Sent ${shortDate(pkg.created_at)}${pkg.created_by_name ? ` by ${pkg.created_by_name}` : ""}`,
            `Questions go to ${pkg.contact_name}`,
            `Due ${dateTime(pkg.due_at)}`,
            pkg.walkthrough_at ? `Walkthrough ${dateTime(pkg.walkthrough_at)}` : null,
            winner ? `Awarded to ${winner.company_name} · ${money(winner.bid_amount)}` : null,
        ].filter(Boolean).map(m => `<span>${esc(m)}</span>`).join("");

        const files = pkg.files.length
            ? `<span>Plans: ${pkg.files.map((f, i) => `<button type="button" class="bid-link-btn" data-act="plan" data-package="${esc(pkg.id)}" data-file-index="${i}">${esc(f.file_name)}</button>`).join(", ")}</span>`
            : "";

        const rows = invites.map(inv => {
            const s = STATUS[inv.status] || { label: inv.status, chip: "chip--muted" };
            return `
                <tr>
                    <td><strong>${esc(inv.company_name)}</strong><span class="bid-cell-sub">${esc([inv.contact_name, inv.contact_email].filter(Boolean).join(" · "))}</span></td>
                    <td><span class="chip ${s.chip}">${esc(s.label)}</span></td>
                    <td class="bid-amount">${HAS_BID.includes(inv.status) ? esc(money(inv.bid_amount)) : "—"}</td>
                    <td>${esc(activityText(pkg, inv))}${inv.bid_notes && HAS_BID.includes(inv.status) ? `<span class="bid-cell-sub">${esc(inv.bid_notes)}</span>` : ""}</td>
                    <td><div class="bid-row-actions">${rowActions(pkg, inv)}</div></td>
                </tr>`;
        }).join("");

        return `
            <div class="card bid-package-card" data-package-card="${esc(pkg.id)}">
                <div class="card-header">
                    <h2 class="card-title">${esc(pkg.name)}</h2>
                    ${statusChip}
                    ${actions.length ? `<div class="card-header-actions">${actions.join("")}</div>` : ""}
                </div>
                <div class="bid-package-meta">${meta}${files}</div>
                ${invites.length ? `
                <div class="table-wrap">
                    <table class="dash-queue-table bid-tracker-table">
                        <thead><tr><th>Vendor</th><th>Status</th><th style="text-align:right;">Bid</th><th>Last activity</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>` : `<div class="empty-state">No vendors on this invite.</div>`}
            </div>`;
    }

    function render() {
        $("bidEmpty").style.display = packages.length ? "none" : "block";
        $("bidPackages").innerHTML = packages.map(packageCard).join("");
    }

    function findInvite(inviteId) {
        for (const pkg of packages) {
            const invite = pkg.invites.find(i => String(i.id) === String(inviteId));
            if (invite) return { pkg, invite };
        }
        return null;
    }

    /* ---------- remind ---------- */

    async function remind(inviteIds, label) {
        inviteIds.forEach(id => busy.add(id));
        render();
        const { data, error } = await callBidFunction({ action: "remind", invite_ids: inviteIds });
        inviteIds.forEach(id => busy.delete(id));
        if (error) {
            toast(`Reminder didn't send: ${error}`, "error");
            render();
            return;
        }
        const failed = data.failed || [];
        if (failed.length) toast(`Sent ${data.sent}; ${failed.length} failed: ${failed.map(f => f.company_name).join(", ")}`, "error");
        else toast(data.sent ? `Reminder sent${label ? ` to ${label}` : ""}` : "Nobody needed a reminder");
        await load();
    }

    async function requestCoi(invite) {
        if (busy.has(invite.id)) return;
        busy.add(invite.id);
        render();
        const { error } = await callBidFunction({ action: "request_coi", invite_id: invite.id });
        busy.delete(invite.id);
        if (error) {
            toast(`COI request didn't send: ${error}`, "error");
            render();
            return;
        }
        toast(`COI requested from ${invite.company_name}`);
        await load();
    }

    /* ---------- log bid ---------- */

    function openLog(pkg, invite) {
        logTarget = { pkg, invite };
        const editing = invite.status === "bid_received";
        $("bidLogTitle").textContent = editing ? "Edit Bid" : "Log Bid";
        $("bidLogSubtitle").textContent = `${invite.company_name} · ${pkg.name}`;
        $("bidLogAmount").value = invite.bid_amount != null ? String(Number(invite.bid_amount)) : "";
        $("bidLogFile").value = "";
        $("bidLogDate").value = invite.bid_received_on || todayIso();
        $("bidLogNotes").value = invite.bid_notes || "";
        $("bidLogExistingFile").textContent = invite.proposal ? `On file: ${invite.proposal.file_name}. Choose a new file only to replace it.` : "";
        $("bidLogMessage").textContent = "";
        $("bidLogSaveBtn").disabled = false;
        openOverlay("bidLogOverlay");
        $("bidLogAmount").focus();
    }

    function proposalFileName(pkg, invite, original) {
        const ext = (String(original || "").match(/\.[a-z0-9]{1,8}$/i) || [".pdf"])[0];
        const clean = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "-").trim();
        return `${clean(project.name)} - ${clean(pkg.name)} - ${clean(invite.company_name)} - Proposal${ext}`;
    }

    async function saveLog(event) {
        event.preventDefault();
        if (!logTarget) return;
        const { pkg, invite } = logTarget;
        const msg = $("bidLogMessage");
        const amount = parseAmount($("bidLogAmount").value);
        if (amount === null) { msg.textContent = "Enter the bid total, like 168900 or 168,900.50."; msg.className = "auth-message error"; return; }
        // The proposal file is optional — it can be added later with Edit Bid.
        const file = $("bidLogFile").files && $("bidLogFile").files[0];

        $("bidLogSaveBtn").disabled = true;
        msg.textContent = "Saving…";
        msg.className = "auth-message";

        let newFile = null;
        try {
            if (file) {
                const name = proposalFileName(pkg, invite, file.name);
                const renamed = new File([file], name, { type: file.type || "application/octet-stream" });
                const path = await window.ProjectFields.uploadFile(project.id, renamed, null, { pathSegments: [BIDS_CATEGORY, BIDS_SUBFOLDER] });
                const { data, error } = await client().from("project_files").insert({
                    project_id: project.id, category: BIDS_CATEGORY, subfolder: BIDS_SUBFOLDER, sub_subfolder: null,
                    bucket: DOCS_BUCKET, storage_path: path, file_name: name, source: "bid", uploaded_by_name: staffName(),
                }).select("id").single();
                if (error) { client().storage.from(DOCS_BUCKET).remove([path]).catch(() => {}); throw error; }
                newFile = { id: data.id, path };
            }

            const changes = {
                status: "bid_received",
                bid_amount: amount,
                bid_received_on: $("bidLogDate").value || todayIso(),
                bid_notes: $("bidLogNotes").value.trim() || null,
                logged_by: staffId(),
                logged_by_name: staffName(),
                logged_at: new Date().toISOString(),
                // A bid the vendor submitted in the portal stays marked as theirs.
                bid_source: invite.bid_source || "staff",
            };
            if (newFile) changes.proposal_file_id = newFile.id;

            const { data: updated, error } = await client().from("bid_invites").update(changes).eq("id", invite.id).select("id");
            if (error || !updated || !updated.length) throw error || new Error("You don't have permission to log bids.");
        } catch (err) {
            if (newFile) {
                await client().from("project_files").delete().eq("id", newFile.id).then(() => {}, () => {});
                client().storage.from(DOCS_BUCKET).remove([newFile.path]).catch(() => {});
            }
            msg.textContent = `Couldn't save: ${err && err.message ? err.message : err}`;
            msg.className = "auth-message error";
            $("bidLogSaveBtn").disabled = false;
            return;
        }

        closeOverlay("bidLogOverlay");
        toast(`Bid logged for ${invite.company_name}`);
        logTarget = null;
        await load();
    }

    /* ---------- retry ---------- */

    function openRetry(pkg, invite) {
        retryTarget = { pkg, invite };
        $("bidRetrySubtitle").textContent = `${invite.company_name} · ${pkg.name}`;
        const errEl = $("bidRetryError");
        errEl.textContent = invite.send_error || "";
        errEl.style.display = invite.send_error ? "block" : "none";
        $("bidRetryEmail").value = invite.contact_email || "";
        $("bidRetryMessage").textContent = "";
        $("bidRetrySendBtn").disabled = false;
        openOverlay("bidRetryOverlay");
    }

    async function sendRetry(event) {
        event.preventDefault();
        if (!retryTarget) return;
        const { pkg, invite } = retryTarget;
        const msg = $("bidRetryMessage");
        const email = $("bidRetryEmail").value.trim();
        if (!isEmail(email)) { msg.textContent = "Enter a valid email address."; msg.className = "auth-message error"; return; }
        $("bidRetrySendBtn").disabled = true;
        msg.textContent = "Sending…";
        msg.className = "auth-message";

        if (email !== invite.contact_email) {
            const { data, error } = await client().from("bid_invites").update({ contact_email: email }).eq("id", invite.id).select("id");
            if (error || !data || !data.length) {
                msg.textContent = `Couldn't update the email: ${error ? error.message : "permission denied"}`;
                msg.className = "auth-message error";
                $("bidRetrySendBtn").disabled = false;
                return;
            }
        }
        const { data, error } = await callBidFunction({ action: "send", package_id: pkg.id, invite_ids: [invite.id] });
        if (error || (data.failed && data.failed.length)) {
            msg.textContent = `Didn't send: ${error || data.failed[0].error}`;
            msg.className = "auth-message error";
            $("bidRetrySendBtn").disabled = false;
            await load();
            return;
        }
        closeOverlay("bidRetryOverlay");
        toast(`Invite sent to ${invite.company_name}`);
        retryTarget = null;
        await load();
    }

    /* ---------- compare + award ---------- */

    function openCompare(pkg) {
        compareTarget = pkg;
        const bids = pkg.invites.filter(i => HAS_BID.includes(i.status) && i.bid_amount != null)
            .sort((a, b) => Number(a.bid_amount) - Number(b.bid_amount));
        const others = pkg.invites.filter(i => !bids.includes(i));
        const low = bids.length ? Number(bids[0].bid_amount) : null;
        const high = bids.length ? Number(bids[bids.length - 1].bid_amount) : null;

        $("bidCompareTitle").textContent = `Compare Bids · ${pkg.name}`;
        $("bidCompareSubtitle").textContent = `${bids.length} bid${bids.length === 1 ? "" : "s"} received of ${pkg.invites.length} invited · due ${dateTime(pkg.due_at)}`;
        $("bidCompareStats").innerHTML = `
            <div class="stat-item"><p class="stat-label">Low bid</p><p class="bid-stat-value">${esc(money(low))}</p></div>
            <div class="stat-item"><p class="stat-label">High bid</p><p class="bid-stat-value">${esc(money(high))}</p></div>
            <div class="stat-item"><p class="stat-label">Spread</p><p class="bid-stat-value">${esc(bids.length > 1 ? money(high - low) : "—")}</p></div>`;

        const canAward = canManage && pkg.status === "open";
        const bidRows = bids.map((inv, i) => {
            const diff = Number(inv.bid_amount) - low;
            const pct = low ? (diff / low) * 100 : 0;
            const isWinner = pkg.awarded_invite_id === inv.id;
            return `
                <tr class="${i === 0 ? "is-low-bid" : ""}">
                    <td><strong>${esc(inv.company_name)}</strong>
                        ${i === 0 ? ` <span class="chip chip--success">Low Bid</span>` : ""}
                        ${isWinner ? ` <span class="chip chip--success">Awarded</span>` : ""}
                        ${inv.bid_notes ? `<span class="bid-cell-sub">${esc(inv.bid_notes)}</span>` : ""}</td>
                    <td class="bid-amount">${esc(money(inv.bid_amount))}</td>
                    <td class="bid-amount">${i === 0 ? "—" : `+${esc(money(diff))} (${pct.toFixed(1)}%)`}</td>
                    <td>${inv.proposal ? `<button type="button" class="bid-link-btn" data-act="proposal" data-invite="${esc(inv.id)}">View</button>` : `<span class="bid-cell-sub">No file</span>`}</td>
                    <td>${canAward ? `<button type="button" class="auth-button auth-button--sm ${i === 0 ? "" : "auth-button--secondary"}" data-act="award" data-invite="${esc(inv.id)}">Award</button>` : ""}</td>
                </tr>`;
        }).join("");
        const otherRows = others.map(inv => {
            const s = STATUS[inv.status] || { label: inv.status, chip: "chip--muted" };
            return `<tr><td>${esc(inv.company_name)}</td><td class="bid-amount"><span class="chip ${s.chip}">${esc(s.label)}</span></td><td class="bid-amount">—</td><td>—</td><td></td></tr>`;
        }).join("");
        $("bidCompareBody").innerHTML = bidRows + otherRows;
        openOverlay("bidCompareOverlay");
    }

    function openAward(pkg, invite) {
        awardTarget = { pkg, invite };
        const others = pkg.invites.filter(i => i.id !== invite.id && i.status === "bid_received");
        $("bidAwardTitle").textContent = `Award ${pkg.name}?`;
        $("bidAwardSubtitle").textContent = `${invite.company_name} · ${money(invite.bid_amount)}`;
        $("bidAwardNotifyWinner").checked = true;
        $("bidAwardNotifyWinnerLabel").textContent = `Email ${invite.company_name} an award notice`;
        $("bidAwardNotifyOthers").checked = others.length > 0;
        $("bidAwardNotifyOthersRow").classList.toggle("hidden", !others.length);
        $("bidAwardNotifyOthersLabel").textContent = `Email the other ${others.length === 1 ? "bidder" : `${others.length} bidders`} a "not selected" note (${others.map(o => o.company_name).join(", ")})`;
        $("bidAwardMessage").textContent = "";
        $("bidAwardConfirmBtn").disabled = false;
        closeOverlay("bidCompareOverlay");
        openOverlay("bidAwardOverlay");
    }

    async function confirmAward(event) {
        event.preventDefault();
        if (!awardTarget) return;
        const { pkg, invite } = awardTarget;
        const msg = $("bidAwardMessage");
        $("bidAwardConfirmBtn").disabled = true;
        msg.textContent = "Awarding…";
        msg.className = "auth-message";
        const { data, error } = await callBidFunction({
            action: "award",
            package_id: pkg.id,
            invite_id: invite.id,
            notify_winner: $("bidAwardNotifyWinner").checked,
            notify_others: $("bidAwardNotifyOthers").checked,
        });
        if (error) {
            msg.textContent = `Couldn't award: ${error}`;
            msg.className = "auth-message error";
            $("bidAwardConfirmBtn").disabled = false;
            return;
        }
        closeOverlay("bidAwardOverlay");
        const failed = data.failed || [];
        if (failed.length) toast(`Awarded to ${invite.company_name}, but ${failed.length} email${failed.length === 1 ? "" : "s"} didn't send (${failed.map(f => f.company_name).join(", ")}).`, "error");
        else toast(`Awarded to ${invite.company_name}${data.emailed ? ` · ${data.emailed} email${data.emailed === 1 ? "" : "s"} sent` : ""}${data.coi_requested ? " · COI requested" : ""}`);
        awardTarget = null;
        await load();
    }

    /* ---------- wiring ---------- */

    function onClick(event) {
        const btn = event.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "compare" || act === "remind-all" || act === "plan") {
            const pkg = packages.find(p => String(p.id) === String(btn.dataset.package));
            if (!pkg) return;
            if (act === "compare") openCompare(pkg);
            else if (act === "plan") openFile(pkg.files[Number(btn.dataset.fileIndex)]);
            else {
                const ids = pkg.invites.filter(i => WAITING.includes(i.status)).map(i => i.id);
                if (ids.length) remind(ids, `${ids.length} vendor${ids.length === 1 ? "" : "s"}`);
            }
            return;
        }
        const found = findInvite(btn.dataset.invite);
        if (!found) return;
        if (act === "proposal") openFile(found.invite.proposal);
        else if (act === "log") openLog(found.pkg, found.invite);
        else if (act === "retry") openRetry(found.pkg, found.invite);
        else if (act === "remind") remind([found.invite.id], found.invite.company_name);
        else if (act === "award") openAward(found.pkg, found.invite);
        else if (act === "request-coi") requestCoi(found.invite);
    }

    function wire() {
        document.addEventListener("click", event => {
            if (event.target.closest("#bidPackages, #bidCompareOverlay")) onClick(event);
        });
        $("bidLogForm").addEventListener("submit", saveLog);
        $("bidLogCancelBtn").addEventListener("click", () => closeOverlay("bidLogOverlay"));
        $("bidLogCancelBtn2").addEventListener("click", () => closeOverlay("bidLogOverlay"));
        $("bidRetryForm").addEventListener("submit", sendRetry);
        $("bidRetryCancelBtn").addEventListener("click", () => closeOverlay("bidRetryOverlay"));
        $("bidCompareCloseBtn").addEventListener("click", () => closeOverlay("bidCompareOverlay"));
        $("bidAwardForm").addEventListener("submit", confirmAward);
        $("bidAwardCancelBtn").addEventListener("click", () => closeOverlay("bidAwardOverlay"));
        $("bidAwardBackBtn").addEventListener("click", () => {
            closeOverlay("bidAwardOverlay");
            if (compareTarget) openCompare(compareTarget);
        });
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            ["bidAwardOverlay", "bidLogOverlay", "bidRetryOverlay", "bidCompareOverlay"].forEach(id => {
                if (!$(id).classList.contains("hidden")) closeOverlay(id);
            });
        });
    }

    window.addEventListener("project-shell:ready", async (e) => {
        const detail = e.detail || {};
        if (!detail.project) {
            $("bidLoading").style.display = "none";
            setMessage("Couldn't load this project.", "error");
            return;
        }
        project = detail.project;

        try { await (window.supabaseInitialProfilePromise || Promise.resolve()); } catch (err) { /* ignore */ }
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch (err) { /* fails open */ }
        }
        canSend = can(SEND);
        canManage = can(MANAGE);
        if (!canSend && !canManage) {
            $("bidLoading").style.display = "none";
            $("bidNoAccess").style.display = "block";
            return;
        }
        if (canSend) {
            const btn = $("bidNewInviteBtn");
            btn.href = `/pages/vendors.html?invite=1&project=${encodeURIComponent(project.id)}`;
            btn.classList.remove("hidden");
        }
        load();
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
