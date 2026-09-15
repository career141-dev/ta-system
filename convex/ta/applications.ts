// convex/ta/applications.ts
//
// The pipeline, as the TA platform works it.
//
// Two things here are the TA platform's and have no backend equivalent:
//
//   The collision lock. The first TA to shortlist owns the candidate, and the
//   owner is written in the SAME transaction as the stage change. Checking
//   ownership and then writing in two steps is how two recruiters both end up
//   thinking they own somebody.
//
//   Sets. Five or more shortlisted closes a set, counted per recruiter per
//   opening, because each recruiter sends their own end-of-day email.
//
// Stage changes go through the backend's own state machine rather than
// patching `currentStage` here, so the follow-up sequence, the stage counters,
// the pipeline events and the Meta events all still fire.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK, optionalActor} from "./guard";
import { toTaStage, toBackendStage, directorReviewBlockers } from "./stages";
import { executeStageTransition, PipelineStage } from "../pipeline/pipelineStateMachine";

const SET_SIZE = 5;

function projectApplication(a: Doc<"applications">) {
  return {
    id: a._id as string,
    openingId: a.jobId as string,
    candidateId: a.candidateId as string,
    jobPostId: (a.jobPostId ?? null) as string | null,
    stage: toTaStage(a.currentStage),
    backendStage: a.currentStage,
    ownerTaId: (a.ownerTaId ?? null) as string | null,
    shortlistedAt: a.shortlistedAt ?? null,
    setNumber: a.setNumber ?? null,
    answers: a.answers ?? {},
    sourcingChannel: a.taSourcingChannel ?? null,
    legacySourceChannel: a.sourceChannel,
    isAddOn: a.isAddOn ?? false,
    // Not the engine's aiMatchScore / aiMatchExplanation, nor candidateName:
    // no screen reads them from a list, and the explanation is a paragraph per
    // row — across the 8,378 applications the layout loads, most of a 6 MB
    // response. The profile reads them for one person (ta/candidates:profile).
    isActive: a.isActive,
    createdAt: typeof a.createdAt === "number" ? a.createdAt : Date.parse(String(a.createdAt)) || 0,
    lastStageChangedAt: a.lastStageChangedAt,
  };
}

export const listForOpening = query({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    /** A TA-platform stage name, not a backend one. */
    stage: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .collect();

    // Filtered on the TA name, so asking for Follow-up returns everybody in
    // the three backend stages that collapse into it.
    const wanted = args.stage;
    const rows = wanted ? apps.filter((a) => toTaStage(a.currentStage) === wanted) : apps;

    rows.sort((a, b) => (b.lastStageChangedAt ?? 0) - (a.lastStageChangedAt ?? 0));
    return rows.slice(0, args.limit ?? 500).map(projectApplication);
  },
});

/**
 * Every application on the desk, a page at a time.
 *
 * The dashboards and reports genuinely need the lot. Convex caps a query's
 * returned array at 8,192 rows and the desk is already past that, so this
 * pages rather than truncating — a list that looks complete and is short by
 * two hundred is worse than one that takes two round trips.
 */
export const listAll = query({
  args: {
    actorId: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const page = await ctx.db.query("applications").paginate({
      numItems: Math.min(args.limit ?? 4000, 4000),
      cursor: args.cursor ?? null,
    });
    return {
      applications: page.page.map(projectApplication),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const get = query({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const app = await ctx.db.get(args.applicationId as Id<"applications">);
    if (!app) return null;
    const candidate = await ctx.db.get(app.candidateId);
    return {
      ...projectApplication(app),
      /** What still has to be collected before Director Review will accept
       *  them. Empty means the move will go through. */
      directorReviewBlockers: directorReviewBlockers(app, candidate),
    };
  },
});

/**
 * Shortlist a candidate — the collision lock.
 *
 * Returns `{ ok: false, ownerTaId }` rather than throwing when somebody else
 * already owns them: two TAs reaching for the same person at the same moment
 * is ordinary desk life, not an error, and the loser needs to be told who won.
 */
export const shortlist = mutation({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("Application not found");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);

    // Read and write inside one mutation: Convex runs it as a transaction, so
    // a second claimer arriving mid-flight is serialised behind this one and
    // sees the owner that was just written.
    if (app.ownerTaId && app.ownerTaId !== user._id) {
      return { ok: false as const, ownerTaId: app.ownerTaId as string };
    }
    if (app.ownerTaId === user._id) {
      return { ok: true as const, alreadyMine: true, setNumber: app.setNumber ?? null };
    }

    const setNumber = await nextSetNumber(ctx, app.jobId, user._id);
    const now = Date.now();
    await ctx.db.patch(appId, { ownerTaId: user._id, shortlistedAt: now, setNumber });

    // Shortlisting is what sends somebody to Follow-up on this desk.
    if (toTaStage(app.currentStage) !== "follow_up") {
      await executeStageTransition(ctx, {
        applicationId: appId,
        targetStage: "follow_up" as PipelineStage,
        actorId: user._id,
        reason: "Shortlisted by a TA",
        // The assignment check already ran above, against this actor. The
        // state machine's own check would look for a Clerk identity and find
        // none — see convex/ta/guard.ts.
        bypassRoleCheck: true,
      });
    }

    return { ok: true as const, alreadyMine: false, setNumber };
  },
});

/**
 * The set a newly shortlisted person joins.
 *
 * A set closes on the day it reaches five, so anybody shortlisted today joins
 * the set that was open this morning even if that takes it to seven. Counted
 * per recruiter per opening.
 */
async function nextSetNumber(
  ctx: { db: any },
  jobId: Id<"jobs">,
  taId: Id<"users">,
): Promise<number> {
  const all: Doc<"applications">[] = await ctx.db
    .query("applications")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", jobId))
    .collect();
  const mine = all.filter((a) => a.ownerTaId === taId && a.setNumber != null);
  if (mine.length === 0) return 1;

  const top = Math.max(...mine.map((a) => a.setNumber as number));
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const beforeToday = mine.filter(
    (a) => a.setNumber === top && (a.shortlistedAt ?? 0) < startOfToday.getTime(),
  ).length;
  return beforeToday >= SET_SIZE ? top + 1 : top;
}

/** Move a candidate, named in the TA platform's stage vocabulary. */
export const moveStage = mutation({
  args: {
    actorId: v.optional(v.string()),
    applicationId: v.string(),
    stage: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("Application not found");

    const target = toBackendStage(args.stage);
    // The backend reserves these two for a director or the primary recruiter.
    const roles =
      target === "director_shortlist" || target === "client_review"
        ? ["director", "primary_recruiter"]
        : WORKS_THE_DESK;
    await assertJobAccess(ctx, user, app.jobId, roles);

    const result = await executeStageTransition(ctx, {
      applicationId: appId,
      targetStage: target as PipelineStage,
      actorId: user._id,
      reason: args.reason,
      bypassRoleCheck: true,
    });
    return { ...result, stage: toTaStage(target) };
  },
});

/** Take a candidate off an opening's automatic matches for good. */
export const excludeFromMatches = mutation({
  args: { actorId: v.optional(v.string()), openingId: v.string(), candidateId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const openingId = args.openingId as Id<"jobs">;
    await assertJobAccess(ctx, user, openingId, WORKS_THE_DESK);

    const existing = await ctx.db
      .query("matchExclusions")
      .withIndex("by_opening_candidate", (q) =>
        q.eq("openingId", openingId).eq("candidateId", args.candidateId as Id<"candidates">),
      )
      .first();
    if (existing) return { ok: true, alreadyExcluded: true };

    await ctx.db.insert("matchExclusions", {
      openingId,
      candidateId: args.candidateId as Id<"candidates">,
      at: Date.now(),
    });
    return { ok: true, alreadyExcluded: false };
  },
});
