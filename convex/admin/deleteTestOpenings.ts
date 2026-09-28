/**
 * Delete the dummy openings — every job with the word TEST in its title.
 *
 * Why this exists: testing on production left a pile of made-up jobs ("TEST
 * FLLOWUP" and the like) in every list, and deleting them one by one from the
 * three-dots menu is slow. The owner asked for all of them to go (25 Sep).
 *
 * Two steps, run by the release pipeline (run_function), never from a laptop:
 *
 *   1. {}                          → dry run. Lists every match with its id,
 *                                     status and how many applications it holds.
 *                                     Changes nothing.
 *   2. {"dryRun": false, "openingIds": [...]}
 *                                  → deletes exactly those ids, and only if each
 *                                     one still matches. The ids come from step 1,
 *                                     so what is deleted is what the owner read.
 *
 * "TEST" is matched as a whole word, any case: "TEST FLLOWUP" and "Test job"
 * match, "Latest" and "Contest" do not. A real role such as "QA Test Engineer"
 * would match too — which is why step 2 takes the ids, not the rule.
 *
 * Each opening goes straight to the batched delete (ta/openingDelete.ts), not
 * to the Bin — these are dummies, not something anyone will want back:
 * marked at once, then removed in batches with everything under it. Its
 * candidates stay in the database.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { isGone } from "../../src/lib/bin";

const isTest = (title: string) => /\btest\b/i.test(title);

export const run = internalMutation({
  args: {
    /** FALSE deletes. Omit it to see the list first. */
    dryRun: v.optional(v.boolean()),
    /** For the real run: the ids the dry run listed. */
    openingIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    // ponytail: every job read at once; the desk has hundreds, not tens of thousands.
    const jobs = await ctx.db.query("jobs").collect();
    // One already in the Bin is left to the Bin (ta/bin.ts).
    const matches = jobs.filter((j) => isTest(j.title) && !isGone(j));

    const describe = async (j: Doc<"jobs">) => {
      const apps = await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", j._id)).collect();
      return { id: j._id as string, title: j.title, status: j.status, applications: apps.length };
    };

    if (dryRun) {
      const list = await Promise.all(matches.map(describe));
      return {
        dryRun: true,
        matches: list.length,
        openings: list,
        next: 'To delete, run again with {"dryRun": false, "openingIds": [the ids above you want gone]}.',
      };
    }

    if (!args.openingIds?.length) {
      throw new Error("Give openingIds — the ids from the dry run. Nothing was deleted.");
    }
    const byId = new Map(matches.map((j) => [j._id as string, j]));
    const deleted: { id: string; title: string }[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const now = Date.now();
    for (const id of args.openingIds) {
      const job = byId.get(id);
      if (!job) {
        skipped.push({ id, reason: "not found, in the Bin, already being deleted, or no longer has TEST in its title" });
        continue;
      }
      await ctx.db.patch(job._id, { deletingAt: now, status: "cancelled", updatedAt: new Date(now).toISOString() });
      await ctx.scheduler.runAfter(0, internal.ta.openingDelete.step, { jobId: job._id });
      deleted.push({ id, title: job.title });
    }
    return { dryRun: false, deleted: deleted.length, openings: deleted, skipped };
  },
});
