/**
 * What a candidate is allowed to do next, and what has to be true first.
 *
 * Ported from the live system's `pipelineStateMachine`, which is stricter than
 * what this platform had: every stage could jump to every other, so a CV could
 * land on a client's desk without a director ever seeing it, and nothing
 * recorded that it had happened.
 *
 * Two things live here and nowhere else:
 *
 *   **Legal moves.** A directed graph. Rejection is not terminal — a candidate
 *   passed over in March is a candidate in June — and neither is a placement,
 *   because one that falls through inside the guarantee period has to go
 *   somewhere other than a spreadsheet.
 *
 *   **Preconditions.** Some stages cannot be entered on a promise. Interview is
 *   the one that matters: without a date and a time there is nothing to confirm,
 *   nothing to remind anyone about, and no way to chase a no-show.
 */

import type { Stage } from "@/data/types";
import { STAGE_LABEL } from "@/data/types";

export const ALLOWED_TRANSITIONS: Record<Stage, Stage[]> = {
  new_cv: ["follow_up", "rejected", "dropped_out"],
  matched: ["follow_up", "rejected", "dropped_out"],
  follow_up: ["director_review", "rejected", "dropped_out"],
  // The director sending it back for more detail is a real outcome, not a rejection.
  director_review: ["director_shortlist", "follow_up", "rejected", "dropped_out"],
  director_shortlist: ["client_shortlist", "rejected", "dropped_out"],
  client_shortlist: ["interview", "offer", "rejected", "dropped_out"],
  interview: ["offer", "placed", "rejected", "dropped_out"],
  offer: ["placed", "rejected", "dropped_out"],
  // A placement inside its guarantee period can still fall through.
  placed: ["dropped_out", "rejected"],
  // Re-evaluation, which is how a desk works a database it already owns.
  rejected: ["new_cv", "follow_up"],
  dropped_out: ["new_cv", "follow_up"],
};

export type Requirement = "interview_scheduled" | "placement_recorded" | "offer_made";

/** What must already be true to enter a stage. */
export const STAGE_REQUIRES: Partial<Record<Stage, Requirement>> = {
  interview: "interview_scheduled",
  // Placed means somebody accepted and has a joining date. Moving a row there
  // from a menu, with neither, is how 32 applications came to read Placed with
  // no placement behind them (audit finding 13).
  placed: "placement_recorded",
  offer: "offer_made",
};

export const REQUIREMENT_LABEL: Record<Requirement, string> = {
  interview_scheduled: "an interview date and time",
  placement_recorded: "a placement with a joining date — use Record placement on the candidate",
  offer_made: "an offer — use Make offer on the candidate",
};

export interface MoveContext {
  /** Whether this application already has an interview booked. */
  hasInterview?: boolean;
  hasPlacement?: boolean;
  hasOffer?: boolean;
}

export type MoveCheck =
  | { ok: true }
  | { ok: false; reason: "illegal" | "needs"; message: string; requirement?: Requirement };

export function canMove(from: Stage, to: Stage, ctx: MoveContext = {}): MoveCheck {
  if (from === to) return { ok: true };

  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    return {
      ok: false,
      reason: "illegal",
      message: `${STAGE_LABEL[from]} does not lead to ${STAGE_LABEL[to]}.`,
    };
  }

  const needs = STAGE_REQUIRES[to];
  const unmet =
    (needs === "interview_scheduled" && !ctx.hasInterview) ||
    (needs === "placement_recorded" && !ctx.hasPlacement) ||
    (needs === "offer_made" && !ctx.hasOffer);
  if (needs && unmet) {
    return {
      ok: false,
      reason: "needs",
      requirement: needs,
      message: `${STAGE_LABEL[to]} needs ${REQUIREMENT_LABEL[needs]}.`,
    };
  }

  return { ok: true };
}

/** Where this application can actually go, for building a menu that only
 *  offers moves that will work. */
export function nextStages(from: Stage): Stage[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

/**
 * What happened, in the desk's words. Written onto every event so the history
 * reads as a story rather than a list of stage names.
 */
export type EventType =
  | "moved"
  | "shortlisted"
  | "director_shortlisted"
  | "director_returned"
  | "client_shortlisted"
  | "client_passed"
  | "interview_scheduled"
  | "interview_rescheduled"
  | "rejected"
  | "dropped_out"
  | "sent_for_review"
  | "review_returned";

export function eventTypeFor(from: Stage, to: Stage): EventType {
  if (to === "rejected") return "rejected";
  if (to === "dropped_out") return "dropped_out";
  if (to === "interview") return "interview_scheduled";
  if (to === "director_shortlist") return "director_shortlisted";
  if (to === "client_shortlist") return "client_shortlisted";
  if (from === "director_review" && to === "follow_up") return "director_returned";
  if (to === "follow_up") return "shortlisted";
  return "moved";
}
