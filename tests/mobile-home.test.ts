/**
 * `GET /api/mobile/v1/home` (src/lib/mobile/home.ts): each role gets the web
 * dashboard it would see on `/`, as data — and nothing about candidates beyond
 * their names. Run against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";
import type { DirectorHome, HomeVariant, LeadHome, OpsHome, TaHome } from "@/lib/mobile/homeTypes";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-home-"));
process.chdir(tmp);
const { repo, stageCounts } = await import("@/data/store");
const { PIPELINE_STAGES } = await import("@/data/types");
const { mobileHome } = await import("@/lib/mobile/home");
const { KIND_LABEL } = await import("@/lib/alertKinds");
const { openingNeed } = await import("@/lib/openingNeed");
const { isTa } = await import("@/lib/auth");
repo.reset();

const seeded = (role: Role) => {
  const found = repo.users().find((u) => u.role === role);
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
const openOpenings = () => repo.openings().filter((o) => o.status === "open");

/** Every key anywhere in the payload, and every string value. */
function walk(value: unknown, keys = new Set<string>(), strings = new Set<string>()) {
  if (typeof value === "string") strings.add(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      walk(v, keys, strings);
    }
  }
  return { keys, strings };
}

function assertNoCandidateDetail(home: HomeVariant) {
  const { keys, strings } = walk(home);
  for (const k of ["email", "phone", "cv", "cvUrl", "cvText", "candidateId", "notes", "salary", "nic"]) {
    assert(!keys.has(k), `the payload carries no "${k}" field`);
  }
  const json = JSON.stringify(home);
  for (const c of repo.candidates()) {
    if (c.email) assert(!json.includes(c.email), "no candidate email appears");
    if (c.phone) assert(!json.includes(c.phone), "no candidate phone number appears");
  }
  // A name is the only candidate value allowed through.
  assert(strings.size > 0);
}

test("the role switch matches src/app/page.tsx", () => {
  assert.equal(mobileHome(seeded("ta")).variant, "ta");
  assert.equal(mobileHome(seeded("ta_lead")).variant, "lead");
  assert.equal(mobileHome(synthetic("admin")).variant, "lead");
  assert.equal(mobileHome(seeded("director")).variant, "director");
  assert.equal(mobileHome(seeded("ops")).variant, "ops");
  assert.equal(mobileHome(synthetic("ta_support")).variant, "ta");
  assert.equal(mobileHome(synthetic("viewer")).variant, "ta");
});

test("a TA sees only their own openings, and interviews only on them", () => {
  const tas = repo.users().filter((u) => u.role === "ta");
  assert(tas.length >= 2, "the seed has several TAs");
  const deskInterviews = repo.interviews().filter((i) => i.outcome === "pending" && i.scheduledAt > Date.now()).length;
  let narrowerThanDesk = false;

  for (const ta of tas) {
    const home = mobileHome(ta) as TaHome;
    const mine = repo.openingsForUser(ta).filter((o) => o.status === "open");
    const visibleIds = new Set(repo.openingsForUser(ta).map((o) => o.id));

    assert.equal(home.openCount, home.openings.length);
    assert.deepEqual(home.openings.map((o) => o.id).sort(), mine.map((o) => o.id).sort());
    for (const other of openOpenings().filter((o) => !visibleIds.has(o.id))) {
      assert(!home.openings.some((o) => o.id === other.id), `${ta.id} does not see ${other.id}`);
    }

    assert(home.interviews.length <= 5);
    for (const iv of home.interviews) assert(visibleIds.has(iv.openingId), "an interview on someone else's opening");
    for (let i = 1; i < home.interviews.length; i++) {
      assert(home.interviews[i - 1].scheduledAt <= home.interviews[i].scheduledAt, "interviews in time order");
    }
    if (home.interviews.length < Math.min(5, deskInterviews)) narrowerThanDesk = true;

    assert(home.routine.length <= 6);
    for (const a of [...home.urgent, ...home.routine]) {
      assert.equal(a.kindLabel, KIND_LABEL[a.kind] ?? a.kind);
      assert(a.href.startsWith("/"), "href is a web path");
    }

    for (const o of home.openings) {
      const counts = stageCounts(o.id);
      assert.equal(o.followUp, (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0));
      assert(["jd_approval", "low_cvs", "open_set", "on_track"].includes(o.need.kind));
      if (o.cvsToday < 10 && o.need.kind !== "jd_approval") assert.equal(o.need.kind, "low_cvs");
    }
    assertNoCandidateDetail(home);
  }
  assert(narrowerThanDesk, "at least one TA does not see the whole desk's interviews");
});

test("a viewer put on nothing sees no openings", () => {
  const home = mobileHome(synthetic("viewer")) as TaHome;
  assert.equal(home.openCount, 0);
  assert.equal(home.openings.length, 0);
  assert.equal(home.interviews.length, 0);
});

test("the need line follows the web's order", () => {
  const set = { setNumber: 2, count: 3 };
  assert.equal(openingNeed({ jdStatus: "pending_ta_approval", cvsToday: 0, openSet: set }).kind, "jd_approval");
  assert.equal(openingNeed({ jdStatus: "approved", cvsToday: 9, openSet: set }).text, "Only 9 CVs today — under the ten a day line");
  assert.equal(openingNeed({ jdStatus: "approved", cvsToday: 10, openSet: set }).text, "Set 2 needs 2 more to close");
  assert.equal(openingNeed({ jdStatus: "approved", cvsToday: 10, openSet: undefined }).text, "On track");
});

test("a TA lead sees the team, their decisions and every open role", () => {
  const lead = seeded("ta_lead");
  const home = mobileHome(lead) as LeadHome;
  const open = openOpenings();

  assert.equal(home.roles.length, open.length);
  assert.equal(home.openCount, repo.openingsForUser(lead).filter((o) => o.status === "open").length);
  assert.deepEqual(home.team.map((t) => t.userId).sort(), repo.users().filter((u) => isTa(u)).map((u) => u.id).sort());
  for (const row of home.team) {
    assert.equal(row.onLinkedIn + row.noLink + row.notPosted, row.roleCount);
    assert(row.roleTitles.length <= Math.min(2, row.roleCount));
  }

  const theirs = open.filter((o) => o.taLeadId === lead.id);
  const scope = new Set((theirs.length ? theirs : open).map((o) => o.id));
  for (const d of home.decisions) assert(scope.has(d.openingId), "decisions stay on the lead's own roles");
  for (const d of home.decisions) {
    if (d.kind === "stale") assert(d.daysOpen > d.targetDays);
  }
  assertNoCandidateDetail(home);

  // An admin leads nothing, so the decisions fall back to the whole desk.
  const admin = mobileHome(synthetic("admin")) as LeadHome;
  assert.equal(admin.roles.length, open.length);
  assert.equal(admin.openCount, open.length);
});

test("the director's totals add up", () => {
  const home = mobileHome(seeded("director")) as DirectorHome;
  const open = openOpenings();

  assert.equal(home.openCount, open.length);
  assert.deepEqual(home.stages.map((s) => s.stage), PIPELINE_STAGES);
  const inStages = open.reduce(
    (n, o) => n + repo.applications(o.id).filter((a) => (PIPELINE_STAGES as string[]).includes(a.stage)).length,
    0,
  );
  assert.equal(home.stages.reduce((n, s) => n + s.count, 0), inStages);
  for (const s of home.stages) assert(s.label.length > 0);

  assert.equal(home.byClient.reduce((n, c) => n + c.openCount, 0), home.openCount);
  assert.equal(
    home.byClient.filter((c) => c.openCount > 0).reduce((n, c) => n + c.value, 0),
    home.valueInProgress,
  );
  assert.equal(home.valuePlaced, repo.openings().reduce((n, o) => n + (o.valueOfPlacement ?? 0), 0));

  const reviewing = open.flatMap((o) => repo.applications(o.id).filter((a) => a.stage === "director_review"));
  assert.equal(home.waiting.length, reviewing.length);
  assertNoCandidateDetail(home);
});

test("ops gets the client chase, every pending interview and their own alerts", () => {
  const ops = seeded("ops");
  const home = mobileHome(ops) as OpsHome;
  const open = openOpenings();

  const shortlisted = open.flatMap((o) => repo.applications(o.id).filter((a) => a.stage === "client_shortlist"));
  assert.equal(home.withClient.length, shortlisted.length);
  for (const row of home.withClient) assert(row.daysWithClient >= 0);

  assert.equal(home.interviews.length, repo.interviews().filter((i) => i.outcome === "pending").length);
  for (let i = 1; i < home.interviews.length; i++) {
    assert(home.interviews[i - 1].scheduledAt <= home.interviews[i].scheduledAt);
  }
  for (const a of home.assigned) assert.equal(a.kindLabel, KIND_LABEL[a.kind] ?? a.kind);
  assertNoCandidateDetail(home);
});
