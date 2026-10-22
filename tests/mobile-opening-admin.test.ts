/**
 * The Overview's admin actions (src/lib/openings/admin.ts, matching.ts) shared
 * by the web's server actions and the mobile API: the same refusals in the
 * same words, and the same writes. Run against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-admin-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { requestAccess, decideAccess, writeOpeningTeam, writeOpeningDetails } = await import("@/lib/openings/admin");
const { startMatching } = await import("@/lib/openings/matching");
const { mobileOpeningAdmin } = await import("@/lib/mobile/openings");
const { openingDetailsBody, openingTeamBody, accessDecisionBody, parseBody } = await import("@/lib/mobile/openingsBodies");
repo.reset();

const synthetic = (role: Role): User => ({
  id: `u_test_${role}`,
  name: `Test ${role}`,
  email: `${role}@example.test`,
  phone: null,
  routingEmail: null,
  role,
  initials: "TT",
  isActive: true,
});

function fakeDeps() {
  const revalidated: string[] = [];
  const convex: string[] = [];
  return {
    revalidated,
    convex,
    deps: {
      revalidatePath: (p: string) => void revalidated.push(p),
      convexQuery: async <T,>(name: string) => (convex.push(name), undefined as T),
      convexMutation: async <T,>(name: string) => (convex.push(name), undefined as T),
      markTablesStale: () => undefined,
      resetStore: () => undefined,
    },
  };
}

const details = (over: Partial<Record<string, string>> = {}) => ({
  title: "Senior Accountant",
  salaryMin: "250,000",
  salaryMax: "320000",
  salaryCurrency: "LKR",
  packageNotes: " + fuel ",
  locations: "Colombo, Gampaha",
  targetNationalities: "",
  headcount: "2",
  priorityTier: "P2",
  ...over,
});

test("access requests: only a TA may ask, and only on the connected system", async () => {
  const { deps } = fakeDeps();
  const opening = repo.openings()[0];
  assert.deepEqual(await requestAccess(synthetic("director"), opening.id, "", deps), { ok: false, message: "Only a TA can request access to an opening." });
  assert.deepEqual(await requestAccess(synthetic("ta"), "", "", deps), { ok: false, message: "Select an opening first." });
  assert.deepEqual(await requestAccess(synthetic("ta"), opening.id, "", deps), { ok: false, message: "Access requests need the connected system." });
  assert.deepEqual(await decideAccess(synthetic("ta_lead"), "r1", "maybe", "", deps), { ok: false, message: "Choose Approve or Reject." });
  assert.deepEqual(await decideAccess(synthetic("ta_lead"), "", "approve", "", deps), { ok: false, message: "That access request no longer exists." });
});

test("a team with nobody recruiting is refused and nothing changes", async () => {
  const { deps } = fakeDeps();
  const opening = repo.openings()[0];
  const before = repo.assignments(opening.id).map((a) => `${a.userId}:${a.role}`);
  const r = await writeOpeningTeam(synthetic("admin"), opening.id, [{ userId: "x", role: "director" }], deps);
  assert.deepEqual(r, { ok: false, message: "A team needs at least one recruiter on it. Nothing was changed." });
  assert.deepEqual(repo.assignments(opening.id).map((a) => `${a.userId}:${a.role}`), before);
});

test("the team saves one seat per person, the last row winning", async () => {
  const { deps, revalidated } = fakeDeps();
  const opening = repo.openings()[0];
  const ta = repo.users().find((u) => u.role === "ta" && u.isActive)!;
  const r = await writeOpeningTeam(synthetic("admin"), opening.id, [
    { userId: ta.id, role: "supporting_recruiter" },
    { userId: ta.id, role: "primary_recruiter" },
  ], deps);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(repo.assignments(opening.id).map((a) => [a.userId, a.role]), [[ta.id, "primary_recruiter"]]);
  assert(revalidated.includes(`/openings/${opening.id}`));
});

test("details are checked in the web form's order and words", () => {
  const { deps } = fakeDeps();
  const id = repo.openings()[0].id;
  assert.deepEqual(writeOpeningDetails(id, details({ title: "  " }), undefined, deps), { ok: false, message: "An opening needs a title." });
  assert.deepEqual(writeOpeningDetails(id, details({ salaryMin: "500000", salaryMax: "100000" }), undefined, deps), { ok: false, message: "The salary 'from' is higher than the 'to'." });
  assert.deepEqual(writeOpeningDetails(id, details({ priorityTier: "P9" }), undefined, deps), { ok: false, message: "Pick a priority from the list." });
  assert.deepEqual(writeOpeningDetails(id, details({ salaryCurrency: "rupees" }), undefined, deps), { ok: false, message: "Pick a currency from the list." });
});

test("details save as the web saved them: numbers read, lists split, a negative is no amount", () => {
  const { deps } = fakeDeps();
  const id = repo.openings()[0].id;
  assert.deepEqual(writeOpeningDetails(id, details({ salaryMax: "-5000" }), undefined, deps), { ok: true });
  const o = repo.opening(id)!;
  assert.equal(o.salaryMin, 250000);
  assert.equal(o.salaryMax, null);
  assert.equal(o.packageNotes, "+ fuel");
  assert.deepEqual(o.locations, ["Colombo", "Gampaha"]);
  assert.equal(o.headcount, 2);
  assert.equal(o.priorityTier, "P2");
});

test("matching starts only once the JD is approved", () => {
  const { deps } = fakeDeps();
  const scheduled: unknown[] = [];
  const notApproved = repo.openings().find((o) => o.jdStatus !== "approved");
  if (notApproved) {
    const r = startMatching({ id: "u" }, notApproved.id, { ...deps, schedule: (w) => void scheduled.push(w) });
    assert.equal(r.ok, false);
    assert.equal(scheduled.length, 0, "nothing is run");
  }
  const approved = repo.openings().find((o) => o.jdStatus === "approved");
  if (approved) {
    const r = startMatching({ id: "u" }, approved.id, { ...deps, schedule: (w) => void scheduled.push(w) });
    assert.deepEqual(r, { ok: true, message: "Matching started — new matches appear here when it finishes." });
    assert.equal(scheduled.length, 1, "the run is handed to after()");
  }
  assert(notApproved || approved, "the seed has an opening");
});

test("the admin payload fills the forms only for people who may save them", () => {
  const opening = repo.openings()[0];
  const admin = mobileOpeningAdmin(synthetic("admin"), opening.id)!;
  assert.equal(admin.canManage, true);
  assert.equal(admin.details.title, opening.title);
  assert.equal(admin.roles.length, 4);
  assert(admin.people.every((p) => repo.user(p.id)?.isActive));
  assert.equal(mobileOpeningAdmin(synthetic("viewer"), opening.id), null);
});

test("request bodies are checked before anything runs", () => {
  assert.equal(parseBody(openingDetailsBody, details(), "x").ok, true);
  assert.equal(parseBody(openingDetailsBody, { ...details(), extra: "1" }, "x").ok, false);
  assert.equal(parseBody(openingTeamBody, { members: [{ userId: "u", role: "owner" }] }, "x").ok, false);
  assert.equal(parseBody(openingTeamBody, { members: [{ userId: "u", role: "director" }] }, "x").ok, true);
  assert.equal(parseBody(accessDecisionBody, { decision: "approve", reason: "" }, "x").ok, true);
  assert.equal(parseBody(accessDecisionBody, { decision: "yes", reason: "" }, "x").ok, false);
});
