import { query } from "./_generated/server";
import { requireFullAccess } from "./lib/permissions";

/**
 * Overview metrics for the Analytics dashboard.
 * 
 * UPDATED: Now calculates stats live from the DB instead of relying on cached systemStats.
 */
export const getOverviewMetrics = query({
  args: {},
  handler: async (ctx) => {
    await requireFullAccess(ctx);
    // 1. Read total CV count from systemStats DB record (O(1) lookup)
    const sysStat = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();
    const totalCVs = sysStat?.totalCvUploads ?? 0;

    // 2. Read only active jobs
    const activeJobs = await ctx.db.query("jobs")
      .withIndex("by_status", q => q.eq("status", "active"))
      .collect();

    // 3. Aggregate pipeline stage counts from per-job stageCounts
    const globalStageCounts: Record<string, number> = {};
    for (const job of activeJobs) {
      const sc = job.stageCounts || {};
      for (const [stage, count] of Object.entries(sc)) {
        globalStageCounts[stage] = (globalStageCounts[stage] || 0) + (count as number);
      }
    }

    // 4. Compute derived metrics from the aggregated counts
    const shortlistStages = ["ta_shortlist", "second_shortlist", "director_shortlist", "client_review"];
    const shortlisted = shortlistStages.reduce((sum, s) => sum + (globalStageCounts[s] || 0), 0);
    const interviews = globalStageCounts["interview"] || 0;
    const placements = globalStageCounts["placed"] || 0;

    // 5. Source distribution aggregated from last 30 daily stats records
    const recentDailyStats = await ctx.db.query("dailyStats").order("desc").take(30);
    const sourceTotals: Record<string, number> = {};
    let totalFromSources = 0;

    for (const dayStat of recentDailyStats) {
      const bySource = dayStat.cvsBySource || {};
      for (const [source, count] of Object.entries(bySource)) {
        const sourceName = source || "database";
        const countNum = (count as number) || 0;
        sourceTotals[sourceName] = (sourceTotals[sourceName] || 0) + countNum;
        totalFromSources += countNum;
      }
    }

    const sourceDistribution = Object.entries(sourceTotals)
      .map(([name, count]) => ({
        name,
        count,
        percentage: Math.round((count / Math.max(totalFromSources, 1)) * 100),
      }))
      .sort((a, b) => b.count - a.count);

    // 6. Pipeline distribution for bar chart
    const pipelineStages = [
      { id: "new_cvs", label: "New CVs" },
      { id: "matched_candidates", label: "Matched" },
      { id: "ta_shortlist", label: "TA Shortlist" },
      { id: "ai_call", label: "AI Screened" },
      { id: "director_shortlist", label: "Director Review" },
      { id: "client_review", label: "Client Review" },
      { id: "interview", label: "Interview" },
      { id: "offer", label: "Offer" },
      { id: "placed", label: "Placed" },
    ];

    const totalStageCount = Object.values(globalStageCounts).reduce((a, b) => a + b, 0);
    const pipelineDistribution = pipelineStages.map((stage) => {
      const count = globalStageCounts[stage.id] || 0;
      return {
        ...stage,
        count,
        percentage: Math.round((count / Math.max(totalStageCount, 1)) * 100),
      };
    });

    return {
      totalCVs,
      activeJobs: activeJobs.length,
      shortlisted,
      interviews,
      placements,
      sourceDistribution,
      pipelineDistribution,
    };
  },
});
