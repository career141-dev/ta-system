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
