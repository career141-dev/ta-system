// convex/ta/fixes2609.ts
//
// Data corrections from the 21 September testing round.
//
// Each one is an internal mutation the release pipeline runs (run_function),
// never a script against live from a laptop (AGENTS.md rule 5). Each takes
// `dryRun` — true unless the caller says otherwise — and reports what it
// found and what it would change, so it can be rehearsed on a copy first.
// Each works in pages (`cursor` / `limit`) so no single run reads the whole
// table, and is idempotent: a second run finds nothing left to do.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const page = { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) };

/**
 * The sample referees ("Dr. Robert Sterling", "Sarah Lin", +1 555 numbers)
 * that CV re-reads inserted whenever the model found none. They are not
 * people; they were shown as contactable referees on real candidates.
 */
const SAMPLE_REFEREES = [
  { name: "dr. robert sterling", email: "r.sterling@apextech.com" },
  { name: "sarah lin", email: "slin@nexus-enterprise.io" },
];

export const removeSampleReferees = internalMutation({
  args: page,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const res = await ctx.db.query("referees").paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? 500 });
    const fake = res.page.filter((r) =>
      SAMPLE_REFEREES.some(
        (s) => r.name.trim().toLowerCase() === s.name && (r.email ?? "").trim().toLowerCase() === s.email,
      ),
    );
    if (!dryRun) for (const r of fake) await ctx.db.delete(r._id);
    return {
      dryRun,
      scanned: res.page.length,
      sampleReferees: fake.length,
      candidates: [...new Set(fake.map((r) => r.candidateId))].length,
      deleted: dryRun ? 0 : fake.length,
      nextCursor: res.isDone ? null : res.continueCursor,
    };
  },
});

/**
 * Follow-up counts used up by messages the safety guard stopped.
 *
 * With outreach off every WhatsApp and email is stopped ("Test mode:
 * blocked…"), but each round still counted as one of the three, so a candidate
 * showed "2 of 3 sent" having received nothing. Where every outbound message
 * on an application was stopped that way, the count goes back to zero and the
 * schedule is cleared. An application with any message that did go is left
 * alone.
 */
export const resetBlockedFollowUpCounts = internalMutation({
  args: page,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const res = await ctx.db.query("applications").paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? 200 });
    const reset: string[] = [];
    for (const app of res.page) {
      if (!app.followUpAttemptCount) continue;
      const sent = (
        await ctx.db
          .query("communications")
          .withIndex("by_applicationId", (q) => q.eq("applicationId", app._id))
          .collect()
      ).filter((c) => c.direction === "outbound");
      if (sent.length === 0) continue;
      const allStopped = sent.every((c) => c.deliveryStatus === "failed" && /test mode: blocked/i.test(c.errorMessage ?? ""));
      if (!allStopped) continue;
      reset.push(app._id as string);
      if (!dryRun) await ctx.db.patch(app._id, { followUpAttemptCount: 0, nextFollowUpScheduledAt: undefined });
    }
    return {
      dryRun,
      scanned: res.page.length,
      toReset: reset.length,
      reset: dryRun ? 0 : reset.length,
      sample: reset.slice(0, 10),
      nextCursor: res.isDone ? null : res.continueCursor,
    };
  },
});
