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
//   project_file_url { project_id, file_id, download? }   their COI / proposal on that project
//   doc_url { kind }           short-lived link to their W-9 / COI on file
//   team_add { name, email, title?, phone? }    (account holder)
//   team_remove { id }                          (account holder)
//
// Deploy:  supabase functions deploy vendor-api --no-verify-jwt

import { CORS_HEADERS, formatMoney, json, sendEmail, serviceClient } from "../_shared/bid-common.ts";
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
  const { data: rows, error } = await ctx.admin.from("bid_invites")
    .select("id, status, bid_amount, decline_reason, sent_at, viewed_at, responded_at, package_id, coi_requested_at, coi_received_at")
    .eq("company_id", ctx.company!.id)
    .not("status", "in", "(pending,failed)")
    .order("sent_at", { ascending: false });
  if (error) throw error;
  const packageIds = [...new Set((rows || []).map((r: Row) => r.package_id))];
  const { data: pkgs } = packageIds.length
    ? await ctx.admin.from("bid_packages").select("id, name, due_at, walkthrough_at, status, project_id").in("id", packageIds)
    : { data: [] };
  const projectIds = [...new Set((pkgs || []).map((p: Row) => p.project_id))];
  const { data: projects } = projectIds.length
    ? await ctx.admin.from("projects").select("id, name").in("id", projectIds)
    : { data: [] };
  const pkgById = new Map((pkgs || []).map((p: Row) => [p.id, p]));
  const projectById = new Map((projects || []).map((p: Row) => [p.id, p]));
  return json({
    ok: true,
    invites: (rows || []).map((r: Row) => {
      const pkg: Row = pkgById.get(r.package_id) || {};
      return {
        id: r.id, status: r.status, bid_amount: r.bid_amount, decline_reason: r.decline_reason, sent_at: r.sent_at,
        package_name: pkg.name, due_at: pkg.due_at, walkthrough_at: pkg.walkthrough_at, package_status: pkg.status,
        project_name: (projectById.get(pkg.project_id) as Row)?.name || "", project_id: pkg.project_id,
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
      w9: { on_file: Boolean(c.W9FilePath), updated_at: c.W9UpdatedAt || null },
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
  const { data: invs, error } = await ctx.admin.from("bid_invites")
    .select("id, package_id, bid_amount, proposal_file_id, coi_requested_at, coi_received_at, coi_file_id")
    .eq("company_id", ctx.company!.id).eq("status", "awarded");
  if (error) throw error;
  const pkgIds = [...new Set((invs || []).map((r: Row) => r.package_id))];
  const { data: pkgs } = pkgIds.length
    ? await ctx.admin.from("bid_packages").select("id, name, project_id, awarded_at, contact_name, contact_email, contact_phone").in("id", pkgIds)
    : { data: [] };
  const pkgById = new Map((pkgs || []).map((p: Row) => [p.id, p]));
  const projectIds = [...new Set((pkgs || []).map((p: Row) => p.project_id))].filter((id) => !onlyProjectId || id === onlyProjectId);
  const { data: projects } = projectIds.length
    ? await ctx.admin.from("projects").select("id, name, site_address, site_city, site_state, site_zip").in("id", projectIds)
    : { data: [] };
  const fileIds = [...new Set((invs || []).flatMap((r: Row) => [r.coi_file_id, r.proposal_file_id]).filter(Boolean))];
  const { data: files } = fileIds.length
    ? await ctx.admin.from("project_files").select("id, file_name, created_at").in("id", fileIds)
    : { data: [] };
  const fileById = new Map((files || []).map((f: Row) => [f.id, f]));

  return (projects || []).map((p: Row) => {
    const mine = (invs || []).filter((r: Row) => (pkgById.get(r.package_id) as Row)?.project_id === p.id);
    const withCoi = mine.filter((r: Row) => r.coi_file_id).sort((a: Row, b: Row) => String(b.coi_received_at).localeCompare(String(a.coi_received_at)))[0];
    const requested = mine.map((r: Row) => r.coi_requested_at).filter(Boolean).sort().pop() || null;
    const received = withCoi?.coi_received_at || null;
    const outstanding = mine.some((r: Row) => r.coi_requested_at && !r.coi_received_at);
    return {
      id: p.id,
      name: p.name,
      location: [p.site_address, [p.site_city, p.site_state].filter(Boolean).join(", "), p.site_zip].filter(Boolean).join(" "),
      scopes: mine.map((r: Row) => {
        const pkg: Row = pkgById.get(r.package_id) || {};
        return {
          invite_id: r.id, name: pkg.name, amount: r.bid_amount, awarded_at: pkg.awarded_at,
          contact_name: pkg.contact_name, contact_email: pkg.contact_email, contact_phone: pkg.contact_phone,
          proposal: r.proposal_file_id && fileById.get(r.proposal_file_id) ? { id: r.proposal_file_id, name: (fileById.get(r.proposal_file_id) as Row).file_name } : null,
        };
      }),
      coi: {
        requested_at: requested,
        received_at: received,
        needed: outstanding,
        file: withCoi && fileById.get(withCoi.coi_file_id) ? { id: withCoi.coi_file_id, name: (fileById.get(withCoi.coi_file_id) as Row).file_name, uploaded_at: received } : null,
      },
    };
  }).sort((a: Row, b: Row) => Number(b.coi.needed) - Number(a.coi.needed) || String(a.name).localeCompare(String(b.name)));
}

async function projectsList(ctx: VendorContext) {
  const gate = needsCompany(ctx); if (gate) return gate;
  return json({ ok: true, projects: await awardedProjects(ctx), coi_exempt: Boolean(ctx.company!.COIExempt) });
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
    ok: true, project,
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
  const inviteIds = project.scopes.map((sc: Row) => sc.invite_id);
  const { error } = await ctx.admin.from("bid_invites").update({ coi_file_id: fileRow.id, coi_received_at: now }).in("id", inviteIds);
  if (error) throw error;

  // Bell for whoever set up those bid packages.
  // (Separate queries: bid_invites → bid_packages has two FKs, so an embed is ambiguous.)
  const { data: invRows } = await ctx.admin.from("bid_invites").select("package_id").in("id", inviteIds);
  const { data: pkgs } = await ctx.admin.from("bid_packages").select("created_by").in("id", [...new Set((invRows || []).map((r: Row) => r.package_id))]);
  const creators = [...new Set((pkgs || []).map((r: Row) => r.created_by).filter(Boolean))];
  if (creators.length) {
    await notifyStaff(ctx.admin, creators, {
      title: "COI received",
      message: `${companyName(ctx)} uploaded their COI for ${project.name}.`,
      type: "vendor_document",
      link_url: `${STAFF_PORTAL_URL}/pages/project-bid-invites.html?id=${project.id}`,
      link_label: "View bids",
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
  const allowed = project.coi.file?.id === fileId || project.scopes.some((sc: Row) => sc.proposal?.id === fileId);
  if (!allowed) return fail("not_found", 404);
  const { data: file } = await ctx.admin.from("project_files").select("bucket, storage_path, file_name").eq("id", fileId).maybeSingle();
  if (!file) return fail("not_found", 404);
  const { data, error } = await ctx.admin.storage.from(file.bucket || DOCS_BUCKET).createSignedUrl(file.storage_path, LINK_SECONDS, { download: body.download ? file.file_name : undefined });
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl, name: file.file_name });
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
  const { data, error } = await ctx.admin.storage.from(bucket).createSignedUrl(path, LINK_SECONDS);
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl });
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
  save_project_coi: saveProjectCoi, project_file_url: projectFileUrl, doc_url: docUrl, team_add: teamAdd, team_remove: teamRemove,
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
    return await handler(auth.ctx, body);
  } catch (error) {
    console.error(`vendor-api ${action} failed:`, error);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
