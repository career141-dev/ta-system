// convex/mailIntake/shortlist.ts
//
// shortlists@ — the database side of filing a Director's or a client's
// shortlist: what to match against, and moving the people it names.
//
// The reading of the mail (which kind, which opening) is convex/lib/shortlistMail.ts;
// the mailbox handling is process.ts. Nothing here sends anything: a shortlist
// mail moves candidates between stages and stops there.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";
import { addressOf } from "../lib/postRouting";
import { shouldMove, TARGET_STAGE, type OpeningLite } from "../lib/shortlistMail";

/** Openings a shortlist can be for, and the addresses the Director writes from. */
export const context = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ openings: OpeningLite[]; directorAddresses: string[] }> => {
    // Active only: a shortlist for a filled or cancelled opening is not filed
    // on it, it is held.
    const jobs = await ctx.db.query("jobs").collect();
    const openings = jobs
      .filter((j) => j.status === "active")
      .map((j) => ({ id: j._id as string, title: j.title, clientName: j.clientName, clientContactEmail: j.clientContactEmail ?? null }));
    const users = await ctx.db.query("users").collect();
    const directorAddresses = users
      .filter((u) => u.role === "director" && u.isActive)
      .flatMap((u) => [addressOf(u.email), addressOf(u.routingEmail ?? null)])
      .filter((a): a is string => Boolean(a));
    return { openings, directorAddresses };
  },
});

/** Where each candidate stands on each opening — the evidence for inferring a client's opening. */
export const applicationsFor = internalQuery({
  args: { candidateIds: v.array(v.id("candidates")) },
  handler: async (ctx, args) => {
    const out: { candidateId: string; openingId: string; stage: string }[] = [];
    for (const candidateId of args.candidateIds) {
      const apps = await ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId)).collect();
      for (const a of apps) {
        if (a.isActive === false) continue;
        out.push({ candidateId: candidateId as string, openingId: a.jobId as string, stage: a.currentStage ?? "new_cvs" });
      }
    }
    return out;
  },
});

/**
 * Move the named candidates to Director or Client Shortlist on one opening.
 *
 * Forward only (shouldMove): nobody is pulled back, and a rejected or dropped
 * candidate is left for a person. A candidate not yet on the opening is
 * reported as `missing` so the caller can put them there first.
 *
 * Runs as the system rather than a user, the way the rest of the intake does.
 * Director Review's own gate (CV, expected salary, notice period) applies
 * to a TA sending someone to the Director; it is not applied here, because
 * the Director's mail is the Director having already decided.
 */
export const moveShortlisted = internalMutation({
  args: {
    openingId: v.id("jobs"),
    kind: v.union(v.literal("director"), v.literal("client")),
    candidateIds: v.array(v.id("candidates")),
    mailbox: v.string(),
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    const target = TARGET_STAGE[args.kind];
    const moved: Id<"candidates">[] = [];
    const already: Id<"candidates">[] = [];
    const left: { candidateId: Id<"candidates">; stage: string }[] = [];
    const missing: Id<"candidates">[] = [];
    for (const candidateId of args.candidateIds) {
      const apps: Doc<"applications">[] = await ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId)).collect();
      const app = apps.find((a) => a.jobId === args.openingId);
      if (!app) { missing.push(candidateId); continue; }
      const stage = app.currentStage ?? "new_cvs";
      if (stage === target) { already.push(candidateId); continue; }
      if (!shouldMove(stage, target)) { left.push({ candidateId, stage }); continue; }
      await executeStageTransition(ctx, {
        applicationId: app._id,
        targetStage: target as PipelineStage,
        actorId: "shortlist-mail",
        reason: `${args.kind === "director" ? "Director" : "Client"} shortlist received at ${args.mailbox}: ${args.subject.slice(0, 120)}`,
        bypassRoleCheck: true,
        // Moving between shortlist stages never starts an outreach sequence.
        skipAutoOutreach: true,
        // The reviewer's mail is the decision; Director Review's details are not asked for.
        decidedByReviewer: true,
      });
      moved.push(candidateId);
    }
    return { moved, already, left, missing };
  },
});
