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

export function isWorkingDay(d: Date): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  return HOLIDAYS.length === 0 || !HOLIDAYS.includes(d.toISOString().slice(0, 10));
}

/**
 * Hours between two instants, counting working days only.
 *
 * Notebook page 9 is explicit that the weekend does not count toward the
 * 24-hour shortlist rule — otherwise every Monday morning opens with the whole
 * team in breach for not having worked Saturday.
 */
export function workingHoursBetween(from: number, to: number): number {
  if (to <= from) return 0;
  let hours = 0;
  // Whole weeks first. Stepping hour by hour is what the rule means, but the
  // restored database has CVs years old, and the alerts ask this of every one
  // of them: tens of millions of steps, seven seconds a page. Any 168 hours
  // hold five whole working days — as long as no holiday can fall inside, so
  // with holidays set the walk below does all of it.
  if (HOLIDAYS.length === 0) {
    const weeks = Math.floor((to - from) / WEEK_MS);
    if (weeks > 1) {
      // One week is left to the walk, so a daylight-saving hour near either
      // end is still counted the slow, exact way.
      hours += (weeks - 1) * 120;
      from += (weeks - 1) * WEEK_MS;
    }
  }
  const cursor = new Date(from);
  while (cursor.getTime() < to) {
    const next = Math.min(cursor.getTime() + 3_600_000, to);
    if (isWorkingDay(cursor)) hours += (next - cursor.getTime()) / 3_600_000;
    cursor.setTime(next);
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
const COLOMBO_OFFSET_MS = 5.5 * 3_600_000;

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

/** The Colombo hour (0–23) at an instant. */
export function colomboHour(at: number): number {
  return Math.floor((((at + COLOMBO_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000);
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
