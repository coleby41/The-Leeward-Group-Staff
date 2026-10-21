// Shared by the bid-invites, bid-reminders and Vendor Portal Edge Functions.
// See sql/supabase-vendor-portal-setup.sql for the tables.
//
// Secrets (Supabase → Edge Functions → Secrets — project-wide, the COI
// functions already set the first two):
//   RESEND_API_KEY     required
//   RESEND_FROM_EMAIL  the address emails come from. Must be on a domain
//                      verified in Resend — Resend's sandbox address only
//                      delivers to the Resend account owner, so vendors
//                      won't get anything until a domain is verified.
//   BID_FROM_EMAIL     optional — a different address just for bid emails,
//                      e.g. "The Leeward Group <bids@theleewardgroup.us>"

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
export const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const RESEND_API_URL = Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails";

export const BUSINESS_TZ = "America/New_York";
export const COMPANY_NAME = "The Leeward Group";

// "COI Alerts <x@y.com>" → x@y.com, so bid emails can carry their own name.
function fromAddress(): string {
  const configured = Deno.env.get("BID_FROM_EMAIL");
  if (configured) return configured;
  const raw = Deno.env.get("RESEND_FROM_EMAIL") || "onboarding@resend.dev";
  const match = raw.match(/<([^>]+)>/);
  return `${COMPANY_NAME} <${(match ? match[1] : raw).trim()}>`;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// A client that acts as the staff member who called the function — so
// has_permission() / RLS see their real auth.uid().
export function userClient(authHeader: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY || SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// "Thu, Oct 30, 2026 at 2:00 PM" in Eastern time.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: BUSINESS_TZ });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TZ });
  return `${date} at ${time}`;
}

export function formatMoney(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

// YYYY-MM-DD in Eastern time.
export function businessDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(d);
}

export function isValidEmail(value: unknown): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// Only http(s) origins — this ends up in every button link we email out.
export function cleanAppUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}

export async function sendEmail(email: OutgoingEmail): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY is not set" };
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress(),
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = body;
      try { message = JSON.parse(body).message || body; } catch { /* plain text */ }
      return { ok: false, error: `Email service error (${res.status}): ${message}`.slice(0, 500) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Couldn't reach the email service: ${error instanceof Error ? error.message : error}` };
  }
}

// Resend's default limit is 2 emails a second.
export function pause(ms = 550): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Who called this function, and are they allowed to? Returns the staff row
// or an error Response to send back as-is.
export async function requireStaffPermission(
  req: Request,
  permissionKey: string | string[],
): Promise<{ staff: { id: string; full_name: string | null; username: string | null }; error?: undefined } | { error: Response; staff?: undefined }> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { error: json({ ok: false, error: "Please sign in again." }, 401) };

  const admin = serviceClient();
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return { error: json({ ok: false, error: "Your session has expired. Please sign in again." }, 401) };

  const { data: staff } = await admin
    .from("staff_users")
    .select("id, full_name, username, active")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();
  if (!staff || staff.active === false) return { error: json({ ok: false, error: "This account can't do that." }, 403) };

  // Any one of the keys is enough.
  const keys = Array.isArray(permissionKey) ? permissionKey : [permissionKey];
  const asUser = userClient(authHeader);
  let allowed = false;
  for (const key of keys) {
    const { data, error: permError } = await asUser.rpc("has_permission", { p_key: key });
    if (permError) return { error: json({ ok: false, error: `Couldn't check your permissions: ${permError.message}` }, 500) };
    if (data) { allowed = true; break; }
  }
  if (!allowed) return { error: json({ ok: false, error: "You don't have permission to do that." }, 403) };

  return { staff };
}

// Signed download links for a package's plans/specs, good until a week
// after bids are due (and at least two days from now).
export async function signedFileLinks(
  admin: SupabaseClient,
  packageId: string,
  dueAt: string,
): Promise<{ name: string; url: string }[]> {
  const { data: rows, error } = await admin
    .from("bid_package_files")
    .select("sort_order, project_files(file_name, bucket, storage_path)")
    .eq("package_id", packageId)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const week = 7 * 24 * 60 * 60;
  const untilDue = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 1000);
  const expiresIn = Math.max(2 * 24 * 60 * 60, untilDue + week);

  const links: { name: string; url: string }[] = [];
  for (const row of rows || []) {
    // deno-lint-ignore no-explicit-any
    const file: any = Array.isArray(row.project_files) ? row.project_files[0] : row.project_files;
    if (!file?.storage_path) continue;
    const { data, error: signError } = await admin.storage.from(file.bucket || "project-documents").createSignedUrl(file.storage_path, expiresIn);
    if (signError || !data?.signedUrl) throw new Error(`Couldn't create a download link for ${file.file_name}: ${signError?.message || "unknown error"}`);
    links.push({ name: file.file_name, url: data.signedUrl });
  }
  return links;
}
