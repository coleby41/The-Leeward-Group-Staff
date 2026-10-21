/* ===========================================================
   FORM LOGS (project-form-logs.html)

   Per-project log of every VPO, Back Charge, and approved Incident Report
   — three tables (ID | Vendor | Date | Comment | Amount), VPO/BC also
   getting an "IR ID" column linking back to the source incident report
   (Coleby: "link the ID of the IR and make it a collum on both the BC and
   the VPO" — not on the IR table itself, its own ID column already IS
   that id) and an Actions column with a Delete button (IR deletion
   already lives on Account Activity — this page doesn't duplicate it).
   Clicking an ID (either column) opens that row's filed document (a
   signed URL into the project-documents bucket), when one exists; rows
   that haven't been filed yet (e.g. a BC/VPO whose template-fill step
   failed — see the graceful-degradation handling in confirmBc()/
   confirmVpo() in js/account-activity.js) show a plain, unlinked "not
   filed yet" id instead of a dead link.

   Waits for the "project-shell:ready" event (project-shell.js) to know
   which project we're on, then owns everything below the header/sidebar.

   Tables read: vpos, back_charges, incident_reports (status = 'approved'
   only — an IR only becomes a real, filed document once it's approved),
   all filtered to this project. project_files is looked up afterward, in
   one batched query, to resolve each row's project_file_id into an
   openable document.

   Deleting a BC/VPO (delete_bc_with_cleanup / delete_vpo_with_cleanup RPCs,
   see sql/supabase-bc-vpo-setup.sql section 10) reclaims its number — the
   next one created takes its place, same convention as
   delete_incident_report_with_cleanup()/reclaim_incident_report_number()
   for incident reports — but ONLY when the deleted row held the current
   top of its project's (and, for VPO, its building's) counter; deleting
   from the middle of the sequence still just leaves a gap, same tradeoff
   IR numbering already makes.
=========================================================== */

(function () {
    "use strict";

    const VPO_TABLE = "vpos";
    const BC_TABLE = "back_charges";
    const IR_TABLE = "incident_reports";
    const PROJECT_FILES_TABLE = "project_files";

    // Coleby: only show the 4 newest per card, with a "Show All" popup for
    // the rest — same cap/popup shape as Account Activity's Form
    // Submissions section (AA_FORMS_SHOWN there).
    const FORM_LOGS_SHOWN = 4;

    // Which RPC deletes each kind — see sql/supabase-bc-vpo-setup.sql
    // section 10. No entry for "Ir" on purpose: IR deletion lives on
    // Account Activity (deleteReport() in js/account-activity.js), not here.
    const DELETE_RPC = { Vpo: "delete_vpo_with_cleanup", Bc: "delete_bc_with_cleanup" };
    const KIND_LABEL = { Vpo: "VPO", Bc: "Back Charge" };

    // Which kinds get an "IR ID" column linking back to the source
    // incident report — VPO/BC only (both snapshot incident_report_id at
    // creation, see sql/supabase-bc-vpo-setup.sql sections 3/5). Not "Ir"
    // itself — its own ID column already IS the IR's id, a second column
    // would just repeat it.
    const HAS_IR_LINK = { Vpo: true, Bc: true };

    // Filed BC/VPO/IR documents always land in project-documents (never
    // form-submissions) — see js/bc-vpo-docs.js's fileFilledDocument() and
    // the incident report filing flow in js/account-activity.js. Still
    // read file.bucket off the row rather than hardcoding it, same as
    // js/project-files.js does, in case that ever changes.
    const PROJECT_DOCS_BUCKET = "project-documents";

    let currentProject = null;
    let projectFilesById = {}; // { [project_files.id]: { storage_path, bucket, file_name } }
    let incidentReportsById = {}; // { [incident_reports.id]: { ir_number, project_file_id } } -- for the VPO/BC "IR ID" column
    let shellSourceIdByIrId = {}; // { [incident_reports.id]: vpo_number/bc_number } -- the migrated VPO/BC's own old-form id, keyed by its shell IR's id. Lets the Ir table itself show the same "IR-... Legacy" pill treatment as the VPO/BC table's "IR ID" column, for a shell IR that has no real ir_number of its own (see buildRowData()'s "Ir" branch).
    let rowsByKindId = { Vpo: {}, Bc: {} }; // [kind][row.id] -> full row, for the delete handler
    let allRowsByKind = { Vpo: [], Bc: [], Ir: [] }; // the FULL row set per kind (not just the 4 shown) -- feeds the card total and the Show All popup
    let openPopupKind = null; // which kind's Show All popup is currently open, if any -- so a delete made from inside it can refresh the popup itself, not just the card underneath

    function formLogsCan(permissionKey) {
        return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
    }

    // Same permission that gates deleting a filed incident report — BC/VPO
    // are downstream of that same approval workflow, so this reuses the key
    // rather than introducing a new one that would need its own catalog
    // entry and workgroup grants (see claude/permissions-system-implementation.md).
    function canDeleteFormLogs() {
        return formLogsCan("incident_reports.delete_filed_report");
    }

    /* ---------- helpers ---------- */

    function escapeHtmlFormLogs(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function truncateFormLogText(text, max) {
        if (!text) return "";
        return text.length > max ? `${text.slice(0, max).trim()}…` : text;
    }

    // richTextToPlainText/formatIncidentReportCurrency/formatIncidentReportDate
    // come from js/incident-report-pdf.js (loaded before this file on
    // project-form-logs.html) — defensive fallbacks here in case that
    // script fails to load, so this page degrades instead of throwing.
    function formLogsPlainText(html) {
        if (window.IncidentReportPdf?.richTextToPlainText) return window.IncidentReportPdf.richTextToPlainText(html);
        return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    function formLogsFormatDate(dateStr) {
        if (window.IncidentReportPdf?.formatIncidentReportDate) return window.IncidentReportPdf.formatIncidentReportDate(dateStr);
        return dateStr || "—";
    }

    function formLogsFormatCurrency(value) {
        if (window.IncidentReportPdf?.formatIncidentReportCurrency) return window.IncidentReportPdf.formatIncidentReportCurrency(value);
        if (value === null || value === undefined || value === "") return "—";
        const num = Number(value);
        return Number.isNaN(num) ? "—" : `$${num.toFixed(2)}`;
    }

    function setFormLogsPageMessage(text, type) {
        const el = document.getElementById("formLogsPageMessage");
        if (!el) return;
        if (!text) { el.style.display = "none"; return; }
        el.textContent = text;
        el.className = `workbook-page-message ${type || ""}`.trim();
        el.style.display = "block";
    }

    /* ---------- opening a filed document ---------- */

    async function openFiledDocument(fileId) {
        const file = projectFilesById[fileId];
        if (!file) return;

        const { data, error } = await window.supabaseClient
            .storage
            .from(file.bucket || PROJECT_DOCS_BUCKET)
            // Save under the clean file_name (e.g. "VPO - VPO-HC-1-7-56.docx"),
            // not the storage path's "<timestamp>-..." name -- same as Project Files' Download.
            .createSignedUrl(file.storage_path, 60 * 5, file.file_name ? { download: file.file_name } : undefined);

        if (error || !data?.signedUrl) {
            console.error("Failed to create signed URL for filed document:", error);
            setFormLogsPageMessage("Couldn't open that document. Please try again.", "error");
            return;
        }

        // Signed with download → the browser saves it; no new tab.
        window.FilePreview.download(data.signedUrl, file.file_name);
    }

    /* ---------- deleting a BC/VPO ---------- */

    // Removes the filed document's actual Storage object first (the RPC
    // can only clean up the DB rows — Postgres itself can't reach Storage),
    // then calls delete_bc_with_cleanup/delete_vpo_with_cleanup, whose
    // AFTER DELETE trigger reclaims the BC/VPO number if this row held the
    // current top of its project's (and, for VPO, its building's) counter
    // — see sql/supabase-bc-vpo-setup.sql section 10. Same shape as
    // deleteReport() in js/account-activity.js.
    //
    // Coleby: "i delated all of the BC and the VPO why was the IR not
    // delated as well" -- the RPC used to only ever touch the VPO/BC's own
    // row + its own filed PDF, leaving a "Submit Old Forms" shell IR
    // orphaned behind it every time. The RPC now also cascade-deletes that
    // shell IR server-side (see delete_vpo_with_cleanup/
    // delete_bc_with_cleanup in sql/supabase-bc-vpo-setup.sql -- it only
    // ever does this for a row it marked is_legacy_migration = true at
    // creation, and only once nothing else still references it, so a real
    // IR is never touched), but it still can't reach Storage either -- so
    // it hands back the shell's own filed summary PDF's bucket/path (if it
    // had one and it just got deleted) for us to remove here, the same way
    // as the VPO/BC's own file above.
    async function deleteFormLogRow(kind, rowId, btnEl) {
        const rpcName = DELETE_RPC[kind];
        if (!rpcName || !canDeleteFormLogs()) return;

        const row = rowsByKindId[kind]?.[rowId];
        const label = KIND_LABEL[kind] || "record";
        if (!window.confirm(`Delete this ${label}? This can't be undone.`)) return;

        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Deleting…"; }
        try {
            const filedFile = row?.project_file_id ? projectFilesById[row.project_file_id] : null;
            if (filedFile) {
                const bucket = filedFile.bucket || PROJECT_DOCS_BUCKET;
                await window.supabaseClient.storage.from(bucket).remove([filedFile.storage_path]);
            }
            const { data: cleanupResult, error } = await window.supabaseClient.rpc(rpcName, { p_id: rowId });
            if (error) throw error;

            const shellCleanup = Array.isArray(cleanupResult) ? cleanupResult[0] : cleanupResult;
            if (shellCleanup?.deleted_shell_ir_storage_path) {
                await window.supabaseClient.storage
                    .from(shellCleanup.deleted_shell_ir_bucket || PROJECT_DOCS_BUCKET)
                    .remove([shellCleanup.deleted_shell_ir_storage_path]);
            }

            if (currentProject?.id) await loadFormLogsData(currentProject.id);
        } catch (error) {
            console.error(`Failed to delete ${label}:`, error);
            setFormLogsPageMessage(error.message || `Something went wrong deleting this ${label}. Please try again.`, "error");
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Delete"; }
        }
    }

    /* ---------- row -> table cell markup ---------- */

    function idCellHtml(idText, projectFileId) {
        const label = escapeHtmlFormLogs(idText || "—");
        if (projectFileId && projectFilesById[projectFileId]) {
            return `<span class="form-log-id-link" data-file-id="${projectFileId}" role="button" tabindex="0">${label}</span>`;
        }
        return `<span class="form-log-id-unfiled" title="Not filed into Project Files yet">${label}</span>`;
    }

    // The VPO/BC's own old-form ID (e.g. "VPO-906-1-1-6") re-shown as an IR
    // id for this column (Coleby: "make the link say the IR ID not the VPO
    // ID") -- same identifying number, just the "VPO-"/"BC-" prefix swapped
    // for "IR-" since there's no real ir_number to show here and the raw
    // vpo_number/bc_number would read oddly under an "IR ID" header.
    function legacyIrLabelFor(ownIdText) {
        if (!ownIdText) return "";
        return ownIdText.replace(/^(VPO|BC)-/, "IR-");
    }

    // Same click/unfiled behavior as idCellHtml(), but for the IR ID
    // column on a migrated ("Legacy") row: instead of just the word
    // "Legacy" alone, shows the id (see legacyIrLabelFor() above) followed
    // by a small "Legacy" pill (Coleby: "add a pill that says Legacy and
    // add back the id name", then "flip the id and the button" -- id
    // first, pill after) so the row still reads as a specific record
    // rather than a bare, context-free label.
    function legacyIrCellHtml(projectFileId, ownIdText) {
        const pill = `<span class="form-log-legacy-pill">Legacy</span>`;
        const label = escapeHtmlFormLogs(legacyIrLabelFor(ownIdText) || "—");
        const inner = `${label} ${pill}`;
        if (projectFileId && projectFilesById[projectFileId]) {
            return `<span class="form-log-id-link" data-file-id="${projectFileId}" role="button" tabindex="0">${inner}</span>`;
        }
        return `<span class="form-log-id-unfiled" title="Not filed into Project Files yet">${inner}</span>`;
    }

    function actionsCellHtml(kind, rowId) {
        if (!DELETE_RPC[kind]) return ""; // Ir has no Actions column at all — see below
        if (!canDeleteFormLogs()) return `<td></td>`;
        return `<td><button type="button" class="workbook-btn workbook-btn--danger form-log-delete-btn" data-kind="${kind}" data-id="${escapeHtmlFormLogs(rowId)}">Delete</button></td>`;
    }

    // includeActions defaults true and is shared by the main card tables
    // AND the Show All popup — the popup now mirrors the card exactly
    // (Coleby: "make the new popup to have everything in the table"), so
    // there's no longer a reason for it to pass false here. actionsCellHtml()
    // still omits the column entirely for "Ir", which has none either way.
    // irNumber/irProjectFileId are only ever set for Vpo/Bc (see
    // buildRowData()) — the IR ID column itself is gated by HAS_IR_LINK, so
    // passing them for "Ir" would just be ignored.
    function rowHtml({ kind, id, idText, projectFileId, vendor, date, comment, amount, irNumber, irProjectFileId, irIsLegacy, isLegacyShell, legacyOwnIdText, includeActions = true }) {
        return `
            <tr>
                <td>${isLegacyShell ? legacyIrCellHtml(projectFileId, legacyOwnIdText) : idCellHtml(idText, projectFileId)}</td>
                ${HAS_IR_LINK[kind] ? `<td>${irIsLegacy ? legacyIrCellHtml(irProjectFileId, idText) : idCellHtml(irNumber, irProjectFileId)}</td>` : ""}
                <td>${escapeHtmlFormLogs(vendor || "—")}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatDate(date))}</td>
                <td title="${escapeHtmlFormLogs(comment || "")}">${escapeHtmlFormLogs(truncateFormLogText(comment || "—", 90))}</td>
                <td>${escapeHtmlFormLogs(formLogsFormatCurrency(amount))}</td>
                ${includeActions ? actionsCellHtml(kind, id) : ""}
            </tr>
        `;
    }

    function vendorForBc(row) {
        const parts = [];
        if (row.vendor_to_charge_name) parts.push(`Charge: ${row.vendor_to_charge_name}`);
        if (row.vendor_to_cr_back_name) parts.push(`Credit: ${row.vendor_to_cr_back_name}`);
        return parts.join(" · ");
    }

    // A "Submit Old Forms" migrated record's shell incident_reports row
    // (see createLegacyVpoFromRow() below) deliberately has no real
    // ir_number -- it never goes through live IR numbering. It DOES get its
    // own generated Incident Report summary PDF filed against it (same
    // createLegacyVpoFromRow()), so this column can link to the actual IR
    // form itself rather than pointing back at the VPO's own old-form PDF a
    // second time (Coleby: "it needs to link the IR form not the VPO
    // twice"). Detected purely by "resolves to an incident report but that
    // report has no ir_number" -- true for both this VPO path and, once a
    // BC one exists, that path too. irIsLegacy tells rowHtml() to render
    // legacyIrCellHtml() instead of idCellHtml() -- a "Legacy" pill next to
    // the VPO/BC's own old-form ID (Coleby: "add a pill that says Legacy
    // and add back the id name"), rather than just the bare word "Legacy"
    // with no other context. A pre-existing migrated row from before this
    // fix (no summary PDF ever filed against its shell IR) still gets the
    // pill+id treatment, just in idCellHtml()'s own "not filed yet"
    // unlinked state, same as any other IR whose filing failed.
    function irLinkFieldsFor(row, irRow) {
        if (!irRow) return { irNumber: undefined, irProjectFileId: undefined, irIsLegacy: false };
        return { irNumber: irRow.ir_number || "Legacy", irProjectFileId: irRow.project_file_id, irIsLegacy: !irRow.ir_number };
    }

    // Shared by the main card render and the Show All popup, so both
    // always agree on how a raw vpos/back_charges/incident_reports row
    // turns into a table row — this used to be inlined in
    // renderFormLogSection()'s own .map() only.
    function buildRowData(kind, row) {
        if (kind === "Vpo") {
            const irRow = incidentReportsById[row.incident_report_id];
            const { irNumber, irProjectFileId, irIsLegacy } = irLinkFieldsFor(row, irRow);
            return {
                kind, id: row.id,
                idText: row.vpo_number,
                projectFileId: row.project_file_id,
                vendor: row.vendor_name,
                date: row.report_date,
                comment: formLogsPlainText(row.reason_for_report),
                amount: row.price,
                irNumber,
                irProjectFileId,
                irIsLegacy,
            };
        }
        if (kind === "Bc") {
            const irRow = incidentReportsById[row.incident_report_id];
            const { irNumber, irProjectFileId, irIsLegacy } = irLinkFieldsFor(row, irRow);
            return {
                kind, id: row.id,
                idText: row.bc_number,
                projectFileId: row.project_file_id,
                vendor: vendorForBc(row),
                date: row.report_date,
                comment: formLogsPlainText(row.reason_for_report),
                amount: row.price,
                irNumber,
                irIsLegacy,
                irProjectFileId,
            };
        }
        // Ir — no delete column on this page (see header comment). A
        // migrated shell (no real ir_number) gets the "IR-... Legacy" pill
        // treatment via isLegacyShell/legacyOwnIdText, same as it already
        // gets in the VPO/BC table's own "IR ID" column -- see
        // shellSourceIdByIrId above and rowHtml() below.
        return {
            kind, id: row.id,
            idText: row.ir_number,
            projectFileId: row.project_file_id,
            vendor: row.who_caused_issue,
            date: row.report_date,
            comment: formLogsPlainText(row.reason_for_report),
            amount: row.price,
            isLegacyShell: !row.ir_number,
            legacyOwnIdText: shellSourceIdByIrId[row.id],
        };
    }

    /* ---------- rendering ---------- */

    function renderFormLogSection(kind, rows) {
        const loadingEl = document.getElementById(`formLogs${kind}Loading`);
        const emptyEl = document.getElementById(`formLogs${kind}Empty`);
        const wrapEl = document.getElementById(`formLogs${kind}TableWrap`);
        const bodyEl = document.getElementById(`formLogs${kind}Body`);
        const totalEl = document.getElementById(`formLogs${kind}Total`);
        const showAllWrapEl = document.getElementById(`formLogs${kind}ShowAllWrap`);
        const showAllBtnEl = document.getElementById(`formLogs${kind}ShowAllBtn`);
        if (loadingEl) loadingEl.style.display = "none";
        if (!bodyEl || !wrapEl || !emptyEl) return;

        allRowsByKind[kind] = rows;

        if (!rows.length) {
            wrapEl.style.display = "none";
            emptyEl.style.display = "block";
            bodyEl.innerHTML = "";
            if (totalEl) totalEl.textContent = "";
            if (showAllWrapEl) showAllWrapEl.classList.add("hidden");
            // Deleting the last row of a kind while its popup is open should
            // still clear the popup out to "0 records", not leave it showing
            // the row that was just deleted.
            if (openPopupKind === kind) renderShowAllPopupRows(kind);
            return;
        }

        emptyEl.style.display = "none";
        wrapEl.style.display = "block";

        // Total always reflects every record in the table, not just the 4
        // shown below it — Coleby: "on the top right of the title of the
        // card can we display ... the total". All three kinds keep their
        // dollar amount in the same `price` column.
        const total = rows.reduce((sum, row) => sum + (Number(row.price) || 0), 0);
        if (totalEl) totalEl.textContent = `Total: ${formLogsFormatCurrency(total)}`;

        if (kind === "Vpo" || kind === "Bc") {
            rowsByKindId[kind] = {};
            rows.forEach(row => { rowsByKindId[kind][row.id] = row; });
        }

        const visibleRows = rows.slice(0, FORM_LOGS_SHOWN);
        bodyEl.innerHTML = visibleRows.map(row => rowHtml(buildRowData(kind, row))).join("");

        if (showAllWrapEl && showAllBtnEl) {
            if (rows.length > FORM_LOGS_SHOWN) {
                showAllBtnEl.textContent = `Show All (${rows.length})`;
                showAllWrapEl.classList.remove("hidden");
            } else {
                showAllWrapEl.classList.add("hidden");
            }
        }

        bodyEl.querySelectorAll(".form-log-delete-btn").forEach(el => {
            el.addEventListener("click", () => deleteFormLogRow(el.dataset.kind, el.dataset.id, el));
        });

        bodyEl.querySelectorAll(".form-log-id-link").forEach(el => {
            el.addEventListener("click", () => openFiledDocument(el.dataset.fileId));
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFiledDocument(el.dataset.fileId); }
            });
        });

        // If this kind's Show All popup is open right now, keep it in sync
        // too — otherwise a delete made from inside the popup (see
        // renderShowAllPopupRows()) would leave the popup showing a stale
        // row for the record that was just removed.
        if (openPopupKind === kind) renderShowAllPopupRows(kind);
    }

    /* ---------- "Show All" popup ---------- */

    const SHOW_ALL_TITLE = { Vpo: "VPO", Bc: "Back Charge", Ir: "Incident Report" };

    // Rebuilds just the popup's header row (Actions column only for
    // VPO/BC, same as the card — see actionsCellHtml()) and body rows.
    // Split out from openShowAllPopup() so a delete made from inside the
    // popup, or a refresh of the underlying data, can re-run this without
    // re-opening/re-animating the popup itself.
    function renderShowAllPopupRows(kind) {
        const rows = allRowsByKind[kind] || [];

        const subtitleEl = document.getElementById("formLogsShowAllSubtitle");
        if (subtitleEl) subtitleEl.textContent = `${rows.length} record${rows.length === 1 ? "" : "s"}`;

        const headRowEl = document.getElementById("formLogsShowAllHeadRow");
        if (headRowEl) {
            headRowEl.innerHTML = `<th>ID</th>${HAS_IR_LINK[kind] ? "<th>IR ID</th>" : ""}<th>Vendor</th><th>Date</th><th>Comment</th><th>Amount</th>${DELETE_RPC[kind] ? "<th>Actions</th>" : ""}`;
        }

        const bodyEl = document.getElementById("formLogsShowAllBody");
        if (!bodyEl) return;

        bodyEl.innerHTML = rows.map(row => rowHtml(buildRowData(kind, row))).join("");

        bodyEl.querySelectorAll(".form-log-delete-btn").forEach(el => {
            el.addEventListener("click", () => deleteFormLogRow(el.dataset.kind, el.dataset.id, el));
        });
        bodyEl.querySelectorAll(".form-log-id-link").forEach(el => {
            el.addEventListener("click", () => openFiledDocument(el.dataset.fileId));
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFiledDocument(el.dataset.fileId); }
            });
        });
    }

    function openShowAllPopup(kind) {
        openPopupKind = kind;

        const titleEl = document.getElementById("formLogsShowAllTitle");
        if (titleEl) titleEl.textContent = `${SHOW_ALL_TITLE[kind] || kind} — all records`;

        renderShowAllPopupRows(kind);

        document.getElementById("formLogsShowAllOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeShowAllPopup() {
        openPopupKind = null;
        document.getElementById("formLogsShowAllOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    function showFormLogsLoadFailure() {
        ["Vpo", "Bc", "Ir"].forEach(kind => {
            const loadingEl = document.getElementById(`formLogs${kind}Loading`);
            if (loadingEl) loadingEl.style.display = "none";
        });
        setFormLogsPageMessage("Couldn't load this project's form logs. Please try again.", "error");
    }

    /* ---------- loading ---------- */

    async function loadProjectFilesFor(fileIds) {
        projectFilesById = {};
        const uniqueIds = [...new Set(fileIds.filter(Boolean))];
        if (!uniqueIds.length) return;

        const { data, error } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .select("id, storage_path, bucket, file_name")
            .in("id", uniqueIds);

        if (error) {
            console.error("Failed to load filed documents:", error);
            return; // rows without a resolvable file just render as "not filed yet"
        }

        (data || []).forEach(file => { projectFilesById[file.id] = file; });
    }

    // Batch-resolves each VPO/BC row's source incident report (ir_number +
    // its own project_file_id, so the new "IR ID" column can both label
    // and link) — same one-query-for-everyone-on-screen shape as
    // loadProjectFilesFor() above, keyed by incident_reports.id.
    async function loadIncidentReportsFor(incidentReportIds) {
        incidentReportsById = {};
        const uniqueIds = [...new Set(incidentReportIds.filter(Boolean))];
        if (!uniqueIds.length) return;

        const { data, error } = await window.supabaseClient
            .from(IR_TABLE)
            .select("id, ir_number, project_file_id")
            .in("id", uniqueIds);

        if (error) {
            console.error("Failed to load linked incident reports:", error);
            return; // rows without a resolvable IR just render a blank IR ID column
        }

        (data || []).forEach(ir => { incidentReportsById[ir.id] = ir; });
    }

    // Pulls the trailing integer off a formatted ID string -- "BC-TP-014" ->
    // 14, "IR-TP-003" -> 3. Used to sort BC/IR by their actual ID number
    // rather than by created_at/report_date (Coleby: "it needs to be by ID
    // Number"). Rows with no number yet (shouldn't normally happen -- both
    // are only ever created already-numbered) sort to the very end rather
    // than breaking the sort.
    function trailingIdNumber(idText) {
        const match = /(\d+)\s*$/.exec(idText || "");
        return match ? parseInt(match[1], 10) : -Infinity;
    }

    // Descending by ID number, newest/highest first (Coleby's answer:
    // "Newest first (highest number on top)") -- same feel as the previous
    // newest-first ordering, just keyed off the number itself so it can't
    // drift out of sync with creation order.
    function sortByIdNumberDesc(rows, numberOf) {
        return [...rows].sort((a, b) => numberOf(b) - numberOf(a));
    }

    async function loadFormLogsData(projectId) {
        const [vpoResult, bcResult, irResult] = await Promise.all([
            window.supabaseClient
                .from(VPO_TABLE)
                .select("*")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(BC_TABLE)
                .select("*")
                .eq("project_id", projectId),
            window.supabaseClient
                .from(IR_TABLE)
                .select("*")
                .eq("project_id", projectId)
                .eq("status", "approved"),
        ]);

        if (vpoResult.error || bcResult.error || irResult.error) {
            console.error("Failed to load project form logs:", vpoResult.error || bcResult.error || irResult.error);
            showFormLogsLoadFailure();
            return;
        }

        // Sorted here (client-side) rather than via .order() in the queries
        // above, since VPO's ID number isn't a single column to order by --
        // "VPO-TP-3-1-7"'s meaningful sequence number is the trailing
        // project_total_at_creation, stored separately as a real integer
        // (see sql/supabase-bc-vpo-setup.sql section 4/5) -- while BC/IR's
        // number has to be parsed out of their text bc_number/ir_number.
        const vpoRows = sortByIdNumberDesc(vpoResult.data || [], r => r.project_total_at_creation ?? trailingIdNumber(r.vpo_number)); // imported VPOs have no stored total -- read it off the id
        const bcRows = sortByIdNumberDesc(bcResult.data || [], r => trailingIdNumber(r.bc_number));
        const irRows = sortByIdNumberDesc(irResult.data || [], r => trailingIdNumber(r.ir_number));

        // Reverse index: shell IR id -> the VPO/BC's own old-form id, so
        // the Ir table's own row for a migrated shell (no real ir_number)
        // can show the same "IR-... Legacy" pill the VPO/BC table's "IR
        // ID" column shows for it, instead of a bare "—" (Coleby: "the IR
        // chart is not showing the new IR ID's anymore").
        shellSourceIdByIrId = {};
        vpoRows.forEach(r => { if (r.incident_report_id) shellSourceIdByIrId[r.incident_report_id] = r.vpo_number; });
        bcRows.forEach(r => { if (r.incident_report_id) shellSourceIdByIrId[r.incident_report_id] = r.bc_number; });

        // Resolve each VPO/BC's source IR first, so its project_file_id
        // (needed to make the new "IR ID" column clickable) can be folded
        // into the same batched project_files lookup below.
        const incidentReportIds = [
            ...vpoRows.map(r => r.incident_report_id),
            ...bcRows.map(r => r.incident_report_id),
        ];
        await loadIncidentReportsFor(incidentReportIds);

        const fileIds = [
            ...vpoRows.map(r => r.project_file_id),
            ...bcRows.map(r => r.project_file_id),
            ...irRows.map(r => r.project_file_id),
            ...Object.values(incidentReportsById).map(ir => ir.project_file_id),
        ];
        await loadProjectFilesFor(fileIds);

        renderFormLogSection("Vpo", vpoRows);
        renderFormLogSection("Bc", bcRows);
        renderFormLogSection("Ir", irRows);
    }

    /* ---------- static wiring (elements exist at parse time — script tag is at the bottom of the page) ---------- */

    ["Vpo", "Bc", "Ir"].forEach(kind => {
        document.getElementById(`formLogs${kind}ShowAllBtn`)?.addEventListener("click", () => openShowAllPopup(kind));
    });
    document.getElementById("formLogsShowAllCloseBtn")?.addEventListener("click", closeShowAllPopup);
    document.getElementById("formLogsShowAllOverlay")?.addEventListener("click", (event) => {
        if (event.target.id === "formLogsShowAllOverlay") closeShowAllPopup();
    });

    /* ---------- "Submit Old Forms" (legacy migration entry point) ----------
       Button + amber "Legacy Feature" pill on the hero (see
       project-form-logs.html) -- opens a warning popup before going any
       further, since this is a temporary tool for backfilling old BC/VPO
       records that'll get phased out once that's done. "Go Back" and the
       backdrop both just close the popup and leave you on Form Logs, same
       convention as the Show All popup right above. "Continue" opens the
       batch upload/review popup below. */
    function openLegacyWarningPopup() {
        document.getElementById("formLogsLegacyWarningOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeLegacyWarningPopup() {
        document.getElementById("formLogsLegacyWarningOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    document.getElementById("formLogsSubmitOldFormsBtn")?.addEventListener("click", openLegacyWarningPopup);
    document.getElementById("formLogsLegacyGoBackBtn")?.addEventListener("click", closeLegacyWarningPopup);
    document.getElementById("formLogsLegacyWarningOverlay")?.addEventListener("click", (event) => {
        if (event.target.id === "formLogsLegacyWarningOverlay") closeLegacyWarningPopup();
    });

    /* ---------- "Submit Old Forms" batch upload + review popup ----------
       Opens when Continue is clicked above. Each selected PDF is read
       client-side by js/legacy-forms-import.js (pdf.js under the hood --
       no AI, no server call, per Coleby: "is there any JS scrip we can
       make? there is no handwriten its all pdf"); the results land in an
       editable review table (Coleby: batch upload, not one at a time, with
       a chance to review before anything's actually created) rather than
       creating records straight off the parse. Kind (BC/VPO) comes from
       the id text embedded in the PDF itself -- nobody picks it per file.

       Row lifecycle: ready -> creating -> created, or -> failed (and back
       to creating if Create All is clicked again, which only retries
       ready/needs-review/failed rows and leaves already-created ones
       alone). Unreadable files show up as "error" and are never offered
       to Create All.

       A VPO or BC row missing a field just means that field renders blank
       in its input (Coleby: "if there is no info for that input put N/A")
       -- createLegacyVpoFromRow()/createLegacyBcFromRow() below are what
       actually substitute "N/A" (or a sane default for a non-text column)
       at creation time, so the review table always shows exactly what was
       found/typed, blank or not. */

    let legacyBatchRows = []; // in-memory only -- rebuilt fresh every time the popup's (re)opened, never persisted
    let legacyBatchRowSeq = 0;

    function resetLegacyBatchState() {
        legacyBatchRows = [];
        const bodyEl = document.getElementById("formLogsLegacyBatchBody");
        if (bodyEl) bodyEl.innerHTML = "";
        const wrapEl = document.getElementById("formLogsLegacyBatchTableWrap");
        if (wrapEl) wrapEl.style.display = "none";
        const messageEl = document.getElementById("formLogsLegacyBatchMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
        const fileInput = document.getElementById("formLogsLegacyFileInput");
        if (fileInput) fileInput.value = "";
        const createAllBtn = document.getElementById("formLogsLegacyCreateAllBtn");
        if (createAllBtn) { createAllBtn.disabled = true; createAllBtn.textContent = "Create All"; }
        const parseBtn = document.getElementById("formLogsLegacyParseBtn");
        if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = "Read Files"; }
    }

    function openLegacyBatchPopup() {
        closeLegacyWarningPopup();
        resetLegacyBatchState();
        document.getElementById("formLogsLegacyBatchOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeLegacyBatchPopup() {
        document.getElementById("formLogsLegacyBatchOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    // Loose "does this look like the same project" check for the PDF's own
    // "Project Name:" text vs. the project Form Logs is currently showing
    // -- normalizes both down to bare lowercase words so punctuation/"The"/
    // spacing differences don't false-positive, then checks either reads as
    // a substring of the other. Missing data on either side isn't flagged
    // (nothing to compare), just an actual apparent mismatch is.
    function normalizeForCompare(str) {
        return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    function legacyProjectNameLooksMismatched(guess) {
        const guessNorm = normalizeForCompare(guess);
        const projectNorm = normalizeForCompare(currentProject?.name);
        if (!guessNorm || !projectNorm) return false;
        return !guessNorm.includes(projectNorm) && !projectNorm.includes(guessNorm);
    }

    // Turns one js/legacy-forms-import.js parse result into this table's
    // row state. Doesn't touch the network/DOM -- just classifies.
    function buildLegacyBatchRow(result) {
        const rowKey = `legacyRow${legacyBatchRowSeq++}`;

        if (result.error || !result.kind) {
            return { rowKey, file: result.file, fileName: result.fileName, kind: null, status: "error", statusMessage: result.error || "Couldn't read this PDF." };
        }
        if (result.kind === "bc") {
            return { rowKey, file: result.file, fileName: result.fileName, kind: "bc", oldId: result.oldId || "", status: "unsupported", statusMessage: "BC parsing isn't built yet" };
        }

        const mismatch = legacyProjectNameLooksMismatched(result.projectNameGuess);
        const missingCore = !result.vendorName || result.price === null || result.price === undefined || !result.reportDate;
        const notes = [];
        if (mismatch) notes.push(`PDF says "${result.projectNameGuess}" — check this belongs to this project`);
        if (missingCore) notes.push("some fields weren't found, check the blanks");

        return {
            rowKey,
            file: result.file,
            fileName: result.fileName,
            kind: "vpo",
            oldId: result.oldId || "",
            vendorName: result.vendorName || "",
            reportDate: result.reportDate || "",
            buildings: result.buildings || "",
            reasonForReport: result.reasonForReport || "",
            price: result.price ?? null,
            status: (mismatch || missingCore) ? "needs-review" : "ready",
            statusMessage: notes.join(" · "),
        };
    }

    function legacyBatchStatusLabel(row) {
        switch (row.status) {
            case "ready": return "Ready";
            case "needs-review": return row.statusMessage ? `Needs review — ${row.statusMessage}` : "Needs review";
            case "unsupported": return row.statusMessage || "Not supported yet";
            case "error": return row.statusMessage || "Couldn't read this PDF";
            case "creating": return "Creating…";
            case "created": return "Created ✓";
            case "failed": return `Failed — ${row.statusMessage || "please try again"}`;
            default: return "";
        }
    }

    function legacyBatchFieldInputHtml(row, field, type) {
        const value = row[field];
        const displayValue = value === null || value === undefined ? "" : value;
        const disabled = row.status === "creating" || row.status === "created";
        return `<input type="${type}" class="legacy-batch-field-input" data-row-key="${row.rowKey}" data-field="${field}" value="${escapeHtmlFormLogs(displayValue)}" ${type === "number" ? 'step="0.01"' : ""} ${disabled ? "disabled" : ""}>`;
    }

    function legacyBatchRowHtml(row) {
        const kindLabel = row.kind === "vpo" ? "VPO" : row.kind === "bc" ? "BC" : "—";
        const statusHtml = `<span class="legacy-batch-row-status legacy-batch-row-status--${row.status}">${escapeHtmlFormLogs(legacyBatchStatusLabel(row))}</span>`;
        const fileCell = `<td title="${escapeHtmlFormLogs(row.fileName)}">${escapeHtmlFormLogs(truncateFormLogText(row.fileName, 28))}</td>`;

        if (row.kind !== "vpo" && row.kind !== "bc") {
            // Unreadable files -- nothing to edit or create, just show why.
            return `
                <tr data-row-key="${row.rowKey}">
                    ${fileCell}
                    <td>${kindLabel}</td>
                    <td>${escapeHtmlFormLogs(row.oldId || "—")}</td>
                    <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                    <td>${statusHtml}</td>
                </tr>
            `;
        }

        // BC has two vendor columns (charge / CR back); VPO only has one, so
        // its "Vendor to Credit" cell is just a dash -- nothing to fill in.
        const vendorCell = row.kind === "bc"
            ? legacyBatchFieldInputHtml(row, "vendorToChargeName", "text")
            : legacyBatchFieldInputHtml(row, "vendorName", "text");
        const vendorCreditCell = row.kind === "bc"
            ? legacyBatchFieldInputHtml(row, "vendorToCrBackName", "text")
            : "—";

        return `
            <tr data-row-key="${row.rowKey}">
                ${fileCell}
                <td>${kindLabel}</td>
                <td>${escapeHtmlFormLogs(row.oldId || "—")}</td>
                <td>${vendorCell}</td>
                <td>${vendorCreditCell}</td>
                <td>${legacyBatchFieldInputHtml(row, "reportDate", "date")}</td>
                <td>${legacyBatchFieldInputHtml(row, "buildings", "text")}</td>
                <td>${legacyBatchFieldInputHtml(row, "reasonForReport", "text")}</td>
                <td>${legacyBatchFieldInputHtml(row, "price", "number")}</td>
                <td>${statusHtml}</td>
            </tr>
        `;
    }

    // A row is offered to Create All if it's a VPO or BC that hasn't already
    // been created -- "failed" is included on purpose, so clicking Create
    // All again after a partial failure retries just the rows that didn't
    // make it, without touching the ones that already succeeded.
    function legacyRowIsCreatable(row) {
        return (row.kind === "vpo" || row.kind === "bc") && row.status !== "created" && row.status !== "creating";
    }

    function updateLegacyCreateAllButton() {
        const btn = document.getElementById("formLogsLegacyCreateAllBtn");
        if (!btn) return;
        if (btn.textContent === "Create All") btn.disabled = !legacyBatchRows.some(legacyRowIsCreatable);
    }

    function renderLegacyBatchRows() {
        const bodyEl = document.getElementById("formLogsLegacyBatchBody");
        const wrapEl = document.getElementById("formLogsLegacyBatchTableWrap");
        if (!bodyEl) return;

        bodyEl.innerHTML = legacyBatchRows.map(legacyBatchRowHtml).join("");
        if (wrapEl) wrapEl.style.display = legacyBatchRows.length ? "block" : "none";

        // Edits flow straight back into the row model as the user types, so
        // Create All always reads whatever's actually in the table, not the
        // original parsed guess.
        bodyEl.querySelectorAll(".legacy-batch-field-input").forEach(input => {
            input.addEventListener("input", () => {
                const row = legacyBatchRows.find(r => r.rowKey === input.dataset.rowKey);
                if (!row) return;
                const field = input.dataset.field;
                row[field] = field === "price" ? (input.value === "" ? null : Number(input.value)) : input.value;
            });
        });

        updateLegacyCreateAllButton();
    }

    // Patches just one row's Status cell (and locks its inputs once it
    // starts creating) instead of re-rendering the whole table -- Create
    // All runs the rows one at a time and re-rendering everything on every
    // row would wipe out whatever the user's still editing on the others.
    function setLegacyBatchRowStatus(rowKey, status, statusMessage) {
        const row = legacyBatchRows.find(r => r.rowKey === rowKey);
        if (row) {
            row.status = status;
            if (statusMessage !== undefined) row.statusMessage = statusMessage;
        }
        const tr = document.querySelector(`#formLogsLegacyBatchBody tr[data-row-key="${rowKey}"]`);
        if (!tr) return;
        const statusCell = tr.children[9];
        if (statusCell) statusCell.innerHTML = `<span class="legacy-batch-row-status legacy-batch-row-status--${status}">${escapeHtmlFormLogs(legacyBatchStatusLabel(row || { status, statusMessage }))}</span>`;
        if (status === "creating" || status === "created") {
            tr.querySelectorAll(".legacy-batch-field-input").forEach(input => { input.disabled = true; });
        }
    }

    async function readSelectedLegacyFiles() {
        const fileInput = document.getElementById("formLogsLegacyFileInput");
        const parseBtn = document.getElementById("formLogsLegacyParseBtn");
        const messageEl = document.getElementById("formLogsLegacyBatchMessage");
        const files = Array.from(fileInput?.files || []);

        if (!files.length) {
            if (messageEl) { messageEl.textContent = "Pick at least one PDF first."; messageEl.className = "auth-message error"; }
            return;
        }
        if (!window.LegacyFormsImport) {
            if (messageEl) { messageEl.textContent = "The PDF reader didn't load. Please refresh and try again."; messageEl.className = "auth-message error"; }
            return;
        }

        if (parseBtn) { parseBtn.disabled = true; parseBtn.textContent = "Reading…"; }
        if (messageEl) { messageEl.textContent = `Reading ${files.length} file${files.length === 1 ? "" : "s"}…`; messageEl.className = "auth-message"; }

        try {
            // Each parse never throws (see js/legacy-forms-import.js) -- one
            // bad file always comes back as its own { error } row instead
            // of taking the whole batch down.
            const results = await Promise.all(files.map(file => window.LegacyFormsImport.parseLegacyForm(file)));
            legacyBatchRows = [...legacyBatchRows, ...results.map(buildLegacyBatchRow)];
            renderLegacyBatchRows();

            const creatableCount = legacyBatchRows.filter(legacyRowIsCreatable).length;
            if (messageEl) {
                messageEl.textContent = creatableCount
                    ? `Read ${files.length} file${files.length === 1 ? "" : "s"} — review the fields below, then Create All.`
                    : `Read ${files.length} file${files.length === 1 ? "" : "s"}, but none could be created — see Status below.`;
                messageEl.className = creatableCount ? "auth-message success" : "auth-message error";
            }
        } catch (error) {
            console.error("Failed to read old form PDFs:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong reading those files. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (parseBtn) { parseBtn.disabled = false; parseBtn.textContent = "Read Files"; }
        }
    }

    // Same "who's signed in" lookup used elsewhere on this page's own
    // script tag (see updateStaffName() in project-form-logs.html) --
    // project-shell.js/loadprofile.js populate window.currentSupabaseProfile
    // once it's loaded; the localStorage copy is the same fallback used
    // there for the moment right after a fresh page load.
    function getLegacyStaffProfile() {
        if (window.currentSupabaseProfile) return window.currentSupabaseProfile;
        try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; }
    }

    function todayIsoDate() {
        return new Date().toISOString().slice(0, 10);
    }

    // Creates ONE migrated VPO from a reviewed batch row:
    //   1. A shell incident_reports row -- inserted normally (its own
    //      BEFORE INSERT trigger auto-assigns an approver and forces
    //      pending_approval, see set_incident_report_defaults() in
    //      sql/supabase-incident-reports-setup.sql), then approved through
    //      finalize_incident_report_approval() -- the SAME RPC a real
    //      approval uses -- so it gets a real, live-numbered ir_number
    //      (Coleby: "it needs to keep the same IR ID policy", after an
    //      earlier version here deliberately skipped this RPC to avoid
    //      burning a number; that's been reversed on his explicit request).
    //      The row still only exists to be the vpos row's
    //      incident_report_id foreign key -- there's no real submitted-by-a-
    //      human report behind it -- but its IR ID now reads exactly like
    //      any other approved report's, e.g. "IR-TP-011", not a
    //      VPO-number-derived placeholder.
    //   2. A generated Incident Report summary PDF, filed against that same
    //      shell IR row (Coleby: "it needs to link the IR form not the VPO
    //      twice" -- the Form Logs "IR ID" column linking to this row used
    //      to just point at the VPO's own old-form PDF a second time, since
    //      the shell IR had no document of its own). Built with the same
    //      buildIncidentReportBasePdfBytes() a real approval uses (no
    //      attachments to merge here, so pdf-lib isn't needed) -- non-fatal
    //      if it fails (a pdfmake load hiccup, say): the migrated VPO itself
    //      is what actually matters, so this is caught and logged rather
    //      than failing the whole row over a secondary summary document.
    //   3. The actual vpos row, with the OLD id preserved as vpo_number
    //      exactly as scraped (Coleby: "Keep their original old numbers as-
    //      is") instead of going through next_vpo_numbering() --
    //      building_seq/project_total_at_creation are left null since this
    //      never touches that live counter either (only the IR side now
    //      consumes real numbering, not the VPO side).
    //   4. The original old PDF itself, filed into Project Files under VPO
    //      Without Signature -- same default subfolder a freshly auto-
    //      generated VPO gets (2026-10-05: reversed from an earlier version
    //      that filed these into With Signature on the reasoning that an old
    //      form's blank signature line was "approved another way... Normal";
    //      Coleby asked for Without Signature instead, so this no longer
    //      special-cases a migrated record's folder at all).
    // Any missing text field becomes "N/A" here (Coleby: "if there is no
    // info for that input put N/A"); a missing price/date -- which can't be
    // "N/A", they're a number/date column -- fall back to 0 / today.
    async function createLegacyVpoFromRow(row) {
        const staff = getLegacyStaffProfile();
        const staffId = staff?.id || staff?.uid || null;
        const staffName = staff?.full_name || staff?.username || "Staff";

        const reportDate = row.reportDate || todayIsoDate();
        const price = (row.price === null || row.price === undefined || row.price === "") ? 0 : Number(row.price);
        const buildings = row.buildings || "N/A";
        const reasonForReport = row.reasonForReport || "N/A";
        const vendorName = row.vendorName || "N/A";

        const { data: insertedIr, error: insertIrError } = await window.supabaseClient
            .from(IR_TABLE)
            .insert({
                project_id: currentProject.id,
                report_date: reportDate,
                price,
                buildings,
                unit_numbers: "N/A",
                person_making_report: "N/A", // Coleby: old form's "Requested By" is just the vendor's own name again, not a real person -- "Leave it N/A"
                reason_for_report: reasonForReport,
                who_caused_issue: "N/A",
                submitted_by: staffId,
                submitted_by_name: staffName,
                // Marks this row as a "Submit Old Forms" shell rather than a
                // real submitted report -- now that it gets a real,
                // live-numbered ir_number (see finalize_incident_report_
                // approval() call below), that's no longer something
                // ir_number alone can tell you. delete_vpo_with_cleanup/
                // delete_bc_with_cleanup read this flag to know it's safe
                // to cascade-delete this row once nothing references it
                // anymore (sql/supabase-bc-vpo-setup.sql) -- a real IR is
                // never touched, whatever else happens to it.
                is_legacy_migration: true,
            })
            .select()
            .single();
        if (insertIrError) throw insertIrError;

        // Everything from here through the VPO insert either finishes this
        // record or must not leave the shell IR behind -- a thrown error in
        // this block deletes insertedIr before re-throwing. Before this fix,
        // a failure here (e.g. finalize_incident_report_approval erroring
        // out) left the already-inserted shell IR committed and orphaned at
        // pending_approval, with nothing to clean it up -- it just sat on
        // Account Activity forever looking like a real report needing
        // approval, and a retry created a second, successful shell right
        // alongside it rather than replacing it (confirmed 2026-10-05: two
        // "(Pending)" ghosts on Account Activity for amounts that already
        // had real, finished VPO records in Form Logs).
        let vpoRow;
        try {
            // Same RPC/flow a real approval uses (see approveIncidentReport()
            // in js/account-activity.js) -- grabs this project's next real
            // ir_number and stamps the row approved in one atomic step.
            const { data: approvedIr, error: approveError } = await window.supabaseClient
                .rpc("finalize_incident_report_approval", { p_id: insertedIr.id });
            if (approveError) throw approveError;
            const irNumber = approvedIr.ir_number;

            const { error: decisionError } = await window.supabaseClient
                .from(IR_TABLE)
                .update({
                    bc_vpo_decision: "vpo",
                    bc_vpo_decision_at: new Date().toISOString(),
                })
                .eq("id", insertedIr.id);
            if (decisionError) throw decisionError;

            try {
                const reportForPdf = {
                    report_date: reportDate,
                    price,
                    buildings,
                    unit_numbers: "N/A",
                    person_making_report: "N/A",
                    reason_for_report: reasonForReport,
                    change_in_scope: null,
                    who_caused_issue: "N/A",
                    attachments: [],
                };
                const baseBytes = await window.IncidentReportPdf.buildIncidentReportBasePdfBytes(reportForPdf, currentProject, irNumber);
                const irFileName = `Incident Report - ${irNumber}.pdf`;
                const irStoragePath = `${currentProject.id}/construction/incident_report/${Date.now()}-${irFileName}`;

                const { error: irUploadError } = await window.supabaseClient.storage
                    .from(PROJECT_DOCS_BUCKET)
                    .upload(irStoragePath, new Blob([baseBytes], { type: "application/pdf" }), { cacheControl: "3600", upsert: true, contentType: "application/pdf" });
                if (irUploadError) throw irUploadError;

                const { data: irFileRow, error: irFileError } = await window.supabaseClient
                    .from(PROJECT_FILES_TABLE)
                    .insert({
                        project_id: currentProject.id,
                        category: "construction",
                        subfolder: "incident_report",
                        bucket: PROJECT_DOCS_BUCKET,
                        storage_path: irStoragePath,
                        file_name: irFileName,
                        source: "incident_report",
                        incident_report_id: insertedIr.id,
                        uploaded_by_name: staffName,
                    })
                    .select()
                    .single();
                if (irFileError) throw irFileError;

                const { error: irLinkError } = await window.supabaseClient
                    .from(IR_TABLE)
                    .update({ project_file_id: irFileRow.id })
                    .eq("id", insertedIr.id);
                if (irLinkError) throw irLinkError;
            } catch (irPdfErr) {
                // Non-fatal -- see the comment above. Form Logs' "IR ID" column
                // just falls back to its own "not filed yet" unlinked state for
                // this row (same as a real IR whose filing failed) rather than
                // this failing the whole migrated record.
                console.warn(`Couldn't generate/file a summary Incident Report PDF for the shell IR behind ${row.oldId}:`, irPdfErr);
            }

            const { data: insertedVpo, error: vpoError } = await window.supabaseClient
                .from(VPO_TABLE)
                .insert({
                    incident_report_id: insertedIr.id,
                    project_id: currentProject.id,
                    vpo_number: row.oldId,
                    building_number: buildings,
                    building_seq: null,
                    project_total_at_creation: null,
                    vendor_id: null,
                    vendor_name: vendorName,
                    project_name: currentProject.name || null,
                    report_date: reportDate,
                    unit_numbers: "N/A",
                    person_making_report: "N/A",
                    reason_for_report: reasonForReport,
                    change_in_scope: null,
                    price,
                    created_by_id: staffId,
                    created_by_name: staffName,
                })
                .select()
                .single();
            if (vpoError) throw vpoError;
            vpoRow = insertedVpo;
        } catch (createErr) {
            // The shell IR never became a real VPO -- delete it so it
            // doesn't sit on Account Activity forever as a stuck "needs
            // approval" ghost. Best-effort: if the cleanup delete itself
            // fails, the original error is still what the row's
            // Status/retry should show, not the cleanup failure.
            try {
                await window.supabaseClient.from(IR_TABLE).delete().eq("id", insertedIr.id);
            } catch (cleanupErr) {
                console.error(`Also failed to clean up the stranded shell IR for ${row.oldId}:`, cleanupErr);
            }
            throw createErr;
        }

        try {
            const fileBytes = new Uint8Array(await row.file.arrayBuffer());
            await window.BcVpoDocs.fileExistingDocument("vpo", {
                projectId: currentProject.id,
                recordId: vpoRow.id,
                fileBytes,
                fileName: row.file.name,
                contentType: "application/pdf",
                staffName,
                subSubfolderOverride: "vpo_without_signature",
            });
        } catch (fileErr) {
            // Same "the record itself is safe even if filing fails" handling
            // as confirmBc()/confirmVpo() in js/account-activity.js -- the
            // VPO already exists at this point either way.
            console.error(`${row.oldId} was created but its old PDF couldn't be filed:`, fileErr);
            throw new Error(`${row.oldId} was created, but filing its PDF failed: ${fileErr.message || "please retry later from Project Files."}`);
        }

        return vpoRow;
    }

    // Same shape as createLegacyVpoFromRow() above -- shell IR (now with a
    // real, live-numbered ir_number via finalize_incident_report_approval()),
    // best-effort IR summary PDF, then the actual back_charges row (mirroring
    // confirmBc()'s insert in js/account-activity.js, with the OLD id
    // preserved as bc_number exactly as scraped instead of next_bc_number()),
    // then the original old PDF filed into Project Files under BC Without
    // Signature (same reversal as VPO above, 2026-10-05).
    async function createLegacyBcFromRow(row) {
        const staff = getLegacyStaffProfile();
        const staffId = staff?.id || staff?.uid || null;
        const staffName = staff?.full_name || staff?.username || "Staff";

        const reportDate = row.reportDate || todayIsoDate();
        const price = (row.price === null || row.price === undefined || row.price === "") ? 0 : Number(row.price);
        const buildings = row.buildings || "N/A";
        const reasonForReport = row.reasonForReport || "N/A";
        const vendorToChargeName = row.vendorToChargeName || "N/A";
        const vendorToCrBackName = row.vendorToCrBackName || "N/A";

        const { data: insertedIr, error: insertIrError } = await window.supabaseClient
            .from(IR_TABLE)
            .insert({
                project_id: currentProject.id,
                report_date: reportDate,
                price,
                buildings,
                unit_numbers: "N/A",
                person_making_report: "N/A",
                reason_for_report: reasonForReport,
                who_caused_issue: "N/A",
                submitted_by: staffId,
                submitted_by_name: staffName,
                is_legacy_migration: true,
            })
            .select()
            .single();
        if (insertIrError) throw insertIrError;

        // Same cleanup-on-failure shape as createLegacyVpoFromRow() above --
        // see its comment for why: a failure anywhere in here must not leave
        // the shell IR committed and orphaned at pending_approval.
        let bcRow;
        try {
            const { data: approvedIr, error: approveError } = await window.supabaseClient
                .rpc("finalize_incident_report_approval", { p_id: insertedIr.id });
            if (approveError) throw approveError;
            const irNumber = approvedIr.ir_number;

            const { error: decisionError } = await window.supabaseClient
                .from(IR_TABLE)
                .update({
                    bc_vpo_decision: "bc",
                    bc_vpo_decision_at: new Date().toISOString(),
                })
                .eq("id", insertedIr.id);
            if (decisionError) throw decisionError;

            try {
                const reportForPdf = {
                    report_date: reportDate,
                    price,
                    buildings,
                    unit_numbers: "N/A",
                    person_making_report: "N/A",
                    reason_for_report: reasonForReport,
                    change_in_scope: null,
                    who_caused_issue: "N/A",
                    attachments: [],
                };
                const baseBytes = await window.IncidentReportPdf.buildIncidentReportBasePdfBytes(reportForPdf, currentProject, irNumber);
                const irFileName = `Incident Report - ${irNumber}.pdf`;
                const irStoragePath = `${currentProject.id}/construction/incident_report/${Date.now()}-${irFileName}`;

                const { error: irUploadError } = await window.supabaseClient.storage
                    .from(PROJECT_DOCS_BUCKET)
                    .upload(irStoragePath, new Blob([baseBytes], { type: "application/pdf" }), { cacheControl: "3600", upsert: true, contentType: "application/pdf" });
                if (irUploadError) throw irUploadError;

                const { data: irFileRow, error: irFileError } = await window.supabaseClient
                    .from(PROJECT_FILES_TABLE)
                    .insert({
                        project_id: currentProject.id,
                        category: "construction",
                        subfolder: "incident_report",
                        bucket: PROJECT_DOCS_BUCKET,
                        storage_path: irStoragePath,
                        file_name: irFileName,
                        source: "incident_report",
                        incident_report_id: insertedIr.id,
                        uploaded_by_name: staffName,
                    })
                    .select()
                    .single();
                if (irFileError) throw irFileError;

                const { error: irLinkError } = await window.supabaseClient
                    .from(IR_TABLE)
                    .update({ project_file_id: irFileRow.id })
                    .eq("id", insertedIr.id);
                if (irLinkError) throw irLinkError;
            } catch (irPdfErr) {
                console.warn(`Couldn't generate/file a summary Incident Report PDF for the shell IR behind ${row.oldId}:`, irPdfErr);
            }

            const { data: insertedBc, error: bcError } = await window.supabaseClient
                .from(BC_TABLE)
                .insert({
                    incident_report_id: insertedIr.id,
                    project_id: currentProject.id,
                    bc_number: row.oldId,
                    vendor_to_charge_id: null,
                    vendor_to_charge_name: vendorToChargeName,
                    vendor_to_cr_back_id: null,
                    vendor_to_cr_back_name: vendorToCrBackName,
                    project_name: currentProject.name || null,
                    report_date: reportDate,
                    price,
                    buildings,
                    unit_numbers: "N/A",
                    person_making_report: "N/A",
                    reason_for_report: reasonForReport,
                    change_in_scope: null,
                    created_by_id: staffId,
                    created_by_name: staffName,
                })
                .select()
                .single();
            if (bcError) throw bcError;
            bcRow = insertedBc;
        } catch (createErr) {
            try {
                await window.supabaseClient.from(IR_TABLE).delete().eq("id", insertedIr.id);
            } catch (cleanupErr) {
                console.error(`Also failed to clean up the stranded shell IR for ${row.oldId}:`, cleanupErr);
            }
            throw createErr;
        }

        try {
            const fileBytes = new Uint8Array(await row.file.arrayBuffer());
            await window.BcVpoDocs.fileExistingDocument("bc", {
                projectId: currentProject.id,
                recordId: bcRow.id,
                fileBytes,
                fileName: row.file.name,
                contentType: "application/pdf",
                staffName,
                subSubfolderOverride: "bc_without_signature",
            });
        } catch (fileErr) {
            console.error(`${row.oldId} was created but its old PDF couldn't be filed:`, fileErr);
            throw new Error(`${row.oldId} was created, but filing its PDF failed: ${fileErr.message || "please retry later from Project Files."}`);
        }

        return bcRow;
    }

    async function runLegacyCreateAll() {
        const btn = document.getElementById("formLogsLegacyCreateAllBtn");
        const messageEl = document.getElementById("formLogsLegacyBatchMessage");
        const creatableRows = legacyBatchRows.filter(legacyRowIsCreatable);
        if (!creatableRows.length || !currentProject?.id) return;

        if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
        if (messageEl) { messageEl.textContent = `Creating ${creatableRows.length} record${creatableRows.length === 1 ? "" : "s"}…`; messageEl.className = "auth-message"; }

        let successCount = 0;
        let failCount = 0;

        // Sequential on purpose -- each row's Status needs to update live as
        // it finishes (not all at once at the end), and there's no upside to
        // racing several inserts against the same project at once here.
        for (const row of creatableRows) {
            setLegacyBatchRowStatus(row.rowKey, "creating");
            try {
                const createFn = row.kind === "bc" ? createLegacyBcFromRow : createLegacyVpoFromRow;
                await createFn(row);
                setLegacyBatchRowStatus(row.rowKey, "created");
                successCount++;
            } catch (error) {
                console.error(`Failed to create migrated ${row.kind === "bc" ? "BC" : "VPO"} for ${row.fileName}:`, error);
                setLegacyBatchRowStatus(row.rowKey, "failed", error.message || "Something went wrong.");
                failCount++;
            }
        }

        if (btn) { btn.textContent = "Create All"; }
        updateLegacyCreateAllButton();

        if (messageEl) {
            messageEl.textContent = failCount
                ? `${successCount} created, ${failCount} failed — see Status below. Fix and click Create All again to retry just those.`
                : `${successCount} record${successCount === 1 ? "" : "s"} created.`;
            messageEl.className = failCount ? "auth-message error" : "auth-message success";
        }

        // Picks up the newly-created VPOs (and their shell IRs, which show
        // up as approved rows on this same page's own IR card) without a
        // full page reload.
        if (successCount) await loadFormLogsData(currentProject.id);
    }

    document.getElementById("formLogsLegacyContinueBtn")?.addEventListener("click", openLegacyBatchPopup);
    document.getElementById("formLogsLegacyBatchCloseBtn")?.addEventListener("click", closeLegacyBatchPopup);
    document.getElementById("formLogsLegacyBatchBackBtn")?.addEventListener("click", closeLegacyBatchPopup);
    document.getElementById("formLogsLegacyBatchOverlay")?.addEventListener("click", (event) => {
        if (event.target.id === "formLogsLegacyBatchOverlay") closeLegacyBatchPopup();
    });
    document.getElementById("formLogsLegacyParseBtn")?.addEventListener("click", readSelectedLegacyFiles);
    document.getElementById("formLogsLegacyCreateAllBtn")?.addEventListener("click", runLegacyCreateAll);

    /* ---------- init ---------- */

    window.addEventListener("project-shell:ready", async (event) => {
        const { project, error } = event.detail;
        currentProject = project;

        const heroNameEl = document.getElementById("formLogsHeroName");

        if (error || !project) {
            setFormLogsPageMessage("No project selected. Pick one from Project Overview.", "error");
            showFormLogsLoadFailure();
            return;
        }

        if (heroNameEl) heroNameEl.textContent = `Form Logs — ${project.name || "Untitled project"}`;

        await loadFormLogsData(project.id);
    });
})();
