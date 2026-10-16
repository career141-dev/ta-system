import { checksForWorkType, type WorkdayCheck, type WorkdayJobView } from "./workday";

const CANDIDATE_TASKS = new Set(["candidate_progress", "review", "candidate", "details", "handoff", "followup", "email", "profile", "upload", "director_wait"]);

/** Candidate actions stay on job pages; attendance ends with the EOD submission. */
export function sidebarChecks(job: WorkdayJobView): WorkdayCheck[] {
  return checksForWorkType(job.workType, job.checks).filter(c => !CANDIDATE_TASKS.has(c.key.split(":")[0]));
}
