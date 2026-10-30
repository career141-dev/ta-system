/**
 * Switch "Automatic follow-up" on for the openings still open (30 Oct).
 *
 * Why: the owner wants follow-up to run without a TA pressing anything — the
 * first template goes when a candidate is shortlisted, reminders every 24
 * hours, and the assistant answers replies. All of that already happens on an
 * opening whose switch is on; the switch just started off, so most openings
 * waited for a TA's Send. New openings now start with it on (ta/openings.ts,
 * CaptureForm); this turns it on for the ones already open.
 *
 * Nothing is sent by this: the first message goes only when a candidate next
 * ENTERS Follow-up. People already waiting there are not messaged by it (the
 * sweep leaves an opening's candidates with no first message alone,
 * lib/followUpScope.ts). Every send still passes lib/outreachSafety.ts.
 *
 * Run by the release pipeline (run_function), never from a laptop:
 *
 *   1. {}                                   → dry run, first page: the open
 *                                              openings that are off. Changes nothing.
 *      {"cursor": "<next>"}                 → the next page.
 *   2. {"dryRun": false, "openingIds": [...]} → switches on exactly those ids.
 *
 * Paged, 25 openings a read: a job row carries its embedding and match
 * results, and reading them all at once can pass the per-call read limit.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { isGone } from "../../src/lib/bin";
import { autoFollowUpPatch, followUpOn, questionLabels } from "../lib/followUpScope";

const CLOSED = ["closed", "filled", "cancelled"];

export const run = internalMutation({
  args: {
    /** FALSE switches on. Omit it to see the list first. */
    dryRun: v.optional(v.boolean()),
    /** For the real run: the ids the dry run listed. */
    openingIds: v.optional(v.array(v.string())),
    /** Dry run only: the page after this one. */
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (dryRun) {
      const page = await ctx.db.query("jobs").paginate({ cursor: args.cursor ?? null, numItems: 25 });
      const off = page.page
        .filter((j) => !isGone(j) && !CLOSED.includes(j.status) && !followUpOn(j))
        .map((j) => ({ id: j._id as string, title: j.title, status: j.status }));
      return {
        dryRun: true,
        openings: off,
        next: page.isDone ? null : page.continueCursor,
        howTo: page.isDone
          ? 'Last page. To switch on, run {"dryRun": false, "openingIds": [the ids from every page]}.'
          : 'More openings: run again with {"cursor": "<next>"}.',
      };
    }

    const switched: string[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (const id of args.openingIds ?? []) {
      const job = await ctx.db.get(id as Id<"jobs">);
      if (!job) { skipped.push({ id, why: "not found" }); continue; }
      if (isGone(job) || CLOSED.includes(job.status)) { skipped.push({ id, why: `no longer open (${job.status})` }); continue; }
      if (followUpOn(job)) { skipped.push({ id, why: "already on" }); continue; }
      await ctx.db.patch(job._id, {
        ...autoFollowUpPatch(true),
        // The CV pipeline asks and reads replies by these; kept in step as setAuto does.
        customFollowUpQuestions: questionLabels(job.followUpQuestions ?? []),
        updatedAt: new Date().toISOString(),
      });
      switched.push(id);
    }
    return { dryRun: false, switchedOn: switched.length, switched, skipped };
  },
});
