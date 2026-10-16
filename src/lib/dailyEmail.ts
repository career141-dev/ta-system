import type { EffortRow, ShortlistRow } from "./eod-format";

export type SubmissionType = "midday" | "eod";
export type DailyEmailStatus = "draft" | "sending" | "accepted" | "failed" | "uncertain";
export interface DailyEmailSnapshot {
  subject: string;
  html: string;
  from: string;
  to: string[];
  cc: string[];
  attachmentNames: string[];
  rows: ShortlistRow[];
  effort: EffortRow;
  introText: string;
  outroText: string;
  researchLink: string;
  extraTo: string[];
  extraCc: string[];
  removed: string[];
}
export interface DailyEmail {
  _id: string;
  jobId: string;
  userId: string;
  date: string;
  submissionType: SubmissionType;
  number: number;
  revision: number;
  status: DailyEmailStatus;
  fields: Record<string, string>;
  applicationIds: string[];
  parentId?: string;
  roundId?: string;
  snapshot?: DailyEmailSnapshot;
  acceptedAt?: number;
  finalizedAt?: number;
  expiresAt?: number;
}

export const DAILY_EMAIL_LABEL: Record<DailyEmailStatus, string> = {
  draft: "Draft", sending: "Sending", accepted: "Sent", failed: "Failed", uncertain: "Needs review",
};

/** Check accepted submissions, not candidate timestamps or browser state. */
export function dailySendProblem(
  emails: Pick<DailyEmail, "status" | "submissionType" | "parentId">[],
  type: SubmissionType,
  requireMidday: boolean,
  revised = false,
): string | null {
  if (emails.some(e => e.status === "sending" || e.status === "uncertain"))
    return "An email is still sending or needs reconciliation. Ask the TA Lead to check it before retrying.";
  if (revised) return null;
  if (emails.some(e => e.status === "accepted" && e.submissionType === "eod" && !e.parentId))
    return "The end-of-day email has already been sent. You can correct that email; new submissions resume tomorrow.";
  if (type === "eod" && requireMidday && !emails.some(e => e.status === "accepted" && e.submissionType === "midday"))
    return "Send at least one midday email for this opening today before sending end of day.";
  return null;
}

export function sameCandidateList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
}
