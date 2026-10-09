// convex/ta/employersText.ts
//
// Every employer, now and before, for the candidates already on file (9 Oct).
//
// Database search finds people by company through `employersText` and its
// search index (`search_employers_all`). New and re-read CVs get the field when
// they are written (candidates/candidates:refreshEmployersText). This fills it
// in for everyone read before, from the current employer and the career, with
// the résumé's history first, the same rule the profile uses (withCareer).
//
// A migration the release pipeline runs (run_function), never a script from a
// laptop (AGENTS.md rule 5):
//
//   run_function ta/employersText:backfill run_args {"dryRun": true}
//   run_function ta/employersText:backfill run_args {"dryRun": false, "all": true}
//
// `dryRun` is true unless the caller says false, and reports what it would
// change. `all` chains page after page until the table is done. A second run
// finds nothing left to do.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { employersTextOf } from "../lib/employers";

export const backfill = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    /** Keep going to the end of the table, a page at a time. */
    all: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const res = await ctx.db.query("candidates").paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? 200 });

    let changed = 0;
    let withEmployers = 0;
    let withPastEmployers = 0;
    const examples: Record<string, unknown>[] = [];

    for (const c of res.page) {
      const resume = await ctx.db
        .query("candidateResumes")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", c._id))
        .first();
      const text = employersTextOf(c, resume);
      if (text) withEmployers++;
      if (text && text.includes(" | ")) withPastEmployers++;
      if ((c.employersText ?? undefined) === text) continue;
      changed++;
      if (examples.length < 10) examples.push({ id: c._id, was: c.employersText ?? null, now: text ?? null });
      if (!dryRun) await ctx.db.patch(c._id, { employersText: text });
    }

    const nextCursor = res.isDone ? null : res.continueCursor;
    if (args.all && nextCursor) {
      await ctx.scheduler.runAfter(0, internal.ta.employersText.backfill, { dryRun, cursor: nextCursor, limit: args.limit, all: true });
    }
    const summary = { dryRun, scanned: res.page.length, changed, withEmployers, withPastEmployers, nextCursor };
    // A chained run reports each page here, since only the first page answers the caller.
    console.log(`[employersText.backfill] ${JSON.stringify(summary)}`);
    return { ...summary, examples };
  },
});
