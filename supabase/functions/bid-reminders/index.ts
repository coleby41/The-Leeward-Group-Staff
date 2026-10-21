// Bid Invites — automatic reminders, run once a day by pg_cron (see
// sql/supabase-bid-invites-cron-setup.sql), same setup as the COI reminders.
//
//   - No response: 3+ days after the invite went out and the vendor hasn't
//     said whether they're bidding → one reminder (only if the package has
//     "Remind if no response in 3 days" on).
//   - Due tomorrow: the day before bids are due, to everyone who hasn't
//     submitted a bid or said they're not bidding (only if "Remind 1 day
//     before bids are due" is on).
//
// Each reminder is only ever sent once per vendor.
//
// Deploy:  supabase functions deploy bid-reminders
// Only the service role may call it (the daily job does).

import { BUSINESS_TZ, SERVICE_ROLE_KEY, businessDate, json, pause, sendEmail, serviceClient } from "../_shared/bid-common.ts";
import { packageForEmail, renderBidEmail } from "../_shared/bid-email.ts";
import { normalizeEmail } from "../_shared/vendor-common.ts";

const NO_RESPONSE_AFTER_DAYS = 3;

// deno-lint-ignore no-explicit-any
type Row = any;

function callerRole(req: Request): string | null {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role || null;
  } catch {
    return null;
  }
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  // Only the service role key is accepted — either the exact key this
  // function runs with, or a service_role JWT (whose signature the platform
  // has already checked, since this is deployed with JWT verification on).
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const isServiceKey = (SERVICE_ROLE_KEY && bearer === SERVICE_ROLE_KEY) || callerRole(req) === "service_role";
  if (!isServiceKey) return json({ ok: false, error: "Not allowed" }, 401);

  const admin = serviceClient();
  const today = businessDate();
  const tomorrow = addDays(today, 1);
  const noResponseCutoff = new Date(Date.now() - NO_RESPONSE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: packages, error } = await admin
    .from("bid_packages")
    .select("*")
    .eq("status", "open")
    .gt("due_at", new Date().toISOString());
  if (error) return json({ ok: false, error: error.message }, 500);

  let sent = 0;
  const failed: { company_name: string; error: string }[] = [];
  let first = true;

  for (const pkg of packages || []) {
    const dueDate = businessDate(new Date(pkg.due_at));
    const dueTomorrow = pkg.remind_before_due && dueDate === tomorrow;

    const { data: invites } = await admin.from("bid_invites").select("*").eq("package_id", pkg.id).in("status", ["sent", "viewed", "bidding"]);
    const due: { invite: Row; kind: "reminder_due" | "reminder_no_response" }[] = [];
    for (const invite of invites || []) {
      if (dueTomorrow && !invite.due_reminder_sent_at) {
        due.push({ invite, kind: "reminder_due" });
      } else if (pkg.remind_no_response && (invite.status === "sent" || invite.status === "viewed") && (invite.reminder_count || 0) === 0
        && invite.sent_at && invite.sent_at <= noResponseCutoff) {
        due.push({ invite, kind: "reminder_no_response" });
      }
    }
    if (!due.length) continue;

    const { data: project } = await admin.from("projects").select("id, name, site_address, site_city, site_state, site_zip").eq("id", pkg.project_id).maybeSingle();
    const { count: files } = await admin.from("bid_package_files").select("id", { count: "exact", head: true }).eq("package_id", pkg.id);
    const { data: users } = await admin.from("vendor_users").select("email, language").in("email", due.map((d) => normalizeEmail(d.invite.contact_email)));
    const langs = new Map((users || []).map((u: Row) => [normalizeEmail(u.email), u.language === "es" ? "es" : "en"]));
    const emailPkg = packageForEmail(pkg, project);

    for (const { invite, kind } of due) {
      if (!first) await pause();
      first = false;
      // deno-lint-ignore no-explicit-any
      const email = renderBidEmail(kind, emailPkg, invite, { lang: (langs.get(normalizeEmail(invite.contact_email)) as any) || "en", fileCount: files || 0 });
      const result = await sendEmail({ to: invite.contact_email, subject: email.subject, html: email.html, text: email.text, replyTo: pkg.contact_email });
      if (!result.ok) {
        failed.push({ company_name: invite.company_name, error: result.error || "Unknown error" });
        continue;
      }
      sent++;
      const now = new Date().toISOString();
      await admin.from("bid_invites").update(
        kind === "reminder_due"
          ? { due_reminder_sent_at: now, reminder_count: (invite.reminder_count || 0) + 1, last_reminded_at: now }
          : { reminder_count: (invite.reminder_count || 0) + 1, last_reminded_at: now },
      ).eq("id", invite.id);
    }
  }

  console.log(`bid-reminders ${today} (${BUSINESS_TZ}): sent ${sent}, failed ${failed.length}`);
  return json({ ok: true, sent, failed });
});
