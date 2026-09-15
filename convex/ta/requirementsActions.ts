"use node";

// convex/ta/requirementsActions.ts
//
// The extraction itself: the older app's proven JD extractor
// (convex/lib/jdParser.ts — DeepSeek through OpenRouter, NVIDIA fallback),
// normalised by convex/lib/jobRequirements.ts, applied by
// ta/requirements:applyExtraction. See ta/requirements.ts for when it runs.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { extractSearchRequirements } from "../lib/jdParser";
import { valuesFromExtraction } from "../lib/jobRequirements";

export const extract = internalAction({
  args: { jobId: v.id("jobs"), mode: v.union(v.literal("fill"), v.literal("replace")) },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.ta.requirements.jobForExtraction, { jobId: args.jobId });
    if (!job) return;
    const text = `${job.title}\n\n${job.jobDescription}`.trim();
    if (job.jobDescription.trim().length < 40) {
      await ctx.runMutation(internal.ta.requirements.markExtractionFailed, {
        jobId: args.jobId,
        error: "The JD is too short to extract requirements from.",
      });
      return;
    }
    try {
      const { requirements, usage } = await extractSearchRequirements(text, "job_description");
      // The parser falls back to splitting words when every model fails; that
      // is not an extraction, and writing it would fill the job with noise.
      if (usage.model === "regex-fallback") {
        await ctx.runMutation(internal.ta.requirements.markExtractionFailed, {
          jobId: args.jobId,
          error: "The extraction model did not answer. Try Re-extract, or fill the details in by hand.",
        });
        return;
      }
      await ctx.runMutation(internal.ta.requirements.applyExtraction, {
        jobId: args.jobId,
        mode: args.mode,
        values: valuesFromExtraction(requirements),
        model: usage.model,
      });
    } catch (e) {
      await ctx.runMutation(internal.ta.requirements.markExtractionFailed, {
        jobId: args.jobId,
        error: (e as Error).message ?? "Extraction failed",
      });
    }
  },
});
