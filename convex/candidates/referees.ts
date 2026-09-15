import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

export const getRefereesByCandidate = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    let validId = ctx.db.normalizeId("candidates", args.candidateId);
    if (!validId) {
      const upload = await ctx.db.get(args.candidateId as any);
      if (upload && (upload as any).candidateId) {
        validId = (upload as any).candidateId;
      }
    }
    if (!validId) return [];

    return await ctx.db
      .query("referees")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", validId!))
      .collect();
  },
});

export const saveExtractedReferees = mutation({
  args: {
    candidateId: v.id("candidates"),
    referees: v.array(
      v.object({
        name: v.string(),
        designation: v.optional(v.string()),
        company: v.optional(v.string()),
        contactNo: v.optional(v.string()),
        email: v.optional(v.string()),
        relationship: v.optional(v.string()),
        notes: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Delete existing referees for this candidate to allow re-parsing idempotency
    const existing = await ctx.db
      .query("referees")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    for (const ref of existing) {
      await ctx.db.delete(ref._id);
    }

    const insertedIds = [];
    const now = new Date().toISOString();

    for (const ref of args.referees) {
      if (!ref.name || ref.name.trim().length === 0) continue;
      const id = await ctx.db.insert("referees", {
        candidateId: args.candidateId,
        name: ref.name.trim(),
        designation: ref.designation || undefined,
        company: ref.company || undefined,
        contactNo: ref.contactNo || undefined,
        email: ref.email || undefined,
        relationship: ref.relationship || undefined,
        notes: ref.notes || undefined,
        createdAt: now,
      });
      insertedIds.push(id);
    }

    return insertedIds;
  },
});

export const addReferee = mutation({
  args: {
    candidateId: v.id("candidates"),
    name: v.string(),
    designation: v.optional(v.string()),
    company: v.optional(v.string()),
    contactNo: v.optional(v.string()),
    email: v.optional(v.string()),
    relationship: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("referees", {
      candidateId: args.candidateId,
      name: args.name.trim(),
      designation: args.designation || undefined,
      company: args.company || undefined,
      contactNo: args.contactNo || undefined,
      email: args.email || undefined,
      relationship: args.relationship || undefined,
      notes: args.notes || undefined,
      createdAt: new Date().toISOString(),
    });
  },
});

export const deleteReferee = mutation({
  args: { id: v.id("referees") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const getCandidatesWithRawText = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit || 10;
    const results = [];

    // 1. Check candidateResumes
    const resumes = await ctx.db.query("candidateResumes").order("desc").take(limit * 3);
    for (const resume of resumes) {
      if (results.length >= limit) break;
      if (!resume.rawText || resume.rawText.trim().length < 30) continue;
      const candidate = await ctx.db.get(resume.candidateId);
      if (candidate) {
        results.push({
          candidateId: candidate._id,
          candidateName: candidate.fullName || "Unnamed Candidate",
          rawText: resume.rawText,
        });
      }
    }

    // 2. Fallback to candidates table directly if candidateResumes has fewer items
    if (results.length < limit) {
      const candidates = await ctx.db.query("candidates").order("desc").take(limit * 3);
      for (const cand of candidates) {
        if (results.length >= limit) break;
        if (results.some((r) => r.candidateId === cand._id)) continue;
        const candidateResume = await ctx.db
          .query("candidateResumes")
          .withIndex("by_candidateId", (q) => q.eq("candidateId", cand._id))
          .first();

        const rawText =
          candidateResume?.rawText ||
          `Candidate Profile: ${cand.fullName || "Candidate"} - ${cand.currentJobTitle || "Professional"}. Experience: ${cand.totalExperienceYears || 5} years. Email: ${cand.email || "N/A"}.`;

        results.push({
          candidateId: cand._id,
          candidateName: cand.fullName || "Unnamed Candidate",
          rawText,
        });
      }
    }

    return results;
  },
});
