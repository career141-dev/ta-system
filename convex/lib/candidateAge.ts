/**
 * A candidate's birth date, read from their CV — 28 Sep 2026, at the owner's
 * request: "the age calculation performed for every candidate".
 *
 * Nothing worked age out before. `candidates.age` existed and was only ever
 * set by hand, so almost nobody had one. What is stored now is the birth date,
 * not the age: an age written down is wrong a year later, a birth date never.
 * The age is worked out from it on the day it is shown (ageOn).
 *
 * Three sources, in the order they are trusted:
 *   1. A date of birth the CV states ("Date of Birth: 12/03/1990").
 *   2. A Sri Lankan NIC number. It carries the birth date itself — most local
 *      CVs have one — so it is exact, and it checks the stated date.
 *   3. An age the CV states ("Age: 34"), taken back to a birth year from the
 *      day the CV was received. Approximate by a year, and marked so.
 *
 * Pure, and shared by the backend (CV extraction, the backfill migration) and
 * the tests. Dates are read day-first, as Sri Lankan and Gulf CVs write them.
 */

export type BirthSource = "dob" | "nic" | "stated_age";

export interface Birth {
  /** YYYY-MM-DD, or YYYY-07-01 when only the year is known. */
  date: string;
  source: BirthSource;
  /** "exact" to the day; "year" when only the year could be worked out. */
  precision: "exact" | "year";
  /** When the CV's own date and its NIC disagree — worth a look. */
  mismatch?: string;
}

/** The youngest and oldest age a working candidate plausibly has. */
const MIN_AGE = 16;
const MAX_AGE = 75;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/** A date as a CV writes it, day-first. Null when it is not a full date. */
export function parseDayFirst(raw: string): { y: number; m: number; d: number } | null {
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/\bof\b/g, " ");
  let m = s.match(/^(\d{4})[./\-\s](\d{1,2})[./\-\s](\d{1,2})\b/); // 1990-03-12
  if (m) return validDate(+m[1], +m[2], +m[3]) ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  m = s.match(/^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{4})\b/); // 12/03/1990 — day first
  if (m) {
    if (validDate(+m[3], +m[2], +m[1])) return { y: +m[3], m: +m[2], d: +m[1] };
    // 03/25/1990 cannot be day-first; it is the one American date we can read.
    if (validDate(+m[3], +m[1], +m[2])) return { y: +m[3], m: +m[1], d: +m[2] };
    return null;
  }
  m = s.match(/^(\d{1,2})[\s.\-/,]+([a-z]{3,9})[\s.\-/,]+(\d{4})\b/); // 12 March 1990
  if (m && MONTHS[m[2].slice(0, 3)]) {
    const mo = MONTHS[m[2].slice(0, 3)];
    return validDate(+m[3], mo, +m[1]) ? { y: +m[3], m: mo, d: +m[1] } : null;
  }
  m = s.match(/^([a-z]{3,9})[\s.\-/,]+(\d{1,2})[\s.\-/,]+(\d{4})\b/); // March 12, 1990
  if (m && MONTHS[m[1].slice(0, 3)]) {
    const mo = MONTHS[m[1].slice(0, 3)];
    return validDate(+m[3], mo, +m[2]) ? { y: +m[3], m: mo, d: +m[2] } : null;
  }
  return null;
}

/**
 * A Sri Lankan NIC's birth date. Old: YYDDD…V/X (nine digits and a letter);
 * new: YYYYDDD… (twelve digits). DDD is the day of the year, plus 500 for a
 * woman, counted on a 366-day calendar whatever the year — the NIC's own
 * rule, so 60 is always 29 February and 61 always 1 March.
 */
export function birthFromNic(nic: string): { y: number; m: number; d: number } | null {
  const s = nic.trim().toUpperCase();
  let y: number;
  let day: number;
  if (/^\d{9}[VX]$/.test(s)) {
    y = 1900 + Number(s.slice(0, 2));
    day = Number(s.slice(2, 5));
  } else if (/^\d{12}$/.test(s)) {
    y = Number(s.slice(0, 4));
    day = Number(s.slice(4, 7));
  } else return null;
  if (day > 500) day -= 500;
  if (day < 1 || day > 366 || y < 1900) return null;
  const LEAP = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let m = 0;
  while (day > LEAP[m]) day -= LEAP[m++];
  // 29 February on an NIC issued for a year that had none: the day is the 28th or the 1st, not a valid date.
  if (!validDate(y, m + 1, day)) return null;
  return { y, m: m + 1, d: day };
}

/** An age in whole years on a given day. */
export function ageOn(birthDate: string, asOf: Date = new Date()): number | null {
  const m = birthDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  let age = asOf.getUTCFullYear() - y;
  if (asOf.getUTCMonth() + 1 < mo || (asOf.getUTCMonth() + 1 === mo && asOf.getUTCDate() < d)) age--;
  return age;
}

const plausible = (y: number, m: number, d: number, asOf: Date) => {
  const age = ageOn(iso(y, m, d), asOf);
  return age !== null && age >= MIN_AGE && age <= MAX_AGE;
};

const DOB_LABEL = /\b(?:date\s*of\s*birth|d\.?\s?o\.?\s?b\.?|birth\s*date|birthday|born(?:\s+on)?)\b\.?\s*[:\-–]?\s*([^\n]{6,40})/gi;
const NIC_LABELLED = /\b(?:n\.?\s?i\.?\s?c\.?|national\s+identity(?:\s+card)?|identity\s+card|id\s*(?:no|number|#))\b[^0-9\n]{0,20}(\d{9}[vVxX]|\d{12})\b/gi;
const NIC_OLD_BARE = /\b(\d{9}[vVxX])\b/g;
const AGE_LABEL = /\bage\b\s*[:\-–]?\s*(\d{2})\s*(?:years?|yrs?)?\b/gi;

/**
 * The best birth date a CV gives, or null. `received` is when the CV came in,
 * which a stated age counts from.
 */
export function findBirth(rawText: string, received: Date = new Date()): Birth | null {
  const text = rawText ?? "";
  const asOf = new Date();

  let stated: { y: number; m: number; d: number } | null = null;
  for (const m of text.matchAll(DOB_LABEL)) {
    const d = parseDayFirst(m[1]);
    if (d && plausible(d.y, d.m, d.d, asOf)) {
      stated = d;
      break;
    }
  }

  let fromNic: { y: number; m: number; d: number } | null = null;
  for (const re of [NIC_LABELLED, NIC_OLD_BARE]) {
    for (const m of text.matchAll(re)) {
      const d = birthFromNic(m[1]);
      if (d && plausible(d.y, d.m, d.d, asOf)) {
        fromNic = d;
        break;
      }
    }
    if (fromNic) break;
  }

  if (stated && fromNic) {
    const a = iso(stated.y, stated.m, stated.d);
    const b = iso(fromNic.y, fromNic.m, fromNic.d);
    // The NIC is issued from the birth certificate; a typed date is the one
    // more likely to be wrong. Kept, and the difference said.
    return a === b
      ? { date: a, source: "dob", precision: "exact" }
      : { date: b, source: "nic", precision: "exact", mismatch: `CV says ${a}, NIC says ${b}` };
  }
  if (stated) return { date: iso(stated.y, stated.m, stated.d), source: "dob", precision: "exact" };
  if (fromNic) return { date: iso(fromNic.y, fromNic.m, fromNic.d), source: "nic", precision: "exact" };

  for (const m of text.matchAll(AGE_LABEL)) {
    const age = Number(m[1]);
    if (age < MIN_AGE || age > MAX_AGE) continue;
    // Mid-year: the birthday could fall either side of the day the CV came in.
    const y = received.getUTCFullYear() - age;
    if (plausible(y, 7, 1, asOf)) return { date: iso(y, 7, 1), source: "stated_age", precision: "year" };
  }
  return null;
}
