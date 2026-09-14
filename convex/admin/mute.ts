import { mutation } from "../_generated/server";

export const muteTechLead = mutation({
  args: {},
  handler: async (ctx) => {
    const job = await ctx.db.query("jobs").withIndex("by_keyword", (q) => q.eq("keyword", "TECHLEAD")).first();
    if (job) {
      await ctx.db.patch(job._id, { muteDefaultWhatsappReply: true });
      return "Muted TECHLEAD job";
    }
    return "Job not found";
  }
});
