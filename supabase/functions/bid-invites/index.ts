// Bid Invites — staff actions (called from the portal with the signed-in
// staff member's session):
//
//   { action: "preview", draft }                   → the invite email, for step 3 of the wizard
//   { action: "send", package_id, invite_ids? }
//       emails every invite on the package that hasn't gone out yet (or just
//       invite_ids — used to retry a failed one)
//   { action: "remind", invite_ids }               → reminder to vendors who haven't submitted a bid yet
//   { action: "award", package_id, invite_id, notify_winner, notify_others }
//       the winner's award email also asks for their COI PDF (unless the
//       vendor is COI-exempt); without the email, use request_coi
//   { action: "request_coi", invite_id }         → (re)sends the COI request to the awarded vendor
//   { action: "paperwork", project_id }          → every vendor on the project and where
//       their paperwork (contract, W-9, COI) stands, with review decisions
//   { action: "paperwork_decide", project_id, company_id, items, note? }
//       items: { contract|w9|coi: { decision: "approved"|"returned", note } }.
//       Only once everything is in. Sends all decisions to the vendor in one
//       email; the project unlocks for them when every item is approved.
//   award (when a COI is needed) and request_coi refuse with code "no_template"
//   until the project has a COI template (project_coi_templates).
//
// Every email's "View Invite & Bid" button signs the vendor into the Vendor
// Portal (VENDOR_PORTAL_URL). Emails go out in the language the vendor
// picked in the portal (English until they choose Spanish).
//
// Deploy:  supabase functions deploy bid-invites
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL, VENDOR_PORTAL_URL

import {
  CORS_HEADERS, isValidEmail, json, pause, requireStaffPermission, sendEmail, serviceClient,
} from "../_shared/bid-common.ts";
import { packageForEmail, renderBidEmail, renderPaperworkEmail } from "../_shared/bid-email.ts";
import { type Lang, TEAM_INVITE_LINK_HOURS, createLoginLink, lang, normalizeEmail } from "../_shared/vendor-common.ts";
import { ITEMS, ITEM_LABELS, type ItemKey, paperworkState } from "../_shared/paperwork.ts";

const SEND = "vendors.send_bid_invites";
const MANAGE = "projects.manage_bid_invites";

// deno-lint-ignore no-explicit-any
type Row = any;

// Each recipient's portal language (vendor_users.language), English if
// they haven't signed in / picked one.
// deno-lint-ignore no-explicit-any
async function languagesFor(admin: any, emails: string[]): Promise<Map<string, Lang>> {
  const wanted = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  const map = new Map<string, Lang>();
  if (!wanted.length) return map;
  const { data } = await admin.from("vendor_users").select("email, language").in("email", wanted);
  (data || []).forEach((u: Row) => map.set(normalizeEmail(u.email), u.language === "es" ? "es" : "en"));
  return map;
}

// deno-lint-ignore no-explicit-any
async function fileCount(admin: any, packageId: string): Promise<number> {
  const { count } = await admin.from("bid_package_files").select("id", { count: "exact", head: true }).eq("package_id", packageId);
  return count || 0;
}

async function loadPackage(packageId: string) {
  const admin = serviceClient();
  const { data: pkg, error } = await admin.from("bid_packages").select("*").eq("id", packageId).maybeSingle();
  if (error) throw error;
  if (!pkg) return null;
  const { data: project } = await admin
    .from("projects")
    .select("id, name, site_address, site_city, site_state, site_zip")
    .eq("id", pkg.project_id)
    .maybeSingle();
  return { pkg, project };
}

async function handlePreview(body: Row) {
  const draft = body.draft || {};
  const admin = serviceClient();
  const { data: project } = draft.project_id
    ? await admin.from("projects").select("id, name, site_address, site_city, site_state, site_zip").eq("id", draft.project_id).maybeSingle()
    : { data: null };
  const pkg = packageForEmail({
    name: draft.name || "Bid package",
    scope: draft.scope,
    location: draft.location,
    due_at: draft.due_at || new Date().toISOString(),
    walkthrough_at: draft.walkthrough_at,
    walkthrough_location: draft.walkthrough_location,
    questions_due_at: draft.questions_due_at,
    contact_name: draft.contact_name || "",
    contact_email: draft.contact_email || "",
    contact_phone: draft.contact_phone,
  }, project);
  const rendered = renderBidEmail("invite", pkg, {
    token: "preview",
    company_name: draft.sample_company_name || "Vendor Name",
    contact_name: draft.sample_contact_name || null,
  }, { lang: body.lang === "es" ? "es" : "en", fileCount: Array.isArray(draft.file_names) ? draft.file_names.length : 0 });
  return json({ ok: true, subject: rendered.subject, html: rendered.html });
}

async function handleSend(body: Row) {
  const packageId = String(body.package_id || "");
  if (!packageId) return json({ ok: false, error: "package_id is required" }, 400);

  const loaded = await loadPackage(packageId);
  if (!loaded) return json({ ok: false, error: "That bid invite doesn't exist anymore." }, 404);
  const { pkg, project } = loaded;
  if (pkg.status !== "open") return json({ ok: false, error: "This bid invite is closed." }, 400);

  const admin = serviceClient();

  let query = admin.from("bid_invites").select("*").eq("package_id", pkg.id).in("status", ["pending", "failed"]);
  if (Array.isArray(body.invite_ids) && body.invite_ids.length) query = query.in("id", body.invite_ids.map(String));
  const { data: invites, error } = await query.order("company_name");
  if (error) throw error;
  if (!invites?.length) return json({ ok: true, sent: 0, failed: [] });

  const files = await fileCount(admin, pkg.id);
  const langs = await languagesFor(admin, invites.map((i: Row) => i.contact_email));

  const emailPkg = packageForEmail(pkg, project);
  let sent = 0;
  const failed: { invite_id: string; company_name: string; error: string }[] = [];

  for (let i = 0; i < invites.length; i++) {
    const invite = invites[i];
    if (i > 0) await pause();
    if (!isValidEmail(invite.contact_email)) {
      const message = `"${invite.contact_email}" isn't a valid email address.`;
      await admin.from("bid_invites").update({ status: "failed", send_error: message }).eq("id", invite.id);
      failed.push({ invite_id: invite.id, company_name: invite.company_name, error: message });
      continue;
    }
    const email = renderBidEmail("invite", emailPkg, invite, { lang: langs.get(normalizeEmail(invite.contact_email)) || "en", fileCount: files });
    const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: pkg.contact_email });
    if (result.ok) {
      await admin.from("bid_invites").update({ status: "sent", sent_at: new Date().toISOString(), send_error: null }).eq("id", invite.id);
      sent++;
    } else {
      await admin.from("bid_invites").update({ status: "failed", send_error: result.error }).eq("id", invite.id);
      failed.push({ invite_id: invite.id, company_name: invite.company_name, error: result.error || "Unknown error" });
    }
  }

  return json({ ok: true, sent, failed });
}

async function handleRemind(body: Row) {
  const ids = Array.isArray(body.invite_ids) ? body.invite_ids.map(String) : [];
  if (!ids.length) return json({ ok: false, error: "invite_ids is required" }, 400);

  const admin = serviceClient();
  const { data: invites, error } = await admin.from("bid_invites").select("*").in("id", ids).in("status", ["sent", "viewed", "bidding"]);
  if (error) throw error;
  if (!invites?.length) return json({ ok: true, sent: 0, failed: [] });

  const packages = new Map<string, Row>();
  const langs = await languagesFor(admin, invites.map((i: Row) => i.contact_email));
  let sent = 0;
  const failed: { invite_id: string; company_name: string; error: string }[] = [];

  for (let i = 0; i < invites.length; i++) {
    const invite = invites[i];
    if (!packages.has(invite.package_id)) {
      const loaded = await loadPackage(invite.package_id);
      const files = loaded ? await fileCount(admin, loaded.pkg.id) : 0;
      packages.set(invite.package_id, loaded ? { ...loaded, files } : null);
    }
    const loaded = packages.get(invite.package_id);
    if (!loaded || loaded.pkg.status !== "open") continue;
    if (i > 0) await pause();
    const kind = invite.status === "bidding" ? "reminder_due" : "reminder_no_response";
    const email = renderBidEmail(kind, packageForEmail(loaded.pkg, loaded.project), invite, { lang: langs.get(normalizeEmail(invite.contact_email)) || "en", fileCount: loaded.files });
    const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: loaded.pkg.contact_email });
    if (result.ok) {
      await admin.from("bid_invites").update({ reminder_count: (invite.reminder_count || 0) + 1, last_reminded_at: new Date().toISOString() }).eq("id", invite.id);
      sent++;
    } else {
      failed.push({ invite_id: invite.id, company_name: invite.company_name, error: result.error || "Unknown error" });
    }
  }
  return json({ ok: true, sent, failed });
}

async function handleAward(body: Row, staffName: string) {
  const packageId = String(body.package_id || "");
  const inviteId = String(body.invite_id || "");
  if (!packageId || !inviteId) return json({ ok: false, error: "package_id and invite_id are required" }, 400);

  const loaded = await loadPackage(packageId);
  if (!loaded) return json({ ok: false, error: "That bid invite doesn't exist anymore." }, 404);
  const { pkg, project } = loaded;
  if (pkg.status !== "open") return json({ ok: false, error: "This bid invite has already been awarded or closed." }, 400);

  const admin = serviceClient();
  const { data: invites, error } = await admin.from("bid_invites").select("*").eq("package_id", pkg.id);
  if (error) throw error;
  const winner = (invites || []).find((i: Row) => i.id === inviteId);
  if (!winner) return json({ ok: false, error: "That vendor isn't on this bid invite." }, 400);
  if (winner.status !== "bid_received") return json({ ok: false, error: "This vendor hasn't submitted a bid yet." }, 400);

  const losers = (invites || []).filter((i: Row) => i.id !== inviteId && i.status === "bid_received");

  // The award asks the winner for a COI, so the project needs a COI template
  // first (vendors can't upload without one) — unless they're COI-exempt. (2026-11-10)
  const coiNeeded = await needsCoi(admin, winner.company_id);
  if (coiNeeded && !(await hasCoiTemplate(admin, pkg.project_id))) {
    return json({ ok: false, error: "Post this project's COI template before awarding. Vendors can't upload their COI without it.", code: "no_template" }, 409);
  }
  const now = new Date().toISOString();

  // Close the package first (only if it's still open, so two people
  // clicking Award at once can't both win), then the vendor statuses.
  const { data: closed, error: closeError } = await admin
    .from("bid_packages")
    .update({ status: "awarded", awarded_invite_id: winner.id, awarded_at: now, awarded_by_name: staffName })
    .eq("id", pkg.id)
    .eq("status", "open")
    .select("id");
  if (closeError) throw closeError;
  if (!closed?.length) return json({ ok: false, error: "This bid invite has already been awarded or closed." }, 409);

  // The COI PDF is only requested once a vendor is awarded the job (coiNeeded, above).
  const { error: winError } = await admin.from("bid_invites").update({ status: "awarded" }).eq("id", winner.id);
  if (winError) throw winError;
  if (losers.length) {
    const { error: loseError } = await admin.from("bid_invites").update({ status: "not_selected" }).in("id", losers.map((i: Row) => i.id));
    if (loseError) throw loseError;
  }

  const emailPkg = packageForEmail(pkg, project);
  const langs = await languagesFor(admin, [winner, ...losers].map((i: Row) => i.contact_email));
  const failed: { company_name: string; error: string }[] = [];
  let emailed = 0;
  let coiRequested = false;

  const toEmail: { invite: Row; kind: "awarded" | "not_selected" }[] = [];
  if (body.notify_winner) toEmail.push({ invite: winner, kind: "awarded" });
  if (body.notify_others) losers.forEach((invite: Row) => toEmail.push({ invite, kind: "not_selected" }));

  for (let i = 0; i < toEmail.length; i++) {
    const { invite, kind } = toEmail[i];
    if (i > 0) await pause();
    const email = renderBidEmail(kind, emailPkg, invite, { lang: langs.get(normalizeEmail(invite.contact_email)) || "en", coiRequest: kind === "awarded" && coiNeeded });
    const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: pkg.contact_email });
    if (result.ok) {
      emailed++;
      const sentAt = new Date().toISOString();
      // The award email doubles as the COI request (counted only once it's sent).
      const coiAsked = kind === "awarded" && coiNeeded ? { coi_requested_at: sentAt, coi_received_at: null } : {};
      await admin.from("bid_invites").update({ result_emailed_at: sentAt, ...coiAsked }).eq("id", invite.id);
      if (kind === "awarded" && coiNeeded) coiRequested = true;
    } else {
      failed.push({ company_name: invite.company_name, error: result.error || "Unknown error" });
    }
  }

  return json({ ok: true, emailed, failed, not_selected: losers.length, coi_requested: coiRequested });
}

// deno-lint-ignore no-explicit-any
async function needsCoi(admin: any, companyId: unknown): Promise<boolean> {
  if (companyId == null) return true;
  const { data } = await admin.from("Companies").select("COIExempt").eq("id", companyId).maybeSingle();
  return !data?.COIExempt;
}

// deno-lint-ignore no-explicit-any
async function hasCoiTemplate(admin: any, projectId: unknown): Promise<boolean> {
  if (projectId == null) return false;
  const { data } = await admin.from("project_coi_templates").select("project_id").eq("project_id", projectId).maybeSingle();
  return Boolean(data);
}

async function handleRequestCoi(body: Row) {
  const inviteId = String(body.invite_id || "");
  if (!inviteId) return json({ ok: false, error: "invite_id is required" }, 400);
  const admin = serviceClient();
  const { data: invite, error } = await admin.from("bid_invites").select("*").eq("id", inviteId).maybeSingle();
  if (error) throw error;
  if (!invite) return json({ ok: false, error: "That invite doesn't exist anymore." }, 404);
  if (invite.status !== "awarded") return json({ ok: false, error: "The COI is only requested from the awarded vendor." }, 400);
  if (!isValidEmail(invite.contact_email)) return json({ ok: false, error: "This vendor contact has no valid email." }, 400);
  const loaded = await loadPackage(invite.package_id);
  if (!loaded) return json({ ok: false, error: "That bid invite doesn't exist anymore." }, 404);
  if (!(await hasCoiTemplate(admin, loaded.pkg.project_id))) {
    return json({ ok: false, error: "Post this project's COI template first. Vendors can't upload their COI without it.", code: "no_template" }, 409);
  }
  const langs = await languagesFor(admin, [invite.contact_email]);
  const email = renderBidEmail("coi_request", packageForEmail(loaded.pkg, loaded.project), invite, { lang: langs.get(normalizeEmail(invite.contact_email)) || "en" });
  const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: loaded.pkg.contact_email });
  if (!result.ok) return json({ ok: false, error: result.error || "The email didn't send." }, 502);
  const now = new Date().toISOString();
  await admin.from("bid_invites").update({ coi_requested_at: now, coi_received_at: null }).eq("id", invite.id);
  return json({ ok: true, coi_requested_at: now });
}

// ---- Vendor paperwork review (2026-11-10) ---------------------------------

const DOCS_BUCKET = "project-documents";
const W9_BUCKET = "company-w9s";

// Every vendor on a project (awarded bid invites + vendors added directly),
// with their paperwork state. onlyCompanyId narrows it to one vendor.
// deno-lint-ignore no-explicit-any
async function loadPaperwork(admin: any, projectId: string, onlyCompanyId?: number) {
  const must = (res: Row) => { if (res.error) throw res.error; return res.data || []; };
  const pkgs = must(await admin.from("bid_packages").select("id").eq("project_id", projectId).neq("status", "draft"));
  const pkgIds = pkgs.map((p: Row) => p.id);
  const [invites, assigned, contracts, reviews] = await Promise.all([
    pkgIds.length
      ? admin.from("bid_invites").select("id, company_id, company_name, contact_email, coi_file_id, coi_received_at").in("package_id", pkgIds).eq("status", "awarded")
      : Promise.resolve({ data: [] }),
    admin.from("vendor_project_assignments").select("id, company_id, coi_file_id, coi_received_at, hidden").eq("project_id", projectId),
    admin.from("project_vendor_contracts").select("company_id, file_id, signed_file_id, not_needed, signed_at").eq("project_id", projectId),
    admin.from("project_vendor_reviews").select("*").eq("project_id", projectId),
  ]).then((rs) => rs.map(must));
  const rows = [...invites, ...assigned.filter((a: Row) => !a.hidden)].filter((r: Row) => r.company_id != null && (!onlyCompanyId || Number(r.company_id) === onlyCompanyId));
  const companyIds = [...new Set(rows.map((r: Row) => Number(r.company_id)))];
  if (!companyIds.length) return [];
  const companies = must(await admin.from("Companies").select("id, Name, FriendlyName, W9FilePath, W9Exempt, W9UpdatedAt, COIExempt").in("id", companyIds));
  const contractBy = new Map<number, Row>(contracts.map((k: Row) => [Number(k.company_id), k]));
  const reviewBy = new Map<number, Row>(reviews.map((r: Row) => [Number(r.company_id), r]));
  const fileIds = [...new Set([...contracts.map((k: Row) => k.signed_file_id), ...rows.map((r: Row) => r.coi_file_id)].filter(Boolean))];
  const files = fileIds.length ? must(await admin.from("project_files").select("id, file_name, bucket, storage_path, created_at").in("id", fileIds)) : [];
  const fileBy = new Map<string, Row>(files.map((f: Row) => [String(f.id), f]));

  return companies.map((c: Row) => {
    const mine = rows.filter((r: Row) => Number(r.company_id) === Number(c.id));
    const withCoi = mine.filter((r: Row) => r.coi_file_id && fileBy.get(String(r.coi_file_id)))
      .sort((a: Row, b: Row) => String(b.coi_received_at).localeCompare(String(a.coi_received_at)))[0];
    const k = contractBy.get(Number(c.id)) || null;
    const review = reviewBy.get(Number(c.id)) || null;
    const state = paperworkState({ contract: k, company: c, coiFileId: withCoi?.coi_file_id || null, review });
    return {
      company: c, contract: k, review, state,
      contactEmails: [...new Set(mine.map((r: Row) => normalizeEmail(r.contact_email)).filter(Boolean))] as string[],
      files: {
        contract: k?.signed_file_id ? fileBy.get(String(k.signed_file_id)) || null : null,
        coi: withCoi ? fileBy.get(String(withCoi.coi_file_id)) || null : null,
      },
    };
  }).sort((a: Row, b: Row) => String(a.company.FriendlyName || a.company.Name).localeCompare(String(b.company.FriendlyName || b.company.Name)));
}

// deno-lint-ignore no-explicit-any
async function signedUrl(admin: any, bucket: string, path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const { data } = await admin.storage.from(bucket).createSignedUrl(path, 60 * 10);
  return data?.signedUrl || null;
}

async function handlePaperwork(body: Row) {
  const projectId = String(body.project_id || "");
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);
  const admin = serviceClient();
  const list = await loadPaperwork(admin, projectId);
  const vendors = await Promise.all(list.map(async (v: Row) => {
    const doc = async (key: ItemKey) => {
      const it = v.state.items[key];
      let file = null;
      if (key === "w9" && v.company.W9FilePath) file = { name: "W-9.pdf", url: await signedUrl(admin, W9_BUCKET, v.company.W9FilePath), uploaded_at: v.company.W9UpdatedAt || null };
      else if (key !== "w9" && v.files[key]) file = { name: v.files[key].file_name, url: await signedUrl(admin, v.files[key].bucket || DOCS_BUCKET, v.files[key].storage_path), uploaded_at: key === "contract" ? v.contract?.signed_at || null : v.files[key].created_at };
      return { state: it.state, decision: it.decision, note: v.review?.[`${key}_note`] || null, file };
    };
    return {
      company_id: v.company.id,
      company_name: v.company.FriendlyName || v.company.Name,
      status: v.state.status,
      items: { contract: await doc("contract"), w9: await doc("w9"), coi: await doc("coi") },
      note: v.review?.note || null,
      last_decision: v.review?.last_decision || null,
      decided_at: v.review?.decided_at || null,
      decided_by_name: v.review?.decided_by_name || null,
      approved_at: v.review?.approved_at || null,
    };
  }));
  return json({ ok: true, vendors });
}

async function handlePaperworkDecide(body: Row, staffName: string) {
  const projectId = String(body.project_id || "");
  const companyId = Number(body.company_id);
  if (!projectId || !Number.isFinite(companyId)) return json({ ok: false, error: "project_id and company_id are required" }, 400);
  const admin = serviceClient();
  const [v] = await loadPaperwork(admin, projectId, companyId);
  if (!v) return json({ ok: false, error: "That vendor isn't on this project." }, 404);
  if (v.state.status === "approved") return json({ ok: false, error: "This vendor's paperwork is already approved." }, 409);
  if (v.state.status !== "in_review") return json({ ok: false, error: "The vendor hasn't finished their paperwork yet. You can review it once the contract, W-9 and COI are all in." }, 409);

  const input = body.items || {};
  const decisions = {} as Record<ItemKey, { decision: "approved" | "returned"; note: string | null }>;
  for (const key of ITEMS) {
    if (v.state.items[key].state === "exempt") { decisions[key] = { decision: "approved", note: null }; continue; }
    const d = String(input[key]?.decision || "");
    const note = String(input[key]?.note || "").trim().slice(0, 1000) || null;
    if (d !== "approved" && d !== "returned") return json({ ok: false, error: `Choose Approve or Return for the ${ITEM_LABELS.en[key]}.` }, 400);
    if (d === "returned" && !note) return json({ ok: false, error: `Add a note saying what's wrong with the ${ITEM_LABELS.en[key]}.` }, 400);
    decisions[key] = { decision: d, note: d === "returned" ? note : null };
  }
  const allApproved = ITEMS.every((key) => decisions[key].decision === "approved");
  const generalNote = String(body.note || "").trim().slice(0, 2000) || null;
  const now = new Date().toISOString();
  const ref = (key: ItemKey) => decisions[key].decision === "returned" ? v.state.items[key].ref : null;

  const { error } = await admin.from("project_vendor_reviews").upsert({
    project_id: projectId, company_id: companyId,
    contract_status: decisions.contract.decision, w9_status: decisions.w9.decision, coi_status: decisions.coi.decision,
    contract_note: decisions.contract.note, w9_note: decisions.w9.note, coi_note: decisions.coi.note,
    note: generalNote,
    contract_returned_file_id: ref("contract"), w9_returned_path: ref("w9"), coi_returned_file_id: ref("coi"),
    last_decision: allApproved ? "approved" : "returned",
    decided_at: now, decided_by_name: staffName,
    approved_at: allApproved ? now : null,
    updated_at: now,
  }, { onConflict: "project_id,company_id" });
  if (error) throw error;

  // Email the vendor: the awarded invite contacts who have a portal login,
  // else the account holder. Each gets a sign-in link to the project.
  const { data: project } = await admin.from("projects").select("id, name").eq("id", projectId).maybeSingle();
  const { data: users } = await admin.from("vendor_users").select("id, email, name, language, role, status").eq("company_id", companyId).eq("status", "active");
  const active = users || [];
  let recipients = active.filter((u: Row) => v.contactEmails.includes(normalizeEmail(u.email)));
  if (!recipients.length) recipients = active.filter((u: Row) => u.role === "holder");
  const companyName = v.company.FriendlyName || v.company.Name || "your company";
  let emailed = 0;
  const failed: string[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const u = recipients[i];
    if (i > 0) await pause();
    const lng = lang(u.language);
    const returned = ITEMS.filter((key) => decisions[key].decision === "returned").map((key) => ({ label: ITEM_LABELS[lng][key], note: decisions[key].note || "" }));
    const link = await createLoginLink(admin, u.id, { redirectTo: `project.html?id=${projectId}`, minutes: TEAM_INVITE_LINK_HOURS * 60 });
    const mail = renderPaperworkEmail(lng, u.name || companyName, companyName, project?.name || "your project", allApproved, returned, generalNote, link, TEAM_INVITE_LINK_HOURS);
    const result = await sendEmail({ to: u.email, subject: mail.subject, html: mail.html, text: mail.text });
    if (result.ok) emailed++; else failed.push(u.email);
  }
  return json({ ok: true, approved: allApproved, emailed, failed, no_recipient: recipients.length === 0 });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const action = String(body?.action || "");
  const needed = action === "preview" ? SEND
    : action === "send" ? [SEND, MANAGE]
    : action === "remind" || action === "award" || action === "request_coi" || action === "paperwork_decide" ? MANAGE
    : action === "paperwork" ? [SEND, MANAGE]
    : null;
  if (!needed) return json({ ok: false, error: `Unknown action "${action}"` }, 400);

  const auth = await requireStaffPermission(req, needed);
  if (auth.error) return auth.error;

  try {
    if (action === "preview") return await handlePreview(body);
    if (action === "send") return await handleSend(body);
    if (action === "remind") return await handleRemind(body);
    if (action === "request_coi") return await handleRequestCoi(body);
    if (action === "paperwork") return await handlePaperwork(body);
    if (action === "paperwork_decide") return await handlePaperworkDecide(body, auth.staff.full_name || auth.staff.username || "Staff");
    return await handleAward(body, auth.staff.full_name || auth.staff.username || "Staff");
  } catch (error) {
    console.error(`bid-invites ${action} failed:`, error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
