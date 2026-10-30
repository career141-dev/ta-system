/**
 * The nudge must land INSIDE WhatsApp's free 24-hour window.
 *
 * The bug: the scheduler defaulted to exactly 24 hours, the same length as the
 * window. Every nudge arrived as the window shut, so it went as a billed
 * template AND the template replaced whatever the AI had written — the
 * candidate got "we're still looking forward to progressing your application"
 * instead of "we have your notice period, we still need your expected salary".
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WHATSAPP_NUDGE_HOURS,
  SERVICE_WINDOW_HOURS,
  nudgeHoursWithinWindow,
  burstToAnswer,
  inSendingHours,
  isEchoOfOurs,
} from "../convex/lib/followUpWindow";

test("the WhatsApp default lands inside the free window, not on its edge", () => {
  const hours = nudgeHoursWithinWindow(null, "whatsapp");
  assert.equal(hours, MAX_WHATSAPP_NUDGE_HOURS);
  assert.ok(hours < SERVICE_WINDOW_HOURS, "a 24h default is exactly the bug this prevents");
});

test("an absent channel is treated as WhatsApp", () => {
  // inboundExtraction passes args.channel through, which is optional.
  assert.equal(nudgeHoursWithinWindow(null, undefined), MAX_WHATSAPP_NUDGE_HOURS);
  assert.equal(nudgeHoursWithinWindow(undefined, undefined), MAX_WHATSAPP_NUDGE_HOURS);
});

test("a candidate's own promise is honoured when it fits", () => {
  // "I'll send it in two hours" must not be stretched to 23.
  assert.equal(nudgeHoursWithinWindow(2, "whatsapp"), 2);
  assert.equal(nudgeHoursWithinWindow(0.167, "whatsapp"), 0.167);
  assert.equal(nudgeHoursWithinWindow(22.9, "whatsapp"), 22.9);
});

test("a promise beyond the window is pulled just inside it", () => {
  assert.equal(nudgeHoursWithinWindow(24, "whatsapp"), MAX_WHATSAPP_NUDGE_HOURS);
  assert.equal(nudgeHoursWithinWindow(72, "whatsapp"), MAX_WHATSAPP_NUDGE_HOURS);
});

test("email has no 24-hour window and keeps its own rhythm", () => {
  assert.equal(nudgeHoursWithinWindow(null, "email"), SERVICE_WINDOW_HOURS);
  assert.equal(nudgeHoursWithinWindow(72, "email"), 72, "email must not be clamped");
});

test("nonsense from the model falls back rather than scheduling in the past", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    const hours = nudgeHoursWithinWindow(bad as number | null, "whatsapp");
    assert.equal(hours, MAX_WHATSAPP_NUDGE_HOURS, `${String(bad)} should fall back`);
    assert.ok(hours > 0, "a nudge scheduled at or before now fires immediately, forever");
  }
});

// ── Pacing (30 Oct): one reply to a burst, no night reminders, no echoes ────

const msg = (direction: string, body: string, sentAt: number, channel = "whatsapp") => ({ direction, channel, body, sentAt });

test("a burst of three messages is answered once, reading all three", () => {
  // Newest first, as the index returns them.
  const recent = [msg("inbound", "notice 1 month", 300), msg("inbound", "salary 120k", 200), msg("inbound", "hi", 100), msg("outbound", "Hi Nimal, could you share…", 50)];
  assert.equal(burstToAnswer(recent, 100), null, "the first message's turn leaves it to the last");
  assert.equal(burstToAnswer(recent, 200), null);
  assert.equal(burstToAnswer(recent, 300), ["hi", "salary 120k", "notice 1 month"].join("\n"));
});

test("only what came after our last message is answered again", () => {
  const recent = [msg("inbound", "ok", 400), msg("outbound", "Thanks, noted.", 350), msg("inbound", "salary 120k", 200)];
  assert.equal(burstToAnswer(recent, 400), "ok");
});

test("an email in between does not split a WhatsApp burst", () => {
  const recent = [msg("inbound", "two", 300), msg("outbound", "email reply", 250, "email"), msg("inbound", "one", 200), msg("outbound", "question", 100)];
  assert.equal(burstToAnswer(recent, 300), ["one", "two"].join("\n"));
});

test("reminders go 08:00 to 20:00 Sri Lanka time only", () => {
  const colombo = (h: number, m = 0) => Date.UTC(2026, 9, 30, h, m) - 5.5 * 3600_000;
  assert.equal(inSendingHours(colombo(7, 59)), false);
  assert.equal(inSendingHours(colombo(8, 0)), true);
  assert.equal(inSendingHours(colombo(19, 59)), true);
  assert.equal(inSendingHours(colombo(20, 0)), false);
  assert.equal(inSendingHours(colombo(23, 30)), false);
});

test("our own message coming back is an echo; the candidate's words are not", () => {
  const now = 1_000_000;
  const ours = { body: "Thank you! We have recorded your update.", sentAt: now - 60_000 };
  assert.equal(isEchoOfOurs("Thank you! We have recorded your update.", ours, now), true);
  assert.equal(isEchoOfOurs("thank you", ours, now), false);
  assert.equal(isEchoOfOurs("Thank you! We have recorded your update.", { ...ours, sentAt: now - 60 * 60_000 }, now), false, "an hour later it is the candidate quoting us");
  assert.equal(isEchoOfOurs("hi", null, now), false);
});
