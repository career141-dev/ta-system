/** Director-review details and notes use the same writes on web and mobile. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-review-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { writeCandidateReview } = await import("@/lib/candidates/reviewWrites");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");

const deps = {
  convexQuery: async <T,>() => undefined as T,
  revalidatePath: () => undefined,
  markTablesStale: () => undefined,
  invalidateCandidate: () => undefined,
  primeStore: async () => undefined,
};
repo.reset();

test("another recruiter cannot change Director-review details by direct address", async () => {
  const ta = repo.users().find((row) => row.role === "ta" && row.isActive)!;
  const found = repo.openingsForUser(ta).flatMap((opening) => {
    const assignment = repo.assignmentFor(opening.id, ta.id);
    const seat = seatFor(ta, assignment?.role ?? null);
    return repo.applications(opening.id)
      .filter((app) => visibleToSeat([app], seat).length === 0)
      .map((app) => ({ opening, app }));
  })[0];
  assert(found);
  const candidate = repo.candidate(found.app.candidateId)!;
  const before = candidate.expectedSalary;
  const result = await writeCandidateReview(ta, found.opening.id, found.app.id, {
    action: "details",
    currentSalary: "",
    currentSalaryCurrency: "LKR",
    expectedSalary: "450,000",
    expectedSalaryCurrency: "LKR",
    noticePeriod: "30 days",
    currentDesignation: candidate.currentTitle ?? "",
    currentCompany: candidate.currentEmployer ?? "",
    customDetails: [],
  }, deps);
  assert.equal(result.ok, false);
  assert.equal(repo.candidate(candidate.id)?.expectedSalary, before);
});

test("details keep the website's currency, notice and custom-line rules", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const app = repo.openings().flatMap((opening) => repo.applications(opening.id))[0]!;
  const candidate = repo.candidate(app.candidateId)!;
  const result = await writeCandidateReview(lead, app.openingId, app.id, {
    action: "details",
    currentSalary: "Not disclosed",
    currentSalaryCurrency: "LKR",
    expectedSalary: "450,000",
    expectedSalaryCurrency: "LKR",
    noticePeriod: "2 months",
    currentDesignation: "Finance Manager",
    currentCompany: "Lanka Manufacturing",
    customDetails: [{ label: "Availability", value: "Can interview after 5 PM" }, { label: "", value: "Prefers Colombo" }],
  }, deps);
  assert.deepEqual(result, { ok: true, message: "Details saved." });
  const saved = repo.candidate(candidate.id)!;
  assert.equal(saved.currentSalary, "Not disclosed");
  assert.equal(saved.expectedSalary, "LKR 450,000");
  assert.equal(saved.noticePeriodDays, 60);
  assert.equal(saved.currentTitle, "Finance Manager");
  assert.deepEqual(repo.application(app.id)?.notes?.slice(-2), ["Availability: Can interview after 5 PM", "Prefers Colombo"]);
});

test("a review note can be removed only by its writer", async () => {
  const lead = repo.users().find((row) => row.role === "ta_lead" && row.isActive)!;
  const director = repo.users().find((row) => row.role === "director" && row.isActive)!;
  const app = repo.openings().flatMap((opening) => repo.applications(opening.id))[0]!;
  assert.deepEqual(await writeCandidateReview(lead, app.openingId, app.id, { action: "add_note", note: "Strong finance controls experience." }, deps), { ok: true, message: "Note added." });
  const note = repo.application(app.id)?.reviewNotes?.at(-1)!;
  assert(note);
  assert.deepEqual(await writeCandidateReview(director, app.openingId, app.id, { action: "remove_note", noteId: note.id }, deps), { ok: false, status: 403, message: "Only the person who wrote a note can remove it." });
  assert.deepEqual(await writeCandidateReview(lead, app.openingId, app.id, { action: "remove_note", noteId: note.id }, deps), { ok: true, message: "Note removed." });
});
