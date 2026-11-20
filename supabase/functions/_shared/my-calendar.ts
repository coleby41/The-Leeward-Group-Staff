// My Calendar (2026-11-20) — each staff member's own events, made in the
// portal (no Google / Outlook). Used by push-send (phone reminders).
//
// Events are stored as wall-clock dates/times in their time zone
// (start_date, start_time, end_date, end_time, tz), so repeats keep the same
// local time across daylight saving changes.
// The browser copy of this logic is js/dashboard/my-calendar.js.

// deno-lint-ignore no-explicit-any
type Row = any;

export const REPEATS = ["none", "daily", "weekly", "monthly", "yearly"] as const;
// All-day events remind as if they start at 9:00 AM.
export const ALL_DAY_REMINDER_TIME = "09:00";

const DAY = 86400000;
const toUtcDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fromUtcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fromUtcDay(toUtcDay(s) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toUtcDay(b) - toUtcDay(a)) / DAY);

// "2026-01-31" + 1 month -> null (no Feb 31st; that month is skipped)
function addMonths(s: string, n: number): string | null {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  return t.getUTCDate() === d ? fromUtcDay(t.getTime()) : null;
}

// Start dates of every occurrence whose days overlap [from, to] (inclusive dates).
export function occurrenceDates(ev: Row, from: string, to: string): string[] {
  const start = ev.start_date as string;
  const span = Math.max(0, daysBetween(start, ev.end_date || start));
  const until = ev.repeat && ev.repeat !== "none" ? (ev.repeat_until || "9999-12-31") : start;
  const out: string[] = [];
  const keep = (d: string) => { if (d <= to && addDays(d, span) >= from && d <= until) out.push(d); };
  if (!ev.repeat || ev.repeat === "none") { keep(start); return out; }
  if (ev.repeat === "daily" || ev.repeat === "weekly") {
    const step = ev.repeat === "daily" ? 1 : 7;
    let k = Math.max(0, Math.floor((daysBetween(start, from) - span) / step));
    for (let i = 0; i < 1000; i++, k++) {
      const d = addDays(start, k * step);
      if (d > to || d > until) break;
      keep(d);
    }
    return out;
  }
  const months = ev.repeat === "monthly" ? 1 : 12;
  for (let k = 0; k < 3000; k++) {
    const d = addMonths(start, k * months);
    if (d === null) continue;
    if (d > to || d > until) break;
    keep(d);
  }
  return out;
}

// Minutes the time zone is ahead of UTC at that moment.
function tzOffsetMs(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - at.getTime();
}

// Wall-clock date + time in a time zone -> the real moment.
export function zonedToUtc(date: string, time: string | null, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = String(time || "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h || 0, mi || 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

// The day "now" is in that time zone, as YYYY-MM-DD.
export function zonedToday(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

export interface Occurrence { event: Row; date: string; start: Date; end: Date }

// Occurrences of events between two moments (by start).
export function occurrencesBetween(events: Row[], fromAt: Date, toAt: Date): Occurrence[] {
  const out: Occurrence[] = [];
  for (const ev of events) {
    const tz = ev.tz || "America/New_York";
    const from = addDays(zonedToday(tz, fromAt), -1), to = addDays(zonedToday(tz, toAt), 1);
    for (const date of occurrenceDates(ev, from, to)) {
      const span = Math.max(0, daysBetween(ev.start_date, ev.end_date || ev.start_date));
      const start = zonedToUtc(date, ev.all_day ? "00:00" : ev.start_time, tz);
      const end = ev.all_day ? zonedToUtc(addDays(date, span + 1), "00:00", tz) : zonedToUtc(addDays(date, span), ev.end_time || ev.start_time, tz);
      if (end > fromAt && start <= toAt) out.push({ event: ev, date, start, end });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// When a reminder "minutes before" fires for one occurrence.
export function reminderAt(ev: Row, date: string, minutes: number): Date {
  const base = zonedToUtc(date, ev.all_day ? ALL_DAY_REMINDER_TIME : ev.start_time, ev.tz || "America/New_York");
  return new Date(base.getTime() - minutes * 60000);
}

export function reminderLabel(minutes: number): string {
  if (minutes === 0) return "Starting now";
  if (minutes < 60) return `In ${minutes} minutes`;
  if (minutes === 60) return "In 1 hour";
  if (minutes < 1440) return `In ${Math.round(minutes / 60)} hours`;
  if (minutes === 1440) return "Tomorrow";
  if (minutes === 10080) return "In 1 week";
  return `In ${Math.round(minutes / 1440)} days`;
}

export function timeLabel(ev: Row, start: Date): string {
  const tz = ev.tz || "America/New_York";
  if (ev.all_day) return start.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }) + " · All day";
  return start.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
