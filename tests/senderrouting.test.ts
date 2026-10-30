import assert from "node:assert/strict";
import test from "node:test";
import { isNumberLevelError, numberReadiness, pickSender, type SenderNumber } from "../convex/lib/senderRouting";

const MAIN = { phone: "+94742197476", phoneId: "965783109962872" };
const thushini: SenderNumber = { phone: "+94779077728", phoneId: "1147756625098092", userId: "u_thushini", ready: true };
const hassanOff: SenderNumber = { phone: "+94740110140", phoneId: "1276466655555760", userId: "u_hassan", ready: false };
const numbers = [MAIN, thushini, hassanOff];

test("the candidate's owner TA's ready number sends, before the opening's channel line", () => {
  const p = pickSender({ ownerTaId: "u_thushini", assignedTaIds: ["u_hassan"], channelNumber: "0742197476", numbers });
  assert.equal(p?.phoneId, thushini.phoneId);
});

test("no owner yet: the opening's first assigned TA's number", () => {
  assert.equal(pickSender({ assignedTaIds: ["u_thushini", "u_hassan"], numbers })?.phoneId, thushini.phoneId);
});

test("a TA number that is not ready falls back to the channel line, then to the main line (null)", () => {
  assert.equal(pickSender({ ownerTaId: "u_hassan", channelNumber: "+94 74 219 7476", numbers })?.phoneId, MAIN.phoneId);
  assert.equal(pickSender({ ownerTaId: "u_hassan", numbers }), null);
  assert.equal(pickSender({ ownerTaId: "u_nobody", numbers }), null);
});

test("a number typed on the opening wins, unless it is known not ready; rows from before 30 Oct still send", () => {
  assert.equal(pickSender({ override: "077 907 7728", ownerTaId: "u_hassan", numbers })?.phoneId, thushini.phoneId);
  assert.equal(pickSender({ override: "+94740110140", numbers }), null);
  assert.equal(pickSender({ override: "0742197476", ownerTaId: "u_thushini", numbers })?.phoneId, MAIN.phoneId);
  // A legacy row tied to a TA but never checked does not send for that TA.
  assert.equal(pickSender({ ownerTaId: "u_x", numbers: [{ ...MAIN, userId: "u_x" }] }), null);
});

test("only errors about the number or its account switch a TA number off", () => {
  assert.equal(isNumberLevelError('HTTP 400: {"error":{"message":"Payment","code":131042}}'), true);
  assert.equal(isNumberLevelError('HTTP 404: {"error":{"code":132001,"message":"template"}}'), true);
  assert.equal(isNumberLevelError('HTTP 401: {"error":{"type":"OAuthException","code":190}}'), true);
  assert.equal(isNumberLevelError('HTTP 400: {"error":{"code":100,"message":"Invalid parameter"}}'), false);
  assert.equal(isNumberLevelError('HTTP 400: {"error":{"code":131026,"message":"Message undeliverable"}}'), false);
});

const approved = [
  { name: "career141_initial_outreach", status: "APPROVED" },
  { name: "career141_followup_reminder", status: "APPROVED" },
];

test("ready only when connected on the Cloud API, both templates approved and replies subscribed", () => {
  const ok = numberReadiness("+94779077728", {
    phone: { status: "CONNECTED", platform_type: "CLOUD_API", display_phone_number: "+94 77 907 7728" },
    templates: approved,
    subscribedApps: [{ whatsapp_business_api_data: {} }],
  });
  assert.equal(ok.ready, true);

  const linkedOnly = numberReadiness("+94779077728", {
    phone: { status: "CONNECTED", platform_type: "NOT_APPLICABLE", display_phone_number: "+94 77 907 7728" },
    templates: [{ name: "career141_initial_outreach", status: "PENDING" }],
    subscribedApps: [],
  });
  assert.equal(linkedOnly.ready, false);
  assert.match(linkedOnly.note, /not connected to the Cloud API/);
  assert.match(linkedOnly.note, /career141_initial_outreach is pending/);
  assert.match(linkedOnly.note, /career141_followup_reminder is missing/);
  assert.match(linkedOnly.note, /no app subscribed/);

  const noAccess = numberReadiness("+94779077728", { phone: "Unsupported get request", templates: "x", subscribedApps: "y" });
  assert.equal(noAccess.ready, false);
  assert.match(noAccess.note, /API user cannot reach this number/);
});
