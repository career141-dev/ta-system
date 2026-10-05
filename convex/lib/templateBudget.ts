// convex/lib/templateBudget.ts
//
// How many WhatsApp templates we are willing to pay for in a day, and when the
// first WhatsApp of a follow-up is allowed to go at all.
//
// Why both live here: they are the two levers on the Meta bill, and both are
// off unless a number is configured, so a deployment that has not opted in
// behaves exactly as before.
//
// **Templates are the only WhatsApp we pay for.** Free text inside the
// candidate's 24-hour window is free, so the chase gets cheaper the more the
// candidate talks. The cost is concentrated in the first, cold message — and
// in a bulk send, one bad afternoon can spend a month's budget before anyone
// notices. Hence a cap that fails closed rather than a report that arrives
// after the invoice.
//
// Pure: no Convex imports, so it is tested on its own (tests/templatebudget.test.ts).

/** Midnight UTC for the day containing `now`. The cap is a per-UTC-day count. */
export function startOfUtcDay(now: number): number {
  return Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
}

/**
 * The day's ceiling on billable templates, from the environment.
 *
 * Unset, zero or nonsense means no cap — an existing deployment keeps sending
 * exactly as it did. Opting in is deliberate.
 */
export function dailyTemplateCap(raw: string | undefined): number | null {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Whether another template may be paid for today. */
export function withinTemplateBudget(sentToday: number, cap: number | null): boolean {
  if (cap === null) return true;
  return sentToday < cap;
}

/**
 * How long to hold the first WhatsApp back while email has a chance.
 *
 * Day 0 used to send the WhatsApp template AND the email together, so every
 * candidate cost a template even when the email alone would have done. With
 * this set, Day 0 is email only and the first WhatsApp waits — and a candidate
 * who answers the email never costs a template at all, because the reply opens
 * the free window and the conversation carries on there.
 *
 * Only honoured when there is an email to send; a candidate with a phone and
 * no email still gets WhatsApp immediately, or they would hear nothing.
 */
export function emailFirstDelayMs(days: number | null | undefined, hasEmail: boolean): number | null {
  if (!hasEmail) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 24 * 60 * 60 * 1000);
}
