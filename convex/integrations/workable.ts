// V8 runtime — mutations and queries for Workable import tracking
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";

export const createImportJob = internalMutation({
  args: {
    userId: v.string(),
    totalCandidates: v.number(),
    maxCandidates: v.optional(v.number()),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("workableImports", {
      status: "running",
      totalCandidates: args.totalCandidates,
      maxCandidates: args.maxCandidates,
      imported: 0,
      skipped: 0,
      failed: 0,
      userId: args.userId,
      startedAt: new Date().toISOString(),
      subdomain: args.subdomain,
      apiKey: args.apiKey,
    });
  },
});

export const updateImportJob = internalMutation({
  args: {
    importId: v.id("workableImports"),
    imported: v.optional(v.number()),
    skipped: v.optional(v.number()),
    deduplicated: v.optional(v.number()),
    failed: v.optional(v.number()),
    totalCandidates: v.optional(v.number()),
    maxCandidates: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("stopped"), v.literal("paused"))
    ),
    errorMessage: v.optional(v.string()),
    lastCursor: v.optional(v.string()),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    candidateIndex: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { importId, ...rest } = args;
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rest)) {
      if (val !== undefined) patch[k] = val;
    }
    await ctx.db.patch(importId, patch);
  },
});

export const getImportJob = internalQuery({
  args: { importId: v.id("workableImports") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.importId);
  },
});

export const getLatestImportJob = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("workableImports").order("desc").first();
  },
});

export const stopAllRunningWorkableImports = mutation({
  args: {},
  handler: async (ctx) => {
    const runningJobs = await ctx.db
      .query("workableImports")
      .filter((q) => q.eq(q.field("status"), "running"))
      .collect();

    let stoppedCount = 0;
    for (const job of runningJobs) {
      await ctx.db.patch(job._id, {
        status: "stopped",
        errorMessage: "Import stopped by user.",
      });
      stoppedCount++;
    }

    return { stoppedCount, message: `Stopped ${stoppedCount} running Workable import jobs.` };
  },
});

export const insertCvUpload = internalMutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    storageProvider: v.optional(v.string()),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("cvUploads", {
      storageId: args.storageId,
      s3Key: args.s3Key,
      storageProvider: args.storageProvider,
      fileName: args.fileName,
      fileType: args.fileType,
      fileSize: args.fileSize,
      source: "Workable",
      uploadedBy: args.userId,
      status: "pending",
    });
  },
});

export const findCandidateByWorkableId = internalQuery({
  args: { workableCandidateId: v.string() },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("candidates")
      .withIndex("by_workableCandidateId", (q) =>
        q.eq("workableCandidateId", args.workableCandidateId)
      )
      .first();
    return entry ?? null;
  },
});

export const clearImportHistory = mutation({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query("workableImports").take(100);
    for (const job of jobs) {
      await ctx.db.delete(job._id);
    }
    return { deleted: jobs.length };
  },
});

export const getLatestImportStatus = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let job = null;
    const uid = args.userId;
    if (uid) {
      job = await ctx.db
        .query("workableImports")
        .withIndex("by_user", (q) => q.eq("userId", uid))
        .order("desc")
        .first();
    }
    if (!job) {
      job = await ctx.db.query("workableImports").order("desc").first();
    }
    if (!job) return null;
    return { ...job, deduplicated: job.deduplicated ?? 0 };
  },
});

export const getImportStatus = query({
  args: { importId: v.id("workableImports") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.importId);
    if (!job) return null;
    return { ...job, deduplicated: job.deduplicated ?? 0 };
  },
});
