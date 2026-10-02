// convex/ta/jdApproval.ts
//
// CVs that came in while an opening's JD was still a draft were filed but not
// scored (cvs/cvScoringActions, lib/jdGate). When the JD is approved they are
// scored against it here (25 September).

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { SCORE_STAGGER_MS } from "../lib/jdGate";

/** The most CVs one approval scores; anything past it is scored by hand. */
const MAX_WAITING = 400;

export const scoreWaitingCvs = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.jdStatus !== "approved") return { scheduled: 0 };
    // Only new CVs nobody has scored: a CV a TA already moved on is theirs.
    const waiting = (
      await ctx.db
        .query("applications")
        .withIndex("by_job_stage", (q) => q.eq("jobId", args.jobId).eq("currentStage", "new_cvs"))
        .take(MAX_WAITING * 2)
    ).filter((a) => a.aiMatchScore === undefined && a.isActive).slice(0, MAX_WAITING);
    for (const [i, a] of waiting.entries()) {
      await ctx.scheduler.runAfter(i * SCORE_STAGGER_MS, internal.cvs.cvScoringActions.processCvScoring, {
        candidateId: a.candidateId,
        jobId: args.jobId,
      });
    }
    return { scheduled: waiting.length };
  },
});
