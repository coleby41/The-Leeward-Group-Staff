// Vendor Portal -- staff actions (called from the staff portal with the
// signed-in staff member's session; needs vendors.approve_applications).
//
//   { action: "approve", application_id }
//       Creates the vendor (Companies), their contact (Contacts), turns on
//       the applicant's portal login as the company's account holder, and
//       emails them a sign-in link.
//   { action: "reject", application_id, reason? }
//       Marks it rejected and emails the applicant (with the reason, if given).
//   { action: "w9_url", application_id }   -> a short-lived link to view the W-9
//   { action: "request_project_coi", company_id, project_id }   (vendors.add_edit_vendor)
//       After staff add a vendor to a project (vendor page › Manage Projects):
//       emails the vendor's account holder a 72-hour sign-in link that opens
//       that project's folder in the Vendor Portal to upload the COI.
//
// Deploy:  supabase functions deploy vendor-admin

import { CORS_HEADERS, json, requireStaffPermission, sendEmail, serviceClient } from "../_shared/bid-common.ts";
import { renderApprovedEmail, renderProjectCoiEmail, renderRejectedEmail } from "../_shared/bid-email.ts";
import { type Row, TEAM_INVITE_LINK_HOURS, clean, createLoginLink, lang, normalizeEmail } from "../_shared/vendor-common.ts";

const APPROVE = "vendors.approve_applications";

async function loadPending(admin: Row, id: string) {
  const { data } = await admin.from("vendor_applications").select("*").eq("id", id).maybeSingle();
  return data;
}

async function approve(body: Row, staff: Row) {
  const admin = serviceClient();
  const app = await loadPending(admin, String(body.application_id || ""));
  if (!app) return json({ ok: false, error: "That application doesn't exist anymore." }, 404);
  if (app.status !== "pending") return json({ ok: false, error: `This application was already ${app.status}.` }, 409);

  // Claim it first so two people approving at once can't make two vendors.
  const now = new Date().toISOString();
  const staffName = staff.full_name || staff.username || "Staff";
  const { data: claimed } = await admin.from("vendor_applications")
    .update({ status: "approved", reviewed_by: staff.id, reviewed_by_name: staffName, reviewed_at: now })
    .eq("id", app.id).eq("status", "pending").select("id");
  if (!claimed?.length) return json({ ok: false, error: "Someone else already reviewed this application." }, 409);

  let createdCompanyId: number | null = null;
  try {
    const { data: company, error: companyError } = await admin.from("Companies").insert({
      Name: app.legal_name,
      FriendlyName: app.friendly_name,
      Street: app.street,
      City: app.city,
      State: app.state,
      Zip: app.zip,
      "SSN/FID": app.ssn_fid,
      W9FilePath: app.w9_path,
      W9UpdatedAt: app.w9_path ? app.created_at : null,
      COIExpiresOn: app.coi_expires_on,
    }).select().single();
    if (companyError) throw companyError;
    createdCompanyId = company.id;

    const { data: contact, error: contactError } = await admin.from("Contacts").insert({
      company_id: company.id,
      Name: app.contact_name,
      Title: app.contact_title,
      Email: app.contact_email,
      WorkPhone: app.contact_phone,
    }).select("id").single();
    if (contactError) throw contactError;

    const { data: users } = await admin.from("vendor_users").select("id").eq("application_id", app.id);
    let userId = users?.[0]?.id;
    if (userId) {
      const { error } = await admin.from("vendor_users")
        .update({ company_id: company.id, contact_id: contact.id, status: "active", role: "holder" })
        .eq("id", userId);
      if (error) throw error;
    } else {
      const { data: created, error } = await admin.from("vendor_users").insert({
        email: app.contact_email, name: app.contact_name, title: app.contact_title, phone: app.contact_phone,
        company_id: company.id, contact_id: contact.id, application_id: app.id,
        role: "holder", status: "active", language: app.language, added_by: "application",
      }).select("id").single();
      if (error) throw error;
      userId = created.id;
    }

    await admin.from("vendor_applications").update({ company_id: company.id }).eq("id", app.id);

    const link = await createLoginLink(admin, userId, { minutes: TEAM_INVITE_LINK_HOURS * 60 });
    const email = renderApprovedEmail(lang(app.language), app.contact_name, app.legal_name, link, TEAM_INVITE_LINK_HOURS);
    const sent = await sendEmail({ to: app.contact_email, subject: email.subject, html: email.html, text: email.text });

    return json({ ok: true, company_id: company.id, emailed: sent.ok, email_error: sent.ok ? null : sent.error });
  } catch (error) {
    // Undo and put it back so it can be tried again.
    if (createdCompanyId !== null) {
      await admin.from("vendor_users").update({ company_id: null, contact_id: null, status: "pending" }).eq("application_id", app.id);
      await admin.from("Companies").delete().eq("id", createdCompanyId);
    }
    await admin.from("vendor_applications").update({ status: "pending", reviewed_by: null, reviewed_by_name: null, reviewed_at: null }).eq("id", app.id);
    throw error;
  }
}

async function reject(body: Row, staff: Row) {
  const admin = serviceClient();
  const app = await loadPending(admin, String(body.application_id || ""));
  if (!app) return json({ ok: false, error: "That application doesn't exist anymore." }, 404);
  if (app.status !== "pending") return json({ ok: false, error: `This application was already ${app.status}.` }, 409);
  const reason = clean(body.reason, 1000);

  const { data: claimed } = await admin.from("vendor_applications").update({
    status: "rejected", reject_reason: reason, reviewed_by: staff.id,
    reviewed_by_name: staff.full_name || staff.username || "Staff", reviewed_at: new Date().toISOString(),
  }).eq("id", app.id).eq("status", "pending").select("id");
  if (!claimed?.length) return json({ ok: false, error: "Someone else already reviewed this application." }, 409);

  const { data: users } = await admin.from("vendor_users").select("id").eq("application_id", app.id).eq("status", "pending");
  for (const u of users || []) {
    await admin.from("vendor_users").update({ status: "rejected" }).eq("id", u.id);
    await admin.from("vendor_sessions").delete().eq("vendor_user_id", u.id);
  }

  const email = renderRejectedEmail(lang(app.language), app.contact_name, app.legal_name, reason);
  const sent = await sendEmail({ to: app.contact_email, subject: email.subject, html: email.html, text: email.text });
  return json({ ok: true, emailed: sent.ok, email_error: sent.ok ? null : sent.error });
}

async function w9Url(body: Row) {
  const admin = serviceClient();
  const app = await loadPending(admin, String(body.application_id || ""));
  if (!app?.w9_path) return json({ ok: false, error: "No W-9 on this application." }, 404);
  const { data, error } = await admin.storage.from("company-w9s").createSignedUrl(app.w9_path, 60 * 10);
  if (error || !data) throw error || new Error("no url");
  return json({ ok: true, url: data.signedUrl });
}

// Who gets the email: the account holder, else any active login, else the
// vendor's first contact with an email (given a login, like a bid invite does).
async function recipientFor(admin: Row, companyId: number) {
  const { data: logins } = await admin.from("vendor_users").select("*").eq("company_id", companyId).eq("status", "active");
  const holder = (logins || []).find((u: Row) => u.role === "holder") || (logins || [])[0];
  if (holder) return holder;
  const { data: contacts } = await admin.from("Contacts").select("id, Name, Title, Email, MobilePhone, WorkPhone").eq("company_id", companyId).order("id");
  const c = (contacts || []).find((x: Row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x.Email || "").trim()));
  if (!c) return null;
  const email = normalizeEmail(c.Email);
  const { data: existing } = await admin.from("vendor_users").select("*").eq("email", email).maybeSingle();
  if (existing) return existing.company_id === companyId && existing.status !== "rejected" ? existing : null;
  const { data: created, error } = await admin.from("vendor_users").insert({
    email, name: c.Name || null, title: c.Title || null, phone: c.MobilePhone || c.WorkPhone || null,
    company_id: companyId, contact_id: c.id, role: "holder", status: "active", added_by: "staff",
  }).select().single();
  if (error) throw error;
  return created;
}

async function requestProjectCoi(body: Row) {
  const admin = serviceClient();
  const companyId = Number(body.company_id);
  const projectId = String(body.project_id || "");
  const { data: asg } = await admin.from("vendor_project_assignments").select("id").eq("company_id", companyId).eq("project_id", projectId).maybeSingle();
  if (!asg) return json({ ok: false, error: "Add the vendor to this project first." }, 404);
  const [{ data: company }, { data: project }] = await Promise.all([
    admin.from("Companies").select("id, Name, FriendlyName").eq("id", companyId).maybeSingle(),
    admin.from("projects").select("id, name").eq("id", projectId).maybeSingle(),
  ]);
  if (!company || !project) return json({ ok: false, error: "That vendor or project doesn't exist anymore." }, 404);
  const user = await recipientFor(admin, companyId);
  if (!user) return json({ ok: false, error: "This vendor has no contact with an email address to send it to." }, 400);
  const link = await createLoginLink(admin, user.id, { redirectTo: `project.html?id=${project.id}`, minutes: TEAM_INVITE_LINK_HOURS * 60 });
  const mail = renderProjectCoiEmail(lang(user.language), user.name || company.Name, company.Name, project.name, link, TEAM_INVITE_LINK_HOURS);
  const sent = await sendEmail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.ok) return json({ ok: false, error: sent.error || "The email didn't send." }, 502);
  await admin.from("vendor_project_assignments").update({ coi_requested_at: new Date().toISOString() }).eq("id", asg.id);
  return json({ ok: true, sent_to: user.email });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const action = String(body?.action || "");
  if (!["approve", "reject", "w9_url", "request_project_coi"].includes(action)) return json({ ok: false, error: `Unknown action "${action}"` }, 400);

  const auth = await requireStaffPermission(req, action === "request_project_coi" ? "vendors.add_edit_vendor" : APPROVE);
  if (auth.error) return auth.error;

  try {
    if (action === "request_project_coi") return await requestProjectCoi(body);
    if (action === "approve") return await approve(body, auth.staff);
    if (action === "reject") return await reject(body, auth.staff);
    return await w9Url(body);
  } catch (error) {
    console.error(`vendor-admin ${action} failed:`, error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
