/** Web and phone profile edits share validation, ownership and messages. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-profile-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { writeCandidateProfile } = await import("@/lib/candidates/profileWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const deps = {
  convexQuery: async <T,>() => undefined as T,
  revalidatePath: () => undefined,
};

// Reset once: the JSON seed intentionally reuses nested objects, so resetting after a
// contact mutation would rebuild intakes from the already-mutated candidate object.
repo.reset();

test("the owner can correct and clear contact details with the web's messages", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 1 && (!app.ownerTaId || app.ownerTaId === ta.id))
      .map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const saved = await writeCandidateProfile(ta, found.opening.id, found.app.id, { field: "email", value: "  new@example.test  " }, deps);
  assert.deepEqual(saved, { ok: true, message: "Email saved." });
  assert.equal(repo.candidate(found.app.candidateId)?.email, "new@example.test");
  const cleared = await writeCandidateProfile(ta, found.opening.id, found.app.id, { field: "email", value: "" }, deps);
  assert.deepEqual(cleared, { ok: true, message: "Email saved." });
  assert.equal(repo.candidate(found.app.candidateId)?.email, null);
});

test("another recruiter's candidate cannot be edited by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id).filter((app) => visibleToSeat([app], seat).length === 0).map((app) => ({ opening, app }));
  })[0];
  assert(found, "the seed has another recruiter's candidate on a shared opening");
  const before = repo.candidate(found.app.candidateId)?.phone;
  const result = await writeCandidateProfile(ta, found.opening.id, found.app.id, { field: "phone", value: "+94 77 000 0000" }, deps);
  assert.equal(result.ok, false);
  assert.equal(repo.candidate(found.app.candidateId)?.phone, before);
});

test("name validation keeps the website's exact copy", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const opening = repo.openings().find((row) => repo.applications(row.id).length > 0)!;
  const app = repo.applications(opening.id)[0]!;
  assert.deepEqual(
    await writeCandidateProfile(lead, opening.id, app.id, { field: "name", value: "Unnamed candidate" }, deps),
    { ok: false, status: 400, message: "Type their full name." },
  );
  const saved = await writeCandidateProfile(lead, opening.id, app.id, { field: "name", value: "  Ishara   Jayawardena  " }, deps);
  assert.deepEqual(saved, { ok: true, message: "Name saved." });
  assert.equal(repo.candidate(app.candidateId)?.fullName, "Ishara Jayawardena");
});
