import { action, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";

export const registerFolderCandidateUpload = mutation({
  args: {
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    s3Key: v.string(),
    uploadedBy: v.string(),
    sourceChannel: v.optional(v.string()),
    batchIndex: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ cvUploadId: string; s3Key: string }> => {
    const sourceChannel = args.sourceChannel || "Manual Directory Import";

    // 1. Save cvUploads record
    const cvUploadId: any = await ctx.db.insert("cvUploads", {
      s3Key: args.s3Key,
      storageProvider: "r2",
      fileName: args.fileName,
      fileSize: args.fileSize,
      fileType: args.fileType,
      source: sourceChannel,
      uploadedBy: args.uploadedBy,
      status: "uploaded",
    });

    // 2. Queue background DeepSeek V4 Flash AI extraction
    const delayMs = (args.batchIndex ?? 0) * 500; // Paced 500ms delay per candidate in batch
    await ctx.runMutation(api.cvs.cvUploads.queueManualExtraction, {
      cvUploadId,
      s3Key: args.s3Key,
      storageProvider: "r2",
      fileName: args.fileName,
      fileType: args.fileType,
      sourceChannel,
      uploadedBy: args.uploadedBy,
      delayMs,
    });

    return { cvUploadId, s3Key: args.s3Key };
  },
});

export const uploadFolderCandidate = action({
  args: {
    fileName: v.string(),
    fileType: v.string(),
    base64Data: v.string(),
    uploadedBy: v.string(),
    sourceChannel: v.optional(v.string()),
    batchIndex: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ cvUploadId: string; s3Key: string; isSkipped?: boolean }> => {
    const sourceChannel = args.sourceChannel || "Manual Directory Import";

    // 0. Pre-check if this file was already uploaded in a previous import session
    const existingCheck = await ctx.runQuery(api.cvs.cvUploads.checkUploadedFile, {
      fileName: args.fileName,
      sourceChannel,
    });

    if (existingCheck.isUploaded && existingCheck.cvUploadId) {
      return {
        cvUploadId: existingCheck.cvUploadId,
        s3Key: existingCheck.s3Key || "",
        isSkipped: true,
      };
    }

    // 1. Upload CV buffer to Cloudflare R2 storage
    const s3Key: string = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
      fileName: args.fileName,
      contentType: args.fileType === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64Data: args.base64Data,
    });

    const fileSize = Math.round((args.base64Data.length * 3) / 4);

    // 2. Save cvUploads record
    const cvUploadId: any = await ctx.runMutation(api.cvs.cvUploads.saveUpload, {
      s3Key,
      storageProvider: "r2",
      fileName: args.fileName,
      fileSize,
      fileType: args.fileType,
      source: sourceChannel,
      uploadedBy: args.uploadedBy,
    });

    // 3. Queue background DeepSeek V4 Flash AI extraction
    const delayMs = (args.batchIndex ?? 0) * 500; // Paced 500ms delay per candidate in batch
    await ctx.runMutation(api.cvs.cvUploads.queueManualExtraction, {
      cvUploadId,
      s3Key,
      storageProvider: "r2",
      fileName: args.fileName,
      fileType: args.fileType,
      sourceChannel,
      uploadedBy: args.uploadedBy,
      delayMs,
    });

    return { cvUploadId, s3Key };
  },
});

export const getFolderImportProgress = query({
  args: {
    sourceChannel: v.optional(v.string()),
    rootFolderName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sourceChannel = args.sourceChannel || "Manual Directory Import";

    if (args.rootFolderName) {
      const folderRecord = await ctx.db
        .query("folderImportProgress")
        .withIndex("by_channel_folder", (q) =>
          q.eq("sourceChannel", sourceChannel).eq("rootFolderName", args.rootFolderName)
        )
        .first();

      return folderRecord || null;
    }

    const record = await ctx.db
      .query("folderImportProgress")
      .withIndex("by_sourceChannel", (q) => q.eq("sourceChannel", sourceChannel))
      .first();

    return record || null;
  },
});

export const updateFolderImportProgress = mutation({
  args: {
    sourceChannel: v.optional(v.string()),
    rootFolderName: v.optional(v.string()),
    lastProcessedIndex: v.number(),
    lastProcessedFolderName: v.string(),
    totalDiscoveredFolders: v.optional(v.number()),
    uploadedCount: v.number(),
    skippedCount: v.number(),
    failedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const sourceChannel = args.sourceChannel || "Manual Directory Import";
    let existing;

    if (args.rootFolderName) {
      existing = await ctx.db
        .query("folderImportProgress")
        .withIndex("by_channel_folder", (q) =>
          q.eq("sourceChannel", sourceChannel).eq("rootFolderName", args.rootFolderName)
        )
        .first();
    } else {
      existing = await ctx.db
        .query("folderImportProgress")
        .withIndex("by_sourceChannel", (q) => q.eq("sourceChannel", sourceChannel))
        .first();
    }

    const payload = {
      sourceChannel,
      rootFolderName: args.rootFolderName,
      lastProcessedIndex: args.lastProcessedIndex,
      lastProcessedFolderName: args.lastProcessedFolderName,
      totalDiscoveredFolders: args.totalDiscoveredFolders,
      uploadedCount: args.uploadedCount,
      skippedCount: args.skippedCount,
      failedCount: args.failedCount,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    } else {
      return await ctx.db.insert("folderImportProgress", payload);
    }
  },
});

export const resetFolderImportProgress = mutation({
  args: {
    sourceChannel: v.optional(v.string()),
    rootFolderName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sourceChannel = args.sourceChannel || "Manual Directory Import";

    if (args.rootFolderName) {
      const records = await ctx.db
        .query("folderImportProgress")
        .withIndex("by_channel_folder", (q) =>
          q.eq("sourceChannel", sourceChannel).eq("rootFolderName", args.rootFolderName)
        )
        .collect();

      for (const rec of records) {
        await ctx.db.delete(rec._id);
      }
      return { resetCount: records.length };
    }

    const records = await ctx.db
      .query("folderImportProgress")
      .withIndex("by_sourceChannel", (q) => q.eq("sourceChannel", sourceChannel))
      .collect();

    for (const rec of records) {
      await ctx.db.delete(rec._id);
    }
    return { resetCount: records.length };
  },
});
