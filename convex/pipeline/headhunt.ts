import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { requireUser, requireJobAssignment } from "../lib/permissions";
import { syncCandidateOverallStatus } from "../candidates/candidates";

import { adjustJobStageStat } from "../jobs/stats";

export const uploadHeadhuntedCandidate = mutation({
  args: {
    jobId: v.id("jobs"),
    fullName: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    currentSalary: v.number(),
    expectedSalary: v.number(),
    noticePeriodDays: v.number(),
    cvUploadId: v.id("cvUploads"),
  },
  handler: async (ctx, args) => {
    // Permission check: User must be a recruiter assigned to the job
    const user = await requireUser(ctx);
    await requireJobAssignment(ctx, args.jobId, ["primary_recruiter", "supporting_recruiter"]);

    // Hard gate — do not relax these to optional. This is the one stage
    // where salary/notice data is mandatory at point of entry, since there's
    // no Follow-up sequence afterward to chase missing data for headhunted CVs.
    if (!args.currentSalary || !args.expectedSalary || !args.noticePeriodDays) {
      throw new Error("Current salary, expected salary, and notice period are required for headhunted uploads.");
    }

    const now = Date.now();

    // 1. Create candidate
    const candidateId = await ctx.db.insert("candidates", {
      fullName: args.fullName,
      email: args.email,
      phone: args.phone,
      currentSalary: args.currentSalary,
      expectedSalary: args.expectedSalary,
      noticePeriodDays: args.noticePeriodDays,
      cvUploadId: args.cvUploadId,
      status: "new",
      firstSourceChannel: "headhunting",
      lastUpdatedAt: now,
      firstSeenAt: now,
    });

    // 2. Create application
    const applicationId = await ctx.db.insert("applications", {
      candidateId,
      jobId: args.jobId,
      cvFileId: args.cvUploadId,
      sourceChannel: "headhunting",
      currentStage: "second_shortlist",
      isActive: true,
      loopIteration: 1,
      createdAt: now,
      lastStageChangedAt: now,
      stageHistory: [
        {
          stage: "second_shortlist",
          enteredAt: new Date().toISOString(),
          changedBy: user._id,
          note: `Manually uploaded via headhunting by ${user.fullName}`,
        }
      ]
    });
    
    await adjustJobStageStat(ctx, args.jobId, null, "second_shortlist", true);

    await syncCandidateOverallStatus(ctx, candidateId);

    return { candidateId, applicationId };
  },
});
