// convex/lib/scoopMail.ts
//
// Scoops (the desk, 27 September): the Director, a TA Lead or Ops send CVs for
// a job to a TA. Until 29 September the mail intake read each TA's mailbox for
// them; now the TA uploads them on the opening's Scoops page. What is left is
// kept pure so it can be tested without Graph or a database: who counts as a
// sender, and what an upload writes on the application.

/** The roles whose CVs count as a scoop. Another TA's do not (the desk, 27 Sep). */
const SENDER_ROLES = new Set(["director", "ops", "ta_manager", "senior_ta"]);
const SENDER_TA_ROLES = new Set(["director", "ta_lead", "ops"]);

export function isScoopSender(user: { role?: string | null; taRole?: string | null; isActive?: boolean | null } | null | undefined): boolean {
  if (!user || user.isActive === false) return false;
  // An explicit taRole wins, as in the app's own mapping (src/data/convex/map.ts).
  if (user.taRole) return SENDER_TA_ROLES.has(user.taRole);
  return SENDER_ROLES.has(user.role ?? "");
}

/**
 * What a scoop upload writes on the application (the Scoops page, 29 Sep).
 *
 * The flag is `scoopReceivedAt` (+ `scoopFromUserId` when the TA named the
 * lead): that is what the end-of-day SCOOP column reads. The owner is left
 * alone — the TA's own Shortlist claims the person, gives them a set number and
 * moves them on. A scoop already marked keeps its first date and sender unless
 * the sender was blank and is now given.
 */
export function scoopFlag<Id extends string>(
  app: { scoopReceivedAt?: number | null; scoopFromUserId?: Id | null },
  now: number,
  fromUserId?: Id | null,
): { scoopReceivedAt?: number; scoopFromUserId?: Id } | null {
  const patch: { scoopReceivedAt?: number; scoopFromUserId?: Id } = {};
  if (!app.scoopReceivedAt) patch.scoopReceivedAt = now;
  if (fromUserId && !app.scoopFromUserId) patch.scoopFromUserId = fromUserId;
  return Object.keys(patch).length ? patch : null;
}
