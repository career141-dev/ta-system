/** Follow-up sends stay behind the same candidate scope and connected-store gate. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-follow-up-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { sendCandidateFollowUp, stopCandidateFollowUp } = await import("@/lib/candidates/followUpWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const deps = {
  convexQuery: async <T,>() => undefined as T,
  convexMutation: async <T,>() => { throw new Error("must not reach the backend in the JSON test store"); return undefined as T; },
  resetStore: () => undefined,
  revalidatePath: () => undefined,
};
repo.reset();

test("a candidate outside the recruiter's seat cannot be messaged by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 0)
      .map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const result = await sendCandidateFollowUp(ta, found.opening.id, found.app.id, "whatsapp", deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
});

test("the local JSON store cannot pretend an outreach was sent or stopped", async () => {
  const admin = {
    id: "u_follow_up_admin",
    name: "Follow-up Admin",
    email: "follow-up-admin@example.test",
    phone: null,
    routingEmail: null,
    role: "admin" as const,
    initials: "FA",
    isActive: true,
  };
  const opening = repo.openings().find((row) => repo.applications(row.id).length > 0)!;
  const app = repo.applications(opening.id)[0]!;
  assert.deepEqual(await sendCandidateFollowUp(admin, opening.id, app.id, "email", deps), {
    ok: false,
    status: 409,
    message: "Sending needs the Convex store.",
  });
  assert.deepEqual(await stopCandidateFollowUp(admin, opening.id, app.id, deps), {
    ok: false,
    status: 409,
    message: "Stopping needs the Convex store.",
  });
});
