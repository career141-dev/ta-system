/**
 * Where a candidate has worked, and whether that is the company a search asked for.
 *
 * Database search could not find people by employer (9 Oct). Only the current
 * employer had a search index, keyword search did not use it, and past
 * employers were in no index and no score. So "HR personnel in Dialog" only
 * found people whose CV text happened to say "Dialog". The owner's rule: a
 * company named in a search keeps only people who worked there, now or before,
 * with the people there now ranked first.
 *
 * Pure, with no database, network or Node, so the backend, the web app and the
 * tests all use the same code.
 */
import { companyMatch } from "./samePerson";
import { resolveLocationViaGazetteer } from "./gazetteer";

export type JobLine = { title?: string | null; company?: string | null; startDate?: string | null; endDate?: string | null };

type HasCareer = { currentEmployer?: string | null; jobHistory?: JobLine[] | null; employersText?: string | null };

/**
 * The career to read. Extraction writes the dated history to the résumé row,
 * so it wins when it has entries, and the candidate row's own copy is the
 * fallback. This is the same rule as `withCareer` in ta/candidates.ts.
 */
export function careerOf(candidate: { jobHistory?: JobLine[] | null }, resume?: { jobHistory?: JobLine[] | null } | null): JobLine[] {
  return (resume?.jobHistory?.length ? resume.jobHistory : candidate.jobHistory) ?? [];
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Every employer, current first, each company once even when spelled two ways. */
export function employersOf(candidate: HasCareer, resume?: { jobHistory?: JobLine[] | null } | null): string[] {
  const out: string[] = [];
  const add = (name: string | null | undefined) => {
    const n = clean(name);
    if (n.length < 2) return;
    if (out.some((o) => companyMatch(o, n) === "same" || o.toLowerCase() === n.toLowerCase())) return;
    out.push(n);
  };
  add(candidate.currentEmployer);
  for (const job of careerOf(candidate, resume)) add(job.company);
  return out;
}

/**
 * The text the employer search index reads, or undefined when nobody is named.
 * Undefined rather than "", so a candidate with no career does not sit in the
 * index as an empty document.
 */
export function employersTextOf(candidate: HasCareer, resume?: { jobHistory?: JobLine[] | null } | null): string | undefined {
  const all = employersOf(candidate, resume);
  return all.length ? all.join(" | ").slice(0, 2000) : undefined;
}

export type EmployerHit = {
  /** "current": works there now. "past": an earlier job. */
  when: "current" | "past";
  /** "same": the same distinctive words. "close": one name sits inside the other. */
  how: "same" | "close";
  /** The company as the CV spells it. */
  company: string;
  /** The years worked there, when the CV dates the job: "2019–2022", "2021–now". */
  years: string | null;
  /** 100 for current/same, down to 70 for past/close. */
  score: number;
};

const year = (d: string | null | undefined) => (d ?? "").match(/(19|20)\d{2}/)?.[0] ?? null;
const isOngoing = (d: string | null | undefined) => !d || /present|current|now|to date|ongoing/i.test(d);

function yearsOf(job: JobLine): string | null {
  const from = year(job.startDate);
  const to = isOngoing(job.endDate) ? "now" : year(job.endDate);
  if (!from && !to) return null;
  if (!from) return `until ${to}`;
  return `${from}–${to ?? "?"}`;
}

const SCORE = { current: { same: 100, close: 90 }, past: { same: 80, close: 70 } } as const;

/**
 * The best match between the companies asked for and where this person worked.
 *
 * The current employer is the `currentEmployer` field, or else the first job
 * in the career that has no end date. "Dialog" matches "Dialog Axiata PLC";
 * company suffixes ("Pvt Ltd", "PLC", "Lanka") are ignored, and generic
 * entries like "Self employed" or "Freelance" never match (lib/samePerson).
 * When the career is not loaded but `employersText` is, a match there counts
 * as a past employer, because the text does not say which one is current.
 */
export function employerMatch(
  wanted: string[],
  candidate: HasCareer,
  scope: "current" | "any" = "any",
): EmployerHit | null {
  const asked = wanted.map(clean).filter((w) => w.length > 1);
  if (!asked.length) return null;
  const career = candidate.jobHistory ?? [];
  const currentJob = career.find((j) => j.company && isOngoing(j.endDate) && year(j.startDate));
  const current = clean(candidate.currentEmployer) || clean(currentJob?.company);

  let best: EmployerHit | null = null;
  const consider = (hit: EmployerHit) => {
    if (!best || hit.score > best.score) best = hit;
  };

  for (const w of asked) {
    if (current) {
      const how = companyMatch(w, current);
      if (how) {
        const job = career.find((j) => companyMatch(j.company, current) !== null);
        consider({ when: "current", how, company: current, years: job ? yearsOf(job) : null, score: SCORE.current[how] });
      }
    }
    if (scope === "current") continue;
    for (const job of career) {
      const how = companyMatch(w, job.company);
      if (!how) continue;
      const isCurrent = !!current && companyMatch(job.company, current) !== null;
      const when = isCurrent ? "current" : "past";
      consider({ when, how, company: clean(job.company), years: yearsOf(job), score: SCORE[when][how] });
    }
    if (!career.length && candidate.employersText) {
      for (const name of candidate.employersText.split("|")) {
        const how = companyMatch(w, name);
        if (how && !(current && companyMatch(name, current))) {
          consider({ when: "past", how, company: clean(name), years: null, score: SCORE.past[how] });
        }
      }
    }
  }
  return best;
}

/** One line for a reason or a result row: "Works at Dialog Axiata (2021–now)". */
export function describeEmployerHit(hit: EmployerHit): string {
  const verb = hit.when === "current" ? "Works at" : "Worked at";
  return `${verb} ${hit.company}${hit.years ? ` (${hit.years})` : ""}`;
}

/** Excluded when the person works at one of these now. "Not from Dialog" is about where they are today. */
export function excludedByEmployer(excluded: string[], candidate: HasCareer): boolean {
  if (!excluded.length) return false;
  return employerMatch(excluded, candidate, "current") !== null;
}

// ─── Reading companies out of a sentence without a model ─────────────────────
//
// Only used when every model is down. It reads capitalised names after
// "at", "in", "from" and the like. A name the gazetteer knows as a place
// ("in Dhaka", "in Sri Lanka") is a location, not an employer.

const NOT_COMPANY = new Set([
  "the", "a", "an", "least", "most", "colombo", "remote", "home", "office", "hr", "it", "sales", "marketing",
  "finance", "accounts", "banking", "management", "years", "year", "english", "sinhala", "tamil",
]);

const COMPANY_AFTER =
  /\b(currently\s+(?:working\s+)?at|now\s+at|working\s+(?:at|in|for)|works\s+(?:at|in|for)|worked\s+(?:at|in|for)|employed\s+(?:at|by)|ex[-\s]|from|at|in)\s+([A-Z][\w&.'-]*(?:\s+(?:[A-Z][\w&.'-]*|&|of))*)/g;

export type EmployersInText = { employers: string[]; excludeEmployers: string[]; scope: "current" | "any" };

export function employersInText(text: string): EmployersInText {
  const employers: string[] = [];
  const excludeEmployers: string[] = [];
  let scope: "current" | "any" = "any";
  for (const m of text.matchAll(COMPANY_AFTER)) {
    const lead = m[1].toLowerCase();
    // "working at ABC. in Colombo": the full stop ends the message, not the name.
    const name = m[2].replace(/[.'-]+$/, "").replace(/\s+(?:of|&)$/i, "").trim();
    if (!name || NOT_COMPANY.has(name.toLowerCase())) continue;
    if (resolveLocationViaGazetteer(name)) continue;
    const before = text.slice(Math.max(0, m.index! - 12), m.index!).toLowerCase();
    if (/\b(not|no|without|except)\s*$/.test(before)) {
      excludeEmployers.push(name);
      continue;
    }
    if (lead.startsWith("currently") || lead.startsWith("now")) scope = "current";
    employers.push(name);
  }
  return { employers: [...new Set(employers)], excludeEmployers: [...new Set(excludeEmployers)], scope };
}
