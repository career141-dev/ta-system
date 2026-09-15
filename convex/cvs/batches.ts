import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { api } from "../_generated/api";

export const createBatch = mutation({
  args: {
    sourceChannel: v.string(),
    totalCount: v.number(),
    jobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    const batchId = await ctx.db.insert("ingestionBatches", {
      sourceChannel: args.sourceChannel,
      totalCount: args.totalCount,
      completedCount: 0,
      failedCount: 0,
      status: "in_progress",
      startedAt: Date.now(),
      jobId: args.jobId,
    });
    return batchId;
  },
});

export const updateBatchProgress = mutation({
  args: {
    batchId: v.id("ingestionBatches"),
    status: v.union(v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db.get(args.batchId);
    if (!batch) return;

    const updates: any = {};
    let newCompletedCount = batch.completedCount;
    let newFailedCount = batch.failedCount;

    if (args.status === "completed") {
      newCompletedCount += 1;
      updates.completedCount = newCompletedCount;
    } else {
      newFailedCount += 1;
      updates.failedCount = newFailedCount;
    }

    if (newCompletedCount + newFailedCount >= batch.totalCount) {
      updates.status = "completed";
      updates.completedAt = Date.now();
    }

    await ctx.db.patch(args.batchId, updates);
  },
});

export const getBatch = query({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.batchId);
  },
});

export const getBatchLogs = query({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ingestionLog")
      .withIndex("by_batchId", (q) => q.eq("batchId", args.batchId))
      .order("desc")
      .collect();
  },
});

export const updateLogStage = mutation({
  args: {
    logId: v.id("ingestionLog"),
    stage: v.string(),
    errorMessage: v.optional(v.string()),
    candidateName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: any = { stage: args.stage };
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.candidateName !== undefined) updates.candidateName = args.candidateName;
    if (args.stage === "completed" || args.stage === "failed") {
      updates.processedAt = Date.now();
      const log = await ctx.db.get(args.logId);
      if (log) {
        updates.processingTimeMs = Date.now() - log.receivedAt;
      }
    }
    await ctx.db.patch(args.logId, updates);
  },
});

export const getLatestActiveBatch = query({
  args: {},
  handler: async (ctx) => {
    // Find the most recent batch that is in_progress
    const activeBatch = await ctx.db
      .query("ingestionBatches")
      .withIndex("by_status", (q) => q.eq("status", "in_progress"))
      .order("desc")
      .first();

    return activeBatch ? activeBatch._id : null;
  },
});

export const pauseBatch = mutation({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.batchId, { paused: true });
  },
});

export const resumeBatchIngestion = mutation({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.batchId, { paused: false });
    // Immediately check and trigger next chunk
    await ctx.scheduler.runAfter(0, api.cvs.cvUploads.checkAndTriggerNextBatch, {
      batchId: args.batchId,
    });
  },
});

export const cancelBatch = mutation({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.batchId, {
      status: "failed",
      completedAt: Date.now(),
    });

    const uploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_batchId", (q) => q.eq("batchId", args.batchId))
      .collect();

    let cancelledCount = 0;
    for (const upload of uploads) {
      if (upload.status === "queued" || upload.status === "processing" || upload.status === "pending_retry") {
        await ctx.db.patch(upload._id, {
          status: "failed",
          errorMessage: "Cancelled by user",
        });
        cancelledCount++;
      }
    }
    return { success: true, cancelledCount };
  },
});
