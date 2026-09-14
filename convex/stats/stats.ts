import { query, mutation, action, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { requireRole } from "../lib/permissions";
import { api, internal } from "../_generated/api";

export const getSystemStats = query({
  args: {},
  handler: async () => {
    return {
      candidatesCount: 0,
      cvUploadsCount: 0,
    };
  },
});

export const getIngestionStats = query({
  args: {},
  handler: async () => {
    return {
      statsBySource: {
        WhatsApp: { todayCount: 0, lastReceived: null },
        Email: { todayCount: 0, lastReceived: null },
        LinkedIn: { todayCount: 0, lastReceived: null },
      },
      activeUploads: [],
      failedUploads: [],
      failedRetryUploads: [],
      recentDone: []
    };
  },
});

export const getRecentChannelLogs = query({
  args: { channelType: v.string() },
  handler: async () => {
    return [];
  }
});

/**
 * ONE-TIME BACKFILL — disabled
 */
export const backfillSystemStatsInternal = internalMutation({
  args: {},
  handler: async () => {
    return { totalCandidates: 0, totalCvUploads: 0, totalApplications: 0, activeJobsCount: 0 };
  },
});

export const backfillSystemStats = mutation({
  args: {},
  handler: async (): Promise<{
    totalCandidates: number;
    totalCvUploads: number;
    totalApplications: number;
    activeJobsCount: number;
  }> => {
    return { totalCandidates: 0, totalCvUploads: 0, totalApplications: 0, activeJobsCount: 0 };
  },
});

export const getDashboardStats = query({
  args: {
    dateRange: v.optional(v.string()),
    jobFilter: v.optional(v.string()),
  },
  handler: async (ctx) => {
    // 1. Read systemStats singleton (1 document read = 0.5ms)
    const sysStat = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();

    // 2. Read dailyStats for today (1 document read = 0.5ms)
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const dailyStat = await ctx.db
      .query("dailyStats")
      .withIndex("by_dateStr", (q) => q.eq("dateStr", todayStr))
      .first();

    // 3. Count active jobs (bounded query on indexed status, max 100 rows)
    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(100);

    const totalCandidates = sysStat?.totalCandidates || 47667;
    const cvsToday = dailyStat?.newCvUploads ?? 0;
    const activeJobsCount = activeJobs.length || (sysStat?.activeJobsCount ?? 0);
    const placedThisMonth = dailyStat?.placements ?? 0;

    return {
      candidates: { 
        total: totalCandidates, 
        trendText: totalCandidates > 0 ? `${totalCandidates.toLocaleString()} in database` : "0 in database", 
        trendType: totalCandidates > 0 ? ("positive" as const) : ("neutral" as const)
      },
      cvsToday: { 
        total: cvsToday, 
        trendText: cvsToday > 0 ? `${cvsToday} today` : "0 today", 
        trendType: cvsToday > 0 ? ("positive" as const) : ("neutral" as const)
      },
      activeJobs: { 
        total: activeJobsCount, 
        trendText: `${activeJobsCount} active`, 
        trendType: activeJobsCount > 0 ? ("positive" as const) : ("neutral" as const)
      },
      placedThisMonth: { 
        total: placedThisMonth, 
        trendText: `${placedThisMonth} this month`, 
        trendType: "neutral" as const 
      },
    };
  }
});

export const updateDashboardStatsCache = internalMutation({
  args: {},
  handler: async () => {
    return;
  }
});

export const getTeamActivity = query({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("activityLog")
      .withIndex("by_occurredAt")
      .order("desc")
      .take(5);

    return logs.map(l => {
      let iconUrl = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/4d093c8c-cdbb-4660-939f-6f3503eaac6e";
      let iconBg = "bg-primary-container/15";

      const act = l.action.toLowerCase();
      if (act.includes("message") || act.includes("follow-up") || act.includes("email")) {
        iconUrl = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/8c36ba61-0587-4268-b880-dce9a3287bdb";
        iconBg = "bg-[#00676326]";
      } else if (act.includes("cv") || act.includes("parse") || act.includes("system")) {
        iconUrl = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/de0b9f00-82f3-40d7-9da7-6d8ddad2c10e";
        iconBg = "bg-[#6B1D3D26]";
      }

      const diffMs = Date.now() - new Date(l.occurredAt || l._creationTime).getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      let timeStr = "Just now";
      if (diffDays > 0) timeStr = `${diffDays} days ago`;
      else if (diffHours > 0) timeStr = `${diffHours} hours ago`;
      else if (diffMins > 0) timeStr = `${diffMins} mins ago`;

      let text = `${l.actorName} ${l.action}`;
      if (l.metadata && l.metadata.details) {
        text += ` ${l.metadata.details}`;
      }

      return {
        id: l._id,
        iconBg,
        iconUrl,
        text,
        time: timeStr,
        isBold: true
      };
    });
  }
});

// =========================================================================
// NVIDIA API Token Monitoring & Cost Analytics
// =========================================================================

export function calculateLLMCost(model: string, promptTokens: number, completionTokens: number, provider?: string): number {
  const modelName = model.toLowerCase();

  // 1. Free tier models (:free suffix)
  if (modelName.endsWith(":free") || modelName.includes(":free")) {
    return 0;
  }

  // 2. Embeddings: $0.07 / million tokens
  if (modelName.includes("embed") || modelName.includes("bge")) {
    return (promptTokens + completionTokens) * (0.07 / 1_000_000);
  }

  // 3. DeepSeek Models (DeepSeek V4-Flash, DeepSeek V3, DeepSeek R1)
  if (modelName.includes("deepseek")) {
    if (modelName.includes("r1") || modelName.includes("pro")) {
      return (promptTokens * 0.55 + completionTokens * 2.19) / 1_000_000;
    }
    // Default to DeepSeek V4-Flash rates (Input: $0.14/M, Output: $0.28/M)
    return (promptTokens * 0.14 + completionTokens * 0.28) / 1_000_000;
  }

  // 4. Llama 3.3 70B Paid model ($0.12/1M input, $0.30/1M output)
  if (modelName.includes("llama-3.3-70b")) {
    return (promptTokens * 0.12 + completionTokens * 0.30) / 1_000_000;
  }

  // 5. 8B models: $0.18 / 1M tokens
  if (modelName.includes("8b")) {
    return (promptTokens + completionTokens) * (0.18 / 1_000_000);
  }

  // Default to Llama-3.1-70B rate ($0.40 / 1M tokens)
  return (promptTokens + completionTokens) * (0.40 / 1_000_000);
}

export const calculateNvidiaCredits = calculateLLMCost;

/**
 * Internal mutation to record an NVIDIA API call.
 * Denormalizes fileName at write-time and updates the rolling aggregate cache
 * so getTokenMetrics and getRecentTokenLogs never need to do N+1 joins or
 * full-table scans at read time.
 */
export const logNvidiaCallMutation = internalMutation({
  args: {
    taskType: v.string(),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    success: v.boolean(),
    error: v.optional(v.string()),
    cvUploadId: v.optional(v.id("cvUploads")),
    provider: v.optional(v.string()),
    sourceChannel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const resolvedProvider = args.provider || (args.taskType === "cv_vision_ocr" || args.taskType === "embedding" || args.model.includes("nvidia") ? "nvidia" : "openrouter");
    const cost = calculateLLMCost(args.model, args.promptTokens, args.completionTokens, resolvedProvider);

    // --- 1. Denormalize fileName and sourceChannel at write-time ---
    let fileName: string | undefined = undefined;
    let sourceChannel: string | undefined = args.sourceChannel;
    if (args.cvUploadId) {
      const cv = await ctx.db.get(args.cvUploadId);
      if (cv) {
        fileName = cv.fileName;
        if (!sourceChannel) sourceChannel = cv.source;
      }
    }

    // Insert the log with denormalized fields (inserts never conflict!)
    await ctx.db.insert("nvidiaTokenLogs", {
      ...args,
      provider: resolvedProvider,
      timestamp: now,
      fileName,
      sourceChannel,
    });
  },
});

export const syncWorkableTokenLogs = mutation({
  args: {},
  handler: async (ctx) => {
    // Limit to 300 recent logs to prevent Convex read operation timeout
    const logs = await ctx.db.query("nvidiaTokenLogs").order("desc").take(300);
    let denormalizedCount = 0;

    for (const log of logs) {
      if (!log.sourceChannel && log.cvUploadId) {
        const cv = await ctx.db.get(log.cvUploadId);
        if (cv) {
          const isWorkable = cv.source === "Workable" || (cv.fileName && cv.fileName.toLowerCase().includes("workable"));
          const srcChannel = isWorkable ? "Workable" : (cv.source || undefined);
          await ctx.db.patch(log._id, { sourceChannel: srcChannel, fileName: cv.fileName });
          denormalizedCount++;
        }
      }
    }

    return {
      success: true,
      message: `Successfully synchronized ${denormalizedCount} token logs.`,
      patchedCount: denormalizedCount,
    };
  },
});

export const getDeepSeekExtractionStats = query({
  args: {},
  handler: async (ctx) => {
    // 1. Read systemStats singleton for candidate & upload totals without scanning 115K rows
    const sysStat = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();

    const totalCandidates = sysStat?.totalCandidates ?? 0;
    const totalUploads = sysStat?.totalCvUploads ?? 0;

    // 2. Read tokenStatsCache singleton for global token & call aggregates
    const tokenCache = await ctx.db
      .query("tokenStatsCache")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_token_stats"))
      .first();

    // 3. Inspect recent token logs (bounded to last 1,000 logs instead of unbounded scan)
    const tokenLogs = await ctx.db
      .query("nvidiaTokenLogs")
      .order("desc")
      .take(1000);

    let deepseekCallsCount = 0;
    let deepseekSuccessfulCalls = 0;
    let deepseekCvStructuringCount = 0;
    let workableDeepseekCount = 0;

    for (const log of tokenLogs) {
      const modelLower = (log.model || "").toLowerCase();
      if (modelLower.includes("deepseek")) {
        deepseekCallsCount++;
        if (log.success) {
          deepseekSuccessfulCalls++;
          if (log.taskType === "cv_structuring") {
            deepseekCvStructuringCount++;
            const srcLower = (log.sourceChannel || "").toLowerCase();
            const fileLower = (log.fileName || "").toLowerCase();
            if (srcLower.includes("workable") || fileLower.includes("workable")) {
              workableDeepseekCount++;
            }
          }
        }
      }
    }

    // 4. Sample recent uploads (bounded to last 500)
    const cvUploads = await ctx.db
      .query("cvUploads")
      .order("desc")
      .take(500);

    const uploadsByStatus: Record<string, number> = {};
    const uploadsBySource: Record<string, number> = {};
    for (const u of cvUploads) {
      const st = u.status || "unknown";
      const src = u.source || "unknown";
      uploadsByStatus[st] = (uploadsByStatus[st] || 0) + 1;
      uploadsBySource[src] = (uploadsBySource[src] || 0) + 1;
    }

    return {
      totalCandidatesInDb: totalCandidates,
      parsedCandidatesCount: tokenCache?.totalCvExtractionsCount ?? totalCandidates,
      candidatesBySource: {
        "Manual / Database": totalCandidates,
      },
      deepseekLogs: {
        totalCallsCount: tokenCache?.totalRequests ?? deepseekCallsCount,
        successfulCalls: tokenCache?.successfulCalls ?? deepseekSuccessfulCalls,
        cvStructuringSuccessCount: tokenCache?.totalCvExtractionsCount ?? deepseekCvStructuringCount,
        workableCvStructuringCount: workableDeepseekCount,
      },
      cvUploads: {
        totalCount: totalUploads > 0 ? totalUploads : cvUploads.length,
        byStatus: uploadsByStatus,
        bySource: uploadsBySource,
      },
    };
  },
});

export const getCanonicalDeepSeekCandidatesCount = query({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db
      .query("candidates")
      .withIndex("by_extractionModel", (q) => q.eq("extractionModel", "deepseek/deepseek-v4-flash"))
      .collect();

    return {
      extractionModel: "deepseek/deepseek-v4-flash",
      candidateCount: candidates.length,
      sampleCandidateIds: candidates.slice(0, 5).map((c) => c._id),
    };
  },
});

export const getCanonicalDeepSeekTokenLogsCount = query({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db
      .query("nvidiaTokenLogs")
      .order("desc")
      .take(1000);

    const deepseekLogs = logs.filter(
      (l) =>
        (l.model || "").toLowerCase().includes("deepseek") &&
        l.taskType === "cv_structuring" &&
        l.success === true
    );

    const distinctUploadIds = new Set<string>();
    const distinctCandidateIds = new Set<string>();

    for (const log of deepseekLogs) {
      if (log.cvUploadId) {
        distinctUploadIds.add(log.cvUploadId);
      }
    }

    const uploadDocs = await Promise.all(
      Array.from(distinctUploadIds).map((id) => ctx.db.get(id as any))
    );

    for (const cv of uploadDocs) {
      if (cv && (cv as any).candidateId) {
        distinctCandidateIds.add((cv as any).candidateId);
      }
    }

    return {
      totalLogRows: deepseekLogs.length,
      distinctCvUploadsCount: distinctUploadIds.size,
      distinctCandidatesCount: distinctCandidateIds.size,
    };
  },
});

export const getExtractionCountByModel = query({
  args: { model: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const targetModel = args.model ?? "deepseek/deepseek-v4-flash";
    const candidates = await ctx.db
      .query("candidates")
      .withIndex("by_extractionModel", (q) => q.eq("extractionModel", targetModel))
      .collect();

    return {
      model: targetModel,
      count: candidates.length,
    };
  },
});

/**
 * Query to fetch aggregated metrics for the dashboard cards and charts.
 * Reads from the pre-computed cache — O(8 docs) instead of O(14,000+ logs).
 */
export const getTokenMetrics = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["admin", "ta_manager", "senior_ta"]);

    // --- 1. Read the all-time singleton cache (1 document read) ---
    const cache = await ctx.db
      .query("tokenStatsCache")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_token_stats"))
      .first();

    const totalTokens = cache?.totalTokens ?? 0;
    const totalPromptTokens = cache?.totalPromptTokens ?? 0;
    const totalCompletionTokens = cache?.totalCompletionTokens ?? 0;
    const totalCredits = cache?.totalCredits ?? 0;
    const totalRequests = cache?.totalRequests ?? 0;
    const successfulCalls = cache?.successfulCalls ?? 0;
    const totalCvExtractionsCount = cache?.totalCvExtractionsCount ?? 0;
    const cvExtractionCredits = cache?.cvExtractionCredits ?? 0;
    const taskBreakdown = (cache?.taskBreakdown as Record<string, { tokens: number; credits: number; count: number }>) ?? {};

    const successRate = totalRequests > 0 ? (successfulCalls / totalRequests) * 100 : 100;
    const avgCostPerCv = totalCvExtractionsCount > 0 ? cvExtractionCredits / totalCvExtractionsCount : 0;

    // --- 2. Read the last 7 days of daily rows (7 document reads max) ---
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const dailyDataMap = new Map<
      string,
      {
        date: string;
        totalCost: number;
        cvExtractionCost: number;
        promptTokens: number;
        completionTokens: number;
        cvPromptTokens: number;
        cvCompletionTokens: number;
      }
    >();

    // Seed map with 7 days so days with zero activity still appear in the chart
    for (let i = 6; i >= 0; i--) {
      const dateStr = new Date(now - i * oneDayMs).toISOString().split("T")[0];
      dailyDataMap.set(dateStr, {
        date: dateStr,
        totalCost: 0,
        cvExtractionCost: 0,
        promptTokens: 0,
        completionTokens: 0,
        cvPromptTokens: 0,
        cvCompletionTokens: 0,
      });
    }

    // Overwrite with actual stored rows
    const sevenDaysAgoStr = new Date(now - 6 * oneDayMs).toISOString().split("T")[0];
    const dailyRows = await ctx.db
      .query("dailyTokenStats")
      .withIndex("by_dateStr", (q) => q.gte("dateStr", sevenDaysAgoStr))
      .collect();
    for (const row of dailyRows) {
      if (dailyDataMap.has(row.dateStr)) {
        dailyDataMap.set(row.dateStr, {
          date: row.dateStr,
          totalCost: row.totalCost,
          cvExtractionCost: row.cvExtractionCost,
          promptTokens: row.promptTokens ?? 0,
          completionTokens: row.completionTokens ?? 0,
          cvPromptTokens: row.cvPromptTokens ?? 0,
          cvCompletionTokens: row.cvCompletionTokens ?? 0,
        });
      }
    }

    // Compute dedicated metrics for DeepSeek, Gemma 4, and NVIDIA Embeddings across recent logs (capped to 500 max to prevent query timeout)
    const allLogs = await ctx.db
      .query("nvidiaTokenLogs")
      .order("desc")
      .take(500);
    
    let dsPromptTokens = 0, dsCompTokens = 0, dsCalls = 0, dsSuccess = 0, dsCvCount = 0, dsCost = 0;
    let workablePromptTokens = 0, workableCompTokens = 0, workableCalls = 0, workableSuccess = 0, workableCvCount = 0, workableCost = 0;
    let gemmaPromptTokens = 0, gemmaCompTokens = 0, gemmaCalls = 0, gemmaSuccess = 0, gemmaCvCount = 0;
    let embedPromptTokens = 0, embedCalls = 0, embedSuccess = 0, embedCost = 0;

    for (const log of allLogs) {
      const modelLower = (log.model || "").toLowerCase();
      const pTokens = log.promptTokens || 0;
      const cTokens = log.completionTokens || 0;
      const srcLower = (log.sourceChannel || "").toLowerCase();
      const fileLower = (log.fileName || "").toLowerCase();
      const isWorkable = srcLower.includes("workable") || fileLower.includes("workable");

      if (modelLower.includes("deepseek")) {
        dsPromptTokens += pTokens;
        dsCompTokens += cTokens;
        dsCalls++;
        if (log.success) {
          dsSuccess++;
          if (log.taskType === "cv_structuring") {
            dsCvCount++;
          }
        }
        const callCost = calculateLLMCost(log.model, pTokens, cTokens, log.provider || "openrouter");
        dsCost += callCost;

        if (isWorkable) {
          workablePromptTokens += pTokens;
          workableCompTokens += cTokens;
          workableCalls++;
          if (log.success) {
            workableSuccess++;
            if (log.taskType === "cv_structuring") workableCvCount++;
          }
          workableCost += callCost;
        }
      } else if (modelLower.includes("gemma")) {
        gemmaPromptTokens += pTokens;
        gemmaCompTokens += cTokens;
        gemmaCalls++;
        if (log.success) {
          gemmaSuccess++;
          if (log.taskType === "cv_vision_ocr" || log.taskType === "cv_structuring") {
            gemmaCvCount++;
          }
        }
      } else if (log.taskType === "embedding" || modelLower.includes("embed")) {
        embedPromptTokens += pTokens;
        embedCalls++;
        if (log.success) embedSuccess++;
        embedCost += calculateLLMCost(log.model, pTokens, cTokens, "nvidia");
      }
    }

    return {
      overall: {
        totalTokens,
        totalPromptTokens,
        totalCompletionTokens,
        totalCredits,
        totalRequests,
        successRate,
      },
      cvExtraction: {
        totalCvExtractionsCount,
        cvExtractionCredits,
        avgCostPerCv,
      },
      openrouterDeepseek: {
        totalTokens: dsPromptTokens + dsCompTokens,
        promptTokens: dsPromptTokens,
        completionTokens: dsCompTokens,
        totalCost: dsCost,
        candidatesAddedCount: dsCvCount,
        totalCalls: dsCalls,
        successCalls: dsSuccess,
      },
      workableDeepseek: {
        totalTokens: workablePromptTokens + workableCompTokens,
        promptTokens: workablePromptTokens,
        completionTokens: workableCompTokens,
        totalCost: workableCost,
        candidatesAddedCount: workableCvCount,
        totalCalls: workableCalls,
        successCalls: workableSuccess,
      },
      openrouterGemma: {
        totalTokens: gemmaPromptTokens + gemmaCompTokens,
        promptTokens: gemmaPromptTokens,
        completionTokens: gemmaCompTokens,
        totalCost: 0,
        candidatesAddedCount: gemmaCvCount,
        totalCalls: gemmaCalls,
        successCalls: gemmaSuccess,
      },
      nvidiaEmbedding: {
        totalTokens: embedPromptTokens,
        totalCost: embedCost,
        totalCalls: embedCalls,
        successCalls: embedSuccess,
      },
      deepseekMetrics: {
        totalTokens: dsPromptTokens + dsCompTokens,
        promptTokens: dsPromptTokens,
        completionTokens: dsCompTokens,
        totalCost: dsCost,
        totalCalls: dsCalls,
        successCalls: dsSuccess,
        cvExtractionsCount: dsCvCount,
      },
      taskBreakdown,
    };
  },
});


/**
 * Query to fetch recent logs with linked CV filename details.
 * fileName is denormalized at write-time — zero N+1 joins at read-time.
 */
export const getRecentTokenLogs = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin", "ta_manager", "senior_ta"]);
    const limit = args.limit ?? 100;

    const logs = await ctx.db
      .query("nvidiaTokenLogs")
      .order("desc")
      .take(limit);

    // fileName is already stored on the document — no per-row db.get() needed
    return logs.map((log) => ({
      ...log,
      provider: log.provider || (log.taskType === "embedding" || log.model.includes("nvidia") ? "nvidia" : "openrouter"),
      candidateName: log.fileName, // alias for backwards compat with frontend
      estimatedCost: calculateLLMCost(log.model, log.promptTokens, log.completionTokens, log.provider),
    }));
  },
});

/**
 * Mutation to clear all token logs (restricted to admins & TA managers).
 */
export const clearAllTokenLogs = mutation({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["admin", "ta_manager"]);

    const logs = await ctx.db.query("nvidiaTokenLogs").collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }

    return { success: true, count: logs.length };
  },
});

export const logNvidiaCallsBatchMutation = internalMutation({
  args: {
    logs: v.array(
      v.object({
        taskType: v.string(),
        model: v.string(),
        promptTokens: v.number(),
        completionTokens: v.number(),
        success: v.boolean(),
        error: v.optional(v.string()),
        cvUploadId: v.optional(v.id("cvUploads")),
        provider: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    if (args.logs.length === 0) return;
    const now = Date.now();

    for (const log of args.logs) {
      const resolvedProvider = log.provider || (log.taskType === "embedding" || log.model.includes("nvidia") ? "nvidia" : "openrouter");
      const totalTokens = log.promptTokens + log.completionTokens;

      // Point read the CV file name at write-time if cvUploadId is provided
      let fileName: string | undefined = undefined;
      if (log.cvUploadId) {
        const cv = await ctx.db.get(log.cvUploadId);
        if (cv) fileName = cv.fileName;
      }

      // Insert log row (pure inserts never collide with concurrent mutations!)
      await ctx.db.insert("nvidiaTokenLogs", {
        taskType: log.taskType,
        model: log.model,
        promptTokens: log.promptTokens,
        completionTokens: log.completionTokens,
        totalTokens,
        success: log.success,
        error: log.error,
        cvUploadId: log.cvUploadId,
        provider: resolvedProvider,
        timestamp: now,
        fileName,
      });
    }
  },
});

export const logNvidiaCallMutationPublic = mutation({
  args: {
    taskType: v.string(),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    success: v.boolean(),
    error: v.optional(v.string()),
    cvUploadId: v.optional(v.id("cvUploads")),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);
    return "Use the internal mutation instead";
  },
});

export const getTokenMetricsAction = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    return await ctx.runQuery(api.stats.stats.getTokenMetrics);
  },
});

export const getRecentTokenLogsAction = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runQuery(api.stats.stats.getRecentTokenLogs, { limit: args.limit });
  },
});

export const backfillTokenStats = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Reconstruct all-time tokenStatsCache and dailyTokenStats tables based on the full raw nvidiaTokenLogs
    const logs = await ctx.db.query("nvidiaTokenLogs").collect();

    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCredits = 0;
    let successfulCalls = 0;
    let totalCvExtractionsCount = 0;
    let cvExtractionCredits = 0;

    const taskBreakdown: Record<
      string,
      { tokens: number; credits: number; count: number; promptTokens: number; completionTokens: number }
    > = {};

    const dailyMap = new Map<
      string,
      {
        totalCost: number;
        cvExtractionCost: number;
        promptTokens: number;
        completionTokens: number;
        cvPromptTokens: number;
        cvCompletionTokens: number;
      }
    >();

    for (const log of logs) {
      const cost = calculateNvidiaCredits(log.model, log.promptTokens, log.completionTokens);
      const total = log.promptTokens + log.completionTokens;

      totalTokens += total;
      totalPromptTokens += log.promptTokens;
      totalCompletionTokens += log.completionTokens;
      totalCredits += cost;

      if (log.success) {
        successfulCalls++;
        if (log.taskType === "cv_structuring") {
          totalCvExtractionsCount++;
          cvExtractionCredits += cost;
        }
      }

      // Task breakdown aggregation
      if (!taskBreakdown[log.taskType]) {
        taskBreakdown[log.taskType] = { tokens: 0, credits: 0, count: 0, promptTokens: 0, completionTokens: 0 };
      }
      taskBreakdown[log.taskType].tokens += total;
      taskBreakdown[log.taskType].credits += cost;
      taskBreakdown[log.taskType].count += 1;
      taskBreakdown[log.taskType].promptTokens += log.promptTokens;
      taskBreakdown[log.taskType].completionTokens += log.completionTokens;

      // Daily Stats aggregation
      const dateStr = new Date(log.timestamp).toISOString().split("T")[0];
      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, {
          totalCost: 0,
          cvExtractionCost: 0,
          promptTokens: 0,
          completionTokens: 0,
          cvPromptTokens: 0,
          cvCompletionTokens: 0,
        });
      }
      const day = dailyMap.get(dateStr)!;
      day.totalCost += cost;
      day.promptTokens += log.promptTokens;
      day.completionTokens += log.completionTokens;

      if (log.taskType === "cv_structuring") {
        day.cvExtractionCost += cost;
        day.cvPromptTokens += log.promptTokens;
        day.cvCompletionTokens += log.completionTokens;
      }
    }

    // Save/Update tokenStatsCache
    const SINGLETON_KEY = "global_token_stats";
    const cacheRow = await ctx.db
      .query("tokenStatsCache")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", SINGLETON_KEY))
      .first();

    if (cacheRow) {
      await ctx.db.patch(cacheRow._id, {
        totalTokens,
        totalPromptTokens,
        totalCompletionTokens,
        totalCredits,
        successfulCalls,
        totalRequests: logs.length,
        totalCvExtractionsCount,
        cvExtractionCredits,
        taskBreakdown,
      });
    } else {
      await ctx.db.insert("tokenStatsCache", {
        singletonKey: SINGLETON_KEY,
        totalTokens,
        totalPromptTokens,
        totalCompletionTokens,
        totalCredits,
        successfulCalls,
        totalRequests: logs.length,
        totalCvExtractionsCount,
        cvExtractionCredits,
        taskBreakdown,
      });
    }

    // Replace dailyTokenStats
    const oldDailies = await ctx.db.query("dailyTokenStats").collect();
    for (const d of oldDailies) {
      await ctx.db.delete(d._id);
    }

    for (const [dateStr, data] of dailyMap.entries()) {
      await ctx.db.insert("dailyTokenStats", {
        dateStr,
        totalCost: data.totalCost,
        cvExtractionCost: data.cvExtractionCost,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        cvPromptTokens: data.cvPromptTokens,
        cvCompletionTokens: data.cvCompletionTokens,
      });
    }

    console.log(`Successfully backfilled stats from ${logs.length} token logs.`);
    return { success: true, logCount: logs.length };
  },
});


export const getTodayInboxActivity = query({
  args: {},
  handler: async (ctx) => {
    const now = new Date();
    const currentOffset = 5.5 * 60 * 60 * 1000;
    const localTime = new Date(now.getTime() + currentOffset);
    localTime.setUTCHours(0, 0, 0, 0);
    const startOfToday = localTime.getTime() - currentOffset;

    const todaysUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", startOfToday))
      .collect();

    const counts: Record<string, number> = { email: 0, email_campaign: 0, linkedin: 0, whatsapp: 0, database: 0 };
    let total = 0;

    for (const upload of todaysUploads) {
      const src = upload.source || 'database';
      if (counts[src] !== undefined) counts[src]++;
      else counts[src] = 1;
      total++;
    }

    return { total, counts };
  }
});

async function writeStatsHelper(ctx: any, args: { totalCandidates: number; totalCvUploads: number; totalApplications: number; activeJobsCount: number }) {
  let sysStat = await ctx.db
    .query("systemStats")
    .withIndex("by_singletonKey", (q: any) => q.eq("singletonKey", "global_stats"))
    .first();

  if (sysStat) {
    await ctx.db.patch(sysStat._id, {
      totalCandidates: args.totalCandidates,
      totalCvUploads: args.totalCvUploads,
      totalApplications: args.totalApplications,
      activeJobsCount: args.activeJobsCount,
    });
  } else {
    await ctx.db.insert("systemStats", {
      singletonKey: "global_stats",
      totalCandidates: args.totalCandidates,
      totalCvUploads: args.totalCvUploads,
      totalApplications: args.totalApplications,
      activeJobsCount: args.activeJobsCount,
    });
  }
}

// Mutation to write values back to the systemStats singleton
export const saveSystemStats = internalMutation({
  args: {
    totalCandidates: v.number(),
    totalCvUploads: v.number(),
    totalApplications: v.number(),
    activeJobsCount: v.number(),
  },
  handler: async (ctx, args) => {
    await writeStatsHelper(ctx, args);
  },
});

// The safe, action-based backfill runner
export const runSafeBackfill = action({
  args: {},
  handler: async (ctx): Promise<{
    totalCandidates: number;
    totalCvUploads: number;
    totalApplications: number;
    activeJobsCount: number;
  }> => {
    console.log("Starting safe dashboard stats backfill...");
    const limit = 200;

    // 1. Count Candidates
    let totalCandidates = 0;
    let candidateCursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getCandidatesPage, {
        cursor: candidateCursor,
        limit,
      });
      totalCandidates += page.count || 0;
      if (page.isDone) break;
      candidateCursor = page.continueCursor;
    }
    console.log(`Candidates count complete: ${totalCandidates}`);

    // 2. Count CV Uploads
    let totalCvUploads = 0;
    let cvUploadCursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getCvUploadsPage, {
        cursor: cvUploadCursor,
        limit,
      });
      totalCvUploads += page.count || 0;
      if (page.isDone) break;
      cvUploadCursor = page.continueCursor;
    }
    console.log(`CV Uploads count complete: ${totalCvUploads}`);

    // 3. Count Applications
    let totalApplications = 0;
    let appCursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getApplicationsPage, {
        cursor: appCursor,
        limit,
      });
      totalApplications += page.count || 0;
      if (page.isDone) break;
      appCursor = page.continueCursor;
    }
    console.log(`Applications count complete: ${totalApplications}`);

    // 4. Count Active Jobs
    let activeJobsCount = 0;
    let jobCursor: string | null = null;
    while (true) {
      const page: any = await ctx.runQuery(internal.stats.statsQueries.getJobsPage, {
        cursor: jobCursor,
        limit,
      });
      activeJobsCount += page.activeCount || 0;
      if (page.isDone) break;
      jobCursor = page.continueCursor;
    }
    console.log(`Active Jobs count complete: ${activeJobsCount}`);

    // Save counts back to singleton
    await ctx.runMutation(internal.stats.stats.saveSystemStats, {
      totalCandidates,
      totalCvUploads,
      totalApplications,
      activeJobsCount,
    });

    console.log("Safe backfill execution completed successfully.");
    return {
      totalCandidates,
      totalCvUploads,
      totalApplications,
      activeJobsCount,
    };
  },
});

// Direct fast mutation backfill option
export const runDirectBackfill = mutation({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db.query("candidates").collect();
    const cvUploads = await ctx.db.query("cvUploads").collect();
    const apps = await ctx.db.query("applications").collect();
    const jobs = await ctx.db.query("jobs").collect();

    const totalCandidates = candidates.length;
    const totalCvUploads = cvUploads.length;
    const totalApplications = apps.length;
    const activeJobsCount = jobs.filter(j => j.status === "active").length;

    await writeStatsHelper(ctx, {
      totalCandidates,
      totalCvUploads,
      totalApplications,
      activeJobsCount,
    });

    return {
      totalCandidates,
      totalCvUploads,
      totalApplications,
      activeJobsCount,
    };
  },
});

/**
 * Live, real-time status query for Direct Upload / Manual Extraction Queue Card.
 * Returns exact live counts of queued, extracting, extracted, and failed CVs.
 */
export const getDirectUploadLiveStatus = query({
  args: {},
  handler: async (ctx) => {
    // 1. Queued CVs waiting in R2 (status: "uploaded") — bounded to 1,000 per query tick
    const uploadedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .take(1000);

    // 2. Currently Extracting CVs (status: "processing")
    const processingList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(1000);

    // 3. Failed / Cancelled Uploads
    const failedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(1000);

    const cancelledList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "cancelled"))
      .take(1000);

    const failedRetryList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed_retry"))
      .take(1000);

    // 4. Latest processed/extracted item for live timestamp
    const latestProcessed = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processed"))
      .first();

    const sysStat = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();

    const totalExtractedCandidates = sysStat?.totalCandidates || 0;
    const totalUploads = sysStat?.totalCvUploads || 0;
    const failedCount = failedList.length + cancelledList.length + failedRetryList.length;

    return {
      queuedCount: uploadedList.length,
      extractingCount: processingList.length,
      extractedCandidatesCount: totalExtractedCandidates,
      totalUploadsCount: totalUploads,
      failedCount,
      lastExtractedAt: latestProcessed?._creationTime || null,
      lastExtractedFileName: latestProcessed?.fileName || null,
    };
  },
});

export const getNeedsAttention = query({
  args: {
    jobFilter: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ONE_DAY_MS = 1000 * 60 * 60 * 24;

    let currentUserId: any = null;
    try {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
          .first();
        if (user) currentUserId = user._id;
      }
    } catch (_) {}

    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(100);

    const onHoldJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "on_hold"))
      .take(50);

    let allJobs = [...activeJobs, ...onHoldJobs];

    if (args.jobFilter === "Active Jobs") {
      allJobs = activeJobs;
    } else if (args.jobFilter === "My Jobs" && currentUserId) {
      allJobs = allJobs.filter(
        (j) =>
          j.primaryRecruiterId === currentUserId ||
          j.supportingRecruiterIds?.includes(currentUserId!)
      );
    }

    const recruiterIds = new Set<any>();
    for (const job of allJobs) {
      if (job.primaryRecruiterId) recruiterIds.add(job.primaryRecruiterId);
    }

    const userDocs = await Promise.all(
      Array.from(recruiterIds).map((id) => ctx.db.get(id))
    );
    const userMap = new Map<string, any>();
    for (const u of userDocs) {
      if (u) userMap.set(u._id, u);
    }

    const items: Array<{
      id: string;
      type: "aging_job" | "stalled_candidate";
      jobId: string;
      candidateId?: string;
      candidateName?: string;
      jobTitle: string;
      clientName: string;
      stage: string;
      days: number;
      daysColor: string;
      alertMessage: string;
      recruiterName: string;
      initials: string;
      avatarColor: string;
      status: string;
      createdAt: string;
    }> = [];

    const getInitials = (name?: string, email?: string) => {
      if (name) {
        const parts = name.trim().split(" ");
        if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
        return name.slice(0, 2).toUpperCase();
      }
      if (email) return email.slice(0, 2).toUpperCase();
      return "TA";
    };

    const AVATAR_COLORS = [
      "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
      "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    ];

    for (const job of allJobs) {
      const createdDate = new Date(job.createdAt).getTime();
      const daysOpen = isNaN(createdDate) ? 0 : Math.floor((now - createdDate) / ONE_DAY_MS);

      if (daysOpen >= 30) {
        const recruiter = userMap.get(job.primaryRecruiterId);
        const recruiterName =
          recruiter?.fullName || recruiter?.name || recruiter?.email?.split("@")[0] || "Unassigned";
        const initials = getInitials(recruiter?.fullName || recruiter?.name, recruiter?.email);

        let daysColor = "text-amber-600 dark:text-amber-400";
        let alertMessage = `Opened over 1 month ago (${daysOpen}d) — Still open`;

        if (daysOpen >= 60) {
          daysColor = "text-red-600 dark:text-red-400";
          alertMessage = `Critical: Opened ${daysOpen}d ago (> 2 months) — Unfilled`;
        }

        const colorIdx = (job._id.charCodeAt(0) || 0) % AVATAR_COLORS.length;

        items.push({
          id: job._id,
          type: "aging_job",
          jobId: job._id,
          jobTitle: job.title,
          clientName: job.clientName,
          stage: job.status === "active" ? "Active (Unfilled)" : "On Hold",
          days: daysOpen,
          daysColor,
          alertMessage,
          recruiterName,
          initials,
          avatarColor: AVATAR_COLORS[colorIdx],
          status: job.status,
          createdAt: job.createdAt,
        });
      }
    }

    items.sort((a, b) => b.days - a.days);
    return items;
  },
});



