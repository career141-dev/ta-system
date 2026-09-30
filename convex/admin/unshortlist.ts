/**
 * Take a shortlist claim off one application, so the other TA can work them.
 *
 * Why this exists: Amal Dassanayake Usp (Security Manager, DELMO - HOLDING) was
 * shortlisted by Uzmaan, which locks him for everyone else ("you cannot
 * contact"). The owner asked for the claim to be lifted (30 Sep). There is no
 * button for this, so it is a migration.
 *
 * Two steps, run by the release pipeline (run_function), never from a laptop:
 *
 *   1. {"applicationId": "..."}                   → dry run. Shows who, which
 *                                                    opening, who holds it.
 *   2. {"applicationId": "...", "dryRun": false}  → clears the claim.
 *
 * Only the claim is cleared (owner, shortlisted time, set). The stage is left
 * where it is: moving someone back out of follow-up is a separate decision.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const run = internalMutation({
  args: {
    applicationId: v.string(),
    /** FALSE clears the claim. Omit it to see the row first. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const app = await ctx.db.get(args.applicationId as Id<"applications">);
    if (!app) throw new Error("Application not found. Nothing was changed.");

    const [candidate, job, owner] = await Promise.all([
      ctx.db.get(app.candidateId),
      ctx.db.get(app.jobId),
      app.ownerTaId ? ctx.db.get(app.ownerTaId) : null,
    ]);
    const row = {
      applicationId: app._id as string,
      candidate: candidate?.fullName ?? null,
      opening: job?.title ?? null,
      stage: app.currentStage,
      shortlistedBy: owner?.fullName ?? null,
      shortlistedAt: app.shortlistedAt ? new Date(app.shortlistedAt).toISOString() : null,
      setNumber: app.setNumber ?? null,
    };

    if (!app.ownerTaId) return { dryRun, changed: false, reason: "Not shortlisted by anyone.", row };
    if (dryRun) {
      return { dryRun: true, row, next: 'To clear it, run again with "dryRun": false.' };
    }
    await ctx.db.patch(app._id, { ownerTaId: undefined, shortlistedAt: undefined, setNumber: undefined });
    return { dryRun: false, changed: true, row };
  },
});
