/** The native candidate sheet keeps the website's privacy boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-candidate-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileCandidate } = await import("@/lib/mobile/candidate");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");
repo.reset();

const synthetic = (role: Role): User => ({
  id: `u_candidate_${role}`,
  name: `Candidate ${role}`,
  email: `${role}@example.test`,
  phone: null,
  routingEmail: null,
  role,
  initials: "CC",
  isActive: true,
});

test("an authorised sheet contains the full profile and stage siblings", () => {
  const admin = synthetic("admin");
  const opening = repo.openings().find((row) => repo.applications(row.id).length > 0)!;
  const app = repo.applications(opening.id)[0]!;
  const result = mobileCandidate(admin, opening.id, app.id);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.payload.context.applicationId, app.id);
  assert.equal(result.payload.profile.candidateId, app.candidateId);
  assert(result.payload.tabs.some((tab) => tab.key === "history"));
  assert.equal(result.payload.referenceAccess.canView, true);
  assert.equal(result.payload.referenceAccess.canVerify, true);
  assert.equal(result.payload.followUp, null);
  assert(result.payload.messages.every((message) => typeof message.deliveryStatus === "string"));
  assert(result.payload.context.position >= 1);
  assert(result.payload.context.total >= 1);
});

test("an application cannot be crossed into a different opening", () => {
  const admin = synthetic("admin");
  const openings = repo.openings().filter((row) => repo.applications(row.id).length > 0);
  assert(openings.length >= 2);
  const app = repo.applications(openings[0]!.id)[0]!;
  assert.deepEqual(mobileCandidate(admin, openings[1]!.id, app.id), { kind: "not_found" });
});

test("a TA cannot open another recruiter's candidate by address", () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const opening = repo.openingsForUser(ta).find((row) => {
    const assignment = repo.assignmentFor(row.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(row.id).some((app) => visibleToSeat([app], seat).length === 0);
  });
  if (!opening) return;
  const assignment = repo.assignmentFor(opening.id, ta.id);
  const seat = seatFor(ta, assignment?.role ?? null);
  const hidden = repo.applications(opening.id).find((app) => visibleToSeat([app], seat).length === 0)!;
  const result = mobileCandidate(ta, opening.id, hidden.id);
  assert.equal(result.kind, "forbidden");
});

test("client contacts cannot open sourcing stages", () => {
  const client = synthetic("client");
  const app = repo.openings().flatMap((opening) => repo.applications(opening.id)).find((row) => row.stage === "ta_follow_up");
  assert(app);
  const result = mobileCandidate(client, app.openingId, app.id);
  assert.equal(result.kind, "forbidden");
});

test("client seats never receive reference contact lists", () => {
  const client = synthetic("client");
  const opening = repo.openings().find((row) => repo.applications(row.id).some((app) => ["client_shortlist", "interview", "offer", "placed"].includes(app.stage)))!;
  const current = repo.assignments(opening.id).map(({ userId, role }) => ({ userId, role }));
  repo.setAssignments(opening.id, [...current, { userId: client.id, role: "client_contact" }], adminUserId());
  const app = repo.applications(opening.id).find((row) => ["client_shortlist", "interview", "offer", "placed"].includes(row.stage))!;
  assert(opening && app);
  const result = mobileCandidate(client, opening.id, app.id);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.payload.referenceAccess, { canView: false, canVerify: false });
  assert.deepEqual(result.payload.referees, []);
  assert.deepEqual(result.payload.companyReferences, []);
  assert.equal(result.payload.tabs.some((tab) => tab.key === "reference" || tab.key === "company_refs"), false);
});

function adminUserId() {
  return repo.users().find((row) => row.role === "admin")?.id ?? "system";
}
