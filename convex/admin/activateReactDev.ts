import { mutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";

export default mutation({
  handler: async (ctx) => {
    // Only activate this job
    // Only activate this job
    const jobId = "m1767he2f504zqhdgcrwng0fwn8a23n7" as Id<"jobs">; // Senior React Developer
    await ctx.db.patch(jobId, { status: "active", updatedAt: new Date().toISOString() });
    
    return "Activated Senior React Developer job.";
  }
});
