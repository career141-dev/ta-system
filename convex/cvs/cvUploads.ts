import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { query, mutation, internalQuery, internalMutation } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { adjustGlobalStat } from "../stats/statsHelper";
import { requireUser, requireFullAccess } from "../lib/permissions";

export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveUpload = mutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    storageProvider: v.optional(v.string()),
    fileName: v.string(),
    fileSize: v.float64(),
    fileType: v.string(),
    source: v.optional(v.string()),
    campaignLabel: v.optional(v.string()),
    assignToJob: v.optional(v.string()),
    uploadedBy: v.string(),
    batchId: v.optional(v.id("ingestionBatches")),
  },
  handler: async (ctx, args) => {
    const cvId = await ctx.db.insert("cvUploads", {
      storageId: args.storageId,
      s3Key: args.s3Key,
      storageProvider: args.storageProvider || (args.s3Key ? "r2" : "convex"),
      fileName: args.fileName,
      fileSize: args.fileSize,
      fileType: args.fileType,
      source: args.source,
      campaignLabel: args.campaignLabel,
      assignToJob: args.assignToJob,
      uploadedBy: args.uploadedBy,
      batchId: args.batchId,
      status: "uploaded",
    });

    // @ts-ignore
    await adjustGlobalStat(ctx, "new_cv_upload", 1, { sourceChannel: args.source || "Manual" });
    return cvId;
  },
});

export const queueManualExtraction = mutation({
  args: {
    cvUploadId: v.id("cvUploads"),
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    storageProvider: v.optional(v.string()),
    fileName: v.string(),
    fileType: v.string(),
    sourceChannel: v.string(),
    uploadedBy: v.string(),
    batchId: v.optional(v.id("ingestionBatches")),
    isRetry: v.optional(v.boolean()),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const logId = await ctx.db.insert("ingestionLog", {
      channelType: "manual_upload",
      routingStatus: "routed",
      cvFileId: args.cvUploadId,
      receivedAt: Date.now(),
      batchId: args.batchId,
      stage: "queued",
      candidateName: args.fileName,
      rawSender: args.uploadedBy,
    } as any);

    await ctx.scheduler.runAfter(args.delayMs ?? 0, api.cvs.cvExtraction.processCvExtraction, {
      storageId: args.storageId,
      s3Key: args.s3Key,
      storageProvider: args.storageProvider,
      fileType: args.fileType,
      sourceChannel: args.sourceChannel,
      uploadedBy: args.uploadedBy,
      cvUploadId: args.cvUploadId,
      batchId: args.batchId,
      logId,
      isRetry: args.isRetry,
    });

    return logId;
  },
});

export const clearAll = mutation({
  handler: async (ctx) => {
    await requireFullAccess(ctx);
    const all = await ctx.db.query("cvUploads").collect();
    for (const doc of all) {
      await ctx.db.delete(doc._id);
    }
    return all.length;
  },
});

export const deleteStorageFiles = mutation({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    await requireFullAccess(ctx);
    for (const id of args.storageIds) {
      await ctx.storage.delete(id);
    }
    return args.storageIds.length;
  },
});

export const listUploadedInBatch = internalQuery({
  args: {
    batchId: v.id("ingestionBatches"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cvUploads")
      .withIndex("by_batchId", (q) => q.eq("batchId", args.batchId))
      .filter((q) => q.eq(q.field("status"), "uploaded"))
      .take(args.limit);
  },
});

export const checkUploadsStatus = internalQuery({
  args: {
    cvUploadIds: v.array(v.id("cvUploads")),
  },
  handler: async (ctx, args) => {
    const statuses = [];
    for (const id of args.cvUploadIds) {
      const upload = await ctx.db.get(id);
      statuses.push(upload ? upload.status : "failed");
    }
    return statuses;
  },
});

export const checkAndTriggerNextBatch = mutation({
  args: {
    batchId: v.id("ingestionBatches"),
  },
  handler: async (ctx, args) => {
    // Abort if batch is paused
    const batch = await ctx.db.get(args.batchId);
    if (batch?.paused) {
      console.log(`[checkAndTriggerNextBatch] Batch ${args.batchId} is paused. Aborting next trigger.`);
      return;
    }

    // Check if there are any cvUploads in this batch that are STILL "processing" or "queued" or "pending_retry"
    const processingUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_batchId", (q) => q.eq("batchId", args.batchId))
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "processing"),
          q.eq(q.field("status"), "queued"),
          q.eq(q.field("status"), "pending_retry")
        )
      )
      .collect();

    // If there are still uploads processing/queued in the CURRENT active chunk of the batch, do nothing.
    if (processingUploads.length > 0) {
      console.log(`[checkAndTriggerNextBatch] Batch ${args.batchId} has ${processingUploads.length} uploads still processing. Waiting.`);
      return;
    }

    // Atomically grab the next up to 15 uploads (VPS benchmark: 15 concurrent is safe ceiling)
    const nextUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_batchId", (q) => q.eq("batchId", args.batchId))
      .filter((q) => q.eq(q.field("status"), "uploaded"))
      .take(15);

    if (nextUploads.length === 0) {
      console.log(`[checkAndTriggerNextBatch] Batch ${args.batchId} is fully complete.`);
      return;
    }

    console.log(`[checkAndTriggerNextBatch] Triggering next ${nextUploads.length} uploads for batch ${args.batchId}`);

    // Mark them as queued atomically and schedule the extractions
    // For a batch of 10: run first 5 with 2s stagger, and next 5 with a 20s offset delay
    let index = 0;
    for (const upload of nextUploads) {
      await ctx.db.patch(upload._id, { status: "queued" });

      const logId = await ctx.db.insert("ingestionLog", {
        channelType: "manual_upload",
        routingStatus: "routed",
        cvFileId: upload._id,
        receivedAt: Date.now(),
        batchId: args.batchId,
        stage: "queued",
        candidateName: upload.fileName,
        rawSender: upload.uploadedBy,
      });

      const staggerDelayMs = index * 100;

      await ctx.scheduler.runAfter(staggerDelayMs, api.cvs.cvExtraction.processCvExtraction, {
        storageId: upload.storageId as Id<"_storage"> | undefined,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider,
        fileType: upload.fileType,
        sourceChannel: upload.source || "Manual",
        uploadedBy: upload.uploadedBy,
        cvUploadId: upload._id,
        batchId: args.batchId,
        logId: logId,
        isRetry: false,
      });
      index++;
    }
  },
});

export const cancelAllRunningExtractions = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Immediately pause & fail active ingestion batches first (stops next batch triggers in < 5ms)
    const activeBatches = await ctx.db
      .query("ingestionBatches")
      .withIndex("by_status", (q) => q.eq("status", "in_progress"))
      .take(50);

    for (const batch of activeBatches) {
      await ctx.db.patch(batch._id, {
        status: "failed",
        paused: true,
        completedAt: Date.now(),
      });
    }

    // 2. Query bounded active uploads using by_status index (max 30 per status to guarantee < 150ms runtime)
    const queued = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .take(30);

    const processing = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(30);

    const pendingRetry = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "pending_retry"))
      .take(30);

    const activeUploads = [...queued, ...processing, ...pendingRetry];

    let cancelledCount = 0;
    for (const upload of activeUploads) {
      await ctx.db.patch(upload._id, {
        status: "failed",
        errorMessage: "Cancelled by user",
      });
      cancelledCount++;
    }

    return { success: true, cancelledCount, batchesCancelled: activeBatches.length };
  },
});

export const recoverStuckUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(50);

    let count = 0;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const upload of stuck) {
      // Use processingStartedAt (stamped when extraction actually began) if available;
      // fall back to _creationTime only for legacy records that predate the new field.
      const processingStartMs = (upload as any).processingStartedAt ?? upload._creationTime;
      if (processingStartMs < tenMinutesAgo) {
        await ctx.db.patch(upload._id, {
          status: "failed",
          errorMessage: "Process interrupted or timed out (>10m)",
        });
        
        // Also check if this upload is part of a batch
        if (upload.batchId) {
          // Trigger next batch evaluation
          await ctx.scheduler.runAfter(0, api.cvs.cvUploads.checkAndTriggerNextBatch, {
            batchId: upload.batchId as any,
          });
        }
        count++;
      }
    }
    return count;
  },
});

export const recoverStuckUploadsPublic = mutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(50);

    let count = 0;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const upload of stuck) {
      const processingStartMs = (upload as any).processingStartedAt ?? upload._creationTime;
      if (processingStartMs < tenMinutesAgo) {
        await ctx.db.patch(upload._id, {
          status: "failed",
          errorMessage: "Process interrupted or timed out (>10m)",
        });
        
        if (upload.batchId) {
          await ctx.scheduler.runAfter(0, api.cvs.cvUploads.checkAndTriggerNextBatch, {
            batchId: upload.batchId as any,
          });
        }
        count++;
      }
    }
    return count;
  },
});

/**
 * Recovery Tool: Scans all cvUploads in Cloudflare R2 / Convex.
 * If a candidate profile was deleted from the candidates table,
 * this mutation re-enqueues extraction to restore the candidate profile!
 */
export const restoreAllCandidatesFromUploads = mutation({
  args: {},
  handler: async (ctx) => {
    // Process up to 100 uploads per iteration to stay within 1s mutation limits
    const uploadsChunk = await ctx.db.query("cvUploads").take(100);
    let requeued = 0;
    let checkedCount = 0;

    for (const upload of uploadsChunk) {
      checkedCount++;
      let candidateExists = false;
      if (upload.candidateId) {
        const cand = await ctx.db.get(upload.candidateId);
        if (cand) candidateExists = true;
      }

      if (!candidateExists) {
        await ctx.db.patch(upload._id, {
          status: "uploaded",
          candidateId: undefined,
        });

        // Trigger parallel extraction (100ms spread)
        await ctx.scheduler.runAfter(requeued * 100, api.cvs.cvExtraction.processCvExtraction, {
          storageId: upload.storageId as any,
          s3Key: upload.s3Key,
          storageProvider: upload.storageProvider,
          fileType: upload.fileType,
          sourceChannel: upload.source || "Recovery",
          uploadedBy: upload.uploadedBy,
          cvUploadId: upload._id,
        });

        requeued++;
      }
    }

    return { checkedCount, requeuedRestored: requeued };
  },
});

/**
 * Sweeps all unparsed, empty ("Unknown"), or interrupted candidate profiles
 * and schedules AI extraction for each with a 2-second stagger.
 */
export const reparseAllUnextractedCandidates = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Find all candidates that are unparsed or have empty/stub names
    const unparsedCandidates = await ctx.db
      .query("candidates")
      .filter((q) =>
        q.or(
          q.eq(q.field("isParsed"), false),
          q.eq(q.field("fullName"), undefined),
          q.eq(q.field("fullName"), "Unknown"),
          q.eq(q.field("fullName"), "Applicant")
        )
      )
      .take(100);

    let requeued = 0;
    const processedUploadIds = new Set<string>();

    for (const candidate of unparsedCandidates) {
      if (!candidate.cvUploadId) continue;
      const upload = await ctx.db.get(candidate.cvUploadId);
      if (!upload || (!upload.s3Key && !upload.storageId)) continue;

      processedUploadIds.add(upload._id);

      // Reset upload state to pending
      await ctx.db.patch(upload._id, {
        status: "pending",
        isHealAttempted: false,
        errorMessage: undefined,
        candidateId: candidate._id,
      });

      // Schedule extraction with 2-second stagger to prevent rate limits
      await ctx.scheduler.runAfter(requeued * 2000, api.cvs.cvExtraction.processCvExtraction, {
        storageId: upload.storageId as any,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider || "r2",
        fileType: upload.fileType || "pdf",
        sourceChannel: upload.source || candidate.sourceChannel || "Email",
        uploadedBy: upload.uploadedBy || "System Healing",
        cvUploadId: upload._id,
      });

      requeued++;
    }

    // 2. Also check any cvUploads that are stuck in 'failed' or 'uploaded' with no candidate
    const stuckUploads = await ctx.db
      .query("cvUploads")
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "failed"),
          q.eq(q.field("status"), "uploaded")
        )
      )
      .take(50);

    for (const upload of stuckUploads) {
      if (processedUploadIds.has(upload._id)) continue;
      if (!upload.s3Key && !upload.storageId) continue;

      await ctx.db.patch(upload._id, {
        status: "pending",
        isHealAttempted: false,
        errorMessage: undefined,
      });

      await ctx.scheduler.runAfter(requeued * 2000, api.cvs.cvExtraction.processCvExtraction, {
        storageId: upload.storageId as any,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider || "r2",
        fileType: upload.fileType || "pdf",
        sourceChannel: upload.source || "Email",
        uploadedBy: upload.uploadedBy || "System Healing",
        cvUploadId: upload._id,
      });

      requeued++;
    }

    return { scannedCandidates: unparsedCandidates.length, requeuedCount: requeued };
  },
});

/**
 * Returns the count of candidates with isParsed: false or Unknown name
 */
export const getUnextractedCandidatesCount = query({
  args: {},
  handler: async (ctx) => {
    const unparsed = await ctx.db
      .query("candidates")
      .filter((q) =>
        q.or(
          q.eq(q.field("isParsed"), false),
          q.eq(q.field("fullName"), undefined),
          q.eq(q.field("fullName"), "Unknown"),
          q.eq(q.field("fullName"), "Applicant")
        )
      )
      .take(100);

    return unparsed.length;
  },
});

/**
 * Returns list of successfully uploaded/processing filenames for Manual Directory Import
 */
export const getUploadedDirectoryFiles = query({
  args: {
    sourceChannel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Return empty array to prevent client timeout on 12,000+ items.
    // Individual file deduplication is performed O(1) per file via uploadFolderCandidate backend action.
    return [] as string[];
  },
});

/**
 * Checks if a specific file name has already been successfully uploaded for a source channel
 */
export const checkUploadedFile = query({
  args: {
    fileName: v.string(),
    sourceChannel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const targetSource = args.sourceChannel || "Manual Directory Import";
    const existingRecords = await ctx.db
      .query("cvUploads")
      .withIndex("by_source_fileName", (q) =>
        q.eq("source", targetSource).eq("fileName", args.fileName)
      )
      .collect();

    const validExisting = existingRecords.find(
      (r) =>
        r.status === "uploaded" ||
        r.status === "processing" ||
        r.status === "processed" ||
        r.status === "completed" ||
        r.status === "pending_retry"
    );

    if (validExisting) {
      return {
        isUploaded: true,
        cvUploadId: validExisting._id,
        s3Key: validExisting.s3Key || "",
        status: validExisting.status,
      };
    }
    return { isUploaded: false };
  },
});

/**
 * Clears failed cvUploads records for directory import so they can be clean-retried
 */
export const clearFailedDirectoryUploads = mutation({
  args: {
    sourceChannel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const targetSource = args.sourceChannel || "Manual Directory Import";
    const records = await ctx.db
      .query("cvUploads")
      .withIndex("by_source_fileName", (q) => q.eq("source", targetSource))
      .collect();

    const failed = records.filter(
      (r) => r.status === "failed" || r.status === "cancelled" || r.status === "failed_retry"
    );

    for (const rec of failed) {
      await ctx.db.delete(rec._id);
    }

    return { deletedCount: failed.length };
  },
});
/**
 * Atomically claims up to limit 'uploaded' items and marks them 'processing'
 * to prevent race conditions during concurrent worker runs.
 */
export const claimUploadedBatch = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const uploadedRecords = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .take(limit);

    const claimed = [];
    for (const record of uploadedRecords) {
      if (!record.s3Key && !record.storageId) {
        await ctx.db.patch(record._id, {
          status: "failed",
          errorMessage: "File URL not found (neither R2 nor Convex storage)",
        });
        continue;
      }
      await ctx.db.patch(record._id, {
        status: "processing",
        processingStartedAt: Date.now(),
      });
      claimed.push(record);
    }
    return claimed;
  },
});

export const claimUploadedBatchPublic = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const uploadedRecords = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .take(limit);

    const claimed = [];
    for (const record of uploadedRecords) {
      if (!record.s3Key && !record.storageId) {
        await ctx.db.patch(record._id, {
          status: "failed",
          errorMessage: "File URL not found (neither R2 nor Convex storage)",
        });
        continue;
      }
      await ctx.db.patch(record._id, {
        status: "processing",
        processingStartedAt: Date.now(),
      });
      claimed.push(record);
    }
    return claimed;
  },
});

/**
 * Recovery tool: Guarantees ANY cvUploads record without a candidate profile
 * (failed, cancelled, failed_retry, or stuck processing) gets re-queued as 'uploaded'
 * so the background worker extracts it into a complete candidate profile.
 */
export const requeueAllStuckUploads = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;

    const failedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(limit);

    const cancelledList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "cancelled"))
      .take(limit);

    const failedRetryList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed_retry"))
      .take(limit);

    // Also check stuck processing (> 5 mins ago)
    const processingList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(limit);

    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    const stuckProcessing = processingList.filter((u) => {
      const startMs = (u as any).processingStartedAt ?? u._creationTime;
      return startMs < fiveMinsAgo;
    });

    const allStuck = [...failedList, ...cancelledList, ...failedRetryList, ...stuckProcessing]
      .filter((u) => {
        if ((u as any).isHealAttempted) return false;
        if (u.status === "needs_review") return false;
        if (u.errorMessage?.includes("File URL not found")) return false;
        return Boolean(u.s3Key || u.storageId);
      })
      .slice(0, limit);

    let requeuedCount = 0;
    for (const upload of allStuck) {
      if ((!upload.storageId && !upload.s3Key) || upload.errorMessage?.includes("File URL not found") || upload.errorMessage?.includes("No file data")) {
        // Record has no physical file in storage or was deleted — mark permanently failed so it doesn't loop
        await ctx.db.patch(upload._id, {
          status: "failed",
          errorMessage: upload.errorMessage || "No file data associated with this upload record (storage file missing)",
        });
        continue;
      }

      if ((upload.extractionAttempts ?? 0) >= 2) {
        // Exceeded max retry budget — mark for human review to break infinite retry storm
        await ctx.db.patch(upload._id, {
          status: "needs_review",
          errorMessage: `Extraction attempted ${upload.extractionAttempts} times without resolution. Flagged for review.`,
        });
        continue;
      }

      await ctx.db.patch(upload._id, {
        status: "uploaded",
        errorMessage: undefined,
      });
      requeuedCount++;
    }

    return { requeuedCount, remaining: allStuck.length };
  },
});

/**
 * Recovery Tool: Scans all cvUploads for records whose extraction was skipped
 * or failed due to insufficient API credits, resets their status, and re-triggers
 * parallel LLM extraction using refilled credits.
 */
export const recoverCreditDepletedCVs = mutation({
  args: {
    limit: v.optional(v.number()),
    staggerMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchLimit = Math.min(args.limit ?? 30, 50);
    const staggerMs = args.staggerMs ?? 500; // 500ms fast parallel stagger by default

    // 1. Fetch targeted statuses using indexed queries
    const processedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processed"))
      .take(150);

    const failedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(50);

    const failedRetryList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "failed_retry"))
      .take(50);

    const permFailedList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "extraction_failed_permanent"))
      .take(50);

    const processingList = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(100);

    const threeMinsAgo = Date.now() - 3 * 60 * 1000;
    const stuckProcessing = processingList.filter((u) => {
      const startMs = (u as any).processingStartedAt ?? u._creationTime;
      return startMs < threeMinsAgo;
    });

    // 2. Filter for uploads affected by credit depletion or failed/stuck states
    const creditAffectedUploads = [
      ...processedList.filter((u) => {
        const errMsg = (u.errorMessage || "").toLowerCase();
        return (
          errMsg.includes("credit") ||
          errMsg.includes("insufficient") ||
          errMsg.includes("balance") ||
          errMsg.includes("403") ||
          errMsg.includes("quota")
        );
      }),
      ...stuckProcessing,
      ...failedList,
      ...failedRetryList,
      ...permFailedList,
    ]
      .filter((u) => {
        if (u.status === "needs_review") return false;
        return Boolean(u.s3Key || u.storageId);
      })
      .slice(0, batchLimit);

    let requeuedCount = 0;
    for (let i = 0; i < creditAffectedUploads.length; i++) {
      const upload = creditAffectedUploads[i];
      const delayMs = i * staggerMs;

      await ctx.db.patch(upload._id, {
        status: "pending",
        errorMessage: undefined,
        extractionAttempts: 0,
      });

      if (upload.candidateId) {
        const candidateDoc = await ctx.db.get(upload.candidateId);
        if (candidateDoc) {
          await ctx.db.patch(upload.candidateId, {
            isParsed: false,
          });
        }
      }

      const validChannels = ["whatsapp", "meta_campaign", "email", "email_campaign", "linkedin", "workable", "manual_upload", "headhunting"];
      const channelType = validChannels.includes(upload.source || "") ? (upload.source as any) : "manual_upload";

      const logId = await ctx.db.insert("ingestionLog", {
        channelType,
        routingStatus: upload.assignToJob ? "routed" : "unrouted",
        cvFileId: upload._id,
        candidateId: upload.candidateId,
        receivedAt: Date.now(),
        batchId: upload.batchId,
        stage: "queued",
        candidateName: upload.fileName,
        rawSender: upload.uploadedBy,
      } as any);

      await ctx.scheduler.runAfter(delayMs, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId: upload._id,
        storageId: upload.storageId,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider || (upload.s3Key ? "r2" : "convex"),
        fileType: upload.fileType || "application/pdf",
        sourceChannel: upload.source || "manual_upload",
        uploadedBy: upload.uploadedBy || "system",
        batchId: upload.batchId,
        logId,
      });

      requeuedCount++;
    }

    return {
      success: true,
      totalMatched: creditAffectedUploads.length,
      requeuedCount,
      estimatedCompletionSec: Math.ceil((requeuedCount * staggerMs) / 1000) + 10,
    };
  },
});
