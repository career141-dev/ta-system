/**
 * Utilities for parsing candidate answers for follow-ups and review details.
 */

const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * Days, where the candidate's words or recruiter input carry a number or duration.
 *
 * e.g. "30 days" -> 30, "2 months" -> 60, "immediate" -> 0, "45" -> 45.
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
