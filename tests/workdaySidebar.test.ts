import assert from "node:assert/strict";
import { sidebarChecks } from "@/lib/workdaySidebar";
import type { WorkdayCheck, WorkdayJobView } from "@/lib/workday";

const check = (key: string): WorkdayCheck => ({ key, jobId: "job", label: key, href: "/", kind: "details", canCarry: false, evidenceAt: 0, status: "incomplete" });
const job = { jobId: "job", workType: "100%", shortlist: [], checks: [
  ...["candidate_progress", "review", "candidate", "details", "handoff", "followup", "email", "profile", "upload", "director_wait"].map(k => check(`${k}:candidate`)),
  ...["jd_review", "director_cv", "chatgpt", "daily_email", "mail"].map(k => check(`${k}:job`)),
] } as unknown as WorkdayJobView;
const original = structuredClone(job);
assert.deepEqual(sidebarChecks(job).map(c => c.key), ["jd_review:job", "director_cv:job", "chatgpt:job", "daily_email:job", "mail:job"]);
for (const workType of ["Follow-up", "Add-on"] as const) {
  assert.deepEqual(sidebarChecks({ ...job, workType }).map(c => c.key), ["director_cv:job", "chatgpt:job", "daily_email:job", "mail:job"]);
}
assert.deepEqual(job, original, "Sidebar filtering preserves evidence and job-page actions");
console.log("Sidebar hides candidate-progress tasks and preserves setup, EOD and mail safety checks.");
