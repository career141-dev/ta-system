import { mutation } from "../_generated/server";
import { v } from "convex/values";

export const migrate = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Calculate global stats
    const candidates = await ctx.db.query("candidates").collect();
    const cvUploads = await ctx.db.query("cvUploads").collect();
    const jobs = await ctx.db.query("jobs").collect();
    const applications = await ctx.db.query("applications").collect();

    const totalCandidates = candidates.length;
    const totalCvUploads = cvUploads.length;
    const totalApplications = applications.length;
    const activeJobsCount = jobs.filter(j => j.status === "active").length;

    const existingSysStat = await ctx.db.query("systemStats")
      .withIndex("by_singletonKey", q => q.eq("singletonKey", "global_stats"))
      .first();

    if (existingSysStat) {
      await ctx.db.patch(existingSysStat._id, {
        totalCandidates,
        totalCvUploads,
        totalApplications,
        activeJobsCount,
      });
    } else {
      await ctx.db.insert("systemStats", {
        singletonKey: "global_stats",
        totalCandidates,
        totalCvUploads,
        totalApplications,
        activeJobsCount,
      });
    }

    // 2. Initialize dailyStats for the last 60 days
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    // Group everything by day
    const dailyData: Record<string, any> = {};
    for (let i = 0; i < 60; i++) {
      const d = new Date(now - i * oneDay);
      const dateStr = d.toISOString().split("T")[0];
      dailyData[dateStr] = {
        newCandidates: 0,
        newCvUploads: 0,
        newApplications: 0,
        newJobs: 0,
        placements: 0,
        cvsBySource: {}
      };
    }

    const sixtyDaysAgo = now - 60 * oneDay;

    for (const c of candidates) {
      if (c._creationTime >= sixtyDaysAgo) {
        const dateStr = new Date(c._creationTime).toISOString().split("T")[0];
        if (dailyData[dateStr]) dailyData[dateStr].newCandidates++;
      }
    }

    for (const cv of cvUploads) {
      if (cv._creationTime >= sixtyDaysAgo) {
        const dateStr = new Date(cv._creationTime).toISOString().split("T")[0];
        if (dailyData[dateStr]) {
          dailyData[dateStr].newCvUploads++;
          const source = cv.source || "Manual";
          if (!dailyData[dateStr].cvsBySource[source]) dailyData[dateStr].cvsBySource[source] = 0;
          dailyData[dateStr].cvsBySource[source]++;
        }
      }
    }

    for (const app of applications) {
      if (app._creationTime >= sixtyDaysAgo) {
        const dateStr = new Date(app._creationTime).toISOString().split("T")[0];
        if (dailyData[dateStr]) dailyData[dateStr].newApplications++;
      }
      
      if (app.currentStage === "placed" && app.lastStageChangedAt >= sixtyDaysAgo) {
        const dateStr = new Date(app.lastStageChangedAt).toISOString().split("T")[0];
        if (dailyData[dateStr]) dailyData[dateStr].placements++;
      }
    }

    for (const j of jobs) {
      if (j._creationTime >= sixtyDaysAgo && j.status !== "draft") { // Just approximate
        const dateStr = new Date(j._creationTime).toISOString().split("T")[0];
        if (dailyData[dateStr]) dailyData[dateStr].newJobs++;
      }
    }

    for (const [dateStr, data] of Object.entries(dailyData)) {
      const existingDaily = await ctx.db.query("dailyStats")
        .withIndex("by_dateStr", q => q.eq("dateStr", dateStr))
        .first();
        
      if (existingDaily) {
        await ctx.db.patch(existingDaily._id, data);
      } else {
        await ctx.db.insert("dailyStats", {
          dateStr,
          ...data
        });
      }
    }

    return { success: true, message: "Migration completed successfully" };
  }
});
