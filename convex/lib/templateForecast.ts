// convex/lib/templateForecast.ts
//
// What the WhatsApp follow-up will actually cost, from how many candidates go
// into it rather than from how many candidates exist.
//
// Written because every figure in the cost discussion was an assumption
// (2 October). The estimate on the table said $500/month for WhatsApp, built
// from "10,000 candidates × 2 templates × $0.025". All three inputs were
// guesses: the rate was the Marketing one, the 2 templates ignored that a
// candidate who replies costs only the first, and the 10,000 was the whole
// database rather than the people a TA actually shortlists.
//
// Only shortlisting costs money. 78,000 candidates sitting in the database
// cost nothing.
//
// Pure: no Convex imports, so it is tested on its own
// (tests/templateforecast.test.ts).

/**
 * Meta's USD rate card, "Rest of Asia Pacific", effective 1 October 2026.
 * Sri Lanka has no standalone rate and is mapped to that region.
 *
 * Marketing is here for one reason: it is 7.5× Utility, so a template
 * reclassified by Meta is the one thing that would really change the bill.
 */
export const META_UTILITY_RATE_USD = 0.0113;
export const META_MARKETING_RATE_USD = 0.0842;

/** Business-initiated conversations per rolling 24 hours, per number, at the current tier. */
export const DAILY_CONVERSATION_LIMIT = 250;

export type Forecast = {
  /** Billable templates. A candidate who replies costs one; a silent one costs every attempt. */
  templates: number;
  utilityCostUsd: number;
  /** The same volume if Meta reclassified the templates. */
  marketingCostUsd: number;
  /** Working days to clear the queue, given Meta's limit and how many numbers are wired up. */
  daysToSend: number;
};

/**
 * Templates and cost for a batch of candidates.
 *
 * `replyRate` is the fraction who answer the first message. They cost one
 * template, because their reply opens the free 24-hour window and everything
 * after it is free. The rest cost `maxAttempts`, one per reminder.
 *
 * `numbers` is how many TA numbers are wired up: Meta's limit is per number,
 * so five numbers clear the queue five times faster at identical cost.
 */
export function forecastTemplates(input: {
  candidates: number;
  maxAttempts?: number;
  replyRate?: number;
  numbers?: number;
}): Forecast {
  const candidates = Math.max(0, Math.floor(input.candidates || 0));
  const attempts = clamp(input.maxAttempts ?? 3, 1, 10);
  const replyRate = clamp(input.replyRate ?? 0.3, 0, 1);
  const numbers = Math.max(1, Math.floor(input.numbers ?? 1));

  const repliers = candidates * replyRate;
  const silent = candidates - repliers;
  const templates = round2(repliers * 1 + silent * attempts);

  const perDay = DAILY_CONVERSATION_LIMIT * numbers;

  return {
    templates,
    utilityCostUsd: round2(templates * META_UTILITY_RATE_USD),
    marketingCostUsd: round2(templates * META_MARKETING_RATE_USD),
    daysToSend: templates === 0 ? 0 : Math.ceil(templates / perDay),
  };
}

/**
 * The most Meta will let through in a month, whatever the budget says.
 *
 * The limit, not the price, is what actually caps this: on one number no
 * amount of money buys more than this many templates.
 */
export function monthlyCeiling(numbers = 1, days = 30): { templates: number; utilityCostUsd: number } {
  const templates = DAILY_CONVERSATION_LIMIT * Math.max(1, Math.floor(numbers)) * days;
  return { templates, utilityCostUsd: round2(templates * META_UTILITY_RATE_USD) };
}

const clamp = (n: number, lo: number, hi: number) =>
  !Number.isFinite(n) ? lo : Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
