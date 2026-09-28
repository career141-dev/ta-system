// convex/ta/ageExperience.ts
//
// Birth dates and experience for the candidates already on file — 28 Sep, with
// the new reading of both (lib/candidateAge, lib/experience).
//
// New CVs get both when they are read (cvs/cvExtraction). This fills in the
// ones read before: the birth date from the CV text held in the database, and
// the stored experience figure summed again from the job dates. The desk's
// screens work both out afresh whenever they show them (lib/candidateFacts);
// the stored figure is what Database search filters on.
//
// A migration the release pipeline runs (run_function), never a script from a
// laptop (AGENTS.md rule 5). `dryRun` is true unless the caller says false,
// and reports what it would change; `all` chains page after page until the
// table is done; a second run finds nothing left to do. A birth date typed in
// by hand, or read before, is never overwritten.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { findBirth } from "../lib/candidateAge";
import { experienceOn } from "../lib/experience";

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

    let births = 0;
    let fromNic = 0;
    let fromStatedAge = 0;
    let mismatches = 0;
    let noText = 0;
    let experienceChanged = 0;
    const examples: Record<string, unknown>[] = [];

    for (const c of res.page) {
      const resume = await ctx.db
        .query("candidateResumes")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", c._id))
        .first();
      const patch: Record<string, unknown> = {};

      if (!c.dateOfBirth) {
        const text = c.rawText ?? resume?.rawText ?? "";
        if (!text) noText++;
        const birth = text ? findBirth(text, new Date(c.firstSeenAt ?? c._creationTime)) : null;
        if (birth) {
          births++;
          if (birth.source === "nic") fromNic++;
          if (birth.source === "stated_age") fromStatedAge++;
          if (birth.mismatch) mismatches++;
          patch.dateOfBirth = birth.date;
          patch.dateOfBirthSource = birth.source;
          if (birth.mismatch) patch.dateOfBirthNote = birth.mismatch;
        }
      }

      const career = (resume?.jobHistory?.length ? resume.jobHistory : c.jobHistory) ?? [];
      const birthYear = Number(((patch.dateOfBirth as string | undefined) ?? c.dateOfBirth ?? "").slice(0, 4)) || undefined;
      const years = experienceOn(career, new Date(), birthYear)?.years;
      if (years !== undefined && years !== c.totalExperienceYears) {
        experienceChanged++;
        patch.totalExperienceYears = years;
      }

      if (Object.keys(patch).length) {
        if (examples.length < 10) {
          examples.push({ id: c._id, was: { age: c.age ?? null, experience: c.totalExperienceYears ?? null }, now: patch });
        }
        if (!dryRun) await ctx.db.patch(c._id, patch);
      }
    }

    const nextCursor = res.isDone ? null : res.continueCursor;
    if (args.all && nextCursor) {
      await ctx.scheduler.runAfter(0, internal.ta.ageExperience.backfill, { dryRun, cursor: nextCursor, limit: args.limit, all: true });
    }
    const summary = { dryRun, scanned: res.page.length, births, fromNic, fromStatedAge, mismatches, noText, experienceChanged, nextCursor };
    // A chained run reports each page here, since only the first page answers the caller.
    console.log(`[ageExperience.backfill] ${JSON.stringify(summary)}`);
    return { ...summary, examples };
  },
});
