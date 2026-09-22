// convex/ta/firstPost.ts
//
// The advert every opening starts with, and the migration that gives one to
// each open opening that has none.
//
// The shared mailboxes route by post (pipeline/postFiling.ts): an opening with
// no post cannot receive a single application. Openings made in the TA app had
// none — the post was left to a TA adding one on the LinkedIn Job tab, which
// nobody did (22 September). The first post carries the opening's title, the
// primary recruiter and the job's keyword, the same shape backfill.ts gave the
// restored jobs; the TA edits its title and aliases when the LinkedIn advert
// reads differently.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { firstPostFor } from "../lib/firstPost";

export { firstPostFor };

/**
 * Give every active opening with no post its first one. Dry run unless
 * `dryRun: false`; idempotent — an opening that has any post is left alone.
 * Run by the release pipeline (run_function), never from a laptop.
 */
export const ensurePosts = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const jobs = (await ctx.db.query("jobs").collect()).filter((j) => j.status === "active");
    const withPost = new Set((await ctx.db.query("jobPosts").collect()).map((p) => p.openingId as string));
    const missing = jobs.filter((j) => !withPost.has(j._id as string));
    if (!dryRun) {
      const now = Date.now();
      for (const job of missing) await ctx.db.insert("jobPosts", firstPostFor(job, now));
    }
    return {
      dryRun,
      activeOpenings: jobs.length,
      withPost: jobs.length - missing.length,
      missingPost: missing.length,
      noRecruiter: missing.filter((j) => !j.primaryRecruiterId).length,
      created: dryRun ? 0 : missing.length,
      sample: missing.slice(0, 15).map((j) => j.title),
    };
  },
});
