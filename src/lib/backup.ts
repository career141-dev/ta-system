import type { Application, Candidate, Opening } from "@/data/types";

/**
 * Backup candidates — notebook page 3:
 *
 *   "the offer goes and [the candidate does] not accept
 *    → [Backup: set is recommended] → similar candidate"
 *
 * Pure scoring, so it can be tested on its own. The point is speed: when an
 * offer falls through the desk has days, not weeks, and the people who almost
 * made it are already in the pool.
 */

export interface BackupMatch {
  application: Application;
  candidate: Candidate;
  score: number;
  /** Why it was suggested, in plain words the TA can act on. */
  reasons: string[];
}

/**
 * Rough salary comparison — the desk writes "895K gross", "LKR 1.2m", "USD 7,500".
 *
 * The currency comes back with the number, because comparing a candidate's
 * "524K" against an opening banded in USD says everyone is over budget. Where
 * the two currencies differ the signal is dropped rather than asserted — a
 * confident wrong reason is worse than one fewer reason.
 */
export function parseSalary(s: string | null): { amount: number; currency: string } | null {
  if (!s) return null;
  const m = s.match(/([\d][\d,.]*)\s*(k|m|million)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k") n *= 1_000;
  if (unit === "m" || unit === "million") n *= 1_000_000;
  const currency = /\busd\b|\$/i.test(s) ? "USD" : "LKR";
  return { amount: n, currency };
}

function titleOverlap(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const stop = new Set(["of", "and", "the", "a", "an", "-", "&"]);
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2 && !stop.has(w)),
    );
  const x = tok(a);
  const y = tok(b);
  if (x.size === 0 || y.size === 0) return 0;
  let hits = 0;
  for (const w of x) if (y.has(w)) hits++;
  return hits / Math.max(x.size, y.size);
}
