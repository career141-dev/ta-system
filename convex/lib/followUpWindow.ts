// convex/lib/followUpWindow.ts
//
// When the next nudge goes, so that it still lands inside WhatsApp's free
// 24-hour service window.
//
// The bug this fixes (23 September): the scheduler defaulted to exactly 24
// hours, which is the same length as the window a candidate's reply opens. The
// nudge therefore arrived at, or a few seconds after, the moment the window
// shut. Two things went wrong every time:
//
//   1. Free text was no longer allowed, so `whatsappOutbound.sendWhatsApp`
//      fell back to an approved template — a billed message where a free one
//      would have done.
//   2. The template REPLACES the message. Whatever the AI had composed —
//      "thanks, we have your notice period, we still need your expected
//      salary" — was dropped, and the candidate got the generic "we're still
//      looking forward to progressing your application" instead.
//
// One hour of headroom covers the gap between the schedule time, the
// seven-minute sweep that picks it up, and the send itself.
//
// Pure: no Convex imports, so it is tested on its own (tests/followupwindow.test.ts).

/** WhatsApp's customer service window: free-text is allowed this long after the candidate writes. */
export const SERVICE_WINDOW_HOURS = 24;

/** Enough room for the sweep (runs every 7 minutes) to fire before the window shuts. */
export const SWEEP_HEADROOM_HOURS = 1;

/** The latest a WhatsApp nudge may be scheduled and still be free. */
export const MAX_WHATSAPP_NUDGE_HOURS = SERVICE_WINDOW_HOURS - SWEEP_HEADROOM_HOURS; // 23

/**
 * How many hours until the next nudge.
 *
 * `requested` is what the model asked for — a candidate saying "I'll send it
 * tonight" gives a few hours, and that is honoured as-is. Only the fallback
 * and over-long values are pulled inside the window, and only for WhatsApp:
 * email has no such window, so its 24-hour rhythm is left alone.
 */
export function nudgeHoursWithinWindow(
  requested: number | null | undefined,
  channel?: string,
): number {
  const isWhatsApp = channel !== "email";
  const fallback = isWhatsApp ? MAX_WHATSAPP_NUDGE_HOURS : SERVICE_WINDOW_HOURS;

  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  // A candidate's own promise is honoured, up to the window. Past it, the
  // message would cost a template and lose its text, so it goes just inside.
  return isWhatsApp ? Math.min(requested, MAX_WHATSAPP_NUDGE_HOURS) : requested;
}
