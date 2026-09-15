"use node";

import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * 24/7 Background Healer Worker — Runs every 2 minutes.
 * Claims strictly 1 unextracted or incomplete candidate/upload missing 5 core fields (name, contact, skills, experience, summary),
 * attempts AI LLM re-extraction ONCE, and cleanly moves to the next file if any error occurs.
 */
export const healNextUnparsedCandidate = internalAction({
  args: {},
  handler: async (ctx): Promise<{ healed: boolean; cvUploadId?: string }> => {
    // 1. Claim 1 unextracted or incomplete candidate/upload record (single-attempt policy)
    const target = await ctx.runMutation(internal.cvs.healer.claimNextUnparsedRecord, {});
    if (!target) {
      return { healed: false };
    }

    console.log(`[Healer 24/7] Claimed record ${target.cvUploadId} (${target.fileName}) for single-attempt extraction sweep...`);

    try {
      // Dispatch AI extraction asynchronously via scheduler with 3s pacing delay
      await ctx.scheduler.runAfter(3000, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId: target.cvUploadId as any,
        storageId: target.storageId,
        s3Key: target.s3Key || undefined,
        storageProvider: target.storageProvider || "r2",
        fileType: target.fileType,
        sourceChannel: target.source,
        uploadedBy: target.uploadedBy,
      });

      console.log(`[Healer 24/7] Dispatched extraction for record ${target.cvUploadId}`);
      return { healed: true, cvUploadId: target.cvUploadId };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.warn(`[Healer 24/7] Extraction dispatch failed for ${target.cvUploadId} (${errorMsg}). Moving to next candidate...`);
      
      // Record single-attempt failure and leave record intact so healer moves to next file
      await ctx.runMutation(internal.cvs.healer.releaseFailedClaim, {
        cvUploadId: target.cvUploadId as any,
        candidateId: target.candidateId as any,
        errorMessage: errorMsg,
      });
      return { healed: false };
    }
  },
});
