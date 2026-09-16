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
// presses Send. Every message still passes the outreach gate
// (convex/lib/outreachSafety.ts), so in test mode it reaches only the test
// recipient.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { outreachLive } from "../lib/outreachSafety";
import { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK } from "./guard";
import { initiateFollowUpOutreach, stopFollowUpSequenceForApp } from "../pipeline/followUpHelper";
import { toTaStage } from "./stages";

/**
 * Send the next follow-up for one candidate: the Day 0 outreach if nothing has
 * gone out yet, otherwise a reminder.
 */
export const send = internalMutation({
  args: { actorId: v.string(), applicationId: v.string() },
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
    if (!hasPhone && !candidate.email) {
      throw new Error("No phone number or email address on file.");
    }

    const before = app.followUpAttemptCount ?? 0;
    const job = await ctx.db.get(app.jobId);
    const max = job?.maxFollowUpAttempts ?? 3;
    if (before >= max) {
      throw new Error(`All ${max} follow-ups have been sent. Call them, or mark them as dropped out.`);
    }

    const communicationId = await initiateFollowUpOutreach(ctx, appId, { isManual: true });
    const after = (await ctx.db.get(appId))?.followUpAttemptCount ?? before;
    if (after === before) {
      // initiateFollowUpOutreach returns early when every detail is already in.
      return { sent: false as const, reason: "Everything the follow-up asks for is already collected." };
    }
    return {
      sent: true as const,
      kind: before === 0 ? ("initial" as const) : ("reminder" as const),
      attempt: after,
      maxAttempts: max,
      channels: { whatsapp: hasPhone, email: !!candidate.email },
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
