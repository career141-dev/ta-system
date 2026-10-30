/**
 * Who has the conversation, the assistant or a person (30 Oct), and how the
 * assistant reads a conversation a TA has been part of.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { assistantQuietReason, historyLine } from "../convex/lib/assistantControl";

test("the assistant answers only when nobody has taken over and nothing waits for a TA", () => {
  assert.equal(assistantQuietReason({}), null);
  assert.equal(assistantQuietReason(null), null);
  assert.match(assistantQuietReason({ taTookOverAt: 1 }) ?? "", /taken over/);
  assert.match(assistantQuietReason({ flaggedForTaReview: true, taReviewReason: "upset" }) ?? "", /Waiting for a TA: upset/);
  assert.equal(assistantQuietReason({ flaggedForTaReview: false, taTookOverAt: undefined }), null);
});

test("the history tells the candidate, the assistant and a TA apart", () => {
  assert.equal(historyLine({ direction: "inbound", channel: "whatsapp", body: "salary 120k" }), "[Candidate] salary 120k");
  assert.equal(historyLine({ direction: "outbound", channel: "whatsapp", body: "Noted!", senderAgent: "system" }), "[Assistant] Noted!");
  assert.equal(historyLine({ direction: "outbound", channel: "whatsapp", body: "I'll call you at 4", senderAgent: "ta" }), "[TA (a person on our team)] I'll call you at 4");
  assert.equal(historyLine({ direction: "outbound", channel: "email", subject: "Your application", body: "Hi" }), "[Assistant (email: Your application)] Hi");
});

const read = (p: string) => fs.readFileSync(p, "utf8");

test("every path honours a take-over", () => {
  const webhook = read("convex/communications/whatchimp.ts");
  assert.ok(webhook.includes("message_echoes") && webhook.includes("recordTaPhoneMessage"), "the TA's phone replies are not received");
  assert.ok(webhook.includes('message.type === "audio"') && webhook.includes("recordVoiceNote"), "voice notes are dropped");
  const crons = read("convex/crons.ts");
  assert.ok(crons.includes('q.eq(q.field("taTookOverAt"), undefined)'), "the sweep reads taken-over rows");
  assert.ok(crons.includes('if (typeof app.taTookOverAt === "number") continue;'), "the sweep reminds a taken-over candidate");
  const extraction = read("convex/communications/inboundExtraction.ts");
  assert.ok(extraction.includes("const quiet = assistantQuietReason(activeApp);"));
  assert.ok(extraction.includes(".map((m) => historyLine(m))"), "the model cannot tell a TA's words from its own");
  const followUp = read("convex/ta/followUp.ts");
  assert.ok(followUp.includes("export const takeOver") && followUp.includes("export const handBack"));
  assert.ok(read("src/components/LiveFollowUp.tsx").includes("Hand back to the assistant"));
});
