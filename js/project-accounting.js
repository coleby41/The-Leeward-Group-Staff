/* ===========================================================
   PROJECT ACCOUNTING (pages/project-accounting.html)

   Home tab: "work in progress" banner for now.
   Invoices tab: every invoice on this project — search, All / Not paid /
   Paid filter, add, click the file name to open the PDF, edit, delete
   (type the full file name; deletes the file too). A table on desktop,
   cards on phones, plus a search bubble above the tab bar on phones.

   Data + the add/edit form live in js/project-invoices.js.
   Edit/delete buttons only show for people the project's invoice setting
   allows (Project Members → "Edit & delete invoices"); the database
   enforces the same rule.
=========================================================== */
(function () {
    "use strict";

    const PI = () => window.ProjectInvoices;

    let project = null;
    let invoices = [];
    let canManage = false;
    let filter = "all";
    let query = "";
    let tab = "home";
    let pendingDelete = null;
    let previewInvoice = null;

    const $ = id => document.getElementById(id);

    function esc(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function isPhone() {
        return window.matchMedia ? window.matchMedia("(max-width: 768px)").matches : window.innerWidth <= 768;
    }

    function setMessage(text, type) {
        const el = $("acctPageMessage");
        if (!el) return;
        el.textContent = text || "";
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = text ? "block" : "none";
    }

    function toast(text, type) {
        if (typeof window.showToast === "function") window.showToast(text, { type: type || "success" });
        else setMessage(text, type);
    }

    /* ---------- tabs ---------- */

    function showTab(name) {
        tab = name === "invoices" ? "invoices" : "home";
        document.querySelectorAll("[data-acct-tab]").forEach(btn => {
            const on = btn.dataset.acctTab === tab;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-selected", String(on));
        });
        $("acctHomePanel").hidden = tab !== "home";
        $("acctInvoicesPanel").hidden = tab !== "invoices";
        document.body.classList.toggle("acct-on-invoices", tab === "invoices");
        const hash = tab === "invoices" ? "#invoices" : "";
        if (window.location.hash !== hash) history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    }

    /* ---------- filtering ---------- */

    function searchText(inv) {
        return [
            inv.vendor_name, inv.invoice_number, PI().formatDate(inv.invoice_date), inv.invoice_date,
            PI().formatMoney(inv.total_due), String(inv.total_due), inv.paid ? "paid" : "not paid unpaid",
            inv.file ? inv.file.file_name : "",
            inv.is_hardware_store ? "hardware store" : "", inv.description || ""
        ].join(" ").toLowerCase();
    }

    function visibleInvoices(q) {
        const words = String(q ?? query).toLowerCase().split(/\s+/).filter(Boolean);
        return invoices.filter(inv => {
            if (filter === "paid" && !inv.paid) return false;
            if (filter === "unpaid" && inv.paid) return false;
            if (!words.length) return true;
            const text = searchText(inv);
            return words.every(w => text.includes(w));
        });
    }

    /* ---------- rendering ---------- */

    const ICONS = {
        pdf: '<span class="acct-pdf-icon" aria-hidden="true"></span>',
        edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
        del: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'
    };

    function statusPill(inv) {
        return `<span class="acct-pill ${inv.paid ? "acct-pill--paid" : "acct-pill--unpaid"}">${inv.paid ? "Paid" : "Not paid"}</span>`;
    }

    function vendorHtml(inv) {
        return `<span class="acct-strong">${esc(inv.vendor_name)}</span>` +
            (inv.is_hardware_store ? ` <span class="acct-tag">Hardware store</span>` : "") +
            (inv.description ? `<span class="acct-desc">${esc(inv.description)}</span>` : "");
    }

    function fileLink(inv) {
        const name = inv.file ? inv.file.file_name : "(file missing)";
        return `<button type="button" class="acct-file-link" data-acct-action="open" data-id="${inv.id}"${inv.file ? "" : " disabled"}>${ICONS.pdf}<span>${esc(name)}</span></button>`;
    }

    function render() {
        $("acctInvoiceCount").textContent = String(invoices.length);
        const list = visibleInvoices();
        $("acctLoading").style.display = "none";
        $("acctEmpty").style.display = invoices.length ? "none" : "block";
        $("acctNoMatch").style.display = invoices.length && !list.length ? "block" : "none";
        $("acctTableWrap").hidden = !list.length;
        document.body.classList.toggle("acct-can-manage", canManage);

        $("acctTableBody").innerHTML = list.map(inv => `
            <tr>
                <td>${fileLink(inv)}</td>
                <td class="acct-vendor-cell">${vendorHtml(inv)}</td>
                <td>${esc(inv.invoice_number)}</td>
                <td>${esc(PI().formatDate(inv.invoice_date))}</td>
                <td class="acct-num acct-strong">${esc(PI().formatMoney(inv.total_due))}</td>
                <td>${statusPill(inv)}</td>
                <td class="acct-actions-col">${canManage ? `
                    <button type="button" class="acct-icon-btn" data-acct-action="edit" data-id="${inv.id}" aria-label="Edit invoice ${esc(inv.invoice_number)}" title="Edit">${ICONS.edit}</button>
                    <button type="button" class="acct-icon-btn acct-icon-btn--danger" data-acct-action="delete" data-id="${inv.id}" aria-label="Delete invoice ${esc(inv.invoice_number)}" title="Delete">${ICONS.del}</button>` : ""}
                </td>
            </tr>`).join("");

        $("acctCards").innerHTML = list.map(inv => `
            <article class="acct-card">
                <div class="acct-card-top">
                    <div class="acct-card-main">
                        <div>${vendorHtml(inv)}</div>
                        <div class="acct-card-sub">#${esc(inv.invoice_number)}${inv.invoice_date ? " · " + esc(PI().formatDate(inv.invoice_date)) : ""}</div>
                    </div>
                    <div class="acct-card-amount">
                        <div class="acct-strong">${esc(PI().formatMoney(inv.total_due))}</div>
                        ${statusPill(inv)}
                    </div>
                </div>
                ${fileLink(inv)}
                ${canManage ? `<div class="acct-card-actions">
                    <button type="button" class="acct-card-btn" data-acct-action="edit" data-id="${inv.id}">${ICONS.edit}Edit</button>
                    <button type="button" class="acct-card-btn acct-card-btn--danger" data-acct-action="delete" data-id="${inv.id}">${ICONS.del}Delete</button>
                </div>` : ""}
            </article>`).join("");

        renderSearchResults();
    }

    /* ---------- open (preview) ---------- */

    async function openInvoiceFile(inv) {
        if (!inv || !inv.file) return;
        // Always in the portal's preview (Coleby: never a new tab), phones too.
        previewInvoice = inv;
        $("acctPreviewTitle").textContent = inv.file.file_name;
        $("acctPreviewBody").innerHTML = '<div class="file-preview-loading">Loading preview…</div>';
        $("acctPreviewOverlay").classList.remove("hidden");
        try {
            const url = await PI().signedUrl(inv, false);
            if (previewInvoice !== inv) return;
            $("acctPreviewBody").innerHTML = `<iframe class="file-preview-frame" src="${esc(url)}" title="${esc(inv.file.file_name)}"></iframe>`;
        } catch (err) {
            if (previewInvoice !== inv) return;
            $("acctPreviewBody").innerHTML = '<div class="file-preview-error">Couldn\'t load a preview for this invoice.</div>';
        }
    }

    function closePreview() {
        $("acctPreviewOverlay").classList.add("hidden");
        $("acctPreviewBody").innerHTML = "";
        previewInvoice = null;
    }

    async function downloadPreview() {
        if (!previewInvoice) return;
        try {
            const url = await PI().signedUrl(previewInvoice, true);
            const a = document.createElement("a");
            a.href = url; a.rel = "noopener";
            document.body.appendChild(a); a.click(); a.remove();
        } catch (err) {
            toast("Couldn't download that invoice.", "error");
        }
    }

    /* ---------- add / edit ---------- */

    function openAdd() {
        PI().openForm({
            project,
            onSaved: (inv) => {
                invoices.unshift(inv);
                render();
                toast(`Invoice ${inv.invoice_number} saved to ${PI().FOLDER_LABEL}.`);
            }
        });
    }

    function openEdit(inv) {
        PI().openForm({
            project,
            invoice: inv,
            onSaved: (updated) => {
                const i = invoices.findIndex(x => x.id === updated.id);
                if (i >= 0) invoices[i] = updated;
                render();
                toast("Invoice updated.");
            }
        });
    }

    /* ---------- delete ---------- */

    function expectedDeleteName(inv) {
        return inv.file ? inv.file.file_name : inv.invoice_number;
    }

    function openDelete(inv) {
        pendingDelete = inv;
        $("acctDeleteTitle").textContent = `Delete invoice ${inv.invoice_number}?`;
        $("acctDeleteName").textContent = expectedDeleteName(inv);
        $("acctDeleteNameInput").value = "";
        $("acctDeleteMessage").textContent = "";
        $("acctDeleteConfirmBtn").disabled = true;
        $("acctDeleteConfirmBtn").textContent = "Delete invoice and file";
        $("acctDeleteOverlay").classList.remove("hidden");
        if (!isPhone()) setTimeout(() => $("acctDeleteNameInput").focus(), 50);
    }

    function closeDelete() {
        $("acctDeleteOverlay").classList.add("hidden");
        pendingDelete = null;
    }

    async function confirmDelete() {
        const inv = pendingDelete;
        if (!inv || $("acctDeleteNameInput").value.trim() !== expectedDeleteName(inv)) return;
        const btn = $("acctDeleteConfirmBtn");
        btn.disabled = true;
        btn.textContent = "Deleting…";
        try {
            await PI().deleteInvoice(inv);
            invoices = invoices.filter(x => x.id !== inv.id);
            closeDelete();
            render();
            toast(`Invoice ${inv.invoice_number} and its file were deleted.`);
        } catch (err) {
            console.error("Delete invoice failed:", err);
            $("acctDeleteMessage").textContent = err && err.message ? err.message : "Couldn't delete. Please try again.";
            btn.textContent = "Delete invoice and file";
            btn.disabled = false;
        }
    }

    /* ---------- phone search bubble ---------- */

    let searchFab = null;
    let searchSheet = null;

    function buildSearch() {
        searchFab = document.createElement("button");
        searchFab.type = "button";
        searchFab.className = "acct-search-fab";
        searchFab.setAttribute("aria-label", "Search invoices");
        searchFab.innerHTML = '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

        searchSheet = document.createElement("div");
        searchSheet.className = "acct-search-overlay";
        searchSheet.innerHTML = `
            <div class="acct-search-scrim" data-acct-action="close-search"></div>
            <section class="acct-search-sheet" role="dialog" aria-modal="true" aria-label="Search invoices">
                <div class="inv-handle"><span></span></div>
                <div class="acct-search-head">
                    <label class="acct-search-field">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
                        <input type="search" id="acctSheetSearchInput" placeholder="Search invoices" aria-label="Search invoices" autocomplete="off">
                    </label>
                    <button type="button" class="acct-search-cancel" data-acct-action="close-search">Cancel</button>
                </div>
                <p class="acct-search-count" id="acctSheetSearchCount"></p>
                <div class="acct-search-results" id="acctSheetSearchResults"></div>
            </section>`;
        document.body.append(searchFab, searchSheet);
        document.body.classList.add("has-acct-search-fab");

        searchFab.addEventListener("click", openSearch);
        searchSheet.addEventListener("click", onClick);
        $("acctSheetSearchInput").addEventListener("input", renderSearchResults);
    }

    function openSearch() {
        document.body.classList.add("acct-search-open");
        renderSearchResults();
        setTimeout(() => $("acctSheetSearchInput").focus(), 60);
    }

    function closeSearch() {
        document.body.classList.remove("acct-search-open");
        $("acctSheetSearchInput")?.blur();
    }

    function renderSearchResults() {
        const input = $("acctSheetSearchInput");
        if (!input) return;
        const q = input.value.trim();
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        const list = invoices.filter(inv => words.every(w => searchText(inv).includes(w)));
        $("acctSheetSearchCount").textContent = q
            ? (list.length === 1 ? "1 invoice" : `${list.length} invoices`)
            : "Search by vendor, invoice #, date, amount or paid status";
        $("acctSheetSearchResults").innerHTML = (q ? list : list.slice(0, 20)).map(inv => `
            <button type="button" class="acct-search-row" data-acct-action="open" data-id="${inv.id}"${inv.file ? "" : " disabled"}>
                <span class="acct-search-row-icon" aria-hidden="true"></span>
                <span class="acct-search-row-text">
                    <strong>${esc(inv.vendor_name)} · ${esc(inv.invoice_number)}</strong>
                    <small>${esc([PI().formatDate(inv.invoice_date), PI().formatMoney(inv.total_due), inv.paid ? "Paid" : "Not paid"].filter(Boolean).join(" · "))}</small>
                </span>
            </button>`).join("") || (q ? `<p class="acct-search-empty">No invoices match “${esc(q)}”.</p>` : "");
    }

    /* ---------- events ---------- */

    function findInvoice(id) {
        return invoices.find(x => String(x.id) === String(id));
    }

    function onClick(e) {
        const btn = e.target.closest("[data-acct-action]");
        if (!btn || btn.disabled) return;
        const action = btn.dataset.acctAction;
        const inv = btn.dataset.id ? findInvoice(btn.dataset.id) : null;
        if (action === "open") { if (searchSheet && searchSheet.contains(btn)) closeSearch(); openInvoiceFile(inv); }
        else if (action === "edit" && inv) openEdit(inv);
        else if (action === "delete" && inv) openDelete(inv);
        else if (action === "close-search") closeSearch();
    }

    function wire() {
        document.querySelectorAll("[data-acct-tab]").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.acctTab)));
        document.querySelectorAll("[data-acct-filter]").forEach(btn => btn.addEventListener("click", () => {
            filter = btn.dataset.acctFilter;
            document.querySelectorAll("[data-acct-filter]").forEach(b => b.classList.toggle("is-on", b === btn));
            render();
        }));
        $("acctSearchInput").addEventListener("input", (e) => { query = e.target.value; render(); });
        $("acctAddInvoiceBtn").addEventListener("click", openAdd);
        $("acctInvoicesPanel").addEventListener("click", onClick);

        $("acctPreviewCloseBtn").addEventListener("click", closePreview);
        $("acctPreviewDownloadBtn").addEventListener("click", downloadPreview);
        $("acctPreviewOverlay").addEventListener("click", (e) => { if (e.target.id === "acctPreviewOverlay") closePreview(); });

        $("acctDeleteCancelBtn").addEventListener("click", closeDelete);
        $("acctDeleteConfirmBtn").addEventListener("click", confirmDelete);
        $("acctDeleteNameInput").addEventListener("input", () => {
            $("acctDeleteConfirmBtn").disabled = !pendingDelete || $("acctDeleteNameInput").value.trim() !== expectedDeleteName(pendingDelete);
        });
        $("acctDeleteNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmDelete(); });

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (!$("acctPreviewOverlay").classList.contains("hidden")) closePreview();
            else if (!$("acctDeleteOverlay").classList.contains("hidden")) closeDelete();
            else if (document.body.classList.contains("acct-search-open")) closeSearch();
        });

        buildSearch();
        showTab(window.location.hash === "#invoices" ? "invoices" : "home");
    }

    async function load() {
        try {
            const [list, manage] = await Promise.all([PI().loadInvoices(project.id), PI().canManage(project.id)]);
            invoices = list;
            canManage = manage;
            render();
        } catch (err) {
            console.error("Couldn't load invoices:", err);
            $("acctLoading").style.display = "none";
            setMessage("Couldn't load invoices. If this is the first time, the invoices SQL setup may not have been run yet.", "error");
        }
    }

    window.addEventListener("project-shell:ready", (e) => {
        const detail = e.detail || {};
        if (!detail.project) {
            $("acctLoading").style.display = "none";
            setMessage("Couldn't load this project.", "error");
            return;
        }
        project = detail.project;
        load();
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
