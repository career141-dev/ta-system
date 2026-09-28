// convex/ta/matching.ts
//
// Database matches for an opening: the run ledger, and reading back what the
// backend's reverse-match engine produced.
//
// The engine itself is not touched. `matching/agent2:runReverseMatch` is the
// tuned one and stays exactly as it is; this module records that a run
// happened and translates its output into the TA platform's shape. Wiring the
// trigger to the opening's screen is plan step 8.
//
// The run ledger matters more than it looks. A list of matches with no record
// of how it was produced cannot be argued with: "why is this person here" and
// "why is this person NOT here" are both questions about the run, not the row.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK, optionalActor} from "./guard";
import { cvFileMissing } from "../../src/lib/cvMissing";

export const runsForOpening = internalQuery({
  args: { actorId: v.optional(v.string()), openingId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const runs = await ctx.db
      .query("matchRuns")
      .withIndex("by_opening", (q) => q.eq("openingId", args.openingId as Id<"jobs">))
      .collect();
    runs.sort((a, b) => b.at - a.at);
    return runs.slice(0, args.limit ?? 20).map((r) => ({
      id: r._id as string,
      at: r.at,
      trigger: r.trigger,
      considered: r.considered,
      afterRules: r.afterRules,
      added: r.added,
      embedModel: r.embedModel,
      assessmentVersion: r.assessmentVersion ?? null,
      note: r.note ?? null,
    }));
  },
});

export const recordRun = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    trigger: v.union(v.literal("jd_approved"), v.literal("nightly"), v.literal("manual")),
    considered: v.number(),
    afterRules: v.number(),
    added: v.number(),
    embedModel: v.string(),
    assessmentVersion: v.optional(v.string()),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const id = await ctx.db.insert("matchRuns", {
      openingId: args.openingId as Id<"jobs">,
      at: Date.now(),
      trigger: args.trigger,
      considered: args.considered,
      afterRules: args.afterRules,
      added: args.added,
      embedModel: args.embedModel,
      assessmentVersion: args.assessmentVersion,
      note: args.note ?? null,
    });
    return { id: id as string };
  },
});

/** Everyone taken off this opening's matches, so a rerun does not offer them
 *  again. Returned as a plain list for the caller to turn into a Set. */
export const exclusionsForOpening = internalQuery({
  args: { actorId: v.optional(v.string()), openingId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = await ctx.db
      .query("matchExclusions")
      .withIndex("by_opening", (q) => q.eq("openingId", args.openingId as Id<"jobs">))
      .collect();
    return rows.map((r) => ({ candidateId: r.candidateId as string, at: r.at }));
  },
});

/**
 * What the reverse-match engine last produced for this opening.
 *
 * `reverseMatchResults` is stored inline on the job document, so this is a
 * single read. The per-result audit fields — the current-role gate, the
 * role-family verdict, the location gate and their penalties — are carried
 * through rather than summarised, because they are the explanation of the
 * score and dropping them would leave a number with nothing behind it.
 */
export const reverseMatchResults = internalQuery({
  args: { actorId: v.optional(v.string()), openingId: v.string(), minScore: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const job = await ctx.db.get(args.openingId as Id<"jobs">);
    if (!job) return null;

    const floor = args.minScore ?? 0;
    const scored = (job.reverseMatchResults ?? []).filter(
      (r: { overallScore: number }) => r.overallScore >= floor,
    );
    // Results saved before a CV was found lost stay on the job until the next
    // run; they are not handed out meanwhile (src/lib/cvMissing.ts).
    const people = await Promise.all(
      scored.map((r) => {
        const id = ctx.db.normalizeId("candidates", r.cvId);
        return id ? ctx.db.get(id) : null;
      }),
    );
    const results = scored.filter((_, i) => !(people[i] && cvFileMissing(people[i])));

    return {
      status: job.reverseMatchStatus ?? null,
      matchedAt: job.reverseMatchedAt ?? null,
      roleFamily: job.roleFamily ?? null,
      taPreferences: job.taPreferences ?? null,
      total: results.length,
      results,
    };
  },
});

/**
 * Turn engine results into applications at the `matched` stage.
 *
 * Unclaimed on purpose: a match is a suggestion, and a TA shortlisting is what
 * turns it into work. Nobody is contacted by this.
 *
 * Skips anyone already on the opening and anyone excluded, and reports both
 * counts rather than silently doing nothing — "added 0" and "0 were new" are
 * different answers.
 */
export const admitMatches = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    openingId: v.string(),
    candidateIds: v.array(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    await assertJobAccess(ctx, user, jobId, WORKS_THE_DESK);

    const existing = await ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
      .collect();
    const already = new Set(existing.map((a) => a.candidateId as string));

    const excluded = new Set(
      (
        await ctx.db
          .query("matchExclusions")
          .withIndex("by_opening", (q) => q.eq("openingId", jobId))
          .collect()
      ).map((r) => r.candidateId as string),
    );

    let added = 0;
    let skippedExisting = 0;
    let skippedExcluded = 0;

    for (const cid of args.candidateIds) {
      if (already.has(cid)) { skippedExisting++; continue; }
      if (excluded.has(cid)) { skippedExcluded++; continue; }

      const candidate = await ctx.db.get(cid as Id<"candidates">);
      if (!candidate) continue;

      const now = Date.now();
      await ctx.db.insert("applications", {
        candidateId: cid as Id<"candidates">,
        jobId,
        sourceChannel: "database",
        taSourcingChannel: "SCOOP",
        currentStage: "matched_candidates",
        // Unclaimed: no ownerTaId, no setNumber.
        loopIteration: 0,
        isActive: true,
        createdAt: now,
        lastStageChangedAt: now,
        candidateName: candidate.fullName,
        candidateEmail: candidate.email,
        candidatePhone: candidate.phone,
        stageHistory: [
          {
            stage: "matched_candidates",
            enteredAt: new Date(now).toISOString(),
            changedBy: user._id,
            note: args.note ?? "Matched from the database",
          },
        ],
      });
      added++;
    }

    return { added, skippedExisting, skippedExcluded };
  },
});
