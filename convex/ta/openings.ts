// convex/ta/openings.ts
//
// Openings, which are `jobs` rows read through the TA platform's vocabulary.
//
// One `jobs` row is one Opening. The adverts under it live in `jobPosts`, and
// the client it belongs to lives in `clients`; both are TA-platform tables and
// both are optional here, because the restored production rows predate them
// and must keep working until the backfill (plan step 5) has run.

import { mapIndustry } from "../lib/jobRequirements";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { projectOpening } from "./model/projections";
import { requireActor, assertJobAccess, optionalActor} from "./guard";
import { scheduleExtraction } from "./requirements";
import { autoFollowUpPatch } from "../lib/followUpScope";
import { firstPostFor } from "../lib/firstPost";
import { SCORE_AFTER_APPROVAL_MS } from "../lib/jdGate";
import { internal } from "../_generated/api";
import { workingStageKey } from "../../src/lib/workingStage";
import { recordActiveMode, refreshWorkdayChecks } from "./workdays";
import { invalidateJdReviews, recordJdReview } from "../lib/workdayChecks";
import { isGone } from "../../src/lib/bin";


export const list = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    /** Omit for every status. */
    status: v.optional(v.string()),
    /** Only openings this person is assigned to. */
    mineOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);

    const jobs = (
      args.status
        ? await ctx.db
            .query("jobs")
            .withIndex("by_status", (q) => q.eq("status", args.status as Doc<"jobs">["status"]))
            .collect()
        : await ctx.db.query("jobs").collect()
    // An opening in the Bin (ta/bin.ts) or being deleted has left the desk.
    ).filter((j) => !isGone(j));

    // "Only mine" is a question about a person, so it cannot be answered
    // without one. Refusing beats returning everything, which would look like
    // an answer and quietly widen what the caller sees.
    if (args.mineOnly && !user) {
      throw new Error("mineOnly needs an actorId — there is nobody to scope the list to.");
    }

    let scoped = jobs;
    if (args.mineOnly && user && !["admin", "ta_manager"].includes(user.role)) {
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

export const get = internalQuery({
  args: { actorId: v.optional(v.string()), openingId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const job = await ctx.db.get(args.openingId as Id<"jobs">);
    if (!job || isGone(job)) return null;

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
        workingStage: a.workingStage,
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
export const updateTaFields = internalMutation({
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
export const approveJd = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    jdMarkdown: v.optional(v.string()),
    /**
     * The JD was worked out with the AI in the JD chat (25 Sep). The Job
     * details stopped following the notes when the chat began, so they are
     * read again from the approved JD, keeping what a person corrected.
     */
    detailsFromJd: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Opening not found");
    await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);

    const approvedText = args.jdMarkdown ?? job.jobDescription;
    if (!approvedText.trim()) throw new Error("Add the job description before approving it.");
    if (approvedText !== job.jobDescription) await invalidateJdReviews(ctx, jobId);
    await ctx.db.patch(jobId, {
      ...(args.jdMarkdown !== undefined ? { jobDescription: args.jdMarkdown } : {}),
      jdStatus: "approved" as const,
      jdApprovedBy: user._id,
      jdApprovedAt: Date.now(),
      updatedAt: new Date().toISOString(),
    });
    if (approvedText !== job.jobDescription) await refreshWorkdayChecks(ctx, jobId, user._id);
    await recordJdReview(ctx, user._id, jobId, approvedText);
    await refreshWorkdayChecks(ctx, jobId, user._id);
    // The approved JD is what matching scores against, so its structured
    // requirements are read out of it now — filling blanks, never overwriting
    // what a person corrected (ta/requirements.ts). A JD from the chat
    // replaces them instead, still keeping a person's corrections.
    if (args.detailsFromJd) await scheduleExtraction(ctx, jobId, "replace", true);
    else await scheduleExtraction(ctx, jobId, "fill");
    // CVs that came in while the JD was a draft were not scored (cvScoringActions);
    // they are scored now, once the requirements above have been read.
    await ctx.scheduler.runAfter(SCORE_AFTER_APPROVAL_MS, internal.ta.jdApproval.scoreWaitingCvs, { jobId });
    return { ok: true, approvedBy: user._id as string };
  },
});

/** The notes captured with an opening — what the JD is written from. Newest first, joined. */
export const briefNotes = internalQuery({
  args: { actorId: v.optional(v.string()), openingId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = (await ctx.db.query("briefs").collect()).filter(
      (b) => String(b.openingId ?? "") === args.openingId,
    );
    rows.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
    return rows.map((b) => b.notesMarkdown ?? "").filter((n) => n.trim()).join("\n\n");
  },
});

/**
 * Save the JD text — a generated draft, or an edit after approval. An approved
 * JD that changes is read again for requirements, in fill mode.
 */
export const saveJd = internalMutation({
  args: {
    actorId: v.string(),
    openingId: v.string(),
    jdMarkdown: v.string(),
    /** A JD chat revision of an approved JD: the Job details follow it (25 Sep). */
    detailsFromJd: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Opening not found");
    await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);
    const changed = (job.jobDescription ?? "") !== args.jdMarkdown;
    if (changed) await invalidateJdReviews(ctx, jobId);
    await ctx.db.patch(jobId, { jobDescription: args.jdMarkdown, updatedAt: new Date().toISOString() });
    await refreshWorkdayChecks(ctx, jobId, user._id);
    if (changed && job.jdStatus === "approved" && args.jdMarkdown.trim()) {
      if (args.detailsFromJd) await scheduleExtraction(ctx, jobId, "replace", true);
      else await scheduleExtraction(ctx, jobId, "fill");
    }
    return { ok: true, reextracting: changed && job.jdStatus === "approved" };
  },
});

function makeKeyword(title: string): string {
  const prefix = title.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 5) || "JOB";
  const year = new Date().getFullYear().toString().slice(-2);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `${prefix}${year}${rand}`;
}

/**
 * Create a new Opening (jobs row) along with its assignments.
 */
export const create = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    clientId: v.string(),
    title: v.string(),
    country: v.optional(v.string()),
    hiringFor: v.optional(v.string()),
    targetGender: v.optional(v.union(v.string(), v.null())),
    jdMarkdown: v.optional(v.string()),
    assignedTaIds: v.array(v.string()),
    taLeadId: v.optional(v.union(v.string(), v.null())),
    directorId: v.optional(v.union(v.string(), v.null())),
    notesMarkdown: v.optional(v.string()),
    /** Whose notes these are: a lead's brief, or the TA's own (1 Oct). Defaults to the lead's. */
    briefKind: v.optional(v.union(v.literal("management_to_lead"), v.literal("lead_to_ta"))),
    /** What the app read out of the notes (salary, locations, must-haves). */
    briefExtracted: v.optional(v.any()),
    priorityTier: v.optional(v.string()),
    /** Automatic follow-up reminders after the TA's first Send (ta/followUp.ts `setAuto`). */
    autoFollowUp: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);

    let clientName = "Client";
    let clientIndustry = "Other";
    let clientIdVal: Id<"clients"> | undefined;

    try {
      const clientDoc = await ctx.db.get(args.clientId as Id<"clients">);
      if (clientDoc) {
        clientName = clientDoc.name;
        clientIndustry = mapIndustry(clientDoc.industry) ?? "Other";
        clientIdVal = clientDoc._id;
      }
    } catch {
      // Fallback if client is not in clients table
    }

    let keyword = makeKeyword(args.title);
    let attempts = 0;
    while (attempts < 10) {
      const existing = await ctx.db
        .query("jobs")
        .withIndex("by_keyword", (q) => q.eq("keyword", keyword))
        .first();
      if (!existing) break;
      keyword = makeKeyword(args.title);
      attempts++;
    }

    const now = new Date().toISOString();
    const primaryRecruiterId = (args.assignedTaIds[0] ?? user._id) as Id<"users">;
    const tier = (["P1", "P2", "P3", "P4", "P5"].includes(args.priorityTier ?? "")
      ? args.priorityTier
      : "P3") as Doc<"jobs">["priorityTier"];

    const jobId = await ctx.db.insert("jobs", {
      title: args.title,
      clientName,
      clientIndustry,
      clientId: clientIdVal,
      recruitmentType: "both",
      isConfidential: false,
      jobDescription: args.jdMarkdown ?? "",
      requiredSkills: [],
      seniorityLevel: "mid_level",
      experienceMinYears: 2,
      location: args.country || "Sri Lanka",
      keyword,
      status: "active",
      positionStatus: "active",
      jdStatus: "pending_ta_approval",
      targetGender: args.targetGender ?? null,
      targetNationalities: args.hiringFor ? [args.hiringFor] : [],
      priorityTier: tier,
      headcount: 1,
      primaryRecruiterId,
      assignedTaIds: args.assignedTaIds.map((id) => id as Id<"users">),
      taLeadId: (args.taLeadId ?? user._id) as Id<"users">,
      directorId: args.directorId ? (args.directorId as Id<"users">) : undefined,
      directorReviewEnabled: true,
      clientReviewEnabled: true,
      esaCheckEnabled: false,
      rejectionLoopAction: "ask_ta_each_time",
      agent3AfterDay7: "mark_unresponsive",
      agent5Enabled: false,
      agent5Trigger: "manual_only",
      agent5CallScript: "default",
      agent5NoAnswerAction: "notify_ta",
      headhuntingEnabled: false,
      ...(args.autoFollowUp ? autoFollowUpPatch(true) : {}),
      createdAt: now,
      updatedAt: now,
    });

    for (let i = 0; i < args.assignedTaIds.length; i++) {
      const taId = args.assignedTaIds[i] as Id<"users">;
      await ctx.db.insert("jobAssignments", {
        jobId,
        userId: taId,
        assignmentRole: i === 0 ? "primary_recruiter" : "supporting_recruiter",
        assignedBy: user._id,
        assignedAt: now,
        isActive: true,
      });
    }

    // Its first advert, so the shared mailboxes can route applications to it
    // from the start (ta/firstPost.ts, 22 September).
    const made = await ctx.db.get(jobId);
    if (made) await ctx.db.insert("jobPosts", firstPostFor(made, Date.now()));

    if (args.notesMarkdown) {
      // Marked by who wrote it. A TA's notes were filed as the lead's brief, and
      // the job never pointed at them, so the TA found nothing on it (1 Oct).
      const briefId = await ctx.db.insert("briefs", {
        clientId: clientIdVal,
        openingId: jobId,
        kind: args.briefKind ?? "management_to_lead",
        capturedBy: user._id,
        capturedAt: Date.now(),
        method: "notes",
        notesMarkdown: args.notesMarkdown,
        transcriptStatus: "none",
        extracted: args.briefExtracted ?? {},
      });
      await ctx.db.patch(jobId, { briefId });
    }

    return { id: jobId as string };
  },
});

export const setWorkingStage = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    userId: v.optional(v.string()),
    stage: v.union(v.literal("100%"), v.literal("Follow-up"), v.literal("Add-on")),
  },
  handler: async (ctx, args) => {
    const actor = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const targetUserId = args.userId ? (args.userId as Id<"users">) : actor._id;

    const assignment = await ctx.db
      .query("jobAssignments")
      .withIndex("by_jobId_userId", (q) => q.eq("jobId", jobId).eq("userId", targetUserId))
      .first();

    if (assignment && assignment.isActive) {
      if (assignment.assignmentRole === "client_contact") throw new Error("A client seat does not work the pipeline.");
      await ctx.db.patch(assignment._id, { workingStage: args.stage });
      await recordActiveMode(ctx, targetUserId, jobId, args.stage);
      return { ok: true, stage: args.stage };
    }

    // Anyone else working the job — an admin, director or lead who is not on
    // its team — keeps their stage in the TA settings. Creating an assignment
    // here made a lead who changed the menu the job's primary recruiter
    // (review, 22 Sep); the menu was then shown to TAs only (25 Sep). Who may
    // work an opening is decided by the app ("opening.act") before this runs.
    if (["client", "viewer"].includes(actor.role)) throw new Error("You are not on this opening.");
    if (!(await ctx.db.get(jobId))) throw new Error("That opening no longer exists.");
    const key = workingStageKey(jobId, targetUserId);
    const held = await ctx.db
      .query("taSettings")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (held) await ctx.db.patch(held._id, { value: args.stage, updatedAt: Date.now() });
    else await ctx.db.insert("taSettings", { key, value: args.stage, updatedAt: Date.now() });
    await recordActiveMode(ctx, targetUserId, jobId, args.stage);
    return { ok: true, stage: args.stage };
  },
});

