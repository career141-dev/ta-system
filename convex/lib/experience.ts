/**
 * Total professional experience, from the job history a CV gives — rebuilt
 * 28 Sep 2026, when the owner asked for it to be "significantly more accurate"
 * and for the figures we already had to be checked.
 *
 * What was wrong with the old sum (candidates/derivations.ts), found on review:
 *  - It was worked out once, when the CV was read, and stored. A job still
 *    running ("present") stopped counting that day: a CV read in 2022 still
 *    showed its 2022 total. `experienceOn` counts to the day it is asked.
 *  - Dates went through `new Date()`, which reads 01/03/2019 month-first,
 *    American style, and cannot read 03/2019, Mar'19 or "Jan 2019 - Till date"
 *    at all; a date it could not read dropped the whole job.
 *  - A year alone was the 1st of January, so "2019 – 2021" was two years
 *    where it may be nearly three, and "2019 – 2019" was nothing at all.
 *
 * Now: dates are read day-first, as the desk's CVs write them, with month
 * names and the ways CVs say "still here"; a year alone runs January to
 * December when it ends a job; overlapping jobs are counted once; a job that
 * starts before the person could have worked (before 15, when the birth date
 * is known) or in the future is left out; and the result says how sure it is.
 *
 * Pure, and shared by the backend and the tests.
 */

export interface JobDates {
  startDate?: string | null;
  endDate?: string | null;
}

export interface Experience {
  /** Years, to one decimal. */
  years: number;
  /** A job in it is still running, so the figure grows by itself. */
  current: boolean;
  /** Some dates were a year alone, so it may be out by up to a year. */
  approximate: boolean;
  /** Jobs counted, and jobs whose dates could not be used. */
  counted: number;
  skipped: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const STILL_HERE = /^(present|current(ly)?|now|to\s*date|till\s*(date|now)|until\s*now|up\s*to\s*(date|now)|ongoing|continuing|to\s*present|still\s*working|working)$/i;

export interface CvDate {
  /** Year and month (1–12); month is null when the CV gave only a year. */
  y: number;
  m: number | null;
  /** The CV said the job is still running. */
  present?: boolean;
}

/** One date as a CV writes it. Null when there is nothing usable in it. */
export function parseCvDate(raw: string | null | undefined): CvDate | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/[.,]+$/, "").replace(/\s+/g, " ");
  if (!s) return null;
  if (STILL_HERE.test(s)) return { y: 0, m: null, present: true };

  const year = (t: string) => {
    let y = Number(t);
    if (t.length === 2) y += y > 50 ? 1900 : 2000; // Mar'19
    return y >= 1950 && y <= 2100 ? y : null;
  };
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:t.*)?$/))) {
    // 2019-03, 2019/03, 2019-03-01
    const y = year(m[1]);
    const mo = +m[2];
    return y && mo >= 1 && mo <= 12 ? { y, m: mo } : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    // 01/03/2019 — day first; 03/25/2019 can only be month first.
    const y = year(m[3]);
    const a = +m[1];
    const b = +m[2];
    const mo = b >= 1 && b <= 12 ? b : a >= 1 && a <= 12 ? a : null;
    return y && mo ? { y, m: mo } : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/))) {
    // 03/2019
    const y = year(m[2]);
    const mo = +m[1];
    return y && mo >= 1 && mo <= 12 ? { y, m: mo } : null;
  }
  if ((m = s.match(/^(?:\d{1,2}(?:st|nd|rd|th)?\s+)?([a-z]{3,9})[\s\-'’.,/]*(\d{4}|\d{2})$/))) {
    // Jan 2019, January 2019, Jan-2019, Jan'19, 1st March 2019
    const mo = MONTHS[m[1].slice(0, 3)];
    const y = year(m[2]);
    return mo && y ? { y, m: mo } : null;
  }
  if ((m = s.match(/^(\d{4})\s*([a-z]{3,9})$/))) {
    // 2019 March
    const mo = MONTHS[m[2].slice(0, 3)];
    const y = year(m[1]);
    return mo && y ? { y, m: mo } : null;
  }
  if ((m = s.match(/^(\d{4})$/))) {
    const y = year(m[1]);
    return y ? { y, m: null } : null;
  }
  return null;
}

const DAY = 86_400_000;

/**
 * Years of experience on a given day. Null when no job's dates can be used.
 * `birthYear`, when known, drops jobs that start before the person was 15 —
 * school years and schooling written as jobs.
 */
export function experienceOn(jobs: JobDates[] | null | undefined, asOf: Date = new Date(), birthYear?: number | null): Experience | null {
  const now = asOf.getTime();
  const intervals: { start: number; end: number }[] = [];
  let approximate = false;
  let current = false;
  let skipped = 0;

  for (const job of jobs ?? []) {
    const start = parseCvDate(job.startDate);
    const endRaw = (job.endDate ?? "").trim();
    // No end date on a job is how many CVs write the current one.
    const end = endRaw ? parseCvDate(endRaw) : { y: 0, m: null, present: true };
    if (!start || start.present || !end) {
      skipped++;
      continue;
    }
    if (birthYear && start.y < birthYear + 15) {
      skipped++;
      continue;
    }
    // A job starts at the start of its month, or of its year.
    const s = Date.UTC(start.y, (start.m ?? 1) - 1, 1);
    // …and ends at the end of its month or year, or today.
    const e = end.present ? now : end.m ? Date.UTC(end.y, end.m, 1) - DAY : Date.UTC(end.y, 11, 31);
    if (start.m === null || (!end.present && end.m === null)) approximate = true;
    if (s > now) {
      skipped++;
      continue;
    }
    const clampedEnd = Math.min(e, now);
    if (clampedEnd <= s) {
      skipped++;
      continue;
    }
    if (end.present || e >= now) current = true;
    intervals.push({ start: s, end: clampedEnd });
  }
  if (!intervals.length) return null;

  // Two jobs at once are one stretch of working life, counted once.
  intervals.sort((a, b) => a.start - b.start);
  const merged = [intervals[0]];
  for (const i of intervals.slice(1)) {
    const last = merged[merged.length - 1];
    if (i.start <= last.end + DAY) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  const days = merged.reduce((sum, i) => sum + (i.end - i.start) / DAY + 1, 0);
  return { years: Math.round((days / 365.25) * 10) / 10, current, approximate, counted: intervals.length, skipped };
}

/** "10+ years of experience" as the CV states it, for checking the sum against. */
export function statedExperience(text: string | null | undefined): number | null {
  const m = (text ?? "").match(/\b(\d{1,2})(?:\.\d)?\s*\+?\s*(?:years?|yrs?)(?:\s+and\s+\d+\s+months?)?\s+(?:of\s+)?(?:[\w-]+\s+){0,3}?(?:experience|exp\b)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 50 ? n : null;
}

/**
 * The CV's own claim beside the sum of its dates: said when they disagree by
 * more than two years, so a TA knows which figure to question.
 */
export function experienceCheck(sum: Experience | null, stated: number | null): string | null {
  if (stated === null) return null;
  if (!sum) return `CV says ${stated} years; its job dates could not be read`;
  if (Math.abs(sum.years - stated) > 2) return `CV says ${stated} years; its job dates add up to ${sum.years}`;
  return null;
}
