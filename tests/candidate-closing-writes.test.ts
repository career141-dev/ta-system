/** Web and phone offer actions share one permission and record path. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-closing-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { writeCandidateClosing } = await import("@/lib/candidates/closingWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const deps = { convexQuery: async <T,>() => undefined as T, revalidatePath: () => undefined };
repo.reset();

test("another recruiter cannot make an offer by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 0)
      .map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const before = repo.offers(found.app.id).length;
  const result = await writeCandidateClosing(ta, found.opening.id, found.app.id, {
    action: "offer", salary: 300_000, salaryBasis: "monthly", currency: "LKR", startDate: "2030-03-04", terms: "Medical cover",
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(repo.offers(found.app.id).length, before);
});

test("an offer can be recorded and turned into a placement", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const app = repo.applications().find((row) => row.stage === "client_shortlist")!;
  const opening = repo.opening(app.openingId)!;

  assert.deepEqual(await writeCandidateClosing(lead, opening.id, app.id, {
    action: "offer", salary: 320_000, salaryBasis: "monthly", currency: "LKR", startDate: "2030-03-04", terms: "Vehicle and fuel allowance",
  }, deps), { ok: true, message: "Offer recorded." });
  assert.equal(repo.application(app.id)?.stage, "offer");
  const offer = repo.pendingOffer(app.id)!;
  assert.equal(offer.salary, 320_000);

  const placed = await writeCandidateClosing(lead, opening.id, app.id, {
    action: "place", offerId: offer.id, joinDate: "2030-03-10",
  }, deps);
  assert.equal(placed.ok, true);
  assert.equal(placed.message, "Placement recorded.");
  assert(placed.ok && placed.placementId);
  assert.equal(repo.application(app.id)?.stage, "placed");
  assert.equal(repo.offer(offer.id)?.status, "accepted");
  assert.equal(repo.placementForApplication(app.id)?.offerId, offer.id);
});

test("declining an offer closes it and records why", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const app = repo.applications().find((row) => row.stage === "interview" && !repo.pendingOffer(row.id))!;
  const opening = repo.opening(app.openingId)!;
  const made = await writeCandidateClosing(lead, opening.id, app.id, {
    action: "offer", salary: 5_400, salaryBasis: "annual", currency: "USD", startDate: "", terms: "",
  }, deps);
  assert.equal(made.ok, true);
  const offer = repo.pendingOffer(app.id)!;

  assert.deepEqual(await writeCandidateClosing(lead, opening.id, app.id, {
    action: "respond", offerId: offer.id, status: "declined", reason: "Accepted a counter-offer",
  }, deps), { ok: true, message: "Offer declined." });
  assert.equal(repo.offer(offer.id)?.status, "declined");
  assert.equal(repo.application(app.id)?.stage, "dropped_out");
  assert.equal(repo.application(app.id)?.offerDeclineReason, "Accepted a counter-offer");
});

test("a placement still needs a readable join date", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const offer = repo.offers().find((row) => row.status === "pending")!;
  assert(offer);
  const result = await writeCandidateClosing(lead, offer.openingId, offer.applicationId, {
    action: "place", offerId: offer.id, joinDate: "",
  }, deps);
  assert.deepEqual(result, { ok: false, status: 400, message: "A placement needs a join date." });
});
