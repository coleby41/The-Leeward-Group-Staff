// Shared by the Vendor Portal Edge Functions (vendor-auth, vendor-api,
// vendor-apply, vendor-admin) and bid-invites.
//
// Vendors never get a Supabase Auth session (see the top of
// sql/supabase-vendor-portal-setup.sql for why). Instead:
//   - a one-time sign-in link is emailed (vendor_login_tokens, 1 hour), or
//     the "View Invite & Bid" button in a bid invite is used (bid_invites.token);
//   - either one is exchanged for a session token (vendor_sessions, 30 days)
//     that the portal keeps in the browser and sends with every request.
// Only SHA-256 hashes of tokens are stored.
//
// Secrets (Supabase -> Edge Functions -> Secrets):
//   VENDOR_PORTAL_URL   the Vendor Portal's address, e.g.
//                       https://leeward-vendor-portal.vercel.app (no trailing slash)
//   STAFF_PORTAL_URL    optional -- the staff portal's address, used for links
//                       in staff notification emails
//   RESEND_API_KEY / RESEND_FROM_EMAIL / BID_FROM_EMAIL -- see bid-common.ts

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { json, serviceClient } from "./bid-common.ts";

export const PORTAL_URL = (Deno.env.get("VENDOR_PORTAL_URL") || "http://localhost:8788").replace(/\/+$/, "");
export const STAFF_PORTAL_URL = (Deno.env.get("STAFF_PORTAL_URL") || "").replace(/\/+$/, "");

export const LOGIN_LINK_MINUTES = 60;
export const TEAM_INVITE_LINK_HOURS = 72;
export const SESSION_DAYS = 30;
export const INVITE_LINK_GRACE_DAYS = 14;     // invite button works until 14 days after bids are due

export type Lang = "en" | "es";
export const lang = (value: unknown): Lang => (value === "es" ? "es" : "en");

// deno-lint-ignore no-explicit-any
export type Row = any;

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function clean(value: unknown, max = 300): string | null {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

export function safeFileName(name: unknown): string {
  const base = String(name || "file.pdf").split(/[\\/]/).pop() || "file.pdf";
  return base.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-120) || "file.pdf";
}

// Only paths inside the portal (no open redirects).
export function safeRedirect(value: unknown): string | null {
  const s = String(value || "").trim();
  if (!s) return null;
  if (!/^[a-z0-9-]+\.html(\?[a-zA-Z0-9=&_.%-]*)?$/.test(s)) return null;
  return s;
}

export async function findVendorUserByEmail(admin: SupabaseClient, email: string): Promise<Row | null> {
  if (!email) return null;
  // Emails are always stored lower-cased (every insert goes through
  // normalizeEmail), so an exact match is enough.
  const { data, error } = await admin.from("vendor_users").select("*").eq("email", email).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// A one-time sign-in link to the portal.
export async function createLoginLink(
  admin: SupabaseClient,
  vendorUserId: string,
  options: { redirectTo?: string | null; minutes?: number } = {},
): Promise<string> {
  const token = randomToken();
  const minutes = options.minutes ?? LOGIN_LINK_MINUTES;
  const { error } = await admin.from("vendor_login_tokens").insert({
    vendor_user_id: vendorUserId,
    token_hash: await sha256(token),
    redirect_to: options.redirectTo || null,
    expires_at: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  return `${PORTAL_URL}/auth.html#t=${encodeURIComponent(token)}`;
}

export async function createSession(admin: SupabaseClient, vendorUserId: string, userAgent: string | null): Promise<string> {
  const token = randomToken();
  const { error } = await admin.from("vendor_sessions").insert({
    vendor_user_id: vendorUserId,
    token_hash: await sha256(token),
    expires_at: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    user_agent: userAgent ? userAgent.slice(0, 300) : null,
  });
  if (error) throw error;
  await admin.from("vendor_users").update({ last_sign_in_at: new Date().toISOString() }).eq("id", vendorUserId);
  return token;
}

export interface VendorContext {
  admin: SupabaseClient;
  user: Row;              // vendor_users row
  company: Row | null;    // Companies row (null while the application is pending)
  sessionId: string;
}

// Looks up the session token the portal sent. Returns the vendor or an
// error Response to send back as-is.
export async function requireVendor(sessionToken: unknown): Promise<{ ctx: VendorContext; error?: undefined } | { error: Response; ctx?: undefined }> {
  const token = String(sessionToken || "");
  if (!token) return { error: json({ ok: false, error: "signed_out" }, 401) };
  const admin = serviceClient();
  // One round trip: session + its login + the login's company.
  const { data: session, error } = await admin
    .from("vendor_sessions")
    .select("id, vendor_user_id, expires_at, last_seen_at, vendor_users(*, Companies(*))")
    .eq("token_hash", await sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    if (session) await admin.from("vendor_sessions").delete().eq("id", session.id);
    return { error: json({ ok: false, error: "signed_out" }, 401) };
  }
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Row | null | undefined;
  const user = one(session.vendor_users);
  if (!user || (user.status !== "active" && user.status !== "pending")) {
    await admin.from("vendor_sessions").delete().eq("id", session.id);
    return { error: json({ ok: false, error: "signed_out" }, 401) };
  }
  const company = user.company_id ? one(user.Companies) || null : null;
  delete user.Companies;
  // Sliding expiry: touch at most once an hour.
  if (Date.now() - new Date(session.last_seen_at).getTime() > 60 * 60 * 1000) {
    await admin.from("vendor_sessions").update({
      last_seen_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    }).eq("id", session.id);
  }
  return { ctx: { admin, user, company, sessionId: session.id } };
}

// Staff (by staff_users.id) who have a permission through one of their
// workgroups, plus everyone in the Super Admin workgroup.
export async function staffWithPermission(admin: SupabaseClient, key: string): Promise<Row[]> {
  const [{ data: staff }, { data: groups }, { data: grants }] = await Promise.all([
    admin.from("staff_users").select("id, full_name, workgroup, active").neq("active", false),
    admin.from("workgroups").select("id, name"),
    admin.from("workgroup_permissions").select("workgroup_id, permission_key").eq("permission_key", key),
  ]);
  const allowedGroups = new Set<string>(["super admin"]);
  const grantIds = new Set((grants || []).map((g: Row) => String(g.workgroup_id)));
  (groups || []).forEach((g: Row) => { if (grantIds.has(String(g.id))) allowedGroups.add(String(g.name).trim().toLowerCase()); });
  return (staff || []).filter((s: Row) => (s.workgroup || []).some((w: string) => allowedGroups.has(String(w).trim().toLowerCase())));
}

export async function notifyStaff(
  admin: SupabaseClient,
  staffIds: string[],
  notification: { title: string; message: string; type: string; link_url?: string; link_label?: string },
): Promise<void> {
  if (!staffIds.length) return;
  const { error } = await admin.from("notifications").insert(staffIds.map((id) => ({ user_id: id, ...notification })));
  if (error) console.error("notifyStaff failed:", error.message);
}

export function maskTaxId(value: unknown): string | null {
  const raw = String(value || "").replace(/[^0-9A-Za-z]/g, "");
  if (!raw) return null;
  return `•••••${raw.slice(-4)}`;
}
