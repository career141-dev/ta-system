// convex/ta/storage.ts
//
// Whether file storage can be used here, asked without trying to use it.

import { v } from "convex/values";
import { query } from "../_generated/server";

/**
 * True when every setting the R2 client needs is present.
 *
 * The profile used to find out by asking storage/r2:generateDownloadUrl to
 * sign a link and catching the failure — which the backend logs as an uncaught
 * error ("No value provided for input HTTP label: Bucket") on every profile
 * view of a deployment without R2. This reads the same four settings and
 * answers; it reveals nothing about their values.
 */
export const r2Configured = query({
  args: {},
  handler: async () =>
    Boolean(
      process.env.R2_BUCKET_NAME &&
        process.env.R2_ENDPOINT &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY,
    ),
});

/**
 * Whether this deployment is safe to test on: scheduled jobs off (so nothing
 * polls live mailboxes or chases candidates on its own) and outbound locked (so
 * nothing reaches a real person). The TA app checks this before its first read
 * — see src/lib/safety.ts.
 */
export const safetyState = query({
  args: {},
  handler: async () => ({
    cronsDisabled: process.env.C141_DISABLE_CRONS === "true",
    outboundLocked: process.env.C141_OUTBOUND_LOCK === "true",
  }),
});

/**
 * Rows in one page of a table — for scripts/db-baseline.ts, which counts every
 * table before and after a test phase. Convex keeps no row counts, and a whole
 * table cannot be read in one execution, so it is counted a page at a time.
 */
export const countPage = query({
  args: { table: v.string(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query(args.table as never)
      .paginate({ cursor: args.cursor ?? null, numItems: 1000 });
    return { count: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
