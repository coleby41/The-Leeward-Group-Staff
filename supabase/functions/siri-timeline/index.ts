// supabase/functions/siri-timeline/index.ts
// "Hey Siri, Update Timeline" -> Shortcut POSTs { project, change } here
// with the employee's personal code in the x-siri-token header.
// Works on the same tables as pages/project-timeline.html:
//   schedule_phases, schedule_tasks, schedule_dependencies
// Returns plain text that the Shortcut speaks back.
//
// Deploy:  supabase functions deploy siri-timeline --no-verify-jwt
//
// Things employees can say as the "change":
//   push framing back 5 days      | delay site clean 2 weeks
//   pull framing forward 3 days   | move framing up 1 week
//   move framing to november 18   | start site clean on 12/1
//   push construction back 1 week (a phase name moves every task in it)
//   framing 50 percent            | set framing to 75%
//   mark framing done             | finish framing
//   mark framing started
//   add drywall after framing for 2 weeks
//   add inspection on november 20
//   add trash haul under site clean for 3 days
//   add punch list in close out
//   add milestone final walk on 1/15
//   undo                          (reverts that employee's last voice change)

import { createClient } from "npm:@supabase/supabase-js@2";

const PHASES = "schedule_phases";
const TASKS = "schedule_tasks";
const DEPS = "schedule_dependencies";
const TOKENS = "siri_tokens";
const LOG = "timeline_voice_log";
const DEFAULT_DAYS = 7; // length of a new task when no "for N days" is said

// Service role key lives only on the server; it bypasses RLS.
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const say = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain" } });

// deno-lint-ignore no-explicit-any
type Row = any;
type Who = { id: string; name: string };

Deno.serve(async (req) => {
  try {
    // ---- who is this? (personal code from the Add to Siri setup) ----
    const who = await identify(req.headers.get("x-siri-token"));
    if (!who) return say("Your Siri code isn't valid. Set it up again from the Timeline page.", 401);

    let body: { project?: string; change?: string };
    try { body = await req.json(); } catch { return say("Bad request.", 400); }
    const project = String(body.project ?? "").trim();
    const change = String(body.change ?? "").trim().toLowerCase().replace(/[.!?]+$/, "");

    if (/^undo( last( change)?)?$/.test(change)) return await undo(who);
    if (!project || !change) return say("I need a project and a change.");

    // ---- project ----
    const { data: projs, error: pErr } = await sb.from("projects")
      .select("id, name").ilike("name", `%${project}%`).limit(5);
    if (pErr) throw pErr;
    if (!projs?.length) return say(`I couldn't find a project called ${project}.`);
    const proj = projs[0];

    const cmd = parse(change);
    if (!cmd) return say(`I didn't get "${change}". Try: push framing back 5 days.`);

    const [ph, tk, dp] = await Promise.all([
      sb.from(PHASES).select("*").eq("project_id", proj.id).order("sort_order"),
      sb.from(TASKS).select("*").eq("project_id", proj.id).order("sort_order"),
      sb.from(DEPS).select("*").eq("project_id", proj.id),
    ]);
    if (ph.error) throw ph.error;
    if (tk.error) throw tk.error;
    if (dp.error) throw dp.error;
    const phases: Row[] = ph.data ?? [], tasks: Row[] = tk.data ?? [], deps: Row[] = dp.data ?? [];
    const ctx: Ctx = { who, projectId: proj.id, command: change, batch: crypto.randomUUID() };

    if (cmd.kind === "add") return say(await addTask(cmd, proj.name, phases, tasks, ctx));

    // ---- target: a task, or a whole phase ----
    const task = findByName(tasks, cmd.task);
    const phase = task ? null : findByName(phases, cmd.task);
    if (!task && !phase) return say(`There's no task like ${cmd.task} on ${proj.name}.`);

    // ---- date changes ----
    if (cmd.kind === "shift" || cmd.kind === "moveTo") {
      let roots: Row[];
      let days: number;
      if (task) {
        roots = [task];
        days = cmd.kind === "shift" ? cmd.days : diffDays(task.start_date ?? task.end_date, cmd.date);
      } else {
        roots = tasks.filter((t) => t.phase_id === phase.id);
        if (!roots.length) return say(`${phase.name} has no tasks to move.`);
        const first = roots.map((t) => t.start_date ?? t.end_date).sort()[0];
        days = cmd.kind === "shift" ? cmd.days : diffDays(first, cmd.date);
      }
      if (days === 0) return say("It's already there.");

      // Move the targets plus their subtasks and everything that comes after them.
      const ids = downstream(tasks, deps, roots.map((r) => r.id));
      const moving = tasks.filter((t) => ids.has(t.id));
      for (const t of moving) {
        await updateTask(t, {
          start_date: addDays(t.start_date, days),
          end_date: addDays(t.end_date, days),
        }, ctx);
      }
      const label = task ? task.name : phase.name;
      const extra = moving.length > roots.length ? ` ${moving.length - roots.length} linked task${moving.length - roots.length > 1 ? "s" : ""} moved too.` : "";
      const when = task ? ` Now ${fmt(addDays(task.start_date ?? task.end_date, days))} to ${fmt(addDays(task.end_date, days))}.` : "";
      return say(`${label} on ${proj.name} moved ${plural(Math.abs(days), "day")} ${days > 0 ? "later" : "earlier"}.${when}${extra}`);
    }

    // ---- status / progress (tasks only) ----
    if (!task) return say(`${phase.name} is a phase. Say a task name for status or progress.`);
    if (cmd.kind === "done") {
      await updateTask(task, { status: "complete", progress_percent: 100 }, ctx);
      return say(`Marked ${task.name} done.`);
    }
    if (cmd.kind === "started") {
      await updateTask(task, { status: "in_progress" }, ctx);
      return say(`Marked ${task.name} in progress.`);
    }
    if (cmd.kind === "progress") {
      const p = Math.max(0, Math.min(100, cmd.progress));
      const patch: Row = { progress_percent: p };
      if (p === 100) patch.status = "complete";
      else if (p > 0 && task.status === "not_started") patch.status = "in_progress";
      await updateTask(task, patch, ctx);
      return say(`${task.name} is now ${p} percent.`);
    }
    return say("Nothing changed.");
  } catch (e) {
    console.error(e);
    return say("Something went wrong saving that.", 500);
  }
});

// ================= auth =================

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function identify(token: string | null): Promise<Who | null> {
  if (!token || token.length < 20) return null;
  const hash = await sha256(token.trim());
  const { data } = await sb.from(TOKENS).select("id, staff_user_id, staff_name")
    .eq("token_hash", hash).eq("revoked", false).maybeSingle();
  if (!data) return null;
  // First use of a new code retires that person's older codes.
  await sb.from(TOKENS).update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  await sb.from(TOKENS).update({ revoked: true })
    .eq("staff_user_id", data.staff_user_id).eq("revoked", false).neq("id", data.id);
  return { id: data.staff_user_id, name: data.staff_name || "Siri" };
}

// ================= writes (all logged for undo) =================

type Ctx = { who: Who; projectId: string; command: string; batch: string };

async function updateTask(t: Row, patch: Row, ctx: Ctx) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, t[k]]));
  const { error } = await sb.from(TASKS).update({
    ...patch,
    updated_at: new Date().toISOString(),
    updated_by: ctx.who.id,
    updated_by_name: ctx.who.name,
  }).eq("id", t.id);
  if (error) throw error;
  await log(ctx, t.id, before, patch);
}

async function log(ctx: Ctx, itemId: string, before: Row, after: Row) {
  const { error } = await sb.from(LOG).insert({
    batch_id: ctx.batch, project_id: ctx.projectId, item_id: itemId, item_table: TASKS,
    staff_user_id: ctx.who.id, command: ctx.command, before, after,
  });
  if (error) console.error("log failed", error);
}

async function addTask(cmd: AddCmd, projName: string, phases: Row[], tasks: Row[], ctx: Ctx) {
  if (!phases.length) return `${projName} has no phases yet. Add one on the Timeline page first.`;

  const after = cmd.after ? findByName(tasks, cmd.after) : null;
  if (cmd.after && !after) return `There's no task like ${cmd.after} on ${projName}.`;
  const parent = cmd.under ? findByName(tasks, cmd.under) : null;
  const underPhase = cmd.under && !parent ? findByName(phases, cmd.under) : null;
  if (cmd.under && !parent && !underPhase) return `There's no task or phase like ${cmd.under} on ${projName}.`;

  // Start: spoken date > day after the "after" task > parent's start > today
  const start = cmd.date
    ?? (after ? addDays(after.end_date, 1)! : null)
    ?? parent?.start_date
    ?? today();
  const end = cmd.milestone ? start : addDays(start, (cmd.days ?? DEFAULT_DAYS) - 1)!;

  // Phase: named phase > parent's/after's phase > phase whose tasks cover the start date > last phase
  const phaseId = underPhase?.id ?? parent?.phase_id ?? after?.phase_id
    ?? phases.find((p) => tasks.some((t) => t.phase_id === p.id && (t.start_date ?? t.end_date) <= start && t.end_date >= start))?.id
    ?? phases[phases.length - 1].id;

  const sortOrder = tasks.filter((t) => t.phase_id === phaseId)
    .reduce((m, t) => Math.max(m, t.sort_order ?? 0), -1) + 1;

  const { data: created, error } = await sb.from(TASKS).insert({
    project_id: ctx.projectId,
    phase_id: phaseId,
    parent_task_id: parent?.id ?? null,
    item_type: cmd.milestone ? "milestone" : "task",
    name: titleCase(cmd.title),
    start_date: start,
    end_date: end,
    sort_order: sortOrder,
    created_by: ctx.who.id,
    created_by_name: ctx.who.name,
    updated_by: ctx.who.id,
    updated_by_name: ctx.who.name,
  }).select().single();
  if (error) throw error;

  if (after) {
    const { error: dErr } = await sb.from(DEPS).insert({
      project_id: ctx.projectId,
      predecessor_task_id: after.id,
      successor_task_id: created.id,
      dependency_type: "finish_to_start",
      created_by: ctx.who.id,
    });
    if (dErr) console.error("dependency insert failed", dErr);
  }

  // before.__created tells undo to delete the row (its dependency goes with it)
  await log(ctx, created.id, { __created: true }, created);

  const phaseName = phases.find((p) => p.id === phaseId)?.name;
  const where = after ? ` after ${after.name}` : parent ? ` under ${parent.name}` : ` in ${phaseName}`;
  return cmd.milestone
    ? `Added milestone ${created.name}${where}, ${fmt(start)}.`
    : `Added ${created.name}${where}, ${fmt(start)} to ${fmt(end)}.`;
}

// Revert this person's most recent voice change (every row in that batch).
async function undo(who: Who) {
  const { data: last } = await sb.from(LOG).select("batch_id")
    .eq("staff_user_id", who.id).eq("undone", false)
    .order("created_at", { ascending: false }).limit(1);
  if (!last?.length) return say("There's nothing to undo.");
  const batch = last[0].batch_id;
  const { data: rows, error } = await sb.from(LOG).select("*").eq("batch_id", batch);
  if (error) throw error;
  for (const r of rows ?? []) {
    const { error: uErr } = r.before?.__created
      ? await sb.from(r.item_table || TASKS).delete().eq("id", r.item_id)
      : await sb.from(r.item_table || TASKS).update({
        ...r.before,
        updated_at: new Date().toISOString(),
        updated_by: who.id,
        updated_by_name: who.name,
      }).eq("id", r.item_id);
    if (uErr) throw uErr;
  }
  await sb.from(LOG).update({ undone: true }).eq("batch_id", batch);
  return say(`Undid "${rows?.[0]?.command}".`);
}

// ================= parsing =================

type AddCmd = { kind: "add"; title: string; milestone?: boolean; after?: string; under?: string; date?: string; days?: number };
type Cmd =
  | { kind: "shift"; task: string; days: number }
  | { kind: "moveTo"; task: string; date: string }
  | { kind: "progress"; task: string; progress: number }
  | { kind: "done"; task: string }
  | { kind: "started"; task: string }
  | AddCmd;

const WORDNUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const num = (s: string) => WORDNUM[s] ?? parseInt(s, 10);
const unitDays = (u: string) => (u.startsWith("week") ? 7 : 1);
const AMT = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?)`;

function parse(t: string): Cmd | null {
  let m: RegExpMatchArray | null;

  // "add drywall after framing starting nov 20 for 2 weeks" / "add milestone final walk on 1/15"
  if ((m = t.match(/^(?:add|create|new)\s+(.+)$/))) {
    let rest = m[1];
    const cmd: AddCmd = { kind: "add", title: "" };
    if ((m = rest.match(/^(?:a\s+)?milestone\s+(?:called\s+)?(.+)$/))) { cmd.milestone = true; rest = m[1]; }
    for (let k = 0; k < 3; k++) { // peel optional clauses off the end, any order
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

  // "framing 50 percent" / "set framing to 75%"
  if ((m = t.match(/^(?:set\s+|mark\s+)?(.+?)\s+(?:to\s+|at\s+|is\s+)?(\d{1,3})\s*(?:%|percent)(?:\s+(?:done|complete))?$/)))
    return { kind: "progress", task: m[1], progress: +m[2] };

  // "move framing to november 18" / "start site clean on 12/1"
  if ((m = t.match(/^(?:move|start|reschedule|set)\s+(.+?)\s+(?:to|for|on)\s+(.+)$/))) {
    const d = parseDate(m[2]);
    if (d) return { kind: "moveTo", task: m[1], date: d };
  }

  // earlier
  if ((m = t.match(new RegExp(String.raw`^(?:pull|move|bring|bump|slide)\s+(.+?)\s+(?:up|forward|in|ahead|earlier)\s+(?:by\s+)?${AMT}$`))))
    return { kind: "shift", task: m[1], days: -num(m[2]) * unitDays(m[3]) };

  // later
  if ((m = t.match(new RegExp(String.raw`^(?:push|delay|move|bump|slide)\s+(.+?)\s+(?:back\s+|out\s+)?(?:by\s+)?${AMT}(?:\s+(?:back|out|later))?$`))))
    return { kind: "shift", task: m[1], days: num(m[2]) * unitDays(m[3]) };

  if ((m = t.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/))) return { kind: "done", task: m[1] };
  if ((m = t.match(/^(?:finish|complete)\s+(.+)$/))) return { kind: "done", task: m[1] };
  if ((m = t.match(/^(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:started|in progress)$/))) return { kind: "started", task: m[1] };

  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "november 18", "nov 18th 2027", "11/18", "11/18/27", "2026-11-18".
// No year -> this year, or next year if that date already passed.
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
  if (y === null) {
    y = new Date().getUTCFullYear();
    if (iso(y, mo, d) < today()) y++;
  }
  return iso(y, mo, d);
}

// ================= helpers =================

const today = () => new Date().toISOString().slice(0, 10);
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[-_]/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function addDays(d: string | null, n: number): string | null {
  if (!d) return d;
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const fmt = (d: string | null) =>
  d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "no date";

// Exact name match first, then partial.
function findByName(rows: Row[], q: string) {
  const nq = norm(q.replace(/^the\s+/, "").replace(/\s+(phase|task)$/, ""));
  return rows.find((r) => norm(r.name) === nq) ??
    rows.find((r) => norm(r.name).includes(nq) || nq.includes(norm(r.name)));
}

// Roots + their subtasks (parent_task_id) + successors (schedule_dependencies), recursively.
function downstream(tasks: Row[], deps: Row[], rootIds: string[]) {
  const found = new Set<string>(rootIds);
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop()!;
    const next = [
      ...tasks.filter((t) => t.parent_task_id === id).map((t) => t.id),
      ...deps.filter((d) => d.predecessor_task_id === id).map((d) => d.successor_task_id),
    ];
    for (const n of next) if (!found.has(n)) { found.add(n); stack.push(n); }
  }
  return found;
}
