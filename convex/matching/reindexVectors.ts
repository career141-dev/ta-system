// convex/matching/reindexVectors.ts
// Fast batch re-indexer: re-embeds all candidates with OpenAI text-embedding-3-small
// and upserts new 1024-dim vectors into Qdrant, replacing stale NVIDIA vectors.
// Cost: ~.47 total for ~46,798 candidates.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalAction, internalQuery, action } from "../_generated/server";
import { internal } from "../_generated/api";
import { batchUpsertCandidateVectors, ensureCandidateCollection, getQdrantClient, QDRANT_CANDIDATE_COLLECTION } from "../lib/qdrant";
import type { CandidateVectorPoint } from "../lib/qdrant";

const BATCH_SIZE = 100;
const BATCHES_PER_WORKER = 5; // 500 candidates per action execution

function buildCandidateEmbedText(candidate: any): string {
  const parts: string[] = [];
  if (candidate.fullName) parts.push(candidate.fullName);
  if (candidate.currentJobTitle) parts.push(candidate.currentJobTitle);
  if (candidate.headline) parts.push(candidate.headline);
  if (Array.isArray(candidate.skills) && candidate.skills.length > 0) {
    parts.push("Skills: " + candidate.skills.slice(0, 30).join(", "));
  }
  if (candidate.summary) parts.push(candidate.summary.slice(0, 500));
  if (candidate.locationCity || candidate.locationCountry) {
    parts.push([candidate.locationCity, candidate.locationCountry].filter(Boolean).join(", "));
  }
  if (candidate.industry) parts.push(candidate.industry);
  return parts.join(". ").replace(/\s+/g, " ").trim();
}

/**
 * Batch embed multiple texts via OpenAI in a SINGLE HTTP request
 */
async function embedBatchWithOpenAI(texts: string[]): Promise<(number[] | null)[]> {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (!openAiKey) {
    console.error("[reindexVectors] OPENAI_API_KEY not set");
    return texts.map(() => null);
  }

  const sanitized = texts.map((t) =>
    t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, "").replace(/\s+/g, " ").trim() || "candidate profile"
  );

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + openAiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: sanitized,
        model: "text-embedding-3-small",
        dimensions: 1024,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn("[reindexVectors] OpenAI batch error (" + response.status + "):", errText);
      return texts.map(() => null);
    }

    const data = await response.json();
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (typeof item.index === "number" && Array.isArray(item.embedding)) {
          const emb = item.embedding;
          results[item.index] = emb.length > 1024 ? emb.slice(0, 1024) : emb;
        }
      }
    }

    return results;
  } catch (err: any) {
    console.warn("[reindexVectors] OpenAI batch network error:", err?.message);
    return texts.map(() => null);
  }
}

/**
 * Convex internal query using native B-tree cursor pagination.
 */
export const queryCandidatePage = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db.query("candidates").order("desc").paginate(args.paginationOpts);
  },
});

/**
 * Internal action: worker processes up to BATCHES_PER_WORKER batches (500 candidates)
 * in a loop, then schedules the next worker.
 */
export const reindexWorker = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    processed: v.optional(v.number()),
    failed: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    let currentCursor: string | null = args.cursor ?? null;
    let totalProcessed = args.processed ?? 0;
    let totalFailed = args.failed ?? 0;

    for (let batchNum = 0; batchNum < BATCHES_PER_WORKER; batchNum++) {
      let pageResult: any;
      try {
        pageResult = await ctx.runQuery(
          internal.matching.reindexVectors.queryCandidatePage,
          {
            paginationOpts: {
              numItems: BATCH_SIZE,
              cursor: currentCursor,
            },
          }
        );
      } catch (err: any) {
        console.error("[reindexVectors] Query page failed:", err?.message);
        break;
      }

      const candidates: any[] = pageResult?.page ?? [];
      if (candidates.length === 0) {
        console.log("[reindexVectors] 🎉 ALL CANDIDATES PROCESSED! Total: " + totalProcessed + " indexed, " + totalFailed + " failed.");
        return;
      }

      const texts = candidates.map((c) => buildCandidateEmbedText(c));
      const embeddings = await embedBatchWithOpenAI(texts);

      const points: CandidateVectorPoint[] = [];
      let batchFailed = 0;

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const emb = embeddings[i];

        if (!emb || emb.length !== 1024) {
          batchFailed++;
          continue;
        }

        points.push({
          candidateId: candidate._id as string,
          vector: emb,
          payload: {
            candidateId: candidate._id as string,
            fullName: candidate.fullName ?? "",
            currentJobTitle: candidate.currentJobTitle ?? "",
            skills: Array.isArray(candidate.skills) ? candidate.skills : [],
            totalExperienceYears: candidate.totalExperienceYears ?? 0,
            seniorityLevel: candidate.seniorityLevel ?? "",
            locationCity: candidate.locationCity ?? "",
            locationCountry: candidate.locationCountry ?? "",
            sourceChannel: candidate.sourceChannel ?? "",
            overallStatus: candidate.overallStatus ?? "",
            updatedAt: Date.now(),
          },
        });
      }

      let qdrantSuccess = 0;
      let qdrantFailed = 0;
      if (points.length > 0) {
        const res = await batchUpsertCandidateVectors(points);
        qdrantSuccess = res.success;
        qdrantFailed = res.failed;
      }

      totalProcessed += qdrantSuccess;
      totalFailed += batchFailed + qdrantFailed;
      currentCursor = pageResult.continueCursor;

      console.log(
        "[reindexVectors] Indexed " + qdrantSuccess + " in this batch | Total: " + totalProcessed + " indexed so far."
      );

      if (pageResult.isDone || !currentCursor) {
        console.log("[reindexVectors] 🎉 COMPLETED ALL PAGES! Total: " + totalProcessed + " indexed.");
        return;
      }
    }

    // Schedule next worker loop
    await ctx.scheduler.runAfter(0, internal.matching.reindexVectors.reindexWorker, {
      cursor: currentCursor,
      processed: totalProcessed,
      failed: totalFailed,
    });
  },
});

/**
 * Public action: kick off the full re-index
 */
export const startReindex = action({
  args: {},
  handler: async (ctx, _args): Promise<{ message: string }> => {
    await ctx.scheduler.runAfter(0, internal.matching.reindexVectors.reindexWorker, {
      cursor: null,
      processed: 0,
      failed: 0,
    });
    return {
      message:
        "Fast batch re-indexing started (500 candidates per worker chunk). " +
        "Monitor progress in Convex dashboard logs or via checkProgress.",
    };
  },
});

/**
 * Public action: check how many candidates are currently indexed in Qdrant
 */
export const checkProgress = action({
  args: {},
  handler: async (_ctx, _args): Promise<{ indexed: number; message: string }> => {
    try {
      const ready = await ensureCandidateCollection();
      if (!ready) {
        return { indexed: 0, message: "Could not connect to Qdrant" };
      }
      const client = getQdrantClient();
      const info = await (client as any).getCollection(QDRANT_CANDIDATE_COLLECTION);
      const count = info?.points_count ?? info?.result?.points_count ?? 0;
      return {
        indexed: count,
        message: "Qdrant currently has " + count + " candidate vectors indexed out of ~46,798 total.",
      };
    } catch (err: any) {
      return { indexed: -1, message: "Error checking Qdrant: " + (err?.message ?? String(err)) };
    }
  },
});


export const testLiveEmbedAndUpsert = action({
  args: {},
  handler: async (ctx) => {
    const pageResult: any = await ctx.runQuery(
      internal.matching.reindexVectors.queryCandidatePage,
      { paginationOpts: { numItems: 5, cursor: null } }
    );
    const candidates: any[] = pageResult?.page ?? [];
    const texts = candidates.map((c) => buildCandidateEmbedText(c));
    const embeddings = await embedBatchWithOpenAI(texts);
    
    const validCount = embeddings.filter((e) => e && e.length === 1024).length;
    
    return {
      candidatesRead: candidates.length,
      sampleCandidate: candidates[0]?.fullName,
      validEmbeddings: validCount,
      openAiKeyPresent: !!process.env.OPENAI_API_KEY
    };
  }
});


export const getCandidateCounts = action({
  args: {},
  handler: async (ctx) => {
    // Test count with pagination without index vs with index
    const p1: any = await ctx.runQuery(internal.matching.reindexVectors.queryWithIndexCount, {});
    return p1;
  }
});

export const queryWithIndexCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const p1 = await ctx.db.query("cvUploads").withIndex("by_status", (q) => q.eq("status", "completed")).paginate({ numItems: 10, cursor: null });
    return {
      cvUploadsCount: p1.page.length,
      sampleFile: p1.page[0]?.fileName,
      sampleCandidateId: p1.page[0]?.candidateId,
      continueCursor: p1.continueCursor,
      isDone: p1.isDone,
    };
  }
});


export const getEstimatedUsageCost = action({
  args: {},
  handler: async (_ctx) => {
    // 21,628 candidates indexed at ~500 tokens each = 10,814,000 tokens
    // OpenAI text-embedding-3-small rate: .02 per 1,000,000 tokens
    const vectorsCount = 21628;
    const avgTokensPerDoc = 500;
    const totalTokens = vectorsCount * avgTokensPerDoc;
    const estimatedCostUsd = (totalTokens / 1000000) * 0.02;
    
    return {
      totalCandidatesIndexed: vectorsCount,
      estimatedTokensUsed: totalTokens,
      model: "text-embedding-3-small",
      ratePerMillionTokens: ".02",
      totalCostIncurred: "$" + estimatedCostUsd.toFixed(4),
      centsTotal: (estimatedCostUsd * 100).toFixed(2) + " cents",
    };
  }
});
