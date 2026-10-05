/**
 * What the follow-up costs, and why the estimate on the table was wrong.
 *
 * That estimate was "$500/month = 10,000 candidates × 2 templates × $0.025".
 * Each input was a guess: the rate was Meta's Marketing rate, the 2 templates
 * ignored that a candidate who replies only costs the first, and the 10,000
 * was the whole database rather than the people a TA actually shortlists
 * (2 October).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_CONVERSATION_LIMIT,
  META_MARKETING_RATE_USD,
  META_UTILITY_RATE_USD,
  forecastTemplates,
  monthlyCeiling,
} from "../convex/lib/templateForecast";

test("a candidate who replies costs one template, not three", () => {
  // The reply opens the free 24-hour window, so everything after it is free.
  const all = forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: 1 });
  assert.equal(all.templates, 100);
  const none = forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: 0 });
  assert.equal(none.templates, 300);
});

test("a mixed reply rate lands between the two", () => {
  // 30 reply (1 each) + 70 silent (3 each) = 240.
  const f = forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: 0.3 });
  assert.equal(f.templates, 240);
  assert.equal(f.utilityCostUsd, 2.71); // 240 × 0.0113
});

test("the Utility rate is the one that applies, and Marketing is 7.5x it", () => {
  assert.equal(META_UTILITY_RATE_USD, 0.0113);
  assert.equal(META_MARKETING_RATE_USD, 0.0842);
  const f = forecastTemplates({ candidates: 10_000, maxAttempts: 1, replyRate: 1 });
  assert.equal(f.templates, 10_000);
  assert.equal(f.utilityCostUsd, 113);
  assert.equal(f.marketingCostUsd, 842, "reclassification is the real cost risk");
});

test("the original $500 estimate cannot be reproduced at the real rate", () => {
  // 10,000 candidates, every reminder, nobody replying — the worst case.
  const worst = forecastTemplates({ candidates: 10_000, maxAttempts: 3, replyRate: 0 });
  assert.equal(worst.templates, 30_000);
  assert.equal(worst.utilityCostUsd, 339);
  assert.ok(worst.utilityCostUsd < 500, "even the worst case is below the estimate");
});

test("Meta's limit, not the budget, sets how long a batch takes", () => {
  const one = forecastTemplates({ candidates: 10_000, maxAttempts: 1, replyRate: 1, numbers: 1 });
  assert.equal(one.daysToSend, 40, "10,000 ÷ 250 per day");
  const five = forecastTemplates({ candidates: 10_000, maxAttempts: 1, replyRate: 1, numbers: 5 });
  assert.equal(five.daysToSend, 8, "five numbers clear it five times faster, at the same cost");
  assert.equal(five.utilityCostUsd, one.utilityCostUsd);
});

test("the monthly ceiling is the limit times the numbers", () => {
  assert.equal(DAILY_CONVERSATION_LIMIT, 250);
  const one = monthlyCeiling(1);
  assert.equal(one.templates, 7_500);
  assert.equal(one.utilityCostUsd, 84.75, "the most one number can bill in a month");
  assert.equal(monthlyCeiling(5).templates, 37_500);
});

test("nothing in, nothing out", () => {
  const f = forecastTemplates({ candidates: 0 });
  assert.equal(f.templates, 0);
  assert.equal(f.utilityCostUsd, 0);
  assert.equal(f.daysToSend, 0, "an empty queue takes no days, not one");
});

test("nonsense inputs are clamped rather than producing a nonsense bill", () => {
  const negative = forecastTemplates({ candidates: -500 });
  assert.equal(negative.templates, 0);
  // A reply rate outside 0–1, or a NaN, must not invert the arithmetic.
  assert.equal(forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: 2 }).templates, 100);
  assert.equal(forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: -1 }).templates, 300);
  assert.equal(forecastTemplates({ candidates: 100, maxAttempts: 3, replyRate: Number.NaN }).templates, 300);
  assert.ok(forecastTemplates({ candidates: 100, numbers: 0 }).daysToSend > 0, "zero numbers must not divide by zero");
});
