// convex/ta/openings.ts
//
// Openings, which are `jobs` rows read through the TA platform's vocabulary.
//
// One `jobs` row is one Opening. The adverts under it live in `jobPosts`, and
// the client it belongs to lives in `clients`; both are TA-platform tables and
// both are optional here, because the restored production rows predate them
// and must keep working until the backfill (plan step 5) has run.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess } from "./guard";

/** An opening as the TA platform reads it. Legacy fields are carried through
 *  unchanged so nothing is lost in translation. */
function projectOpening(job: Doc<"jobs">) {
  return {
    id: job._id as string,
    title: job.title,
    clientId: (job.clientId ?? null) as string | null,
    clientName: job.clientName,
    clientIndustry: job.clientIndustry,
    jdMarkdown: job.jobDescription,
    jdStatus: job.jdStatus ?? null,
    jdApprovedAt: job.jdApprovedAt ?? null,
    keyword: job.keyword,
    locations: job.location ? [job.location] : [],
    targetNationalities: job.targetNationalities ?? [],
    targetGender: job.targetGender ?? null,
    headcount: job.headcount ?? 1,
    priorityTier: job.priorityTier ?? null,
    positionStatus: job.positionStatus ?? null,
    status: job.status,
    seniorityLevel: job.seniorityLevel,
    requiredSkills: job.requiredSkills ?? [],
    niceToHaveSkills: job.niceToHaveSkills ?? [],
    experienceMinYears: job.experienceMinYears ?? null,
    experienceMaxYears: job.experienceMaxYears ?? null,
    followUpQuestions: job.followUpQuestions ?? [],
    taLeadId: (job.taLeadId ?? null) as string | null,
    assignedTaIds: (job.assignedTaIds ?? []) as string[],
    primaryRecruiterId: job.primaryRecruiterId as string,
    stageCounts: job.stageCounts ?? {},
    totalApplications: job.totalApplications ?? 0,
    valueOnProgressing: job.valueOnProgressing ?? null,
    valueOfPlacement: job.valueOfPlacement ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export const list = query({
  args: {
    actorId: v.optional(v.string()),
    /** Omit for every status. */
    status: v.optional(v.string()),
    /** Only openings this person is assigned to. */
    mineOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);

    const jobs = args.status
      ? await ctx.db
          .query("jobs")
          .withIndex("by_status", (q) => q.eq("status", args.status as Doc<"jobs">["status"]))
          .collect()
      : await ctx.db.query("jobs").collect();

    let scoped = jobs;
    if (args.mineOnly && !["admin", "ta_manager"].includes(user.role)) {
      const mine = await ctx.db
        .query("jobAssignments")
        .withIndex("by_userId_isActive", (q) => q.eq("userId", user._id).eq("isActive", true))
        .collect();
      const ids = new Set(mine.map((a) => a.jobId as string));
      scoped = jobs.filter((j) => ids.has(j._id as string));
    }

    scoped.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return scoped.slice(0, args.limit ?? 200).map(projectOpening);
  },
});

export const get = query({
  args: { actorId: v.optional(v.string()), openingId: v.string() },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const job = await ctx.db.get(args.openingId as Id<"jobs">);
    if (!job) return null;

    const posts = await ctx.db
      .query("jobPosts")
      .withIndex("by_opening", (q) => q.eq("openingId", job._id))
      .collect();

    const assignments = await ctx.db
      .query("jobAssignments")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    return {
      ...projectOpening(job),
      posts: posts.map((p) => ({
        id: p._id as string,
        title: p.title,
        status: p.status,
        channel: p.channel,
        aliasKeywords: p.aliasKeywords,
        campaignCode: p.campaignCode,
        assignedTaId: (p.assignedTaId ?? null) as string | null,
      })),
      assignments: assignments.map((a) => ({
        userId: a.userId as string,
        role: a.assignmentRole,
      })),
    };
  },
});

/**
 * Set the TA-platform fields on an opening.
 *
 * Deliberately narrow: it writes only fields the TA workflow owns. The job's
 * own description, skills and channel configuration are edited by the
 * existing `jobs` mutations and are not duplicated here, so there is one
 * writer per field rather than two that can disagree.
 */
export const updateTaFields = mutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    clientId: v.optional(v.string()),
    priorityTier: v.optional(v.string()),
    positionStatus: v.optional(v.string()),
    targetNationalities: v.optional(v.array(v.string())),
    targetGender: v.optional(v.union(v.string(), v.null())),
    headcount: v.optional(v.number()),
    followUpQuestions: v.optional(v.array(v.object({ id: v.string(), label: v.string() }))),
    valueOnProgressing: v.optional(v.number()),
    valueOfPlacement: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Opening not found");
    await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);

    const { actorId: _a, openingId: _o, clientId, ...rest } = args;
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, value] of Object.entries(rest)) {
      if (value !== undefined) patch[k] = value;
    }
    if (clientId !== undefined) patch.clientId = clientId as Id<"clients">;

    await ctx.db.patch(jobId, patch);
    return { ok: true };
  },
});

/**
 * Approve the JD.
 *
 * The TA platform gates every fit score on this: with no approved JD there are
 * no agreed requirements to score against, so nothing is scored at all. It is
 * therefore a real state change, not a label.
 */
export const approveJd = mutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    jdMarkdown: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Opening not found");
    await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);

    await ctx.db.patch(jobId, {
      ...(args.jdMarkdown !== undefined ? { jobDescription: args.jdMarkdown } : {}),
      jdStatus: "approved" as const,
      jdApprovedBy: user._id,
      jdApprovedAt: Date.now(),
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, approvedBy: user._id as string };
  },
});
