import { internalMutation, mutation } from "../_generated/server";
import { calculateNvidiaCredits } from "../stats/stats";

/**
 * Backfills token log statistics:
 * 1. Populates missing `sourceChannel` on existing `nvidiaTokenLogs` by looking up linked `cvUploads`.
 * 2. Rebuilds `tokenStatsCache` singleton and `dailyTokenStats` rows from raw logs.
 */
export const backfillCandidateExtractionModelPublic = mutation({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("nvidiaTokenLogs").order("desc").take(500);
    const deepseekLogs = logs.filter((l) =>
      (l.model || "").toLowerCase().includes("deepseek") &&
      l.taskType === "cv_structuring" &&
      l.success === true
    );

    let candidatesPatched = 0;
    const patchedCandidateIds = new Set<string>();

    for (const log of deepseekLogs) {
      if (log.cvUploadId) {
        const cv: any = await ctx.db.get(log.cvUploadId);
        if (cv && cv.candidateId) {
          const candidate: any = await ctx.db.get(cv.candidateId);
          if (candidate && !candidate.extractionModel) {
            await ctx.db.patch(candidate._id, {
              extractionModel: "deepseek/deepseek-v4-flash",
            });
            candidatesPatched++;
            patchedCandidateIds.add(candidate._id);
          }
        }
      }
    }

    return {
      success: true,
      deepseekLogsInspected: deepseekLogs.length,
      candidatesPatched,
      patchedCandidateIdsCount: patchedCandidateIds.size,
    };
  },
});

export const backfillTokenCachePublic = mutation({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("nvidiaTokenLogs").collect();

    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCredits = 0;
    let successfulCalls = 0;
    let totalCvExtractionsCount = 0;
    let cvExtractionCredits = 0;
    const taskBreakdown: Record<string, { tokens: number; credits: number; count: number }> = {};
    const dailyMap: Record<string, { totalCost: number; cvExtractionCost: number }> = {};

    let denormalizedCount = 0;

    for (const log of logs) {
      // Populates sourceChannel if missing
      if (!log.sourceChannel && log.cvUploadId) {
        const cv = await ctx.db.get(log.cvUploadId);
        if (cv && cv.source) {
          await ctx.db.patch(log._id, { sourceChannel: cv.source, fileName: cv.fileName });
          denormalizedCount++;
        }
      }

      const cost = calculateNvidiaCredits(log.model, log.promptTokens, log.completionTokens);

      totalTokens += log.totalTokens;
      totalPromptTokens += log.promptTokens;
      totalCompletionTokens += log.completionTokens;
      totalCredits += cost;
      if (log.success) successfulCalls++;
      if (log.taskType === "cv_structuring" && log.success) {
        totalCvExtractionsCount++;
        cvExtractionCredits += cost;
      }
      if (!taskBreakdown[log.taskType]) {
        taskBreakdown[log.taskType] = { tokens: 0, credits: 0, count: 0 };
      }
      taskBreakdown[log.taskType].tokens += log.totalTokens;
      taskBreakdown[log.taskType].credits += cost;
      taskBreakdown[log.taskType].count += 1;

      const dateStr = new Date(log.timestamp).toISOString().split("T")[0];
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { totalCost: 0, cvExtractionCost: 0 };
      dailyMap[dateStr].totalCost += cost;
      if (log.taskType === "cv_structuring") dailyMap[dateStr].cvExtractionCost += cost;
    }

    // Upsert the singleton
    const existing = await ctx.db
      .query("tokenStatsCache")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_token_stats"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        totalTokens, totalPromptTokens, totalCompletionTokens, totalCredits,
        successfulCalls, totalRequests: logs.length,
        totalCvExtractionsCount, cvExtractionCredits, taskBreakdown,
      });
    } else {
      await ctx.db.insert("tokenStatsCache", {
        singletonKey: "global_token_stats",
        totalTokens, totalPromptTokens, totalCompletionTokens, totalCredits,
        successfulCalls, totalRequests: logs.length,
        totalCvExtractionsCount, cvExtractionCredits, taskBreakdown,
      });
    }

    // Upsert daily rows
    for (const [dateStr, data] of Object.entries(dailyMap)) {
      const row = await ctx.db
        .query("dailyTokenStats")
        .withIndex("by_dateStr", (q) => q.eq("dateStr", dateStr))
        .first();
      if (row) {
        await ctx.db.patch(row._id, data);
      } else {
        await ctx.db.insert("dailyTokenStats", { dateStr, ...data });
      }
    }

    return {
      message: `Re-synced ${logs.length} token logs (${denormalizedCount} sourceChannels patched) across ${Object.keys(dailyMap).length} days.`,
    };
  },
});

export const backfillTokenCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("nvidiaTokenLogs").collect();

    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCredits = 0;
    let successfulCalls = 0;
    let totalCvExtractionsCount = 0;
    let cvExtractionCredits = 0;
    const taskBreakdown: Record<string, { tokens: number; credits: number; count: number }> = {};
    const dailyMap: Record<string, { totalCost: number; cvExtractionCost: number }> = {};

    for (const log of logs) {
      const cost = calculateNvidiaCredits(log.model, log.promptTokens, log.completionTokens);

      totalTokens += log.totalTokens;
      totalPromptTokens += log.promptTokens;
      totalCompletionTokens += log.completionTokens;
      totalCredits += cost;
      if (log.success) successfulCalls++;
      if (log.taskType === "cv_structuring" && log.success) {
        totalCvExtractionsCount++;
        cvExtractionCredits += cost;
      }
      if (!taskBreakdown[log.taskType]) {
        taskBreakdown[log.taskType] = { tokens: 0, credits: 0, count: 0 };
      }
      taskBreakdown[log.taskType].tokens += log.totalTokens;
      taskBreakdown[log.taskType].credits += cost;
      taskBreakdown[log.taskType].count += 1;

      const dateStr = new Date(log.timestamp).toISOString().split("T")[0];
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { totalCost: 0, cvExtractionCost: 0 };
      dailyMap[dateStr].totalCost += cost;
      if (log.taskType === "cv_structuring") dailyMap[dateStr].cvExtractionCost += cost;
    }

    // Upsert the singleton
    const existing = await ctx.db
      .query("tokenStatsCache")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_token_stats"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        totalTokens, totalPromptTokens, totalCompletionTokens, totalCredits,
        successfulCalls, totalRequests: logs.length,
        totalCvExtractionsCount, cvExtractionCredits, taskBreakdown,
      });
    } else {
      await ctx.db.insert("tokenStatsCache", {
        singletonKey: "global_token_stats",
        totalTokens, totalPromptTokens, totalCompletionTokens, totalCredits,
        successfulCalls, totalRequests: logs.length,
        totalCvExtractionsCount, cvExtractionCredits, taskBreakdown,
      });
    }

    // Upsert daily rows
    for (const [dateStr, data] of Object.entries(dailyMap)) {
      const row = await ctx.db
        .query("dailyTokenStats")
        .withIndex("by_dateStr", (q) => q.eq("dateStr", dateStr))
        .first();
      if (row) {
        await ctx.db.patch(row._id, data);
      } else {
        await ctx.db.insert("dailyTokenStats", { dateStr, ...data });
      }
    }

    return {
      message: `Backfilled cache from ${logs.length} logs across ${Object.keys(dailyMap).length} days.`,
    };
  },
});
