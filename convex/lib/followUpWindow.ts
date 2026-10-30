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

// ── Pacing: answer like a person, not a machine (30 Oct) ─────────────────────

/**
 * How long the assistant waits after a WhatsApp message before answering.
 * People write in bursts — "hi", "salary 120k", "notice 1 month" — and each
 * line got its own answer. Every message now waits this long; only the last
 * one of a burst answers, reading them all together.
 */
export const REPLY_PAUSE_MS = 30_000;

/** Assistant replies to one candidate in one Colombo day before a TA takes over. */
export const MAX_BOT_REPLIES_PER_DAY = 8;

const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Reminders go out 08:00–20:00 Sri Lanka time, never at night. */
export function inSendingHours(at: number): boolean {
  const hour = new Date(at + COLOMBO_OFFSET_MS).getUTCHours();
  return hour >= 8 && hour < 20;
}

/**
 * The candidate's messages that one turn should answer, oldest first: those
 * after our last WhatsApp to them. Null when a newer message is still
 * waiting its own pause — that one answers the whole burst instead.
 *
 * `recent` is newest first, as read from the index.
 */
export function burstToAnswer(
  recent: { direction: string; channel: string; body?: string | null; sentAt: number | string }[],
  inboundAt: number,
): string | null {
  const whatsapp = recent.filter((m) => m.channel === "whatsapp");
  const newest = whatsapp.find((m) => m.direction === "inbound");
  if (newest && Number(newest.sentAt) > inboundAt) return null;
  const lines: string[] = [];
  for (const m of whatsapp) {
    if (m.direction !== "inbound") break;
    if (m.body?.trim()) lines.unshift(m.body.trim());
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * Our own message coming back. The webhook can deliver a copy of what we just
 * sent (echoes, a second app on the account); answering it starts a loop.
 */
export function isEchoOfOurs(text: string, lastOutbound: { body?: string | null; sentAt: number | string } | null, now: number): boolean {
  if (!lastOutbound?.body) return false;
  return now - Number(lastOutbound.sentAt) < 10 * 60_000 && lastOutbound.body.trim() === text.trim();
}
