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
import { requireActor, assertJobAccess, WORKS_THE_DESK } from "./guard";
import { initiateFollowUpOutreach, stopFollowUpSequenceForApp } from "../pipeline/followUpHelper";
import { toTaStage } from "./stages";
import { autoFollowUpPatch, questionLabels, sameRoundAs } from "../lib/followUpScope";

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

    if (toTaStage(app.currentStage) !== "follow_up") {
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
    if (!sameRound && before >= max) {
      throw new Error(`All ${max} follow-ups have been sent. Call them, or mark them as dropped out.`);
    }

    const report: { sent: boolean; kind?: "initial" | "reminder" } = { sent: false };
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
    await assertJobAccess(ctx, user, jobId, ["primary_recruiter", "supporting_recruiter", "director"]);

    await ctx.db.patch(jobId, {
      ...autoFollowUpPatch(args.enabled),
      // The CV pipeline asks and reads replies by these; keep them in step.
      customFollowUpQuestions: questionLabels(job.followUpQuestions ?? []),
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, enabled: args.enabled, maxAttempts: job.maxFollowUpAttempts ?? 3 };
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
    await stopFollowUpSequenceForApp(ctx, appId);
    return { ok: true };
  },
});
