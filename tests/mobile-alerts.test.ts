/**
 * `GET /api/mobile/v1/alerts` and `POST /api/mobile/v1/alerts/read`
 * (src/lib/mobile/alerts.ts, src/lib/alerts/readState.ts): the web's /alerts
 * page as data, and its Mark read / unread / all — through the same service
 * the web's server actions use. Run against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-alerts-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { computeAlerts, alertsFor } = await import("@/lib/sla");
const { isWorkingDay } = await import("@/lib/calendar");
const { KIND_LABEL, alertGroup, runsEveryDay } = await import("@/lib/alertKinds");
const { markAlerts, canSwitchAlertScope } = await import("@/lib/alerts/readState");
const { mobileAlerts, markAlertsBodySchema, parseMarkAlertsBody } = await import("@/lib/mobile/alerts");
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

/** Records what the service asked of Next and of Convex. */
function fakeDeps() {
  const revalidated: string[] = [];
  const convex: string[] = [];
  return {
    revalidated,
    convex,
    deps: {
      revalidatePath: (p: string) => void revalidated.push(p),
      convexMutation: async (name: string) => void convex.push(name),
    },
  };
}

/** A seeded person with alerts of their own, fewer than the desk's. */
function personWithAlerts(roles: Role[]): User {
  const all = computeAlerts();
  const found = repo
    .users()
    .filter((u) => roles.includes(u.role))
    .find((u) => {
      const mine = alertsFor(u.id).length;
      return mine > 0 && mine < all.length;
    });
  assert(found, `the seed has a ${roles.join("/")} with some, not all, of the alerts`);
  return found;
}

test("only an admin, TA lead or director may see everyone's", () => {
  const allowed: Role[] = ["admin", "ta_lead", "director"];
  for (const role of ["admin", "ta_lead", "director", "ta", "ta_support", "ops", "viewer", "client"] as Role[]) {
    const user = synthetic(role);
    assert.equal(canSwitchAlertScope(user), allowed.includes(role), role);
    const payload = mobileAlerts(user, true);
    assert.equal(payload.canSwitchScope, allowed.includes(role));
    assert.equal(payload.scope, allowed.includes(role) ? "everyone" : "mine", `${role} asking for everyone's`);
    assert.equal(mobileAlerts(user, false).scope, "mine");
  }
});

test("a TA asking for everyone's silently gets their own", () => {
  const ta = personWithAlerts(["ta"]);
  const mine = alertsFor(ta.id).map((a) => a.id).sort();
  const asked = mobileAlerts(ta, true);
  assert.equal(asked.scope, "mine");
  assert.deepEqual(asked.alerts.map((a) => a.id).sort(), mine);
  assert(asked.alerts.length < computeAlerts().length, "not the whole desk");

  const lead = synthetic("ta_lead");
  assert.equal(mobileAlerts(lead, true).alerts.length, computeAlerts().length);
  assert.deepEqual(mobileAlerts(lead, false).alerts, [], "a lead with no alerts of their own sees none as 'mine'");
});

test("rows carry the page's label, opening and assignees, and nothing else", () => {
  const payload = mobileAlerts(synthetic("director"), true);
  assert(payload.alerts.length > 0, "the seed raises alerts");
  const names = new Map(repo.users().map((u) => [u.id, u.name]));
  for (const row of payload.alerts) {
    const raw = computeAlerts().find((a) => a.id === row.id)!;
    assert.equal(row.kindLabel, KIND_LABEL[row.kind] ?? row.kind);
    assert.equal(row.openingTitle, repo.opening(raw.openingId)?.title ?? null);
    assert.deepEqual(row.assignees, raw.assignedTo.map((id) => names.get(id)).filter(Boolean));
    assert.deepEqual(
      Object.keys(row).sort(),
      ["action", "assignees", "detail", "dueAt", "group", "href", "id", "kind", "kindLabel", "openingId", "openingTitle", "read", "urgent"],
    );
  }
  const json = JSON.stringify(payload);
  for (const c of repo.candidates()) {
    if (c.email) assert(!json.includes(c.email), "no candidate email appears");
    if (c.phone) assert(!json.includes(c.phone), "no candidate phone number appears");
  }
});

test("headings follow the page: urgent, then today, held only off a working day", () => {
  assert.equal(alertGroup({ urgent: true, kind: "cv_waiting" }, false), "urgent");
  assert.equal(alertGroup({ urgent: true, kind: "cv_waiting" }, true), "urgent");
  assert.equal(alertGroup({ urgent: false, kind: "cv_waiting" }, true), "today");
  assert.equal(alertGroup({ urgent: false, kind: "cv_waiting" }, false), "held");
  for (const kind of ["followup_due", "opening_assigned", "review_reply_received"]) {
    assert(runsEveryDay(kind));
    assert.equal(alertGroup({ urgent: false, kind }, false), "today", `${kind} runs at weekends too`);
  }
  assert(!runsEveryDay("stale_role"));

  // The payload at now, and at the next non-working day.
  const director = synthetic("director");
  let offDay = Date.now();
  while (isWorkingDay(new Date(offDay))) offDay += 24 * 3600 * 1000;
  for (const now of [Date.now(), offDay]) {
    const payload = mobileAlerts(director, true, now);
    assert.equal(payload.workingDay, isWorkingDay(new Date(now)));
    const rank = { urgent: 0, today: 1, held: 2 };
    for (let i = 1; i < payload.alerts.length; i++) {
      assert(rank[payload.alerts[i - 1].group] <= rank[payload.alerts[i].group], "listed urgent, today, held");
    }
    for (const row of payload.alerts) {
      assert.equal(row.group, alertGroup(row, payload.workingDay));
      if (payload.workingDay) assert.notEqual(row.group, "held");
    }
  }
  assert.equal(mobileAlerts(director, true, offDay).workingDay, false);
});

test("mark read and unread round-trips through the shared service", async () => {
  const ta = personWithAlerts(["ta"]);
  const ids = alertsFor(ta.id).map((a) => a.id);
  const one = ids[0];
  assert(!mobileAlerts(ta, false).alerts.find((a) => a.id === one)!.read, "starts unread");

  const { deps, revalidated, convex } = fakeDeps();
  const read = await markAlerts(ta, { read: true, ids: [one] }, deps);
  assert.deepEqual(read, { ok: true, changed: 1, message: "1 alert marked as read." });
  assert(mobileAlerts(ta, false).alerts.find((a) => a.id === one)!.read);
  assert(repo.readAlertIds(ta.id).has(one));
  assert.deepEqual(revalidated, ["/alerts", "/api/notifications"]);
  assert.deepEqual(convex, [], "the JSON store tells no backend");

  if (ids.length > 1) {
    const two = await markAlerts(ta, { read: true, ids: ids.slice(0, 2) }, deps);
    assert.equal(two.ok && two.message, "2 alerts marked as read.");
  }

  const unread = await markAlerts(ta, { read: false, ids: [one] }, deps);
  assert.deepEqual(unread, { ok: true, changed: 1, message: "1 alert marked as unread." });
  assert(!mobileAlerts(ta, false).alerts.find((a) => a.id === one)!.read);

  // Read state is per person: another user's view is untouched.
  const lead = synthetic("ta_lead");
  await markAlerts(ta, { read: true, ids: [one] }, deps);
  assert(!mobileAlerts(lead, true).alerts.find((a) => a.id === one)!.read);

  assert.deepEqual(await markAlerts(ta, { read: true, ids: [] }, deps), { ok: false, message: "No alerts selected." });
  repo.clearReadAlerts(ta.id);
});

test("mark all covers the scope, and a TA's 'everyone' is their own", async () => {
  const ta = personWithAlerts(["ta"]);
  const { deps } = fakeDeps();
  const res = await markAlerts(ta, { all: true, everyone: true }, deps);
  assert.deepEqual(res, { ok: true, changed: alertsFor(ta.id).length, message: "All alerts marked as read." });
  assert(mobileAlerts(ta, false).alerts.every((a) => a.read));
  const others = computeAlerts().filter((a) => !a.assignedTo.includes(ta.id));
  assert(others.length > 0);
  for (const a of others) assert(!repo.readAlertIds(ta.id).has(a.id), "everyone's was not marked for a TA");

  const director = synthetic("director");
  const all = await markAlerts(director, { all: true, everyone: true }, deps);
  assert.equal(all.ok && all.changed, computeAlerts().length);
  assert(mobileAlerts(director, true).alerts.every((a) => a.read));
  repo.clearReadAlerts(ta.id);
  repo.clearReadAlerts(director.id);
});

test("the request body is checked before anything is marked", () => {
  const good = [
    { read: true, ids: ["a1"] },
    { read: false, ids: ["a1", "a2"] },
    { read: true, all: true, scope: "mine" },
    { read: true, all: true, scope: "everyone" },
    { read: true, ids: Array.from({ length: 500 }, (_, i) => `a${i}`) },
  ];
  for (const body of good) assert(markAlertsBodySchema.safeParse(body).success, JSON.stringify(body).slice(0, 60));

  const bad: unknown[] = [
    undefined,
    null,
    "read",
    {},
    { read: true },
    { read: true, ids: [] },
    { read: true, ids: [""] },
    { read: true, ids: ["   "] },
    { read: true, ids: [1] },
    { read: "yes", ids: ["a1"] },
    { ids: ["a1"] },
    { read: false, all: true, scope: "mine" },
    { read: true, all: true },
    { read: true, all: true, scope: "team" },
    { read: true, all: false, scope: "mine" },
    { read: true, all: true, scope: "mine", ids: ["a1"] },
    { read: true, ids: Array.from({ length: 501 }, (_, i) => `a${i}`) },
  ];
  for (const body of bad) {
    assert(!markAlertsBodySchema.safeParse(body).success, `refused: ${JSON.stringify(body)?.slice(0, 60)}`);
    const parsed = parseMarkAlertsBody(body);
    assert(!parsed.ok && parsed.message.length > 0);
  }
  const tooMany = parseMarkAlertsBody({ read: true, ids: Array.from({ length: 501 }, (_, i) => `a${i}`) });
  assert(!tooMany.ok && tooMany.message === "Mark at most 500 alerts at a time.");

  assert.deepEqual(parseMarkAlertsBody({ read: true, all: true, scope: "everyone" }), { ok: true, request: { all: true, everyone: true } });
  assert.deepEqual(parseMarkAlertsBody({ read: false, ids: ["a1"] }), { ok: true, request: { read: false, ids: ["a1"] } });
});
