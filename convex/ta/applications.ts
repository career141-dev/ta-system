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
//   Sets. Five or more shortlisted in one day closes a set, counted per
//   recruiter per opening, because each recruiter sends their own end-of-day
//   email (convex/lib/sets.ts).
//
// Stage changes go through the backend's own state machine rather than
// patching `currentStage` here, so the follow-up sequence, the stage counters,
// the pipeline events and the Meta events all still fire.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { projectApplication } from "./model/projections";
import { requireActor, assertJobAccess, assertNotAnotherTasCandidate, isTaOnOwnDesk, WORKS_THE_DESK, optionalActor} from "./guard";
import { toTaStage, toBackendStage, directorReviewBlockers } from "./stages";
import { followUpOn } from "../lib/followUpScope";
import { nextSetFor } from "../lib/sets";
import { backupPrimary } from "../lib/backup";
import { workingStageKey } from "../../src/lib/workingStage";
import { executeStageTransition, PipelineStage } from "../pipeline/pipelineStateMachine";
import { isGone } from "../../src/lib/bin";



export const listForOpening = internalQuery({
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
    const job = await ctx.db.get(jobId);
    if (!job || isGone(job)) return [];

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
export const listAll = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const page = await ctx.db.query("applications").paginate({
      numItems: Math.min(args.limit ?? 2000, 2000),
      cursor: args.cursor ?? null,
    });
    // Applications on an opening in the Bin stay out of the dashboards until
    // it is restored. The Bin is a handful of rows, read through its index.
    const binned = new Set(
      (await ctx.db.query("jobs").withIndex("by_binnedAt", (q) => q.gt("binnedAt", 0)).collect()).map((j) => j._id as string),
    );
    return {
      applications: page.page.filter((a) => !binned.has(a.jobId as string)).map(projectApplication),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const get = internalQuery({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const app = await ctx.db.get(args.applicationId as Id<"applications">);
    if (!app) return null;
    const job = await ctx.db.get(app.jobId);
    if (!job || isGone(job)) return null;
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
export const shortlist = internalMutation({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("Application not found");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    // The Shortlist button is for people still to be taken on. A closed card on a stale page
    // is brought back deliberately (Brought back / Add to pipeline), not by a claim (2 Oct).
    const stage = toTaStage(app.currentStage);
    if (stage === "rejected" || stage === "dropped_out") {
      throw new Error("This candidate is closed on this opening. Bring them back first, then shortlist.");
    }
    return claimForTa(ctx, user, app);
  },
});

/** Stages a claim moves into TA Follow-up; every other stage stays where it is. */
const PULLED_INTO_FOLLOW_UP = new Set<string>(["new_cv", "matched", "ai_follow_up", "rejected", "dropped_out"]);

/**
 * The claim itself, shared with the headhunted-CV upload (ta/hhUpload.ts), so
 * a CV uploaded from TA Follow-up is claimed by exactly the same rule.
 */
export async function claimForTa(
  ctx: MutationCtx,
  user: Doc<"users">,
  app: Doc<"applications">,
  reason = "Shortlisted by a TA",
) {
  const appId = app._id;
  // Read and write inside one mutation: Convex runs it as a transaction, so
  // a second claimer arriving mid-flight is serialised behind this one and
  // sees the owner that was just written.
  if (app.ownerTaId && app.ownerTaId !== user._id) {
    return { ok: false as const, ownerTaId: app.ownerTaId as string };
  }
  if (app.ownerTaId === user._id) {
    return { ok: true as const, alreadyMine: true, setNumber: app.setNumber ?? null };
  }

  const now = Date.now();
  const setNumber = await nextSetNumber(ctx, app.jobId, user._id, now);
  // On an Add-on day what the TA shortlists is an add-on (the desk, 28 Sep).
  const addOn = !app.isAddOn && (await workingStageOf(ctx, app.jobId, user._id)) === "Add-on";
  // With someone already at interview or offer, it is a backup (convex/lib/backup).
  const primary = app.backupForApplicationId ? null : await backupPrimaryOn(ctx, app.jobId, appId);
  await ctx.db.patch(appId, {
    ownerTaId: user._id,
    shortlistedAt: now,
    setNumber,
    ...(addOn ? { isAddOn: true, addedOnAt: now } : {}),
    ...(primary ? { backupForApplicationId: primary } : {}),
  });

  // Shortlisting is what sends somebody to Follow-up on this desk.
  // A TA's shortlist is TA Follow-up — a database match or a new CV the TA
  // picks, and someone the AI shortlisted first: the TA taking them on is
  // what starts the outreach. AI Follow-up is only the AI's own shortlist,
  // a CV scored at or above the pass mark (cvs/cvScoringActions.ts). For
  // two days on 23–24 September a TA's shortlist went to AI Follow-up by
  // mistake; the owner asked for it back (24 September).
  // Only people still at the front of the pipeline are pulled into Follow-up (2 Oct).
  // Someone already at Director review, interview, offer or placed is claimed
  // where they are — shortlisting must never send a candidate backwards, as it did
  // for anyone left unowned by admin/unshortlist.ts or an HH upload.
  if (PULLED_INTO_FOLLOW_UP.has(toTaStage(app.currentStage))) {
    await executeStageTransition(ctx, {
      applicationId: appId,
      targetStage: "follow_up" as PipelineStage,
      actorId: user._id,
      reason,
      bypassRoleCheck: true,
      // Unless the opening's follow-up switch is off: a switch that says off
      // has to mean off. Every message still passes the outreach gate
      // (convex/lib/outreachSafety.ts).
      skipAutoOutreach: !followUpOn(await ctx.db.get(app.jobId)),
    });
  }

  return { ok: true as const, alreadyMine: false, setNumber };
}

/**
 * The set a newly shortlisted person joins. The rule is in convex/lib/sets.ts
 * (the desk, 28 September): a set stays open across days until five or more
 * are sent in one Colombo day. Counted per recruiter per opening; the local
 * store in src/data/store.ts calls the same rule.
 */
async function nextSetNumber(
  ctx: { db: any },
  jobId: Id<"jobs">,
  taId: Id<"users">,
  now: number,
): Promise<number> {
  const all: Doc<"applications">[] = await ctx.db
    .query("applications")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", jobId))
    .collect();
  return nextSetFor(all.filter((a) => a.ownerTaId === taId && a.setNumber != null), now);
}

/** The job's candidate a new shortlist would back up, if anyone is at interview or offer. */
async function backupPrimaryOn(
  ctx: { db: any },
  jobId: Id<"jobs">,
  selfId: Id<"applications">,
): Promise<Id<"applications"> | null> {
  const all: Doc<"applications">[] = await ctx.db
    .query("applications")
    .withIndex("by_jobId", (q: any) => q.eq("jobId", jobId))
    .collect();
  const id = backupPrimary(
    all.map((a) => ({ id: a._id as string, stage: toTaStage(a.currentStage) })),
    selfId,
  );
  return id as Id<"applications"> | null;
}

/**
 * A TA's working stage on a job: on their assignment, or in the TA settings
 * for someone working it without being on the team (convex/ta/openings.ts
 * setWorkingStage writes both). "100%" when never set.
 */
async function workingStageOf(ctx: { db: any }, jobId: Id<"jobs">, userId: Id<"users">): Promise<string> {
  const assignment = await ctx.db
    .query("jobAssignments")
    .withIndex("by_jobId_userId", (q: any) => q.eq("jobId", jobId).eq("userId", userId))
    .first();
  if (assignment?.isActive) return assignment.workingStage ?? "100%";
  const held = await ctx.db
    .query("taSettings")
    .withIndex("by_key", (q: any) => q.eq("key", workingStageKey(jobId, userId)))
    .first();
  return held?.value ?? "100%";
}

/** Move a candidate, named in the TA platform's stage vocabulary. */
export const moveStage = internalMutation({
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

    // Into TA Follow-up with nobody's name on them is a shortlist: whoever
    // moves them claims them. That used to be a second call from the web app
    // after the move, and it swallowed a refused claim — two TAs moving the
    // same person both read "Moved" (2 Oct). Claimed here, in the move's own
    // transaction, the second one is told who has them instead.
    if (target === "follow_up") {
      if (!app.ownerTaId) {
        const claimed = await claimForTa(ctx, user, app, args.reason || undefined);
        if (!claimed.ok) return { success: false, ownerTaId: claimed.ownerTaId, stage: toTaStage(app.currentStage) };
        return { success: true, claimed: true, stage: toTaStage("follow_up") };
      }
      if ((app.ownerTaId as string) !== (user._id as string) && isTaOnOwnDesk(user)) {
        return { success: false, ownerTaId: app.ownerTaId as string, stage: toTaStage(app.currentStage) };
      }
    }
    assertNotAnotherTasCandidate(user, app);

    const result = await executeStageTransition(ctx, {
      applicationId: appId,
      targetStage: target as PipelineStage,
      actorId: user._id,
      reason: args.reason,
      bypassRoleCheck: true,
      // Moving a card by hand into Follow-up starts the outreach too, so a
      // candidate reaches the sequence the same way however they got there —
      // and, as with shortlisting, only on an opening whose follow-up is on.
      // A rejected person brought back came through here and was sent the
      // Day 0 message on an opening switched off (review of PR #2, 21 Sep).
      skipAutoOutreach: target === "follow_up" ? !followUpOn(await ctx.db.get(app.jobId)) : undefined,
    });
    return { ...result, stage: toTaStage(target) };
  },
});

/** Take a candidate off an opening's automatic matches for good. */
export const excludeFromMatches = internalMutation({
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
