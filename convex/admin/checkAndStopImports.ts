import { mutation, query } from "../_generated/server";

export const checkAndStopActiveImports = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Check zipImportJobs
    const zipJobs = await ctx.db.query("zipImportJobs").collect();
    let zipStopped = 0;
    for (const job of zipJobs) {
      if (job.status === "running" || job.status === "paused") {
        await ctx.db.patch(job._id, {
          status: "stopped",
          errorMessage: "Stopped by user request",
        });
        zipStopped++;
      }
    }

    // 2. Check workableImports
    const workableJobs = await ctx.db.query("workableImports").collect();
    let workableStopped = 0;
    for (const job of workableJobs) {
      if (job.status === "running" || job.status === "paused") {
        await ctx.db.patch(job._id, {
          status: "stopped",
          errorMessage: "Stopped by user request",
        });
        workableStopped++;
      }
    }

    return {
      success: true,
      zipJobsTotal: zipJobs.length,
      zipJobsStopped: zipStopped,
      workableJobsTotal: workableJobs.length,
      workableJobsStopped: workableStopped,
    };
  },
});
