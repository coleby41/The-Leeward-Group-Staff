// supabase/functions/siri-timeline/index.ts
// "Hey Siri, update timeline" -> Shortcut POSTs { project, change } here.
// Returns plain text that the Shortcut speaks back.
//
// Deploy:
//   supabase secrets set SIRI_TOKEN=<long random string>
//   supabase functions deploy siri-timeline --no-verify-jwt
//
// Commands it understands (said as the "change"):
//   push framing back 5 days      | delay site clean 2 weeks
//   pull walls up forward 3 days  | move walls up up 1 week
//   move walls up to November 18  | start site clean on 12/1
//   site clean 50 percent         | set walls up to 75%
//   mark site clean done          | finish walls up
//   mark walls up started
//   add drywall after walls up for 2 weeks
//   add inspection on november 20
//   add trash haul under site clean for 3 days
//   undo                          (reverts the last voice change, including an add)

import { createClient } from "npm:@supabase/supabase-js@2";

// ---- CONFIG: change these to match your schema ----
const ITEMS = "project_timeline_items"; // timeline table (rows like the JSON you sent)
const PROJECTS = "projects";            // projects table
const PROJECT_NAME_COL = "name";        // column Siri matches the spoken project against
const DONE_STATUS = "completed";        // your "done" status value
const STARTED_STATUS = "in_progress";
const LOG = "timeline_voice_log";
const NEW_TYPE = "phase";               // type for new top-level items
const NEW_CHILD_TYPE = "task";          // type for items added "under" another item
const DEFAULT_DAYS = 7;                 // length of a new item when no "for N days" is said
// ---------------------------------------------------

// Service role key lives only on the server; it bypasses RLS.
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const say = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain" } });

Deno.serve(async (req) => {
  // Only your Shortcut knows this token.
  if (req.headers.get("x-siri-token") !== Deno.env.get("SIRI_TOKEN")) {
    return say("Not authorized.", 401);
  }

  let body: { project?: string; change?: string };
  try { body = await req.json(); } catch { return say("Bad request.", 400); }

  const project = String(body.project ?? "").trim();
  const change = String(body.change ?? "").trim().toLowerCase().replace(/[.!?]+$/, "");

  try {
    if (/^undo( last( change)?)?$/.test(change)) return await undo();
    if (!project || !change) return say("I need a project and a change.");

    // --- find project ---
    const { data: projs, error: pErr } = await sb
      .from(PROJECTS).select(`id, ${PROJECT_NAME_COL}`)
      .ilike(PROJECT_NAME_COL, `%${project}%`).limit(5);
    if (pErr) throw pErr;
    if (!projs?.length) return say(`I couldn't find a project called ${project}.`);
    // deno-lint-ignore no-explicit-any
    const proj = projs[0] as any;
    const projName = proj[PROJECT_NAME_COL];

    // --- parse command ---
    const cmd = parse(change);
    if (!cmd) return say(`I didn't get "${change}". Try: push framing back 5 days.`);

    const { data: items, error: iErr } = await sb.from(ITEMS).select("*").eq("project_id", proj.id);
    if (iErr) throw iErr;
    const batch = crypto.randomUUID(); // groups cascaded rows so undo reverts them together

    // --- add a new item ---
    if (cmd.kind === "add") {
      const after = cmd.after ? findItem(items ?? [], cmd.after) : null;
      if (cmd.after && !after) return say(`There's no task like ${cmd.after} on ${projName}.`);
      const parent = cmd.under ? findItem(items ?? [], cmd.under) : null;
      if (cmd.under && !parent) return say(`There's no task like ${cmd.under} on ${projName}.`);

      // Start: spoken date > day after the "after" item ends > parent's start > today
      const start = cmd.date
        ?? (after?.end_date ? addDays(after.end_date, 1) : null)
        ?? parent?.start_date
        ?? new Date().toISOString().slice(0, 10);
      const end = addDays(start, (cmd.days ?? DEFAULT_DAYS) - 1);

      // Put it at the end of its level (same parent)
      const parentId = parent?.id ?? null;
      const siblings = (items ?? []).filter((i) => (i.parent_id ?? null) === parentId);
      const position = siblings.reduce((max, i) => Math.max(max, i.position ?? 0), -1) + 1;

      const { data: created, error: cErr } = await sb.from(ITEMS).insert({
        project_id: proj.id,
        parent_id: parentId,
        depends_on_id: after?.id ?? null,
        type: parent ? NEW_CHILD_TYPE : NEW_TYPE,
        title: titleCase(cmd.title),
        status: "not_started",
        progress: 0,
        start_date: start,
        end_date: end,
        position,
        created_by_name: "Siri",
      }).select().single();
      if (cErr) throw cErr;

      // before.__created tells undo to delete this row instead of reverting fields
      await sb.from(LOG).insert({
        batch_id: batch, project_id: proj.id, item_id: created.id, command: change,
        before: { __created: true }, after: created,
      });

      const where = after ? ` after ${after.title}` : parent ? ` under ${parent.title}` : "";
      return say(`Added ${created.title} to ${projName}${where}, ${fmt(start)} to ${fmt(end)}.`);
    }

    // --- find task ---
    const item = findItem(items ?? [], cmd.task);
    if (!item) return say(`There's no task like ${cmd.task} on ${projName}.`);

    // --- date changes (shift or move-to) ---
    if (cmd.kind === "shift" || cmd.kind === "moveTo") {
      // move-to with no existing start date: just set the start
      if (cmd.kind === "moveTo" && !item.start_date) {
        await apply(item, { start_date: cmd.date }, change, proj.id, batch);
        return say(`${item.title} on ${projName} now starts ${fmt(cmd.date)}.`);
      }
      const days = cmd.kind === "shift" ? cmd.days : diffDays(item.start_date, cmd.date);
      if (days === 0) return say(`${item.title} is already there.`);

      // Shift the task plus everything under it (parent_id) and after it (depends_on_id)
      // by the same number of days, so the schedule stays in order.
      const targets = [item, ...downstream(items ?? [], item.id)];
      for (const t of targets) {
        await apply(t, {
          start_date: addDays(t.start_date, days),
          end_date: addDays(t.end_date, days),
        }, change, proj.id, batch);
      }
      const extra = targets.length > 1 ? ` ${targets.length - 1} linked item${targets.length > 2 ? "s" : ""} moved with it.` : "";
      return say(
        `${item.title} on ${projName} moved ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"}. ` +
        `Now ${fmt(addDays(item.start_date, days))} to ${fmt(addDays(item.end_date, days))}.${extra}`,
      );
    }

    // --- status / progress ---
    if (cmd.kind === "done") {
      await apply(item, { status: DONE_STATUS, progress: 100 }, change, proj.id, batch);
      return say(`Marked ${item.title} on ${projName} done.`);
    }
    if (cmd.kind === "started") {
      await apply(item, { status: STARTED_STATUS }, change, proj.id, batch);
      return say(`Marked ${item.title} on ${projName} in progress.`);
    }
    if (cmd.kind === "progress") {
      const p = Math.max(0, Math.min(100, cmd.progress));
      const patch: Record<string, unknown> = { progress: p };
      if (p === 100) patch.status = DONE_STATUS;
      else if (p > 0 && item.status === "not_started") patch.status = STARTED_STATUS;
      await apply(item, patch, change, proj.id, batch);
      return say(`${item.title} on ${projName} is now ${p} percent.`);
    }
    return say("Nothing changed.");
  } catch (e) {
    console.error(e);
    return say("Something went wrong saving that. Nothing may have changed.", 500);
  }
});

// ================= parsing =================

type Cmd =
  | { kind: "shift"; task: string; days: number }
  | { kind: "moveTo"; task: string; date: string }
  | { kind: "progress"; task: string; progress: number }
  | { kind: "done"; task: string }
  | { kind: "started"; task: string }
  | { kind: "add"; title: string; after?: string; under?: string; date?: string; days?: number };

const WORDNUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const num = (s: string) => WORDNUM[s] ?? parseInt(s, 10);
const unitDays = (u: string) => (u.startsWith("week") ? 7 : 1);
const AMT = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?)`;

function parse(t: string): Cmd | null {
  let m: RegExpMatchArray | null;

  // "add drywall after walls up starting nov 20 for 2 weeks"
  if ((m = t.match(/^(?:add|create|new)\s+(.+)$/))) {
    let rest = m[1];
    const cmd: Extract<Cmd, { kind: "add" }> = { kind: "add", title: "" };
    // peel optional clauses off the end, in any order
    for (let k = 0; k < 3; k++) {
      let c: RegExpMatchArray | null;
      if (cmd.days === undefined && (c = rest.match(new RegExp(String.raw`\s+(?:for|lasting)\s+${AMT}$`)))) {
        cmd.days = num(c[1]) * unitDays(c[2]);
        rest = rest.slice(0, c.index);
      } else if (!cmd.date && (c = rest.match(/\s+(?:on|starting(?: on)?|beginning(?: on)?)\s+(.+)$/)) && parseDate(c[1])) {
        cmd.date = parseDate(c[1])!;
        rest = rest.slice(0, c.index);
      }
    }
    if ((m = rest.match(/^(.+?)\s+after\s+(.+)$/))) { cmd.after = m[2]; rest = m[1]; }
    if ((m = rest.match(/^(.+?)\s+(?:under|in)\s+(.+)$/))) { cmd.under = m[2]; rest = m[1]; }
    cmd.title = rest.replace(/^(?:a|an|the)\s+/, "").trim();
    return cmd.title ? cmd : null;
  }

  // "site clean 50 percent" / "set walls up to 75%"
  if ((m = t.match(/^(?:set\s+|mark\s+)?(.+?)\s+(?:to\s+|at\s+|is\s+)?(\d{1,3})\s*(?:%|percent)(?:\s+(?:done|complete))?$/)))
    return { kind: "progress", task: m[1], progress: +m[2] };

  // "move walls up to november 18" / "start site clean on 12/1"
  if ((m = t.match(/^(?:move|start|reschedule|set)\s+(.+?)\s+(?:to|for|on)\s+(.+)$/))) {
    const d = parseDate(m[2]);
    if (d) return { kind: "moveTo", task: m[1], date: d };
  }

  // earlier: "pull framing up 3 days", "move framing forward a week"
  if ((m = t.match(new RegExp(String.raw`^(?:pull|move|bring|bump|slide)\s+(.+?)\s+(?:up|forward|in|ahead|earlier)\s+(?:by\s+)?${AMT}$`))))
    return { kind: "shift", task: m[1], days: -num(m[2]) * unitDays(m[3]) };

  // later: "push framing back 5 days", "delay framing by 2 weeks"
  if ((m = t.match(new RegExp(String.raw`^(?:push|delay|move|bump|slide)\s+(.+?)\s+(?:back\s+|out\s+)?(?:by\s+)?${AMT}(?:\s+(?:back|out|later))?$`))))
    return { kind: "shift", task: m[1], days: num(m[2]) * unitDays(m[3]) };

  // done
  if ((m = t.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/)))
    return { kind: "done", task: m[1] };
  if ((m = t.match(/^(?:finish|complete)\s+(.+)$/))) return { kind: "done", task: m[1] };

  // started
  if ((m = t.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:started|in progress)$/)))
    return { kind: "started", task: m[1] };

  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Handles "november 18", "nov 18th 2027", "11/18", "11/18/27", "2026-11-18".
// No year given -> this year, or next year if that date already passed.
function parseDate(raw: string): string | null {
  const s = raw.replace(/(\d+)(st|nd|rd|th)\b/g, "$1").replace(/,/g, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  let y: number | null = null, mo: number, d: number;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    mo = +m[1]; d = +m[2];
    if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  } else if ((m = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/))) {
    const i = MONTHS.findIndex((x) => m![1].startsWith(x));
    if (i < 0) return null;
    mo = i + 1; d = +m[2];
    if (m[3]) y = +m[3];
  } else return null;

  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (y === null) {
    y = new Date().getUTCFullYear();
    if (iso(y, mo, d) < today) y++;
  }
  return iso(y, mo, d);
}

// ================= helpers =================

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function addDays(d: string | null, n: number): string | null {
  if (!d) return d;
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const fmt = (d: string | null) =>
  d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "no date";

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// deno-lint-ignore no-explicit-any
function findItem(items: any[], q: string) {
  const nq = norm(q.replace(/^the\s+/, "").replace(/\s+(phase|task)$/, ""));
  return items.find((i) => norm(i.title) === nq) ??
    items.find((i) => norm(i.title).includes(nq) || nq.includes(norm(i.title)));
}

// Everything nested under (parent_id) or waiting on (depends_on_id) the item, recursively.
// deno-lint-ignore no-explicit-any
function downstream(items: any[], rootId: string) {
  const found = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const i of items) {
      if ((i.parent_id === id || i.depends_on_id === id) && i.id !== rootId && !found.has(i.id)) {
        found.add(i.id);
        stack.push(i.id);
      }
    }
  }
  return items.filter((i) => found.has(i.id));
}

// Update one row and log before/after so it can be undone.
async function apply(
  // deno-lint-ignore no-explicit-any
  item: any, patch: Record<string, unknown>, command: string, projectId: string, batch: string,
) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, item[k]]));
  const { error } = await sb.from(ITEMS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", item.id);
  if (error) throw error;
  const { error: logErr } = await sb.from(LOG).insert({
    batch_id: batch, project_id: projectId, item_id: item.id, command, before, after: patch,
  });
  if (logErr) console.error("log failed", logErr);
}

// Revert the most recent voice change (all rows in its batch).
async function undo() {
  const { data: last } = await sb.from(LOG).select("batch_id").eq("undone", false)
    .order("created_at", { ascending: false }).limit(1);
  if (!last?.length) return say("There's nothing to undo.");
  const batch = last[0].batch_id;
  const { data: rows, error } = await sb.from(LOG).select("*").eq("batch_id", batch);
  if (error) throw error;
  for (const r of rows ?? []) {
    // an "add" is undone by deleting the row it created
    const { error: uErr } = r.before?.__created
      ? await sb.from(ITEMS).delete().eq("id", r.item_id)
      : await sb.from(ITEMS).update({ ...r.before, updated_at: new Date().toISOString() }).eq("id", r.item_id);
    if (uErr) throw uErr;
  }
  await sb.from(LOG).update({ undone: true }).eq("batch_id", batch);
  return say(`Undid "${rows?.[0]?.command}".`);
}
