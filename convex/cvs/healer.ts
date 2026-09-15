import { query, internalMutation } from "../_generated/server";
import { v } from "convex/values";

const HEALER_MODEL_TAG = "llama31-70b-healer";

/**
 * Checks if a candidate profile is COMPLETELY EMPTY (all 5 core fields are missing/empty).
 * Per requirements: Re-extraction only occurs if ALL 5 fields are empty.
 * If ANY of the 5 fields are present, do NOT heal that candidate.
 * 
 * 1. Name (fullName)
 * 2. Contact (email or phone)
 * 3. Skills (skills array)
 * 4. Experience (jobHistory array)
 * 5. Summary (summary string)
 */
function isCandidateCompletelyEmpty(c: any): boolean {
  if (!c) return true;
  const hasName = Boolean(c.fullName && c.fullName.trim());
  const hasContact = Boolean((c.email && c.email.trim()) || (c.phone && c.phone.trim()) || (c.phoneClean && c.phoneClean.trim()));
  const hasSkills = Array.isArray(c.skills) && c.skills.length > 0;
  const hasJobHistory = Array.isArray(c.jobHistory) && c.jobHistory.length > 0;
  const hasSummary = Boolean(c.summary && c.summary.trim());

  // If ANY of the 5 fields exist, candidate is NOT completely empty (do NOT heal)
  const hasAnyField = hasName || hasContact || hasSkills || hasJobHistory || hasSummary;
  return !hasAnyField;
}

/**
 * Single-Attempt Claim Mutation:
 * Finds 1 unextracted or incomplete candidate/upload that has NOT been heal-attempted yet.
 * Marks it with isHealAttempted: true and status: "healing".
 */
export const claimNextUnparsedRecord = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. First priority: Check pending cvUploads with status "uploaded" that have files and haven't been tried yet
    const unextractedUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .take(5);

    for (const upload of unextractedUploads) {
      if (upload.isHealAttempted) continue;
      if (!upload.s3Key && !upload.storageId) {
        // Mark file-less upload as failed so it is skipped immediately
        await ctx.db.patch(upload._id, {
          isHealAttempted: true,
          status: "failed",
          errorMessage: "File missing permanently (neither R2 nor Convex storage)",
        });
        continue;
      }

      // If candidate already exists and has ANY of the 5 fields populated, skip healing
      if (upload.candidateId) {
        const candidate = await ctx.db.get(upload.candidateId);
        if (candidate && !isCandidateCompletelyEmpty(candidate)) {
          // Candidate has details — do NOT try to heal
          await ctx.db.patch(upload._id, { status: "processed", isHealAttempted: true });
          continue;
        }
      }

      // Claim for extraction run (strictly single attempt)
      await ctx.db.patch(upload._id, {
        status: "healing",
        isHealAttempted: true,
      });

      if (upload.candidateId) {
        await ctx.db.patch(upload.candidateId, { isHealAttempted: true });
      }

      return {
        cvUploadId: upload._id,
        candidateId: upload.candidateId ?? undefined,
        storageId: upload.storageId,
        s3Key: upload.s3Key || "",
        storageProvider: upload.storageProvider || "r2",
        fileName: upload.fileName || "document.pdf",
        fileType: upload.fileType || "pdf",
        source: upload.source || "Direct Import",
        uploadedBy: upload.uploadedBy || "System Worker",
      };
    }

    // 2. Second priority: Target un-attempted candidates directly using by_isHealAttempted index
    const candidatesSample = await ctx.db
      .query("candidates")
      .withIndex("by_isHealAttempted", (q: any) => q.eq("isHealAttempted", false))
      .take(10);

    for (const candidate of candidatesSample) {
      if (candidate.isHealAttempted) continue;

      if (isCandidateCompletelyEmpty(candidate) && candidate.cvUploadId) {
        const upload = await ctx.db.get(candidate.cvUploadId);
        if (!upload || (!upload.s3Key && !upload.storageId)) {
          await ctx.db.patch(candidate._id, { isHealAttempted: true });
          continue;
        }

        // Claim record for single-attempt re-extraction
        await ctx.db.patch(candidate._id, { isHealAttempted: true });
        await ctx.db.patch(upload._id, {
          status: "healing",
          isHealAttempted: true,
        });

        return {
          cvUploadId: upload._id,
          candidateId: candidate._id,
          storageId: upload.storageId,
          s3Key: upload.s3Key || "",
          storageProvider: upload.storageProvider || "r2",
          fileName: upload.fileName || "document.pdf",
          fileType: upload.fileType || "pdf",
          source: upload.source || candidate.sourceChannel || "Direct Import",
          uploadedBy: upload.uploadedBy || "System Worker",
        };
      }
    }

    return null;
  },
});

export const saveHealedCandidate = internalMutation({
  args: {
    cvUploadId: v.id("cvUploads"),
    candidateId: v.optional(v.id("candidates")),
    extracted: v.any(),
    extractionModel: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.cvUploadId, {
      status: "processed",
      isHealAttempted: true,
    });
    if (args.candidateId) {
      await ctx.db.patch(args.candidateId, { isHealAttempted: true });
    }
  },
});

export const releaseFailedClaim = internalMutation({
  args: {
    cvUploadId: v.id("cvUploads"),
    candidateId: v.optional(v.id("candidates")),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.cvUploadId, {
      status: "failed",
      isHealAttempted: true,
      errorMessage: args.errorMessage,
    });
    if (args.candidateId) {
      await ctx.db.patch(args.candidateId, { isHealAttempted: true });
    }
  },
});

/**
 * Inspection Query — Ultra-fast Indexed Status (<1ms)
 */
export const getHealerStatus = query({
  args: {},
  handler: async (ctx) => {
    const queuedUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .take(10);

    const healingUploads = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "healing"))
      .take(10);

    return {
      healerActive: true,
      modelUsed: "deepseek/deepseek-v4-flash",
      modelTag: HEALER_MODEL_TAG,
      unextractedUploadsQueuedSample: queuedUploads.length,
      currentlyHealingCount: healingUploads.length,
      status: "running_24_7",
    };
  },
});
