import { workdayDate, type WorkType } from "./workday";

/** The fields needed to decide whether a candidate belongs in today's EOD. */
export interface EodCandidateFacts {
  stage: string;
  ownerTaId?: string | null;
  isAddOn?: boolean;
  lastStageChangedAt: number;
}

export interface EodEligibility {
  taId: string | null;
  workType: WorkType;
  /** Start of the current work session; Add-on candidates must have reached
   * Director Review on or after this instant. */
  sessionStart?: number | null;
  /** Colombo day (YYYY-MM-DD) the candidate reached Director Review. Each day's
   * email carries that day's candidates only; earlier unsent days are sent as
   * a missed end of day (30 Oct). */
  day?: string | null;
}

/**
 * One policy for the composer and both durable mail reservations.
 * Convex stores Director Review as `second_shortlist`; the app model exposes
 * it as `director_review`, so both spellings are accepted at this boundary.
 */
export function isEodCandidateEligible(
  candidate: EodCandidateFacts,
  context: EodEligibility,
): boolean {
  if (!["director_review", "second_shortlist"].includes(candidate.stage)) return false;
  if (context.taId && candidate.ownerTaId !== context.taId) return false;
  if (context.day && workdayDate(candidate.lastStageChangedAt) !== context.day) return false;
  if (context.workType !== "Add-on") return true;
  return !!candidate.isAddOn && candidate.lastStageChangedAt >= (context.sessionStart ?? Number.POSITIVE_INFINITY);
}
