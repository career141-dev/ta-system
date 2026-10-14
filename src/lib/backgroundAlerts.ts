import { hasWorkingHours } from "./calendar";

export const BACKGROUND_ALERT_ROLLOUT = "background_ta_alerts_started_at";
export type BackgroundAlertKind = "job_no_new_candidates" | "director_no_shortlist";
export interface BackgroundAlertView {
  id: string;
  kind: BackgroundAlertKind;
  openingId: string;
  detail: string;
  href: string;
  dueAt: number;
}

export function inactivityStart(rollout: number, assignedAt: number, arrivedAt: number) {
  return Math.max(rollout, assignedAt, arrivedAt);
}

/** The first instant the shared calendar considers the window complete. */
export function backgroundDeadline(since: number) {
  const day = 86_400_000;
  let high = since + day;
  while (!hasWorkingHours(since, high, 24)) high += day;
  let low = since;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (hasWorkingHours(since, mid, 24)) high = mid;
    else low = mid;
  }
  return high;
}

export function directorNeedsShortlist(round: {
  kind: string; dispatch: string; sentAt: number; applicationIds: readonly string[];
  decisions: readonly { applicationId: string; outcome: string }[];
}, rollout: number, now: number) {
  return round.kind === "director" && round.dispatch === "sent" && round.sentAt >= rollout &&
    round.applicationIds.length > 0 && hasWorkingHours(round.sentAt, now, 24) &&
    !round.decisions.some(d => d.outcome === "shortlisted" && round.applicationIds.includes(d.applicationId));
}

export function backgroundAlertHref(kind: string, openingId: string) {
  return kind === "director_no_shortlist" ? `/openings/${openingId}/eod?kind=director` : `/openings/${openingId}/database`;
}
