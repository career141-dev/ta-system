/** Workday rules shared by the transactional backend and the daily review. */
export type WorkType = "100%" | "Add-on" | "Follow-up";
export type CheckKind =
  | "cv_review"
  | "details"
  | "handoff"
  | "follow_up"
  | "profile"
  | "email"
  | "system";
export interface WorkdayCheck {
  key: string;
  jobId: string;
  label: string;
  href: string;
  kind: CheckKind;
  canCarry: boolean;
  evidenceAt: number;
  status?: "incomplete" | "complete" | "waiting";
  completedAt?: number;
  completedBy?: string;
  evidence?: string;
  progress?: string;
  needsEmptySuggestionsReason?: boolean;
  blocksEmail?: boolean;
  events?: { status: string; at: number; by?: string; evidence?: string; observed?: boolean }[];
  waiting?: { reason: string; nextAction: string; dueAt: number };
}
export interface CarryForward {
  key: string;
  reason: string;
  nextAction: string;
  dueAt: number;
  recordedAt: number;
  evidenceAt: number;
}
export interface WorkdayCandidate {
  id: string;
  name: string;
  stage: string;
  source: string;
  shortlistedAt: number;
  sent: boolean;
}
export interface WorkdayJobView {
  jobId: string;
  title: string;
  workType: WorkType;
  checks: WorkdayCheck[];
  shortlist: WorkdayCandidate[];
  activity: {
    cvReviews: number;
    profilesAdded: number;
    profilesWorked: number;
    researchAt: number | null;
    researchActions: number;
    benchmarkActions: number;
    benchmarks: number;
    benchmarksAdded: number;
    sent: number;
    emailAt: number | null;
    jdApproved: boolean;
    postConnected: boolean;
  };
}
export interface WorkdayView {
  id: string;
  userId: string;
  name: string;
  date: string;
  startedAt: number;
  finishedAt: number | null;
  jobs: WorkdayJobView[];
  requests: {
    id: string;
    jobId: string;
    title: string;
    status: string;
    reason?: string;
  }[];
}
export interface WorkdayPayload {
  canWork: boolean;
  canLead: boolean;
  role: string;
  lastFinishedAt: number | null;
  lastFinishedDate: string | null;
  active: WorkdayView | null;
  history: WorkdayView[];
  team: WorkdayView[];
  options: { id: string; title: string; workType?: WorkType; carry?: boolean; preview?: WorkdayJobView }[];
  nextCursor?: string | null;
}

export function workdayDate(now: number): string {
  return new Date(now).toLocaleDateString("en-CA", {
    timeZone: "Asia/Colombo",
  });
}

/** A reply or new action invalidates a previously recorded waiting reason. */
export function applyCarryForwards(
  checks: WorkdayCheck[],
  carries: CarryForward[],
  now: number,
): WorkdayCheck[] {
  return checks.map((check) => {
    const carry = carries.find((c) => c.key === check.key);
    const valid =
      check.canCarry &&
      carry &&
      carry.dueAt > now &&
      carry.evidenceAt === check.evidenceAt;
    return valid
      ? {
          ...check,
          waiting: {
            reason: carry.reason,
            nextAction: carry.nextAction,
            dueAt: carry.dueAt,
          },
        }
      : check;
  });
}

export function validateCarry(
  check: WorkdayCheck,
  reason: string,
  nextAction: string,
  dueAt: number,
  now: number,
): void {
  if (!check.canCarry)
    throw new Error("This step must be completed before finishing work.");
  if (!reason.trim() || !nextAction.trim())
    throw new Error("Give a reason and the next action.");
  if (reason.length > 1000 || nextAction.length > 1000)
    throw new Error("Keep the reason and next action under 1,000 characters.");
  if (!Number.isFinite(dueAt) || dueAt <= now)
    throw new Error("Choose a future follow-up time.");
}

export function completionBlockers(jobs: WorkdayJobView[]): WorkdayCheck[] {
  return jobs.flatMap((j) => j.checks).filter((c) => c.status !== "complete" && !c.waiting);
}

export function emailBlockers(jobs: WorkdayJobView[]): WorkdayCheck[] {
  return completionBlockers(jobs).filter((c) => c.blocksEmail);
}

export function workdayTime(at: number | null): string {
  return at === null
    ? "—"
    : new Date(at).toLocaleString("en-GB", {
        timeZone: "Asia/Colombo",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
