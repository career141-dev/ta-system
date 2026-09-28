/**
 * Several interviews per candidate (28 Sep): each booked on its own, moved
 * with its history kept, a status that says where it stands, and one feedback
 * entry per person that only its author or a lead may change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-interviews-"));
process.chdir(tmp);

const { repo } = await import("@/data/store");
const { interviewStatus, mayChangeFeedback, OUTCOME_FOR } = await import("@/lib/interviews");
const { can } = await import("@/lib/auth");
import type { User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const ta = repo.users().find((u) => u.role === "ta")!;
const app = repo.applications().find((a) => a.stage === "client_shortlist")!;
const base = { timezone: "Asia/Colombo", location: "Office", mode: "in_person" as const, interviewers: ["Panel"], durationMins: 45, notes: null, byUserId: ta.id };
const when = Date.now() + 2 * 86_400_000;

console.log("\nbooking two interviews keeps both");
const tech = repo.scheduleInterview({ ...base, applicationId: app.id, title: "Technical interview", scheduledAt: when });
const hr = repo.scheduleInterview({ ...base, applicationId: app.id, title: "HR interview", scheduledAt: when + 3_600_000 });
const ivs = repo.interviews(app.id);
eq("both pending", ivs.filter((i) => i.outcome === "pending").map((i) => i.title).sort(), ["HR interview", "Technical interview"]);
eq("stage is interview", repo.application(app.id)?.stage, "interview");
eq("second one is round 2", ivs.find((i) => i.title === "HR interview")?.round, 2);

console.log("\nrescheduling keeps the old time");
const hrId = (hr as { id: string }).id;
eq("booked ok", tech.ok && hr.ok, true);
repo.confirmInterview(hrId);
const r = repo.rescheduleInterview(hrId, { scheduledAt: when + 86_400_000, location: "Office", mode: "in_person", reason: "Interviewer unavailable", byUserId: ta.id });
let moved = repo.interviews(app.id).find((i) => i.id === hrId)!;
eq("ok", r.ok, true);
eq("new time", moved.scheduledAt, when + 86_400_000);
eq("confirmation cleared", moved.confirmedAt, null);
eq("status reads Rescheduled", interviewStatus(moved), "rescheduled");
eq("history kept with reason", [moved.history.length, moved.history[0].kind, moved.history[0].reason], [1, "rescheduled", "Interviewer unavailable"]);
eq("same time twice is refused", repo.rescheduleInterview(hrId, { scheduledAt: when + 86_400_000, location: "Office", mode: "in_person", reason: null, byUserId: ta.id }).ok, false);

console.log("\nstatus changes are logged");
repo.setInterviewOutcome(hrId, "no_show", ta.id, "Did not answer");
moved = repo.interviews(app.id).find((i) => i.id === hrId)!;
eq("no show", interviewStatus(moved), "no_show");
eq("logged", moved.history.at(-1)?.detail, "Rescheduled → No show");
repo.rescheduleInterview(hrId, { scheduledAt: when + 2 * 86_400_000, location: "Office", mode: "video", reason: null, byUserId: ta.id });
moved = repo.interviews(app.id).find((i) => i.id === hrId)!;
eq("a no-show can be put back on", moved.outcome, "pending");
repo.setInterviewOutcome(hrId, "attended", ta.id);
eq("completed cannot be rescheduled", repo.rescheduleInterview(hrId, { scheduledAt: when, location: "", mode: "phone", reason: null, byUserId: ta.id }).ok, false);

// The status form sends "completed"; the action once only took "attended" (28 Sep).
eq("every status the form offers maps to a stored outcome", OUTCOME_FOR, { scheduled: "pending", completed: "attended", cancelled: "cancelled", no_show: "no_show" });

console.log("\nfeedback: one entry per person, updated in place");
const fb = { interviewer: "Head of HR", ratings: { technical: 3, communication: 4, behaviour: 5, performance: null, overall: 4 }, recommendation: "hire" as const, comments: "Good" };
repo.saveInterviewFeedback(hrId, { ...fb, byUserId: ta.id });
repo.saveInterviewFeedback(hrId, { ...fb, byUserId: ta.id, comments: "Very good" });
repo.saveInterviewFeedback(hrId, { ...fb, byUserId: "someone_else" });
moved = repo.interviews(app.id).find((i) => i.id === hrId)!;
eq("two people, two entries", moved.feedback.length, 2);
eq("own entry updated", moved.feedback.find((f) => f.byUserId === ta.id)?.comments, "Very good");

console.log("\nwho may change feedback");
const u = (role: User["role"], id = "u1") => ({ id, role, isActive: true }) as User;
eq("own", mayChangeFeedback(u("ta"), { byUserId: "u1" }), true);
eq("someone else's, as a TA", mayChangeFeedback(u("ta"), { byUserId: "u2" }), false);
eq("someone else's, as a lead", mayChangeFeedback(u("ta_lead"), { byUserId: "u2" }), true);
eq("client contact on the opening may give feedback", can(u("client"), "interview.feedback", { assignment: { role: "client_contact" } as never }).ok, true);
eq("…but not reschedule", can(u("client"), "opening.act", { assignment: { role: "client_contact" } as never }).ok, false);
eq("viewer may not", can(u("viewer"), "interview.feedback", {}).ok, false);
eq("a stranger to the opening may not", can(u("ta"), "interview.feedback", {}).ok, false);

console.log("\nthe live mapping keeps title, history and feedback, with no nulls nested");
{
  const { TABLES, sameValue } = await import("../convex/ta/model/tables");
  const m = TABLES.interviews;
  const cx = { get: async () => ({ _id: "a", jobId: "j", candidateId: "c" }), now: 1 };
  const doc = await m.toDoc(moved as never, cx as never, true);
  eq("no null inside the stored arrays", JSON.stringify([doc.taHistory, doc.taFeedback]).includes("null"), false);
  const back = m.fromDoc({ ...doc, _id: moved.id } as never) as Record<string, unknown>;
  for (const k of ["title", "history", "feedback"] as const) eq(`${k} round-trips`, sameValue(back[k], moved[k]), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
