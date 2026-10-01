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
//   Aura (voice-agent/)      → reads the metadata, greets the candidate from
//                              Career141, asks salary, notice and the opening's
//                              questions, and sends each line to the call window
//   completeWebCall (below)  → the window hands back the transcript when the
//                              call ends; ta/voiceExtract.ts reads the answers
//                              and applyCallAnswers fills them into the record
//
// The room credentials are minted by the Next server, which already holds the
// LiveKit key; nothing here needs it.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, assertNotAnotherTasCandidate, WORKS_THE_DESK } from "./guard";
import { allJobQuestions, callBrief, candidateSpoke, detailsToCollect, screeningQuestions, standardAnswers, transcriptText, type CallAnswers } from "../lib/screeningCall";
import { answersById } from "../lib/followUpScope";
import { checkAndAdvanceFollowUp, updateFollowUpFlags } from "../pipeline/followUpHelper";

/** A call left "in progress" this long is treated as abandoned, so a retry is possible. */
const STALE_CALL_MS = 15 * 60 * 1000;

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
    assertNotAnotherTasCandidate(user, app);
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

    // The opening's own questions, wherever they were set — the TA System's,
    // the CV pipeline's follow-up questions, or the old call questions.
    const custom = screeningQuestions(job);

    // Everything the Aura agent (voice-agent/) is told. It calls from Career141;
    // the hiring company is in the brief, and never named when confidential.
    const metadata = {
      agentType: "aura-screening",
      mode: "live",
      sessionMode: "live",
      callSessionId: session.callSessionId as string,
      stateVersion: session.stateVersion,
      aiCallId: aiCallId as string,
      candidateName: candidate.fullName ?? "the candidate",
      jobTitle: job.title,
      companyName: "Career141",
      jobDescription: callBrief(job),
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

/**
 * The call has ended in the call window: keep what was said, read the answers.
 *
 * The transcript is the lines Aura sent to the window as the call went.
 * Nothing said on the candidate's side means nobody answered. Otherwise the
 * call is complete and the answers are read out of it (ta/voiceExtract.ts).
 * Harmless if the call was already closed.
 */
export const completeWebCall = internalMutation({
  args: {
    actorId: v.string(),
    aiCallId: v.string(),
    durationSeconds: v.number(),
    lines: v.array(v.object({ who: v.union(v.literal("agent"), v.literal("candidate")), text: v.string() })),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const call = await ctx.db.get(args.aiCallId as Id<"aiCalls">);
    if (!call) return { ok: false as const, answered: false };
    await assertJobAccess(ctx, user, call.jobId, WORKS_THE_DESK);
    if (!["scheduled", "in_progress"].includes(call.callStatus)) return { ok: true as const, answered: false, alreadyEnded: true };

    const now = Date.now();
    const answered = candidateSpoke(args.lines);
    const transcript = transcriptText(args.lines);
    await ctx.db.patch(call._id, {
      callStatus: answered ? "completed" : "no_answer",
      completedAt: now,
      callDurationSeconds: Math.max(0, Math.round(args.durationSeconds)),
      transcript: transcript || undefined,
    });
    if (call.voiceCallSessionId) {
      const session = await ctx.db.get(call.voiceCallSessionId);
      if (session?.status === "active") {
        await ctx.db.patch(session._id, {
          status: answered ? "completed" : "cancelled",
          finalizedAt: now,
          durationSeconds: Math.max(0, Math.round(args.durationSeconds)),
          ...(answered ? {} : { livekitFailureReason: args.reason ?? "Nobody answered" }),
        });
      }
    }
    if (call.applicationId) await ctx.db.patch(call.applicationId, { aiCallStatus: answered ? "completed" : "no_answer" });
    if (answered && call.applicationId) {
      await ctx.scheduler.runAfter(0, internal.ta.voiceExtract.extractCallAnswers, { aiCallId: call._id });
    }
    return { ok: true as const, answered };
  },
});

/** What the extraction needs: the transcript and the questions that were asked. */
export const callForExtraction = internalQuery({
  args: { aiCallId: v.id("aiCalls") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.aiCallId);
    if (!call) return null;
    const job = await ctx.db.get(call.jobId);
    return { transcript: call.transcript ?? "", questions: job ? screeningQuestions(job) : [] };
  },
});

/**
 * Write what the call collected.
 *
 * On the call record: everything heard. On the candidate: blanks only, so a
 * figure a TA already checked is not replaced by one read off a transcript.
 * On the application: the opening's questions, by wording and by id, and the
 * follow-up flags, exactly as a WhatsApp or email reply records them.
 */
export const applyCallAnswers = internalMutation({
  args: {
    aiCallId: v.id("aiCalls"),
    answers: v.object({
      interested: v.union(v.boolean(), v.null()),
      currentSalary: v.union(v.number(), v.null()),
      currentSalaryCurrency: v.union(v.string(), v.null()),
      expectedSalary: v.union(v.number(), v.null()),
      expectedSalaryCurrency: v.union(v.string(), v.null()),
      noticePeriodDays: v.union(v.number(), v.null()),
      answers: v.record(v.string(), v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.aiCallId);
    if (!call) return { ok: false, filled: [] as string[] };
    const a: CallAnswers = args.answers;
    const u = <T,>(x: T | null): T | undefined => (x === null ? undefined : x);

    await ctx.db.patch(call._id, {
      currentSalary: u(a.currentSalary),
      currentSalaryCurrency: u(a.currentSalaryCurrency),
      expectedSalary: u(a.expectedSalary),
      expectedSalaryCurrency: u(a.expectedSalaryCurrency),
      noticePeriodDays: u(a.noticePeriodDays),
      customQuestionAnswers: Object.entries(a.answers).map(([question, answer]) => ({ question, answer })),
    });

    const candidate = await ctx.db.get(call.candidateId);
    if (!candidate) return { ok: false, filled: [] as string[] };
    const fill: Record<string, unknown> = {};
    if (candidate.currentSalary === undefined && a.currentSalary !== null) {
      fill.currentSalary = a.currentSalary;
      if (a.currentSalaryCurrency) fill.currentSalaryCurrency = a.currentSalaryCurrency;
    }
    if (candidate.expectedSalary === undefined && a.expectedSalary !== null) {
      fill.expectedSalary = a.expectedSalary;
      if (a.expectedSalaryCurrency) fill.expectedSalaryCurrency = a.expectedSalaryCurrency;
    }
    if (candidate.noticePeriodDays === undefined && a.noticePeriodDays !== null) fill.noticePeriodDays = a.noticePeriodDays;
    if (Object.keys(fill).length) await ctx.db.patch(candidate._id, fill);

    if (!call.applicationId) return { ok: true, filled: Object.keys(fill) };
    const app = await ctx.db.get(call.applicationId);
    const job = await ctx.db.get(call.jobId);
    // The opening's questions that repeat a standard detail are answered from its figures.
    const collected = { ...(job ? standardAnswers(allJobQuestions(job), a) : {}), ...a.answers };
    if (app && Object.keys(collected).length) {
      const byLabel = { ...(app.customFollowUpAnswers ?? {}) } as Record<string, string>;
      for (const [q, ans] of Object.entries(collected)) if (!byLabel[q]) byLabel[q] = ans;
      const byId = answersById(job?.followUpQuestions ?? [], byLabel);
      await ctx.db.patch(app._id, {
        customFollowUpAnswers: byLabel,
        answers: { ...byId, ...(app.answers ?? {}) },
      });
    }
    const updated = await ctx.db.get(candidate._id);
    await updateFollowUpFlags(ctx, call.applicationId, updated);
    await checkAndAdvanceFollowUp(ctx, candidate._id);
    return { ok: true, filled: Object.keys(fill) };
  },
});
