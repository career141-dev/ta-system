/** Manual call logs use the same permission and persistence rules on web and mobile. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-call-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { writeCandidateCall } = await import("@/lib/candidates/callWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const paths: string[] = [];
const deps = {
  convexQuery: async <T,>() => undefined as T,
  revalidatePath: (value: string) => { paths.push(value); },
  markTablesStale: () => undefined,
};
repo.reset();

test("another recruiter cannot log a call by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 0)
      .map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const before = repo.callFeedback(found.app.id).length;
  const result = await writeCandidateCall(ta, found.opening.id, found.app.id, { kind: "ad_hoc", outcome: "reached", body: "Called." }, deps);
  assert.equal(result.ok, false);
  assert.equal(repo.callFeedback(found.app.id).length, before);
});

test("a manual call is logged and a reached pre-interview call clears its escalation", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const escalation = repo.alerts().find((row) => row.kind === "interview_confirmation_escalation")!;
  assert(escalation);
  const app = repo.application(escalation.subjectId)!;
  assert(app);
  paths.length = 0;
  const result = await writeCandidateCall(lead, app.openingId, app.id, {
    kind: "pre_interview",
    outcome: "reached",
    body: "Confirmed attendance for tomorrow.",
  }, deps);
  assert.deepEqual(result, { ok: true, message: "Call logged." });
  assert.deepEqual(repo.callFeedback(app.id).at(-1), {
    applicationId: app.id,
    kind: "pre_interview",
    outcome: "reached",
    body: "Confirmed attendance for tomorrow.",
    structured: null,
    source: "manual",
    recordedBy: lead.id,
    id: repo.callFeedback(app.id).at(-1)!.id,
    recordedAt: repo.callFeedback(app.id).at(-1)!.recordedAt,
  });
  assert.deepEqual(paths, ["/alerts", `/openings/${app.openingId}`]);
  assert.equal(repo.alerts().some((row) => row.id === escalation.id), false);
});
