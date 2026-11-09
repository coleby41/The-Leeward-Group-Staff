// Vendor Portal -- everything a signed-in vendor does. Public (deploy with
// --no-verify-jwt); every request carries the portal session token in the
// body ({ session, action, ... }) and only ever sees that vendor's own
// company's data.
//
//   me                         who's signed in, their company, application status
//   set_language { language }  'en' | 'es' (also used for their emails)
//   update_me { name, title, phone }
//   invites                    their company's bid invites
//   invite { id }              one invite (marks it Viewed the first time)
//   file_url { invite_id, file_id }  short-lived link to a plan/spec or their proposal
//   respond { id, choice: 'bidding' | 'not_bidding', reason?, note? }
//   bid_upload_url { id, file_name }  upload slot for the proposal PDF
//   submit_bid { id, amount, notes?, path, file_name }
//   profile                    company info, W-9 / COI status, team logins
//   update_company { friendly_name, street, city, state, zip }   (account holder)
//   doc_upload_url { kind: 'w9' | 'coi', file_name }
//   save_doc { kind: 'w9', path, ssn_fid? }   (COI PDFs go in project folders, below)
//   set_coi_date { expires_on }  the company's COI expiration date -- a
//       current date is what counts for approval (no PDF)
//   projects                   "My Projects": one folder per awarded project
//   project { id }             one project folder (awarded scopes, COI status)
//   project_coi_upload_url { project_id, file_name }
//   save_project_coi { project_id, path, file_name }
//       the COI PDF for that project: filed in the project's Files ›
//       Contracts & Procurement › Vendors, answers the "COI needed" request
//   project_file_url { project_id, file_id, download? }   their COI / proposal / contract on that project
//   sign_contract { project_id, name, title?, signature_png, agree }
//       signs the project's contract in the portal: adds a signature page
//       (name, title, signature, email, date/time, IP, file fingerprint) to
//       the PDF, files it in Contracts & Procurement › Vendors.
//   A project stays LOCKED (no scopes, amounts or proposals) until the
//   contract is signed, the company has a W-9 on file and this project's
//   COI is uploaded (exempt / not-needed count as done).
//   doc_url { kind }           short-lived link to their W-9 / COI on file
//   team_add { name, email, title?, phone? }    (account holder)
//   team_remove { id }                          (account holder)
//
// Deploy:  supabase functions deploy vendor-api --no-verify-jwt

import { CORS_HEADERS, formatMoney, json, sendEmail, serviceClient } from "../_shared/bid-common.ts";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { renderTeamInviteEmail } from "../_shared/bid-email.ts";
import {
  STAFF_PORTAL_URL, TEAM_INVITE_LINK_HOURS, type Row, type VendorContext, clean, createLoginLink,
  findVendorUserByEmail, lang, maskTaxId, normalizeEmail, notifyStaff, requireVendor, safeFileName,
  staffWithPermission,
} from "../_shared/vendor-common.ts";

const DOCS_BUCKET = "project-documents";
const BIDS_CATEGORY = "contracts_procurement";
const BIDS_SUBFOLDER = "bids";
const DOC_BUCKETS: Record<string, string> = { w9: "company-w9s", coi: "company-cois" };
const LINK_SECONDS = 60 * 10;

const fail = (error: string, status = 400, extra: Row = {}) => json({ ok: false, error, ...extra }, status);

function companyName(ctx: VendorContext): string {
  return ctx.company?.Name || "Your company";
}

function isHolder(ctx: VendorContext): boolean {
  return ctx.user.role === "holder";
}

function needsCompany(ctx: VendorContext): Response | null {
  return ctx.company ? null : fail("pending_approval", 403);
}

// Rows from a Supabase query, or throw its error (the handler turns that
// into a server_error response and logs it) -- never silently empty.
function must(res: { data: unknown; error: unknown }): Row[] {
  if (res.error) throw res.error;
  return (res.data as Row[]) || [];
}

// An embedded relation comes back as an object or a one-item array.
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Row | null | undefined;

// The invite, if it belongs to this vendor's company -- with its package.
async function loadInvite(ctx: VendorContext, id: unknown): Promise<{ invite: Row; pkg: Row } | null> {
  if (!ctx.company || !/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const { data: invite } = await ctx.admin.from("bid_invites").select("*")
    .eq("id", String(id)).eq("company_id", ctx.company.id).maybeSingle();
  if (!invite || invite.status === "pending" || invite.status === "failed") return null;
  const { data: pkg } = await ctx.admin.from("bid_packages").select("*").eq("id", invite.package_id).maybeSingle();
  if (!pkg) return null;
  return { invite, pkg };
}

function canStillBid(pkg: Row): boolean {
  return pkg.status === "open" && new Date(pkg.due_at).getTime() > Date.now();
}

// ---------------------------------------------------------------------------

async function me(ctx: VendorContext) {
  const u = ctx.user;
  let application = null;
  if (u.application_id) {
    const { data } = await ctx.admin.from("vendor_applications")
      .select("status, legal_name, friendly_name, street, city, state, zip, contact_name, contact_title, contact_phone, contact_email, w9_path, created_at")
      .eq("id", u.application_id).maybeSingle();
    if (data) application = { ...data, w9_on_file: Boolean(data.w9_path), w9_path: undefined };
  }
  return json({
    ok: true,
    user: { id: u.id, name: u.name, email: u.email, title: u.title, phone: u.phone, role: u.role, status: u.status, language: u.language },
    company: ctx.company ? { id: ctx.company.id, name: ctx.company.Name, friendly_name: ctx.company.FriendlyName || null } : null,
    application,
  });
}

async function setLanguage(ctx: VendorContext, body: Row) {
  const language = lang(body.language);
  await ctx.admin.from("vendor_users").update({ language }).eq("id", ctx.user.id);
  return json({ ok: true, language });
}

async function updateMe(ctx: VendorContext, body: Row) {
  const name = clean(body.name, 120);
  if (!name) return fail("missing_fields", 400, { fields: ["name"] });
  const patch = { name, title: clean(body.title, 120), phone: clean(body.phone, 40) };
  await ctx.admin.from("vendor_users").update(patch).eq("id", ctx.user.id);
  // Keep Leeward's contact card in sync.
  if (ctx.user.contact_id != null) {
    await ctx.admin.from("Contacts").update({ Name: patch.name, Title: patch.title, MobilePhone: patch.phone }).eq("id", ctx.user.contact_id);
  }
  return json({ ok: true });
}

async function invites(ctx: VendorContext) {
  const gate = needsCompany(ctx); if (gate) return gate;
  // One query: each invite with its package and the package's project
  // (was 3 queries one after another). Any error now fails the request
  // instead of returning rows with blank names/dates.
  const rows = must(await ctx.admin.from("bid_invites")
    .select("id, status, bid_amount, decline_reason, sent_at, viewed_at, responded_at, package_id, coi_requested_at, coi_received_at, bid_packages(id, name, due_at, walkthrough_at, status, project_id, projects(id, name))")
    .eq("company_id", ctx.company!.id)
    .not("status", "in", "(pending,failed)")
    .order("sent_at", { ascending: false }));
  return json({
    ok: true,
    invites: rows.map((r: Row) => {
      const pkg: Row = one(r.bid_packages) || {};
      const project: Row = one(pkg.projects) || {};
      return {
        id: r.id, status: r.status, bid_amount: r.bid_amount, decline_reason: r.decline_reason, sent_at: r.sent_at,
        package_name: pkg.name, due_at: pkg.due_at, walkthrough_at: pkg.walkthrough_at, package_status: pkg.status,
        project_name: project.name || "", project_id: pkg.project_id,
        open: pkg.status === "open" && new Date(pkg.due_at).getTime() > Date.now(),
        coi_needed: r.status === "awarded" && Boolean(r.coi_requested_at) && !r.coi_received_at,
      };
    }),
  });
}

async function invite(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const loaded = await loadInvite(ctx, body.id);
  if (!loaded) return fail("not_found", 404);
  const { invite: inv, pkg } = loaded;

  if (!inv.viewed_at) {
    const patch: Row = { viewed_at: new Date().toISOString() };
    if (inv.status === "sent") patch.status = "viewed";
    await ctx.admin.from("bid_invites").update(patch).eq("id", inv.id);
    Object.assign(inv, patch);
  }

  const [{ data: project }, { data: fileRows }] = await Promise.all([
    ctx.admin.from("projects").select("name, project_code, site_address, site_city, site_state, site_zip").eq("id", pkg.project_id).maybeSingle(),
    ctx.admin.from("bid_package_files").select("project_file_id, sort_order, project_files(id, file_name)").eq("package_id", pkg.id).order("sort_order"),
  ]);
  let proposal = null;
  if (inv.proposal_file_id) {
    const { data } = await ctx.admin.from("project_files").select("id, file_name").eq("id", inv.proposal_file_id).maybeSingle();
    proposal = data || null;
  }
  const site = project ? [project.site_address, [project.site_city, project.site_state].filter(Boolean).join(", "), project.site_zip].filter(Boolean).join(" ") : "";

  return json({
    ok: true,
    invite: {
      id: inv.id, status: inv.status, bid_amount: inv.bid_amount, bid_notes: inv.bid_notes,
      decline_reason: inv.decline_reason, decline_note: inv.decline_note, responded_at: inv.responded_at,
      bid_source: inv.bid_source, proposal,
      coi: inv.status === "awarded" && inv.coi_requested_at
        ? { requested_at: inv.coi_requested_at, received_at: inv.coi_received_at || null }
        : null,
    },
    company_coi: { expires_on: ctx.company!.COIExpiresOn || null, on_file: Boolean(ctx.company!.COIFilePath), exempt: Boolean(ctx.company!.COIExempt) },
    package: {
      name: pkg.name, scope: pkg.scope, location: pkg.location || site || null, due_at: pkg.due_at,
      walkthrough_at: pkg.walkthrough_at, walkthrough_location: pkg.walkthrough_location,
      questions_due_at: pkg.questions_due_at, contact_name: pkg.contact_name, contact_email: pkg.contact_email,
      contact_phone: pkg.contact_phone, status: pkg.status, can_bid: canStillBid(pkg) && !["awarded", "not_selected"].includes(inv.status),
    },
    project: { id: pkg.project_id, name: project?.name || "", code: project?.project_code || "" },
    files: (fileRows || []).map((r: Row) => {
      const f = Array.isArray(r.project_files) ? r.project_files[0] : r.project_files;
      return f ? { id: f.id, name: f.file_name } : null;
    }).filter(Boolean),
  });
}

async function fileUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const loaded = await loadInvite(ctx, body.invite_id);
  if (!loaded) return fail("not_found", 404);
  const fileId = String(body.file_id || "");
  let allowed = loaded.invite.proposal_file_id === fileId;
  if (!allowed) {
    const { data } = await ctx.admin.from("bid_package_files").select("id").eq("package_id", loaded.pkg.id).eq("project_file_id", fileId).maybeSingle();
    allowed = Boolean(data);
  }
  if (!allowed) return fail("not_found", 404);
  const { data: file } = await ctx.admin.from("project_files").select("bucket, storage_path, file_name").eq("id", fileId).maybeSingle();
  if (!file) return fail("not_found", 404);
  const { data, error } = await ctx.admin.storage.from(file.bucket || DOCS_BUCKET).createSignedUrl(file.storage_path, LINK_SECONDS, { download: body.download ? file.file_name : undefined });
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl, name: file.file_name });
}

const DECLINE_REASONS = new Set(["schedule_full", "outside_scope", "too_far", "other"]);

async function respond(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const loaded = await loadInvite(ctx, body.id);
  if (!loaded) return fail("not_found", 404);
  const { invite: inv, pkg } = loaded;
  if (!canStillBid(pkg) || ["awarded", "not_selected"].includes(inv.status)) return fail("closed", 409);

  const now = new Date().toISOString();
  if (body.choice === "bidding") {
    // Saying "Bidding" again after submitting a bid doesn't undo the bid.
    if (inv.status !== "bid_received") {
      await ctx.admin.from("bid_invites").update({ status: "bidding", responded_at: now, decline_reason: null, decline_note: null }).eq("id", inv.id);
    }
    return json({ ok: true });
  }
  if (body.choice === "not_bidding") {
    const reason = DECLINE_REASONS.has(String(body.reason)) ? String(body.reason) : "other";
    await ctx.admin.from("bid_invites").update({
      status: "not_bidding", responded_at: now, decline_reason: reason, decline_note: clean(body.note, 1000),
      // Withdrawing a submitted bid clears it.
      bid_amount: null, bid_notes: null, bid_received_on: null, bid_source: null, proposal_file_id: null,
    }).eq("id", inv.id);
    return json({ ok: true });
  }
  return fail("bad_choice");
}

function bidsPrefix(projectId: string): string {
  return `${projectId}/${BIDS_CATEGORY}/${BIDS_SUBFOLDER}/`;
}

async function bidUploadUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const loaded = await loadInvite(ctx, body.id);
  if (!loaded) return fail("not_found", 404);
  if (!canStillBid(loaded.pkg)) return fail("closed", 409);
  const name = safeFileName(body.file_name);
  if (!/\.pdf$/i.test(name)) return fail("pdf_only");
  const path = `${bidsPrefix(loaded.pkg.project_id)}${Date.now()}-vendor-${loaded.invite.id.slice(0, 8)}-${name}`;
  const { data, error } = await ctx.admin.storage.from(DOCS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error || new Error("no upload url");
  return json({ ok: true, bucket: DOCS_BUCKET, path, token: data.token, signed_url: data.signedUrl });
}

async function fileExists(ctx: VendorContext, bucket: string, path: string): Promise<boolean> {
  const folder = path.split("/").slice(0, -1).join("/");
  const name = path.split("/").pop();
  const { data } = await ctx.admin.storage.from(bucket).list(folder, { search: name });
  return (data || []).some((o: Row) => o.name === name);
}

async function submitBid(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const loaded = await loadInvite(ctx, body.id);
  if (!loaded) return fail("not_found", 404);
  const { invite: inv, pkg } = loaded;
  if (!canStillBid(pkg) || ["awarded", "not_selected"].includes(inv.status)) return fail("closed", 409);

  const amount = Number(String(body.amount ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999) return fail("bad_amount", 400, { fields: ["amount"] });
  const path = String(body.path || "");
  const marker = `-vendor-${inv.id.slice(0, 8)}-`;
  if (!path.startsWith(bidsPrefix(pkg.project_id)) || !path.includes(marker) || path.includes("..")) return fail("missing_file", 400, { fields: ["file"] });
  if (!(await fileExists(ctx, DOCS_BUCKET, path))) return fail("missing_file", 400, { fields: ["file"] });

  const { data: project } = await ctx.admin.from("projects").select("name").eq("id", pkg.project_id).maybeSingle();
  const original = safeFileName(body.file_name || path.split("/").pop());
  const fileName = `${companyName(ctx)} - Bid - ${pkg.name} - ${original}`.replace(/[\\/]/g, "-").slice(0, 200);
  const { data: fileRow, error: fileError } = await ctx.admin.from("project_files").insert({
    project_id: pkg.project_id, category: BIDS_CATEGORY, subfolder: BIDS_SUBFOLDER, sub_subfolder: null,
    bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "bid",
    uploaded_by_name: `${ctx.user.name || ctx.user.email} (${companyName(ctx)}, Vendor Portal)`,
  }).select("id").single();
  if (fileError) throw fileError;

  const now = new Date();
  const { error } = await ctx.admin.from("bid_invites").update({
    status: "bid_received",
    bid_amount: Math.round(amount * 100) / 100,
    bid_notes: clean(body.notes, 2000),
    bid_received_on: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now),
    bid_source: "portal",
    proposal_file_id: fileRow.id,
    submitted_by_vendor_user: ctx.user.id,
    responded_at: now.toISOString(),
    decline_reason: null, decline_note: null,
  }).eq("id", inv.id);
  if (error) throw error;

  // Let Leeward know.
  const amountText = formatMoney(amount);
  const projectName = project?.name || "a project";
  const staffLink = `${STAFF_PORTAL_URL}/pages/project-bid-invites.html?id=${pkg.project_id}`;
  if (pkg.created_by) {
    await notifyStaff(ctx.admin, [pkg.created_by], {
      title: "Bid submitted",
      message: `${companyName(ctx)} submitted a bid of ${amountText} for ${pkg.name} on ${projectName}.`,
      type: "bid_submitted", link_url: staffLink, link_label: "View bids",
    });
  }
  if (pkg.contact_email) {
    const subject = `Bid submitted – ${companyName(ctx)} – ${projectName} – ${pkg.name}`;
    const text = `${companyName(ctx)} submitted a bid of ${amountText} for ${pkg.name} on ${projectName} through the Vendor Portal.\n\nSubmitted by: ${ctx.user.name || ""} <${ctx.user.email}>\n${clean(body.notes, 2000) ? `Notes: ${clean(body.notes, 2000)}\n` : ""}\nThe proposal is filed in the project's Files › Contracts & Procurement › Bids.${STAFF_PORTAL_URL ? `\n\n${staffLink}` : ""}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222">${text.split("\n").map((l) => l ? l.replace(/&/g, "&amp;").replace(/</g, "&lt;") : "").join("<br>")}</div>`;
    const sent = await sendEmail({ to: pkg.contact_email, subject, html, text });
    if (!sent.ok) console.error("vendor-api: bid notification email failed:", sent.error);
  }

  return json({ ok: true });
}

async function profile(ctx: VendorContext) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const c = ctx.company!;
  const { data: team } = await ctx.admin.from("vendor_users")
    .select("id, name, email, title, phone, role, status, last_sign_in_at, created_at")
    .eq("company_id", c.id).in("status", ["active"]).order("created_at");
  // Trades / tags Leeward has on the vendor (read-only for the vendor).
  const { data: tagRows } = await ctx.admin.from("company_tags").select("tag_id").eq("company_id", c.id);
  const tagIds = (tagRows || []).map((r: Row) => r.tag_id);
  const { data: tags } = tagIds.length
    ? await ctx.admin.from("vendor_tags").select("id, name, category_id").in("id", tagIds)
    : { data: [] };
  const catIds = [...new Set((tags || []).map((t: Row) => t.category_id))];
  const { data: cats } = catIds.length
    ? await ctx.admin.from("vendor_tag_categories").select("id, name, sort_order").in("id", catIds)
    : { data: [] };
  const catById = new Map((cats || []).map((k: Row) => [k.id, k]));
  const tagList = (tags || []).map((t: Row) => ({ name: t.name, category: (catById.get(t.category_id) as Row)?.name || "", sort: (catById.get(t.category_id) as Row)?.sort_order ?? 0 }))
    .sort((a: Row, b: Row) => a.sort - b.sort || String(a.name).localeCompare(String(b.name)))
    .map(({ name, category }: Row) => ({ name, category }));
  return json({
    ok: true,
    company: {
      legal_name: c.Name, friendly_name: c.FriendlyName || null, street: c.Street, city: c.City, state: c.State, zip: c.Zip,
      tax_id: maskTaxId(c["SSN/FID"]),
      w9: { on_file: Boolean(c.W9FilePath), updated_at: c.W9UpdatedAt || null, exempt: Boolean(c.W9Exempt) },
      coi: { on_file: Boolean(c.COIFilePath), expires_on: c.COIExpiresOn || null, exempt: Boolean(c.COIExempt) },
      tags: tagList,
    },
    team: (team || []).map((t: Row) => ({ ...t, is_me: t.id === ctx.user.id })),
    is_holder: isHolder(ctx),
  });
}

async function updateCompany(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  if (!isHolder(ctx)) return fail("holder_only", 403);
  const patch = {
    FriendlyName: clean(body.friendly_name, 200),
    Street: clean(body.street, 200),
    City: clean(body.city, 100),
    State: clean(body.state, 2)?.toUpperCase() || null,
    Zip: clean(body.zip, 10),
  };
  const missing = Object.entries(patch).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return fail("missing_fields", 400, { fields: missing });
  const { error } = await ctx.admin.from("Companies").update(patch).eq("id", ctx.company!.id);
  if (error) throw error;
  return json({ ok: true });
}

async function docUploadUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const bucket = DOC_BUCKETS[String(body.kind)];
  if (!bucket) return fail("bad_kind");
  const name = safeFileName(body.file_name);
  if (!/\.pdf$/i.test(name)) return fail("pdf_only");
  const path = `vendor-portal/${ctx.company!.id}/${Date.now()}-${name}`;
  const { data, error } = await ctx.admin.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) throw error || new Error("no upload url");
  return json({ ok: true, bucket, path, token: data.token, signed_url: data.signedUrl });
}

async function saveDoc(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const kind = String(body.kind);
  const bucket = DOC_BUCKETS[kind];
  if (!bucket) return fail("bad_kind");
  // COI PDFs are per project now (save_project_coi).
  if (kind === "coi") return fail("bad_kind");
  const path = String(body.path || "");
  if (!path.startsWith(`vendor-portal/${ctx.company!.id}/`) || path.includes("..")) return fail("missing_file", 400, { fields: ["file"] });
  if (!(await fileExists(ctx, bucket, path))) return fail("missing_file", 400, { fields: ["file"] });

  let patch: Row;
  if (kind === "coi") {
    const expires = String(body.expires_on || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return fail("missing_fields", 400, { fields: ["expires_on"] });
    patch = { COIFilePath: path, COIExpiresOn: expires };
  } else {
    patch = { W9FilePath: path, W9UpdatedAt: new Date().toISOString() };
    const taxId = clean(body.ssn_fid, 20);
    if (taxId) {
      if (!/^[0-9]{9}$/.test(taxId.replace(/[^0-9]/g, ""))) return fail("bad_tax_id", 400, { fields: ["ssn_fid"] });
      patch["SSN/FID"] = taxId;
    }
  }
  const { error } = await ctx.admin.from("Companies").update(patch).eq("id", ctx.company!.id);
  if (error) throw error;

  const label = kind === "coi" ? `a new COI (expires ${body.expires_on})` : "a new W-9";
  const editors = await staffWithPermission(ctx.admin, "vendors.add_edit_vendor");
  await notifyStaff(ctx.admin, editors.map((s: Row) => s.id), {
    title: kind === "coi" ? "Vendor uploaded a COI" : "Vendor uploaded a W-9",
    message: `${companyName(ctx)} uploaded ${label} on the Vendor Portal.`,
    type: "vendor_document",
    link_url: `${STAFF_PORTAL_URL}/pages/vendor.html?id=${ctx.company!.id}`,
    link_label: "View vendor",
  });
  return json({ ok: true });
}

// ---- My Projects: one folder per awarded project -------------------------

// Awarded invites for this company, grouped by project.
async function awardedProjects(ctx: VendorContext, onlyProjectId?: string) {
  // Was 7 queries one after another; now 3 rounds, each run in parallel.
  // Every query's error is checked (must) so a failed lookup is a visible
  // error, not a project with a missing contract / COI / name.
  // Round 1: awarded invites (with their package) + direct assignments.
  const [invRows, assigned] = await Promise.all([
    ctx.admin.from("bid_invites")
      .select("id, package_id, bid_amount, proposal_file_id, coi_requested_at, coi_received_at, coi_file_id, bid_packages(id, name, project_id, awarded_at, contact_name, contact_email, contact_phone)")
      .eq("company_id", ctx.company!.id).eq("status", "awarded"),
    // Projects Leeward added this vendor to directly (vendor page › Manage Projects).
    ctx.admin.from("vendor_project_assignments")
      .select("id, project_id, scope, created_at, coi_requested_at, coi_received_at, coi_file_id, hidden")
      .eq("company_id", ctx.company!.id),
  ]).then((rs) => rs.map(must));
  const invs = invRows.map((r: Row) => { const pkg = one(r.bid_packages); delete r.bid_packages; return { r, pkg }; });
  const pkgs = invs.map((x: Row) => x.pkg).filter(Boolean);
  const pkgById = new Map(pkgs.map((p: Row) => [p.id, p]));
  const invsOnly = invs.map((x: Row) => x.r);
  // Projects Leeward removed from this vendor (Manage Projects › Remove) stay out of the portal.
  const hiddenIds = new Set(assigned.filter((a: Row) => a.hidden).map((a: Row) => a.project_id));
  const projectIds = [...new Set([
    ...pkgs.map((p: Row) => p.project_id),
    ...assigned.map((a: Row) => a.project_id),
  ])].filter((id) => id && !hiddenIds.has(id) && (!onlyProjectId || id === onlyProjectId));

  // Round 2: the projects, their COI templates and this vendor's contracts.
  const [projects, templates, contractRows] = projectIds.length
    ? await Promise.all([
      ctx.admin.from("projects").select("id, name, site_address, site_city, site_state, site_zip").in("id", projectIds),
      // Leeward's COI template for each project (sample COI with the coverage it needs).
      ctx.admin.from("project_coi_templates").select("project_id, project_file_id, updated_at").in("project_id", projectIds),
      // This vendor's contract on each project (staff upload it on the project's Accounts page).
      ctx.admin.from("project_vendor_contracts")
        .select("id, project_id, file_id, signed_file_id, not_needed, signed_at, signed_in_portal, signer_name")
        .eq("company_id", ctx.company!.id).in("project_id", projectIds),
    ]).then((rs) => rs.map(must))
    : [[], [], []];
  const templateByProject = new Map(templates.map((t: Row) => [t.project_id, t]));
  const contractByProject = new Map(contractRows.map((c: Row) => [c.project_id, c]));

  // Round 3: file names for everything above.
  const fileIds = [...new Set([
    ...contractRows.flatMap((c: Row) => [c.file_id, c.signed_file_id]),
    ...invsOnly.flatMap((r: Row) => [r.coi_file_id, r.proposal_file_id]),
    ...assigned.map((a: Row) => a.coi_file_id),
    ...templates.map((t: Row) => t.project_file_id),
  ].filter(Boolean))];
  const files = fileIds.length
    ? must(await ctx.admin.from("project_files").select("id, file_name, created_at").in("id", fileIds))
    : [];
  const fileById = new Map((files || []).map((f: Row) => [f.id, f]));

  return (projects || []).map((p: Row) => {
    const mineInv = invsOnly.filter((r: Row) => (pkgById.get(r.package_id) as Row)?.project_id === p.id);
    const mineAsg = (assigned || []).filter((a: Row) => a.project_id === p.id);
    const mine = [...mineInv, ...mineAsg];   // COI columns are the same on both
    const withCoi = mine.filter((r: Row) => r.coi_file_id).sort((a: Row, b: Row) => String(b.coi_received_at).localeCompare(String(a.coi_received_at)))[0];
    const requested = mine.map((r: Row) => r.coi_requested_at).filter(Boolean).sort().pop() || null;
    const received = withCoi?.coi_received_at || null;
    const outstanding = mine.some((r: Row) => r.coi_requested_at && !r.coi_received_at);
    const k: Row = contractByProject.get(p.id) || null;
    const kFile = (id: unknown) => id && fileById.get(id) ? { id, name: (fileById.get(id) as Row).file_name } : null;
    const contract = {
      status: k?.not_needed ? "not_needed" : k?.signed_file_id ? "signed" : k?.file_id ? "to_sign" : "waiting",
      file: kFile(k?.file_id),
      signed_file: kFile(k?.signed_file_id),
      signed_at: k?.signed_at || null,
      signed_in_portal: Boolean(k?.signed_in_portal),
      signer_name: k?.signer_name || null,
    };
    const c = ctx.company!;
    const checklist = {
      contract: contract.status === "signed" || contract.status === "not_needed",
      w9: Boolean(c.W9FilePath) || Boolean(c.W9Exempt),
      coi: Boolean(withCoi && fileById.get(withCoi.coi_file_id)) || Boolean(c.COIExempt),
    };
    return {
      contract,
      checklist,
      locked: !(checklist.contract && checklist.w9 && checklist.coi),
      id: p.id,
      name: p.name,
      location: [p.site_address, [p.site_city, p.site_state].filter(Boolean).join(", "), p.site_zip].filter(Boolean).join(" "),
      scopes: [
        ...mineInv.map((r: Row) => {
          const pkg: Row = pkgById.get(r.package_id) || {};
          return {
            invite_id: r.id, name: pkg.name, amount: r.bid_amount, awarded_at: pkg.awarded_at,
            contact_name: pkg.contact_name, contact_email: pkg.contact_email, contact_phone: pkg.contact_phone,
            proposal: r.proposal_file_id && fileById.get(r.proposal_file_id) ? { id: r.proposal_file_id, name: (fileById.get(r.proposal_file_id) as Row).file_name } : null,
          };
        }),
        ...mineAsg.map((a: Row) => ({
          assignment_id: a.id, name: a.scope || null, amount: null, awarded_at: a.created_at,
          contact_name: null, contact_email: null, contact_phone: null, proposal: null,
        })),
      ],
      coi_template: (() => {
        const t: Row = templateByProject.get(p.id);
        const f: Row = t && fileById.get(t.project_file_id);
        return f ? { id: t.project_file_id, name: f.file_name, updated_at: t.updated_at } : null;
      })(),
      coi: {
        requested_at: requested,
        received_at: received,
        needed: outstanding,
        file: withCoi && fileById.get(withCoi.coi_file_id) ? { id: withCoi.coi_file_id, name: (fileById.get(withCoi.coi_file_id) as Row).file_name, uploaded_at: received } : null,
      },
    };
  }).sort((a: Row, b: Row) => Number(b.coi.needed) - Number(a.coi.needed) || String(a.name).localeCompare(String(b.name)));
}

// A locked project shows only its name, location and the paperwork checklist.
function lockedView(p: Row): Row {
  return p.locked ? { ...p, scopes: [] } : p;
}

async function projectsList(ctx: VendorContext) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const projects = (await awardedProjects(ctx)).map(lockedView);
  return json({ ok: true, projects, coi_exempt: Boolean(ctx.company!.COIExempt) });
}

function validProjectId(id: unknown): string | null {
  const s = String(id || "");
  return /^[0-9a-f-]{36}$/i.test(s) ? s : null;
}

async function projectOne(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const id = validProjectId(body.id);
  const [project] = id ? await awardedProjects(ctx, id) : [];
  if (!project) return fail("not_found", 404);
  return json({
    ok: true, project: lockedView(project),
    company_coi: { expires_on: ctx.company!.COIExpiresOn || null, exempt: Boolean(ctx.company!.COIExempt) },
  });
}

const VENDOR_FILES_SUBFOLDER = "vendors";

async function projectCoiUploadUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const id = validProjectId(body.project_id);
  const [project] = id ? await awardedProjects(ctx, id) : [];
  if (!project) return fail("not_found", 404);
  const name = safeFileName(body.file_name);
  if (!/\.pdf$/i.test(name)) return fail("pdf_only");
  const path = `${project.id}/${BIDS_CATEGORY}/${VENDOR_FILES_SUBFOLDER}/${Date.now()}-coi-${ctx.company!.id}-${name}`;
  const { data, error } = await ctx.admin.storage.from(DOCS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error || new Error("no upload url");
  return json({ ok: true, bucket: DOCS_BUCKET, path, token: data.token, signed_url: data.signedUrl });
}

async function saveProjectCoi(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const id = validProjectId(body.project_id);
  const [project] = id ? await awardedProjects(ctx, id) : [];
  if (!project) return fail("not_found", 404);
  const path = String(body.path || "");
  const prefix = `${project.id}/${BIDS_CATEGORY}/${VENDOR_FILES_SUBFOLDER}/`;
  if (!path.startsWith(prefix) || !path.includes(`-coi-${ctx.company!.id}-`) || path.includes("..")) return fail("missing_file", 400, { fields: ["file"] });
  if (!(await fileExists(ctx, DOCS_BUCKET, path))) return fail("missing_file", 400, { fields: ["file"] });

  const original = safeFileName(body.file_name || path.split("/").pop());
  const fileName = `${companyName(ctx)} - COI - ${original}`.replace(/[\\/]/g, "-").slice(0, 200);
  const { data: fileRow, error: fileError } = await ctx.admin.from("project_files").insert({
    project_id: project.id, category: BIDS_CATEGORY, subfolder: VENDOR_FILES_SUBFOLDER, sub_subfolder: null,
    bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "bid",
    uploaded_by_name: `${ctx.user.name || ctx.user.email} (${companyName(ctx)}, Vendor Portal)`,
  }).select("id").single();
  if (fileError) throw fileError;

  const now = new Date().toISOString();
  const inviteIds = project.scopes.map((sc: Row) => sc.invite_id).filter(Boolean);
  const assignmentIds = project.scopes.map((sc: Row) => sc.assignment_id).filter(Boolean);
  if (inviteIds.length) {
    const { error } = await ctx.admin.from("bid_invites").update({ coi_file_id: fileRow.id, coi_received_at: now }).in("id", inviteIds);
    if (error) throw error;
  }
  if (assignmentIds.length) {
    const { error } = await ctx.admin.from("vendor_project_assignments").update({ coi_file_id: fileRow.id, coi_received_at: now }).in("id", assignmentIds);
    if (error) throw error;
  }

  // Bell for whoever set up those bid packages.
  // (Separate queries: bid_invites → bid_packages has two FKs, so an embed is ambiguous.)
  const { data: invRows } = await ctx.admin.from("bid_invites").select("package_id").in("id", inviteIds);
  const { data: pkgs } = await ctx.admin.from("bid_packages").select("created_by").in("id", [...new Set((invRows || []).map((r: Row) => r.package_id))]);
  const { data: asgRows } = assignmentIds.length
    ? await ctx.admin.from("vendor_project_assignments").select("added_by").in("id", assignmentIds)
    : { data: [] };
  const creators = [...new Set([...(pkgs || []).map((r: Row) => r.created_by), ...(asgRows || []).map((r: Row) => r.added_by)].filter(Boolean))];
  if (creators.length) {
    await notifyStaff(ctx.admin, creators, {
      title: "COI received",
      message: `${companyName(ctx)} uploaded their COI for ${project.name}.`,
      type: "vendor_document",
      link_url: inviteIds.length ? `${STAFF_PORTAL_URL}/pages/project-bid-invites.html?id=${project.id}` : `${STAFF_PORTAL_URL}/pages/vendor.html?id=${ctx.company!.id}`,
      link_label: inviteIds.length ? "View bids" : "View vendor",
    });
  }
  return json({ ok: true });
}

async function projectFileUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const id = validProjectId(body.project_id);
  const [project] = id ? await awardedProjects(ctx, id) : [];
  if (!project) return fail("not_found", 404);
  const fileId = String(body.file_id || "");
  const allowed = project.coi.file?.id === fileId || project.coi_template?.id === fileId
    || project.contract.file?.id === fileId || project.contract.signed_file?.id === fileId
    || (!project.locked && project.scopes.some((sc: Row) => sc.proposal?.id === fileId));
  if (!allowed) return fail("not_found", 404);
  const { data: file } = await ctx.admin.from("project_files").select("bucket, storage_path, file_name").eq("id", fileId).maybeSingle();
  if (!file) return fail("not_found", 404);
  const { data, error } = await ctx.admin.storage.from(file.bucket || DOCS_BUCKET).createSignedUrl(file.storage_path, LINK_SECONDS, { download: body.download ? file.file_name : undefined });
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl, name: file.file_name });
}

// ---- Sign the project's contract in the portal ------------------------------

const MAX_SIGNATURE_BYTES = 300 * 1024;

function wrapText(text: string, font: Row, size: number, width: number): string[] {
  const words = String(text || "").split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

async function signContract(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const id = validProjectId(body.project_id);
  const [project] = id ? await awardedProjects(ctx, id) : [];
  if (!project) return fail("not_found", 404);
  if (project.contract.status === "signed") return fail("already_signed", 409);
  if (project.contract.status !== "to_sign" || !project.contract.file) return fail("no_contract", 409);

  const name = clean(body.name, 120);
  const title = clean(body.title, 120);
  const missing = [!name ? "name" : null, body.agree !== true ? "agree" : null].filter(Boolean);
  const png = String(body.signature_png || "");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(png);
  if (!m) missing.push("signature");
  if (missing.length) return fail("missing_fields", 400, { fields: missing });
  const sigBytes = Uint8Array.from(atob(m![1]), (ch) => ch.charCodeAt(0));
  if (sigBytes.length > MAX_SIGNATURE_BYTES) return fail("signature_too_big", 400, { fields: ["signature"] });

  const { data: contractRow } = await ctx.admin.from("project_vendor_contracts")
    .select("id, file_id, uploaded_by").eq("project_id", project.id).eq("company_id", ctx.company!.id).maybeSingle();
  if (!contractRow?.file_id) return fail("no_contract", 409);
  const { data: original } = await ctx.admin.from("project_files").select("bucket, storage_path, file_name").eq("id", contractRow.file_id).maybeSingle();
  if (!original) return fail("no_contract", 409);
  const { data: blob, error: dlError } = await ctx.admin.storage.from(original.bucket || DOCS_BUCKET).download(original.storage_path);
  if (dlError || !blob) throw dlError || new Error("contract download failed");
  const originalBytes = new Uint8Array(await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", originalBytes))).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Original pages, then one signature page.
  let pdf: Row;
  try { pdf = await PDFDocument.load(originalBytes, { ignoreEncryption: true }); }
  catch { return fail("bad_contract_pdf", 409); }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sig = await pdf.embedPng(sigBytes);
  const page = pdf.addPage([612, 792]);
  const now = new Date();
  const when = now.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "long" });
  const ink = rgb(0.08, 0.15, 0.23), soft = rgb(0.37, 0.43, 0.49);
  let y = 730;
  page.drawText("Electronic Signature", { x: 56, y, size: 20, font: bold, color: ink }); y -= 28;
  for (const line of wrapText(`${companyName(ctx)} signed this contract for ${project.name} electronically in The Leeward Group Vendor Portal.`, font, 11, 500)) {
    page.drawText(line, { x: 56, y, size: 11, font, color: soft }); y -= 16;
  }
  y -= 16;
  const sigW = Math.min(260, sig.width), sigH = sigW * (sig.height / sig.width);
  page.drawImage(sig, { x: 56, y: y - sigH, width: sigW, height: sigH }); y -= sigH + 6;
  page.drawLine({ start: { x: 56, y }, end: { x: 336, y }, thickness: 1, color: soft }); y -= 16;
  page.drawText(`${name}${title ? `, ${title}` : ""}`, { x: 56, y, size: 12, font: bold, color: ink }); y -= 34;
  const rows: [string, string][] = [
    ["Company", companyName(ctx)],
    ["Project", String(project.name || "")],
    ["Document", String(original.file_name || "")],
    ["Signed by", `${name}${title ? `, ${title}` : ""}`],
    ["Email", String(ctx.user.email || "")],
    ["Date / time", when],
    ["IP address", String(body._ip || "unknown")],
    ["Document fingerprint (SHA-256 of the unsigned PDF)", digest],
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: 56, y, size: 9, font: bold, color: soft }); y -= 13;
    for (const line of wrapText(value, font, 10, 500)) { page.drawText(line, { x: 56, y, size: 10, font, color: ink }); y -= 14; }
    y -= 6;
  }
  y -= 6;
  for (const line of wrapText(`By signing, ${name} agreed to sign this document electronically and that this electronic signature is the same as a handwritten one.`, font, 9, 500)) {
    page.drawText(line, { x: 56, y, size: 9, font, color: soft }); y -= 12;
  }
  const signedBytes = await pdf.save();

  const baseName = safeFileName(String(original.file_name || "contract.pdf").replace(/\.pdf$/i, ""));
  const path = `${project.id}/${BIDS_CATEGORY}/${VENDOR_FILES_SUBFOLDER}/${Date.now()}-contract-signed-${ctx.company!.id}-${baseName}.pdf`;
  const { error: upError } = await ctx.admin.storage.from(DOCS_BUCKET).upload(path, signedBytes, { contentType: "application/pdf", upsert: false });
  if (upError) throw upError;
  const fileName = `${companyName(ctx)} - Contract (Signed) - ${String(original.file_name || "").replace(/^.* - Contract - /, "")}`.replace(/[\\/]/g, "-").slice(0, 200);
  const { data: fileRow, error: fileError } = await ctx.admin.from("project_files").insert({
    project_id: project.id, category: BIDS_CATEGORY, subfolder: VENDOR_FILES_SUBFOLDER, sub_subfolder: null,
    bucket: DOCS_BUCKET, storage_path: path, file_name: fileName, source: "contract",
    uploaded_by_name: `${name} (${companyName(ctx)}, Vendor Portal)`,
  }).select("id").single();
  if (fileError) throw fileError;

  const { error } = await ctx.admin.from("project_vendor_contracts").update({
    signed_file_id: fileRow.id, signed_at: now.toISOString(), signed_in_portal: true,
    signer_name: name, signer_title: title, signer_email: ctx.user.email || null,
    signer_vendor_user_id: ctx.user.id, signer_ip: body._ip || null,
  }).eq("id", contractRow.id);
  if (error) throw error;

  if (contractRow.uploaded_by) {
    await notifyStaff(ctx.admin, [contractRow.uploaded_by], {
      title: "Contract signed",
      message: `${companyName(ctx)} signed their contract for ${project.name} on the Vendor Portal.`,
      type: "vendor_document",
      link_url: `${STAFF_PORTAL_URL}/pages/project-accounts.html?id=${project.id}`,
      link_label: "View accounts",
    });
  }
  return json({ ok: true });
}

async function setCoiDate(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const expires = String(body.expires_on || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return fail("missing_fields", 400, { fields: ["expires_on"] });
  const { error } = await ctx.admin.from("Companies").update({ COIExpiresOn: expires }).eq("id", ctx.company!.id);
  if (error) throw error;
  const editors = await staffWithPermission(ctx.admin, "vendors.add_edit_vendor");
  await notifyStaff(ctx.admin, editors.map((s: Row) => s.id), {
    title: "Vendor updated their COI date",
    message: `${companyName(ctx)} set their COI expiration date to ${expires} on the Vendor Portal (no PDF).`,
    type: "vendor_document",
    link_url: `${STAFF_PORTAL_URL}/pages/vendor.html?id=${ctx.company!.id}`,
    link_label: "View vendor",
  });
  return json({ ok: true });
}

async function docUrl(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  const kind = String(body.kind);
  const bucket = DOC_BUCKETS[kind];
  const path = kind === "coi" ? ctx.company!.COIFilePath : kind === "w9" ? ctx.company!.W9FilePath : null;
  if (!bucket || !path) return fail("not_found", 404);
  const name = `${companyName(ctx)} - ${kind === "coi" ? "COI" : "W-9"}.pdf`.replace(/[\\/]/g, "-");
  const { data, error } = await ctx.admin.storage.from(bucket).createSignedUrl(path, LINK_SECONDS, { download: body.download ? name : undefined });
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl, name });
}

async function teamAdd(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  if (!isHolder(ctx)) return fail("holder_only", 403);
  const email = normalizeEmail(body.email);
  const name = clean(body.name, 120);
  if (!name || !email) return fail("missing_fields", 400, { fields: [!name ? "name" : null, !email ? "email" : null].filter(Boolean) });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("bad_email", 400, { fields: ["email"] });

  const companyId = ctx.company!.id;
  const existing = await findVendorUserByEmail(ctx.admin, email);
  if (existing && (existing.company_id !== companyId || existing.status === "active" || existing.status === "pending")) {
    return fail(existing.company_id === companyId ? "already_on_team" : "email_in_use", 409, { fields: ["email"] });
  }

  // Link to (or create) the contact Leeward sees on the vendor page.
  const { data: contacts } = await ctx.admin.from("Contacts").select("id, Email, Email2").eq("company_id", companyId);
  let contactId = (contacts || []).find((c: Row) => normalizeEmail(c.Email) === email || normalizeEmail(c.Email2) === email)?.id ?? null;
  if (contactId == null) {
    const { data: created, error } = await ctx.admin.from("Contacts").insert({
      company_id: companyId, Name: name, Title: clean(body.title, 120), Email: email, MobilePhone: clean(body.phone, 40),
    }).select("id").single();
    if (error) throw error;
    contactId = created.id;
  }

  const row = {
    email, name, title: clean(body.title, 120), phone: clean(body.phone, 40), company_id: companyId,
    contact_id: contactId, role: "member", status: "active", language: ctx.user.language || "en", added_by: "vendor",
  };
  let userId: string;
  if (existing) {
    const { error } = await ctx.admin.from("vendor_users").update(row).eq("id", existing.id);
    if (error) throw error;
    userId = existing.id;
  } else {
    const { data: created, error } = await ctx.admin.from("vendor_users").insert(row).select("id").single();
    if (error) throw error;
    userId = created.id;
  }

  const link = await createLoginLink(ctx.admin, userId, { minutes: TEAM_INVITE_LINK_HOURS * 60 });
  const mail = renderTeamInviteEmail(lang(row.language), name, ctx.user.name || ctx.user.email, companyName(ctx), link, TEAM_INVITE_LINK_HOURS);
  const sent = await sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  return json({ ok: true, emailed: sent.ok });
}

async function teamRemove(ctx: VendorContext, body: Row) {
  const gate = needsCompany(ctx); if (gate) return gate;
  if (!isHolder(ctx)) return fail("holder_only", 403);
  const id = String(body.id || "");
  if (id === ctx.user.id) return fail("cant_remove_self");
  const { data: target } = await ctx.admin.from("vendor_users").select("id, company_id").eq("id", id).maybeSingle();
  if (!target || target.company_id !== ctx.company!.id) return fail("not_found", 404);
  await ctx.admin.from("vendor_users").update({ status: "disabled" }).eq("id", id);
  await ctx.admin.from("vendor_sessions").delete().eq("vendor_user_id", id);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------

const ACTIONS: Record<string, (ctx: VendorContext, body: Row) => Promise<Response>> = {
  me, set_language: setLanguage, update_me: updateMe, invites, invite, file_url: fileUrl, respond,
  bid_upload_url: bidUploadUrl, submit_bid: submitBid, profile, update_company: updateCompany,
  doc_upload_url: docUploadUrl, save_doc: saveDoc, set_coi_date: setCoiDate,
  projects: projectsList, project: projectOne, project_coi_upload_url: projectCoiUploadUrl,
  save_project_coi: saveProjectCoi, project_file_url: projectFileUrl, sign_contract: signContract, doc_url: docUrl, team_add: teamAdd, team_remove: teamRemove,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const action = String(body?.action || "");
  const handler = ACTIONS[action];
  if (!handler) return json({ ok: false, error: `Unknown action "${action}"` }, 400);
  try {
    const auth = await requireVendor(body.session);
    if (auth.error) return auth.error;
    // For the signature record (sign_contract). Never trusted from the client.
    body._ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || null;
    return await handler(auth.ctx, body);
  } catch (error) {
    console.error(`vendor-api ${action} failed:`, error);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
