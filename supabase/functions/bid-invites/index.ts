// Bid Invites — staff actions (called from the portal with the signed-in
// staff member's session):
//
//   { action: "preview", draft }                   → the invite email, for step 3 of the wizard
//   { action: "send", package_id, invite_ids? }
//       emails every invite on the package that hasn't gone out yet (or just
//       invite_ids — used to retry a failed one)
//   { action: "remind", invite_ids }               → reminder to vendors who haven't submitted a bid yet
//   { action: "award", package_id, invite_id, notify_winner, notify_others }
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
import { packageForEmail, renderBidEmail } from "../_shared/bid-email.ts";
import { type Lang, normalizeEmail } from "../_shared/vendor-common.ts";

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

  const toEmail: { invite: Row; kind: "awarded" | "not_selected" }[] = [];
  if (body.notify_winner) toEmail.push({ invite: winner, kind: "awarded" });
  if (body.notify_others) losers.forEach((invite: Row) => toEmail.push({ invite, kind: "not_selected" }));

  for (let i = 0; i < toEmail.length; i++) {
    const { invite, kind } = toEmail[i];
    if (i > 0) await pause();
    const email = renderBidEmail(kind, emailPkg, invite, { lang: langs.get(normalizeEmail(invite.contact_email)) || "en" });
    const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: pkg.contact_email });
    if (result.ok) {
      emailed++;
      await admin.from("bid_invites").update({ result_emailed_at: new Date().toISOString() }).eq("id", invite.id);
    } else {
      failed.push({ company_name: invite.company_name, error: result.error || "Unknown error" });
    }
  }

  return json({ ok: true, emailed, failed, not_selected: losers.length });
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
    : action === "remind" || action === "award" ? MANAGE
    : null;
  if (!needed) return json({ ok: false, error: `Unknown action "${action}"` }, 400);

  const auth = await requireStaffPermission(req, needed);
  if (auth.error) return auth.error;

  try {
    if (action === "preview") return await handlePreview(body);
    if (action === "send") return await handleSend(body);
    if (action === "remind") return await handleRemind(body);
    return await handleAward(body, auth.staff.full_name || auth.staff.username || "Staff");
  } catch (error) {
    console.error(`bid-invites ${action} failed:`, error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
