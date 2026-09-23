// convex/lib/answered.ts
//
// When a follow-up question counts as answered.
//
// The chase used to close a question only on a NUMBER: `expectedSalary`,
// `currentSalary`, `noticePeriodDays`. Candidates do not answer that way.
// "Negotiable", "open to discuss", "I'd rather not say", "around two months",
// "can't say yet" are all answers — and every one of them left the checklist
// open, so the next message asked again. A real candidate was asked for a
// salary figure four times in eleven minutes before anyone noticed
// (23 September).
//
// A person is allowed to decline. These say so in one place, so the prompt,
// the flags and the missing-field list cannot drift apart.
//
// Pure: no Convex imports, so it is tested on its own (tests/answered.test.ts).

const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

type CandidateLike = {
  currentSalary?: number | null;
  expectedSalary?: number | null;
  currentSalaryNote?: string | null;
  expectedSalaryNote?: string | null;
  noticePeriodDays?: number | null;
  noticePeriod?: string | null;
};

/** A figure, or what they said instead. */
export function hasCurrentSalary(c: CandidateLike | null | undefined): boolean {
  return !!c && (isNumber(c.currentSalary) || filled(c.currentSalaryNote));
}

export function hasExpectedSalary(c: CandidateLike | null | undefined): boolean {
  return !!c && (isNumber(c.expectedSalary) || filled(c.expectedSalaryNote));
}

/**
 * A number of days, or the words.
 *
 * `noticePeriod` has always existed as a string but nothing ever read it, so
 * "two months" was stored and then asked for again.
 */
export function hasNoticePeriod(c: CandidateLike | null | undefined): boolean {
  return !!c && (isNumber(c.noticePeriodDays) || filled(c.noticePeriod));
}

/**
 * Days, where the candidate's words carry a number we can trust.
 *
 * Deliberately narrow: "2 months" and "6 weeks" convert, "end of the quarter"
 * and "not sure yet" do not — those stay as text for a person to read. A wrong
 * date here schedules a real candidate's chase at the wrong time.
 */
export function noticePeriodToDays(text: string | null | undefined): number | null {
  if (!filled(text)) return null;
  const t = text!.trim().toLowerCase();

  if (/\b(immediate|immediately|right away|asap|available now|free now|no notice)\b/.test(t)) return 0;

  const m = t.match(/(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years)\b/);
  if (!m) {
    const bare = t.match(/^\s*(\d+)\s*$/);
    return bare ? Number(bare[1]) : null;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  switch (m[2]) {
    case "day":
    case "days":
      return Math.round(n);
    case "week":
    case "weeks":
      return Math.round(n * 7);
    case "month":
    case "months":
      return Math.round(n * 30);
    default:
      return Math.round(n * 365);
  }
}
