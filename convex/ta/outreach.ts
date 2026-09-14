// convex/ta/outreach.ts
//
// What was actually said to a candidate, and what a call recorded.
//
// The TA platform keeps a log rather than a counter. The backend has both — a
// `communications` table and `followUpAttemptCount` on the application — and
// the two can disagree. Reading the log is what makes "what did we actually
// say to this person" answerable, which is the question that matters when a
// candidate rings up asking why they were closed.
//
// Sending is NOT here. The backend's senders are the tuned, approved path
// (`metaTemplateSender` for the template outside the 24-hour window,
// `whatsappOutbound.sendWhatsApp` inside it, `graphEmail.sendGraphEmail` for
// mail) and they stay the only way anything leaves. Plan step 10 points the
// TA platform's drafts at them. This module reads, and records a call that a
// person made themselves.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK } from "./guard";

export const messagesFor = query({
  args: {
    actorId: v.optional(v.string()),
    candidateId: v.optional(v.string()),
    applicationId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);

    let rows: Doc<"communications">[] = [];
    if (args.applicationId) {
      rows = await ctx.db
        .query("communications")
        .withIndex("by_applicationId", (q) =>
          q.eq("applicationId", args.applicationId as Id<"applications">),
        )
        .collect();
    } else if (args.candidateId) {
      rows = await ctx.db
        .query("communications")
        .withIndex("by_candidate_time", (q) =>
          q.eq("candidateId", args.candidateId as Id<"candidates">),
        )
        .collect();
    } else {
      throw new Error("Name a candidate or an application.");
    }

    const at = (c: Doc<"communications">) =>
      typeof c.sentAt === "number" ? c.sentAt : Date.parse(String(c.sentAt)) || 0;
    rows.sort((a, b) => at(b) - at(a));

    return rows.slice(0, args.limit ?? 100).map((c) => ({
      id: c._id as string,
      candidateId: c.candidateId as string,
      applicationId: (c.applicationId ?? null) as string | null,
      direction: c.direction,
      channel: c.channel,
      subject: c.subject ?? null,
      body: c.body,
      // Two status fields exist on this table and they are written by
      // different paths; both are surfaced rather than one being picked, so a
      // disagreement is visible instead of hidden.
      deliveryStatus: c.deliveryStatus,
      legacyStatus: c.status ?? null,
      stoppedSequence: c.stoppedSequence,
      sequenceDay: c.sequenceDay ?? null,
      sentAt: at(c),
    }));
  },
});

/** Where the follow-up sequence has got to, read off the application itself —
 *  which is where the live state actually lives, not `followUpSequences`. */
export const followUpState = query({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const app = await ctx.db.get(args.applicationId as Id<"applications">);
    if (!app) return null;
    const job = await ctx.db.get(app.jobId);

    return {
      applicationId: app._id as string,
      attemptCount: app.followUpAttemptCount ?? 0,
      lastContactDay: app.followUpState?.lastContactDay ?? null,
      replyChannel: app.followUpState?.replyChannel ?? null,
      nextScheduledAt: app.nextFollowUpScheduledAt ?? null,
      enteredAt: app.followUpEnteredAt ?? null,
      lastCandidateReplyAt: app.lastCandidateReplyAt ?? null,
      waitingForEta: app.waitingForCandidateEta ?? false,
      etaMs: app.candidateEtaMs ?? null,
      flaggedForTaReview: app.flaggedForTaReview ?? false,
      taReviewReason: app.taReviewReason ?? null,
      // The four the sequence is chasing, and the job's own questions.
      collected: {
        cv: app.followUpCvReceived ?? null,
        currentSalary: app.followUpCurrentSalary ?? null,
        expectedSalary: app.followUpExpectedSalary ?? null,
        noticePeriod: app.followUpNoticePeriod ?? null,
      },
      customAnswers: app.customFollowUpAnswers ?? {},
      customQuestions: job?.customFollowUpQuestions ?? [],
      maxAttempts: job?.maxFollowUpAttempts ?? null,
      agentEnabled: job?.agent3Enabled ?? false,
    };
  },
});

/**
 * Record a call a person made themselves.
 *
 * Their own documentation says the automated calls are suspended over number
 * registration, so the mode that is actually useful today is a TA on the phone
 * working through the same script and typing what they heard. This writes that
 * down; it places no call.
 */
export const recordCall = mutation({
  args: {
    actorId: v.optional(v.string()),
    applicationId: v.string(),
    kind: v.union(
      v.literal("pre_interview"), v.literal("post_interview"),
      v.literal("post_offer"), v.literal("ad_hoc"),
    ),
    outcome: v.union(
      v.literal("reached"), v.literal("no_answer"),
      v.literal("rescheduled"), v.literal("declined"),
    ),
    body: v.string(),
    structured: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("Application not found");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);

    const id = await ctx.db.insert("callFeedback", {
      applicationId: appId,
      kind: args.kind,
      outcome: args.outcome,
      body: args.body,
      structured: args.structured ?? null,
      source: "manual" as const,
      recordedBy: user._id,
      recordedAt: Date.now(),
    });
    return { id: id as string };
  },
});

export const callsFor = query({
  args: { actorId: v.optional(v.string()), applicationId: v.string() },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    const rows = await ctx.db
      .query("callFeedback")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", args.applicationId as Id<"applications">),
      )
      .collect();
    rows.sort((a, b) => b.recordedAt - a.recordedAt);
    return rows.map((c) => ({
      id: c._id as string,
      kind: c.kind,
      outcome: c.outcome,
      body: c.body,
      structured: c.structured ?? null,
      source: c.source,
      recordedBy: c.recordedBy as string,
      recordedAt: c.recordedAt,
    }));
  },
});
