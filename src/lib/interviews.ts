/**
 * What the desk calls an interview's state, and who may change its feedback.
 *
 * The status is derived, not stored (28 Sep). `outcome` already holds whether
 * it happened, and every SLA rule reads it; a second stored status would drift
 * from it. "Rescheduled" is simply a pending interview that has been moved.
 */

import type { Interview, InterviewFeedback, InterviewRatingKey, User } from "@/data/types";

export type InterviewStatus = "scheduled" | "rescheduled" | "completed" | "cancelled" | "no_show";

export const INTERVIEW_STATUS_LABEL: Record<InterviewStatus, string> = {
  scheduled: "Scheduled",
  rescheduled: "Rescheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

export function interviewStatus(iv: Pick<Interview, "outcome" | "history">): InterviewStatus {
  if (iv.outcome === "attended") return "completed";
  if (iv.outcome === "no_show") return "no_show";
  if (iv.outcome === "cancelled") return "cancelled";
  return iv.history.some((h) => h.kind === "rescheduled") ? "rescheduled" : "scheduled";
}

/** The status a person picks, as the stored outcome. "Scheduled" reopens a cancelled or no-show one. */
export const OUTCOME_FOR: Record<Exclude<InterviewStatus, "rescheduled">, Interview["outcome"]> = {
  scheduled: "pending",
  completed: "attended",
  cancelled: "cancelled",
  no_show: "no_show",
};

export const RATING_LABEL: Record<InterviewRatingKey, string> = {
  technical: "Technical skills",
  communication: "Communication",
  behaviour: "Behaviour",
  performance: "Performance",
  overall: "Overall interview",
};

export const RECOMMENDATION_LABEL: Record<NonNullable<InterviewFeedback["recommendation"]>, string> = {
  hire: "Hire",
  next_round: "Next round",
  hold: "Hold",
  reject: "Do not proceed",
};

/**
 * Your own feedback is yours to change. Somebody else's is only a lead's,
 * director's or admin's — a TA tidying a client interviewer's words would be
 * rewriting the evidence the decision is taken on.
 */
export function mayChangeFeedback(user: User, entry: Pick<InterviewFeedback, "byUserId"> | undefined): boolean {
  if (!entry || entry.byUserId === user.id) return true;
  return user.role === "admin" || user.role === "director" || user.role === "ta_lead";
}

/** "3 Oct, 10:00" in Colombo time — history lines are read long after, from any server. */
export function whenLabel(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo",
  });
}
