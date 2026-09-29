/**
 * Scoops (the desk, 27 Sep; uploaded on the opening's Scoops page since 29 Sep):
 * CVs the Director, a TA Lead or Ops send a TA are counted on their end-of-day
 * SCOOP. Another TA's CVs are not a scoop.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isScoopSender, scoopFlag } from "../convex/lib/scoopMail";

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

test("an upload flags the scoop with today's date and the lead who sent it", () => {
  assert.deepEqual(scoopFlag({}, 1000, "lead1"), { scoopReceivedAt: 1000, scoopFromUserId: "lead1" });
});

test("the sender is optional", () => {
  assert.deepEqual(scoopFlag({}, 1000, null), { scoopReceivedAt: 1000 });
});

test("a scoop already marked keeps its first date and sender", () => {
  assert.equal(scoopFlag({ scoopReceivedAt: 500, scoopFromUserId: "lead1" }, 1000, "lead2"), null);
});

test("a scoop uploaded again names the sender it was missing, keeping its date", () => {
  assert.deepEqual(scoopFlag({ scoopReceivedAt: 500 }, 1000, "lead1"), { scoopFromUserId: "lead1" });
});
