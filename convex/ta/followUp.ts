// convex/ta/followUp.ts
//
// The follow-up sequence, started by a person.
//
// The sequence itself is the proven one from the older app —
// `initiateFollowUpOutreach` in convex/pipeline/followUpHelper.ts:
//
//   first press  → Day 0: the approved Meta template `career141_initial_outreach`
//                  (name, role, requirements, what is missing) + a Graph email
//   later presses → a reminder: WhatsApp free text inside Meta's 24-hour window,
//                  the `career141_followup_reminder` template outside it, + email
//
// What is different on this desk is only WHO starts it. Moving a card into
// Follow-up sends nothing (see `skipAutoOutreach` in ta/applications.ts); a TA
// presses Send. With the opening's switch on (`setAuto` below) the sweep in
// convex/crons.ts sends the reminders after that first Send, as it does for
// the CV pipeline's jobs. Every message still passes the outreach gate
// (convex/lib/outreachSafety.ts), so in test mode it reaches only the test
// recipient.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { outreachLive } from "../lib/outreachSafety";
import { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, assertNotAnotherTasCandidate, isDeskWideUser, WORKS_THE_DESK } from "./guard";
import { initiateFollowUpOutreach, stopFollowUpSequenceForApp } from "../pipeline/followUpHelper";
import { toTaStage } from "./stages";
import { autoFollowUpPatch, justSent, questionLabels, sameRoundAs } from "../lib/followUpScope";
import { internal } from "../_generated/api";
import { MAX_WHATSAPP_NUDGE_HOURS } from "../lib/followUpWindow";

/**
 * Send the next follow-up for one candidate: the Day 0 outreach if nothing has
 * gone out yet, otherwise a reminder.
 */
export const send = internalMutation({
  args: {
    actorId: v.string(),
    applicationId: v.string(),
    /** One channel (the WhatsApp / Email buttons), or both when omitted. */
    channel: v.optional(v.union(v.literal("whatsapp"), v.literal("email"))),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    assertNotAnotherTasCandidate(user, app);

    const taStage = toTaStage(app.currentStage);
    if (taStage !== "ai_follow_up" && taStage !== "ta_follow_up") {
      throw new Error("Move the candidate to Follow-up before sending.");
    }
    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("That candidate no longer exists.");
    if ((candidate as { doNotContact?: boolean }).doNotContact) {
      throw new Error("This candidate has asked not to be contacted.");
    }
    const hasPhone = !!(candidate.phone ?? "").replace(/\D/g, "");
    const hasEmail = !!candidate.email;
    if (args.channel === "whatsapp" && !hasPhone) throw new Error("No phone number on file for WhatsApp.");
    if (args.channel === "email" && !hasEmail) throw new Error("No email address on file.");
    if (!hasPhone && !hasEmail) {
      throw new Error("No phone number or email address on file.");
    }

    const before = app.followUpAttemptCount ?? 0;
    const job = await ctx.db.get(app.jobId);
    const max = job?.maxFollowUpAttempts ?? 3;
    const now = Date.now();
    const channel = args.channel ?? "both";
    const sameRound = sameRoundAs({
      attempts: before,
      lastManualSendAt: app.followUpLastManualSendAt,
      lastManualChannels: app.followUpLastManualChannels,
      channel,
      now,
    });
    // Two presses on one candidate (two TAs, or a double click) are read one after
    // the other here, so the second sees what the first recorded: nothing is sent
    // twice, and no attempt is used up for it (2 Oct).
    if (justSent({ attempts: before, lastManualSendAt: app.followUpLastManualSendAt, lastManualChannels: app.followUpLastManualChannels, channel, now })) {
      return {
        sent: false as const,
        duplicate: true as const,
        reason: `A follow-up was sent to this candidate a moment ago (follow-up ${before} of ${max}). Nothing was sent again.`,
      };
    }
    if (!sameRound && before >= max) {
      throw new Error(`All ${max} follow-ups have been sent. Call them, or mark them as dropped out.`);
    }

    const report: { sent: boolean; kind?: "initial" | "reminder"; blocked?: boolean } = { sent: false };
    const communicationId = await initiateFollowUpOutreach(ctx, appId, {
      isManual: true,
      only: args.channel,
      sameRound,
      report,
    });
    if (!report.sent) {
      // initiateFollowUpOutreach returns early when every detail is already in.
      return { sent: false as const, reason: "Everything the follow-up asks for is already collected." };
    }
    if (report.blocked) {
      return {
        sent: false as const,
        blocked: true as const,
        reason: "Not sent — messages to candidates are switched off on this system (test mode). It is recorded in the chat and not counted as a follow-up.",
      };
    }

    const sentOn = channel === "both" ? ["whatsapp", "email"] : [channel];
    await ctx.db.patch(appId, {
      followUpLastManualSendAt: sameRound ? app.followUpLastManualSendAt : now,
      followUpLastManualChannels: sameRound ? [...(app.followUpLastManualChannels ?? []), ...sentOn] : sentOn,
    });
    const after = (await ctx.db.get(appId))?.followUpAttemptCount ?? before;
    return {
      sent: true as const,
      kind: report.kind ?? (before === 0 ? ("initial" as const) : ("reminder" as const)),
      attempt: after,
      maxAttempts: max,
      sameRound,
      channels: {
        whatsapp: hasPhone && channel !== "email",
        email: hasEmail && channel !== "whatsapp",
      },
      communicationId: (communicationId ?? null) as string | null,
    };
  },
});

/**
 * Whether messages would reach real people, for the banner on the screen.
 * Says whether the test recipients are set — never what they are.
 */
export const gateStatus = internalQuery({
  args: {},
  handler: async () => ({
    live: outreachLive(),
    testEmailSet: !!(process.env.OUTREACH_TEST_EMAIL ?? "").trim(),
    testPhoneSet: !!(process.env.OUTREACH_TEST_PHONE ?? "").trim(),
    metaConfigured: !!(process.env.META_ACCESS_TOKEN ?? "").trim(),
    graphSenderConfigured: !!(process.env.MS_SENDER_EMAIL || process.env.OUTBOUND_EMAIL_SENDER),
  }),
});

/**
 * The opening's automatic follow-up switch.
 *
 * On: WhatsApp and email reminders every 24 hours after a TA's first Send, up
 * to the opening's attempt ceiling (3 unless set), then Unresponsive — the CV
 * pipeline's sequence, run by the seven-minute sweep. Replies arrive through
 * the WhatChimp webhook and are read into the record. Off: nothing automatic;
 * Send still works by hand.
 */
export const setAuto = internalMutation({
  args: { actorId: v.string(), openingId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = args.openingId as Id<"jobs">;
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Opening not found");
    // Admin, director, TA lead and ops on any opening; a TA on their own
    // (30 Oct). The page offered every TA lead the button — the same rule,
    // src/lib/auth.ts opening.manage — but a lead not on the opening's team
    // was refused here with "You are not assigned to this opening".
    if (!isDeskWideUser(user)) {
      await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);
    }

    await ctx.db.patch(jobId, {
      ...autoFollowUpPatch(args.enabled),
      // The CV pipeline asks and reads replies by these; keep them in step.
      customFollowUpQuestions: questionLabels(job.followUpQuestions ?? []),
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, enabled: args.enabled, maxAttempts: job.maxFollowUpAttempts ?? 3 };
  },
});

/**
 * Take over the conversation (30 Oct): the assistant stops answering and the
 * reminders stop; anything still queued is cancelled. The candidate's replies
 * are still read into the record, and the TA is told when they write.
 */
export const takeOver = internalMutation({
  args: { actorId: v.string(), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    assertNotAnotherTasCandidate(user, app);
    await stopFollowUpSequenceForApp(ctx, appId);
    await ctx.db.patch(appId, { taTookOverAt: Date.now(), taTookOverBy: user._id, taTookOverVia: "button" });
    return { ok: true };
  },
});

/**
 * Give the conversation back to the assistant (30 Oct). If the candidate's
 * last WhatsApp is still unanswered it answers now — reading what the TA
 * said, labelled as theirs — otherwise the next reminder is scheduled
 * inside WhatsApp's free window. Also clears a "Needs you" flag.
 */
export const handBack = internalMutation({
  args: { actorId: v.string(), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    assertNotAnotherTasCandidate(user, app);
    await ctx.db.patch(appId, {
      taTookOverAt: undefined,
      taTookOverBy: undefined,
      taTookOverVia: undefined,
      flaggedForTaReview: false,
      taReviewReason: undefined,
    });
    const taStage = toTaStage(app.currentStage);
    if (taStage !== "ai_follow_up" && taStage !== "ta_follow_up") return { ok: true, answering: false };
    const last = await ctx.db
      .query("communications")
      .withIndex("by_applicationId", (q) => q.eq("applicationId", appId))
      .order("desc")
      .first();
    if (last?.direction === "inbound" && last.channel === "whatsapp") {
      await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.answerWhatsAppTurn, {
        candidateId: app.candidateId,
        applicationId: appId,
        inboundAt: Number(last.sentAt),
      });
      return { ok: true, answering: true };
    }
    await ctx.db.patch(appId, { nextFollowUpScheduledAt: Date.now() + MAX_WHATSAPP_NUDGE_HOURS * 60 * 60 * 1000 });
    return { ok: true, answering: false };
  },
});

/** Stop the sequence: cancels anything still pending and clears the schedule. */
export const stop = internalMutation({
  args: { actorId: v.string(), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    assertNotAnotherTasCandidate(user, app);
    await stopFollowUpSequenceForApp(ctx, appId);
    return { ok: true };
  },
});
