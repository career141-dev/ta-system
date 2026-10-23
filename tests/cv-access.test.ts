/** Direct CV routes keep the candidate ownership boundary of the web page. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-cv-access-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mayChangeCv, mayOpenCv } = await import("@/lib/cvAccess");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");
repo.reset();

test("a TA cannot read or replace another recruiter's CV by direct address", () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive);
  assert(ta);
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 0)
      .map((app) => ({ app, opening }));
  })[0];
  assert(found, "the seed has another recruiter's candidate on a shared opening");
  assert.equal(mayOpenCv(ta, found.app.candidateId, found.app.id), false);
  assert.equal(mayChangeCv(ta, found.app.id), false);
});

test("an authorised candidate keeps read and replacement access", () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive);
  assert(ta);
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 1 && (!app.ownerTaId || app.ownerTaId === ta.id))
      .map((app) => ({ app, opening }));
  })[0];
  assert(found);
  assert.equal(mayOpenCv(ta, found.app.candidateId, found.app.id), true);
  assert.equal(mayChangeCv(ta, found.app.id), true);
});
