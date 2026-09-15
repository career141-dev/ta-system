import { mutation } from "../_generated/server";

export const migrateCandidates = mutation({
  handler: async (ctx) => {
    // Process in batches of 100 to avoid hitting mutation limits
    const candidates = await ctx.db.query("candidates").take(100);
    let migratedCount = 0;
    let newCount = 0;    // CVs inserted as brand-new candidateResumes records
    let mergeCount = 0;  // CVs merged/patched into existing candidateResumes records

    for (const candidate of candidates) {
      let needsUpdate = false;
      const updates: any = {};

      const c = candidate as any;
      if (c.rawText !== undefined || c.jobHistory !== undefined || c.embedding !== undefined) {
        needsUpdate = true;
        // Check if a resume already exists for this candidate
        const existingResume = await ctx.db
          .query("candidateResumes")
          .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
          .first();

        if (!existingResume) {
          await ctx.db.insert("candidateResumes", {
            candidateId: candidate._id,
            rawText: c.rawText ?? "",
            jobHistory: c.jobHistory,
            embedding: c.embedding,
            hasEmbedding: !!(c.embedding && c.embedding.length > 0),
          });
          newCount++;
        } else if (c.embedding && !existingResume.embedding) {
          // If resume exists but lacks embedding, patch it
          await ctx.db.patch(existingResume._id, { 
            embedding: c.embedding,
            hasEmbedding: true,
          });
          mergeCount++;
        } else {
          // Resume already exists and is up to date — counted as merge/dedup
          mergeCount++;
        }

        // Compute pastJobTitles
        let pastJobTitles: string[] | undefined = undefined;
        if (c.jobHistory && c.jobHistory.length > 0) {
          pastJobTitles = c.jobHistory.map((j: any) => j.title).filter((t: any) => !!t);
        }

        updates.rawText = undefined;
        updates.jobHistory = undefined;
        updates.embedding = undefined;
        updates.pastJobTitles = pastJobTitles;
      }

      if (candidate.phone && !candidate.phoneClean) {
        needsUpdate = true;
        updates.phoneClean = candidate.phone.replace(/[^0-9]/g, "");
      }

      if (needsUpdate) {
        await ctx.db.patch(candidate._id, updates);
        migratedCount++;
      }
    }

    return {
      migratedCount,
      newCount,
      mergeCount,
      hasMore: candidates.length === 100,
    };
  },
});
