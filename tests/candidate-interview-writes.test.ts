/** Web and phone interview actions share one permission and audit path. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-interviews-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { writeCandidateInterview } = await import("@/lib/candidates/interviewWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const deps = { convexQuery: async <T,>() => undefined as T, revalidatePath: () => undefined };
repo.reset();

test("another recruiter cannot book an interview by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id).filter((app) => visibleToSeat([app], seat).length === 0).map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const before = repo.interviews(found.app.id).length;
  const result = await writeCandidateInterview(ta, found.opening.id, found.app.id, {
    action: "schedule", title: "Client interview", date: "2030-03-04", time: "10:30", timezone: "Asia/Colombo",
    location: "Video", mode: "video", interviewers: ["Client"], durationMins: 45, notes: "",
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(repo.interviews(found.app.id).length, before);
});

test("booking, attendance, rescheduling, outcome, verdict and feedback keep the website rules", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const app = repo.openings().flatMap((opening) => repo.applications(opening.id)).find((row) => row.stage === "client_shortlist")!;
  assert(app, "the seed has a client-shortlisted candidate");
  const opening = repo.opening(app.openingId)!;

  const booked = await writeCandidateInterview(lead, opening.id, app.id, {
    action: "schedule", title: "Technical interview", date: "2030-03-04", time: "10:30", timezone: "Asia/Colombo",
    location: "Microsoft Teams", mode: "video", interviewers: ["Ayesha Fernando"], durationMins: 45, notes: "Bring one reporting example.",
  }, deps);
  assert.equal(booked.ok, true);
  assert.match(booked.message, /^Interview booked for /);
  assert.equal(repo.application(app.id)?.stage, "interview");
  const interview = repo.interviews(app.id).at(-1)!;

  assert.deepEqual(await writeCandidateInterview(lead, opening.id, app.id, { action: "confirm", interviewId: interview.id }, deps), { ok: true, message: "Attendance confirmed." });
  assert(repo.interviews(app.id).find((row) => row.id === interview.id)?.confirmedAt);

  const moved = await writeCandidateInterview(lead, opening.id, app.id, {
    action: "reschedule", interviewId: interview.id, date: "2030-03-05", time: "14:00", location: "Client office", mode: "in_person", reason: "Panel availability",
  }, deps);
  assert.equal(moved.ok, true);
  assert.equal(repo.interviews(app.id).find((row) => row.id === interview.id)?.confirmedAt, null);

  assert.deepEqual(await writeCandidateInterview(lead, opening.id, app.id, {
    action: "edit", interviewId: interview.id, title: "Finance panel", interviewers: ["Ayesha Fernando", "Ruwan Silva"], durationMins: 60, notes: "Discuss controls.",
  }, deps), { ok: true, message: "Interview details saved." });

  assert.deepEqual(await writeCandidateInterview(lead, opening.id, app.id, { action: "outcome", interviewId: interview.id, outcome: "completed", reason: "" }, deps), { ok: true, message: "Interview status saved." });
  assert.deepEqual(await writeCandidateInterview(lead, opening.id, app.id, { action: "result", interviewId: interview.id, result: "passed", clientRating: 4, clientFeedback: "Proceed to the final discussion." }, deps), { ok: true, message: "Client verdict saved." });
  assert.deepEqual(await writeCandidateInterview(lead, opening.id, app.id, {
    action: "feedback", interviewId: interview.id, forUserId: null, interviewer: "Ayesha Fernando",
    ratings: { technical: 4, communication: 5, behaviour: 4, performance: null, overall: 4 }, recommendation: "next_round", comments: "Strong examples.",
  }, deps), { ok: true, message: "Feedback saved." });

  const saved = repo.interviews(app.id).find((row) => row.id === interview.id)!;
  assert.equal(saved.outcome, "attended");
  assert.equal(saved.result, "passed");
  assert.equal(saved.feedback.length, 1);
  assert(saved.history.some((row) => row.kind === "rescheduled"));
  assert(saved.history.some((row) => row.kind === "status"));
});

test("feedback still needs a score or a comment", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const interview = repo.interviews().find((row) => row.feedback.length === 0)!;
  assert(interview);
  const app = repo.application(interview.applicationId)!;
  const result = await writeCandidateInterview(lead, app.openingId, app.id, {
    action: "feedback", interviewId: interview.id, forUserId: null, interviewer: "Panel",
    ratings: { technical: null, communication: null, behaviour: null, performance: null, overall: null }, recommendation: null, comments: "",
  }, deps);
  assert.deepEqual(result, { ok: false, status: 400, message: "Give at least one score or a comment." });
});
