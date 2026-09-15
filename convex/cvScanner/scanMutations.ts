import { v } from "convex/values";
import { mutation, query, internalMutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { requireUser } from "../lib/permissions";
import { adjustGlobalStat } from "../stats/statsHelper";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const createScan = mutation({
  args: {
    title: v.string(),
    criteria: v.array(
      v.union(
        v.string(),
        v.object({
          text: v.string(),
          isLocation: v.boolean(),
        })
      )
    ),
    files: v.array(
      v.object({
        fileStorageId: v.optional(v.id("_storage")),
        s3Key: v.optional(v.string()),
        fileName: v.string(),
        fileSize: v.number(),
        fileType: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const now = Date.now();
    const expiresAt = now + SEVEN_DAYS_MS;

    const scanId = await ctx.db.insert("cvScans", {
      userId: user._id,
      title: args.title || `CV Scan (${args.files.length} CVs)`,
      criteria: args.criteria,
      expansionStatus: "pending",
      status: "pending",
      totalFiles: args.files.length,
      processedFiles: 0,
      matchedFiles: 0,
      createdAt: now,
      expiresAt,
    });

    const resultIds = [];
    for (const file of args.files) {
      const resultId = await ctx.db.insert("cvScanResults", {
        scanId,
        fileStorageId: file.fileStorageId,
        s3Key: file.s3Key,
        fileName: file.fileName,
        fileSize: file.fileSize,
        fileType: file.fileType,
        matchScore: 0,
        isMatch: false,
        matchedCriteria: [],
        criterionScores: [],
        evidenceQuotes: [],
        reasoning: "",
        status: "pending",
        extractionAttempts: 0,
      });
      resultIds.push(resultId);
    }

    return { scanId, resultIds };
  },
});

export const updateResult = internalMutation({
  args: {
    resultId: v.id("cvScanResults"),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    candidateName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    currentTitle: v.optional(v.string()),
    matchScore: v.optional(v.number()),
    isMatch: v.optional(v.boolean()),
    matchedCriteria: v.optional(v.array(v.string())),
    criterionScores: v.optional(v.array(v.object({ criterion: v.string(), score: v.number() }))),
    evidenceQuotes: v.optional(v.array(v.object({ quote: v.string(), isVerifiedQuote: v.boolean() }))),
    reasoning: v.optional(v.string()),
    error: v.optional(v.string()),
    extractionAttempts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.resultId);
    if (!existing) return;

    const patches: any = {
      status: args.status,
      processedAt: args.status === "completed" || args.status === "failed" ? Date.now() : existing.processedAt,
    };

    if (args.candidateName !== undefined) patches.candidateName = args.candidateName;
    if (args.email !== undefined) patches.email = args.email;
    if (args.phone !== undefined) patches.phone = args.phone;
    if (args.currentTitle !== undefined) patches.currentTitle = args.currentTitle;
    if (args.matchScore !== undefined) patches.matchScore = args.matchScore;
    if (args.isMatch !== undefined) patches.isMatch = args.isMatch;
    if (args.matchedCriteria !== undefined) patches.matchedCriteria = args.matchedCriteria;
    if (args.criterionScores !== undefined) patches.criterionScores = args.criterionScores;
    if (args.evidenceQuotes !== undefined) patches.evidenceQuotes = args.evidenceQuotes;
    if (args.reasoning !== undefined) patches.reasoning = args.reasoning;
    if (args.error !== undefined) patches.error = args.error;
    if (args.extractionAttempts !== undefined) patches.extractionAttempts = args.extractionAttempts;

    await ctx.db.patch(args.resultId, patches);

    // Update parent scan stats if completed or failed
    if (args.status === "completed" || args.status === "failed") {
      const scan = await ctx.db.get(existing.scanId);
      if (scan) {
        const allResults = await ctx.db
          .query("cvScanResults")
          .withIndex("by_scanId", (q) => q.eq("scanId", existing.scanId))
          .collect();

        const processedFiles = allResults.filter(
          (r) => r._id === args.resultId ? (args.status === "completed" || args.status === "failed") : (r.status === "completed" || r.status === "failed")
        ).length;

        const matchedFiles = allResults.filter(
          (r) => r._id === args.resultId ? (args.isMatch ?? r.isMatch) : r.isMatch
        ).length;

        const overallStatus = processedFiles >= scan.totalFiles ? "completed" : "processing";

        await ctx.db.patch(scan._id, {
          processedFiles,
          matchedFiles,
          status: overallStatus,
        });
      }
    }
  },
});

export const updateScanStatus = mutation({
  args: {
    scanId: v.id("cvScans"),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.scanId, { status: args.status });
  },
});

export const promoteCandidateToDb = mutation({
  args: {
    resultId: v.id("cvScanResults"),
    jobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const result = await ctx.db.get(args.resultId);
    if (!result) throw new Error("Scan result not found");
    if (result.promotedCandidateId) return result.promotedCandidateId;

    const now = new Date().toISOString();

    // Deduplication check: check if candidate with same email or phone exists in DB
    let existingCandidate: any = null;
    if (result.email && result.email.trim().length > 3) {
      existingCandidate = await ctx.db
        .query("candidates")
        .withIndex("by_email", (q) => q.eq("email", result.email!.trim()))
        .first();
    }

    if (!existingCandidate && result.phone && result.phone.trim().length > 3) {
      existingCandidate = await ctx.db
        .query("candidates")
        .withIndex("by_phone", (q) => q.eq("phone", result.phone!.trim()))
        .first();
    }

    let candidateId: Id<"candidates">;
    if (existingCandidate) {
      console.log(`[promoteCandidateToDb] Deduplicated: Matched existing candidate ${existingCandidate._id} (${existingCandidate.fullName})`);
      candidateId = existingCandidate._id;
    } else {
      candidateId = await ctx.db.insert("candidates", {
        fullName: result.candidateName || result.fileName.replace(/\.[^/.]+$/, ""),
        email: result.email || undefined,
        phone: result.phone || undefined,
        currentTitle: result.currentTitle || undefined,
        summary: result.reasoning || undefined,
        isParsed: false,
        sourceChannel: "cv_scanner",
        createdAt: now,
        updatedAt: now,
        rawCvText: result.reasoning,
      } as any);

      await adjustGlobalStat(ctx, "new_candidate", 1, { sourceChannel: "cv_scanner" });
    }

    await ctx.db.patch(args.resultId, { promotedCandidateId: candidateId });

    if (args.jobId) {
      // Check if application already exists for this candidate on this job
      const existingApp = await ctx.db
        .query("applications")
        .withIndex("by_candidate_job", (q) =>
          q.eq("candidateId", candidateId).eq("jobId", args.jobId!)
        )
        .first();

      if (!existingApp) {
        await ctx.db.insert("applications", {
          jobId: args.jobId,
          candidateId,
          stage: "new_cvs",
          status: "active",
          createdAt: now,
          appliedAt: now,
          sourceChannel: "cv_scanner",
        } as any);
      }
    }

    return candidateId;
  },
});

export const getScanSession = query({
  args: { scanId: v.id("cvScans") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.scanId);
  },
});

export const getScanResults = query({
  args: { scanId: v.id("cvScans") },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("cvScanResults")
      .withIndex("by_scanId", (q) => q.eq("scanId", args.scanId))
      .collect();

    return results.sort((a, b) => b.matchScore - a.matchScore);
  },
});

export const getScanResultById = query({
  args: { resultId: v.id("cvScanResults") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.resultId);
  },
});

export const getScanResultDirectUrl = query({
  args: { resultId: v.id("cvScanResults") },
  handler: async (ctx, args) => {
    const result = await ctx.db.get(args.resultId);
    if (!result) return { url: null, fileName: "Document.pdf" };

    let url: string | null = null;
    if (result.fileStorageId) {
      url = await ctx.storage.getUrl(result.fileStorageId);
    }

    return {
      url,
      fileName: result.fileName,
      candidateName: result.candidateName,
      hasS3Key: !!result.s3Key,
    };
  },
});

export const getUserScans = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const limit = args.limit || 20;

    const scans = await ctx.db
      .query("cvScans")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return scans;
  },
});

export const cleanupExpiredCvScans = mutation({
  handler: async (ctx) => {
    const now = Date.now();
    const expiredScans = await ctx.db
      .query("cvScans")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(50);

    let deletedCount = 0;
    for (const scan of expiredScans) {
      const results = await ctx.db
        .query("cvScanResults")
        .withIndex("by_scanId", (q) => q.eq("scanId", scan._id))
        .collect();

      for (const res of results) {
        if (!res.promotedCandidateId && res.fileStorageId) {
          try {
            await ctx.storage.delete(res.fileStorageId);
          } catch (e) {
            console.warn(`[cleanupExpiredCvScans] Storage delete failed for ${res.fileStorageId}:`, e);
          }
        }
        await ctx.db.delete(res._id);
      }

      await ctx.db.delete(scan._id);
      deletedCount++;
    }

    return { deletedScansCount: deletedCount };
  },
});

export const updateScanExpandedCriteria = internalMutation({
  args: {
    scanId: v.id("cvScans"),
    expandedCriteria: v.array(
      v.object({
        original: v.string(),
        definition: v.string(),
        equivalentTitles: v.array(v.string()),
        relatedSignals: v.array(v.string()),
        isLocation: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.scanId, {
      expandedCriteria: args.expandedCriteria,
      expansionStatus: "completed",
    });
  },
});

export const updateScanExpansionStatus = internalMutation({
  args: {
    scanId: v.id("cvScans"),
    expansionStatus: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.scanId, {
      expansionStatus: args.expansionStatus,
      ...(args.expansionStatus === "failed" ? { status: "failed" } : {}),
    });
  },
});

export const getCachedExpansion = internalMutation({
  args: {
    normalizedCriterion: v.string(),
    promptVersion: v.string(),
  },
  handler: async (ctx, args) => {
    const cached = await ctx.db
      .query("criteriaExpansionCache")
      .withIndex("by_normalizedCriterion", (q) =>
        q.eq("normalizedCriterion", args.normalizedCriterion)
      )
      .first();

    if (cached && cached.promptVersion === args.promptVersion) {
      return cached.expansion;
    }
    return null;
  },
});

export const saveCachedExpansion = internalMutation({
  args: {
    normalizedCriterion: v.string(),
    expansion: v.object({
      definition: v.string(),
      equivalentTitles: v.array(v.string()),
      relatedSignals: v.array(v.string()),
    }),
    promptVersion: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("criteriaExpansionCache", {
      normalizedCriterion: args.normalizedCriterion,
      expansion: args.expansion,
      promptVersion: args.promptVersion,
      createdAt: Date.now(),
    });
  },
});
