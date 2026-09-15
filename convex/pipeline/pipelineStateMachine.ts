import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireUser, requireJobAssignment } from "../lib/permissions";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { initiateFollowUpOutreach, stopFollowUpSequenceForApp } from "./followUpHelper";
import { adjustJobStageStat } from "../jobs/stats";
import { adjustGlobalStat } from "../stats/statsHelper";

export const PIPELINE_STAGES = [
  "new_cvs",
  "matched_candidates",
  "ta_shortlist",
  "follow_up",
  "second_shortlist",
  "director_shortlist",
  "client_review",
  "interview",
  "offer",
  "placed",
  "rejected",
  "unresponsive",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// Directed Acyclic Graph (DAG) for valid stage transitions
export const ALLOWED_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  new_cvs: ["matched_candidates", "ta_shortlist", "follow_up", "rejected", "unresponsive"],
  matched_candidates: ["ta_shortlist", "follow_up", "rejected", "unresponsive"],
  ta_shortlist: ["follow_up", "second_shortlist", "rejected", "unresponsive"],
  follow_up: ["second_shortlist", "ta_shortlist", "rejected", "unresponsive"],
  second_shortlist: ["director_shortlist", "client_review", "rejected", "unresponsive"],
  director_shortlist: ["client_review", "rejected", "unresponsive"],
  client_review: ["interview", "offer", "rejected", "unresponsive"],
  interview: ["offer", "placed", "rejected", "unresponsive"],
  offer: ["placed", "rejected", "unresponsive"],
  placed: [], // Terminal state
  rejected: ["new_cvs", "ta_shortlist"], // Re-evaluation flow
  unresponsive: ["new_cvs", "follow_up"],
};

export interface TransitionOptions {
  applicationId: Id<"applications">;
  targetStage: PipelineStage;
  actorId?: Id<"users"> | string;
  reason?: string;
  bypassRoleCheck?: boolean;
}

/**
 * Central State Machine Executor for Application Pipeline Transitions
 */
export async function executeStageTransition(
  ctx: MutationCtx,
  opts: TransitionOptions
) {
  const { applicationId, targetStage, actorId, reason, bypassRoleCheck } = opts;

  const app = await ctx.db.get(applicationId);
  if (!app) throw new Error(`[StateMachine] Application ${applicationId} not found`);

  const currentStage = (app.currentStage || "new_cvs") as PipelineStage;

  // 1. Idempotency Check: if already at target stage, exit cleanly
  if (currentStage === targetStage) {
    return { success: true, idempotent: true, stage: currentStage };
  }

  // 2. Validate Allowed Transition
  const allowed = ALLOWED_TRANSITIONS[currentStage];
  if (allowed && !allowed.includes(targetStage) && !bypassRoleCheck) {
    console.warn(
      `[StateMachine] Non-standard transition requested: ${currentStage} -> ${targetStage} for app ${applicationId}`
    );
  }

  // 3. Permission & Role Checks
  let actorDisplayId = actorId || "system";
  if (!bypassRoleCheck) {
    const user = await requireUser(ctx);
    actorDisplayId = user._id;

    if (["director_shortlist", "client_review"].includes(targetStage)) {
      if (user.role !== "admin") {
        await requireJobAssignment(ctx, app.jobId, ["director", "primary_recruiter"]);
      }
    } else {
      await requireJobAssignment(ctx, app.jobId, [
        "primary_recruiter",
        "supporting_recruiter",
        "director",
      ]);
    }
  }

  // 4. Stage Specific Validation Gates
  if (targetStage === "second_shortlist") {
    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found for application");
    const hasCV =
      app.followUpCvReceived === true ||
      (app.followUpCvReceived === undefined && (!!candidate.cvUploadId || !!app.cvFileId));
    const hasCurrentSalary =
      app.followUpCurrentSalary === true ||
      (app.followUpCurrentSalary === undefined && candidate.currentSalary !== undefined);
    const hasExpectedSalary =
      app.followUpExpectedSalary === true ||
      (app.followUpExpectedSalary === undefined && candidate.expectedSalary !== undefined);
    const hasNoticePeriod =
      app.followUpNoticePeriod === true ||
      (app.followUpNoticePeriod === undefined && candidate.noticePeriodDays !== undefined);

    if (!(hasCV && hasCurrentSalary && hasExpectedSalary && hasNoticePeriod)) {
      throw new Error(
        "Cannot move to 2nd Shortlist: Missing mandatory candidate details (CV, Current Salary, Expected Salary, Notice Period)."
      );
    }
  }

  const now = Date.now();
  const patch: Record<string, any> = {
    currentStage: targetStage,
    lastStageChangedAt: now,
    stageHistory: [
      ...(app.stageHistory ?? []),
      {
        stage: targetStage,
        enteredAt: new Date(now).toISOString(),
        changedBy: actorDisplayId,
        note: reason,
      },
    ],
  };

  if (targetStage === "follow_up" || targetStage === "ta_shortlist") {
    patch.followUpEnteredAt = now;
  }

  await ctx.db.patch(applicationId, patch);

  // 5. Audit Logging
  await ctx.db.insert("pipelineEvents", {
    applicationId,
    candidateId: app.candidateId,
    jobId: app.jobId,
    eventType: `stage_change_${targetStage}`,
    fromStage: currentStage,
    toStage: targetStage,
    actorType: bypassRoleCheck ? "system" : "user",
    actorId: actorDisplayId as any,
    notes: reason || `Transitioned to ${targetStage}`,
    createdAt: now,
  });

  // 6. Statistics Adjustments
  await adjustJobStageStat(ctx, app.jobId, currentStage, targetStage);

  if (targetStage === "placed") {
    await adjustGlobalStat(ctx, "placement");
    await ctx.runMutation(internal.meta.trigger.triggerMetaEventIfEligible, {
      applicationId,
      eventName: "Hire",
    });
  } else if (targetStage === "interview") {
    await ctx.runMutation(internal.meta.trigger.triggerMetaEventIfEligible, {
      applicationId,
      eventName: "Schedule",
    });
  } else if (["ta_shortlist", "matched_candidates", "second_shortlist"].includes(targetStage)) {
    await ctx.runMutation(internal.meta.trigger.triggerMetaEventIfEligible, {
      applicationId,
      eventName: "QualifiedLead",
    });
  }

  // 7. Automated Sequence Triggers & Stops
  if (targetStage === "follow_up") {
    await initiateFollowUpOutreach(ctx, applicationId);
  } else {
    await stopFollowUpSequenceForApp(ctx, applicationId);
  }

  // 8. Sync Candidate Global Overall Status
  await syncCandidateOverallStatus(ctx, app.candidateId);

  return { success: true, previousStage: currentStage, newStage: targetStage };
}
