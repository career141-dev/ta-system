"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Background Healer Worker — runs every 31 minutes (see crons.ts "bg-healer-cv-extractor").
 * Each tick claims up to 5 records (stuck "healing" retries first, then unextracted uploads,
 * then completely empty candidates) and dispatches AI re-extraction for each, staggered to
 * avoid provider rate limits. Every tick is recorded in `healerState` for status reporting.
 */
export const healNextUnparsedCandidate = internalAction({
  args: {},
  handler: async (ctx): Promise<{ healed: boolean; dispatched: number }> => {
    const { targets, recoveredStuck, flaggedForReview, candidatesChecked } =
      await ctx.runMutation(internal.cvs.healer.claimHealBatch, {});

    let dispatched = 0;
    let dispatchErrors = 0;
    let lastError: string | undefined;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        await ctx.scheduler.runAfter(3000 + i * 5000, internal.cvs.cvExtraction.processCvExtraction, {
          cvUploadId: target.cvUploadId,
          storageId: target.storageId,
          s3Key: target.s3Key || undefined,
          storageProvider: target.storageProvider || "r2",
          fileType: target.fileType,
          sourceChannel: target.source,
          uploadedBy: target.uploadedBy,
        });
        dispatched++;
        console.log(`[Healer] Dispatched extraction for ${target.cvUploadId} (${target.fileName}), heal attempt ${target.healAttempt}`);
      } catch (err: any) {
        dispatchErrors++;
        const errorMessage: string = err?.message || String(err);
        lastError = errorMessage;
        console.warn(`[Healer] Extraction dispatch failed for ${target.cvUploadId} (${errorMessage}). Moving to next record...`);
        await ctx.runMutation(internal.cvs.healer.releaseFailedClaim, {
          cvUploadId: target.cvUploadId,
          candidateId: target.candidateId,
          errorMessage,
        });
      }
    }

    await ctx.runMutation(internal.cvs.healer.recordHealerRun, {
      dispatched,
      recoveredStuck,
      flaggedForReview,
      candidatesChecked,
      dispatchErrors,
      lastError,
    });

    console.log(
      `[Healer] Tick complete: dispatched=${dispatched}, recoveredStuck=${recoveredStuck}, ` +
      `flaggedForReview=${flaggedForReview}, candidatesChecked=${candidatesChecked}, dispatchErrors=${dispatchErrors}`
    );

    return { healed: dispatched > 0, dispatched };
  },
});
