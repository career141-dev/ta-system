// convex/mailIntake/repair.ts
//
// Undoing what the linkedin@ trial got wrong (16–17 September), before the
// routing and placement fixes: applicants filed to openings their advert was
// not for, and applicants moved from New CVs to Matched candidates by a second
// placement nobody made.
//
// Each call names the applications (worked out from the message log against
// the corrected routing rules) and every one is checked again here: created by
// the trial, from LinkedIn, in a stage no person moved it to. Anything else is
// left alone and reported. `dryRun` reports without changing anything.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { adjustJobStageStat } from "../jobs/stats";
import { syncCandidateOverallStatus } from "../candidates/candidates";

/** The trial ran from the first sync until the corrected placement was deployed. */
const TRIAL_FROM = Date.parse("2026-09-16T14:50:00Z");
const TRIAL_TO = Date.parse("2026-09-17T04:10:00Z");
const MAX_PER_CALL = 15;

function fromTrial(app: { _creationTime: number; sourceChannel?: string } | null): boolean {
  return Boolean(app && app.sourceChannel === "linkedin" && app._creationTime >= TRIAL_FROM && app._creationTime < TRIAL_TO);
}

/** Remove trial applications on openings the corrected rules would not file them to. */
export const removeMisfiled = internalMutation({
  args: {
    applicationIds: v.array(v.id("applications")),
    dryRun: v.boolean(),
    confirm: v.literal("remove misfiled trial applications"),
  },
  handler: async (ctx, args) => {
    if (args.applicationIds.length > MAX_PER_CALL) throw new Error(`At most ${MAX_PER_CALL} per call.`);
    const removed: string[] = [];
    const left: { id: string; why: string }[] = [];
    for (const id of args.applicationIds) {
      const app = await ctx.db.get(id);
      if (!app) { left.push({ id, why: "gone" }); continue; }
      if (!fromTrial(app)) { left.push({ id, why: "not created by the trial" }); continue; }
      if (!["new_cvs", "matched_candidates", "ta_shortlist"].includes(app.currentStage)) {
        left.push({ id, why: `moved on to ${app.currentStage}` });
        continue;
      }
      removed.push(id);
      if (args.dryRun) continue;
      const byApp = async (table: string, index: string, field = "applicationId") => {
        for (const r of await ctx.db.query(table as never).withIndex(index as never, (q: any) => q.eq(field, id)).collect()) {
          await ctx.db.delete((r as { _id: Id<any> })._id);
        }
      };
      await byApp("pipelineEvents", "by_application");
      await byApp("callFeedback", "by_application");
      await byApp("taOutreach", "by_application");
      await byApp("taScreeningCalls", "by_application");
      await byApp("interviews", "by_applicationId");
      await byApp("offers", "by_applicationId");
      await byApp("taAlerts", "by_subject", "subjectId");
      await adjustJobStageStat(ctx, app.jobId, app.currentStage, app.currentStage, false, true);
      await ctx.db.delete(id);
      if (await ctx.db.get(app.candidateId)) await syncCandidateOverallStatus(ctx, app.candidateId);
    }
    return { removed: removed.length, left, dryRun: args.dryRun };
  },
});

/** Put trial applicants the second placement moved to Matched candidates back in New CVs. */
export const restoreToNewCvs = internalMutation({
  args: {
    applicationIds: v.array(v.id("applications")),
    dryRun: v.boolean(),
    confirm: v.literal("restore trial applicants to new cvs"),
  },
  handler: async (ctx, args) => {
    if (args.applicationIds.length > MAX_PER_CALL) throw new Error(`At most ${MAX_PER_CALL} per call.`);
    let restored = 0;
    const left: { id: string; why: string }[] = [];
    for (const id of args.applicationIds) {
      const app = await ctx.db.get(id);
      if (!app || !fromTrial(app)) { left.push({ id, why: app ? "not created by the trial" : "gone" }); continue; }
      if (app.currentStage !== "matched_candidates") { left.push({ id, why: `now in ${app.currentStage}` }); continue; }
      // Moved by the placement minutes after it was created, and not since.
      if (!app.lastStageChangedAt || app.lastStageChangedAt - app._creationTime > 30 * 60_000) {
        left.push({ id, why: "moved later, possibly by a person" });
        continue;
      }
      restored++;
      if (args.dryRun) continue;
      await ctx.db.patch(id, { currentStage: "new_cvs" as any, lastStageChangedAt: Date.now() });
      await adjustJobStageStat(ctx, app.jobId, "matched_candidates", "new_cvs");
      if (await ctx.db.get(app.candidateId)) await syncCandidateOverallStatus(ctx, app.candidateId);
    }
    return { restored, left, dryRun: args.dryRun };
  },
});
