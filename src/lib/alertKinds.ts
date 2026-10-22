/**
 * What each alert kind is called on screen. Shared by the alerts page and the
 * mobile home payload (src/lib/mobile/home.ts) so a kind cannot read one way
 * on the web and another in the app. Unknown kinds fall back to the raw kind.
 */
export const KIND_LABEL: Record<string, string> = {
  low_volume: "Low volume",
  advert_quiet: "Advert quiet",
  cv_waiting: "CV waiting",
  followup_due: "Follow-up",
  stale_role: "Stale role",
  shortlist_sla: "Unscreened",
  client_review_chase: "Client chase",
  director_review_chase: "Director chase",
  review_reply_received: "Review reply",
  interview_confirmation: "Confirm attendance",
  interview_confirmation_escalation: "Escalation",
  interview_followup: "Interview follow-up",
  joining_date: "Joining date",
  opening_assigned: "Role assigned",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/**
 * Kinds that are worked at weekends and on holidays too: on a non-working day
 * the alerts page lists them under "Today" rather than holding them for the
 * next working day. Moved out of src/app/alerts/page.tsx so the mobile alerts
 * payload (src/lib/mobile/alerts.ts) sorts an alert under the same heading.
 */
const EVERY_DAY_KINDS = new Set(["followup_due", "opening_assigned", "review_reply_received"]);

export function runsEveryDay(kind: string): boolean {
  return EVERY_DAY_KINDS.has(kind);
}

/** The heading an alert sits under on /alerts: Urgent, Today, or Next working day. */
export function alertGroup(alert: { urgent: boolean; kind: string }, workingDay: boolean): "urgent" | "today" | "held" {
  if (alert.urgent) return "urgent";
  return workingDay || runsEveryDay(alert.kind) ? "today" : "held";
}
