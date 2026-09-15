import {
  internalQuery,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { requireJobAssignment, requireUser } from "../lib/permissions";
import { isProductionVoiceMode } from "./voiceSessionPolicy";

const MAX_CALL_DURATION_SECONDS = 5 * 60;
const MAX_TRANSCRIPT_CHARACTERS = 100_000;
const MAX_EXTERNAL_SESSION_ID_CHARACTERS = 200;
const MAX_TURN_ID_CHARACTERS = 128;
const MAX_CONSENT_IDEMPOTENCY_KEY_CHARACTERS = 128;
const MAX_LIVEKIT_IDENTIFIER_CHARACTERS = 200;
const MAX_FAILURE_REASON_CHARACTERS = 500;
const STALE_SESSION_AGE_MS = 10 * 60 * 1000;
const MAX_STALE_SESSIONS_PER_RUN = 50;
const VOICE_AGENT_NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_EXPIRED_NONCES_PER_REQUEST = 100;
const SIMULATION_RESERVATION_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_SIMULATIONS_PER_USER = 2;
const MAX_ACTIVE_SIMULATIONS_GLOBAL = 10;
const MAX_SIMULATIONS_PER_USER_PER_HOUR = 10;
const MAX_SALARY = 1_000_000_000;
const MAX_NOTICE_PERIOD_DAYS = 730;
const CURRENCY_CODE = /^[A-Z]{3}$/;

const voiceModeValidator = v.union(
  v.literal("simulation"),
  v.literal("test"),
  v.literal("live"),
);

const voiceAnswerFieldValidator = v.union(
  v.literal("currentSalary"),
  v.literal("expectedSalary"),
  v.literal("noticePeriodDays"),
);

const terminalVoiceStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const voiceConsentDecisionValidator = v.union(
  v.literal("granted"),
  v.literal("declined"),
);

const livekitSipStatusValidator = v.union(
  v.literal("dialing"),
  v.literal("answered"),
  v.literal("completed"),
  v.literal("failed"),
);

type VoiceAnswerField = "currentSalary" | "expectedSalary" | "noticePeriodDays";

function assertBoundedIdentifier(
  value: string,
  name: string,
  maxLength: number,
) {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
}

function assertCallDuration(durationSeconds: number) {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 0 ||
    durationSeconds > MAX_CALL_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be an integer between 0 and ${MAX_CALL_DURATION_SECONDS}`,
    );
  }
}

function assertTranscript(transcript: string | undefined) {
  if (
    transcript !== undefined &&
    transcript.length > MAX_TRANSCRIPT_CHARACTERS
  ) {
    throw new Error(
      `transcript cannot exceed ${MAX_TRANSCRIPT_CHARACTERS} characters`,
    );
  }
}

function assertVoiceAnswerValue(field: VoiceAnswerField, value: number) {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }

  if (field === "noticePeriodDays") {
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_NOTICE_PERIOD_DAYS
    ) {
      throw new Error(
        `noticePeriodDays must be an integer between 0 and ${MAX_NOTICE_PERIOD_DAYS}`,
      );
    }
    return;
  }

  if (value < 0 || value > MAX_SALARY) {
    throw new Error(`${field} must be between 0 and ${MAX_SALARY}`);
  }
}

function assertVoiceAnswerCurrency(
  field: VoiceAnswerField,
  currency: string | undefined,
) {
  if (field === "noticePeriodDays") {
    if (currency !== undefined) {
      throw new Error("currency is forbidden for noticePeriodDays");
    }
    return;
  }
  if (!currency || !CURRENCY_CODE.test(currency)) {
    throw new Error(`${field} requires a three-letter uppercase currency code`);
  }
}

async function getApplicationRelationship(
  ctx: QueryCtx | MutationCtx,
  candidateId: Id<"candidates">,
  jobId: Id<"jobs">,
  applicationId: Id<"applications">,
  requireActive: boolean,
) {
  const candidate = await ctx.db.get(candidateId);
  if (!candidate) throw new Error("Candidate not found");

  const job = await ctx.db.get(jobId);
  if (!job) throw new Error("Job not found");

  const application = await ctx.db.get(applicationId);
  if (!application) throw new Error("Application not found");
  if (
    String(application.candidateId) !== String(candidateId) ||
    String(application.jobId) !== String(jobId)
  ) {
    throw new Error("Application does not belong to the candidate and job");
  }
  if (requireActive && application.isActive === false) {
    throw new Error("Application is not active");
  }

  return { candidate, job, application };
}

async function getLiveAiCall(
  ctx: QueryCtx | MutationCtx,
  aiCallId: Id<"aiCalls">,
  candidateId: Id<"candidates">,
  jobId: Id<"jobs">,
  applicationId: Id<"applications">,
) {
  const aiCall = await ctx.db.get(aiCallId);
  if (!aiCall) throw new Error("AI call record not found");
  if (
    String(aiCall.candidateId) !== String(candidateId) ||
    String(aiCall.jobId) !== String(jobId) ||
    String(aiCall.applicationId) !== String(applicationId)
  ) {
    throw new Error("AI call does not belong to the voice-call relationship");
  }
  return aiCall;
}

function buildAnswerIdempotencyKey(
  callSessionId: Id<"voiceCallSessions">,
  turnId: string,
  field: VoiceAnswerField,
) {
  return JSON.stringify([String(callSessionId), turnId, field]);
}

/** Atomically consume a signed voice-agent request nonce once. */
export const claimVoiceAgentNonce = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(args.nonce)) {
      throw new Error("Invalid voice-agent nonce");
    }

    const now = Date.now();
    const expired = await ctx.db
      .query("voiceAgentNonces")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(MAX_EXPIRED_NONCES_PER_REQUEST);
    for (const nonce of expired) await ctx.db.delete(nonce._id);

    const existing = await ctx.db
      .query("voiceAgentNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();
    if (existing) throw new Error("Voice-agent request replayed");

    await ctx.db.insert("voiceAgentNonces", {
      nonce: args.nonce,
      createdAt: now,
      expiresAt: now + VOICE_AGENT_NONCE_TTL_MS,
    });
    return { success: true };
  },
});

/**
 * Backwards-compatible endpoint for the browser test modal.
 *
 * This is deliberately a no-write simulation boundary. Live results are
 * persisted only by the internal mutations below after the server has created
 * and validated a live voice-call session.
 */
export const recordVoiceCallSession = mutation({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    applicationId: v.optional(v.id("applications")),
    transcript: v.string(),
    durationSeconds: v.number(),
    currentSalary: v.optional(v.number()),
    expectedSalary: v.optional(v.number()),
    noticePeriodDays: v.optional(v.number()),
    noticePeriodText: v.optional(v.string()),
    customQuestionAnswers: v.optional(
      v.array(
        v.object({
          question: v.string(),
          answer: v.optional(v.union(v.string(), v.null())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    await requireJobAssignment(ctx, args.jobId, [
      "primary_recruiter",
      "supporting_recruiter",
    ]);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    if (args.applicationId) {
      await getApplicationRelationship(
        ctx,
        args.candidateId,
        args.jobId,
        args.applicationId,
        false,
      );
    } else {
      const matchingApplication = await ctx.db
        .query("applications")
        .withIndex("by_candidate_job", (q) =>
          q.eq("candidateId", args.candidateId).eq("jobId", args.jobId),
        )
        .first();
      if (!matchingApplication) {
        throw new Error("Candidate has no application for this job");
      }
    }

    assertCallDuration(args.durationSeconds);
    assertTranscript(args.transcript);
    if (args.currentSalary !== undefined) {
      assertVoiceAnswerValue("currentSalary", args.currentSalary);
    }
    if (args.expectedSalary !== undefined) {
      assertVoiceAnswerValue("expectedSalary", args.expectedSalary);
    }
    if (args.noticePeriodDays !== undefined) {
      assertVoiceAnswerValue("noticePeriodDays", args.noticePeriodDays);
    }
    if (args.noticePeriodText && args.noticePeriodText.length > 500) {
      throw new Error("noticePeriodText cannot exceed 500 characters");
    }
    if ((args.customQuestionAnswers?.length ?? 0) > 50) {
      throw new Error(
        "customQuestionAnswers cannot contain more than 50 items",
      );
    }
    for (const answer of args.customQuestionAnswers ?? []) {
      if (
        answer.question.length > 1_000 ||
        (answer.answer?.length ?? 0) > 5_000
      ) {
        throw new Error("Custom question or answer exceeds its size limit");
      }
    }

    return {
      success: true,
      committed: false,
      mode: "simulation" as const,
    };
  },
});

/**
 * Server-authoritative context used to mint a simulation token. The caller
 * cannot substitute a candidate/job/application combination or prompt fields.
 */
export const getVoiceSimulationContext = query({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    applicationId: v.optional(v.id("applications")),
  },
  handler: async (ctx, args) => {
    await requireJobAssignment(ctx, args.jobId, [
      "primary_recruiter",
      "supporting_recruiter",
    ]);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    let application;
    if (args.applicationId) {
      const relationship = await getApplicationRelationship(
        ctx,
        args.candidateId,
        args.jobId,
        args.applicationId,
        false,
      );
      application = relationship.application;
    } else {
      application = await ctx.db
        .query("applications")
        .withIndex("by_candidate_job", (q) =>
          q.eq("candidateId", args.candidateId).eq("jobId", args.jobId),
        )
        .first();
      if (!application) {
        throw new Error("Candidate has no application for this job");
      }
    }

    return {
      candidateName:
        candidate.fullName ?? application.candidateName ?? "Candidate",
      jobTitle: job.title,
      jobDescription: job.jobDescription,
      customQuestions:
        job.agent5CustomQuestions ?? job.customFollowUpQuestions ?? [],
      livekitConfig: {
        apiKey: process.env.LIVEKIT_API_KEY?.trim() || null,
        apiSecret: process.env.LIVEKIT_API_SECRET?.trim() || null,
        publicUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim() || null,
        internalUrl: process.env.LIVEKIT_INTERNAL_URL?.trim() || null,
      },
    };
  },
});

export const getCandidateVoiceCalls = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const calls = await ctx.db
      .query("aiCalls")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .collect();

    if (["admin", "ta_manager", "senior_ta"].includes(user.role)) {
      return calls;
    }

    const assignments = await ctx.db
      .query("jobAssignments")
      .withIndex("by_userId_isActive", (q) =>
        q.eq("userId", user._id).eq("isActive", true),
      )
      .collect();
    const allowedJobIds = new Set(
      assignments.map((assignment) => String(assignment.jobId)),
    );
    return calls.filter((call) => allowedJobIds.has(String(call.jobId)));
  },
});

/** Atomically reserve bounded simulation capacity before creating a room. */
export const reserveVoiceSimulationSession = mutation({
  args: {
    sessionId: v.string(),
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireJobAssignment(ctx, args.jobId, [
      "primary_recruiter",
      "supporting_recruiter",
    ]);
    assertBoundedIdentifier(args.sessionId, "sessionId", 64);
    await getApplicationRelationship(
      ctx,
      args.candidateId,
      args.jobId,
      args.applicationId,
      true,
    );

    const existing = await ctx.db
      .query("voiceSimulationReservations")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (existing) throw new Error("Simulation session ID is already reserved");

    const now = Date.now();
    const activeForUser = await ctx.db
      .query("voiceSimulationReservations")
      .withIndex("by_user_expiresAt", (q) =>
        q.eq("userId", user._id).gt("expiresAt", now),
      )
      .filter((q) => q.eq(q.field("status"), "reserved"))
      .take(MAX_ACTIVE_SIMULATIONS_PER_USER + 1);
    if (activeForUser.length >= MAX_ACTIVE_SIMULATIONS_PER_USER) {
      throw new Error("Too many active voice simulations");
    }

    const recentForUser = await ctx.db
      .query("voiceSimulationReservations")
      .withIndex("by_user_createdAt", (q) =>
        q.eq("userId", user._id).gt("createdAt", now - 60 * 60 * 1000),
      )
      .take(MAX_SIMULATIONS_PER_USER_PER_HOUR + 1);
    if (recentForUser.length >= MAX_SIMULATIONS_PER_USER_PER_HOUR) {
      throw new Error("Hourly voice simulation limit reached");
    }

    const activeGlobal = await ctx.db
      .query("voiceSimulationReservations")
      .withIndex("by_status_expiresAt", (q) =>
        q.eq("status", "reserved").gt("expiresAt", now),
      )
      .take(MAX_ACTIVE_SIMULATIONS_GLOBAL + 1);
    if (activeGlobal.length >= MAX_ACTIVE_SIMULATIONS_GLOBAL) {
      throw new Error("Voice simulation capacity is currently full");
    }

    const reservationId = await ctx.db.insert("voiceSimulationReservations", {
      sessionId: args.sessionId,
      userId: user._id,
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      status: "reserved",
      createdAt: now,
      expiresAt: now + SIMULATION_RESERVATION_TTL_MS,
    });
    return {
      success: true,
      reservationId,
      expiresAt: now + SIMULATION_RESERVATION_TTL_MS,
    };
  },
});

/** Release a reservation if room creation fails before a token is issued. */
export const releaseVoiceSimulationReservation = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const reservation = await ctx.db
      .query("voiceSimulationReservations")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!reservation || String(reservation.userId) !== String(user._id)) {
      throw new Error("Simulation reservation not found");
    }
    if (reservation.status === "released") {
      return { success: true, idempotent: true };
    }
    await ctx.db.patch(reservation._id, {
      status: "released",
      releasedAt: Date.now(),
    });
    return { success: true, idempotent: false };
  },
});

/**
 * Authoritative dial context for the server-side outbound voice dispatcher.
 * The action receives only an aiCallId; all recipient and relationship data is
 * resolved here so no client-provided phone number can reach the SIP provider.
 */
export const getLiveOutboundCallContext = internalQuery({
  args: { aiCallId: v.id("aiCalls") },
  handler: async (ctx, args) => {
    const aiCall = await ctx.db.get(args.aiCallId);
    if (!aiCall) throw new Error("AI call record not found");
    if (!aiCall.applicationId) {
      throw new Error("AI call is missing its application relationship");
    }
    if (
      aiCall.triggerType !== "manual_ta_trigger" &&
      aiCall.triggerType !== "followup_retry"
    ) {
      throw new Error(
        "Only manually triggered AI calls may use this dispatcher",
      );
    }
    const { candidate, job, application } = await getApplicationRelationship(
      ctx,
      aiCall.candidateId,
      aiCall.jobId,
      aiCall.applicationId,
      true,
    );
    if (candidate.doNotContact) {
      throw new Error("Candidate is marked do-not-contact");
    }
    if (!candidate.phone) {
      throw new Error("Candidate has no phone number");
    }

    const existingSession = await ctx.db
      .query("voiceCallSessions")
      .withIndex("by_aiCallId", (q) => q.eq("aiCallId", args.aiCallId))
      .first();
    if (
      !["scheduled", "in_progress"].includes(aiCall.callStatus) &&
      !existingSession
    ) {
      throw new Error(`Cannot dial a ${aiCall.callStatus} AI call`);
    }

    return {
      aiCallId: aiCall._id,
      candidateId: candidate._id,
      applicationId: application._id,
      jobId: job._id,
      candidatePhone: candidate.phone,
      candidateName:
        candidate.fullName ?? application.candidateName ?? "Candidate",
      jobTitle: job.title,
      jobDescription: job.jobDescription,
      customQuestions:
        job.agent5CustomQuestions ?? job.customFollowUpQuestions ?? [],
      callScriptUsed: aiCall.callScriptUsed,
      companyHidden: aiCall.companyHidden,
      existingSession: existingSession
        ? {
            callSessionId: existingSession._id,
            externalSessionId: existingSession.externalSessionId,
            status: existingSession.status,
            stateVersion: existingSession.stateVersion,
            livekitRoomName: existingSession.livekitRoomName,
            livekitParticipantId: existingSession.livekitParticipantId,
            livekitParticipantIdentity:
              existingSession.livekitParticipantIdentity,
            livekitSipCallId: existingSession.livekitSipCallId,
            livekitSipStatus: existingSession.livekitSipStatus,
          }
        : null,
    };
  },
});

/** Create one server-authoritative voice session. Safe to retry. */
export const startVoiceCallSession = internalMutation({
  args: {
    externalSessionId: v.string(),
    aiCallId: v.optional(v.id("aiCalls")),
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    mode: voiceModeValidator,
    livekitRoomName: v.optional(v.string()),
    livekitParticipantIdentity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertBoundedIdentifier(
      args.externalSessionId,
      "externalSessionId",
      MAX_EXTERNAL_SESSION_ID_CHARACTERS,
    );
    if (args.livekitRoomName !== undefined) {
      assertBoundedIdentifier(
        args.livekitRoomName,
        "livekitRoomName",
        MAX_LIVEKIT_IDENTIFIER_CHARACTERS,
      );
    }
    if (args.livekitParticipantIdentity !== undefined) {
      assertBoundedIdentifier(
        args.livekitParticipantIdentity,
        "livekitParticipantIdentity",
        MAX_LIVEKIT_IDENTIFIER_CHARACTERS,
      );
    }
    if (
      args.mode === "simulation" &&
      (args.livekitRoomName || args.livekitParticipantIdentity)
    ) {
      throw new Error(
        "Simulation sessions cannot contain LiveKit dial metadata",
      );
    }

    const existing = await ctx.db
      .query("voiceCallSessions")
      .withIndex("by_externalSessionId", (q) =>
        q.eq("externalSessionId", args.externalSessionId),
      )
      .unique();
    if (existing) {
      const isSameSession =
        String(existing.candidateId) === String(args.candidateId) &&
        String(existing.applicationId) === String(args.applicationId) &&
        String(existing.jobId) === String(args.jobId) &&
        String(existing.aiCallId ?? "") === String(args.aiCallId ?? "") &&
        existing.mode === args.mode &&
        String(existing.livekitRoomName ?? "") ===
          String(args.livekitRoomName ?? "") &&
        String(existing.livekitParticipantIdentity ?? "") ===
          String(args.livekitParticipantIdentity ?? "");
      if (!isSameSession) {
        throw new Error("externalSessionId is already bound to another call");
      }
      return {
        success: true,
        idempotent: true,
        callSessionId: existing._id,
        stateVersion: existing.stateVersion,
      };
    }

    const { candidate } = await getApplicationRelationship(
      ctx,
      args.candidateId,
      args.jobId,
      args.applicationId,
      args.mode !== "simulation",
    );

    if (args.mode !== "simulation" && candidate.doNotContact) {
      throw new Error("Candidate is marked do-not-contact");
    }

    if (args.mode === "simulation" && args.aiCallId) {
      throw new Error(
        "Simulation sessions cannot be linked to production aiCalls",
      );
    }
    if (args.mode !== "simulation" && !args.aiCallId) {
      throw new Error("Live and test sessions require an aiCallId");
    }

    if (args.aiCallId) {
      const existingAiCallSession = await ctx.db
        .query("voiceCallSessions")
        .withIndex("by_aiCallId", (q) => q.eq("aiCallId", args.aiCallId))
        .first();
      if (existingAiCallSession) {
        throw new Error("aiCallId is already bound to another voice session");
      }

      const aiCall = await getLiveAiCall(
        ctx,
        args.aiCallId,
        args.candidateId,
        args.jobId,
        args.applicationId,
      );
      if (!["scheduled", "in_progress"].includes(aiCall.callStatus)) {
        throw new Error(`Cannot start a ${aiCall.callStatus} AI call`);
      }
    }

    const now = Date.now();
    const callSessionId = await ctx.db.insert("voiceCallSessions", {
      externalSessionId: args.externalSessionId,
      aiCallId: args.aiCallId,
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      mode: args.mode,
      status: "active",
      consentStatus: args.mode === "live" ? "pending" : "not_required",
      livekitRoomName: args.livekitRoomName,
      livekitParticipantIdentity: args.livekitParticipantIdentity,
      livekitSipStatus: args.livekitRoomName ? "dialing" : undefined,
      stateVersion: 0,
      startedAt: now,
    });

    if (args.mode === "live" && args.aiCallId) {
      await ctx.db.patch(args.aiCallId, {
        callStatus: "in_progress",
        calledAt: now,
        voiceCallSessionId: callSessionId,
        livekitRoomName: args.livekitRoomName,
        livekitParticipantIdentity: args.livekitParticipantIdentity,
        livekitSipStatus: args.livekitRoomName ? "dialing" : undefined,
      });
      await ctx.db.patch(args.applicationId, {
        aiCallStatus: "in_progress",
        aiCallId: String(args.aiCallId),
      });
      await ctx.db.insert("pipelineEvents", {
        applicationId: args.applicationId,
        candidateId: args.candidateId,
        jobId: args.jobId,
        eventType: "voice_call_started",
        actorType: "agent",
        actorAgent: "career141-voice-agent",
        metadata: JSON.stringify({
          callSessionId,
          externalSessionId: args.externalSessionId,
        }),
        createdAt: now,
      });
    } else if (args.mode === "test" && args.aiCallId) {
      // Test-recipient calls get a dedicated, explicitly labelled call record.
      // They never update the real application's state or write pipeline events.
      await ctx.db.patch(args.aiCallId, {
        isTestCall: true,
        callStatus: "in_progress",
        calledAt: now,
        voiceCallSessionId: callSessionId,
        livekitRoomName: args.livekitRoomName,
        livekitParticipantIdentity: args.livekitParticipantIdentity,
        livekitSipStatus: args.livekitRoomName ? "dialing" : undefined,
      });
    }

    return {
      success: true,
      idempotent: false,
      callSessionId,
      stateVersion: 0,
    };
  },
});

/**
 * Record the candidate's explicit consent before any durable answer write.
 * The state-version transition and idempotency key make webhook/agent retries
 * deterministic. Declining consent also closes the production call record.
 */
export const recordVoiceConsent = internalMutation({
  args: {
    callSessionId: v.id("voiceCallSessions"),
    decision: voiceConsentDecisionValidator,
    idempotencyKey: v.string(),
    expectedStateVersion: v.number(),
  },
  handler: async (ctx, args) => {
    assertBoundedIdentifier(
      args.idempotencyKey,
      "idempotencyKey",
      MAX_CONSENT_IDEMPOTENCY_KEY_CHARACTERS,
    );
    if (
      !Number.isInteger(args.expectedStateVersion) ||
      args.expectedStateVersion < 0
    ) {
      throw new Error("expectedStateVersion must be a non-negative integer");
    }

    const session = await ctx.db.get(args.callSessionId);
    if (!session) throw new Error("Voice call session not found");

    if (!isProductionVoiceMode(session.mode)) {
      return {
        success: true,
        committed: false,
        idempotent: false,
        stateVersion: session.stateVersion,
        consentStatus: session.consentStatus,
      };
    }

    if (
      session.consentStatus === "granted" ||
      session.consentStatus === "declined"
    ) {
      if (
        session.consentIdempotencyKey === args.idempotencyKey &&
        session.consentStatus === args.decision
      ) {
        return {
          success: true,
          committed: true,
          idempotent: true,
          stateVersion: session.stateVersion,
          consentStatus: session.consentStatus,
        };
      }
      throw new Error("Consent has already been recorded for this session");
    }
    if (session.status !== "active") {
      throw new Error(`Cannot record consent on a ${session.status} session`);
    }
    if (session.stateVersion !== args.expectedStateVersion) {
      throw new Error(
        `State version mismatch: expected ${args.expectedStateVersion}, current ${session.stateVersion}`,
      );
    }

    const { candidate } = await getApplicationRelationship(
      ctx,
      session.candidateId,
      session.jobId,
      session.applicationId,
      args.decision === "granted",
    );
    if (args.decision === "granted" && candidate.doNotContact) {
      throw new Error("Candidate is marked do-not-contact");
    }
    if (!session.aiCallId) {
      throw new Error("Live voice session is missing its aiCallId");
    }
    const aiCall = await getLiveAiCall(
      ctx,
      session.aiCallId,
      session.candidateId,
      session.jobId,
      session.applicationId,
    );
    if (aiCall.callStatus !== "in_progress") {
      throw new Error(
        `Cannot record consent on a ${aiCall.callStatus} AI call`,
      );
    }

    const now = Date.now();
    const nextStateVersion = session.stateVersion + 1;
    await ctx.db.patch(args.callSessionId, {
      consentStatus: args.decision,
      consentIdempotencyKey: args.idempotencyKey,
      consentRecordedAt: now,
      stateVersion: nextStateVersion,
      ...(args.decision === "declined"
        ? {
            status: "cancelled" as const,
            finalizedAt: now,
            durationSeconds: 0,
            ...(session.livekitRoomName
              ? { livekitSipStatus: "completed" as const }
              : {}),
          }
        : {}),
    });

    if (args.decision === "declined") {
      await ctx.db.patch(session.aiCallId, {
        callStatus: "declined",
        callDurationSeconds: 0,
        completedAt: now,
        ...(session.livekitRoomName
          ? { livekitSipStatus: "completed" as const }
          : {}),
      });
      await ctx.db.patch(session.applicationId, {
        aiCallStatus: "declined",
      });
    }
    await ctx.db.insert("pipelineEvents", {
      applicationId: session.applicationId,
      candidateId: session.candidateId,
      jobId: session.jobId,
      eventType: `voice_consent_${args.decision}`,
      actorType: "agent",
      actorAgent: "career141-voice-agent",
      metadata: JSON.stringify({
        callSessionId: args.callSessionId,
        stateVersion: nextStateVersion,
      }),
      createdAt: now,
    });

    return {
      success: true,
      committed: true,
      idempotent: false,
      stateVersion: nextStateVersion,
      consentStatus: args.decision,
    };
  },
});

/** Persist identifiers returned by LiveKit after the SIP participant answers. */
export const recordLivekitSipParticipant = internalMutation({
  args: {
    callSessionId: v.id("voiceCallSessions"),
    roomName: v.string(),
    participantId: v.string(),
    participantIdentity: v.string(),
    sipCallId: v.string(),
    status: livekitSipStatusValidator,
  },
  handler: async (ctx, args) => {
    for (const [name, value] of [
      ["roomName", args.roomName],
      ["participantId", args.participantId],
      ["participantIdentity", args.participantIdentity],
      ["sipCallId", args.sipCallId],
    ] as const) {
      assertBoundedIdentifier(value, name, MAX_LIVEKIT_IDENTIFIER_CHARACTERS);
    }

    const session = await ctx.db.get(args.callSessionId);
    if (!session) throw new Error("Voice call session not found");
    if (session.mode === "simulation" || !session.aiCallId) {
      throw new Error(
        "LiveKit identifiers require a live or test voice session",
      );
    }
    if (session.status !== "active") {
      throw new Error(
        `Cannot attach LiveKit identifiers to a ${session.status} session`,
      );
    }
    if (
      (session.livekitRoomName && session.livekitRoomName !== args.roomName) ||
      (session.livekitParticipantIdentity &&
        session.livekitParticipantIdentity !== args.participantIdentity)
    ) {
      throw new Error("LiveKit identifiers do not match the prepared dial");
    }
    if (session.livekitParticipantId) {
      const isSameParticipant =
        session.livekitParticipantId === args.participantId &&
        session.livekitSipCallId === args.sipCallId;
      if (!isSameParticipant) {
        throw new Error(
          "Voice session is already bound to another SIP participant",
        );
      }
      return { success: true, idempotent: true };
    }

    await getLiveAiCall(
      ctx,
      session.aiCallId,
      session.candidateId,
      session.jobId,
      session.applicationId,
    );
    await ctx.db.patch(args.callSessionId, {
      livekitRoomName: args.roomName,
      livekitParticipantId: args.participantId,
      livekitParticipantIdentity: args.participantIdentity,
      livekitSipCallId: args.sipCallId,
      livekitSipStatus: args.status,
    });
    await ctx.db.patch(session.aiCallId, {
      ...(session.mode === "test" ? { isTestCall: true } : {}),
      voiceCallSessionId: args.callSessionId,
      livekitRoomName: args.roomName,
      livekitParticipantId: args.participantId,
      livekitParticipantIdentity: args.participantIdentity,
      livekitSipCallId: args.sipCallId,
      livekitSipStatus: args.status,
    });

    return { success: true, idempotent: false };
  },
});

/** Fail or suppress a manual dial before a voice session is created. */
export const markVoiceDialNotPlaced = internalMutation({
  args: {
    aiCallId: v.id("aiCalls"),
    status: v.union(v.literal("failed"), v.literal("suppressed")),
    reason: v.string(),
    diagnosticOnly: v.boolean(),
    isTestCall: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (
      args.reason.trim().length === 0 ||
      args.reason.length > MAX_FAILURE_REASON_CHARACTERS
    ) {
      throw new Error(
        `reason must contain 1-${MAX_FAILURE_REASON_CHARACTERS} characters`,
      );
    }
    const aiCall = await ctx.db.get(args.aiCallId);
    if (!aiCall || !aiCall.applicationId) {
      throw new Error("AI call relationship not found");
    }
    await getApplicationRelationship(
      ctx,
      aiCall.candidateId,
      aiCall.jobId,
      aiCall.applicationId,
      false,
    );
    if (
      aiCall.callStatus === "failed" &&
      aiCall.livekitSipStatus === args.status
    ) {
      return { success: true, idempotent: true };
    }
    if (!["scheduled", "in_progress"].includes(aiCall.callStatus)) {
      throw new Error(`Cannot fail a ${aiCall.callStatus} AI call`);
    }
    const existingSession = await ctx.db
      .query("voiceCallSessions")
      .withIndex("by_aiCallId", (q) => q.eq("aiCallId", args.aiCallId))
      .first();
    if (existingSession) {
      throw new Error("Use failVoiceCallDial after a voice session is created");
    }

    const now = Date.now();
    await ctx.db.patch(args.aiCallId, {
      callStatus: "failed",
      completedAt: now,
      livekitSipStatus: args.status,
      ...(args.isTestCall ? { isTestCall: true } : {}),
    });
    if (!args.diagnosticOnly) {
      await ctx.db.patch(aiCall.applicationId, { aiCallStatus: "failed" });
      await ctx.db.insert("pipelineEvents", {
        applicationId: aiCall.applicationId,
        candidateId: aiCall.candidateId,
        jobId: aiCall.jobId,
        eventType: "voice_dial_not_placed",
        actorType: "agent",
        actorAgent: "career141-voice-dispatcher",
        notes: args.reason,
        metadata: JSON.stringify({ status: args.status }),
        createdAt: now,
      });
    }
    return { success: true, idempotent: false };
  },
});

/** Close a prepared session when LiveKit rejects or times out the dial. */
export const failVoiceCallDial = internalMutation({
  args: {
    callSessionId: v.id("voiceCallSessions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      args.reason.trim().length === 0 ||
      args.reason.length > MAX_FAILURE_REASON_CHARACTERS
    ) {
      throw new Error(
        `reason must contain 1-${MAX_FAILURE_REASON_CHARACTERS} characters`,
      );
    }
    const session = await ctx.db.get(args.callSessionId);
    if (!session || session.mode === "simulation" || !session.aiCallId) {
      throw new Error("Live or test voice session not found");
    }
    if (session.status === "failed") {
      return { success: true, idempotent: true };
    }
    if (session.mode === "test") {
      if (session.status !== "active") {
        throw new Error(`Cannot fail a ${session.status} test session`);
      }
      const now = Date.now();
      await ctx.db.patch(args.callSessionId, {
        status: "failed",
        stateVersion: session.stateVersion + 1,
        finalizedAt: now,
        durationSeconds: 0,
        livekitSipStatus: "failed",
        livekitFailureReason: args.reason,
      });
      await ctx.db.patch(session.aiCallId, {
        isTestCall: true,
        callStatus: "failed",
        callDurationSeconds: 0,
        completedAt: now,
        livekitSipStatus: "failed",
      });
      return { success: true, idempotent: false };
    }
    if (
      session.status !== "active" ||
      session.stateVersion !== 0 ||
      session.consentStatus !== "pending"
    ) {
      throw new Error(
        "Refusing to fail a call after candidate interaction began",
      );
    }
    await getLiveAiCall(
      ctx,
      session.aiCallId,
      session.candidateId,
      session.jobId,
      session.applicationId,
    );

    const now = Date.now();
    await ctx.db.patch(args.callSessionId, {
      status: "failed",
      stateVersion: 1,
      finalizedAt: now,
      durationSeconds: 0,
      livekitSipStatus: "failed",
      livekitFailureReason: args.reason,
    });
    await ctx.db.patch(session.aiCallId, {
      callStatus: "failed",
      callDurationSeconds: 0,
      completedAt: now,
      livekitSipStatus: "failed",
    });
    await ctx.db.patch(session.applicationId, { aiCallStatus: "failed" });
    await ctx.db.insert("pipelineEvents", {
      applicationId: session.applicationId,
      candidateId: session.candidateId,
      jobId: session.jobId,
      eventType: "voice_dial_failed",
      actorType: "agent",
      actorAgent: "career141-voice-dispatcher",
      notes: args.reason,
      metadata: JSON.stringify({ callSessionId: args.callSessionId }),
      createdAt: now,
    });
    return { success: true, idempotent: false };
  },
});

/**
 * Bounded crash-recovery watchdog. The indexed active range and status recheck
 * make retries idempotent; Convex OCC retries if an agent finalizes concurrently.
 */
export const failStaleVoiceCallSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - STALE_SESSION_AGE_MS;
    const sessions = await ctx.db
      .query("voiceCallSessions")
      .withIndex("by_status_startedAt", (q) =>
        q.eq("status", "active").lt("startedAt", cutoff),
      )
      .take(MAX_STALE_SESSIONS_PER_RUN);

    let failed = 0;
    for (const stale of sessions) {
      const session = await ctx.db.get(stale._id);
      if (
        !session ||
        session.status !== "active" ||
        session.startedAt >= cutoff
      ) {
        continue;
      }

      const durationSeconds = Math.min(
        MAX_CALL_DURATION_SECONDS,
        Math.max(0, Math.floor((now - session.startedAt) / 1000)),
      );
      await ctx.db.patch(session._id, {
        status: "failed",
        stateVersion: session.stateVersion + 1,
        finalizedAt: now,
        durationSeconds,
        ...(session.livekitRoomName
          ? {
              livekitSipStatus: "failed" as const,
              livekitFailureReason: "Stale session watchdog timeout",
            }
          : {}),
      });

      if (session.aiCallId) {
        const aiCall = await ctx.db.get(session.aiCallId);
        const relationshipMatches =
          aiCall &&
          String(aiCall.candidateId) === String(session.candidateId) &&
          String(aiCall.jobId) === String(session.jobId) &&
          String(aiCall.applicationId) === String(session.applicationId);
        if (
          relationshipMatches &&
          ["scheduled", "in_progress"].includes(aiCall.callStatus)
        ) {
          await ctx.db.patch(session.aiCallId, {
            ...(session.mode === "test" ? { isTestCall: true } : {}),
            callStatus: "failed",
            callDurationSeconds: durationSeconds,
            completedAt: now,
            ...(session.livekitRoomName
              ? { livekitSipStatus: "failed" as const }
              : {}),
          });

          if (isProductionVoiceMode(session.mode)) {
            const application = await ctx.db.get(session.applicationId);
            if (
              application &&
              String(application.candidateId) === String(session.candidateId) &&
              String(application.jobId) === String(session.jobId)
            ) {
              await ctx.db.patch(session.applicationId, {
                aiCallStatus: "failed",
              });
              await ctx.db.insert("pipelineEvents", {
                applicationId: session.applicationId,
                candidateId: session.candidateId,
                jobId: session.jobId,
                eventType: "voice_call_watchdog_failed",
                actorType: "system",
                actorAgent: "career141-voice-watchdog",
                metadata: JSON.stringify({ callSessionId: session._id }),
                createdAt: now,
              });
            }
          }
        }
      }
      failed++;
    }

    return { scanned: sessions.length, failed };
  },
});

/**
 * Atomically persist one confirmed live answer and advance the session version.
 * This is internal-only; client-supplied mode/application IDs are never trusted.
 */
export const commitConfirmedVoiceAnswer = internalMutation({
  args: {
    callSessionId: v.id("voiceCallSessions"),
    turnId: v.string(),
    field: voiceAnswerFieldValidator,
    value: v.number(),
    currency: v.optional(v.string()),
    expectedStateVersion: v.number(),
  },
  handler: async (ctx, args) => {
    assertBoundedIdentifier(args.turnId, "turnId", MAX_TURN_ID_CHARACTERS);
    if (
      !Number.isInteger(args.expectedStateVersion) ||
      args.expectedStateVersion < 0
    ) {
      throw new Error("expectedStateVersion must be a non-negative integer");
    }
    assertVoiceAnswerValue(args.field, args.value);
    assertVoiceAnswerCurrency(args.field, args.currency);

    const session = await ctx.db.get(args.callSessionId);
    if (!session) throw new Error("Voice call session not found");
    if (!isProductionVoiceMode(session.mode)) {
      return {
        success: true,
        committed: false,
        idempotent: false,
        stateVersion: session.stateVersion,
      };
    }

    const idempotencyKey = buildAnswerIdempotencyKey(
      args.callSessionId,
      args.turnId,
      args.field,
    );

    // Idempotency is checked before the version. A retry after an acknowledgement
    // loss carries the previous version but must still receive the first success.
    const existingAnswer = await ctx.db
      .query("voiceAnswers")
      .withIndex("by_idempotencyKey", (q) =>
        q.eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingAnswer) {
      if (
        String(existingAnswer.callSessionId) !== String(args.callSessionId) ||
        existingAnswer.turnId !== args.turnId ||
        existingAnswer.field !== args.field ||
        existingAnswer.value !== args.value ||
        existingAnswer.currency !== args.currency
      ) {
        throw new Error(
          "Idempotency key was reused with different answer data",
        );
      }
      return {
        success: true,
        committed: true,
        idempotent: true,
        answerId: existingAnswer._id,
        stateVersion: existingAnswer.committedStateVersion,
      };
    }

    if (session.status !== "active") {
      throw new Error(`Cannot commit an answer to a ${session.status} session`);
    }
    if (session.consentStatus !== "granted") {
      throw new Error(
        "Candidate consent must be granted before saving answers",
      );
    }
    if (session.stateVersion !== args.expectedStateVersion) {
      throw new Error(
        `State version mismatch: expected ${args.expectedStateVersion}, current ${session.stateVersion}`,
      );
    }

    const { candidate } = await getApplicationRelationship(
      ctx,
      session.candidateId,
      session.jobId,
      session.applicationId,
      true,
    );
    if (candidate.doNotContact) {
      throw new Error("Candidate is marked do-not-contact");
    }
    if (!session.aiCallId) {
      throw new Error("Live voice session is missing its aiCallId");
    }
    const aiCall = await getLiveAiCall(
      ctx,
      session.aiCallId,
      session.candidateId,
      session.jobId,
      session.applicationId,
    );
    if (aiCall.callStatus !== "in_progress") {
      throw new Error(
        `Cannot commit an answer to a ${aiCall.callStatus} AI call`,
      );
    }

    const now = Date.now();
    const committedStateVersion = session.stateVersion + 1;
    const candidatePatch: {
      lastUpdatedAt: number;
      currentSalary?: number;
      currentSalaryCurrency?: string;
      expectedSalary?: number;
      expectedSalaryCurrency?: string;
      noticePeriodDays?: number;
    } = { lastUpdatedAt: now };
    const applicationPatch: {
      candidateCurrentSalary?: number;
      candidateExpectedSalary?: number;
      candidateNoticePeriodDays?: number;
      followUpCurrentSalary?: boolean;
      followUpExpectedSalary?: boolean;
      followUpNoticePeriod?: boolean;
    } = {};
    const aiCallPatch: {
      currentSalary?: number;
      currentSalaryCurrency?: string;
      expectedSalary?: number;
      expectedSalaryCurrency?: string;
      noticePeriodDays?: number;
    } = {};

    if (args.field === "currentSalary") {
      candidatePatch.currentSalary = args.value;
      candidatePatch.currentSalaryCurrency = args.currency;
      applicationPatch.candidateCurrentSalary = args.value;
      applicationPatch.followUpCurrentSalary = true;
      aiCallPatch.currentSalary = args.value;
      aiCallPatch.currentSalaryCurrency = args.currency;
    } else if (args.field === "expectedSalary") {
      candidatePatch.expectedSalary = args.value;
      candidatePatch.expectedSalaryCurrency = args.currency;
      applicationPatch.candidateExpectedSalary = args.value;
      applicationPatch.followUpExpectedSalary = true;
      aiCallPatch.expectedSalary = args.value;
      aiCallPatch.expectedSalaryCurrency = args.currency;
    } else {
      candidatePatch.noticePeriodDays = args.value;
      applicationPatch.candidateNoticePeriodDays = args.value;
      applicationPatch.followUpNoticePeriod = true;
      aiCallPatch.noticePeriodDays = args.value;
    }

    const answerId = await ctx.db.insert("voiceAnswers", {
      callSessionId: args.callSessionId,
      candidateId: session.candidateId,
      applicationId: session.applicationId,
      jobId: session.jobId,
      turnId: args.turnId,
      field: args.field,
      value: args.value,
      currency: args.currency,
      idempotencyKey,
      expectedStateVersion: args.expectedStateVersion,
      committedStateVersion,
      committedAt: now,
    });
    await ctx.db.patch(session.candidateId, candidatePatch);
    await ctx.db.patch(session.applicationId, applicationPatch);
    await ctx.db.patch(session.aiCallId, aiCallPatch);
    await ctx.db.patch(args.callSessionId, {
      stateVersion: committedStateVersion,
    });
    await ctx.db.insert("pipelineEvents", {
      applicationId: session.applicationId,
      candidateId: session.candidateId,
      jobId: session.jobId,
      eventType: "voice_answer_confirmed",
      actorType: "agent",
      actorAgent: "career141-voice-agent",
      metadata: JSON.stringify({
        callSessionId: args.callSessionId,
        turnId: args.turnId,
        field: args.field,
        stateVersion: committedStateVersion,
      }),
      createdAt: now,
    });

    return {
      success: true,
      committed: true,
      idempotent: false,
      answerId,
      stateVersion: committedStateVersion,
    };
  },
});

/** Finalize a session once. A same-status retry is idempotent. */
export const finalizeVoiceCallSession = internalMutation({
  args: {
    callSessionId: v.id("voiceCallSessions"),
    expectedStateVersion: v.number(),
    status: terminalVoiceStatusValidator,
    durationSeconds: v.number(),
    transcript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.expectedStateVersion) ||
      args.expectedStateVersion < 0
    ) {
      throw new Error("expectedStateVersion must be a non-negative integer");
    }
    assertCallDuration(args.durationSeconds);
    assertTranscript(args.transcript);

    const session = await ctx.db.get(args.callSessionId);
    if (!session) throw new Error("Voice call session not found");

    if (session.status !== "active") {
      if (session.status === args.status) {
        return {
          success: true,
          committed: session.mode === "live",
          idempotent: true,
          stateVersion: session.stateVersion,
        };
      }
      throw new Error(
        `Session is already ${session.status}; cannot finalize it as ${args.status}`,
      );
    }
    if (session.stateVersion !== args.expectedStateVersion) {
      throw new Error(
        `State version mismatch: expected ${args.expectedStateVersion}, current ${session.stateVersion}`,
      );
    }
    if (
      session.mode === "live" &&
      args.status === "completed" &&
      session.consentStatus !== "granted"
    ) {
      throw new Error("A live call cannot complete before consent is granted");
    }

    const now = Date.now();
    const finalizedStateVersion = session.stateVersion + 1;

    // Non-production finalization never touches candidate/application fields,
    // transcripts, or pipeline events. A dedicated test aiCall may retain only
    // its own operational status and duration for diagnostics.
    if (!isProductionVoiceMode(session.mode)) {
      await ctx.db.patch(args.callSessionId, {
        status: args.status,
        stateVersion: finalizedStateVersion,
        finalizedAt: now,
        durationSeconds: args.durationSeconds,
        ...(session.mode === "test"
          ? {
              livekitSipStatus:
                args.status === "completed"
                  ? ("completed" as const)
                  : ("failed" as const),
            }
          : {}),
      });
      if (session.mode === "test" && session.aiCallId) {
        await ctx.db.patch(session.aiCallId, {
          isTestCall: true,
          callStatus: args.status === "completed" ? "completed" : "failed",
          callDurationSeconds: args.durationSeconds,
          completedAt: now,
          livekitSipStatus:
            args.status === "completed" ? "completed" : "failed",
        });
      }
      return {
        success: true,
        committed: false,
        idempotent: false,
        stateVersion: finalizedStateVersion,
      };
    }

    await getApplicationRelationship(
      ctx,
      session.candidateId,
      session.jobId,
      session.applicationId,
      false,
    );
    if (!session.aiCallId) {
      throw new Error("Live voice session is missing its aiCallId");
    }
    await getLiveAiCall(
      ctx,
      session.aiCallId,
      session.candidateId,
      session.jobId,
      session.applicationId,
    );

    const aiCallStatus: "completed" | "failed" =
      args.status === "completed" ? "completed" : "failed";

    await ctx.db.patch(args.callSessionId, {
      status: args.status,
      stateVersion: finalizedStateVersion,
      finalizedAt: now,
      durationSeconds: args.durationSeconds,
      ...(session.livekitRoomName
        ? {
            livekitSipStatus:
              args.status === "completed"
                ? ("completed" as const)
                : ("failed" as const),
          }
        : {}),
    });
    await ctx.db.patch(session.aiCallId, {
      callStatus: aiCallStatus,
      callDurationSeconds: args.durationSeconds,
      completedAt: now,
      transcript: args.transcript,
      ...(session.livekitRoomName
        ? {
            livekitSipStatus:
              args.status === "completed"
                ? ("completed" as const)
                : ("failed" as const),
          }
        : {}),
    });
    await ctx.db.patch(session.applicationId, {
      aiCallStatus: aiCallStatus,
    });
    await ctx.db.insert("pipelineEvents", {
      applicationId: session.applicationId,
      candidateId: session.candidateId,
      jobId: session.jobId,
      eventType: "voice_call_finalized",
      actorType: "agent",
      actorAgent: "career141-voice-agent",
      metadata: JSON.stringify({
        callSessionId: args.callSessionId,
        status: args.status,
        durationSeconds: args.durationSeconds,
        stateVersion: finalizedStateVersion,
      }),
      createdAt: now,
    });

    return {
      success: true,
      committed: true,
      idempotent: false,
      stateVersion: finalizedStateVersion,
    };
  },
});
