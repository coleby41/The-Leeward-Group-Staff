// Vendor Portal sign-in. Public (deploy with --no-verify-jwt): the portal
// calls it with just the publishable key.
//
//   { action: "request_link", email, lang? }
//       Emails a one-time sign-in link if that email belongs to a portal user
//       (approved, or still waiting for approval). Always answers { ok: true }
//       so nobody can use this to find out which emails have accounts.
//   { action: "verify_link", token }       -> { session, redirect_to }
//   { action: "invite_login", token }      -> { session, redirect_to }
//       The "View Invite & Bid" button in a bid invite email. Signs in the
//       person the invite was sent to (creating their portal login the first
//       time), until 14 days after bids are due. For the awarded vendor it
//       opens the project's folder (where the COI PDF is uploaded).
//   { action: "sign_out", session }
//
// Deploy:  supabase functions deploy vendor-auth --no-verify-jwt

import { CORS_HEADERS, json, sendEmail, serviceClient } from "../_shared/bid-common.ts";
import { renderSignInEmail } from "../_shared/bid-email.ts";
import {
  INVITE_LINK_GRACE_DAYS, LOGIN_LINK_MINUTES, type Row, createLoginLink, createSession,
  findVendorUserByEmail, lang, normalizeEmail, safeRedirect, sha256,
} from "../_shared/vendor-common.ts";

const MAX_LINKS_PER_15_MIN = 5;

async function requestLink(body: Row) {
  const email = normalizeEmail(body.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: true });
  const admin = serviceClient();
  const user = await findVendorUserByEmail(admin, email);
  if (!user || (user.status !== "active" && user.status !== "pending")) return json({ ok: true });

  // A little rate limiting, so the button can't be used to flood someone.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count } = await admin.from("vendor_login_tokens").select("id", { count: "exact", head: true })
    .eq("vendor_user_id", user.id).gte("created_at", since);
  if ((count || 0) >= MAX_LINKS_PER_15_MIN) return json({ ok: true });

  const link = await createLoginLink(admin, user.id, { redirectTo: safeRedirect(body.next) });
  const email_ = renderSignInEmail(lang(user.language), user.name || email, link, LOGIN_LINK_MINUTES);
  const result = await sendEmail({ to: user.email, subject: email_.subject, html: email_.html, text: email_.text });
  if (!result.ok) console.error("vendor-auth: sign-in email failed:", result.error);
  return json({ ok: true });
}

async function verifyLink(body: Row, req: Request) {
  const token = String(body.token || "");
  if (!token) return json({ ok: false, error: "link_invalid" }, 400);
  const admin = serviceClient();
  const { data: row } = await admin.from("vendor_login_tokens").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  if (!row || row.used_at) return json({ ok: false, error: "link_used" }, 400);
  if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, error: "link_expired" }, 400);

  // Mark it used first (only if nobody beat us to it), so it really is one-time.
  const { data: claimed } = await admin.from("vendor_login_tokens").update({ used_at: new Date().toISOString() })
    .eq("id", row.id).is("used_at", null).select("id");
  if (!claimed?.length) return json({ ok: false, error: "link_used" }, 400);

  const { data: user } = await admin.from("vendor_users").select("*").eq("id", row.vendor_user_id).maybeSingle();
  if (!user || (user.status !== "active" && user.status !== "pending")) return json({ ok: false, error: "account_closed" }, 403);

  const session = await createSession(admin, user.id, req.headers.get("user-agent"));
  return json({ ok: true, session, redirect_to: row.redirect_to || null, language: user.language });
}

async function inviteLogin(body: Row, req: Request) {
  const token = String(body.token || "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ ok: false, error: "link_invalid" }, 400);
  const admin = serviceClient();
  const { data: invite } = await admin.from("bid_invites")
    .select("id, package_id, company_id, contact_name, contact_email, status, coi_requested_at")
    .eq("token", token).maybeSingle();
  if (!invite || !invite.company_id || invite.status === "pending" || invite.status === "failed") return json({ ok: false, error: "link_invalid" }, 400);
  const { data: pkg } = await admin.from("bid_packages").select("due_at, status, project_id").eq("id", invite.package_id).maybeSingle();
  const DAY = 24 * 60 * 60 * 1000;
  // Usable until 14 days after bids are due -- or, for the awarded vendor,
  // 30 days after Leeward last asked for their COI (the "Upload COI" button).
  const usableUntil = Math.max(
    new Date(pkg?.due_at || 0).getTime() + INVITE_LINK_GRACE_DAYS * DAY,
    invite.status === "awarded" && invite.coi_requested_at ? new Date(invite.coi_requested_at).getTime() + 30 * DAY : 0,
  );
  if (Date.now() > usableUntil) return json({ ok: false, error: "link_expired" }, 400);

  const email = normalizeEmail(invite.contact_email);
  let user = await findVendorUserByEmail(admin, email);
  // Someone whose login was turned off (or whose application was rejected)
  // can't use an invite to get back in.
  if (user && user.status !== "active") return json({ ok: false, error: "account_closed" }, 403);
  if (!user) {
    // First time this person has used the portal: their login is created
    // from the invite. The first person at a company becomes its account
    // holder (the only one who can add/remove teammates).
    const { count: holders } = await admin.from("vendor_users").select("id", { count: "exact", head: true })
      .eq("company_id", invite.company_id).eq("role", "holder").eq("status", "active");
    const { data: contacts } = await admin.from("Contacts").select("id, Name, Title, Email, Email2, WorkPhone, MobilePhone")
      .eq("company_id", invite.company_id);
    const contact = (contacts || []).find((c: Row) => normalizeEmail(c.Email) === email || normalizeEmail(c.Email2) === email) || null;
    const { data: created, error } = await admin.from("vendor_users").insert({
      email,
      name: contact?.Name || invite.contact_name || null,
      title: contact?.Title || null,
      phone: contact?.MobilePhone || contact?.WorkPhone || null,
      company_id: invite.company_id,
      contact_id: contact?.id ?? null,
      role: (holders || 0) > 0 ? "member" : "holder",
      status: "active",
      added_by: "invite",
    }).select().single();
    if (error) throw error;
    user = created;
  }

  const session = await createSession(admin, user.id, req.headers.get("user-agent"));
  // Awarded: the "Upload COI" button opens that project's folder.
  const redirect = invite.status === "awarded" && pkg?.project_id ? `project.html?id=${pkg.project_id}` : `invite.html?id=${invite.id}`;
  return json({ ok: true, session, redirect_to: redirect, language: user.language });
}

async function signOut(body: Row) {
  const token = String(body.session || "");
  if (token) await serviceClient().from("vendor_sessions").delete().eq("token_hash", await sha256(token));
  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  let body: Row;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }
  const action = String(body?.action || "");
  try {
    if (action === "request_link") return await requestLink(body);
    if (action === "verify_link") return await verifyLink(body, req);
    if (action === "invite_login") return await inviteLogin(body, req);
    if (action === "sign_out") return await signOut(body);
    return json({ ok: false, error: `Unknown action "${action}"` }, 400);
  } catch (error) {
    console.error(`vendor-auth ${action} failed:`, error);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
