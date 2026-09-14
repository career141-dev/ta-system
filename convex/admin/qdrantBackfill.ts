"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { batchUpsertCandidateVectors, ensureCandidateCollection, QDRANT_VECTOR_DIM, type CandidateVectorPoint } from "../lib/qdrant";

export const syncAllCandidateVectorsToQdrant = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    success: boolean;
    totalResumes: number;
    totalSynced: number;
    totalFailed: number;
    message?: string;
  }> => {
    console.log("[Qdrant Backfill] Starting candidate vector backfill to Qdrant...");

    const collectionReady = await ensureCandidateCollection();
    if (!collectionReady) {
      throw new Error("Failed to initialize Qdrant candidate_vectors collection. Make sure Qdrant is running.");
    }

    const batchLimit = args.batchSize || 100;
    let totalProcessed = 0;
    let totalSynced = 0;
    let totalFailed = 0;
    let cursor: string | null = null;
    let isDone = false;

    // 1. Process candidate resumes with embeddings page by page
    while (!isDone) {
      const page: any = await ctx.runQuery(api.matching.queries.getPaginatedResumesWithEmbeddings, {
        limit: batchLimit,
        cursor,
      });

      const batchResumes = page.page || [];
      cursor = page.continueCursor;
      isDone = page.isDone;

      if (batchResumes.length === 0) break;

      const candidateIds = batchResumes.map((r: any) => r.candidateId);
      const candidates = await ctx.runQuery(internal.matching.queries.getCandidatesBatch, {
        candidateIds,
      });

      const candidateMap = new Map<string, any>();
      for (const c of candidates) {
        if (c && c._id) {
          candidateMap.set(c._id, c);
        }
      }

      const points: CandidateVectorPoint[] = [];

      for (const resume of batchResumes) {
        if (!resume.embedding || resume.embedding.length !== QDRANT_VECTOR_DIM) {
          continue;
        }

        const candidate = candidateMap.get(resume.candidateId);
        if (!candidate) continue;

        points.push({
          candidateId: candidate._id,
          vector: resume.embedding,
          payload: {
            candidateId: candidate._id,
            fullName: candidate.fullName || "Candidate",
            currentJobTitle: candidate.currentJobTitle,
            skills: candidate.skills || [],
            totalExperienceYears: candidate.totalExperienceYears,
            seniorityLevel: candidate.seniorityLevel,
            locationCity: candidate.locationCity,
            locationCountry: candidate.locationCountry,
            sourceChannel: candidate.firstSourceChannel || candidate.sourceChannel,
            overallStatus: candidate.overallStatus,
            updatedAt: candidate._creationTime || Date.now(),
          },
        });
      }

      if (points.length > 0) {
        const result = await batchUpsertCandidateVectors(points);
        totalSynced += result.success;
        totalFailed += result.failed;
      }

      totalProcessed += batchResumes.length;
      console.log(`[Qdrant Backfill] Progress: ${totalProcessed} processed (${totalSynced} synced, ${totalFailed} failed)...`);
    }

    console.log(`[Qdrant Backfill] Complete! Successfully synced ${totalSynced} vectors to Qdrant.`);

    return {
      success: true,
      totalResumes: totalProcessed,
      totalSynced,
      totalFailed,
    };
  },
});
