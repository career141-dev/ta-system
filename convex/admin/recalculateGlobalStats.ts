import { mutation } from "../_generated/server";

export const run = mutation({
  handler: async (ctx) => {
    // 1. Recount Global Stats across all tables
    const candidates = await ctx.db.query("candidates").collect();
    const cvs = await ctx.db.query("cvs").collect();
    const uploads = await ctx.db.query("cvUploads").collect();
    const applications = await ctx.db.query("applications").collect();
    const jobs = await ctx.db.query("jobs").filter(q => q.eq(q.field("status"), "active")).collect();
    
    const effectiveCandidatesCount = candidates.length;
    const effectiveUploadsCount = Math.max(uploads.length, cvs.length);

    let sysStat = await ctx.db.query("systemStats")
      .withIndex("by_singletonKey", (q: any) => q.eq("singletonKey", "global_stats"))
      .first();
      
    if (sysStat) {
      await ctx.db.patch(sysStat._id, {
        totalCandidates: effectiveCandidatesCount,
        totalCvUploads: effectiveUploadsCount,
        totalApplications: applications.length,
        activeJobsCount: jobs.length,
      });
    } else {
      await ctx.db.insert("systemStats", {
        singletonKey: "global_stats",
        totalCandidates: effectiveCandidatesCount,
        totalCvUploads: effectiveUploadsCount,
        totalApplications: applications.length,
        activeJobsCount: jobs.length,
      });
    }

    // 2. Clear stale dashboard stats cache so getDashboardStats reads fresh systemStats
    const cachedStats = await ctx.db.query("dashboardStatsCache")
      .withIndex("by_singletonKey", (q: any) => q.eq("singletonKey", "global_dashboard_stats"))
      .first();

    if (cachedStats) {
      await ctx.db.delete(cachedStats._id);
    }
    
    // 3. Recount Daily Stats for Today
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const startOfToday = new Date(todayStr + "T00:00:00Z").getTime();
    
    const uploadsToday = uploads.filter(u => u._creationTime >= startOfToday);
    const cvsToday = cvs.filter(c => c._creationTime >= startOfToday);
    const candidatesToday = candidates.filter(c => c._creationTime >= startOfToday);
    const applicationsToday = applications.filter(a => a._creationTime >= startOfToday);
    const jobsToday = jobs.filter(j => j._creationTime >= startOfToday);
    const totalUploadsToday = Math.max(uploadsToday.length, cvsToday.length);
    
    let dailyStat = await ctx.db.query("dailyStats")
      .withIndex("by_dateStr", (q: any) => q.eq("dateStr", todayStr))
      .first();
      
    if (dailyStat) {
      await ctx.db.patch(dailyStat._id, {
        newCvUploads: totalUploadsToday,
        newCandidates: candidatesToday.length,
        newApplications: applicationsToday.length,
        newJobs: jobsToday.length,
      });
    } else {
      await ctx.db.insert("dailyStats", {
        dateStr: todayStr,
        newCvUploads: totalUploadsToday,
        newCandidates: candidatesToday.length,
        newApplications: applicationsToday.length,
        newJobs: jobsToday.length,
        placements: 0,
        cvsBySource: {},
      });
    }
    
    return {
      message: "Recalculated global and daily stats",
      candidatesCount: candidates.length,
      cvsCount: cvs.length,
      uploadsCount: uploads.length,
      effectiveCandidatesTotal: effectiveCandidatesCount,
      uploadsToday: totalUploadsToday,
      candidatesToday: candidatesToday.length
    };
  }
});
