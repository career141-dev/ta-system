import { v } from "convex/values";
import { action, internalMutation, query } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { resolveCandidateLocation } from "../lib/locationResolver";

export const getUnbackedCandidates = query({
  args: {
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Find candidates with location string but missing locationStructured
    const all = await ctx.db
      .query("candidates")
      .filter((q) =>
        q.and(
          q.neq(q.field("location"), undefined),
          q.neq(q.field("location"), ""),
          q.eq(q.field("locationStructured"), undefined)
        )
      )
      .take(args.limit);

    return all.map((c) => ({ _id: c._id, location: c.location! }));
  },
});

export const updateCandidateLocationStructuredBatch = internalMutation({
  args: {
    patches: v.array(
      v.object({
        candidateId: v.id("candidates"),
        locationStructured: v.object({
          raw_text: v.string(),
          city: v.union(v.string(), v.null()),
          region: v.union(v.string(), v.null()),
          country: v.union(v.string(), v.null()),
        }),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const p of args.patches) {
      await ctx.db.patch(p.candidateId, {
        locationStructured: p.locationStructured,
      });
    }
  },
});

export const getBackfillStats = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 500;
    const candidatesSample = await ctx.db.query("candidates").take(limit);
    const withLocation = candidatesSample.filter((c) => c.location && c.location.trim().length > 0);
    const withStructuredLocation = candidatesSample.filter((c) => c.locationStructured !== undefined);

    return {
      sampleSize: candidatesSample.length,
      withRawLocationCount: withLocation.length,
      withStructuredLocationCount: withStructuredLocation.length,
      pendingBackfillInSample: withLocation.length - withStructuredLocation.length,
    };
  },
});

/**
 * Controlled, batched backfill action for candidate locations.
 * 
 * Args:
 * - batchSize: Number of candidates to process in this run (default: 100, max: 1000)
 */
export const runCandidateLocationBackfillBatch = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const limit = Math.min(args.batchSize || 100, 1000);

    const candidatesToProcess = await ctx.runQuery(api.candidates.backfillLocation.getUnbackedCandidates, {
      limit,
    });

    if (!candidatesToProcess || candidatesToProcess.length === 0) {
      return {
        status: "complete",
        message: "No candidates remaining for location backfill.",
        processedCount: 0,
        gazetteerHits: 0,
        llmFallbackCount: 0,
        durationMs: Date.now() - startTime,
        sampleResolutions: [],
      };
    }

    let gazetteerHits = 0;
    let llmFallbackCount = 0;
    const patches: Array<{ candidateId: any; locationStructured: any }> = [];
    const sampleResolutions: Array<{ candidateId: string; rawText: string; resolved: any }> = [];

    for (const candidate of candidatesToProcess) {
      const resolved = await resolveCandidateLocation(ctx, candidate.location);
      patches.push({
        candidateId: candidate._id,
        locationStructured: resolved,
      });

      if (sampleResolutions.length < 15) {
        sampleResolutions.push({
          candidateId: String(candidate._id),
          rawText: candidate.location,
          resolved,
        });
      }
    }

    const tWriteStart = Date.now();
    await ctx.runMutation(internal.candidates.backfillLocation.updateCandidateLocationStructuredBatch, {
      patches,
    });
    const writeLatencyMs = Date.now() - tWriteStart;

    const durationMs = Date.now() - startTime;

    return {
      status: "success",
      processedCount: patches.length,
      gazetteerHits,
      llmFallbackCount,
      writeLatencyMs,
      durationMs,
      sampleResolutions,
    };
  },
});
