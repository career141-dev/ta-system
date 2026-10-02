import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

export const runBackfill = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    return await ctx.runMutation(internal.admin.ioPerformanceMigrations.backfillCandidateSummaries, {});
  }
});
