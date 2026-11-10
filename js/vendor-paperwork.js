/* ===========================================================
   VENDOR PAPERWORK — Project Bid Invites (2026-11-10)

   One row per vendor on the project (awarded bid invites + vendors added
   directly): where they are with the contract, W-9 and COI, and Leeward's
   review. Rules: supabase/functions/_shared/paperwork.ts.

   Review (projects.manage_bid_invites), only once all three are in:
   Approve or Return each item (a return needs a note), plus an optional
   note to the vendor, then "Send to vendor" sends every decision in one
   email (bid-invites "paperwork_decide"). The project unlocks for the
   vendor in the Vendor Portal only when every item is approved.

   API: window.VendorPaperwork.mount(el, { project, canManage, call })
        → { reload() }    call = the page's callBidFunction
=========================================================== */
(function () {
    "use strict";

    const ITEMS = [
        { key: "contract", label: "Contract" },
        { key: "w9", label: "W-9" },
        { key: "coi", label: "COI" },
    ];
    const ITEM_CHIP = {
        missing:   { label: "Not yet",           chip: "chip--muted" },
        waiting:   { label: "Not sent by Leeward", chip: "chip--muted" },
        submitted: { label: "Submitted",         chip: "chip--info" },
        returned:  { label: "Returned",          chip: "chip--danger" },
        exempt:    { label: "Not required",      chip: "chip--muted" },
    };

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }
    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
    }
    function day(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    function openUrl(name, url) {
        if (!url) return;
        window.FilePreview.open({ name, getUrl: async () => url });   // in the portal, never a new tab
    }

    function itemChip(it) {
        if (it.state === "submitted" && it.decision === "approved") return `<span class="chip chip--success">Approved</span>`;
        const c = ITEM_CHIP[it.state] || ITEM_CHIP.missing;
        return `<span class="chip ${c.chip}">${esc(c.label)}</span>`;
    }

    function progress(v) {
        const n = ITEMS.filter(i => ["submitted", "exempt"].includes(v.items[i.key].state)).length;
        if (v.status === "approved") return `<span class="chip chip--success">Approved</span><span class="bid-cell-sub">${esc(day(v.approved_at))}${v.decided_by_name ? ` · ${esc(v.decided_by_name)}` : ""}</span>`;
        if (v.status === "in_review") return `<span class="chip chip--warning">Ready for review</span><span class="bid-cell-sub">All paperwork is in</span>`;
        const returned = ITEMS.some(i => v.items[i.key].state === "returned");
        return `<span class="chip ${returned ? "chip--danger" : "chip--muted"}">${returned ? "Returned to vendor" : "In progress"}</span><span class="bid-cell-sub">${n} of 3 in</span>`;
    }

    function mount(el, opts) {
        const { project, call } = opts;
        const canManage = Boolean(opts.canManage);
        let vendors = null;
        let error = null;
        let target = null;        // vendor under review
        let choice = {};          // key → { decision, note }
        let sending = false;

        function render() {
            el.style.display = "";
            if (error) { el.innerHTML = `<div class="card-header"><h2 class="card-title">Vendor Paperwork</h2></div><p class="auth-message error">${esc(error)}</p>`; return; }
            if (!vendors) { el.innerHTML = `<div class="card-header"><h2 class="card-title">Vendor Paperwork</h2></div><p class="auth-inline-copy">Loading…</p>`; return; }
            if (!vendors.length) { el.style.display = "none"; return; }
            const ready = vendors.filter(v => v.status === "in_review").length;
            el.innerHTML = `
                <div class="card-header"><h2 class="card-title">Vendor Paperwork</h2>${ready ? `<span class="chip chip--warning">${ready} ready for review</span>` : ""}</div>
                <p class="auth-inline-copy" style="margin:0 0 12px">Each awarded vendor's contract, W-9 and COI. Once all three are in, review and approve them — the project opens for the vendor in the Vendor Portal only after every item is approved.</p>
                <div class="table-wrap"><table class="dash-queue-table bid-tracker-table vp-paper-table">
                    <thead><tr><th>Vendor</th>${ITEMS.map(i => `<th>${esc(i.label)}</th>`).join("")}<th>Status</th><th></th></tr></thead>
                    <tbody>${vendors.map(v => `
                        <tr>
                            <td><strong>${esc(v.company_name)}</strong></td>
                            ${ITEMS.map(i => `<td>${itemChip(v.items[i.key])}</td>`).join("")}
                            <td>${progress(v)}</td>
                            <td><div class="bid-row-actions">${v.status === "in_review" && canManage
                                ? `<button type="button" class="auth-button auth-button--sm" data-pw="review" data-co="${esc(v.company_id)}">Review</button>`
                                : `<button type="button" class="workbook-btn" data-pw="review" data-co="${esc(v.company_id)}">View</button>`}</div></td>
                        </tr>`).join("")}</tbody>
                </table></div>`;
        }

        // ---- the review popup ----
        let overlay = null;
        function ensureOverlay() {
            if (overlay) return overlay;
            overlay = document.createElement("div");
            overlay.className = "popup-overlay hidden";
            overlay.id = "paperworkOverlay";
            overlay.innerHTML = `<div class="popup workbook-popup vp-paper-popup" role="dialog" aria-modal="true" aria-labelledby="paperworkTitle"><div id="paperworkBody"></div></div>`;
            document.body.appendChild(overlay);
            overlay.addEventListener("click", onPopupClick);
            overlay.addEventListener("input", e => {
                const t = e.target;
                if (t.dataset.note) { choice[t.dataset.note] = { ...(choice[t.dataset.note] || {}), note: t.value }; updateSend(); }
            });
            document.addEventListener("keydown", e => { if (e.key === "Escape" && !overlay.classList.contains("hidden")) close(); });
            return overlay;
        }
        function close() {
            overlay.classList.add("hidden");
            if (!document.querySelector(".popup-overlay:not(.hidden)")) document.body.classList.remove("popup-active");
            target = null;
        }

        function canDecide(v) { return canManage && v.status === "in_review"; }

        function popupHtml(v) {
            const decide = canDecide(v);
            const row = (i) => {
                const it = v.items[i.key];
                const c = choice[i.key] || {};
                const exempt = it.state === "exempt";
                return `
                    <div class="vp-paper-item">
                        <div class="vp-paper-item__head">
                            <strong>${esc(i.label)}</strong> ${itemChip(it)}
                            ${it.file ? `<span class="bid-cell-sub">${esc(it.file.name)}${it.file.uploaded_at ? ` · ${esc(day(it.file.uploaded_at))}` : ""}</span>` : ""}
                            ${it.file?.url ? `<button type="button" class="workbook-btn" data-pw="view" data-key="${i.key}">View</button>` : ""}
                        </div>
                        ${exempt ? `<p class="bid-cell-sub" style="margin:0">Not required for this vendor — counts as approved.</p>` : ""}
                        ${!exempt && it.state === "returned" && it.note ? `<p class="vp-paper-note">Returned: ${esc(it.note)}</p>` : ""}
                        ${decide && !exempt ? `
                            <div class="vp-paper-choice" role="radiogroup" aria-label="${esc(i.label)}">
                                <button type="button" class="vp-paper-btn ${c.decision === "approved" ? "is-approve" : ""}" data-pw="pick" data-key="${i.key}" data-val="approved" aria-pressed="${c.decision === "approved"}">✓ Approve</button>
                                <button type="button" class="vp-paper-btn ${c.decision === "returned" ? "is-return" : ""}" data-pw="pick" data-key="${i.key}" data-val="returned" aria-pressed="${c.decision === "returned"}">↩ Return</button>
                            </div>
                            ${c.decision === "returned" ? `<label class="auth-field">What needs to change? <span class="bid-required">*</span>
                                <textarea rows="2" maxlength="1000" data-note="${i.key}" placeholder="e.g. Additional insured must list The Leeward Group LLC">${esc(c.note || "")}</textarea></label>` : ""}` : ""}
                    </div>`;
            };
            return `
                <h2 id="paperworkTitle">${decide ? "Review paperwork" : "Paperwork"} — ${esc(v.company_name)}</h2>
                <p class="auth-inline-copy">${esc(project.name || "")}${v.decided_at ? ` · Last decision ${esc(day(v.decided_at))}${v.decided_by_name ? ` by ${esc(v.decided_by_name)}` : ""}` : ""}</p>
                ${decide ? "" : v.status === "approved"
                    ? `<p class="auth-message success">Approved — the project is open for this vendor.</p>`
                    : `<p class="auth-message">${canManage ? "You can review this once the vendor's contract, W-9 and COI are all in." : "Only people with Manage Bid Invites can approve paperwork."}</p>`}
                <div class="vp-paper-items">${ITEMS.map(row).join("")}</div>
                ${decide ? `<label class="auth-field">Note to the vendor (optional)
                    <textarea rows="2" maxlength="2000" data-note="_general" placeholder="Shown in the email and the Vendor Portal">${esc(choice._general?.note || "")}</textarea></label>
                    <p class="bid-cell-sub" style="margin:0">Every decision goes to the vendor in one email. Returned items reopen for them in the Vendor Portal.</p>` : ""}
                <p class="auth-message" id="paperworkMessage" role="status"></p>
                <div class="popup-buttons">
                    <button type="button" class="auth-button auth-button--secondary" data-pw="close">${decide ? "Cancel" : "Close"}</button>
                    ${decide ? `<button type="button" class="auth-button" data-pw="send" id="paperworkSendBtn">Send to vendor</button>` : ""}
                </div>`;
        }

        function draw() { if (target) { overlay.querySelector("#paperworkBody").innerHTML = popupHtml(target); updateSend(); } }

        function missingChoice() {
            for (const i of ITEMS) {
                if (target.items[i.key].state === "exempt") continue;
                const c = choice[i.key] || {};
                if (!c.decision) return `Choose Approve or Return for the ${i.label}.`;
                if (c.decision === "returned" && !String(c.note || "").trim()) return `Add a note for the returned ${i.label}.`;
            }
            return null;
        }
        function updateSend() {
            const btn = overlay?.querySelector("#paperworkSendBtn");
            if (!btn || !target) return;
            const miss = missingChoice();
            const returning = ITEMS.some(i => choice[i.key]?.decision === "returned");
            btn.disabled = Boolean(miss) || sending;
            btn.textContent = sending ? "Sending…" : returning ? "Return to vendor" : "Approve all & send";
            btn.title = miss || "";
        }

        function openReview(v) {
            target = v;
            choice = {};
            // Start from Leeward's last decision for items that haven't changed since.
            ITEMS.forEach(i => { const it = v.items[i.key]; if (it.decision === "approved" && it.state === "submitted") choice[i.key] = { decision: "approved" }; });
            ensureOverlay();
            draw();
            overlay.classList.remove("hidden");
            document.body.classList.add("popup-active");
        }

        async function send() {
            const miss = missingChoice();
            if (miss || sending) return;
            sending = true; updateSend();
            const msg = overlay.querySelector("#paperworkMessage");
            const items = {};
            ITEMS.forEach(i => { if (choice[i.key]) items[i.key] = { decision: choice[i.key].decision, note: choice[i.key].note || "" }; });
            const { data, error: err } = await call({ action: "paperwork_decide", project_id: project.id, company_id: target.company_id, items, note: choice._general?.note || "" });
            sending = false;
            if (err) { msg.textContent = err; msg.className = "auth-message error"; updateSend(); return; }
            const name = target.company_name;
            close();
            const mail = data.no_recipient ? " (no vendor login to email — let them know)" : data.failed?.length ? ` (email didn't send to ${data.failed.join(", ")})` : data.emailed ? " · emailed" : "";
            toast(`${data.approved ? `Approved ${name}'s paperwork` : `Returned paperwork to ${name}`}${mail}`, data.failed?.length || data.no_recipient ? "error" : "success");
            reload();
        }

        function onPopupClick(e) {
            const b = e.target.closest("[data-pw]");
            if (!b || !target) return;
            const act = b.dataset.pw;
            if (act === "close") close();
            else if (act === "view") { const f = target.items[b.dataset.key].file; if (f) openUrl(f.name, f.url); }
            else if (act === "pick") { choice[b.dataset.key] = { ...(choice[b.dataset.key] || {}), decision: b.dataset.val }; draw(); }
            else if (act === "send") send();
        }

        el.addEventListener("click", e => {
            const b = e.target.closest("[data-pw='review']");
            if (!b || !vendors) return;
            const v = vendors.find(x => String(x.company_id) === String(b.dataset.co));
            if (v) openReview(v);
        });

        async function reload() {
            const { data, error: err } = await call({ action: "paperwork", project_id: project.id });
            error = err ? `Couldn't load vendor paperwork: ${err}` : null;
            vendors = err ? vendors : (data.vendors || []);
            render();
            return vendors;
        }
        render();
        reload();
        return { reload };
    }

    window.VendorPaperwork = { mount };
})();
