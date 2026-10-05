/**
 * The two levers on the Meta bill.
 *
 * Templates are the only WhatsApp we pay for — free text inside the
 * candidate's 24-hour window is free — so the cost sits in the first, cold
 * message. A bulk send can spend a month's budget in an afternoon and the
 * invoice arrives long afterwards, so the cap refuses rather than reports.
 *
 * Both are off unless configured: a deployment that has not opted in must send
 * exactly as it did before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyTemplateCap,
  emailFirstDelayMs,
  startOfUtcDay,
  withinTemplateBudget,
} from "../convex/lib/templateBudget";

test("no cap unless one is configured", () => {
  for (const raw of [undefined, "", "   ", "0", "-5", "abc", "NaN"]) {
    assert.equal(dailyTemplateCap(raw), null, `${String(raw)} must mean no cap`);
  }
});

test("a configured cap is read as a whole number", () => {
  assert.equal(dailyTemplateCap("500"), 500);
  assert.equal(dailyTemplateCap(" 250 "), 250);
  assert.equal(dailyTemplateCap("99.7"), 99, "a fraction of a message cannot be sent");
});

test("with no cap, everything is within budget", () => {
  assert.equal(withinTemplateBudget(0, null), true);
  assert.equal(withinTemplateBudget(1_000_000, null), true);
});

test("the cap is a ceiling, not a threshold", () => {
  assert.equal(withinTemplateBudget(0, 3), true);
  assert.equal(withinTemplateBudget(2, 3), true, "the third message is still allowed");
  assert.equal(withinTemplateBudget(3, 3), false, "the fourth is not");
  assert.equal(withinTemplateBudget(9, 3), false, "nor is anything past it");
});

test("the day boundary is midnight UTC and does not drift", () => {
  const midday = Date.UTC(2026, 9, 2, 12, 30, 45, 123);
  const start = startOfUtcDay(midday);
  assert.equal(new Date(start).toISOString(), "2026-10-02T00:00:00.000Z");
  // Any moment in the same UTC day maps to the same start, so the count is stable.
  assert.equal(startOfUtcDay(Date.UTC(2026, 9, 2, 0, 0, 0)), start);
  assert.equal(startOfUtcDay(Date.UTC(2026, 9, 2, 23, 59, 59, 999)), start);
  // And the next day is a different bucket.
  assert.notEqual(startOfUtcDay(Date.UTC(2026, 9, 3, 0, 0, 0)), start);
});

test("email first only applies when there is an email to send", () => {
  assert.equal(emailFirstDelayMs(2, false), null, "no email means WhatsApp must go now");
  assert.equal(emailFirstDelayMs(2, true), 2 * 24 * 60 * 60 * 1000);
});

test("email first is off unless the opening sets it", () => {
  for (const days of [undefined, null, 0, -1, Number.NaN]) {
    assert.equal(
      emailFirstDelayMs(days as number, true),
      null,
      `${String(days)} must keep the old same-day behaviour`,
    );
  }
});

test("a fractional delay is allowed, for a half-day gap", () => {
  assert.equal(emailFirstDelayMs(0.5, true), 12 * 60 * 60 * 1000);
});
