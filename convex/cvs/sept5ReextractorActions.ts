"use node";

import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * Background Action Worker for Post-Sept 5th CV Re-Extraction.
 * Claims a bounded batch of 5 unextracted records and staggers their dispatches
 * by 2,500ms using the DeepSeek model (deepseek/deepseek-v4-flash).
 */
export const runSept5ReextractionTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number; isDone: boolean }> => {
    // 1. Claim next batch of unextracted records forward from cursor
    const res = await ctx.runMutation(
      internal.cvs.sept5Reextractor.claimNextSept5UnextractedBatch,
      { limit: 4 }
    );

    const { claimed, isDone } = res;

    if (!claimed || claimed.length === 0) {
      if (isDone) {
        console.log("[Sept5 DeepSeek Re-Extractor] Reached live edge. Backlog re-extraction complete.");
      }
      return { processed: 0, isDone };
    }

    console.log(
      `[Sept5 DeepSeek Re-Extractor] Claimed ${claimed.length} unextracted CVs. Staggering dispatches via DeepSeek (3.0s pacing)...`
    );

    // 2. Stagger each extraction by 3,000ms to maintain max 1-2 concurrent actions, leaving 4+ free slots for R2 and live traffic
    for (let i = 0; i < claimed.length; i++) {
      const item = claimed[i];
      const delayMs = i * 3000;

      await ctx.scheduler.runAfter(delayMs, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId: item.cvUploadId,
        storageId: item.storageId,
        s3Key: item.s3Key,
        storageProvider: item.storageProvider,
        fileType: item.fileType,
        sourceChannel: item.sourceChannel,
        uploadedBy: item.uploadedBy,
        skipLLM: false,
      });

      console.log(
        `[Sept5 DeepSeek Re-Extractor] Queued ${item.fileName} (${item.cvUploadId}) with delay ${delayMs}ms`
      );
    }

    return { processed: claimed.length, isDone: false };
  },
});
