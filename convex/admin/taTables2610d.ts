/**
 * The TAs' pipeline tables, third pass, part two (owner, 27 October). The
 * people the TAs named in their answers who are in the database but were never
 * put on the opening (taTables2610c moved only those already on it). Each is
 * put on the opening and then at the stage the TA's table gives — the same two
 * steps the set-CV catch-up uses (createApplication, then the stage move).
 * Someone already on the opening is left where they are; nothing is sent. Run
 * only through the release pipeline, first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/taTables2610d:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";

const DELMO_ENGINEERING = "m17dd0n2x6gt9ybqh09z3c6tcx8fpknh";
const SILVER_BULLET_FINANCE = "m1770jt6a0w5ns7ny7r99fc7x18fz6ke";
const FGL_CUTTING = "m174f3bxxtw95trsnser686t5s8fcxsq";

const ADDS: { candidateId: string; jobId: string; to: PipelineStage; ta: string; who: string }[] = [
  {candidateId: "j9756ezef8nh3bakbysxkr05js8ajw9b",jobId: DELMO_ENGINEERING,to: "client_review",ta: "Sameera",who: "DELMO - HOLDING · Head of Engineering · Kasun Rajapaksha"},
  {candidateId: "j9742hst6er373462e7ac246n18dtx10",jobId: DELMO_ENGINEERING,to: "director_shortlist",ta: "Sameera",who: "DELMO - HOLDING · Head of Engineering · Buddhika Bandara"},
  {candidateId: "j97ahb6zzctm11bwn1qx3979nn8csghv",jobId: DELMO_ENGINEERING,to: "client_review",ta: "Sameera",who: "DELMO - HOLDING · Head of Engineering · Amila Madusanka"},
  {candidateId: "j97fcwhdhd1q1s00vamkjycyh98akvb2",jobId: SILVER_BULLET_FINANCE,to: "interview",ta: "Thushini",who: "Silver Bullet · Finance Manager · Sharmananth Visvanathan"},
  {candidateId: "j9750yzfarwnt1zgvchxndmk998akrb2",jobId: SILVER_BULLET_FINANCE,to: "director_shortlist",ta: "Thushini",who: "Silver Bullet · Finance Manager · Mahesh Seneviratna (older of two profiles)"},
  {candidateId: "j97d23688amcfr4heqer8b2tjx8cbbzz",jobId: FGL_CUTTING,to: "director_shortlist",ta: "Sanduni",who: "FGL Vietnam · Head of Cutting · Rohan Perera"},
];

const LABEL: Record<string, string> = {
  director_shortlist: "Director shortlist", client_review: "Client shortlist", interview: "Interview",
};

/** Is the person there, and are they already on the opening? */
export const check = internalQuery({
  args: { candidateId: v.string(), jobId: v.string() },
  handler: async (ctx, m): Promise<{ candidate: boolean; opening: boolean; appId?: string; stage?: string }> => {
    const candidate = await ctx.db.get(m.candidateId as Id<"candidates">);
    const opening = await ctx.db.get(m.jobId as Id<"jobs">);
    if (!candidate || !opening) return { candidate: !!candidate, opening: !!opening };
    const target = candidate.mergedInto ?? candidate._id;
    const app = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", target))
      .filter((q) => q.eq(q.field("jobId"), opening._id))
      .first();
    return { candidate: true, opening: true, appId: app?._id, stage: app?.currentStage };
  },
});

/** One move, in its own transaction. */
export const moveOne = internalMutation({
  args: { applicationId: v.string(), from: v.string(), to: v.string(), ta: v.string() },
  handler: async (ctx, m): Promise<string> => {
    const app = await ctx.db.get(m.applicationId as Id<"applications">);
    const now = app?.currentStage ?? "missing";
    if (!app || now !== m.from) return `skipped — now at ${now}`;
    await executeStageTransition(ctx, {
      applicationId: app._id,
      targetStage: m.to as PipelineStage,
      actorId: "ta-feedback",
      reason: `${LABEL[m.to]} per ${m.ta}'s pipeline table, 27 Oct (third pass) — added to the opening`,
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
    const rows: { who: string; to: string; result: string }[] = [];
    for (const m of ADDS) {
      let result: string;
      try {
        const c = await ctx.runQuery(internal.admin.taTables2610d.check, { candidateId: m.candidateId, jobId: m.jobId });
        if (!c.candidate || !c.opening) result = `skipped — ${c.candidate ? "opening" : "candidate"} not found`;
        else if (c.appId) result = `skipped — already on the opening at ${c.stage}`;
        else if (args.dryRun) result = "would add and move";
        else {
          const appId = await ctx.runMutation(internal.applications.applications.createApplication, {
            candidateId: m.candidateId as Id<"candidates">,
            jobId: m.jobId as Id<"jobs">,
            sourceChannel: "email",
            metaHeadline: `${m.ta}'s pipeline table, 27 Oct`,
          });
          result = appId
            ? `added — ${await ctx.runMutation(internal.admin.taTables2610d.moveOne, { applicationId: appId, from: "new_cvs", to: m.to, ta: m.ta })}`
            : "skipped — not added";
        }
      } catch (e) {
        result = `error — ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
      rows.push({ who: m.who, to: m.to, result });
    }
    const summary: Record<string, number> = {};
    for (const r of rows) summary[r.result.replace(/ —.*/, "")] = (summary[r.result.replace(/ —.*/, "")] ?? 0) + 1;
    return { dryRun: args.dryRun, summary, rows };
  },
});
