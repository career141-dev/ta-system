// convex/lib/jdGate.ts
//
// A CV is scored against a job's JD, so it waits while that JD is still a
// draft the TA is working out with the AI (25 September). Pure, so it can be
// tested alone.

/**
 * Whether scoring waits for the JD. Only a TA-platform opening whose JD is
 * waiting for approval: older pipeline jobs carry "draft" from the backfill
 * (ta/backfill.ts) and are scored as they always were.
 */
export function scoringWaitsForJd(job: { jdStatus?: string | null }): boolean {
  return job.jdStatus === "pending_ta_approval";
}

/** How long after approval the waiting CVs are scored — the requirements are
 *  read from the approved JD first, so the scores use them. */
export const SCORE_AFTER_APPROVAL_MS = 60_000;

/** Waiting CVs are scored this far apart, so the models are not flooded. */
export const SCORE_STAGGER_MS = 3_000;
