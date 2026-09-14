import { mutation, internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { adjustJobStageStat } from "../jobs/stats";
import { syncCandidateOverallStatus } from "../candidates/candidates";

export const addCandidateToJobFollowUp = mutation({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    const now = Date.now();
    let existingApp = await ctx.db
      .query("applications")
      .withIndex("by_candidate_job", (q) => q.eq("candidateId", args.candidateId).eq("jobId", args.jobId))
      .first();

    let applicationId;
    if (existingApp) {
      const fromStage = existingApp.currentStage;
      await ctx.db.patch(existingApp._id, {
        currentStage: "follow_up",
        followUpEnteredAt: now,
        lastStageChangedAt: now,
        followUpAttemptCount: 0,
        nextFollowUpScheduledAt: undefined,
        nextFollowUpMessage: undefined,
        waitingForCandidateEta: undefined,
        candidateEtaMs: undefined,
        candidateEtaText: undefined,
        flaggedForTaReview: false,
        taReviewReason: undefined,
        isActive: true,
        stageHistory: [
          ...(existingApp.stageHistory ?? []),
          {
            stage: "follow_up",
            enteredAt: new Date().toISOString(),
            changedBy: "system",
            note: "Re-activated in Follow-up stage for Graphic Designer.",
          },
        ],
      });
      await adjustJobStageStat(ctx, args.jobId, fromStage, "follow_up");
      applicationId = existingApp._id;
    } else {
      applicationId = await ctx.db.insert("applications", {
        candidateId: args.candidateId,
        jobId: args.jobId,
        currentStage: "follow_up",
        followUpEnteredAt: now,
        lastStageChangedAt: now,
        followUpAttemptCount: 0,
        isActive: true,
        loopIteration: 1,
        createdAt: now,
        sourceChannel: "WhatsApp",
        stageHistory: [
          {
            stage: "follow_up",
            enteredAt: new Date().toISOString(),
            changedBy: "system",
            note: "Added to Graphic Designer job in follow-up stage.",
          },
        ],
      });
      await adjustJobStageStat(ctx, args.jobId, "new_cvs", "follow_up");
    }

    // Bind WhatsApp session to Graphic Designer job
    const cleanPhone = candidate.phone ? candidate.phone.replace(/\D/g, "") : "";
    if (cleanPhone) {
      const existingSession = await ctx.db
        .query("whatsappSessions")
        .withIndex("by_phone", (q) => q.eq("phone", cleanPhone))
        .first();
      if (existingSession) {
        await ctx.db.patch(existingSession._id, {
          jobId: args.jobId,
          keyword: job.keyword || "GRAPHIC DESIGNER",
          lastInteractionAt: now,
        });
      } else {
        await ctx.db.insert("whatsappSessions", {
          phone: cleanPhone,
          jobId: args.jobId,
          keyword: job.keyword || "GRAPHIC DESIGNER",
          lastInteractionAt: now,
        });
      }
    }

    await syncCandidateOverallStatus(ctx, args.candidateId);
    console.log(`[Follow-Up] Candidate ${candidate.fullName} added to job ${job.title} in follow_up stage.`);
    return { success: true, applicationId };
  },
});


export const scheduleDynamicFollowUp = internalMutation({
  args: {
    applicationId: v.id("applications"),
    nextActionTimeHours: v.number(),
    messageBody: v.string(),
  },
  handler: async (ctx, args) => {
    const nextTimeMs = Date.now() + (args.nextActionTimeHours * 60 * 60 * 1000);
    const app = await ctx.db.get(args.applicationId);
    
    await ctx.db.patch(args.applicationId, {
      nextFollowUpScheduledAt: nextTimeMs,
      nextFollowUpMessage: args.messageBody,
      followUpState: {
        lastContactDay: app?.followUpState?.lastContactDay ?? 0,
        firstChannelUsed: app?.followUpState?.firstChannelUsed ?? "whatsapp",
        replyChannel: "whatsapp",
      },
    });
    console.log(`[Follow-Up] Scheduled next AI message for application ${args.applicationId} in ${args.nextActionTimeHours} hours.`);
  },
});

// Cancels any pending scheduled follow-up for an application.
// Called immediately before sending an inbound reply to prevent the old
// scheduled timestamp from firing and sending a duplicate message.
export const clearPendingFollowUp = internalMutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      nextFollowUpScheduledAt: undefined,
      nextFollowUpMessage: undefined,
    });
    console.log(`[Follow-Up] Cleared pending follow-up for application ${args.applicationId} (inbound reply about to be sent).`);
  },
});

export const resetFollowUpApp = internalMutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const app = await ctx.db.get(args.applicationId);
    const fromStage = app?.currentStage || "unresponsive";

    await ctx.db.patch(args.applicationId, {
      currentStage: "follow_up",
      followUpEnteredAt: now,
      lastStageChangedAt: now,
      followUpAttemptCount: 0,
      nextFollowUpScheduledAt: undefined,
      nextFollowUpMessage: undefined,
      waitingForCandidateEta: undefined,
      candidateEtaMs: undefined,
      candidateEtaText: undefined,
      flaggedForTaReview: false,
      taReviewReason: undefined,
      stageHistory: [
        ...(app?.stageHistory ?? []),
        {
          stage: "follow_up",
          enteredAt: new Date().toISOString(),
          changedBy: "system",
          note: "Reset to Follow-up stage with fresh 7-day window.",
        },
      ],
    });

    if (app) {
      await adjustJobStageStat(ctx, app.jobId, fromStage, "follow_up");
      await syncCandidateOverallStatus(ctx, app.candidateId);
    }
    console.log(`[Follow-Up] Reset application ${args.applicationId} for follow-up evaluation with fresh enteredAt.`);
  },
});

export const resetToNewCvs = internalMutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      currentStage: "new_cvs",
      lastStageChangedAt: Date.now(),
      followUpAttemptCount: 0,
      nextFollowUpScheduledAt: undefined,
      nextFollowUpMessage: undefined,
      flaggedForTaReview: false,
      taReviewReason: undefined,
      stageHistory: [
        {
          stage: "new_cvs",
          enteredAt: new Date().toISOString(),
          changedBy: "system",
        },
      ],
    });
    console.log(`[Pipeline] Reset application ${args.applicationId} back to New CVs stage.`);
  },
});

export const flagForTaReview = internalMutation({
  args: {
    applicationId: v.id("applications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      flaggedForTaReview: true,
      taReviewReason: args.reason,
      nextFollowUpScheduledAt: undefined, // Pause automated nudging completely
      nextFollowUpMessage: undefined,
    });

    const app = await ctx.db.get(args.applicationId);
    if (app) {
      await ctx.db.insert("pipelineEvents", {
        applicationId: args.applicationId,
        candidateId: app.candidateId,
        jobId: app.jobId,
        eventType: "flagged_for_ta_review",
        fromStage: app.currentStage,
        toStage: app.currentStage,
        actorType: "system",
        notes: `Flagged for TA Review: ${args.reason}`,
        createdAt: Date.now(),
      });
    }

    console.log(`[Follow-Up] Application ${args.applicationId} flagged for TA review (${args.reason}). Automated follow-up paused.`);
  },
});

export const clearTaReviewFlag = internalMutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      flaggedForTaReview: false,
      taReviewReason: undefined,
    });
    console.log(`[Follow-Up] Cleared TA review flag for application ${args.applicationId}.`);
  },
});

export const updateCandidateEta = internalMutation({
  args: {
    applicationId: v.id("applications"),
    candidateEtaMs: v.number(),
    candidateEtaText: v.string(),
    waitingForCandidateEta: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      candidateEtaMs: args.candidateEtaMs,
      candidateEtaText: args.candidateEtaText,
      waitingForCandidateEta: args.waitingForCandidateEta,
      nextFollowUpScheduledAt: args.candidateEtaMs, // align schedule with ETA
    });
    console.log(`[Follow-Up] Set ETA for application ${args.applicationId} to ${args.candidateEtaText} (at ${args.candidateEtaMs})`);
  },
});
