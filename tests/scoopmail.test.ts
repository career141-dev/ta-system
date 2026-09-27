/**
 * Scoops by email (the desk, 27 Sep): CVs the Director, a TA Lead or Ops mail
 * to a TA's own mailbox go on that TA's job and are counted on their
 * end-of-day SCOOP. Another TA's CVs are not a scoop. Where the email does not
 * say which of the TA's jobs it is for, nothing is filed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isScoopSender, pickScoopOpening } from "../convex/lib/scoopMail";

test("the Director, a TA Lead and Ops send scoops", () => {
  assert.equal(isScoopSender({ role: "director" }), true);
  assert.equal(isScoopSender({ role: "ta_manager" }), true);
  assert.equal(isScoopSender({ role: "senior_ta" }), true);
  assert.equal(isScoopSender({ role: "ops" }), true);
  assert.equal(isScoopSender({ role: "recruiter", taRole: "ta_lead" }), true);
});

test("another TA, a client, a stranger or a disabled login do not", () => {
  assert.equal(isScoopSender({ role: "ta" }), false);
  assert.equal(isScoopSender({ role: "recruiter" }), false);
  assert.equal(isScoopSender({ role: "client" }), false);
  assert.equal(isScoopSender(null), false);
  assert.equal(isScoopSender({ role: "director", isActive: false }), false);
  // The explicit taRole wins over the legacy role, as in the app's mapping.
  assert.equal(isScoopSender({ role: "senior_ta", taRole: "ta" }), false);
});

const jobs = [
  { id: "j1", title: "Brand Manager", clientName: "Delmo" },
  { id: "j2", title: "Accountant", clientName: "Hayleys" },
];

test("one open job: the scoop is for it, whatever the subject", () => {
  assert.equal(pickScoopOpening([jobs[0]], "CVs", "")?.id, "j1");
});

test("no open job: nothing to file it on", () => {
  assert.equal(pickScoopOpening([], "Brand Manager CVs", ""), null);
});

test("several jobs: the subject or body names the one", () => {
  assert.equal(pickScoopOpening(jobs, "FW: CVs for brand manager", "")?.id, "j1");
  assert.equal(pickScoopOpening(jobs, "Fwd: two more", "Please check these for the Accountant role")?.id, "j2");
});

test("several jobs and none named: not filed", () => {
  assert.equal(pickScoopOpening(jobs, "CVs", "see attached"), null);
});

test("the longer title wins over one inside it", () => {
  const withSenior = [...jobs, { id: "j3", title: "Senior Brand Manager", clientName: "Delmo" }];
  assert.equal(pickScoopOpening(withSenior, "Senior Brand Manager CVs", "")?.id, "j3");
});

test("the same title at two clients: the client decides, or nothing is filed", () => {
  const twins = [
    { id: "a", title: "Accountant", clientName: "Hayleys" },
    { id: "b", title: "Accountant", clientName: "John Keells" },
  ];
  assert.equal(pickScoopOpening(twins, "Accountant - John Keells", "")?.id, "b");
  assert.equal(pickScoopOpening(twins, "Accountant CVs", ""), null);
});

test("a word inside another word is not a match", () => {
  assert.equal(pickScoopOpening([...jobs, { id: "x", title: "Driver", clientName: null }], "Drivers licence copies", ""), null);
});
