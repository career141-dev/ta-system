// convex/lib/extractionQueue.ts — who reads a CV next (26 Oct).
//
// CV reading may hold only a few of the backend's action slots (6 Oct). A run
// over the limit used to reschedule itself every 4–6 seconds. With 800 CVs
// uploaded at once that was ~160 throw-away actions a second fighting the real
// readings for the same slots, and the count of readings in progress looked at
// only the newest 500 scheduled functions — which the reschedules filled within
// seconds, so the limit read as free and was not held either. One CV took 20–25
// minutes to come out of that. Now a CV over the limit waits in a table, in the
// order it arrived, and a reading that ends hands its slot to the oldest one.

/** The most CV readings in progress at once. */
export const MAX_CONCURRENT_EXTRACTIONS = 3;

/*
 * Background work — the two-minute queue, failed-CV retries, the healer, mail
 * and WhatsApp intake — may hold only this many (26 Oct). One line for all of
 * it put a TA's single HH upload behind whatever the background had queued:
 * "Waiting for a CV reader" for minutes before DeepSeek was even called. The
 * slot left over is always free for a CV a TA is watching.
 */
export const BACKGROUND_SLOTS = MAX_CONCURRENT_EXTRACTIONS - 1;

/**
 * A slot whose reading has neither finished nor let go for this long is
 * taken back. A reading stops itself at 210s and the runtime kills an action
 * well before this, so a live reading never loses its slot.
 */
export const EXTRACTION_LEASE_MS = 10 * 60_000;

/**
 * Of the slots held now, which have lapsed (their reading died without letting
 * go), how many CVs may start, and how many of those may be background work.
 * Urgent CVs (a TA's own upload) are started first, from `free`.
 */
export function planTurns<T extends { startedAt?: number; urgent?: boolean }>(
  held: T[],
  now: number,
  max = MAX_CONCURRENT_EXTRACTIONS,
  background = BACKGROUND_SLOTS,
): { lapsed: T[]; free: number; backgroundFree: number } {
  const lapsed = held.filter((h) => h.startedAt !== undefined && now - h.startedAt > EXTRACTION_LEASE_MS);
  const live = held.filter((h) => !lapsed.includes(h));
  const free = Math.max(0, max - live.length);
  const liveBackground = live.filter((h) => !h.urgent).length;
  return { lapsed, free, backgroundFree: Math.min(free, Math.max(0, background - liveBackground)) };
}

/** Is this upload one a TA is waiting on, on screen? */
export function isUrgentUpload(upload: { headhuntedBy?: unknown; scoopedBy?: unknown } | null | undefined): boolean {
  return !!(upload?.headhuntedBy || upload?.scoopedBy);
}
