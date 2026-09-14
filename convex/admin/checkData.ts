import { query } from "../_generated/server";

export const checkDb = query({
  handler: async (ctx) => {
    const sysStat = await ctx.db.query("systemStats")
      .withIndex("by_singletonKey", q => q.eq("singletonKey", "global_stats"))
      .first();

    const recentCvUploads = await ctx.db.query("cvUploads").order("desc").take(50);
    const noCand = recentCvUploads.filter(u => !u.candidateId).length;

    const recentResumes = await ctx.db.query("candidateResumes").order("desc").take(10);
    const resumeStats = recentResumes.map(r => ({
      _id: r._id,
      candidateId: r.candidateId,
      rawTextLen: r.rawText ? r.rawText.length : 0,
      hasEmbeddingField: r.hasEmbedding,
      embeddingLength: r.embedding ? r.embedding.length : 0,
    }));

    const recentTokenLogs = await ctx.db.query("nvidiaTokenLogs")
      .order("desc")
      .take(10);

    const candidates = await ctx.db.query("candidates").collect();
    const workableCandidates = candidates.filter(c => (c as any).source === "Workable" || !!(c as any).workableCandidateId);

    const logs = await ctx.db.query("nvidiaTokenLogs").collect();
    const deepseekCvLogs = logs.filter(l => (l.model || "").toLowerCase().includes("deepseek") && l.taskType === "cv_structuring" && l.success);
    const workableDeepseekLogs = logs.filter(l => (l.model || "").toLowerCase().includes("deepseek") && l.taskType === "cv_structuring" && l.success && ((l.sourceChannel || "").toLowerCase().includes("workable") || (l.fileName || "").toLowerCase().includes("workable")));

    return {
      totalCandidatesInDatabase: candidates.length,
      candidatesFromWorkable: workableCandidates.length,
      totalDeepSeekCvExtractions: deepseekCvLogs.length,
      workableDeepSeekCvExtractions: workableDeepseekLogs.length,
      totalCvUploads: sysStat?.totalCvUploads || 0,
      recentCvUploadsChecked: recentCvUploads.length,
      recentCvUploadsWithoutCandidate: noCand,
      recentTokenLogs: recentTokenLogs.map(l => ({
        taskType: l.taskType,
        model: l.model,
        success: l.success,
        sourceChannel: l.sourceChannel,
        timestamp: l.timestamp,
      })),
    };
  }
});

export const getWorkableUploads = query({
  handler: async (ctx) => {
    const uploads = await ctx.db.query("cvUploads")
      .filter(q => q.eq(q.field("source"), "Workable"))
      .order("desc")
      .take(20);
    return uploads.map(u => ({
      _id: u._id,
      fileName: u.fileName,
      status: u.status,
      candidateId: u.candidateId,
      errorMessage: u.errorMessage,
      storageProvider: u.storageProvider,
      s3Key: u.s3Key,
      _creationTime: u._creationTime,
    }));
  }
});

export const getWorkableJobDetails = query({
  handler: async (ctx) => {
    const job = await ctx.db.query("workableImports").order("desc").first();
    return job;
  }
});

export const getAllSourcesBreakdown = query({
  handler: async (ctx) => {
    const candidates = await ctx.db.query("candidates").order("desc").take(1000);
    const candidateSourceCounts: Record<string, number> = {};
    let latestManualCandidate: any = null;

    for (const c of candidates) {
      const src = (c as any).source || (c as any).sourceChannel || "Unknown";
      candidateSourceCounts[src] = (candidateSourceCounts[src] || 0) + 1;
      if (src.toLowerCase().includes("manual") || src.toLowerCase().includes("directory") || src.toLowerCase().includes("folder")) {
        if (!latestManualCandidate || c._creationTime > latestManualCandidate._creationTime) {
          latestManualCandidate = {
            _id: c._id,
            fullName: c.fullName,
            email: c.email,
            source: src,
            creationTime: c._creationTime,
            formattedDate: new Date(c._creationTime).toLocaleString(),
          };
        }
      }
    }

    const uploads = await ctx.db.query("cvUploads").order("desc").take(1000);
    const uploadSourceCounts: Record<string, number> = {};
    let latestManualUpload: any = null;

    for (const u of uploads) {
      const src = u.source || "Unknown";
      uploadSourceCounts[src] = (uploadSourceCounts[src] || 0) + 1;
      if (src.toLowerCase().includes("manual") || src.toLowerCase().includes("directory") || src.toLowerCase().includes("folder")) {
        if (!latestManualUpload || u._creationTime > latestManualUpload._creationTime) {
          latestManualUpload = {
            _id: u._id,
            fileName: u.fileName,
            source: src,
            status: u.status,
            creationTime: u._creationTime,
            formattedDate: new Date(u._creationTime).toLocaleString(),
          };
        }
      }
    }

    return {
      totalCandidatesScanned: candidates.length,
      candidateSourceCounts,
      totalUploadsScanned: uploads.length,
      uploadSourceCounts,
      latestManualCandidate,
      latestManualUpload,
    };
  },
});

export const getDeepSeekStats = query({
  handler: async (ctx) => {
    const candidates = await ctx.db.query("candidates").order("desc").take(300);
    
    const candidatesBySource: Record<string, number> = {};
    let parsedCandidatesCount = 0;
    for (const c of candidates) {
      const src = (c as any).source || "Manual";
      candidatesBySource[src] = (candidatesBySource[src] || 0) + 1;
      if (c.isParsed) parsedCandidatesCount++;
    }

    const tokenLogs = await ctx.db.query("nvidiaTokenLogs").order("desc").take(500);
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

    return {
      candidatesCheckedSample: candidates.length,
      parsedCandidatesCount,
      candidatesBySource,
      deepseekLogsRecent500: {
        totalCallsCount: deepseekCallsCount,
        successfulCalls: deepseekSuccessfulCalls,
        cvStructuringSuccessCount: deepseekCvStructuringCount,
        workableCvStructuringCount: workableDeepseekCount,
      },
    };
  },
});

export const getDeepSeekTokenReport = query({
  handler: async (ctx) => {
    const logs = await ctx.db.query("nvidiaTokenLogs").order("desc").take(500);

    const breakdown: Record<string, {
      callsCount: number;
      successfulCalls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd: number;
    }> = {};

    let grandTotalTokens = 0;
    let grandTotalCostUsd = 0;
    let totalDeepSeekCalls = 0;

    for (const log of logs) {
      const modelLower = (log.model || "").toLowerCase();
      if (modelLower.includes("deepseek")) {
        totalDeepSeekCalls++;
        const task = log.taskType || "cv_structuring";
        if (!breakdown[task]) {
          breakdown[task] = {
            callsCount: 0,
            successfulCalls: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          };
        }

        const prompt = log.promptTokens || 0;
        const completion = log.completionTokens || 0;
        const total = log.totalTokens || (prompt + completion);
        const cost = (prompt / 1_000_000 * 0.14) + (completion / 1_000_000 * 0.28);

        breakdown[task].callsCount++;
        if (log.success) breakdown[task].successfulCalls++;
        breakdown[task].promptTokens += prompt;
        breakdown[task].completionTokens += completion;
        breakdown[task].totalTokens += total;
        breakdown[task].costUsd += cost;

        grandTotalTokens += total;
        grandTotalCostUsd += cost;
      }
    }

    return {
      sampleLogsInspected: logs.length,
      totalDeepSeekCalls,
      grandTotalTokens,
      grandTotalCostUsd,
      breakdown,
    };
  },
});
