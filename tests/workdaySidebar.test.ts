import assert from "node:assert/strict";
import { sidebarChecks } from "@/lib/workdaySidebar";
import { completionBlockers, type WorkdayCheck, type WorkdayJobView } from "@/lib/workday";

const check = (key: string, patch: Partial<WorkdayCheck> = {}): WorkdayCheck => ({ key, jobId: "job", label: "Candidate Name: action required", href: "/openings/job", kind: "details", canCarry: false, evidenceAt: 0, status: "incomplete", ...patch });
const job = (checks: WorkdayCheck[]): WorkdayJobView => ({ jobId: "job", checks, shortlist: [
  { id: "one", name: "Candidate One", source: "L", stage: "ta_follow_up", sent: false, shortlistedAt: 1 },
  { id: "two", name: "Candidate Two", source: "SCOOP", stage: "director_review", sent: false, shortlistedAt: 1 },
] } as WorkdayJobView);
const original = job([check("review:one"), check("review:two"), check("details:one"), check("profile:three"),
  check("director_candidate:job", { status: "complete" }), check("jd_review:job", { status: "complete" }), check("daily_email:job")]);
const before = structuredClone(original);
const displayed = sidebarChecks(original);
assert.equal(displayed.length, 3, "All candidate tasks collapse into one check; setup/email checks remain separate");
assert.equal(displayed[0].key, "candidate_progress:job");
assert.equal(displayed[0].status, "incomplete", "One ready candidate cannot hide other candidate work");
assert.match(displayed[0].progress!, /Sources: L, SCOOP/);
assert.match(displayed[0].progress!, /1 in TA Shortlist.*1 in Director Review/);
assert.ok(!JSON.stringify(displayed).includes("Candidate One"));
assert.ok(!displayed[0].label.includes("Candidate Name"));
assert.equal(completionBlockers([{ ...original, checks: displayed }]).length, 2);
assert.equal(completionBlockers([original]).length, 5, "The original Finish gates remain unchanged");
assert.deepEqual(original, before, "Formatting never mutates backend evidence");

const complete = sidebarChecks(job([check("review:one", { status: "complete", completedAt: 10, completedBy: "ta" }), check("handoff:two", { status: "complete", completedAt: 20, completedBy: "ta" })]))[0];
assert.equal(complete.status, "complete");
assert.equal(complete.completedAt, 20);
assert.equal(complete.completedBy, "ta");
assert.equal(sidebarChecks(job([check("profile:old", { status: "complete" })]))[0].completedAt, undefined, "Historical times must not be fabricated");
const waiting = check("followup:one", { waiting: { reason: "CV requested", nextAction: "Call", dueAt: 100 } });
assert.equal(sidebarChecks(job([waiting]))[0].status, "waiting");
assert.equal(completionBlockers([{ ...job([waiting]), checks: sidebarChecks(job([waiting])) }]).length, 0);
assert.equal(sidebarChecks(job([waiting, check("details:two")]))[0].status, "incomplete", "Waiting for one candidate does not hide another blocker");
assert.equal(sidebarChecks(job([check("upload:one"), check("mail:one", { kind: "system" })])).length, 2, "Email reconciliation remains a separate system task");
const empty = { ...job([]), shortlist: [] };
assert.deepEqual(sidebarChecks(empty), []);
console.log("Workday sidebar candidate grouping, stage totals, waiting states and preserved Finish gates passed.");
