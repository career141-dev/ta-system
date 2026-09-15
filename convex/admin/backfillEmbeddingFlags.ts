import { mutation, action } from "../_generated/server";
import { api } from "../_generated/api";
import { v } from "convex/values";

export const backfillEmbeddingFlags = mutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("candidateResumes").paginate({
      numItems: 100,
      cursor: args.cursor ?? null,
    });
    
    let count = 0;
    for (const r of page.page) {
      const hasEmb = !!(r.embedding && r.embedding.length > 0);
      if (r.hasEmbedding === undefined || r.hasEmbedding !== hasEmb) {
        await ctx.db.patch(r._id, { hasEmbedding: hasEmb });
        count++;
      }
    }
    
    return {
      processed: page.page.length,
      backfilled: count,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  }
});

export const runAllBackfillFlags = action({
  args: {},
  handler: async (ctx) => {
    let cursor: string | undefined = undefined;
    let isDone = false;
    let totalProcessed = 0;
    let totalBackfilled = 0;

    while (!isDone) {
      const result: { processed: number; backfilled: number; continueCursor: string; isDone: boolean } = await ctx.runMutation(api.admin.backfillEmbeddingFlags.backfillEmbeddingFlags, {
        cursor,
      });
      totalProcessed += result.processed;
      totalBackfilled += result.backfilled;
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    return {
      totalProcessed,
      totalBackfilled,
      complete: true,
    };
  },
});
