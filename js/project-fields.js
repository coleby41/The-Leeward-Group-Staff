/* ===========================================================
   PROJECT FIELDS (shared)
   Single source of truth for every field collected by the New Project
   Onboard wizard (project-home.html / projects-page.js) AND for the
   per-project dashboard pages (projects.html and friends), which use the
   same list to render the Overview summary, the Site Plans page, and the
   sidebar "search everything in this project" feature.

   `page` says which project-dashboard page is the best place to land on
   when a search result for that section is clicked — everything defaults
   to the Overview page except the two document-heavy sections, which have
   their own tab.
=========================================================== */

window.ProjectFields = (function () {

    const PROJECTS_TABLE = "projects";
    // Reads go through this view instead of the base table — it masks the
    // money-adjacent columns (contract_value, utility/trash/porta-potty
    // account numbers) per-row based on the signed-in user's project role,
    // via has_financial_access() (see supabase-rls-lockdown.sql). Writes
    // still go straight to PROJECTS_TABLE, unchanged.
    const PROJECTS_READ_VIEW = "projects_overview";
    const PROJECT_DOCS_BUCKET = "project-documents";

    const WIZARD_STATUS_OPTIONS = ["Not started", "In progress", "Submitted", "Approved"];

    // Canonical "All Files" folder taxonomy — single source of truth shared by:
    //   - project-files.html (renders the folder accordion + file lists)
    //   - form-builder.js / form-template.html (the "file into a project
    //     folder?" category/subfolder pickers when creating a template)
    // `key` values are what actually get stored in form_templates.default_category
    // /default_subfolder and project_files.category/subfolder — stable even if a
    // label gets reworded later. Order here is display order.
    const PROJECT_FILE_CATEGORIES = [
        {
            key: "acquisition_due_diligence", number: "01", label: "Acquisition & Due Diligence",
            subfolders: [
                { key: "purchase_sale", label: "Purchase & Sale" },
                { key: "title", label: "Title" },
                { key: "surveys", label: "Surveys" },
                { key: "environmental", label: "Environmental" },
                { key: "geotechnical", label: "Geotechnical" },
                { key: "property_research", label: "Property Research" },
                { key: "due_diligence_reports", label: "Due Diligence Reports" }
            ]
        },
        {
            key: "development_entitlements", number: "02", label: "Development & Entitlements",
            subfolders: [
                { key: "zoning", label: "Zoning" },
                { key: "land_use", label: "Land Use" },
                { key: "planning", label: "Planning" },
                { key: "government_approvals", label: "Government Approvals" },
                { key: "hoa_community_approvals", label: "HOA / Community Approvals" },
                { key: "entitlements", label: "Entitlements" }
            ]
        },
        {
            key: "design_engineering", number: "03", label: "Design & Engineering",
            subfolders: [
                { key: "architecture", label: "Architecture" },
                { key: "civil", label: "Civil" },
                { key: "structural", label: "Structural" },
                { key: "mep", label: "MEP" },
                { key: "landscape", label: "Landscape" },
                { key: "interior_design", label: "Interior Design" },
                { key: "specifications", label: "Specifications" },
                { key: "design_reviews", label: "Design Reviews" }
            ]
        },
        {
            key: "permits_inspections", number: "04", label: "Permits & Inspections",
            subfolders: [
                { key: "building_permits", label: "Building Permits" },
                { key: "trade_permits", label: "Trade Permits" },
                { key: "inspections", label: "Inspections" },
                { key: "certificates", label: "Certificates" },
                { key: "government_correspondence", label: "Government Correspondence" }
            ]
        },
        {
            key: "contracts_procurement", number: "05", label: "Contracts & Procurement",
            subfolders: [
                { key: "Project Forms Downloadable", label: "Project Form Downloadable" },
                { key: "general_contractor", label: "General Contractor" },
                { key: "subcontractors", label: "Subcontractors" },
                { key: "vendors", label: "Vendors" },
                { key: "purchase_orders", label: "Purchase Orders" },
                { key: "contracts", label: "Contracts" },
                {
                    key: "back_charges", label: "Back Charges - BC",
                    // A folder inside a folder: Contracts & Procurement /
                    // Back Charges - BC / <one of these>. Coleby: keep
                    // signed and unsigned copies apart. This is the only
                    // subfolder with its own children right now — see
                    // findFileSubSubfolder() below and js/project-files.js,
                    // which renders this extra level (nested under the
                    // subfolder in the List-view tree; as its own tile grid,
                    // inline above the file list, in both views) only when
                    // a subfolder actually has a `subfolders` array.
                    subfolders: [
                        { key: "bc_without_signature", label: "BC Without Signature" },
                        { key: "bc_with_signature", label: "BC With Signature" }
                    ]
                },
                {
                    key: "vpo", label: "Variance Purchase Order - VPO",
                    // Same "folder inside a folder" shape as Back Charges -
                    // BC just above — Coleby wants signed/unsigned VPO
                    // copies kept apart the same way. Order matches what he
                    // asked for: With Signature, then Without Signature.
                    subfolders: [
                        { key: "vpo_with_signature", label: "VPO With Signature" },
                        { key: "vpo_without_signature", label: "VPO Without Signature" }
                    ]
                },
                { key: "insurance_bonds", label: "Insurance & Bonds" },
                // Bid Invites (beta): plans/specs uploaded with an Invitation
                // to Bid, and the proposals logged from vendors' replies
                // (js/bid-invites.js, js/project-bid-invites.js).
                { key: "bids", label: "Bids" }
            ]
        },
        {
            key: "construction", number: "06", label: "Construction",
            subfolders: [
                { key: "daily_reports", label: "Daily Reports" },
                { key: "site_photos", label: "Site Photos" },
                { key: "field_reports", label: "Field Reports" },
                { key: "rfis", label: "RFIs" },
                { key: "submittals", label: "Submittals" },
                { key: "inspections", label: "Inspections" },
                { key: "safety", label: "Safety" },
                { key: "quality_control", label: "Quality Control" },
                { key: "progress_reports", label: "Progress Reports" },
                // New: where an approved Incident Report's merged PDF gets
                // filed (pages/incident-report.html / account-activity.js).
                // Created lazily — nothing special needs to happen here,
                // this just makes it a valid, browsable folder from day one.
                { key: "incident_report", label: "Incident Report" }
            ]
        },
        {
            key: "financial", number: "07", label: "Financial",
            subfolders: [
                { key: "project_budget", label: "Project Budget" },
                { key: "cost_tracking", label: "Cost Tracking" },
                { key: "pay_applications", label: "Pay Applications" },
                { key: "draws", label: "Draws" },
                { key: "invoices", label: "Invoices" },
                { key: "lien_waivers", label: "Lien Waivers" },
                { key: "forecasts", label: "Forecasts" },
                { key: "financial_reports", label: "Financial Reports" }
            ]
        },
        
        {
            key: "marketing", number: "09", label: "Marketing",
            subfolders: [
                { key: "branding", label: "Branding" },
                { key: "logo_brand_assets", label: "Logo & Brand Assets" },
                { key: "photography", label: "Photography" },
                { key: "renderings", label: "Renderings" },
                { key: "video", label: "Video" },
                { key: "website", label: "Website" },
                { key: "social_media", label: "Social Media" },
                { key: "advertising", label: "Advertising" },
                { key: "brochures_flyers", label: "Brochures & Flyers" },
                { key: "signage", label: "Signage" },
                { key: "press_public_relations", label: "Press & Public Relations" },
                { key: "marketing_campaigns", label: "Marketing Campaigns" }
            ]
        },
        {
            key: "communications", number: "10", label: "Communications",
            subfolders: [
                { key: "owner", label: "Owner" },
                { key: "architect", label: "Architect" },
                { key: "contractor", label: "Contractor" },
                { key: "subcontractors", label: "Subcontractors" },
                { key: "vendors", label: "Vendors" },
                { key: "government", label: "Government" },
                { key: "public_community", label: "Public / Community" }
            ]
        },
        {
            key: "closeout", number: "11", label: "Closeout",
            subfolders: [
                { key: "punch_list", label: "Punch List" },
                { key: "as_builts", label: "As-Builts" },
                { key: "warranties", label: "Warranties" },
                { key: "om_manuals", label: "O&M Manuals" },
                { key: "final_inspections", label: "Final Inspections" },
                { key: "certificates", label: "Certificates" },
                { key: "certificate_of_occupancy", label: "Certificate of Occupancy" }
            ]
        }
    ];

    function findFileCategory(categoryKey) {
        return PROJECT_FILE_CATEGORIES.find(c => c.key === categoryKey) || null;
    }

    function findFileSubfolder(categoryKey, subfolderKey) {
        const category = findFileCategory(categoryKey);
        if (!category) return null;
        return category.subfolders.find(s => s.key === subfolderKey) || null;
    }

    // A folder inside a folder — one level deeper than findFileSubfolder().
    // Most subfolders have no `subfolders` array at all (the common case),
    // in which case this just returns null, same as looking up a key that
    // doesn't exist.
    function findFileSubSubfolder(categoryKey, subfolderKey, subSubfolderKey) {
        const subfolder = findFileSubfolder(categoryKey, subfolderKey);
        if (!subfolder || !subfolder.subfolders) return null;
        return subfolder.subfolders.find(s => s.key === subSubfolderKey) || null;
    }

    // Label helpers — fall back to the raw stored key so a file never
    // disappears from view just because the taxonomy changed later.
    function fileCategoryLabel(categoryKey) {
        const category = findFileCategory(categoryKey);
        return category ? category.label : categoryKey;
    }

    function fileSubfolderLabel(categoryKey, subfolderKey) {
        const subfolder = findFileSubfolder(categoryKey, subfolderKey);
        return subfolder ? subfolder.label : subfolderKey;
    }

    function fileSubSubfolderLabel(categoryKey, subfolderKey, subSubfolderKey) {
        const subSubfolder = findFileSubSubfolder(categoryKey, subfolderKey, subSubfolderKey);
        return subSubfolder ? subSubfolder.label : subSubfolderKey;
    }

    // Extension → { type, kind } — shared by project-files.html (the
    // Finder-style file list + upload status tray icons) and
    // project-shell.js (the sidebar "search everything" results, so a
    // file result's Kind reads the same way there as it does on the All
    // Files page itself). `type` picks which .file-type-icon--<type> icon
    // to show, `kind` is the human-readable label (mirrors macOS Finder's
    // "Kind" column wording, e.g. "Word Document").
    const FILE_TYPE_META = {
        doc: { type: "word", kind: "Word Document" },
        docx: { type: "word", kind: "Word Document" },
        xls: { type: "excel", kind: "Excel Spreadsheet" },
        xlsx: { type: "excel", kind: "Excel Spreadsheet" },
        csv: { type: "excel", kind: "CSV Document" },
        ppt: { type: "powerpoint", kind: "PowerPoint Presentation" },
        pptx: { type: "powerpoint", kind: "PowerPoint Presentation" },
        pdf: { type: "pdf", kind: "PDF Document" },
        png: { type: "image", kind: "PNG Image" },
        jpg: { type: "image", kind: "JPEG Image" },
        jpeg: { type: "image", kind: "JPEG Image" },
        gif: { type: "image", kind: "GIF Image" },
        webp: { type: "image", kind: "WEBP Image" },
        heic: { type: "image", kind: "HEIC Image" },
    };

    function getFileTypeMeta(fileName) {
        const ext = String(fileName || "").split(".").pop().toLowerCase();
        return FILE_TYPE_META[ext] || { type: "generic", kind: ext ? `${ext.toUpperCase()} File` : "Document" };
    }

    // Canonical project status list — single source of truth for the
    // onboarding wizard's "Status & Tracking" step, the quick-edit popup,
    // the stats header, tabs, and status badges on project-home.html.
    const PROJECT_STATUSES = [
        { value: "active", label: "Active", chip: "chip--success" },
        { value: "onboarding", label: "Onboarding", chip: "chip--info" },
        { value: "on_hold", label: "On Hold", chip: "chip--muted" },
        { value: "completed", label: "Completed", chip: "chip--completed" },
        { value: "archived", label: "Archived", chip: "chip--muted" }
    ];

    // The six "who do we call" contact categories on the Accounts / Contacts
    // page (project-accounts.html / .js) — one quick-access card each, plus
    // the full type list in the "All Contacts" filter. `wizardStep` links a
    // category back to the matching WIZARD_STEPS entry below purely for
    // documentation (the two are separate data models — project_contacts
    // rows are NOT auto-populated from wizard fields, and vice versa) and
    // `icon` selects which .project-stat-icon--<icon> mask to use.
    const CONTACT_TYPES = [
        { key: "property_owner", label: "Property Owner", wizardStep: "owner_contact", icon: "person", color: "accent" },
        { key: "general_contractor", label: "General Contractor", wizardStep: "gc", icon: "building", color: "info" },
        { key: "point_of_contact", label: "Project Point of Contact", wizardStep: "poc", icon: "badge", color: "success" },
        { key: "utilities", label: "Utilities", wizardStep: "utilities", icon: "droplet", color: "info" },
        { key: "trash_porta_potties", label: "Trash / Porta Potties", wizardStep: "temp_services", icon: "trash", color: "completed" },
        { key: "county_city_office", label: "County / City Office", wizardStep: "county_city", icon: "bank", color: "accent" },
        { key: "other", label: "Other", wizardStep: null, icon: "person", color: "completed" }
    ];

    function contactTypeMeta(key) {
        return CONTACT_TYPES.find(t => t.key === key) || CONTACT_TYPES[CONTACT_TYPES.length - 1];
    }

    const WIZARD_STEPS = [
        {
            key: "owner_contact",
            title: "Property Owner Contact Info",
            hint: "Who owns the property this job is on?",
            page: "/pages/projects.html",
            // These 4 steps (owner_contact/gc/poc/county_city) each collect a
            // Name/Phone/Email-shaped contact — layout: "contact" renders
            // them as one consistent grouped card (see wizard-contact-block
            // in styles.css) instead of each hand-rolling its own layout.
            // No fields were removed/merged — same columns, same data.
            layout: "contact",
            fields: [
                { name: "owner_name", label: "Owner name", type: "text", placeholder: "e.g. Jane Smith" },
                { name: "owner_phone", label: "Phone", type: "tel", placeholder: "e.g. (910) 555-0132" },
                { name: "owner_email", label: "Email", type: "email", placeholder: "e.g. jane@email.com" },
                { name: "owner_address", label: "Mailing address", type: "text", placeholder: "Start typing an address…", addressLookup: true }
            ]
        },
        {
            key: "job_name",
            title: "Job Name",
            hint: "This becomes the project's display name across the portal.",
            page: "/pages/projects.html",
            fields: [
                { name: "name", label: "Project / job name", type: "text", placeholder: "e.g. Wilmington Riverfront Renovation" },
                // Short per-project code (e.g. "TP") used to build this
                // project's Incident Report numbers: IR-TP-001, IR-TP-002...
                // See sql/supabase-incident-reports-setup.sql. `uppercase`
                // is an existing field-renderer option (already used by
                // site_state below) — reused here rather than adding a new
                // one, so "tp" typed in still saves as "TP".
                { name: "project_code", label: "Project Code", type: "text", maxlength: 12, uppercase: true, placeholder: "e.g. TP" }
            ]
        },
        {
            key: "site_address",
            title: "Job Site Address",
            hint: "Where the work is actually happening.",
            page: "/pages/projects.html",
            fields: [
                { name: "site_address", label: "Street address", type: "text", placeholder: "e.g. 123 Main St" },
                { name: "site_city", label: "City", type: "text" },
                { name: "site_state", label: "State", type: "text", maxlength: 2, uppercase: true, placeholder: "e.g. NC" },
                { name: "site_zip", label: "Zip", type: "text" }
            ]
        },
        {
            key: "gc",
            title: "General Contractor",
            hint: "Who's the GC of record for this job?",
            page: "/pages/projects.html",
            layout: "contact",
            fields: [
                { name: "gc_name", label: "General contractor name", type: "text" },
                { name: "gc_phone", label: "Phone", type: "tel" },
                { name: "gc_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "poc",
            title: "Project Point of Contact",
            hint: "Who should staff reach out to with questions about this project?",
            page: "/pages/projects.html",
            layout: "contact",
            fields: [
                { name: "poc_name", label: "Name", type: "text" },
                { name: "poc_role", label: "Role", type: "text", placeholder: "e.g. Project Manager" },
                { name: "poc_phone", label: "Phone", type: "tel" },
                { name: "poc_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "site_plans",
            title: "Site Plans",
            hint: "Upload the site plan file if you have it, or just note where things stand.",
            page: "project-site-plans.html",
            fields: [
                { name: "site_plans_status", label: "Status", type: "select", options: WIZARD_STATUS_OPTIONS },
                { name: "site_plans_notes", label: "Notes", type: "textarea" },
                { name: "site_plans_file", label: "Site plan file", type: "file", pathField: "site_plans_file_path", accept: ".pdf,.jpg,.jpeg,.png,.dwg" }
            ]
        },
        {
            key: "permit_plans",
            title: "Permit Plans",
            hint: "Upload the permit plan file if you have it, or just note where things stand.",
            page: "project-site-plans.html",
            fields: [
                { name: "permit_number", label: "Permit number", type: "text" },
                { name: "permit_plans_status", label: "Status", type: "select", options: WIZARD_STATUS_OPTIONS },
                { name: "permit_plans_notes", label: "Notes", type: "textarea" },
                { name: "permit_plans_file", label: "Permit plan file", type: "file", pathField: "permit_plans_file_path", accept: ".pdf,.jpg,.jpeg,.png,.dwg" }
            ]
        },
        {
            key: "utilities",
            title: "Utilities Account Info",
            hint: "",
            page: "/pages/projects.html",
            fields: [
                { name: "electric_provider", label: "Electric provider", type: "text" },
                { name: "electric_account_number", label: "Electric account #", type: "text" },
                { name: "water_provider", label: "Water provider", type: "text" },
                { name: "water_account_number", label: "Water account #", type: "text" },
                { name: "other_utilities_notes", label: "Other utilities notes", type: "textarea" }
            ]
        },
        {
            key: "temp_services",
            title: "Temporary Trash / Porta Potties",
            hint: "",
            page: "/pages/projects.html",
            fields: [
                { name: "trash_vendor", label: "Trash vendor", type: "text" },
                { name: "trash_account_number", label: "Trash account #", type: "text" },
                { name: "porta_potty_vendor", label: "Porta potty vendor", type: "text" },
                { name: "porta_potty_account_number", label: "Porta potty account #", type: "text" },
                { name: "temp_services_notes", label: "Notes", type: "textarea" }
            ]
        },
        {
            key: "county_city",
            title: "County / City Office Contact",
            hint: "Who do we call for permitting or inspections?",
            page: "/pages/projects.html",
            layout: "contact",
            fields: [
                { name: "county_city_office_name", label: "Office name", type: "text", placeholder: "e.g. New Hanover County Building Safety" },
                { name: "county_city_contact_name", label: "Contact name", type: "text" },
                { name: "county_city_phone", label: "Phone", type: "tel" },
                { name: "county_city_email", label: "Email", type: "email" }
            ]
        },
        {
            key: "tracking",
            title: "Status & Tracking",
            hint: "Powers the Project Overview cards — the cover photo, status badge, value, progress bar, and due date. Update anytime by reopening this wizard or clicking a card's status badge.",
            page: "/pages/projects.html",
            fields: [
                { name: "cover_photo", label: "Cover photo", type: "file", pathField: "cover_photo_url", accept: "image/*", bucket: "project-covers", publicBucket: true },
                { name: "status", label: "Status", type: "select", options: PROJECT_STATUSES, noBlankOption: true, default: "onboarding" },
                { name: "project_manager_name", label: "Project manager", type: "text", placeholder: "e.g. John Smith" },
                { name: "contract_value", label: "Contract value ($)", type: "number", placeholder: "e.g. 4200000", default: null },
                { name: "progress_percent", label: "Progress (%)", type: "number", placeholder: "0–100", default: 0 },
                { name: "due_date", label: "Due date", type: "date" }
            ]
        }
    ];

    function isBlank(value) {
        return value === null || value === undefined || String(value).trim() === "";
    }

    // Public-bucket files (cover photo) store a full public URL in the column
    // instead of a bare storage path — pull the path back out of that URL so
    // the old file can still be cleaned up when it's replaced.
    function storagePathFromPublicUrl(url, bucket) {
        if (!url) return null;
        const marker = `/${bucket}/`;
        const idx = url.indexOf(marker);
        return idx === -1 ? null : url.slice(idx + marker.length);
    }

    // Shared upload helper — used by the onboarding wizard (projects-page.js,
    // one file per field, no subfolders) AND by project-files.html (All
    // Files manual uploads, filed under a category/subfolder). Same
    // storage-path convention either way: `${projectId}/[...pathSegments/]
    // ${timestamp}-${safeName}`. The project-documents bucket policy only
    // checks the FIRST path segment (the project id), so adding extra
    // segments after it needs no RLS changes — see supabase-rls-lockdown.sql.
    async function uploadFile(projectId, file, existingValue, options = {}) {
        const bucket = options.bucket || PROJECT_DOCS_BUCKET;
        const isPublic = !!options.publicBucket;
        const extraSegments = Array.isArray(options.pathSegments) ? options.pathSegments.filter(Boolean) : [];

        const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const prefix = [projectId, ...extraSegments].join("/");
        const path = `${prefix}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await window.supabaseClient
            .storage
            .from(bucket)
            .upload(path, file, { upsert: false });

        if (uploadError) throw uploadError;

        const oldPath = isPublic ? storagePathFromPublicUrl(existingValue, bucket) : existingValue;
        if (oldPath) {
            window.supabaseClient
                .storage
                .from(bucket)
                .remove([oldPath])
                .catch(err => console.warn("Couldn't remove old project file:", err));
        }

        if (isPublic) {
            const { data } = window.supabaseClient.storage.from(bucket).getPublicUrl(path);
            return data.publicUrl;
        }

        return path;
    }

    // How many of the wizard's sections have at least one field filled in.
    function computeCompleteness(project) {
        let complete = 0;
        WIZARD_STEPS.forEach(step => {
            const hasValue = step.fields.some(field => {
                const key = field.type === "file" ? field.pathField : field.name;
                return !isBlank(project[key]);
            });
            if (hasValue) complete++;
        });
        return { complete, total: WIZARD_STEPS.length };
    }

    return {
        PROJECTS_TABLE,
        PROJECTS_READ_VIEW,
        PROJECT_DOCS_BUCKET,
        WIZARD_STATUS_OPTIONS,
        PROJECT_STATUSES,
        PROJECT_FILE_CATEGORIES,
        CONTACT_TYPES,
        contactTypeMeta,
        WIZARD_STEPS,
        isBlank,
        computeCompleteness,
        findFileCategory,
        findFileSubfolder,
        findFileSubSubfolder,
        fileCategoryLabel,
        fileSubfolderLabel,
        fileSubSubfolderLabel,
        getFileTypeMeta,
        uploadFile,
        storagePathFromPublicUrl
    };

})();
