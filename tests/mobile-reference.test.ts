/** The phone reference desk remains opening-scoped and follows the website's sourcing seat. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-reference-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileReference } = await import("@/lib/mobile/reference");
repo.reset();

test("an assigned recruiter receives the website's opening-scoped referee groups", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta).find((row) => repo.refereesForPipeline(row.id).length > 0) ?? repo.openingsForUser(ta)[0]!;
  const expected = repo.refereesForPipeline(opening.id);
  const payload = mobileReference(ta, opening.id);
  assert(payload);
  assert.equal(payload.candidates.length, expected.length);
  assert.equal(payload.stats.referees, expected.flatMap((group) => group.referees).length);
  assert(payload.candidates.every((group) => expected.some((row) => row.app.id === group.applicationId)));
});

test("a backchannel search is limited to the company and eight contactable people", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  const company = repo.candidates().find((row) => row.currentEmployer && (row.phone || row.email))?.currentEmployer ?? "Missing company";
  const payload = mobileReference(ta, opening.id, company);
  assert(payload?.backchannel);
  assert.equal(payload.backchannel.company, company);
  assert(payload.backchannel.people.length <= 8);
  assert(payload.backchannel.people.every((row) => row.phone || row.email));
});

test("a client seat cannot read the reference desk", () => {
  const client = { id: "u_reference_client", name: "Client", email: "client@example.test", phone: null, routingEmail: null, role: "client" as const, initials: "CL", isActive: true };
  assert.equal(mobileReference(client, repo.openings()[0]!.id), null);
});
