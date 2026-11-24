// Contract Builder — staff actions (Coleby, 2026-11-19). Called from the
// project's Accounts page with the signed-in staff member's session.
//
//   { action: "prefill", project_id, company_id }
//       everything the Generate contract popup shows: vendor info + contacts,
//       project info, the awarded bid (amount, scope, proposal), the Project
//       Manager, W-9 status, PDFs to pick the plans from, and the saved draft.
//   { action: "save", project_id, company_id, fields }
//       saves the popup's choices, builds the PDF and returns a short-lived
//       preview link + what's still missing. status: not_completed | ready
//   { action: "send", project_id, company_id }
//       builds the final contract from the saved choices (refused while
//       anything is missing), files it in Project Files › Contracts &
//       Procurement › Vendors and makes it the vendor's contract to sign in
//       the Vendor Portal (initials on every page + signature).
//   { action: "gc_sign", project_id, company_id, initials, title?, signature_png, agree }
//       the project's Project Manager signs for Leeward after the vendor:
//       initials on every page, signature, and the agreement date.
//
// fields: { scope, amount, retainage, poc_contact_id, safety_contact_id,
//           sov_file_id, plans_file_id, proposal_file_id }
//
// Needs sql/supabase-contract-builder-setup.sql.
// Deploy:  supabase functions deploy contract-builder

import { CORS_HEADERS, json, serviceClient } from "../_shared/bid-common.ts";
import { notifyStaff, STAFF_PORTAL_URL } from "../_shared/vendor-common.ts";
import {
  type ContractData, type ContractLayout, type Exhibit, type ExhibitFile, addAuditPage, buildContractPdf,
  dollarWords, money, percentWords, sha256Hex, stampGc, stateName,
} from "../_shared/contract-pdf.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

const DOCS_BUCKET = "project-documents";
const W9_BUCKET = "company-w9s";
const CATEGORY = "contracts_procurement";
const SUBFOLDER = "vendors";
const LINK_SECONDS = 60 * 10;
const MAX_SIGNATURE_BYTES = 300 * 1024;
// Where the plans usually live (offered first in the plans picker).
const PLAN_FOLDERS = ["design_engineering", "permits_inspections"];

const fail = (error: string, status = 400, extra: Row = {}) => json({ ok: false, error, ...extra }, status);
const clean = (v: unknown, max = 300) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : ""; };
const isUuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v || ""));

// Any active staff member (same as uploading a contract on the Accounts page).
async function requireStaff(req: Request, admin: Row) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: fail("Please sign in again.", 401) };
  const { data: userData, error } = await admin.auth.getUser(token);
  if (error || !userData?.user) return { error: fail("Your session has expired. Please sign in again.", 401) };
  const { data: staff } = await admin.from("staff_users").select("id, full_name, username, active").eq("auth_user_id", userData.user.id).maybeSingle();
  if (!staff || staff.active === false) return { error: fail("This account can't do that.", 403) };
  return { staff, authUserId: userData.user.id as string };
}

// ---------------------------------------------------------------------------
// Loading

async function loadAll(admin: Row, projectId: string, companyId: number) {
  const [projectRes, companyRes, contactsRes, contractRes, pkgsRes, membersRes] = await Promise.all([
    admin.from("projects").select("*").eq("id", projectId).maybeSingle(),
    admin.from("Companies").select("*").eq("id", companyId).maybeSingle(),
    admin.from("Contacts").select("*").eq("company_id", companyId).order("id"),
    admin.from("project_vendor_contracts").select("*").eq("project_id", projectId).eq("company_id", companyId).maybeSingle(),
    admin.from("bid_packages").select("id, name, scope").eq("project_id", projectId),
    admin.from("project_members").select("user_id, role").eq("project_id", projectId).eq("role", "project_manager"),
  ]);
  for (const r of [projectRes, companyRes, contactsRes, contractRes, pkgsRes, membersRes]) if (r.error) throw r.error;
  const project = projectRes.data, company = companyRes.data;
  if (!project || !company) return null;

  // The awarded bid on this project (newest).
  let award: Row = null;
  const pkgIds = (pkgsRes.data || []).map((p: Row) => p.id);
  if (pkgIds.length) {
    const { data: invs, error } = await admin.from("bid_invites")
      .select("id, package_id, bid_amount, awarded_amount, proposal_file_id, responded_at")
      .eq("company_id", companyId).eq("status", "awarded").in("package_id", pkgIds)
      .order("responded_at", { ascending: false, nullsFirst: false });
    if (error) throw error;
    const inv = (invs || [])[0];
    if (inv) {
      const pkg = (pkgsRes.data || []).find((p: Row) => p.id === inv.package_id) || {};
      award = { invite_id: inv.id, amount: inv.awarded_amount != null ? Number(inv.awarded_amount) : inv.bid_amount != null ? Number(inv.bid_amount) : null, scope: pkg.scope || pkg.name || "", package_name: pkg.name || "", proposal_file_id: inv.proposal_file_id || null };
    }
  }

  // Project Manager(s): Project Members with the Project Manager role.
  const pmAuthIds = (membersRes.data || []).map((m: Row) => m.user_id);
  let pms: Row[] = [];
  if (pmAuthIds.length) {
    const { data, error } = await admin.from("staff_users").select("id, auth_user_id, full_name, username, active").in("auth_user_id", pmAuthIds);
    if (error) throw error;
    pms = (data || []).filter((s: Row) => s.active !== false);
  }

  return { project, company, contacts: contactsRes.data || [], contract: contractRes.data || null, award, pms };
}

function vendorLegalName(c: Row): string {
  const legal = clean(c.Name), dba = clean(c.FriendlyName);
  return dba && dba.toLowerCase() !== legal.toLowerCase() ? `${legal} DBA ${dba}` : legal;
}

function contactName(c: Row | undefined): string { return c ? clean(c.Name) : ""; }

// Fields as saved, with the awarded bid's scope / amount as defaults.
function effectiveFields(all: Row, fields: Row) {
  const f = fields || {};
  const awardAmount = all.award?.amount;
  return {
    scope: clean(f.scope ?? all.award?.scope ?? "", 2000),
    // "Whatever is approved": the awarded bid. Staff type it only when the
    // vendor wasn't awarded through a bid invite.
    amount: awardAmount != null ? awardAmount : (f.amount === "" || f.amount == null ? null : Number(f.amount)),
    amount_from_bid: awardAmount != null,
    retainage: f.retainage === "" || f.retainage == null ? null : Number(f.retainage),
    poc_contact_id: f.poc_contact_id ?? all.contacts[0]?.id ?? null,
    safety_contact_id: f.safety_contact_id ?? null,
    sov_file_id: isUuid(f.sov_file_id) ? f.sov_file_id : null,
    plans_file_id: isUuid(f.plans_file_id) ? f.plans_file_id : null,
    proposal_file_id: isUuid(f.proposal_file_id) ? f.proposal_file_id : (all.award?.proposal_file_id || null),
  };
}

// What's still needed before the contract can be sent.
function missingList(all: Row, fx: Row): string[] {
  const p = all.project, c = all.company;
  const poc = all.contacts.find((x: Row) => String(x.id) === String(fx.poc_contact_id));
  const safety = all.contacts.find((x: Row) => String(x.id) === String(fx.safety_contact_id));
  const m: string[] = [];
  const need = (ok: unknown, label: string) => { if (!ok) m.push(label); };
  need(clean(c.Name), "Vendor name");
  need(clean(c.Street) && clean(c.City) && clean(c.State) && clean(c.Zip), "Vendor street address (vendor record)");
  need(clean(c["SSN/FID"]), "Vendor SSN/FID (vendor record)");
  need(poc, "Point of contact");
  need(safety, "Safety representative");
  need(clean(p.name), "Project name");
  need(clean(p.site_address) && clean(p.site_city) && clean(p.site_state), "Job site address (project)");
  need(clean(p.site_county), "County (project)");
  need(clean(p.owner_entity), "Legal owner entity (project)");
  need(clean(p.lender_name), "Lender (project)");
  need(fx.scope, "Scope of work");
  need(fx.amount != null && fx.amount > 0, "Contract sum");
  need(fx.retainage != null && fx.retainage >= 0 && fx.retainage <= 100, "Retainage %");
  need(all.pms.length, "Project Manager (Project Members) — they sign for Leeward");
  need(fx.sov_file_id, "Exhibit B — Schedule of Values");
  need(fx.plans_file_id, "Exhibit C — Plans (cover sheet)");
  need(fx.proposal_file_id, "Exhibit E — Proposal");
  if (c.W9Exempt && !c.W9FilePath) m.push("Exhibit F — W-9 (vendor is W-9 exempt, no W-9 on file)");
  else need(c.W9FilePath, "Exhibit F — W-9");
  return m;
}

function contractData(all: Row, fx: Row): ContractData {
  const p = all.project, c = all.company;
  const poc = all.contacts.find((x: Row) => String(x.id) === String(fx.poc_contact_id));
  const safety = all.contacts.find((x: Row) => String(x.id) === String(fx.safety_contact_id));
  const st = clean(p.site_state).toUpperCase();
  return {
    SUB_NAME: vendorLegalName(c), SUB_STREET: clean(c.Street), SUB_CITY: clean(c.City), SUB_STATE: clean(c.State),
    SUB_ZIP: clean(c.Zip), SUB_TAXID: clean(c["SSN/FID"]),
    SUB_WORK_PHONE: clean(poc?.WorkPhone), SUB_MOBILE_PHONE: clean(poc?.MobilePhone), SUB_POC: contactName(poc), SUB_EMAIL: clean(poc?.Email),
    PROJECT_NAME: clean(p.name), PROJECT_LOCATION: [clean(p.site_city), stateName(st)].filter(Boolean).join(", "),
    SCOPE: fx.scope || "",
    SUM: fx.amount != null ? money(fx.amount) : "", SUM_WORDS: fx.amount != null ? dollarWords(fx.amount) : "",
    RETAINAGE: fx.retainage != null ? String(fx.retainage) : "", RETAINAGE_WORDS: fx.retainage != null ? percentWords(fx.retainage) : "",
    SAFETY_REP: contactName(safety), OWNER_ENTITY: clean(p.owner_entity),
    SITE_ADDRESS: clean(p.site_address), SITE_CITY: clean(p.site_city), SITE_STATE_NAME: stateName(st), SITE_STATE: st,
    COUNTY: clean(p.site_county).replace(/\s+county$/i, ""), LENDER: clean(p.lender_name),
  };
}

function kindOf(name: string, bytes: Uint8Array): ExhibitFile["kind"] | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return "pdf";                 // %P
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (/\.pdf$/i.test(name)) return "pdf";
  return null;
}

async function download(admin: Row, bucket: string, path: string): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function projectFile(admin: Row, projectId: string, id: string | null): Promise<{ name: string; file: ExhibitFile } | { error: string } | null> {
  if (!id) return null;
  const { data: f } = await admin.from("project_files").select("file_name, bucket, storage_path, project_id").eq("id", id).maybeSingle();
  if (!f || f.project_id !== projectId) return { error: "the file isn't in this project anymore" };
  const bytes = await download(admin, f.bucket || DOCS_BUCKET, f.storage_path);
  if (!bytes) return { error: "the file couldn't be downloaded" };
  const kind = kindOf(f.file_name, bytes);
  if (!kind) return { error: "the file has to be a PDF or an image" };
  return { name: f.file_name, file: { bytes, kind } };
}

// Builds the PDF. Missing exhibits become a "MISSING" page in a preview.
async function build(admin: Row, all: Row, fx: Row) {
  const pid = all.project.id;
  const exhibit = async (letter: string, name: string, id: string | null, missingText: string, firstPageOnly = false): Promise<Exhibit> => {
    const r = await projectFile(admin, pid, id);
    if (!r) return { letter, name, missing: missingText };
    if ("error" in r) return { letter, name, missing: `${missingText} (${r.error})` };
    return { letter, name, files: [{ ...r.file, firstPageOnly }] };
  };
  const w9: Exhibit = await (async () => {
    const path = all.company.W9FilePath;
    if (!path) return { letter: "F", name: "W9", missing: all.company.W9Exempt ? "Vendor is W-9 exempt — no W-9 on file" : "No W-9 on the vendor record" };
    const bytes = await download(admin, W9_BUCKET, path);
    const kind = bytes ? kindOf(path, bytes) : null;
    if (!bytes || !kind) return { letter: "F", name: "W9", missing: "The vendor's W-9 couldn't be read" };
    return { letter: "F", name: "W9", files: [{ bytes, kind }] };
  })();
  const exhibits: Exhibit[] = [
    await exhibit("B", "Schedule of Values", fx.sov_file_id, "Upload the Schedule of Values"),
    await exhibit("C", "Plans and Specifications", fx.plans_file_id, "Pick the plans PDF", true),
    { letter: "D1", name: "Monthly Lien Waiver", generate: "D1" },
    { letter: "D2", name: "Final Lien Waiver", generate: "D2" },
    await exhibit("E", "Proposal", fx.proposal_file_id, all.award ? "The vendor's proposal" : "No bid invite — upload the vendor's proposal"),
    w9,
  ];
  return await buildContractPdf(contractData(all, fx), exhibits);
}

async function signedUrl(admin: Row, bucket: string, path: string, download?: string) {
  const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, LINK_SECONDS, download ? { download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

async function upsertContract(admin: Row, all: Row, patch: Row) {
  if (all.contract) {
    const { data, error } = await admin.from("project_vendor_contracts").update(patch).eq("id", all.contract.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await admin.from("project_vendor_contracts")
    .insert({ project_id: all.project.id, company_id: all.company.id, ...patch }).select().single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Actions

async function prefill(admin: Row, all: Row) {
  const fx = effectiveFields(all, all.contract?.builder);
  const pid = all.project.id;
  // PDFs to pick the plans from (plans folders first) and the proposal/SOV names.
  const { data: files, error } = await admin.from("project_files")
    .select("id, file_name, category, subfolder, created_at")
    .eq("project_id", pid).ilike("file_name", "%.pdf").order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  const plans = (files || []).sort((a: Row, b: Row) => Number(!PLAN_FOLDERS.includes(a.category)) - Number(!PLAN_FOLDERS.includes(b.category)));
  const nameOf = (id: string | null) => (id ? (files || []).find((f: Row) => f.id === id)?.file_name || null : null);
  // Suggest a plans file when none is picked yet: a PDF in a plans folder whose name says plans/permit.
  if (!fx.plans_file_id) {
    const guess = plans.find((f: Row) => PLAN_FOLDERS.includes(f.category) && /plan|permit|cover|set|drawing/i.test(f.file_name));
    if (guess) fx.plans_file_id = guess.id;
  }
  const c = all.company, p = all.project;
  const k = all.contract;
  const missing = missingList(all, fx);
  return json({
    ok: true,
    vendor: {
      name: vendorLegalName(c), street: clean(c.Street), city: clean(c.City), state: clean(c.State), zip: clean(c.Zip),
      taxid: c["SSN/FID"] ? `•••••${String(c["SSN/FID"]).replace(/[^0-9A-Za-z]/g, "").slice(-4)}` : "",
      w9: { on_file: Boolean(c.W9FilePath), exempt: Boolean(c.W9Exempt) },
    },
    contacts: all.contacts.map((x: Row) => ({ id: x.id, name: x.Name, title: x.Title, work_phone: x.WorkPhone, mobile_phone: x.MobilePhone, email: x.Email })),
    project: {
      name: p.name, location: [clean(p.site_city), stateName(p.site_state)].filter(Boolean).join(", "),
      site_address: [clean(p.site_address), clean(p.site_city), clean(p.site_state), clean(p.site_zip)].filter(Boolean).join(", "),
      county: clean(p.site_county), owner_entity: clean(p.owner_entity), lender: clean(p.lender_name),
    },
    award: all.award ? { ...all.award, proposal_file_name: nameOf(all.award.proposal_file_id) } : null,
    pm: all.pms.length ? { names: all.pms.map((s: Row) => s.full_name || s.username) } : null,
    plan_files: plans.map((f: Row) => ({ id: f.id, name: f.file_name, folder: f.category })),
    fields: { ...fx, sov_file_name: nameOf(fx.sov_file_id), proposal_file_name: nameOf(fx.proposal_file_id) },
    missing,
    status: k?.builder_status || null,
    sent: Boolean(k?.generated && k?.file_id),
    vendor_signed: Boolean(k?.generated && k?.signed_file_id),
  });
}

async function save(admin: Row, all: Row, body: Row, staff: Row) {
  if (all.contract?.countersigned_file_id) return fail("This contract is already signed by both sides.", 409);
  const f = body.fields || {};
  const saved = {
    scope: clean(f.scope, 2000),
    amount: f.amount === "" || f.amount == null ? null : Number(f.amount),
    retainage: f.retainage === "" || f.retainage == null ? null : Number(f.retainage),
    poc_contact_id: f.poc_contact_id || null,
    safety_contact_id: f.safety_contact_id || null,
    sov_file_id: isUuid(f.sov_file_id) ? f.sov_file_id : null,
    plans_file_id: isUuid(f.plans_file_id) ? f.plans_file_id : null,
    proposal_file_id: isUuid(f.proposal_file_id) ? f.proposal_file_id : null,
  };
  for (const k of ["amount", "retainage"] as const) if (saved[k] != null && !Number.isFinite(saved[k])) saved[k] = null;
  const fx = effectiveFields(all, saved);
  const missing = missingList(all, fx);
  const { bytes, problems } = await build(admin, all, fx);
  // Files that were picked but couldn't be used (missing ones are already listed).
  const readErrors = problems.filter((p) => /couldn't|isn't in this project|has to be/.test(p));
  const allMissing = [...missing, ...readErrors];
  const path = `${all.project.id}/${CATEGORY}/${SUBFOLDER}/drafts/contract-draft-${all.company.id}.pdf`;
  const { error: upError } = await admin.storage.from(DOCS_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (upError) throw upError;
  const status = allMissing.length ? "not_completed" : "ready";
  // A contract that was already sent keeps builder_status "sent" until it's sent again.
  const keepSent = all.contract?.builder_status === "sent" && all.contract?.file_id;
  await upsertContract(admin, all, {
    builder: saved, builder_status: keepSent ? "sent" : status, builder_missing: allMissing,
    builder_updated_by_name: staff.full_name || staff.username || "Staff", draft_path: path,
  });
  const name = `${vendorLegalName(all.company)} - Contract (Draft).pdf`.replace(/[\\/]/g, "-");
  return json({
    ok: true, status, missing: allMissing,
    url: await signedUrl(admin, DOCS_BUCKET, path), download_url: await signedUrl(admin, DOCS_BUCKET, path, name), name,
  });
}

async function send(admin: Row, all: Row, staff: Row) {
  const k = all.contract;
  if (!k?.builder) return fail("Save the contract first.", 409);
  if (k.countersigned_file_id) return fail("This contract is already signed by both sides.", 409);
  const fx = effectiveFields(all, k.builder);
  const missing = missingList(all, fx);
  if (missing.length) return fail("not_completed", 409, { missing });
  const { bytes, layout, problems } = await build(admin, all, fx);
  if (problems.length) return fail("not_completed", 409, { missing: problems });

  const vendor = vendorLegalName(all.company);
  const path = `${all.project.id}/${CATEGORY}/${SUBFOLDER}/${Date.now()}-contract-${all.company.id}-subcontractor-agreement.pdf`;
  const { error: upError } = await admin.storage.from(DOCS_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (upError) throw upError;
  const fileName = `${vendor} - Contract - Subcontractor Agreement.pdf`.replace(/[\\/]/g, "-").slice(0, 200);
  const { data: fileRow, error: fileError } = await admin.from("project_files").insert({
    project_id: all.project.id, category: CATEGORY, subfolder: SUBFOLDER, sub_subfolder: null,
    bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "contract",
    uploaded_by_name: staff.full_name || staff.username || "Staff",
  }).select("id").single();
  if (fileError) throw fileError;

  await upsertContract(admin, all, {
    file_id: fileRow.id, generated: true, layout, builder_status: "sent", builder_missing: [], not_needed: false,
    uploaded_by: staff.id, uploaded_by_name: staff.full_name || staff.username || "Staff",
    signed_file_id: null, signed_at: null, signed_in_portal: false, signer_name: null, signer_title: null,
    signer_email: null, signer_vendor_user_id: null, signer_ip: null, vendor_initials: null,
    countersigned_file_id: null, countersigned_at: null, countersigner_name: null, countersigner_title: null,
    countersigner_user_id: null, countersigner_ip: null, agreement_date: null,
  });
  return json({ ok: true, file_id: fileRow.id });
}

async function gcSign(admin: Row, all: Row, body: Row, staff: Row, authUserId: string, ip: string | null) {
  const k = all.contract;
  if (!all.pms.some((s: Row) => s.auth_user_id === authUserId)) {
    return fail("Only this project's Project Manager can sign for Leeward. Set it in Project Members.", 403);
  }
  if (!k?.generated || !k.signed_file_id || !k.layout) return fail("The vendor hasn't signed this contract yet.", 409);
  if (k.countersigned_file_id) return fail("You already signed this contract.", 409);

  const initials = clean(body.initials, 6).toUpperCase();
  const title = clean(body.title, 120);
  const missing = [!initials ? "initials" : null, body.agree !== true ? "agree" : null].filter(Boolean) as string[];
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.signature_png || ""));
  if (!m) missing.push("signature");
  if (missing.length) return fail("missing_fields", 400, { fields: missing });
  const sig = Uint8Array.from(atob(m![1]), (ch) => ch.charCodeAt(0));
  if (sig.length > MAX_SIGNATURE_BYTES) return fail("That signature is too big. Clear it and sign again.", 400);

  const { data: vf } = await admin.from("project_files").select("bucket, storage_path, file_name").eq("id", k.signed_file_id).maybeSingle();
  if (!vf) return fail("The vendor-signed contract is missing.", 409);
  const vendorBytes = await download(admin, vf.bucket || DOCS_BUCKET, vf.storage_path);
  if (!vendorBytes) throw new Error("vendor-signed contract download failed");
  const digest = await sha256Hex(vendorBytes);
  const now = new Date();
  const name = staff.full_name || staff.username || "Project Manager";
  const pdf = await stampGc(vendorBytes, k.layout as ContractLayout, { initials, signaturePng: sig, name, when: now });
  const when = now.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "long" });
  await addAuditPage(pdf, "Electronic Signature — Leeward", `${name} signed this contract for Leeward Construction, LLC electronically in The Leeward Group staff portal, after the vendor.`, [
    ["Project", String(all.project.name || "")],
    ["Subcontractor", vendorLegalName(all.company)],
    ["Signed by", `${name}${title ? `, ${title}` : ""} (Project Manager)`],
    ["Initials on every page", initials],
    ["Date / time", when],
    ["IP address", ip || "unknown"],
    ["Document fingerprint (SHA-256 of the vendor-signed PDF)", digest],
  ], sig);
  const out = await pdf.save();

  const path = `${all.project.id}/${CATEGORY}/${SUBFOLDER}/${Date.now()}-contract-signed-final-${all.company.id}.pdf`;
  const { error: upError } = await admin.storage.from(DOCS_BUCKET).upload(path, out, { contentType: "application/pdf", upsert: false });
  if (upError) throw upError;
  const fileName = `${vendorLegalName(all.company)} - Contract (Fully Signed) - Subcontractor Agreement.pdf`.replace(/[\\/]/g, "-").slice(0, 200);
  const { data: fileRow, error: fileError } = await admin.from("project_files").insert({
    project_id: all.project.id, category: CATEGORY, subfolder: SUBFOLDER, sub_subfolder: null,
    bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "contract", uploaded_by_name: name,
  }).select("id").single();
  if (fileError) throw fileError;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const { error } = await admin.from("project_vendor_contracts").update({
    countersigned_file_id: fileRow.id, countersigned_at: now.toISOString(), countersigner_name: name,
    countersigner_title: title || null, countersigner_user_id: staff.id, countersigner_ip: ip, agreement_date: today,
  }).eq("id", k.id);
  if (error) throw error;
  if (k.uploaded_by && k.uploaded_by !== staff.id) {
    await notifyStaff(admin, [k.uploaded_by], {
      title: "Contract fully signed",
      message: `${name} signed ${vendorLegalName(all.company)}'s contract for ${all.project.name}.`,
      type: "vendor_document",
      link_url: `${STAFF_PORTAL_URL}/pages/project-accounts.html?id=${all.project.id}`,
      link_label: "View accounts",
    });
  }
  return json({ ok: true, file_id: fileRow.id });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail("POST only", 405);
  let body: Row;
  try { body = await req.json(); } catch { return fail("Invalid JSON body"); }
  const admin = serviceClient();
  try {
    const auth = await requireStaff(req, admin);
    if (auth.error) return auth.error;
    const projectId = String(body.project_id || "");
    const companyId = Number(body.company_id);
    if (!isUuid(projectId) || !Number.isFinite(companyId)) return fail("Missing project or vendor.");
    const all = await loadAll(admin, projectId, companyId);
    if (!all) return fail("That project or vendor doesn't exist anymore.", 404);
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || null;
    switch (String(body.action || "")) {
      case "prefill": return await prefill(admin, all);
      case "save": return await save(admin, all, body, auth.staff);
      case "send": return await send(admin, all, auth.staff);
      case "gc_sign": return await gcSign(admin, all, body, auth.staff, auth.authUserId!, ip);
      default: return fail(`Unknown action "${body.action}"`);
    }
  } catch (error) {
    console.error(`contract-builder ${body?.action} failed:`, error);
    return fail("Something went wrong building the contract. Please try again.", 500);
  }
});
