import { mutation } from "../_generated/server";
import { v } from "convex/values";

export const cleanupHeavyFields = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit || 100;
    
    // Find candidates that still have rawText, embedding, or jobHistory
    // Convex doesn't allow filtering by field existence directly in a query without a full table scan,
    // so we'll just scan the table and fix up to 'limit' records.
    
    const candidates = await ctx.db.query("candidates").order("desc").take(limit);
    let count = 0;
    
    for (const c of candidates) {
      const updates: any = {};
      
      if ((c as any).rawText !== undefined) updates.rawText = undefined;
      if ((c as any).embedding !== undefined) updates.embedding = undefined;
      if ((c as any).jobHistory !== undefined) updates.jobHistory = undefined;
      
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(c._id, updates);
        count++;
      }
    }
    
    return {
      message: `Cleaned up ${count} candidates out of ${candidates.length} scanned.`,
      processed: candidates.length,
      cleaned: count,
    };
  }
});

// A paginated version to run over all candidates
export const cleanupAllHeavyFields = mutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const q = ctx.db.query("candidates");
    const result = await q.paginate({ cursor: args.cursor ?? null, numItems: 100 });
    
    let count = 0;
    for (const c of result.page) {
      const updates: any = {};
      
      if ((c as any).rawText !== undefined) updates.rawText = undefined;
      if ((c as any).embedding !== undefined) updates.embedding = undefined;
      if ((c as any).jobHistory !== undefined) updates.jobHistory = undefined;
      
      if (Object.keys(updates).length > 0) {
        // Before deleting, make sure candidateResumes has them!
        const existingResume = await ctx.db.query("candidateResumes")
          .withIndex("by_candidateId", (q: any) => q.eq("candidateId", c._id))
          .first();
          
        if (existingResume) {
          const resumeUpdates: any = {};
          if ((c as any).rawText && !existingResume.rawText) resumeUpdates.rawText = (c as any).rawText;
          if ((c as any).embedding && !existingResume.embedding) resumeUpdates.embedding = (c as any).embedding;
          if ((c as any).jobHistory && !existingResume.jobHistory) resumeUpdates.jobHistory = (c as any).jobHistory;
          
          if (Object.keys(resumeUpdates).length > 0) {
            await ctx.db.patch(existingResume._id, resumeUpdates);
          }
        } else {
          if ((c as any).rawText || (c as any).jobHistory || (c as any).embedding) {
            await ctx.db.insert("candidateResumes", {
              candidateId: c._id,
              rawText: (c as any).rawText || "",
              jobHistory: (c as any).jobHistory,
              embedding: (c as any).embedding,
            });
          }
        }
        
        await ctx.db.patch(c._id, updates);
        count++;
      }
    }
    
    return {
      cleaned: count,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  }
});

export const muteTechLeadJob = mutation({
  args: {},
  handler: async (ctx) => {
    const job = await ctx.db.query("jobs").withIndex("by_keyword", (q) => q.eq("keyword", "TECHLEAD")).first();
    if (job) {
      await ctx.db.patch(job._id, { muteDefaultWhatsappReply: true });
      return "Muted TECHLEAD job successfully!";
    }
    return "Job not found";
  },
});
