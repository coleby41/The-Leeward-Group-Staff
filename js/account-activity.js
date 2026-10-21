/* ===========================================================
   ACCOUNT ACTIVITY (pages/account-activity.html)

   Everyone's own page for their submitted forms + incident reports.
   Super Admin/IT additionally get a staff picker (to view anyone's
   activity). Who approves an incident report is set ONE TIME, globally,
   from a button on pages/incident-report.html (see js/incident-report.js)
   — there's no per-report assignment here anymore. Approving/rejecting is
   still only ever done by whoever's currently assigned (enforced both here
   and, for real, by the incident_reports trigger in
   sql/supabase-incident-reports-setup.sql — this file's own checks are
   just so the UI never offers a button that would fail anyway).

   The actual PDF build/merge on approval lives in
   js/incident-report-pdf.js (loaded before this file).
=========================================================== */

(function () {
    "use strict";

    const INCIDENT_REPORTS_TABLE = "incident_reports";
    const PROJECT_FILES_TABLE = "project_files";

    const state = {
        myStaffId: null,
        myName: "Staff",
        isAdmin: false,
        viewedStaffId: null,
        allStaff: [],
        allProjects: [],
        projectFilesById: new Map(),
        // Every report row rendered anywhere on the page gets cached here by
        // id (see renderReportList()) so action buttons — preview, delete —
        // can look up the FULL row (attachments included) from just the
        // data-id on their button, without a second round trip.
        reportsById: new Map(),
        // incident_report_events for the status timeline shown on each
        // report's card — keyed by report id, see loadReportEventsFor().
        eventsByReportId: new Map(),
        pendingRejectReportId: null,
        // Full form_submissions list for the currently-viewed staff member,
        // cached here so the "Show All" popup can list everything even
        // though the card itself only renders the first AA_FORMS_SHOWN (see
        // loadAndRenderViewedSections() / openFormsPopup()).
        allForms: [],
        // BC/VPO popup, opened right after an incident report is approved
        // -- see openBcVpoChoicePopup() below.
        pendingBcVpoReport: null,
        allVendors: [], // Companies, loaded lazily the first time the BC popup opens
    };

    function incidentReportsCan(permissionKey) {
        return window.Permissions ? window.Permissions.hasPermission(permissionKey) : true;
    }

    function aaEscapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str ?? "";
        return d.innerHTML;
    }

    function getAaProfile() {
        return window.currentSupabaseProfile
            || (() => { try { return JSON.parse(localStorage.getItem("staffProfile") || "null"); } catch { return null; } })();
    }

    /* ---------- lookups ---------- */

    function projectFor(id) { return state.allProjects.find(p => String(p.id) === String(id)); }

    function formatMoney(v) { return window.IncidentReportPdf.formatIncidentReportCurrency(v); }
    function formatDate(v) { return window.IncidentReportPdf.formatIncidentReportDate(v); }

    function formatDateTime(iso) {
        if (!iso) return "—";
        return new Date(iso).toLocaleString("en-US", {
            year: "numeric", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
        });
    }

    function truncate(text, max) {
        if (!text) return "";
        return text.length > max ? text.slice(0, max).trim() + "…" : text;
    }

    const STATUS_META = {
        pending_approval: { label: "Pending approval", cls: "aa-status--pending" },
        approved: { label: "Approved", cls: "aa-status--approved" },
        rejected: { label: "Rejected", cls: "aa-status--rejected" },
    };

    /* ---------- notifications ---------- */

    async function notify(userId, title, message, type, linkUrl, linkLabel) {
        if (!userId) return;
        try {
            // supabase-js returns { error } instead of throwing -- check it so a
            // failed insert (e.g. RLS) actually shows in the console.
            const { error } = await window.supabaseClient.from("notifications").insert({
                user_id: userId, title, message, type,
                link_url: linkUrl || null, link_label: linkLabel || null,
            });
            if (error) console.error("Couldn't send notification:", error);
        } catch (err) {
            console.warn("Couldn't send notification:", err);
        }
    }

    /* ---------- data loading ---------- */

    async function loadAllStaff() {
        const { data, error } = await window.supabaseClient
            .from("staff_users")
            .select("id, full_name, workgroup, active")
            .order("full_name", { ascending: true });
        if (error) { console.error("Failed to load staff:", error); return; }
        state.allStaff = data || [];
    }

    async function loadAllProjects() {
        const { data, error } = await window.supabaseClient
            .from("projects")
            .select("id, name, project_code");
        if (error) { console.error("Failed to load projects:", error); return; }
        state.allProjects = data || [];
    }

    // Batch-loads the project_files rows a set of incident reports point
    // at (project_file_id), so "View filed PDF" links don't need one query
    // per row. Merges into the shared cache rather than replacing it.
    async function loadProjectFilesFor(reports) {
        const ids = [...new Set(reports.filter(r => r.project_file_id).map(r => r.project_file_id))]
            .filter(id => !state.projectFilesById.has(id));
        if (!ids.length) return;

        const { data, error } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .select("id, storage_path, file_name, bucket")
            .in("id", ids);
        if (error) { console.warn("Failed to load filed report info:", error); return; }
        (data || []).forEach(row => state.projectFilesById.set(row.id, row));
    }

    // Batch-loads the FULL status timeline (incident_report_events) behind
    // a set of reports and OVERWRITES the cache for each one every time --
    // unlike loadProjectFilesFor() above (a project_files row, once filed,
    // never changes), a report's event list keeps growing every time it's
    // rejected/resubmitted/approved, so a "skip it, already cached" guard
    // here would silently freeze the timeline at whatever it looked like
    // the first time this report was ever rendered — Coleby: "the timeline
    // needs the whole history." Always re-fetching everything currently on
    // screen is cheap enough at this app's scale to just always be correct.
    async function loadReportEventsFor(reports) {
        const ids = [...new Set(reports.map(r => r.id))];
        if (!ids.length) return;

        const { data, error } = await window.supabaseClient
            .from("incident_report_events")
            .select("id, incident_report_id, event_type, actor_name, note, created_at")
            .in("incident_report_id", ids)
            .order("created_at", { ascending: true });
        if (error) { console.warn("Failed to load report timelines:", error); return; }

        ids.forEach(id => state.eventsByReportId.set(String(id), []));
        (data || []).forEach(ev => {
            const key = String(ev.incident_report_id);
            if (!state.eventsByReportId.has(key)) state.eventsByReportId.set(key, []);
            state.eventsByReportId.get(key).push(ev);
        });
    }

    /* ---------- staff picker (Super Admin / IT only) ---------- */

    function populateStaffPicker() {
        const wrap = document.getElementById("aaStaffPickerWrap");
        const select = document.getElementById("aaStaffPicker");
        if (!wrap || !select) return;
        if (!state.isAdmin) { wrap.classList.add("hidden"); return; }

        wrap.classList.remove("hidden");
        const others = state.allStaff.filter(s => String(s.id) !== String(state.myStaffId) && s.active !== false);
        select.innerHTML =
            `<option value="${aaEscapeHtml(state.myStaffId)}">Me (${aaEscapeHtml(state.myName)})</option>` +
            others.map(s => `<option value="${aaEscapeHtml(s.id)}">${aaEscapeHtml(s.full_name || "Staff")}</option>`).join("");

        select.addEventListener("change", () => {
            state.viewedStaffId = select.value;
            loadAndRenderViewedSections();
        });
    }

    /* ---------- report row rendering ---------- */

    // Filename-style title used everywhere a report shows up (Needs Your
    // Approval, Incident Reports, and — for form_submissions — Form
    // Submissions): "Incident Report - IR-TP-001.pdf" once it has a real
    // number, or a clear "(Pending)" placeholder before it's approved.
    function reportTitle(report) {
        const project = projectFor(report.project_id);
        return report.ir_number
            ? `Incident Report - ${report.ir_number}.pdf`
            : `Incident Report - ${project?.name || "Unknown project"} (Pending)`;
    }

    const EVENT_LABELS = {
        submitted: "Form Was Submitted",
        rejected: "Form Was Rejected",
        resubmitted: "Form Was Resubmitted",
        approved: "Form Was Approved",
    };

    // The horizontal status timeline (Submitted -> Rejected -> Resubmitted
    // -> Approved) shown on each report's own card, built from
    // incident_report_events (see loadReportEventsFor()). Starts appearing
    // right after the first submission, and while a report is waiting on a
    // decision the last step reads "Waiting Approval" per Coleby's mockup.
    function reportTimelineHtml(report, events) {
        if (!events || !events.length) return "";

        const steps = events.map(ev => ({
            label: EVENT_LABELS[ev.event_type] || ev.event_type,
            sub: `${formatDateTime(ev.created_at)} &middot; ${aaEscapeHtml(ev.actor_name || "—")}`,
            active: false,
        }));
        if (report.status === "pending_approval") {
            steps.push({
                label: "Waiting Approval",
                sub: report.assigned_approver_name ? `Assigned to ${aaEscapeHtml(report.assigned_approver_name)}` : "",
                active: true,
            });
        }

        const stepsHtml = steps.map((s, i) => `
            ${i > 0 ? `<span class="aa-timeline-arrow" aria-hidden="true">&rarr;</span>` : ""}
            <div class="aa-timeline-step${s.active ? " aa-timeline-step--active" : ""}">
                <span class="aa-timeline-dot"></span>
                <span class="aa-timeline-label">${aaEscapeHtml(s.label)}</span>
                ${s.sub ? `<span class="aa-timeline-sub">${s.sub}</span>` : ""}
            </div>
        `).join("");

        return `<div class="aa-timeline">${stepsHtml}</div>`;
    }

    // Attachment chips used to render right on each report's card (with a
    // "See more" popup, then a per-attachment hide toggle once Coleby
    // wanted to keep a specific file attached but off the card). Removed
    // entirely per his follow-up: "i just dont want that to be seen at all
    // the aprover will see the atched in the report when they go to review
    // the pdf... just trying to clean it up by getting ride of information
    // not needed." The approver already sees every attachment merged into
    // the PDF via View PDF / View filed PDF (previewReportPdf() /
    // viewFiledReportPdf()) — the card itself no longer lists them at all.

    function reportRowHtml(report, opts) {
        opts = opts || {};
        state.reportsById.set(String(report.id), report);
        const project = projectFor(report.project_id);
        const meta = STATUS_META[report.status] || { label: report.status, cls: "" };
        const filedFile = report.project_file_id ? state.projectFilesById.get(report.project_file_id) : null;
        const isMine = String(report.submitted_by) === String(state.myStaffId);

        const lines = [];
        lines.push(`<div class="aa-report-row" data-id="${aaEscapeHtml(report.id)}">`);
        lines.push(`<div class="aa-report-row-main">`);
        lines.push(`<div class="aa-report-row-top">`);
        lines.push(`<span class="aa-report-project">${aaEscapeHtml(reportTitle(report))}</span>`);
        lines.push(`<span class="aa-status-pill ${meta.cls}">${aaEscapeHtml(meta.label)}${report.ir_number ? " · " + aaEscapeHtml(report.ir_number) : ""}</span>`);
        lines.push(`</div>`);

        const detailBits = [];
        detailBits.push(aaEscapeHtml(project?.name || "Unknown project"));
        if (report.price !== null && report.price !== undefined) detailBits.push(formatMoney(report.price));
        if (report.buildings) detailBits.push(`Bldg ${aaEscapeHtml(report.buildings)}`);
        detailBits.push(formatDate(report.report_date));
        if (opts.showSubmitter) detailBits.push(`Submitted by ${aaEscapeHtml(report.submitted_by_name || "Staff")}`);
        lines.push(`<p class="aa-report-detail">${detailBits.join(" &middot; ")}</p>`);

        if (report.reason_for_report) {
            // reason_for_report may hold rich-text HTML from the "Reason for
            // Report" editor (pages/incident-report.html) -- strip it down
            // to plain text before truncating for this preview line, so
            // formatting doesn't show up as literal tags.
            const reasonPreview = window.IncidentReportPdf.richTextToPlainText(report.reason_for_report);
            if (reasonPreview) {
                lines.push(`<p class="aa-report-reason">${aaEscapeHtml(truncate(reasonPreview, 140))}</p>`);
            }
        }

        if (report.status === "rejected" && report.decision_reason) {
            lines.push(`<p class="aa-report-rejection"><strong>Rejected:</strong> ${aaEscapeHtml(report.decision_reason)}</p>`);
        }

        if (report.assigned_approver_name) {
            lines.push(`<p class="aa-report-approver">Approver: ${aaEscapeHtml(report.assigned_approver_name)}</p>`);
        }

        lines.push(reportTimelineHtml(report, state.eventsByReportId.get(String(report.id))));

        lines.push(`</div>`); // .aa-report-row-main

        lines.push(`<div class="aa-report-row-actions">`);

        if (opts.showApproveReject) {
            lines.push(`<button type="button" class="workbook-btn aa-preview-btn" data-id="${aaEscapeHtml(report.id)}">View PDF</button>`);
            if (incidentReportsCan("incident_reports.approve")) {
                lines.push(`<button type="button" class="auth-button aa-approve-btn" data-id="${aaEscapeHtml(report.id)}">Approve</button>`);
            }
            if (incidentReportsCan("incident_reports.reject")) {
                lines.push(`<button type="button" class="auth-button auth-button--red aa-reject-btn" data-id="${aaEscapeHtml(report.id)}">Reject</button>`);
            }
        }

        if (opts.showApproverDelete && incidentReportsCan("incident_reports.delete_filed_report")) {
            lines.push(`<button type="button" class="workbook-btn workbook-btn--danger aa-delete-report-btn" data-id="${aaEscapeHtml(report.id)}">Delete</button>`);
        }

        if (report.status === "rejected" && isMine) {
            lines.push(`<a class="workbook-btn aa-edit-resubmit-btn" href="/pages/incident-report.html?edit=${encodeURIComponent(report.id)}">Edit &amp; Resubmit</a>`);
        }

        if (report.status === "approved" && filedFile) {
            lines.push(`<button type="button" class="workbook-btn aa-view-filed-btn" data-id="${aaEscapeHtml(report.id)}">View filed PDF</button>`);
        } else if (report.status === "approved" && !report.project_file_id && incidentReportsCan("incident_reports.retry_filing")) {
            lines.push(`<button type="button" class="workbook-btn aa-retry-file-btn" data-id="${aaEscapeHtml(report.id)}">Retry filing</button>`);
        }

        lines.push(`</div>`); // .aa-report-row-actions
        lines.push(`</div>`); // .aa-report-row

        return lines.join("");
    }

    function renderReportList(containerId, emptyId, reports, opts) {
        const container = document.getElementById(containerId);
        const empty = document.getElementById(emptyId);
        if (!container) return;
        container.innerHTML = reports.map(r => reportRowHtml(r, opts)).join("");
        if (empty) empty.classList.toggle("hidden", reports.length > 0);
        wireRowActions(container);
    }

    const AA_FORMS_SHOWN = 4;

    function formSubmissionRowHtml(sub) {
        return `
            <div class="aa-report-row" data-id="${aaEscapeHtml(sub.id)}">
                <div class="aa-report-row-main">
                    <div class="aa-report-row-top">
                        <span class="aa-report-project">${aaEscapeHtml(sub.file_name || sub.form_title || "Form")}</span>
                    </div>
                    <p class="aa-report-detail">${formatDateTime(sub.created_at)}</p>
                </div>
                <div class="aa-report-row-actions">
                    <button type="button" class="workbook-btn aa-view-form-btn" data-id="${aaEscapeHtml(sub.id)}" data-path="${aaEscapeHtml(sub.pdf_path || "")}">View PDF</button>
                </div>
            </div>
        `;
    }

    /* ---------- activity charts ---------- */

    const AA_CHART_COLORS = ["#1E76BD", "#F2A93B", "#5DBB63", "#8E6FCE", "#4FB8AF", "#C77DA0", "#D9534F", "#8C8C8C"];

    // Plain CSS conic-gradient pie -- no charting library needed for two
    // small summary charts. `slices` is [{ label, value, color }]; color
    // can be a hex value or a var(--token) reference, both work fine
    // inside conic-gradient().
    function buildPieChartHtml(slices, emptyLabel) {
        const nonZero = slices.filter(s => s.value > 0);
        const total = nonZero.reduce((sum, s) => sum + s.value, 0);
        if (!total) {
            return `<p class="aa-empty-note">${aaEscapeHtml(emptyLabel)}</p>`;
        }

        let acc = 0;
        const stops = nonZero.map(s => {
            const start = (acc / total) * 360;
            acc += s.value;
            const end = (acc / total) * 360;
            return `${s.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
        });

        const legendHtml = nonZero.map(s => `
            <li class="aa-chart-legend-item">
                <span class="aa-chart-legend-swatch" style="background:${s.color}"></span>
                ${aaEscapeHtml(s.label)} <strong>${s.value}</strong>
            </li>
        `).join("");

        const ariaLabel = nonZero.map(s => `${s.label}: ${s.value}`).join(", ");

        return `
            <div class="aa-chart-pie" style="background: conic-gradient(${stops.join(", ")})" role="img" aria-label="${aaEscapeHtml(ariaLabel)}"></div>
            <ul class="aa-chart-legend">${legendHtml}</ul>
        `;
    }

    // Two pie charts, per Coleby's mockup: one covering every form the
    // currently-viewed person has submitted (each Form Submissions title
    // its own slice, plus Incident Reports as one more slice so it reads
    // as "all the forms"), and one breaking their Incident Reports down by
    // status specifically. Scoped to whoever's activity is currently being
    // viewed -- same person the rest of this page is already scoped to.
    function renderActivityCharts(myReports, forms) {
        const allFormsEl = document.getElementById("aaAllFormsChart");
        if (allFormsEl) {
            const counts = new Map();
            forms.forEach(f => {
                const label = f.form_title || "Form";
                counts.set(label, (counts.get(label) || 0) + 1);
            });
            const slices = [...counts.entries()].map(([label, value], i) => ({
                label, value, color: AA_CHART_COLORS[i % AA_CHART_COLORS.length],
            }));
            if (myReports.length) {
                slices.push({ label: "Incident Report", value: myReports.length, color: AA_CHART_COLORS[slices.length % AA_CHART_COLORS.length] });
            }
            allFormsEl.innerHTML = buildPieChartHtml(slices, "No forms submitted yet.");
        }

        const irStatusEl = document.getElementById("aaIrStatusChart");
        if (irStatusEl) {
            const slices = [
                { label: "Approved", value: myReports.filter(r => r.status === "approved").length, color: "var(--success)" },
                { label: "Not Approved", value: myReports.filter(r => r.status === "rejected").length, color: "var(--danger)" },
                { label: "Pending", value: myReports.filter(r => r.status === "pending_approval").length, color: "var(--warning)" },
            ];
            irStatusEl.innerHTML = buildPieChartHtml(slices, "No incident reports submitted yet.");
        }
    }

    /* ---------- section loaders ---------- */

    async function loadAndRenderViewedSections() {
        const isMe = String(state.viewedStaffId) === String(state.myStaffId);

        const [reportsRes, formsRes] = await Promise.all([
            window.supabaseClient.from(INCIDENT_REPORTS_TABLE).select("*").eq("submitted_by", state.viewedStaffId).order("created_at", { ascending: false }),
            window.supabaseClient.from("form_submissions").select("id, form_id, form_title, submitted_by, submitted_by_name, created_at, pdf_path, file_name").eq("submitted_by", state.viewedStaffId).order("created_at", { ascending: false }),
        ]);

        const myReports = reportsRes.data || [];
        if (reportsRes.error) console.error("Failed to load incident reports:", reportsRes.error);
        await Promise.all([loadProjectFilesFor(myReports), loadReportEventsFor(myReports)]);
        renderReportList("aaMyReportsList", "aaMyReportsEmpty", myReports, { showSubmitter: false });

        const forms = formsRes.data || [];
        state.allForms = forms;
        if (formsRes.error) console.error("Failed to load form submissions:", formsRes.error);
        const formsList = document.getElementById("aaFormSubmissionsList");
        const formsEmpty = document.getElementById("aaFormSubmissionsEmpty");
        if (formsList) {
            formsList.innerHTML = forms.slice(0, AA_FORMS_SHOWN).map(formSubmissionRowHtml).join("");
            wireRowActions(formsList);
        }
        if (formsEmpty) formsEmpty.classList.toggle("hidden", forms.length > 0);
        const formsShowAllWrap = document.getElementById("aaFormsShowAllWrap");
        const formsShowAllBtn = document.getElementById("aaFormsShowAllBtn");
        if (formsShowAllWrap) formsShowAllWrap.classList.toggle("hidden", forms.length <= AA_FORMS_SHOWN);
        if (formsShowAllBtn) formsShowAllBtn.textContent = `Show All (${forms.length})`;

        renderActivityCharts(myReports, forms);

        const needsApprovalSection = document.getElementById("aaNeedsApprovalSection");
        if (isMe) {
            needsApprovalSection?.classList.remove("hidden");
            const { data, error } = await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .select("*")
                .eq("assigned_approver_id", state.myStaffId)
                .eq("status", "pending_approval")
                .order("assigned_at", { ascending: true });
            if (error) console.error("Failed to load reports needing your approval:", error);
            const assigned = data || [];
            await Promise.all([loadProjectFilesFor(assigned), loadReportEventsFor(assigned)]);
            renderReportList("aaNeedsApprovalList", "aaNeedsApprovalEmpty", assigned, { showApproveReject: true, showApproverDelete: true, showSubmitter: true });
        } else {
            needsApprovalSection?.classList.add("hidden");
        }

        // Already-decided reports assigned to you -- "Needs Your Approval"
        // above only ever shows pending ones, but you can still delete a
        // report you approved/rejected from here (Coleby: the approver
        // needs to be able to delete the form, not just while it's still
        // pending on them).
        const decidedSection = document.getElementById("aaDecidedSection");
        if (isMe) {
            decidedSection?.classList.remove("hidden");
            const { data: decidedData, error: decidedError } = await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .select("*")
                .eq("assigned_approver_id", state.myStaffId)
                .in("status", ["approved", "rejected"])
                .order("decided_at", { ascending: false });
            if (decidedError) console.error("Failed to load decided reports:", decidedError);
            const decided = decidedData || [];
            await Promise.all([loadProjectFilesFor(decided), loadReportEventsFor(decided)]);
            renderReportList("aaDecidedList", "aaDecidedEmpty", decided, { showApproverDelete: true, showSubmitter: true });
        } else {
            decidedSection?.classList.add("hidden");
        }
    }

    /* ---------- row action wiring ---------- */

    function wireRowActions(container) {
        container.querySelectorAll(".aa-approve-btn").forEach(btn => btn.addEventListener("click", () => approveReport(btn.dataset.id, btn)));
        container.querySelectorAll(".aa-reject-btn").forEach(btn => btn.addEventListener("click", () => openRejectPopup(btn.dataset.id)));
        container.querySelectorAll(".aa-retry-file-btn").forEach(btn => btn.addEventListener("click", () => retryFileReport(btn.dataset.id, btn)));
        container.querySelectorAll(".aa-view-filed-btn").forEach(btn => btn.addEventListener("click", () => viewFiledReportPdf(btn.dataset.id)));
        container.querySelectorAll(".aa-view-form-btn").forEach(btn => btn.addEventListener("click", () => viewFormSubmissionPdf(btn.dataset.path)));
        container.querySelectorAll(".aa-preview-btn").forEach(btn => btn.addEventListener("click", () => previewReportPdf(btn.dataset.id, btn)));
        container.querySelectorAll(".aa-delete-report-btn").forEach(btn => btn.addEventListener("click", () => deleteReport(btn.dataset.id, btn)));
    }

    /* ---------- "show all" form submissions popup ---------- */

    // Same "very corporate" popup.popup--corporate treatment as the
    // attachments "See more" popup above, reused for the full Form
    // Submissions list (Coleby: "Form Submissions still shows all, please
    // make it only show 4 and then add the show all").
    function openFormsPopup() {
        const forms = state.allForms || [];

        const subtitleEl = document.getElementById("aaFormsPopupSubtitle");
        if (subtitleEl) subtitleEl.textContent = `${forms.length} submitted form${forms.length === 1 ? "" : "s"}`;

        const listEl = document.getElementById("aaFormsPopupList");
        if (listEl) {
            listEl.innerHTML = forms.length
                ? forms.map(sub => `
                    <div class="aa-files-popup-row">
                        <span class="ir-attachment-icon ir-attachment-icon--pdf" aria-hidden="true"></span>
                        <span class="aa-files-popup-row-name">${aaEscapeHtml(sub.file_name || sub.form_title || "Form")}</span>
                        <button type="button" class="workbook-btn aa-forms-popup-view-btn" data-path="${aaEscapeHtml(sub.pdf_path || "")}">View PDF</button>
                    </div>
                `).join("")
                : `<p class="aa-empty-note">No forms submitted yet.</p>`;
            listEl.querySelectorAll(".aa-forms-popup-view-btn").forEach(btn => {
                btn.addEventListener("click", () => viewFormSubmissionPdf(btn.dataset.path));
            });
        }

        document.getElementById("aaFormsOverlay")?.classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeFormsPopup() {
        document.getElementById("aaFormsOverlay")?.classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    // Lets the assigned approver see the report as a PDF before deciding
    // (Coleby: "the person that is approving the form needs to see the form
    // PDF version, but do not add a ID to it yet") — builds the same merged
    // PDF approving would file, but with no ir_number, so the footer reads
    // "IR-PENDING" instead of stamping a real one.
    async function previewReportPdf(reportId, btnEl) {
        const report = state.reportsById.get(String(reportId));
        if (!report) return;
        const project = projectFor(report.project_id);

        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Building preview…"; }
        try {
            const bytes = await window.IncidentReportPdf.buildMergedIncidentReportPdf(report, project, null, window.supabaseClient);
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            window.FilePreview.open({ name: "Incident Report (preview).pdf", url, kind: "pdf" });
        } catch (error) {
            console.error("Failed to build report preview:", error);
            alert(error.message || "Couldn't build a preview right now. Please try again.");
        } finally {
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "View PDF"; }
        }
    }

    // Lets the assigned approver delete a report (Coleby: "the person that
    // approves the form needs to be able to delete the form"). Removes the
    // filed PDF's actual bytes from Storage first (the RPC below can only
    // clean up the DB rows — Postgres itself can't reach into Storage),
    // then calls delete_incident_report_with_cleanup(), whose AFTER DELETE
    // trigger also reclaims the IR number if this was the latest one for
    // its project, so the next report filed doesn't leave a gap.
    async function deleteReport(reportId, btnEl) {
        if (!incidentReportsCan("incident_reports.delete_filed_report")) return;
        if (!window.confirm("Delete this incident report? This can't be undone.")) return;

        const report = state.reportsById.get(String(reportId));
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Deleting…"; }
        try {
            const filedFile = report?.project_file_id ? state.projectFilesById.get(report.project_file_id) : null;
            if (filedFile) {
                const bucket = filedFile.bucket || "project-documents";
                await window.supabaseClient.storage.from(bucket).remove([filedFile.storage_path]);
            }
            const { error } = await window.supabaseClient.rpc("delete_incident_report_with_cleanup", { p_id: reportId });
            if (error) throw error;
            await refreshEverything();
        } catch (error) {
            console.error("Failed to delete report:", error);
            alert(error.message || "Something went wrong deleting this. Please try again.");
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Delete"; }
        }
    }

    async function viewFormSubmissionPdf(path) {
        if (!path) return;
        const { data, error } = await window.supabaseClient.storage.from("form-submissions").createSignedUrl(path, 60 * 5);
        if (error || !data) { console.error("Failed to open submission PDF:", error); return; }
        window.FilePreview.open({ name: path.split("/").pop(), url: data.signedUrl, kind: "pdf" });
    }

    async function viewFiledReportPdf(reportId) {
        // The row list this button lives in was rendered from data that
        // already went through loadProjectFilesFor(), so this is a cache
        // hit in the normal case — a fresh lookup only happens if it
        // somehow isn't (e.g. the row was rendered before the file existed).
        const { data: report } = await window.supabaseClient.from(INCIDENT_REPORTS_TABLE).select("project_file_id").eq("id", reportId).single();
        if (!report?.project_file_id) return;
        let fileRow = state.projectFilesById.get(report.project_file_id);
        if (!fileRow) {
            const { data } = await window.supabaseClient.from(PROJECT_FILES_TABLE).select("id, storage_path, file_name, bucket").eq("id", report.project_file_id).single();
            fileRow = data;
        }
        if (!fileRow) return;

        const bucket = fileRow.bucket || "project-documents";
        const { data: signed, error } = await window.supabaseClient.storage.from(bucket).createSignedUrl(fileRow.storage_path, 60 * 5);
        if (error || !signed) { console.error("Failed to open filed report PDF:", error); return; }
        window.FilePreview.open({ name: fileRow.file_name || "Incident Report.pdf", url: signed.signedUrl });
    }

    /* ---------- reject popup ---------- */

    function openRejectPopup(reportId) {
        // Defense in depth -- the Reject button that triggers this is
        // already hidden without this permission, so this silently no-ops.
        if (!incidentReportsCan("incident_reports.reject")) return;
        state.pendingRejectReportId = reportId;
        document.getElementById("aaRejectReasonInput").value = "";
        const messageEl = document.getElementById("aaRejectMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
        document.getElementById("aaRejectOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function closeRejectPopup() {
        document.getElementById("aaRejectOverlay").classList.add("hidden");
        state.pendingRejectReportId = null;
        document.body.classList.remove("popup-active");
    }

    async function confirmReject() {
        if (!state.pendingRejectReportId) return;
        if (!incidentReportsCan("incident_reports.reject")) return;
        const reason = document.getElementById("aaRejectReasonInput").value.trim();
        const messageEl = document.getElementById("aaRejectMessage");
        if (!reason) { if (messageEl) { messageEl.textContent = "Please give a reason."; messageEl.className = "auth-message error"; } return; }

        const btn = document.getElementById("aaConfirmRejectBtn");
        if (btn) btn.disabled = true;

        try {
            const { data: report, error } = await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .update({ status: "rejected", decision_reason: reason })
                .eq("id", state.pendingRejectReportId)
                .select()
                .single();
            if (error) throw error;

            await notify(report.submitted_by, "Incident Report rejected", `Your incident report was rejected: ${reason}`, "incident_report_rejected", "/pages/account-activity.html", "View it here");

            closeRejectPopup();
            await refreshEverything();
        } catch (error) {
            console.error("Failed to reject report:", error);
            if (messageEl) { messageEl.textContent = "Something went wrong. Please try again."; messageEl.className = "auth-message error"; }
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ---------- approve + file ---------- */

    // Shared by the main Approve action and the "Retry filing" button —
    // builds the merged PDF, uploads it into the project's Incident Report
    // folder, and files it in project_files. Assumes `report` is already
    // status === 'approved' with a real ir_number.
    async function fileApprovedReport(report, btnEl) {
        const project = projectFor(report.project_id);
        const mergedBytes = await window.IncidentReportPdf.buildMergedIncidentReportPdf(report, project, report.ir_number, window.supabaseClient);

        const fileName = `Incident Report - ${report.ir_number}.pdf`;
        const storagePath = `${report.project_id}/construction/incident_report/${Date.now()}-${fileName}`;

        const { error: uploadError } = await window.supabaseClient.storage
            .from("project-documents")
            .upload(storagePath, new Blob([mergedBytes], { type: "application/pdf" }), { cacheControl: "3600", upsert: true, contentType: "application/pdf" });
        if (uploadError) throw uploadError;

        const { data: fileRow, error: fileError } = await window.supabaseClient
            .from(PROJECT_FILES_TABLE)
            .insert({
                project_id: report.project_id,
                category: "construction",
                subfolder: "incident_report",
                bucket: "project-documents",
                storage_path: storagePath,
                file_name: fileName,
                source: "incident_report",
                incident_report_id: report.id,
                uploaded_by_name: state.myName,
            })
            .select()
            .single();
        if (fileError) throw fileError;

        const { error: linkError } = await window.supabaseClient
            .from(INCIDENT_REPORTS_TABLE)
            .update({ project_file_id: fileRow.id })
            .eq("id", report.id);
        if (linkError) throw linkError;

        state.projectFilesById.set(fileRow.id, fileRow);
    }

    async function approveReport(reportId, btnEl) {
        if (!incidentReportsCan("incident_reports.approve")) return;
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Approving…"; }
        try {
            const { data: finalized, error: rpcError } = await window.supabaseClient.rpc("finalize_incident_report_approval", { p_id: reportId });
            if (rpcError) throw rpcError;

            if (btnEl) btnEl.textContent = "Merging PDF…";
            await fileApprovedReport(finalized, btnEl);

            await notify(finalized.submitted_by, "Incident Report approved", `Your incident report was approved as ${finalized.ir_number}.`, "incident_report_approved", "/pages/account-activity.html", "View it here");

            await refreshEverything();
            openBcVpoChoicePopup(finalized);
        } catch (error) {
            console.error("Failed to approve report:", error);
            alert(error.message || "Something went wrong approving this. Please try again.");
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Approve"; }
        }
    }

    /* ---------- BC / VPO decision (asked right after approval) ----------
       No dismiss button, no backdrop-click-to-close -- Coleby: "it must be
       a VPO or a BC". The only ways out of this popup are choosing BC,
       choosing VPO, or confirming the Reject panel with a reason (which
       is logged on the report, see confirmBcVpoReject() below). Cancel on
       either the BC or the VPO popup comes back here rather than fully
       dismissing, so the same rule holds all the way through. */

    function openBcVpoChoicePopup(report) {
        state.pendingBcVpoReport = report;
        hideBcVpoRejectPanel();
        document.getElementById("aaBcVpoChoiceOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
    }

    function hideBcVpoChoicePopup() {
        document.getElementById("aaBcVpoChoiceOverlay").classList.add("hidden");
        document.body.classList.remove("popup-active");
    }

    function chooseBc() {
        const report = state.pendingBcVpoReport;
        hideBcVpoChoicePopup();
        openBcPopup(report);
    }

    function chooseVpo() {
        const report = state.pendingBcVpoReport;
        hideBcVpoChoicePopup();
        openVpoPopup(report);
    }

    /* ---------- "doesn't need a BC or VPO" -- requires a reason, logged
       onto the incident report as bc_vpo_decision = 'rejected'. ---------- */

    function showBcVpoRejectPanel() {
        document.getElementById("aaBcVpoRejectReasonInput").value = "";
        const messageEl = document.getElementById("aaBcVpoRejectMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }
        document.getElementById("aaBcVpoRejectPanel").classList.remove("hidden");
    }

    function hideBcVpoRejectPanel() {
        document.getElementById("aaBcVpoRejectPanel")?.classList.add("hidden");
    }

    async function confirmBcVpoReject() {
        const report = state.pendingBcVpoReport;
        if (!report) return;

        const reason = document.getElementById("aaBcVpoRejectReasonInput").value.trim();
        const messageEl = document.getElementById("aaBcVpoRejectMessage");
        if (!reason) { messageEl.textContent = "Please give a reason."; messageEl.className = "auth-message error"; return; }

        const btn = document.getElementById("aaBcVpoRejectConfirmBtn");
        if (btn) btn.disabled = true;

        try {
            const { error } = await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .update({ bc_vpo_decision: "rejected", bc_vpo_decision_reason: reason, bc_vpo_decision_at: new Date().toISOString() })
                .eq("id", report.id);
            if (error) throw error;

            hideBcVpoChoicePopup();
            state.pendingBcVpoReport = null;
            await refreshEverything();
        } catch (error) {
            console.error("Failed to record BC/VPO decision:", error);
            messageEl.textContent = error.message || "Something went wrong. Please try again.";
            messageEl.className = "auth-message error";
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ---------- BC popup: Who to Charge / Who to CR Back ---------- */

    async function loadAllVendors() {
        try {
            const { data, error } = await window.supabaseClient
                .from("Companies")
                .select("id, Name")
                .order("Name", { ascending: true });
            if (error) throw error;
            state.allVendors = data || [];
        } catch (err) {
            console.warn("Couldn't load vendors for the BC popup:", err);
            state.allVendors = [];
        }
    }

    function bcVendorOptionsHtml() {
        return ['<option value="">Select a vendor…</option>']
            .concat(state.allVendors.map(v => `<option value="${v.id}">${aaEscapeHtml(v.Name || "Unnamed vendor")}</option>`))
            .join("");
    }

    /* ---------- BC/VPO template status + inline "replace template" upload
       -- lives in the BC/VPO popups themselves rather than a separate
       settings page, since this is the only place a project user/admin
       needs to touch it (see js/bc-vpo-docs.js for the resolution rules:
       project-specific template if one's been uploaded, else the company
       default). ---------- */

    const BC_VPO_LABEL = { bc: "Back Charge", vpo: "VPO" };

    async function refreshBcVpoTemplateStatus(kind, projectId) {
        const statusEl = document.getElementById(kind === "bc" ? "aaBcTemplateStatusText" : "aaVpoTemplateStatusText");
        if (!statusEl) return;
        const label = BC_VPO_LABEL[kind];
        statusEl.textContent = "Checking template…";
        try {
            const status = await window.BcVpoDocs.getTemplateStatus(kind, projectId);
            if (status.source === "project") {
                statusEl.textContent = `Using this project's ${label} template (${status.fileName}).`;
            } else if (status.source === "default") {
                statusEl.textContent = `Using the company default ${label} template (${status.fileName}).`;
            } else {
                // No project or company-default template uploaded yet -- falls
                // back to the built-in template shipped with the app itself
                // (see js/bc-vpo-docs.js's KIND.bundledPath), so this is just
                // informational, not a blocker. Uploading one now happens
                // from Form Settings on the Incident Report page, not here.
                statusEl.textContent = `Using the built-in ${label} template (${status.fileName}) — upload a project-specific one from Form Settings on the Incident Report page to replace it.`;
            }
        } catch (err) {
            console.warn(`Couldn't check the ${kind} template status:`, err);
            statusEl.textContent = "Couldn't check the template status.";
        }
    }

    async function openBcPopup(report) {
        state.pendingBcVpoReport = report;

        const messageEl = document.getElementById("aaBcMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

        if (!state.allVendors.length) await loadAllVendors();
        const optionsHtml = bcVendorOptionsHtml();
        document.getElementById("aaBcVendorToCharge").innerHTML = optionsHtml;
        document.getElementById("aaBcVendorToCredit").innerHTML = optionsHtml;

        document.getElementById("aaBcOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        refreshBcVpoTemplateStatus("bc", report.project_id);
    }

    // "Back", not a real cancel -- returns to the choice popup rather than
    // dismissing outright, so the BC/VPO/Reject decision still has to be
    // made one way or another.
    function closeBcPopup() {
        document.getElementById("aaBcOverlay").classList.add("hidden");
        const report = state.pendingBcVpoReport;
        if (report) openBcVpoChoicePopup(report);
        else document.body.classList.remove("popup-active");
    }

    async function recordBcVpoDecision(reportId, decision) {
        try {
            await window.supabaseClient
                .from(INCIDENT_REPORTS_TABLE)
                .update({ bc_vpo_decision: decision, bc_vpo_decision_at: new Date().toISOString() })
                .eq("id", reportId);
        } catch (err) {
            // Non-fatal -- the BC/VPO record itself is what matters; this
            // is just the audit trail on the incident report.
            console.warn("Couldn't record bc_vpo_decision on the report:", err);
        }
    }

    // BC-<project_code>-### -- mirrors the IR-<project_code>-### scheme.
    // Throws (with a message meant to be shown to the user) if the project
    // has no project_code set, same guardrail as IR approval already has.
    async function bcNumberFor(projectId, project) {
        if (!project?.project_code) {
            throw new Error("This project has no Project Code set — open its Edit Project wizard (Job Name step) and set one before creating a BC.");
        }
        const { data: seq, error } = await window.supabaseClient.rpc("next_bc_number", { p_project_id: projectId });
        if (error) throw error;
        return `BC-${project.project_code}-${String(seq).padStart(3, "0")}`;
    }

    async function confirmBc() {
        const report = state.pendingBcVpoReport;
        if (!report) return;
        if (!incidentReportsCan("incident_reports.approve")) return;

        const chargeId = document.getElementById("aaBcVendorToCharge").value;
        const creditId = document.getElementById("aaBcVendorToCredit").value;
        const messageEl = document.getElementById("aaBcMessage");

        if (!chargeId) { messageEl.textContent = "Please select who to charge."; messageEl.className = "auth-message error"; return; }
        if (!creditId) { messageEl.textContent = "Please select who to CR back."; messageEl.className = "auth-message error"; return; }

        const chargeVendor = state.allVendors.find(v => String(v.id) === String(chargeId));
        const creditVendor = state.allVendors.find(v => String(v.id) === String(creditId));
        const project = projectFor(report.project_id);

        const btn = document.getElementById("aaBcConfirmBtn");
        if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

        try {
            const bcNumber = await bcNumberFor(report.project_id, project);

            const { data: bcRow, error } = await window.supabaseClient.from("back_charges").insert({
                incident_report_id: report.id,
                project_id: report.project_id,
                bc_number: bcNumber,
                vendor_to_charge_id: chargeVendor?.id || null,
                vendor_to_charge_name: chargeVendor?.Name || null,
                vendor_to_cr_back_id: creditVendor?.id || null,
                vendor_to_cr_back_name: creditVendor?.Name || null,
                project_name: project?.name || null,
                report_date: report.report_date || null,
                price: report.price ?? null,
                buildings: report.buildings || null,
                unit_numbers: report.unit_numbers || null,
                person_making_report: report.person_making_report || null,
                reason_for_report: report.reason_for_report || null,
                change_in_scope: report.change_in_scope || null,
                created_by_id: state.myStaffId,
                created_by_name: state.myName,
            }).select().single();
            if (error) throw error;

            await recordBcVpoDecision(report.id, "bc");

            // The BC record itself is already safely in the database at this
            // point -- a failure filling/filing the template from here on
            // shouldn't read as "the BC wasn't created". It was; only the
            // filing failed, and that's worth a distinct message.
            let filingNote;
            try {
                const filed = await window.BcVpoDocs.fillAndFile("bc", {
                    report,
                    project,
                    recordId: bcRow.id,
                    docNumber: bcNumber,
                    extraTags: {
                        VENDOR_TO_CHARGE: chargeVendor?.Name || "",
                        VENDOR_TO_CREDIT: creditVendor?.Name || "",
                    },
                    staffName: state.myName,
                });
                filingNote = ` It's been filed into Project Files as "${filed.fileName}".`;
            } catch (fileErr) {
                console.error(`${bcNumber} was created but couldn't be filled/filed:`, fileErr);
                filingNote = ` The BC record was saved, but filing it into Project Files failed: ${fileErr.message || "please try again."}`;
            }

            document.getElementById("aaBcOverlay").classList.add("hidden");
            document.body.classList.remove("popup-active");
            state.pendingBcVpoReport = null;
            alert(`${bcNumber} created.${filingNote}`);
            await refreshEverything();
        } catch (error) {
            console.error("Failed to create BC:", error);
            messageEl.textContent = error.message || "Something went wrong creating this BC. Please try again.";
            messageEl.className = "auth-message error";
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Create Back Charge"; }
        }
    }

    /* ---------- VPO popup: just the vendor -- everything else comes off the IR ---------- */

    async function openVpoPopup(report) {
        state.pendingBcVpoReport = report;

        const messageEl = document.getElementById("aaVpoMessage");
        if (messageEl) { messageEl.textContent = ""; messageEl.className = "auth-message"; }

        if (!state.allVendors.length) await loadAllVendors();
        document.getElementById("aaVpoVendor").innerHTML = bcVendorOptionsHtml();

        document.getElementById("aaVpoOverlay").classList.remove("hidden");
        document.body.classList.add("popup-active");
        refreshBcVpoTemplateStatus("vpo", report.project_id);
    }

    // "Back", not a real cancel -- same reasoning as closeBcPopup() above.
    function closeVpoPopup() {
        document.getElementById("aaVpoOverlay").classList.add("hidden");
        const report = state.pendingBcVpoReport;
        if (report) openBcVpoChoicePopup(report);
        else document.body.classList.remove("popup-active");
    }

    // VPO-<project_code>-<building>-<seq for that building>-<project total
    // AS OF THIS VPO's CREATION>. The last segment is a fixed snapshot,
    // confirmed with Coleby -- it counts up over time but never rewrites
    // an already-issued VPO's number.
    async function vpoNumberFor(projectId, project, buildingNumber) {
        if (!project?.project_code) {
            throw new Error("This project has no Project Code set — open its Edit Project wizard (Job Name step) and set one before creating a VPO.");
        }
        if (!buildingNumber) {
            throw new Error("This incident report has no building set, so a VPO can't be numbered from it.");
        }
        const { data, error } = await window.supabaseClient.rpc("next_vpo_numbering", { p_project_id: projectId, p_building_number: buildingNumber });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new Error("Numbering failed — please try again.");
        return {
            vpoNumber: `VPO-${project.project_code}-${buildingNumber}-${row.building_seq}-${row.project_total}`,
            buildingSeq: row.building_seq,
            projectTotal: row.project_total,
        };
    }

    async function confirmVpo() {
        const report = state.pendingBcVpoReport;
        if (!report) return;
        if (!incidentReportsCan("incident_reports.approve")) return;

        const vendorId = document.getElementById("aaVpoVendor").value;
        const messageEl = document.getElementById("aaVpoMessage");

        if (!vendorId) { messageEl.textContent = "Please select a vendor."; messageEl.className = "auth-message error"; return; }

        const vendor = state.allVendors.find(v => String(v.id) === String(vendorId));
        const project = projectFor(report.project_id);

        const btn = document.getElementById("aaVpoConfirmBtn");
        if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

        try {
            const { vpoNumber, buildingSeq, projectTotal } = await vpoNumberFor(report.project_id, project, report.buildings);

            const { data: vpoRow, error } = await window.supabaseClient.from("vpos").insert({
                incident_report_id: report.id,
                project_id: report.project_id,
                vpo_number: vpoNumber,
                building_number: report.buildings || null,
                building_seq: buildingSeq,
                project_total_at_creation: projectTotal,
                vendor_id: vendor?.id || null,
                vendor_name: vendor?.Name || null,
                project_name: project?.name || null,
                report_date: report.report_date || null,
                unit_numbers: report.unit_numbers || null,
                person_making_report: report.person_making_report || null,
                reason_for_report: report.reason_for_report || null,
                change_in_scope: report.change_in_scope || null,
                price: report.price ?? null,
                created_by_id: state.myStaffId,
                created_by_name: state.myName,
            }).select().single();
            if (error) throw error;

            await recordBcVpoDecision(report.id, "vpo");

            // Same "record is safe even if filing fails" handling as confirmBc().
            let filingNote;
            try {
                const filed = await window.BcVpoDocs.fillAndFile("vpo", {
                    report,
                    project,
                    recordId: vpoRow.id,
                    docNumber: vpoNumber,
                    extraTags: {
                        VENDOR: vendor?.Name || "",
                    },
                    staffName: state.myName,
                });
                filingNote = ` It's been filed into Project Files as "${filed.fileName}".`;
            } catch (fileErr) {
                console.error(`${vpoNumber} was created but couldn't be filled/filed:`, fileErr);
                filingNote = ` The VPO record was saved, but filing it into Project Files failed: ${fileErr.message || "please try again."}`;
            }

            document.getElementById("aaVpoOverlay").classList.add("hidden");
            document.body.classList.remove("popup-active");
            state.pendingBcVpoReport = null;
            alert(`${vpoNumber} created.${filingNote}`);
            await refreshEverything();
        } catch (error) {
            console.error("Failed to create VPO:", error);
            messageEl.textContent = error.message || "Something went wrong creating this VPO. Please try again.";
            messageEl.className = "auth-message error";
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Create VPO"; }
        }
    }

    async function retryFileReport(reportId, btnEl) {
        if (!incidentReportsCan("incident_reports.retry_filing")) return;
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = "Retrying…"; }
        try {
            const { data: report, error } = await window.supabaseClient.from(INCIDENT_REPORTS_TABLE).select("*").eq("id", reportId).single();
            if (error) throw error;
            await fileApprovedReport(report, btnEl);
            await refreshEverything();
        } catch (error) {
            console.error("Failed to retry filing:", error);
            alert(error.message || "Filing still didn't go through. Please try again in a moment.");
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = "Retry filing"; }
        }
    }

    /* ---------- refresh everything ---------- */

    async function refreshEverything() {
        await loadAndRenderViewedSections();
    }

    /* ---------- init ---------- */

    function wirePopups() {
        document.getElementById("aaCancelRejectBtn")?.addEventListener("click", closeRejectPopup);
        document.getElementById("aaConfirmRejectBtn")?.addEventListener("click", confirmReject);
        document.getElementById("aaFormsShowAllBtn")?.addEventListener("click", openFormsPopup);
        document.getElementById("aaFormsCloseBtn")?.addEventListener("click", closeFormsPopup);
        document.getElementById("aaFormsOverlay")?.addEventListener("click", (event) => {
            if (event.target.id === "aaFormsOverlay") closeFormsPopup();
        });

        document.getElementById("aaBcChoiceBtn")?.addEventListener("click", chooseBc);
        document.getElementById("aaVpoChoiceBtn")?.addEventListener("click", chooseVpo);
        // No close button and no backdrop-dismiss wired here on purpose --
        // see the comment on openBcVpoChoicePopup() above.
        document.getElementById("aaBcVpoRejectToggleBtn")?.addEventListener("click", showBcVpoRejectPanel);
        document.getElementById("aaBcVpoRejectCancelBtn")?.addEventListener("click", hideBcVpoRejectPanel);
        document.getElementById("aaBcVpoRejectConfirmBtn")?.addEventListener("click", confirmBcVpoReject);

        document.getElementById("aaBcCancelBtn")?.addEventListener("click", closeBcPopup);
        document.getElementById("aaBcConfirmBtn")?.addEventListener("click", confirmBc);
        document.getElementById("aaBcOverlay")?.addEventListener("click", (event) => {
            if (event.target.id === "aaBcOverlay") closeBcPopup();
        });

        document.getElementById("aaVpoCancelBtn")?.addEventListener("click", closeVpoPopup);
        document.getElementById("aaVpoConfirmBtn")?.addEventListener("click", confirmVpo);
        document.getElementById("aaVpoOverlay")?.addEventListener("click", (event) => {
            if (event.target.id === "aaVpoOverlay") closeVpoPopup();
        });
    }

    async function initAccountActivity(attempts) {
        attempts = attempts || 0;
        const profile = getAaProfile();
        const clientReady = !!window.supabaseClient;

        if ((!clientReady || !profile) && attempts < 25) {
            setTimeout(() => initAccountActivity(attempts + 1), 200);
            return;
        }
        if (!clientReady) return;

        state.myStaffId = profile?.id || profile?.uid || null;
        state.myName = (profile && (profile.full_name || profile.username)) || "Staff";
        state.viewedStaffId = state.myStaffId;
        if (window.Permissions) {
            try { await window.Permissions.initPermissions(); } catch { /* incidentReportsCan() fails open regardless */ }
        }
        state.isAdmin = incidentReportsCan("incident_reports.view_all_activity");

        await Promise.all([loadAllStaff(), loadAllProjects()]);
        populateStaffPicker();
        wirePopups();
        await refreshEverything();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => initAccountActivity());
    } else {
        initAccountActivity();
    }
})();
