import { Id } from "../_generated/dataModel";

export type StatEventType = 
  | "new_candidate" 
  | "new_cv_upload" 
  | "new_application" 
  | "deleted_application"
  | "new_job"
  | "closed_job"
  | "placement";

export async function adjustGlobalStat(
  ctx: any, 
  eventType: StatEventType, 
  delta: number = 1,
  metadata?: { sourceChannel?: string }
) {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD (UTC)

  // 1. Ensure System Stats exists
  let sysStat = await ctx.db.query("systemStats")
    .withIndex("by_singletonKey", (q: any) => q.eq("singletonKey", "global_stats"))
    .first();
    
  if (!sysStat) {
    const id = await ctx.db.insert("systemStats", {
      singletonKey: "global_stats",
      totalCandidates: 47667,
      totalCvUploads: 75158,
      totalApplications: 0,
      activeJobsCount: 0,
    });
    sysStat = await ctx.db.get(id);
  }

  // 2. Ensure Daily Stats exists
  let dailyStat = await ctx.db.query("dailyStats")
    .withIndex("by_dateStr", (q: any) => q.eq("dateStr", dateStr))
    .first();
    
  if (!dailyStat) {
    const id = await ctx.db.insert("dailyStats", {
      dateStr,
      newCandidates: 0,
      newCvUploads: 0,
      newApplications: 0,
      newJobs: 0,
      placements: 0,
      cvsBySource: {},
    });
    dailyStat = await ctx.db.get(id);
  }

  // 3. Prepare Updates
  const sysUpdate: any = {};
  const dailyUpdate: any = {};

  switch (eventType) {
    case "new_candidate":
      sysUpdate.totalCandidates = (sysStat.totalCandidates || 0) + delta;
      dailyUpdate.newCandidates = (dailyStat.newCandidates || 0) + delta;
      break;
    case "new_cv_upload":
      sysUpdate.totalCvUploads = (sysStat.totalCvUploads || 0) + delta;
      dailyUpdate.newCvUploads = (dailyStat.newCvUploads || 0) + delta;
      
      if (metadata?.sourceChannel) {
        const currentCvsBySource = dailyStat.cvsBySource || {};
        const source = metadata.sourceChannel;
        const currentCount = currentCvsBySource[source] || 0;
        dailyUpdate.cvsBySource = {
          ...currentCvsBySource,
          [source]: currentCount + delta
        };
      }
      break;
    case "new_application":
      sysUpdate.totalApplications = (sysStat.totalApplications || 0) + delta;
      dailyUpdate.newApplications = (dailyStat.newApplications || 0) + delta;
      break;
    case "deleted_application":
      sysUpdate.totalApplications = Math.max(0, (sysStat.totalApplications || 0) - delta);
      break;
    case "new_job":
      sysUpdate.activeJobsCount = (sysStat.activeJobsCount || 0) + delta;
      dailyUpdate.newJobs = (dailyStat.newJobs || 0) + delta;
      break;
    case "closed_job":
      sysUpdate.activeJobsCount = Math.max(0, (sysStat.activeJobsCount || 0) - delta);
      break;
    case "placement":
      dailyUpdate.placements = (dailyStat.placements || 0) + delta;
      break;
  }

  // 4. Apply Updates
  if (Object.keys(sysUpdate).length > 0) {
    await ctx.db.patch(sysStat._id, sysUpdate);
  }
  
  if (Object.keys(dailyUpdate).length > 0) {
    await ctx.db.patch(dailyStat._id, dailyUpdate);
  }
}
