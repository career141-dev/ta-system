import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "../_generated/server";

import type { Doc, Id } from "../_generated/dataModel";

export const getCandidate = internalQuery({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.candidateId);
  },
});

export const getCandidatesBatch = internalQuery({
  args: { candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const validCandidateIds = args.candidateIds
      .map((id) => ctx.db.normalizeId("candidates", id))
      .filter((id): id is Id<"candidates"> => id !== null);

    const results = await Promise.all(
      validCandidateIds.map((id) => ctx.db.get(id))
    );
    return results.filter((c): c is Doc<"candidates"> => c !== null);
  },
});

export const getCandidatesSummaryBatch = internalQuery({
  args: { candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const validCandidateIds = args.candidateIds
      .map((id) => ctx.db.normalizeId("candidates", id))
      .filter((id): id is Id<"candidates"> => id !== null);

    const docs = await Promise.all(
      validCandidateIds.map((id) => ctx.db.get(id))
    );
    return docs.filter((c): c is Doc<"candidates"> => c !== null).map((c) => ({
      _id: c._id,
      _creationTime: c._creationTime,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      currentJobTitle: c.currentJobTitle || c.currentTitle,
      currentEmployer: c.currentEmployer,
      totalExperienceYears: c.totalExperienceYears ?? c.yearsOfExperience,
      yearsOfExperience: c.yearsOfExperience ?? c.totalExperienceYears,
      seniorityLevel: c.seniorityLevel,
      location: c.location,
      industry: (c.industries && c.industries.length > 0) ? c.industries[0] : c.sector,
      industries: c.industries,
      skills: c.skills,
      pastJobTitles: c.pastJobTitles,
      education: c.education,
      educationDegree: c.educationDegree,
      summary: c.summary,
      source: c.firstSourceChannel || c.sourceChannel,
      sourceChannel: c.sourceChannel || c.firstSourceChannel,
    }));
  },
});

export const getCandidatesBatchPublic = query({
  args: { candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const validCandidateIds = args.candidateIds
      .map((id) => ctx.db.normalizeId("candidates", id))
      .filter((id): id is Id<"candidates"> => id !== null);

    const results = await Promise.all(
      validCandidateIds.map((id) => ctx.db.get(id))
    );
    return results.filter((c): c is Doc<"candidates"> => c !== null);
  },
});

export const getCandidatesByResumeIds = internalQuery({
  args: { resumeIds: v.array(v.id("candidateResumes")) },
  handler: async (ctx, args) => {
    const resumes = await Promise.all(args.resumeIds.map((id) => ctx.db.get(id)));
    const candidateIds = resumes
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({ resumeId: r._id, candidateId: r.candidateId }));
    const candidates = await Promise.all(candidateIds.map(({ candidateId }) => ctx.db.get(candidateId)));
    const results = [];
    for (let i = 0; i < candidateIds.length; i++) {
      const candidate = candidates[i];
      if (candidate) results.push({ candidate, resumeId: candidateIds[i].resumeId });
    }
    return results;
  },
});

export const getCandidateIdsByResumeIds = internalQuery({
  args: { resumeIds: v.array(v.id("candidateResumes")) },
  handler: async (ctx, args) => {
    const resumes = await Promise.all(args.resumeIds.map((id) => ctx.db.get(id)));
    const results: { resumeId: Id<"candidateResumes">; candidateId: Id<"candidates"> }[] = [];
    for (const resume of resumes) {
      if (resume) {
        results.push({ resumeId: resume._id, candidateId: resume.candidateId });
      }
    }
    return results;
  },
});

export const getCandidateResume = internalQuery({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    return await ctx.db.query("candidateResumes").withIndex("by_candidateId", (q: any) => q.eq("candidateId", args.candidateId)).first();
  },
});

export const getCandidateResumesBatch = internalQuery({
  args: { candidateIds: v.array(v.id("candidates")) },
  handler: async (ctx, args) => {
    const resumes = await Promise.all(
      args.candidateIds.map((id) => ctx.db.query("candidateResumes").withIndex("by_candidateId", (q: any) => q.eq("candidateId", id)).first())
    );
    return resumes.filter((r) => r !== null);
  },
});

export const updateCandidateEmbedding = internalMutation({
  args: { 
    candidateId: v.id("candidates"),
    embedding: v.array(v.number())
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("candidateResumes")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", args.candidateId))
      .first();
    const hasEmbedding = !!(args.embedding && args.embedding.length > 0);
    if (existing) {
      await ctx.db.patch(existing._id, { 
        embedding: args.embedding,
        hasEmbedding,
      });
    } else {
      await ctx.db.insert("candidateResumes", {
        candidateId: args.candidateId,
        rawText: "",
        embedding: args.embedding,
        hasEmbedding,
      });
    }
  },
});

export const markCandidateHasEmbedding = internalMutation({
  args: { 
    candidateId: v.id("candidates"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("candidateResumes")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", args.candidateId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { 
        hasEmbedding: true,
      });
    } else {
      await ctx.db.insert("candidateResumes", {
        candidateId: args.candidateId,
        hasEmbedding: true,
      });
    }
    await ctx.db.patch(args.candidateId, {
      hasEmbedding: true,
    });
  },
});

export const updateJobEmbedding = internalMutation({
  args: { 
    jobId: v.id("jobs"),
    embedding: v.array(v.number())
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      embedding: args.embedding,
    });
  },
});

export const getRecentCandidates = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("candidates")
      .order("desc")
      .take(args.limit);
  },
});

export const getCandidateResumesMissingEmbeddings = internalQuery({
  args: { limit: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("candidateResumes")
      .withIndex("by_hasEmbedding", (q) => q.eq("hasEmbedding", false))
      .paginate({
        numItems: args.limit,
        cursor: args.cursor ?? null,
      });

    return {
      missing: page.page,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const getApplicationsByJobIdInternal = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("applications")
      .withIndex("by_job_active", (q) => q.eq("jobId", args.jobId).eq("isActive", true))
      .collect();
  },
});

export const getEmbeddingStats = query({
  args: {},
  handler: async (ctx) => {
    const withEmbeddingPage = await ctx.db.query("candidateResumes").withIndex("by_hasEmbedding", q => q.eq("hasEmbedding", true)).take(100);
    const missingEmbeddingPage = await ctx.db.query("candidateResumes").withIndex("by_hasEmbedding", q => q.eq("hasEmbedding", false)).take(100);

    return {
      resumesWithEmbeddingCount: withEmbeddingPage.length,
      resumesMissingEmbeddingCount: missingEmbeddingPage.length,
    };
  },
});

export const getAllResumesWithEmbeddings = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const q = ctx.db
      .query("candidateResumes")
      .withIndex("by_hasEmbedding", (q) => q.eq("hasEmbedding", true));
    
    if (args.limit) {
      return await q.take(args.limit);
    }
    return await q.take(500);
  },
});

export const getPaginatedResumesWithEmbeddings = query({
  args: {
    limit: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("candidateResumes")
      .withIndex("by_hasEmbedding", (q) => q.eq("hasEmbedding", true))
      .paginate({
        numItems: args.limit,
        cursor: args.cursor ?? null,
      });
  },
});
