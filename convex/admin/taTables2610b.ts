/**
 * The TAs' pipeline tables, second pass (owner, 26 October): Hassan's,
 * Sanduni's and Thushini's again — for the people added since by the set-CV
 * catch-up (mailIntake/setCvs) — and Sameera's status sheet. Cross-checked
 * against the whole applications table that afternoon. One move per
 * application (the further stage when two sheets name the same person); a
 * person rejected in the system whom Sameera's sheet has on the Director's
 * shortlist is brought back (owner's decision). Each moves only if still at
 * the stage it was checked at; nothing is sent. Run only through the release
 * pipeline, first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/taTables2610b:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";

const MOVES: { applicationId: string; from: string; to: PipelineStage; ta: string; who: string }[] = [
  {applicationId: "js7fxa0vk223egz82wrb1rvkm18gmtz6",from: "matched_candidates",to: "unresponsive",ta: "Hassan",who: "DeltaSpike · Business Growth Manager"},
  {applicationId: "js73gytawsqyb1dmgrjn3gjx858f9x38",from: "matched_candidates",to: "director_shortlist",ta: "Hassan",who: "BALPP · HEAD OF ACADEMIC"},
  {applicationId: "js72ngya8qhfce3fc1pcj2yjfx8h1cfd",from: "new_cvs",to: "director_shortlist",ta: "Hassan",who: "MELWA · EHS Manager"},
  {applicationId: "js7fn4rxk2hmsta4a4wt7sqd3d8h1fp9",from: "new_cvs",to: "director_shortlist",ta: "Hassan",who: "MELWA · EHS Manager"},
  {applicationId: "js7eetg3f9tzpszmy22q82w6vh8fa67e",from: "second_shortlist",to: "director_shortlist",ta: "Hassan",who: "DELMO - HOLDING · Manager - Cloud Infrastructure & Security"},
  {applicationId: "js72v3w0qj0y9qs2w3k08p81s98ftzan",from: "director_shortlist",to: "unresponsive",ta: "Sanduni",who: "Silver Bullet · Head of Electrical"},
  {applicationId: "js71eae3pwjq1zpd2hyxhm08pd8gcj9z",from: "second_shortlist",to: "director_shortlist",ta: "Sanduni",who: "PGP · Head of Manufacturing Excellence"},
  {applicationId: "js7bshsr9q08ze6f77p2dqzjwn8h092w",from: "new_cvs",to: "director_shortlist",ta: "Sanduni",who: "Q COLLECTION (SL) · Senior Executive - Electrical"},
  {applicationId: "js7578ay4ma1ccn4689t95erwh8h1xmc",from: "new_cvs",to: "director_shortlist",ta: "Sanduni",who: "Q COLLECTION (SL) · Senior Executive - Electrical"},
  {applicationId: "js7c7d6zgjxnx75qbdzaf36z818fs8bs",from: "second_shortlist",to: "director_shortlist",ta: "Sanduni",who: "DELMO - HOLDING · Head of Engineering"},
  {applicationId: "js77mmnzrr8hetcgy9r9gzvckh8fr8v6",from: "second_shortlist",to: "client_review",ta: "Sanduni",who: "DELMO - HOLDING · Head of Engineering"},
  {applicationId: "js77dcmsdswpz9sw5fa9qpbtc58fcwhk",from: "second_shortlist",to: "director_shortlist",ta: "Sanduni",who: "FGL Vietnam · Head of Cutting"},
  {applicationId: "js73ty7qv2n0qyemktfc8xcyr58fg1h1",from: "second_shortlist",to: "director_shortlist",ta: "Sanduni",who: "FGL Vietnam · Head of Cutting"},
  {applicationId: "js75xyqqbd0374b4qnvvkbv1318femgd",from: "second_shortlist",to: "director_shortlist",ta: "Sanduni",who: "FGL Vietnam · Head of Cutting"},
  {applicationId: "js7f2ydnemsq8xwjezcxz91em18fa3h2",from: "follow_up",to: "director_shortlist",ta: "Thushini",who: "DELMO - HOLDING · IT MANAGER"},
  {applicationId: "js75c7v2t2s631aeggq2e3nenh8fdy1e",from: "matched_candidates",to: "interview",ta: "Thushini",who: "DELMO - HOLDING · IT MANAGER"},
  {applicationId: "js7e1k1vssntdnffe1pc2y6n7s8fqr9r",from: "new_cvs",to: "director_shortlist",ta: "Thushini",who: "Lanka Hospital · RESIDENT MICROBIOLOGIST"},
  {applicationId: "js7cnkjrk51msmmq6556aeaypn8ffp13",from: "second_shortlist",to: "director_shortlist",ta: "Sameera",who: "FGL Vietnam · Head of Cutting"},
  {applicationId: "js726p6z4vyck3m0rqjcsn67ex8fc10r",from: "rejected",to: "director_shortlist",ta: "Sameera",who: "FGL Vietnam · Head of Cutting"},
  {applicationId: "js7fwc9d9rx8tj00wez8kpvv3h8gx61k",from: "matched_candidates",to: "director_shortlist",ta: "Sameera",who: "Silver Bullet · Head of Electrical"},
  {applicationId: "js78qxv1n1h1e3vxmhsq88e84h8h0v99",from: "new_cvs",to: "director_shortlist",ta: "Sameera",who: "SQ - BD · Head of Quality Assurance"},
  {applicationId: "js73ddafnsftbr0qnp0r2hwdk58h0h00",from: "new_cvs",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Purchasing manager"},
  {applicationId: "js72gf24y1w28hatkeeygn7jt98g6gy8",from: "director_shortlist",to: "client_review",ta: "Sameera",who: "SQ - BD · General Manager - Innovation & Operations"},
  {applicationId: "js7fy33xfzbspg18bf1g714p7d8fq1p3",from: "new_cvs",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Head of Engineering"},
  {applicationId: "js7ftecpgk712q2yajas8q41k18fa13a",from: "follow_up",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
  {applicationId: "js714q86ph3b45n5ytfcywjryd8fa9a0",from: "follow_up",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
  {applicationId: "js7dgkcrjn0v4mjwat7qb0mfx98faw9g",from: "follow_up",to: "client_review",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
  {applicationId: "js7b3hwp09fyrg6kpne7ph0c8d8fbdhm",from: "follow_up",to: "client_review",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
  {applicationId: "js7byagrkv43f49d2e87466mss8fan3d",from: "follow_up",to: "client_review",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
  {applicationId: "js73yjrcp0bgmc6eccxnrkpz898fbxw1",from: "follow_up",to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Security Manager"},
];

const LABEL: Record<string, string> = {
  ta_shortlist: "TA shortlist", director_shortlist: "Director shortlist", client_review: "Client shortlist", interview: "Interview", unresponsive: "Dropped out",
};

/**
 * One move, in its own transaction. The first real run did all of them in one
 * mutation and the backend stopped it at its one-second limit — nothing was
 * changed (26 October) — so each is its own, and the action walks the list.
 */
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
      reason: m.to === "unresponsive"
        ? `Dropped out — ${m.ta}'s pipeline table, 26 Oct (second pass)`
        : `${LABEL[m.to]} per ${m.ta}'s pipeline table, 26 Oct (second pass)`,
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
        result = await ctx.runMutation(internal.admin.taTables2610b.moveOne, { applicationId: m.applicationId, from: m.from, to: m.to, ta: m.ta, dryRun: args.dryRun });
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
