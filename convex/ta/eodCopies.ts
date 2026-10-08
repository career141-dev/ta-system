// convex/ta/eodCopies.ts
//
// A sent end-of-day email is kept for a month so the TA can read it back, and
// correct it and send it again when the TA Lead or a Director asks (8 Oct —
// first a day, then the desk asked for a month of history). Once the month is
// over every version of the email is deleted here. The review round it opened
// stays, with `revisedAt` saying it was resent; only the copies of the email go.
//
// The app hides a copy the moment its month is over (src/data/store.ts
// eodCopies), so this only has to catch up, not be on time.

import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

const BATCH = 200;

/** Delete every copy whose month is over, a batch at a time. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("eodEmailCopies")
      .withIndex("by_expires", (q) => q.lte("expiresAt", Date.now()))
      .take(BATCH);
    for (const c of due) await ctx.db.delete(c._id);
    if (due.length === BATCH) await ctx.scheduler.runAfter(0, internal.ta.eodCopies.purgeExpired, {});
    return { deleted: due.length };
  },
});
