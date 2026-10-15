import type { WorkdayCheck, WorkdayJobView } from "./workday";

const CANDIDATE_TASKS = new Set(["review", "candidate", "details", "handoff", "followup", "email", "profile", "upload", "director_wait", "director_candidate"]);

/** One sidebar check per job; the backend and job pages retain the individual actions. */
export function sidebarChecks(job: WorkdayJobView): WorkdayCheck[] {
  if (job.workType === "Follow-up" || job.workType === "Add-on") return [];
  const candidateChecks = job.checks.filter(c => CANDIDATE_TASKS.has(c.key.split(":")[0]));
  if (!candidateChecks.length && !job.shortlist.length) return job.checks;
  const pending = candidateChecks.filter(c => c.status !== "complete" && !c.waiting);
  const waiting = candidateChecks.filter(c => c.waiting);
  const sources = [...new Set(job.shortlist.map(c => c.source).filter(Boolean))];
  const taShortlist = job.shortlist.filter(c => ["ta_follow_up", "ai_follow_up", "ta_shortlist"].includes(c.stage) && !c.sent).length;
  const directorReview = job.shortlist.filter(c => c.stage === "director_review" && !c.sent).length;
  const submitted = job.shortlist.filter(c => c.sent).length;
  const complete = !pending.length && !waiting.length;
  const times = candidateChecks.map(c => c.completedAt);
  const actors = new Set(candidateChecks.map(c => c.completedBy));
  const nextDue = waiting.map(c => c.waiting!).sort((a, b) => a.dueAt - b.dueAt)[0];
  const summary: WorkdayCheck = {
    key: `candidate_progress:${job.jobId}`, jobId: job.jobId,
    label: "Candidates sourced and progressed",
    href: pending[0]?.href ?? `/openings/${job.jobId}/pipeline/ta_follow_up`,
    kind: "details", canCarry: false, evidenceAt: 0,
    status: pending.length ? "incomplete" : waiting.length ? "waiting" : "complete",
    progress: [sources.length ? `Sources: ${sources.join(", ")}` : "Candidates from all sources",
      `${taShortlist} in TA Shortlist`, `${directorReview} in Director Review`, `${submitted} submitted`,
      pending.length ? "Review outstanding candidate actions on the job pages." : waiting.length ? "Follow-ups are scheduled." : "Candidate checks complete."].join(" · "),
    // Do not invent a timestamp when historical candidate evidence has none.
    completedAt: complete && times.length && times.every(t => t !== undefined) ? Math.max(...times as number[]) : undefined,
    completedBy: complete && actors.size === 1 ? candidateChecks[0]?.completedBy : undefined,
    blocksEmail: pending.some(c => c.blocksEmail),
    ...(nextDue && !pending.length ? { waiting: {
      reason: "Candidate follow-ups are scheduled",
      nextAction: "Review the next candidate follow-up on the job pages", dueAt: nextDue.dueAt,
    } } : {}),
  };
  const result: WorkdayCheck[] = [];
  let placed = false;
  for (const check of job.checks) {
    if (CANDIDATE_TASKS.has(check.key.split(":")[0])) {
      if (!placed) result.push(summary);
      placed = true;
    } else result.push(check);
  }
  if (!placed) result.unshift(summary);
  return result;
}
