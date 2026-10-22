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
