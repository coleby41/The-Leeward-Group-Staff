// Vendor COI expiration reminders -- EMPLOYEE-facing only (see
// sql/supabase-coi-notifications-setup.sql for the full design writeup).
//
// Runs once a day (scheduled via pg_cron + pg_net -- see
// sql/supabase-coi-notifications-cron-setup.sql), reads every vendor with
// a COI on file, works out which of the four notification phases (if any)
// each one is due for today, and sends ONE combined digest email per
// recipient (not one email per vendor) -- a recipient who's on more than
// one phase's list gets a single email with a section per phase they're
// actually subscribed to. Sent as HTML (bold vendor lines, underlined
// section headers, a bold red italic unsubscribe line) with a plain-text
// fallback for clients that don't render HTML.
//
// Not deployed from this repo automatically -- this app has no build
// step and no tracked Supabase CLI project (same as the existing
// create-staff-account function), so this file is here for version
// control / reference. To ship it: either paste this file's contents
// into Supabase Dashboard -> Edge Functions -> Create a function named
// "send-coi-reminders", or `supabase functions deploy send-coi-reminders`
// if the CLI ever gets set up for this project. Either way, set the
// RESEND_API_KEY secret before it can actually send anything (see the
// delivery notes for how).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Must be an address on a domain verified in Resend once this goes live --
// Resend's own onboarding@resend.dev sandbox address only actually
// delivers to the Resend account's own owner email, useful for testing
// but not for real staff inboxes. Set a RESEND_FROM_EMAIL secret once a
// domain is verified.
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "COI Alerts <onboarding@resend.dev>";
// Optional -- if set, included as a link at the bottom of each email so
// staff can jump straight to the Vendors page. e.g. "https://staff.leewardgroup.com"
const APP_URL = Deno.env.get("APP_URL") || "";

const PHASES = ["60_day", "30_day", "7_day_daily", "expired_daily"] as const;
type Phase = typeof PHASES[number];

const PHASE_LABEL: Record<Phase, string> = {
  "60_day": "60 Days Before Expiration",
  "30_day": "30 Days Before Expiration",
  "7_day_daily": "Expiring Within 7 Days",
  "expired_daily": "COI that has already expired",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// "Today" is computed in the business's own timezone, not the server's
// (UTC) -- otherwise a cron run scheduled for early morning Eastern could
// land on the wrong side of midnight UTC and be off by a day, same
// reasoning as companies.js's own daysUntil() being computed against the
// viewer's local midnight rather than UTC midnight.
const BUSINESS_TZ = "America/New_York";

function todayInBusinessTz(): string {
  // en-CA gives YYYY-MM-DD directly, no reformatting needed.
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ }).format(new Date());
}

function daysBetween(todayIso: string, targetIso: string): number {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const target = new Date(`${targetIso}T00:00:00Z`);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: "UTC" });
}

interface CompanyRow {
  id: number;
  Name: string | null;
  COIExpiresOn: string; // date, not null (query filters for it)
  COIExempt: boolean | null;
}

interface DueItem {
  company: CompanyRow;
  daysUntil: number;
}

Deno.serve(async (_req: Request) => {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set -- nothing will be sent. Set it with `supabase secrets set RESEND_API_KEY=...`.");
    return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not configured" }), { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const today = todayInBusinessTz();

  // 1. Load recipient settings for all four phases.
  const { data: settingsRows, error: settingsError } = await supabase
    .from("coi_notification_settings")
    .select("phase, recipient_emails");
  if (settingsError) {
    console.error("Failed to load coi_notification_settings:", settingsError);
    return new Response(JSON.stringify({ ok: false, error: settingsError.message }), { status: 500 });
  }
  const recipientsByPhase = new Map<Phase, string[]>();
  for (const phase of PHASES) recipientsByPhase.set(phase, []);
  for (const row of settingsRows || []) {
    recipientsByPhase.set(row.phase as Phase, (row.recipient_emails || []).filter(Boolean));
  }

  // 2. Load every vendor with a COI expiration date. Since 2026-10-21 the
  // date alone is what counts (the PDF is only requested once a vendor is
  // awarded a job), so a vendor with a date but no PDF still gets reminders.
  const { data: companies, error: companiesError } = await supabase
    .from("Companies")
    .select('id, Name, "COIExpiresOn", "COIExempt"')
    .not("COIExpiresOn", "is", null);
  if (companiesError) {
    console.error("Failed to load Companies:", companiesError);
    return new Response(JSON.stringify({ ok: false, error: companiesError.message }), { status: 500 });
  }

  // 3. Bucket each vendor into at most one phase for today. Exempt
  // vendors are skipped entirely -- no point reminding anyone about a COI
  // that isn't required for that vendor.
  const dueByPhase = new Map<Phase, DueItem[]>();
  for (const phase of PHASES) dueByPhase.set(phase, []);

  for (const company of (companies || []) as CompanyRow[]) {
    if (company.COIExempt) continue;
    const daysUntil = daysBetween(today, company.COIExpiresOn);
    let phase: Phase | null = null;
    if (daysUntil > 30 && daysUntil <= 60) phase = "60_day";
    else if (daysUntil > 7 && daysUntil <= 30) phase = "30_day";
    else if (daysUntil >= 0 && daysUntil <= 7) phase = "7_day_daily";
    else if (daysUntil < 0) phase = "expired_daily";
    if (phase) dueByPhase.get(phase)!.push({ company, daysUntil });
  }

  // 4. Dedupe against the log. Milestone phases (60/30-day) check for ANY
  // prior send for this exact expiration date (fires once per cycle);
  // daily phases only check for a send already logged for TODAY (so they
  // fire again tomorrow).
  const toNotify = new Map<Phase, DueItem[]>();
  const logRowsToInsert: { company_id: number; phase: Phase; coi_expires_on: string; sent_on: string }[] = [];

  for (const phase of PHASES) {
    const candidates = dueByPhase.get(phase)!;
    if (candidates.length === 0) continue;
    // No one to tell -- don't burn a "sent" log entry for nobody, so this
    // can still fire once a recipient gets added while the vendor is
    // still within this phase's window.
    if ((recipientsByPhase.get(phase) || []).length === 0) continue;

    const isDaily = phase === "7_day_daily" || phase === "expired_daily";
    const { data: existingLogs } = await supabase
      .from("coi_notification_log")
      .select("company_id, coi_expires_on, sent_on")
      .eq("phase", phase)
      .in("company_id", candidates.map((c) => c.company.id));

    const already = new Set(
      (existingLogs || [])
        .filter((r) => (isDaily ? r.sent_on === today : true))
        .map((r) => `${r.company_id}::${r.coi_expires_on}`)
    );

    const pending = candidates.filter((c) => !already.has(`${c.company.id}::${c.company.COIExpiresOn}`));
    if (pending.length === 0) continue;

    toNotify.set(phase, pending);
    for (const item of pending) {
      logRowsToInsert.push({
        company_id: item.company.id,
        phase,
        coi_expires_on: item.company.COIExpiresOn,
        sent_on: today,
      });
    }
  }

  if (toNotify.size === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, note: "Nothing due today." }), { status: 200 });
  }

  // 5. Build one digest per recipient across whichever phases they're
  // actually on (a recipient only on the 60-day list never sees the
  // 30-day/7-day/expired sections, even if other vendors are due there
  // today).
  const digestByRecipient = new Map<string, Map<Phase, DueItem[]>>();
  for (const [phase, items] of toNotify) {
    for (const email of recipientsByPhase.get(phase) || []) {
      if (!digestByRecipient.has(email)) digestByRecipient.set(email, new Map());
      digestByRecipient.get(email)!.set(phase, items);
    }
  }

  let sentCount = 0;
  const sendErrors: string[] = [];

  for (const [email, phaseMap] of digestByRecipient) {
    // Built in parallel: a plain-text version (fallback for clients that
    // don't render HTML) and an HTML version with the bold/underline/red
    // styling Coleby asked to match -- Resend accepts both `text` and
    // `html` on the same send, and mail clients pick whichever they
    // support, so nobody loses the reminder either way.
    const textSections: string[] = [];
    const htmlSections: string[] = [];

    for (const phase of PHASES) {
      const items = phaseMap.get(phase);
      if (!items || items.length === 0) continue;
      const sorted = items.slice().sort((a, b) => a.daysUntil - b.daysUntil);

      const detailFor = (item: DueItem): string => {
        const expires = formatDate(item.company.COIExpiresOn);
        if (item.daysUntil < 0) {
          return `expired ${expires} (${Math.abs(item.daysUntil)} day${Math.abs(item.daysUntil) === 1 ? "" : "s"} overdue)`;
        }
        if (item.daysUntil === 0) return `expires today (${expires})`;
        return `expires ${expires} (${item.daysUntil} day${item.daysUntil === 1 ? "" : "s"} left)`;
      };

      const textLines = sorted.map((item) => `- ${item.company.Name || "(unnamed vendor)"} -- ${detailFor(item)}`);
      const htmlLines = sorted.map(
        (item) => `<strong>- ${escapeHtml(item.company.Name || "(unnamed vendor)")} -- ${escapeHtml(detailFor(item))}</strong>`
      );

      textSections.push(`${PHASE_LABEL[phase]}:\n${textLines.join("\n")}`);
      htmlSections.push(`<p><u>${escapeHtml(PHASE_LABEL[phase])}:</u><br>${htmlLines.join("<br>")}</p>`);
    }

    const vendorsLink = APP_URL ? `${APP_URL.replace(/\/$/, "")}/pages/vendors.html` : "";

    // Built as separate paragraph "blocks" joined with a blank line between
    // each, rather than one flat array with "" spacer entries filtered
    // out -- filtering blanks out of the array (the previous approach)
    // silently collapsed the spacing whenever a later entry was itself
    // empty, which is exactly the kind of thing that's easy to not notice
    // until someone actually reads the plain-text version.
    const textBlocks = [
      "Hi there,",
      `This is a Vendor Certificate of Insurance (COI) reminder -- ${formatDate(today)}`,
      textSections.join("\n\n"),
    ];
    if (vendorsLink) textBlocks.push(`View vendors: ${vendorsLink}`);
    textBlocks.push("This is an automated message from the LeeWard Group staff portal.");
    textBlocks.push("IF YOU WOULD LIKE TO UNSUBSCRIBE FROM THIS, PLEASE LET LEEWARDGROUP IT ADMIN KNOW.");
    const body = textBlocks.join("\n\n");

    const html = [
      `<p>Hi there,</p>`,
      `<p>This is a Vendor Certificate of Insurance (COI) reminder -- ${escapeHtml(formatDate(today))}</p>`,
      htmlSections.join(""),
      vendorsLink ? `<p><a href="${escapeHtml(vendorsLink)}">View vendors</a></p>` : "",
      `<p><em>This is an automated message from the LeeWard Group staff portal.</em></p>`,
      `<p><strong><em style="color:#cc0000;">IF YOU WOULD LIKE TO UNSUBSCRIBE FROM THIS, PLEASE LET LEEWARDGROUP IT ADMIN KNOW.</em></strong></p>`,
    ]
      .filter(Boolean)
      .join("");

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [email],
          subject: `Vendor COI Reminder -- ${formatDate(today)}`,
          text: body,
          html,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        sendErrors.push(`${email}: ${res.status} ${errText}`);
        continue;
      }
      sentCount++;
    } catch (err) {
      sendErrors.push(`${email}: ${String(err)}`);
    }
  }

  // 6. Log every (company, phase) pair that was included in this run so
  // it isn't re-sent -- logged regardless of individual per-recipient
  // send failures above, matching this app's existing "best effort,
  // don't retry forever" pattern elsewhere; a failed send shows up in
  // sendErrors in the function's own logs for follow-up by hand.
  if (logRowsToInsert.length > 0) {
    const { error: logError } = await supabase
      .from("coi_notification_log")
      .upsert(logRowsToInsert, { onConflict: "company_id,phase,coi_expires_on,sent_on", ignoreDuplicates: true });
    if (logError) console.error("Failed to write coi_notification_log:", logError);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      recipientsEmailed: sentCount,
      recipientsAttempted: digestByRecipient.size,
      vendorsNotified: logRowsToInsert.length,
      errors: sendErrors,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
