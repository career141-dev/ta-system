import { query, mutation, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

// September 5, 2026 00:00:00 GMT+5:30 (Local Time)
export const SEPT5_START_TIMESTAMP_MS = 1788546600000;
export const DEEPSEEK_MODEL_IDENTIFIER = "deepseek/deepseek-v4-flash";

/**
 * Deterministic Candidate Completeness Check:
 * Checks whether a candidate profile actually contains extracted core fields.
 * Bypasses the deceptive `isParsed: true` flag set on empty stubs.
 */
export function isCandidateExtracted(candidate: any): boolean {
  if (!candidate) return false;

  const name = (candidate.fullName || "").trim();
  const hasValidName = Boolean(
    name.length > 0 &&
    name.toLowerCase() !== "applicant" &&
    name.toLowerCase() !== "unknown"
  );

  const hasContact = Boolean(
    (candidate.email && candidate.email.trim()) ||
    (candidate.phone && candidate.phone.trim()) ||
    (candidate.phoneClean && candidate.phoneClean.trim())
  );

  const hasSkills = Array.isArray(candidate.skills) && candidate.skills.length > 0;
  const hasExperience =
    (Array.isArray(candidate.jobHistory) && candidate.jobHistory.length > 0) ||
    (typeof candidate.totalExperienceYears === "number" && candidate.totalExperienceYears > 0);

  // Must have a valid identified name AND at least one other core attribute (contact, skills, or experience)
  if (!hasValidName) return false;
  if (!hasContact && !hasSkills && !hasExperience) return false;

  return true;
}

/**
 * Query: Gets the persistent re-extraction runner state and progress metrics.
 */
export const getSept5ReextractionStatus = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db
      .query("sept5ReextractionState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    if (!record) {
      return {
        key: "singleton",
        startTimestamp: SEPT5_START_TIMESTAMP_MS,
        lastProcessedCreationTime: SEPT5_START_TIMESTAMP_MS,
        totalScanned: 0,
        totalAlreadyExtracted: 0,
        totalQueued: 0,
        totalHealed: 0,
        totalFailed: 0,
        status: "idle",
        modelUsed: DEEPSEEK_MODEL_IDENTIFIER,
        lastTickAt: undefined,
        updatedAt: Date.now(),
      };
    }

    return record;
  },
});

/**
 * Fast Audit Query: Scans a sample of recent uploads from September 5th onwards
 * and reports the breakdown between complete candidates vs unextracted stubs.
 */
export const getSept5AuditSample = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scanLimit = Math.min(args.limit ?? 50, 100);

    const uploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", SEPT5_START_TIMESTAMP_MS)
      )
      .take(scanLimit);

    let completeCount = 0;
    let incompleteCount = 0;
    let orphanedCount = 0;

    const samples = [];

    for (const upload of uploads) {
      if (!upload.candidateId) {
        orphanedCount++;
        if (samples.length < 10) {
          samples.push({
            uploadId: upload._id,
            fileName: upload.fileName,
            status: upload.status,
            isExtracted: false,
            reason: "No candidate profile linked",
            creationTime: new Date(upload._creationTime).toISOString(),
          });
        }
        continue;
      }

      const candidate = await ctx.db.get(upload.candidateId);
      const isExtracted = isCandidateExtracted(candidate);

      if (isExtracted) {
        completeCount++;
      } else {
        incompleteCount++;
      }

      if (samples.length < 10) {
        samples.push({
          uploadId: upload._id,
          candidateId: upload.candidateId,
          candidateName: candidate?.fullName ?? "unset",
          fileName: upload.fileName,
          status: upload.status,
          isParsedFlag: candidate?.isParsed ?? false,
          isExtracted,
          reason: isExtracted
            ? "Complete"
            : "Core fields (name/skills/exp/phone) unset or empty",
          creationTime: new Date(upload._creationTime).toISOString(),
        });
      }
    }

    return {
      sampleTotalScanned: uploads.length,
      sampleCompleteCount: completeCount,
      sampleIncompleteCount: incompleteCount,
      sampleOrphanedCount: orphanedCount,
      modelUsed: DEEPSEEK_MODEL_IDENTIFIER,
      samples,
    };
  },
});

/**
 * Internal Mutation: Atomically claims the next batch of unextracted CVs starting from
 * the checkpoint cursor. Bounded to `limit` items (default: 5).
 */
export const claimNextSept5UnextractedBatch = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchLimit = Math.min(args.limit ?? 4, 8);
    const now = Date.now();

    // 1. Get or initialize state
    let state = await ctx.db
      .query("sept5ReextractionState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    if (!state) {
      const newId = await ctx.db.insert("sept5ReextractionState", {
        key: "singleton",
        startTimestamp: SEPT5_START_TIMESTAMP_MS,
        lastProcessedCreationTime: SEPT5_START_TIMESTAMP_MS,
        totalScanned: 0,
        totalAlreadyExtracted: 0,
        totalQueued: 0,
        totalHealed: 0,
        totalFailed: 0,
        status: "idle",
        modelUsed: DEEPSEEK_MODEL_IDENTIFIER,
        lastTickAt: now,
        updatedAt: now,
      });
      state = (await ctx.db.get(newId))!;
    }

    if (state.status !== "running") {
      return { claimed: [], isDone: state.status === "completed" };
    }

    const cursorTime = state.lastProcessedCreationTime;

    // 2. Query uploads forward from cursorTime using by_creation_time index
    const uploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", cursorTime))
      .order("asc")
      .take(60);

    if (uploads.length === 0) {
      // Reached the current live edge
      await ctx.db.patch(state._id, {
        status: "completed",
        lastTickAt: now,
        updatedAt: now,
      });
      return { claimed: [], isDone: true };
    }

    const claimed = [];
    let scannedInThisRun = 0;
    let alreadyExtractedInThisRun = 0;
    let newCursorTime = cursorTime;
    let lastUploadId = state.lastProcessedUploadId;

    for (const upload of uploads) {
      scannedInThisRun++;
      newCursorTime = upload._creationTime + 1;
      lastUploadId = upload._id;

      // Check physical file availability
      if (!upload.s3Key && !upload.storageId) {
        continue;
      }

      // Check if candidate profile exists and is already extracted
      let needsExtraction = true;
      if (upload.candidateId) {
        const candidate = await ctx.db.get(upload.candidateId);
        if (candidate && isCandidateExtracted(candidate)) {
          needsExtraction = false;
          alreadyExtractedInThisRun++;
        }
      }

      if (!needsExtraction) {
        continue;
      }

      // Record requires re-extraction via DeepSeek
      await ctx.db.patch(upload._id, {
        status: "processing",
        processingStartedAt: now,
        errorMessage: undefined,
      });

      // Clear the deceptive isParsed flag on the candidate stub so it's marked fresh for parsing
      if (upload.candidateId) {
        await ctx.db.patch(upload.candidateId, {
          isParsed: false,
        });
      }

      claimed.push({
        cvUploadId: upload._id,
        candidateId: upload.candidateId,
        storageId: upload.storageId,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider || (upload.s3Key ? "r2" : "convex"),
        fileType: upload.fileType || "pdf",
        fileName: upload.fileName,
        sourceChannel: upload.source || "Sept 5 Re-Extraction",
        uploadedBy: upload.uploadedBy || "DeepSeek Background Re-Extractor",
      });

      if (claimed.length >= batchLimit) {
        break;
      }
    }

    // 3. Update checkpoint state
    await ctx.db.patch(state._id, {
      lastProcessedCreationTime: newCursorTime,
      lastProcessedUploadId: lastUploadId,
      totalScanned: state.totalScanned + scannedInThisRun,
      totalAlreadyExtracted: state.totalAlreadyExtracted + alreadyExtractedInThisRun,
      totalQueued: state.totalQueued + claimed.length,
      lastTickAt: now,
      updatedAt: now,
    });

    return {
      claimed,
      isDone: false,
    };
  },
});

/**
 * Public Mutation: Starts or resumes the background re-extraction runner.
 */
export const startSept5Reextractor = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let state = await ctx.db
      .query("sept5ReextractionState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    if (!state) {
      await ctx.db.insert("sept5ReextractionState", {
        key: "singleton",
        startTimestamp: SEPT5_START_TIMESTAMP_MS,
        lastProcessedCreationTime: SEPT5_START_TIMESTAMP_MS,
        totalScanned: 0,
        totalAlreadyExtracted: 0,
        totalQueued: 0,
        totalHealed: 0,
        totalFailed: 0,
        status: "running",
        modelUsed: DEEPSEEK_MODEL_IDENTIFIER,
        lastTickAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(state._id, {
        status: "running",
        updatedAt: now,
      });
    }

    // Trigger initial tick immediately
    await ctx.scheduler.runAfter(0, internal.cvs.sept5ReextractorActions.runSept5ReextractionTick, {});

    return { success: true, message: "Sept 5th DeepSeek background re-extractor started." };
  },
});

/**
 * Public Mutation: Pauses the background re-extraction runner cleanly.
 */
export const pauseSept5Reextractor = mutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("sept5ReextractionState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    if (state) {
      await ctx.db.patch(state._id, {
        status: "paused",
        updatedAt: Date.now(),
      });
    }

    return { success: true, message: "Sept 5th re-extractor paused." };
  },
});

/**
 * Public Mutation: Resets the cursor to September 5th 00:00:00 to allow a full re-scan.
 */
export const resetSept5Reextractor = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const state = await ctx.db
      .query("sept5ReextractionState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    if (state) {
      await ctx.db.patch(state._id, {
        lastProcessedCreationTime: SEPT5_START_TIMESTAMP_MS,
        lastProcessedUploadId: undefined,
        totalScanned: 0,
        totalAlreadyExtracted: 0,
        totalQueued: 0,
        totalHealed: 0,
        totalFailed: 0,
        status: "idle",
        updatedAt: now,
      });
    }

    return { success: true, message: "Re-extractor reset to September 5th, 2026." };
  },
});
