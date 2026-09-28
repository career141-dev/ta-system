// src/lib/bin.ts
//
// The Bin's clock, shared by the backend (convex/ta/bin.ts) and the screens.
//
// Pressing Delete on a client or an opening used to remove it for good at
// once. From 28 Sep it goes to the Bin instead: hidden everywhere, kept whole
// for seven days so a mistaken delete can be restored, then removed by the
// daily clean-up.

export const BIN_DAYS = 7;
const DAY_MS = 86_400_000;
export const BIN_MS = BIN_DAYS * DAY_MS;

/** Anything with the bin's or the old delete's stamp has left the desk. */
export function isGone(row: { binnedAt?: number | null; deletingAt?: number | null }): boolean {
  return !!(row.binnedAt || row.deletingAt);
}

/** When the daily clean-up removes it for good. */
export function purgeAt(binnedAt: number): number {
  return binnedAt + BIN_MS;
}

export function isDueForPurge(binnedAt: number, now: number): boolean {
  return now >= purgeAt(binnedAt);
}

/** Whole days left, rounded up, so "1 day left" holds until the last moment. */
export function daysLeft(binnedAt: number, now: number): number {
  return Math.max(0, Math.ceil((purgeAt(binnedAt) - now) / DAY_MS));
}

/** "5 Oct" — the date the delete message and the Bin page both show. */
export function purgeDateLabel(binnedAt: number): string {
  return new Date(purgeAt(binnedAt)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Colombo",
  });
}
