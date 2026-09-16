// convex/ta/voice.ts
//
// The AI screening call, held in a browser room instead of over a phone line.
//
// There is no SIP trunk yet, so nothing is dialled. Instead the TA platform
// opens a LiveKit room, the voice agent joins it, and whoever is in the room —
// the TA testing it, or the candidate on a shared link later — talks to it.
// Everything after that is the existing, audited path:
//
//   this file                → aiCalls row + voiceCallSessions row (live mode)
//   the Next server          → creates the room with this metadata, mints a token
//   the agent (agent/)       → reads the metadata, asks the questions, POSTs
//                              consent / confirmed_answer / finalize, signed, to
//                              /api/voice-agent/events (convex/http.ts)
//   commitConfirmedVoiceAnswer → candidate.currentSalary / expectedSalary /
//                              noticePeriodDays, application follow-up flags
//
// The room credentials are minted by the Next server, which already holds the
// LiveKit key; nothing here needs it.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK } from "./guard";

/** A call left "in progress" this long is treated as abandoned, so a retry is possible. */
const STALE_CALL_MS = 15 * 60 * 1000;

/** The questions, in the order the agent asks them. The first one is the reason for the call. */
function detailsToCollect(jobTitle: string, custom: string[]): string[] {
  return [
    `Confirm they are still interested in the ${jobTitle} role they were shortlisted for`,
    "Their current monthly salary, with the currency",
    "Their expected monthly salary, with the currency",
    "Their notice period, in days",
    ...custom,
  ].slice(0, 15);
}

export const prepareWebCall = internalMutation({
  args: {
    actorId: v.string(),
    applicationId: v.string(),
    roomName: v.string(),
    participantIdentity: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    if (app.isActive === false) throw new Error("This application is closed.");

    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("That candidate no longer exists.");
    if (candidate.doNotContact) throw new Error("This candidate has asked not to be contacted.");
    const job = await ctx.db.get(app.jobId);
    if (!job) throw new Error("That opening no longer exists.");

    // One call at a time — but a call abandoned in a closed tab must not block
    // the next attempt forever.
    const now = Date.now();
    const pending = await ctx.db
      .query("aiCalls")
      .withIndex("by_application", (q) => q.eq("applicationId", appId))
      .filter((q) => q.or(q.eq(q.field("callStatus"), "scheduled"), q.eq(q.field("callStatus"), "in_progress")))
      .collect();
    for (const call of pending) {
      if (now - (call.calledAt ?? 0) < STALE_CALL_MS) {
        throw new Error("A call for this candidate is already in progress.");
      }
      await ctx.db.patch(call._id, { callStatus: "failed", completedAt: now });
      if (call.voiceCallSessionId) {
        const session = await ctx.db.get(call.voiceCallSessionId);
        if (session?.status === "active") {
          await ctx.db.patch(session._id, { status: "cancelled", finalizedAt: now, livekitFailureReason: "Abandoned before the agent finished" });
        }
      }
    }

    const aiCallId = await ctx.db.insert("aiCalls", {
      candidateId: app.candidateId,
      applicationId: app._id,
      jobId: app.jobId,
      triggeredBy: user._id,
      triggerType: "manual_ta_trigger",
      callStatus: "scheduled",
      callScriptUsed: "initial_screening",
      companyHidden: false,
      calledAt: now,
      followUpTriggered: false,
      attempts: 1,
      firstAttemptAt: now,
      attemptNumber: 1,
    });

    const session: { callSessionId: Id<"voiceCallSessions">; stateVersion: number } = await ctx.runMutation(
      internal.aiCalls.voiceCalls.startVoiceCallSession,
      {
        externalSessionId: args.roomName,
        aiCallId,
        candidateId: app.candidateId,
        applicationId: app._id,
        jobId: app.jobId,
        mode: "live",
        livekitRoomName: args.roomName,
        livekitParticipantIdentity: args.participantIdentity,
      },
    );

    const custom = (job.agent5CustomQuestions ?? job.customFollowUpQuestions ?? []) as string[];

    // Everything the agent is told. `detailsToCollect` is the field the agent
    // reads; `customQuestions` is kept for the older dispatcher's readers.
    const metadata = {
      mode: "live",
      sessionMode: "live",
      callSessionId: session.callSessionId as string,
      stateVersion: session.stateVersion,
      aiCallId: aiCallId as string,
      candidateName: candidate.fullName ?? "the candidate",
      jobTitle: job.title,
      companyName: job.clientName || "Career141",
      jobDescription: (job.jobDescription ?? "").slice(0, 2000),
      customQuestions: custom,
      detailsToCollect: detailsToCollect(job.title, custom),
    };

    return { aiCallId: aiCallId as string, callSessionId: session.callSessionId as string, metadata };
  },
});

/** The recent AI calls for one application, with what each captured. */
export const callsFor = internalQuery({
  args: { actorId: v.string(), applicationId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) return [];
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    const calls = await ctx.db
      .query("aiCalls")
      .withIndex("by_application", (q) => q.eq("applicationId", appId))
      .collect();
    calls.sort((a, b) => (b.calledAt ?? 0) - (a.calledAt ?? 0));
    const out = [];
    for (const c of calls.slice(0, 5)) {
      const session = c.voiceCallSessionId ? await ctx.db.get(c.voiceCallSessionId) : null;
      out.push({
        id: c._id as string,
        status: c.callStatus,
        calledAt: c.calledAt ?? null,
        durationSeconds: c.callDurationSeconds ?? session?.durationSeconds ?? null,
        consent: session?.consentStatus ?? null,
        currentSalary: c.currentSalary ?? null,
        currentSalaryCurrency: c.currentSalaryCurrency ?? null,
        expectedSalary: c.expectedSalary ?? null,
        expectedSalaryCurrency: c.expectedSalaryCurrency ?? null,
        noticePeriodDays: c.noticePeriodDays ?? null,
        transcript: (c.transcript ?? "").slice(0, 4000),
        endedReason: session?.livekitFailureReason ?? null,
      });
    }
    return out;
  },
});

/**
 * End a call from the TA's side. If the agent already finalized it this does
 * nothing; if it never connected, the records say so instead of staying "in
 * progress".
 */
export const abandonWebCall = internalMutation({
  args: { actorId: v.string(), aiCallId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const call = await ctx.db.get(args.aiCallId as Id<"aiCalls">);
    if (!call) return { ok: true };
    await assertJobAccess(ctx, user, call.jobId, WORKS_THE_DESK);
    if (!["scheduled", "in_progress"].includes(call.callStatus)) return { ok: true, alreadyEnded: true };
    const now = Date.now();
    await ctx.db.patch(call._id, { callStatus: "failed", completedAt: now });
    if (call.voiceCallSessionId) {
      const session = await ctx.db.get(call.voiceCallSessionId);
      if (session?.status === "active") await ctx.db.patch(session._id, { status: "cancelled", finalizedAt: now, livekitFailureReason: "Abandoned before the agent finished" });
    }
    if (call.applicationId) await ctx.db.patch(call.applicationId, { aiCallStatus: "failed" });
    return { ok: true };
  },
});
