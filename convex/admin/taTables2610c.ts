/**
 * The TAs' pipeline tables, third pass (owner, 27 October). The questions sent
 * to Thushini, Sanduni and Sameera after the second pass (taTables2610b) came
 * back; each answer was matched to its application on the opening the same
 * morning. Only the people found on that opening at the stage listed move —
 * Asela Gunathilake (Melwa) and Shanika Chaturanga (Silver Bullet) were
 * already where their table puts them. Each moves only if still at the stage
 * it was checked at; nothing is sent. Run only through the release pipeline,
 * first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/taTables2610c:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";

const MOVES: { applicationId: string; from: string; to: PipelineStage; ta: string; who: string }[] = [
  {applicationId: "js7dyd0jgqdntzy72pct4yse758h17ya",from: "second_shortlist",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Purchasing manager · Thushara Jayathilaka (optional)"},
  {applicationId: "js7dt0j62zgnzvm5emttb6zpzs8h04p5",from: "second_shortlist",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Purchasing manager · Reshan Ariyarathna"},
];

const LABEL: Record<string, string> = {
  director_shortlist: "Director shortlist", client_review: "Client shortlist", interview: "Interview", unresponsive: "Dropped out",
};

/** One move, in its own transaction — a single mutation of all of them hit the one-second limit on 26 October. */
export const moveOne = internalMutation({
  args: { applicationId: v.string(), from: v.string(), to: v.string(), ta: v.string(), dryRun: v.boolean() },
  handler: async (ctx, m): Promise<string> => {
    const app = await ctx.db.get(m.applicationId as Id<"applications">);
    const now = app?.currentStage ?? "missing";
    if (!app || now !== m.from) return `skipped — now at ${now}`;
    if (m.dryRun) return "would move";
    await executeStageTransition(ctx, {
      applicationId: app._id,
      targetStage: m.to as PipelineStage,
      actorId: "ta-feedback",
      reason: `${LABEL[m.to]} per ${m.ta}'s pipeline table, 27 Oct (third pass)`,
      bypassRoleCheck: true,
      skipAutoOutreach: true,
      decidedByReviewer: true,
    });
    return "moved";
  },
});

export const run = internalAction({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const rows: { who: string; from: string; to: string; result: string }[] = [];
    for (const m of MOVES) {
      let result: string;
      try {
        result = await ctx.runMutation(internal.admin.taTables2610c.moveOne, { applicationId: m.applicationId, from: m.from, to: m.to, ta: m.ta, dryRun: args.dryRun });
      } catch (e) {
        result = `error — ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
      rows.push({ who: m.who, from: m.from, to: m.to, result });
    }
    const summary: Record<string, number> = {};
    for (const r of rows) summary[r.result.replace(/ —.*/, "")] = (summary[r.result.replace(/ —.*/, "")] ?? 0) + 1;
    return { dryRun: args.dryRun, summary, rows };
  },
});
