import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireUser, requireJobAssignment } from "../lib/permissions";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { initiateFollowUpOutreach, stopFollowUpSequenceForApp } from "./followUpHelper";
import { adjustJobStageStat } from "../jobs/stats";
import { adjustGlobalStat } from "../stats/statsHelper";
import { expectedSalaryOnFile, noticePeriodOnFile, needsReviewDetails } from "../ta/stages";
import { isDeskWideUser } from "../ta/guard";

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
  /**
   * Do not START the outreach sequence on entering follow_up. The TA platform
   * sends only when a person presses Send; stopping on leave still happens.
   */
  skipAutoOutreach?: boolean;
  /**
   * The Director's or the client's own shortlist (mailIntake/shortlist.ts):
   * the reviewer has decided, so the follow-up details are not asked for on
   * the way past Director Review.
   */
  decidedByReviewer?: boolean;
}

/** The UTC date a placement was counted under (stats/statsHelper.ts counts by UTC day). */
function placedOn(app: { stageHistory?: { stage: string; enteredAt: string }[]; lastStageChangedAt?: number }): string | null {
  const entry = [...(app.stageHistory ?? [])].reverse().find((h) => h.stage === "placed");
  const at = entry ? Date.parse(entry.enteredAt) : app.lastStageChangedAt;
  return at && Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null;
}

/**
 * Central State Machine Executor for Application Pipeline Transitions
 */
export async function executeStageTransition(
  ctx: MutationCtx,
  opts: TransitionOptions
) {
  const { applicationId, targetStage, actorId, reason, bypassRoleCheck, skipAutoOutreach, decidedByReviewer } = opts;

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
  let actingUser: Doc<"users"> | null = null;
  if (!bypassRoleCheck) {
    const user = await requireUser(ctx);
    actingUser = user;
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

  // A placement is undone only by someone who looks after the whole desk.
  // Moves the state machine does not list were only logged (TA moves bypass
  // the check), so any TA could turn a placement back into a rejection
  // (2 Oct). The automation never moves anyone out of Placed.
  if (currentStage === "placed") {
    if (!actingUser && actorId) {
      const id = ctx.db.normalizeId("users", String(actorId));
      actingUser = id ? await ctx.db.get(id) : null;
    }
    if (!actingUser || !isDeskWideUser(actingUser)) {
      throw new Error("Only a TA lead, a director, ops or an admin can move somebody out of Placed.");
    }
  }

  // 4. Stage Specific Validation Gates
  // Director Review's details are needed to enter it, and to go past it
  // without stopping there: a move straight from Follow-up to the Director's
  // or the client's shortlist skipped the check (2 Oct).
  if (needsReviewDetails(currentStage, targetStage, decidedByReviewer === true)) {
    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found for application");
    const hasCV =
      app.followUpCvReceived === true ||
      (app.followUpCvReceived === undefined && (!!candidate.cvUploadId || !!app.cvFileId));
    // Words count ("Not disclosed", "Negotiable"): ta/stages.ts, 28 Sep.
    const hasExpectedSalary =
      app.followUpExpectedSalary === true ||
      (app.followUpExpectedSalary === undefined && expectedSalaryOnFile(candidate));
    const hasNoticePeriod =
      app.followUpNoticePeriod === true ||
      (app.followUpNoticePeriod === undefined && noticePeriodOnFile(candidate));

    if (!(hasCV && hasExpectedSalary && hasNoticePeriod)) {
      // Name only what is actually missing for THIS candidate — not all
      // every time, which sends a TA hunting for something already on file.
      const missing: string[] = [];
      if (!hasCV) missing.push("CV");
      if (!hasExpectedSalary) missing.push("expected salary");
      if (!hasNoticePeriod) missing.push("notice period");
      throw new Error(
        targetStage === "second_shortlist"
          ? `Cannot move to Director Review: still missing ${missing.join(", ")}. Finish the follow-up first.`
          : `Cannot skip Director Review: still missing ${missing.join(", ")}. Finish the follow-up first.`
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

  // Closed and open are part of the move, not left to whoever reads the row:
  // a rejected application stayed isActive, and one brought back kept its old
  // rejection reason, so lists and counts disagreed about who was still in
  // (testing, 21 Sep).
  // The backend's closed stages: rejected, and unresponsive (the desk's "dropped out").
  const closed = targetStage === "rejected" || targetStage === "unresponsive";
  const wasClosed = ["rejected", "unresponsive"].includes(String(app.currentStage));
  // The drop-out reason was only ever in the stage history, so the app could
  // not tell someone moved back to Excel Tables from someone who left — the
  // local store always kept it on the row (29 Sep).
  if (targetStage === "unresponsive") patch.droppedOutReason = reason || undefined;
  if (closed) patch.isActive = false;
  else if (wasClosed) {
    patch.isActive = true;
    patch.rejectedBy = undefined;
    patch.rejectedAt = undefined;
    patch.rejectReason = undefined;
    patch.rejectedFromStage = undefined;
    patch.droppedOutReason = undefined;
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

  // A placement that falls through comes off the day it was counted on —
  // it used to stay counted for good (2 Oct).
  if (currentStage === "placed") {
    const dateStr = placedOn(app as any);
    const daily = dateStr
      ? await ctx.db.query("dailyStats").withIndex("by_dateStr", (q: any) => q.eq("dateStr", dateStr)).first()
      : null;
    if (daily && (daily.placements ?? 0) > 0) await ctx.db.patch(daily._id, { placements: daily.placements - 1 });
  }

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
  if (targetStage === "follow_up" || targetStage === "ta_shortlist") {
    if (!skipAutoOutreach) await initiateFollowUpOutreach(ctx, applicationId);
  } else {
    await stopFollowUpSequenceForApp(ctx, applicationId);
  }

  // 8. Sync Candidate Global Overall Status
  await syncCandidateOverallStatus(ctx, app.candidateId);

  return { success: true, previousStage: currentStage, newStage: targetStage };
}
