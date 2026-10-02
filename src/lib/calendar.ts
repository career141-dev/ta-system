/**
 * The business calendar — spec §12.3.
 *
 * Pure, with no data access, so it can be tested on its own and imported
 * anywhere. Assumed Asia/Colombo, Monday to Friday, 18:00 cutoff until told
 * otherwise (Q10).
 */

export const TIMEZONE = "Asia/Colombo";
export const DAILY_CUTOFF_HOUR = 18;

/** Holidays live here when the TA Lead can maintain them — phase 6 leaves it empty. */
export const HOLIDAYS: string[] = [];

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * Whether the Colombo day containing `d` is a working day. Read on the
 * Colombo clock, not the server's: the server runs on UTC, where Monday's
 * first five and a half Colombo hours are still Sunday (2 Oct).
 */
export function isWorkingDay(d: Date): boolean {
  const colombo = new Date(d.getTime() + COLOMBO_OFFSET_MS);
  const day = colombo.getUTCDay();
  if (day === 0 || day === 6) return false;
  return HOLIDAYS.length === 0 || !HOLIDAYS.includes(colombo.toISOString().slice(0, 10));
}

/**
 * Hours between two instants, counting working days only.
 *
 * Notebook page 9 is explicit that the weekend does not count toward the
 * 24-hour shortlist rule — otherwise every Monday morning opens with the whole
 * team in breach for not having worked Saturday.
 */
export function workingHoursBetween(from: number, to: number): number {
  return countWorkingHours(from, to, Infinity);
}

/**
 * Whether at least `hours` working hours lie between two instants — the same
 * answer as `workingHoursBetween(from, to) >= hours`, but it stops counting the
 * moment the answer is known. For a CV that arrived months ago that is after a
 * day or two of calendar, not months of it.
 */
export function hasWorkingHours(from: number, to: number, hours: number): boolean {
  return countWorkingHours(from, to, hours) >= hours;
}

const WEEK = 7 * 86_400_000;

function countWorkingHours(from: number, to: number, stopAt: number): number {
  if (to <= from) return 0;
  let hours = 0;
  let at = from;
  /*
   * Whole weeks, counted once.
   *
   * Hour steps from `at` fall at the same Colombo times on the same weekdays
   * a week later — Colombo has no daylight saving — so a week's working hours
   * repeat exactly, provided no holiday falls in it. Holidays are checked by
   * walking, so this only applies when there are none.
   */
  if (HOLIDAYS.length === 0) {
    while (to - at >= 2 * WEEK && hours < stopAt) {
      const week = walk(at, at + WEEK, Infinity);
      hours += week;
      at += WEEK;
      while (to - at >= 2 * WEEK && hours < stopAt) {
        hours += week;
        at += WEEK;
      }
    }
  }
  return hours + walk(at, to, stopAt - hours);
}

function walk(from: number, to: number, stopAt: number): number {
  if (to <= from || stopAt <= 0) return 0;
  /*
   * The rule is still "step an hour at a time from `from`, and count the step
   * if the day it STARTS on is a working day". What changed is that runs of
   * steps starting on the same day are counted together instead of one by one.
   *
   * Every step that starts before the next day boundary is judged by the same
   * day, so they can be added in one go. The boundary is Colombo midnight:
   * both the weekday and the holiday list are read on the Colombo date (2 Oct;
   * until then the server's local day and the UTC date).
   *
   * The hour-by-hour loop ran once per hour per application. The shortlist
   * alert asks it about every unscreened CV on the desk — about 7,000, many
   * months old — so it was millions of iterations and 2.9 of the 3.1 seconds
   * every page spent working out the alert badge. This does a few iterations
   * per day instead, with the same answer (tests/calendar.test.ts checks it
   * against the original over thousands of ranges).
   */
  const HOUR = 3_600_000;
  let hours = 0;
  let at = from;
  // One Date object reused for the whole walk rather than one per day.
  const probe = new Date(from);
  while (at < to && hours < stopAt) {
    probe.setTime(at);
    const boundary = Math.min(colomboDayStart(at) + 86_400_000, to);
    const steps = Math.max(1, Math.ceil((boundary - at) / HOUR));
    const end = Math.min(at + steps * HOUR, to);
    if (isWorkingDay(probe)) hours += (end - at) / HOUR;
    at = end;
  }
  return hours;
}

/** The next working morning, for holding routine alerts. */
export function nextWorkingDay(from = new Date()): Date {
  const d = new Date(from);
  d.setHours(9, 0, 0, 0);
  do {
    d.setDate(d.getDate() + 1);
  } while (!isWorkingDay(d));
  return d;
}

/** Colombo is UTC+05:30 all year — no daylight saving to account for. */
export const COLOMBO_OFFSET_MS = 5.5 * 3_600_000;

/**
 * Midnight in Colombo for the day containing `at`, as an instant.
 *
 * Written against the offset rather than the server's local clock: a desk day
 * is a Colombo day wherever the server happens to run. Server-local Date
 * methods here were finding 16 of the 13 September audit.
 */
export function colomboDayStart(at: number): number {
  const shifted = at + COLOMBO_OFFSET_MS;
  return shifted - (((shifted % 86_400_000) + 86_400_000) % 86_400_000) - COLOMBO_OFFSET_MS;
}

/**
 * Calendar days between two instants in Colombo timezone (UTC+05:30).
 * Returns 0 if `from` is on the same Colombo calendar day as `to`.
 * Returns 1 if `from` was yesterday in Colombo, etc.
 */
export function colomboDaysBetween(from: number, to = Date.now()): number {
  const startFrom = colomboDayStart(from);
  const startTo = colomboDayStart(to);
  return Math.max(0, Math.round((startTo - startFrom) / 86_400_000));
}

/**
 * "Today", "Yesterday", or "Mon 28 Sep" for the Colombo day containing `at` —
 * with the year once it is not this year's.
 */
export function colomboDayLabel(at: number, now = Date.now()): string {
  const day = colomboDayStart(at);
  const today = colomboDayStart(now);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  const year = (t: number) => new Date(t + COLOMBO_OFFSET_MS).getUTCFullYear();
  return new Date(at)
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(year(at) !== year(now) ? { year: "numeric" as const } : {}),
      timeZone: TIMEZONE,
    })
    .replace(",", "");
}

/**
 * Items split into Colombo days, newest day first and newest first inside it.
 *
 * For Director review, where the Director reads the list batch by batch: the
 * three sent today apart from the five sent yesterday (30 Sep).
 */
export function groupByColomboDay<T>(items: T[], at: (t: T) => number): { dayStart: number; items: T[] }[] {
  const days = new Map<number, T[]>();
  for (const item of [...items].sort((a, b) => at(b) - at(a))) {
    const day = colomboDayStart(at(item));
    const list = days.get(day);
    if (list) list.push(item);
    else days.set(day, [item]);
  }
  return [...days].map(([dayStart, items]) => ({ dayStart, items }));
}

/** The Colombo hour (0–23) at an instant. */
export function colomboHour(at: number): number {
  return Math.floor((((at + COLOMBO_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000);
}

/**
 * "Good morning" by the desk's clock. The pages read `new Date().getHours()`,
 * which is the server's hour — UTC on the VPS — so Colombo was greeted with
 * "Good morning" until 5:30 in the afternoon (3 Oct).
 */
export function colomboGreeting(at = Date.now()): string {
  const hour = colomboHour(at);
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/**
 * A "YYYY-MM-DDTHH:mm" typed into a form, read as Colombo time.
 * `new Date("2026-09-14T10:00")` reads it in the server's zone instead.
 */
export function colomboLocalToInstant(local: string): number | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return utc - COLOMBO_OFFSET_MS;
}
