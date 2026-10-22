/**
 * The mobile openings API (src/lib/mobile/openings.ts, src/lib/openings/writes.ts):
 * the web's /openings list and an opening's header, rail and Overview as data,
 * and its status / working stage / Bin writes through the same code the web's
 * server actions use. Run against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-openings-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { allows, isDeskWide } = await import("@/lib/auth");
const { mobileOpeningsList, mobileOpeningShell, mobileOpeningOverview, mayReadOpening } = await import("@/lib/mobile/openings");
const { toCountry } = await import("@/lib/openingCountry");
const { decideOn, writeOpeningStatus, writeWorkingStage, binOpenings } = await import("@/lib/openings/writes");
const { setStatusBody, setWorkingStageBody, binOpeningsBody, parseBody } = await import("@/lib/mobile/openingsBodies");
repo.reset();

const seeded = (role: Role) => {
  const found = repo.users().find((u) => u.role === role && u.isActive);
  assert(found, `the seed has a ${role}`);
  return found;
};
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

/** Records what the shared writes asked of Next and of Convex. */
function fakeDeps() {
  const revalidated: string[] = [];
  const convex: string[] = [];
  return {
    revalidated,
    convex,
    deps: {
      revalidatePath: (p: string) => void revalidated.push(p),
      convexQuery: async <T,>(name: string) => {
        convex.push(name);
        return undefined as T;
      },
      convexMutation: async <T,>(name: string) => {
        convex.push(name);
        return undefined as T;
      },
      markTablesStale: () => undefined,
      resetStore: () => undefined,
    },
  };
}

const none = { requestable: null, pendingRequests: null };

test("a TA's list holds only the openings they are on, and its buckets count those rows", () => {
  const ta = seeded("ta");
  const list = mobileOpeningsList(ta, none);
  const mine = new Set(repo.openingsForUser(ta).map((o) => o.id));
  assert(list.rows.length > 0, "the seed TA has openings");
  for (const row of list.rows) assert(mine.has(row.id), `${row.title} is one of the TA's own`);
  const count = (k: string) => list.buckets.find((b) => b.key === k)!.count;
  assert.equal(count("mine"), list.rows.filter((r) => r.buckets.includes("mine")).length);
  assert.equal(count("all"), list.rows.filter((r) => r.buckets.includes("all")).length);
  assert.equal(count("hold"), list.rows.filter((r) => r.status === "on_hold").length);
  assert.equal(list.filters.tas, null, "a TA gets no TA filter");
  assert.notEqual(list.requestable, null, "a TA may ask for openings");
  assert.equal(list.pendingRequests, null, "a TA approves nobody's ask");
});

test("desk-wide roles see the whole desk and the TA filter; leads and admins get the approval queue", () => {
  for (const role of ["ta_lead", "admin", "director", "ops"] as Role[]) {
    const user = synthetic(role);
    assert(isDeskWide(user));
    const list = mobileOpeningsList(user, none);
    assert.equal(list.rows.length, repo.openings().length, `${role} sees every opening`);
    assert.notEqual(list.filters.tas, null, `${role} gets the TA filter`);
    assert.equal(list.pendingRequests !== null, role === "ta_lead" || role === "admin");
    assert.equal(list.requestable, null);
  }
});

test("row permissions match the web's checks", () => {
  for (const role of ["ta", "ta_lead", "viewer"] as Role[]) {
    const user = role === "ta" ? seeded("ta") : synthetic(role);
    for (const row of mobileOpeningsList(user, none).rows) {
      const assignment = repo.assignmentFor(row.id, user.id) ?? null;
      assert.equal(row.canBin, allows(user, "opening.manage", { openingId: row.id, assignment }), `${role} bin on ${row.title}`);
      assert.equal(row.workingStage !== null, allows(user, "opening.act", { assignment }), `${role} stage on ${row.title}`);
    }
  }
  const viewer = mobileOpeningsList(synthetic("viewer"), none);
  assert(viewer.rows.every((r) => !r.canBin && !r.canSetStatus && r.workingStage === null), "a viewer changes nothing");
});

test("countries are read from locations the way the web's filter reads them", () => {
  assert.equal(toCountry("Colombo 03"), "Sri Lanka");
  assert.equal(toCountry("Female only"), "Female only", "no partial-word match");
  for (const row of mobileOpeningsList(synthetic("admin"), none).rows) {
    assert.deepEqual(row.countries, [...new Set(row.locations.map(toCountry).filter(Boolean))]);
  }
});

test("an opening's shell and overview follow the seat: a client contact sees the shortlist side only", () => {
  const admin = synthetic("admin");
  const opening = repo.openings()[0];
  assert(mayReadOpening(admin, opening.id));
  const shell = mobileOpeningShell(admin, opening.id, { middayEmails: [] })!;
  assert(shell.sections.includes("hh_tables") && shell.sections.includes("eod"), "a lead sees the whole rail");
  assert(shell.stages.length >= 8);

  const client = synthetic("client");
  const clientShell = mobileOpeningShell(client, opening.id, { middayEmails: [{ id: "x", number: 1, status: "draft" }] })!;
  assert.deepEqual(clientShell.sections, ["overview", "pipeline", "jd"]);
  assert.deepEqual(clientShell.stages.map((s) => s.stage), ["client_shortlist", "interview", "offer", "placed"]);
  assert.deepEqual(clientShell.middayEmails, [], "no daily emails for a seat that does not act");
  assert.deepEqual(clientShell.posts, []);

  const overview = mobileOpeningOverview(admin, opening.id, { matching: null })!;
  assert.equal(overview.pipeline.reduce((n, s) => n + s.count, 0), overview.inPipeline);
  assert.equal(overview.canEdit, true);
});

test("a TA cannot read an opening they are not on", () => {
  const ta = seeded("ta");
  const theirs = new Set(repo.openingsForUser(ta).map((o) => o.id));
  const other = repo.openings().find((o) => !theirs.has(o.id) && !repo.strategyAssignments(o.id).some((r) => r.doneBy.includes(ta.id)));
  assert(other, "the seed has an opening the TA is not on");
  assert.equal(mayReadOpening(ta, other.id), false);
});

test("the shared decision refuses what the web refuses", async () => {
  const { deps } = fakeDeps();
  const opening = repo.openings()[0];
  assert.deepEqual(await decideOn(synthetic("admin"), "opening.manage", { openingId: opening.id }, deps), { ok: true });
  const viewer = await decideOn(synthetic("viewer"), "opening.manage", { openingId: opening.id }, deps);
  assert.equal(viewer.ok, false);
  assert.equal(!viewer.ok && viewer.status, 403);
  const gone = await decideOn(synthetic("admin"), "opening.manage", { openingId: "nope" }, deps);
  assert.deepEqual(gone, { ok: false, status: 404, message: "That opening no longer exists." });
});

test("status and working stage write and revalidate as the web's actions did", async () => {
  const opening = repo.openings()[0];
  const { deps, revalidated } = fakeDeps();
  writeOpeningStatus(opening.id, "on_hold", deps);
  assert.equal(repo.opening(opening.id)!.status, "on_hold");
  assert.deepEqual(revalidated, ["/openings", `/openings/${opening.id}`]);
  writeOpeningStatus(opening.id, "open", deps);

  const admin = synthetic("admin");
  const bad = await writeWorkingStage(admin, opening.id, "50%", deps);
  assert.deepEqual(bad, { ok: false, message: "Choose a valid working stage." });
  const good = await writeWorkingStage(admin, opening.id, "Add-on", deps);
  assert.deepEqual(good, { ok: true });
  assert.equal(repo.workingStage(opening.id, admin.id), "Add-on");
});

test("binning checks each opening on its own and says which were refused", async () => {
  const { deps } = fakeDeps();
  const [a, b] = repo.openings();
  const viewer = await binOpenings(synthetic("viewer"), [a.id], deps);
  assert.equal(viewer.deleted, 0);
  assert.equal(viewer.problems.length, 1);
  assert.match(viewer.message, /^0 openings moved to the Bin\. They can be restored for \d+ days\. Not deleted — /);

  const admin = await binOpenings(synthetic("admin"), [b.id], deps);
  assert.equal(admin.deleted, 1);
  assert.match(admin.message, /^1 opening moved to the Bin\. They can be restored for \d+ days\.$/);
  assert.equal(repo.openings().some((o) => o.id === b.id), false, "it left the list");
});

test("request bodies are checked before anything runs", () => {
  const problem = "bad";
  assert.equal(parseBody(setStatusBody, { status: "on_hold" }, problem).ok, true);
  assert.equal(parseBody(setStatusBody, { status: "deleted" }, problem).ok, false);
  assert.equal(parseBody(setStatusBody, { status: "open", extra: 1 }, problem).ok, false);
  assert.equal(parseBody(setWorkingStageBody, { stage: "Follow-up" }, problem).ok, true);
  assert.equal(parseBody(setWorkingStageBody, { stage: "50%" }, problem).ok, false);
  assert.equal(parseBody(binOpeningsBody, { openingIds: [] }, problem).ok, false);
  assert.equal(parseBody(binOpeningsBody, { openingIds: ["o1"] }, problem).ok, true);
  assert.equal(parseBody(binOpeningsBody, undefined, problem).ok, false);
});

test("no candidate contact details in any payload", () => {
  const admin = synthetic("admin");
  const opening = repo.openings()[0];
  const json = JSON.stringify([
    mobileOpeningsList(admin, none),
    mobileOpeningShell(admin, opening.id, { middayEmails: [] }),
    mobileOpeningOverview(admin, opening.id, { matching: null }),
  ]);
  for (const c of repo.candidates()) {
    if (c.email) assert(!json.includes(c.email), "no candidate email");
    if (c.phone) assert(!json.includes(c.phone), "no candidate phone");
  }
});
