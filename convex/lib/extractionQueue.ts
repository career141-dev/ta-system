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

/**
 * A slot whose reading has neither finished nor let go for this long is
 * taken back. A reading stops itself at 210s and the runtime kills an action
 * well before this, so a live reading never loses its slot.
 */
export const EXTRACTION_LEASE_MS = 10 * 60_000;

/**
 * Of the slots held now, which have lapsed (their reading died without letting
 * go) and how many CVs may start.
 */
export function planTurns<T extends { startedAt?: number }>(
  held: T[],
  now: number,
  max = MAX_CONCURRENT_EXTRACTIONS,
): { lapsed: T[]; free: number } {
  const lapsed = held.filter((h) => h.startedAt !== undefined && now - h.startedAt > EXTRACTION_LEASE_MS);
  const live = held.length - lapsed.length;
  return { lapsed, free: Math.max(0, max - live) };
}
