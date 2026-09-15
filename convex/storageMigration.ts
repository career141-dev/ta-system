import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

export const inspectSampleCandidateUploads = query({
  args: {},
  handler: async (ctx) => {
    const cvUploads = await ctx.db.query("cvUploads").take(15);
    const candidates = await ctx.db.query("candidates").take(15);
    return { cvUploads, candidates };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const linkHistoricalCvFile = mutation({
  args: {
    oldStorageId: v.string(),
    newStorageId: v.id("_storage"),
    fileHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const cleanId = args.oldStorageId.replace(/\.[^/.]+$/, "");

    // 1. Indexed lookup on cvUploads by storageId
    let upload = await ctx.db
      .query("cvUploads")
      .withIndex("by_storageId", (q) => q.eq("storageId" as any, args.oldStorageId as any))
      .first();

    if (!upload && cleanId !== args.oldStorageId) {
      upload = await ctx.db
        .query("cvUploads")
        .withIndex("by_storageId", (q) => q.eq("storageId" as any, cleanId as any))
        .first();
    }

    // 2. Indexed lookup on cvUploads by fileHash
    if (!upload && args.fileHash) {
      upload = await ctx.db
        .query("cvUploads")
        .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash!))
        .first();
    }

    // 3. Search candidate profile by fileHash
    if (!upload && args.fileHash) {
      const candidate = await ctx.db
        .query("candidates")
        .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash!))
        .first();

      if (candidate && candidate.cvUploadId) {
        upload = await ctx.db.get(candidate.cvUploadId);
      }
    }

    if (upload) {
      await ctx.db.patch(upload._id, {
        storageId: args.newStorageId,
        status: "processed",
      });

      // Update candidate reference if needed
      if (upload.candidateId) {
        const cand = await ctx.db.get(upload.candidateId);
        if (cand) {
          await ctx.db.patch(cand._id, {
            cvUploadId: upload._id,
          });
        }
      }
      return { success: true, matchedUploadId: upload._id, fileName: upload.fileName };
    }

    return { success: false, reason: "No matching database record" };
  },
});

export const cleanExistingReverseMatches = mutation({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query("jobs").collect();
    let updatedCount = 0;
    for (const job of jobs) {
      if (job.reverseMatchResults) {
        const filtered = job.reverseMatchResults.filter((r) => r.overallScore >= 60);
        if (filtered.length !== job.reverseMatchResults.length) {
          await ctx.db.patch(job._id, {
            reverseMatchResults: filtered,
          });
          updatedCount++;
        }
      }
    }
    return { updatedCount, totalJobs: jobs.length };
  },
});
