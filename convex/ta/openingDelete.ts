// convex/ta/openingDelete.ts
//
// Deleting an opening, and everything filed under it — but never a candidate.
//
// Since 28 Sep the Delete button moves an opening to the Bin (ta/bin.ts), and
// this runs seven days later — from the daily clean-up, or from "Delete now"
// in the Bin. The opening is marked as being deleted at once (so it leaves every list straight away), then its data
// is removed in batches, because a large opening carries thousands of rows —
// applications, and under each one its calls, messages, events, reviews,
// interviews and offers — more than one transaction may write.
//
// The candidates themselves stay. Each one loses their application on this
// opening and their overall status is worked out again from whatever else they
// are in, so somebody who was only in this opening is back in the database as
// an available candidate. A CV that came in for the job is still a CV: its
// intake row keeps the candidate and only loses the opening.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireActor } from "./guard";
import { syncCandidateOverallStatus } from "../candidates/candidates";

/** Who may delete a whole opening: a desk decision, not one recruiter's. */
export const MAY_DELETE_OPENINGS = ["admin", "ta_manager", "director", "ops"];

/** Rows removed per transaction, well inside Convex's write limit. */
const BATCH = 400;

/** Rows hanging off one application, by the index that finds them. */
const APPLICATION_CHILDREN: [table: string, index: string][] = [
  ["pipelineEvents", "by_application"],
  ["aiCalls", "by_application"],
  ["voiceCallSessions", "by_application_startedAt"],
  ["voiceAnswers", "by_application_committedAt"],
  ["communications", "by_applicationId"],
  ["candidateInquiries", "by_applicationId"],
  ["directorReviews", "by_applicationId"],
  ["clientReviews", "by_applicationId"],
  ["interviews", "by_applicationId"],
  ["offers", "by_applicationId"],
  ["callFeedback", "by_application"],
  ["taOutreach", "by_application"],
  ["taScreeningCalls", "by_application"],
];

/** Rows belonging to the opening itself, by the index that finds them. */
const OPENING_CHILDREN: [table: string, index: string, field: string][] = [
  ["jobAssignments", "by_jobId", "jobId"],
  ["jobChannels", "by_job", "jobId"],
  ["pipelineEvents", "by_job_time", "jobId"],
  ["aiCalls", "by_job", "jobId"],
  ["communications", "by_job", "jobId"],
  ["candidateInquiries", "by_jobId", "jobId"],
  ["directorReviews", "by_jobId", "jobId"],
  ["clientReviews", "by_jobId", "jobId"],
  ["interviews", "by_jobId", "jobId"],
  ["offers", "by_jobId", "jobId"],
  ["placements", "by_jobId", "jobId"],
  ["rejectionLoopEvents", "by_jobId", "jobId"],
  ["ingestionLog", "by_job", "jobId"],
  ["esaRecords", "by_job", "jobId"],
  ["pipeline", "by_job", "jobId"],
  ["followUpSequences", "by_job_and_cv", "jobId"],
  ["jobPosts", "by_opening", "openingId"],
  ["briefs", "by_opening", "openingId"],
  ["linkVault", "by_opening", "openingId"],
  ["researchReports", "by_opening", "openingId"],
  ["benchmarks", "by_opening", "openingId"],
  ["profileSuggestions", "by_opening", "openingId"],
  ["sourcingChat", "by_opening", "openingId"],
  ["jdChat", "by_opening", "openingId"],
  ["matchRuns", "by_opening", "openingId"],
  ["matchExclusions", "by_opening", "openingId"],
  ["shortlistDecisionReviews", "by_opening", "openingId"],
  ["reviewRounds", "by_opening", "openingId"],
  ["eodEmailCopies", "by_opening", "openingId"],
  ["strategyAssignments", "by_opening", "openingId"],
  // Left behind until 2 Oct: the job id is required on most of these, so a
  // row outliving its opening points at nothing.
  ["whatsappSessions", "by_jobId", "jobId"],
  ["notifications", "by_jobId", "jobId"],
  ["match_scores", "by_job_score", "jobId"],
  ["job_assets", "by_jobId", "jobId"],
  ["custom_filters", "by_jobId", "jobId"],
  ["pipeline_health_reports", "by_job_date", "jobId"],
  ["voiceSimulationReservations", "by_jobId", "jobId"],
];

/**
 * Rows that are not the opening's and stay, but name it: the reference is
 * cleared. Intake rows keep their CV (see the top of this file); a saved search
 * is its owner's; a candidate is never deleted.
 */
const OPENING_REFERENCES: [table: string, index: string, field: string, cleared: null | undefined][] = [
  ["intakeItems", "by_opening", "openingId", null],
  ["savedSearches", "by_opening", "openingId", null],
  ["candidates", "by_firstSourceJobId", "firstSourceJobId", undefined],
];

/**
 * Rows that name the opening inside an array, which no index can find: read a
 * page per step, the cursor carried to the next step in its arguments.
 */
const SCANS: Record<string, (row: any, jobId: string) => Record<string, unknown> | null> = {
  mailIntakeMessages: (row, jobId) =>
    (row.openingIds ?? []).includes(jobId)
      ? { openingIds: row.openingIds.filter((id: string) => id !== jobId) }
      : null,
  intakeItems: (row, jobId) =>
    (row.alsoFiledTo ?? []).some((f: { openingId: string }) => f.openingId === jobId)
      ? { alsoFiledTo: row.alsoFiledTo.filter((f: { openingId: string }) => f.openingId !== jobId) }
      : null,
};
const SCAN_ORDER = Object.keys(SCANS);
const SCAN_PAGE = 200;

/** What deleting would take, for the confirmation. */
export const preview = internalQuery({
  args: { actorId: v.string(), openingId: v.string() },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const jobId = ctx.db.normalizeId("jobs", args.openingId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job) return null;
    const apps = await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", job._id)).collect();
    return {
      title: job.title,
      applications: apps.length,
      candidates: new Set(apps.map((a) => a.candidateId as string)).size,
    };
  },
});

/** One batch. Reschedules itself until the opening is gone. */
export const step = internalMutation({
  args: {
    jobId: v.id("jobs"),
    /** Where the array scans (SCANS) have got to; absent until they start. */
    scan: v.optional(v.object({ table: v.string(), cursor: v.union(v.string(), v.null()) })),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return { done: true };
    if (!job.deletingAt) return { done: true, reason: "not marked for deletion" };

    let budget = BATCH;
    const del = async (id: string) => {
      await ctx.db.delete(id as never);
      budget--;
    };

    // 1. Applications, with everything under each one. The candidate stays.
    const apps = await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", args.jobId)).take(50);
    for (const app of apps) {
      if (budget <= 0) break;
      const finished = await removeApplicationChildren(ctx, app._id, del, () => budget);
      if (!finished) break;
      await del(app._id);
      await syncCandidateOverallStatus(ctx, app.candidateId);
    }
    if (apps.length > 0) {
      await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, { jobId: args.jobId });
      return { done: false, stage: "applications" };
    }

    // 2. The opening's own rows.
    for (const [table, index, field] of OPENING_CHILDREN) {
      const rows = await ctx.db
        .query(table as never)
        .withIndex(index as never, (q: any) => q.eq(field, args.jobId))
        .take(Math.max(1, budget));
      for (const r of rows) {
        // A strategy row's proof images are files in storage: they go with it.
        if (table === "strategyAssignments") {
          for (const p of (r as { proofs?: { id: string }[] }).proofs ?? []) {
            await ctx.storage.delete(p.id as Id<"_storage">).catch(() => {});
          }
        }
        await del((r as { _id: string })._id);
      }
      if (budget <= 0) {
        await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, { jobId: args.jobId });
        return { done: false, stage: table };
      }
    }

    // 3. Rows that stay, without the job: CVs that came in for it, saved
    // searches, and candidates whose first source it was.
    for (const [table, index, field, cleared] of OPENING_REFERENCES) {
      const rows = await ctx.db
        .query(table as never)
        .withIndex(index as never, (q: any) => q.eq(field, args.jobId))
        .take(Math.max(1, budget));
      for (const r of rows) {
        await ctx.db.patch((r as { _id: string })._id as never, { [field]: cleared } as never);
        budget--;
      }
      if (budget <= 0) {
        await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, { jobId: args.jobId });
        return { done: false, stage: table };
      }
    }

    // 3b. The job inside arrays — one page per step, as Convex allows a
    // single paginated read per transaction.
    const scan = args.scan ?? { table: SCAN_ORDER[0], cursor: null };
    const pick = SCANS[scan.table];
    if (pick) {
      const page = await ctx.db
        .query(scan.table as never)
        .paginate({ numItems: SCAN_PAGE, cursor: scan.cursor });
      for (const r of page.page) {
        const patch = pick(r, args.jobId as string);
        if (patch) await ctx.db.patch((r as { _id: string })._id as never, patch as never);
      }
      const next = page.isDone
        ? SCAN_ORDER[SCAN_ORDER.indexOf(scan.table) + 1]
        : scan.table;
      if (next) {
        await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, {
          jobId: args.jobId,
          scan: { table: next, cursor: page.isDone ? null : page.continueCursor },
        });
        return { done: false, stage: scan.table };
      }
    }

    // 4. The opening.
    await ctx.db.delete(args.jobId);
    console.log(`[Delete opening] "${job.title}" (${args.jobId}) and its data removed; candidates kept.`);
    return { done: true };
  },
});

/** Remove the rows under one application. False when the batch ran out first. */
async function removeApplicationChildren(
  ctx: MutationCtx,
  applicationId: Id<"applications">,
  del: (id: string) => Promise<void>,
  left: () => number,
): Promise<boolean> {
  for (const [table, index] of APPLICATION_CHILDREN) {
    const rows = await ctx.db
      .query(table as never)
      .withIndex(index as never, (q: any) => q.eq("applicationId", applicationId))
      .take(Math.max(1, left()));
    for (const r of rows) await del((r as { _id: string })._id);
    if (left() <= 0) return false;
  }
  return true;
}
