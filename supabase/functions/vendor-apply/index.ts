// Vendor Portal: "New Vendor Portal Access Request" form. Public (deploy
// with --no-verify-jwt).
//
//   { action: "w9_upload_url", file_name }  -> { path, token }
//       A one-time upload slot for the applicant's W-9 (company-w9s bucket,
//       applications/ folder). The portal uploads the PDF straight there.
//   { action: "submit", ...fields, w9_path, lang }
//       Saves the application, creates the applicant's (pending) portal
//       login, emails them a confirmation with a sign-in link, and tells
//       the staff who approve applications.
//
// Deploy:  supabase functions deploy vendor-apply --no-verify-jwt

import { CORS_HEADERS, json, sendEmail, serviceClient } from "../_shared/bid-common.ts";
import { renderApplicationReceivedEmail, renderSignInEmail } from "../_shared/bid-email.ts";
import {
  LOGIN_LINK_MINUTES, type Row, STAFF_PORTAL_URL, clean, createLoginLink, findVendorUserByEmail,
  lang, normalizeEmail, notifyStaff, safeFileName, staffWithPermission,
} from "../_shared/vendor-common.ts";

const W9_BUCKET = "company-w9s";
const MAX_APPLICATIONS_PER_DAY_PER_EMAIL = 3;

async function w9UploadUrl(body: Row) {
  const name = safeFileName(body.file_name);
  if (!/\.pdf$/i.test(name)) return json({ ok: false, error: "pdf_only" }, 400);
  const path = `applications/${crypto.randomUUID()}/${Date.now()}-${name}`;
  const { data, error } = await serviceClient().storage.from(W9_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error || new Error("no upload url");
  return json({ ok: true, bucket: W9_BUCKET, path, token: data.token, signed_url: data.signedUrl });
}

async function submit(body: Row) {
  const f = {
    legal_name: clean(body.legal_name, 200),
    friendly_name: clean(body.friendly_name, 200),
    street: clean(body.street, 200),
    city: clean(body.city, 100),
    state: clean(body.state, 2)?.toUpperCase() || null,
    zip: clean(body.zip, 10),
    contact_name: clean(body.contact_name, 120),
    contact_title: clean(body.contact_title, 120),
    contact_email: normalizeEmail(body.contact_email),
    contact_phone: clean(body.contact_phone, 40),
    ssn_fid: clean(body.ssn_fid, 20),
    w9_path: clean(body.w9_path, 400),
    coi_expires_on: /^\d{4}-\d{2}-\d{2}$/.test(String(body.coi_expires_on || "")) ? String(body.coi_expires_on) : null,
    language: lang(body.lang),
  };

  const missing = Object.entries({
    legal_name: f.legal_name, friendly_name: f.friendly_name, street: f.street, city: f.city, state: f.state,
    zip: f.zip, contact_name: f.contact_name, contact_email: f.contact_email, contact_phone: f.contact_phone,
    ssn_fid: f.ssn_fid, w9_path: f.w9_path,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return json({ ok: false, error: "missing_fields", fields: missing }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contact_email)) return json({ ok: false, error: "bad_email", fields: ["contact_email"] }, 400);
  if (!/^[0-9]{9}$/.test(f.ssn_fid!.replace(/[^0-9]/g, ""))) return json({ ok: false, error: "bad_tax_id", fields: ["ssn_fid"] }, 400);
  if (!f.w9_path!.startsWith("applications/") || f.w9_path!.includes("..")) return json({ ok: false, error: "missing_fields", fields: ["w9_path"] }, 400);

  const admin = serviceClient();

  // The W-9 has to really be there.
  const folder = f.w9_path!.split("/").slice(0, -1).join("/");
  const fileName = f.w9_path!.split("/").pop();
  const { data: listed } = await admin.storage.from(W9_BUCKET).list(folder, { search: fileName });
  if (!(listed || []).some((o: Row) => o.name === fileName)) return json({ ok: false, error: "w9_missing", fields: ["w9_path"] }, 400);

  // Already has a login? Don't create a second application -- just send
  // them a sign-in link (same answer either way, so this can't be used to
  // check whether an email is registered).
  const existing = await findVendorUserByEmail(admin, f.contact_email);
  if (existing && (existing.status === "active" || existing.status === "pending")) {
    const link = await createLoginLink(admin, existing.id);
    const email = renderSignInEmail(lang(existing.language), existing.name || f.contact_name!, link, LOGIN_LINK_MINUTES);
    await sendEmail({ to: existing.email, subject: email.subject, html: email.html, text: email.text });
    return json({ ok: true });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await admin.from("vendor_applications").select("id", { count: "exact", head: true })
    .eq("contact_email", f.contact_email).gte("created_at", since);
  if ((count || 0) >= MAX_APPLICATIONS_PER_DAY_PER_EMAIL) return json({ ok: true });

  const { data: application, error: appError } = await admin.from("vendor_applications").insert(f).select().single();
  if (appError) throw appError;

  // A rejected applicant re-applying gets their old login row back.
  const userRow = {
    email: f.contact_email,
    name: f.contact_name,
    title: f.contact_title,
    phone: f.contact_phone,
    company_id: null,
    application_id: application.id,
    role: "holder",
    status: "pending",
    language: f.language,
    added_by: "application",
  };
  let userId: string;
  if (existing) {
    const { error } = await admin.from("vendor_users").update(userRow).eq("id", existing.id);
    if (error) throw error;
    userId = existing.id;
  } else {
    const { data: created, error } = await admin.from("vendor_users").insert(userRow).select("id").single();
    if (error) throw error;
    userId = created.id;
  }

  const link = await createLoginLink(admin, userId);
  const email = renderApplicationReceivedEmail(f.language, f.contact_name!, f.legal_name!, link);
  const sent = await sendEmail({ to: f.contact_email, subject: email.subject, html: email.html, text: email.text });
  if (!sent.ok) console.error("vendor-apply: confirmation email failed:", sent.error);

  const approvers = await staffWithPermission(admin, "vendors.approve_applications");
  await notifyStaff(admin, approvers.map((s: Row) => s.id), {
    title: "New vendor application",
    message: `${f.legal_name} applied for Vendor Portal access (${f.contact_name}, ${f.contact_email}).`,
    type: "vendor_application",
    link_url: `${STAFF_PORTAL_URL}/pages/vendors.html?applications=1`,
    link_label: "Review it",
  });

  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const action = String(body?.action || "");
  try {
    if (action === "w9_upload_url") return await w9UploadUrl(body);
    if (action === "submit") return await submit(body);
    return json({ ok: false, error: `Unknown action "${action}"` }, 400);
  } catch (error) {
    console.error(`vendor-apply ${action} failed:`, error);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
