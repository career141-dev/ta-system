"use node";

import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  isOutboundCallTestMode,
  resolveOutboundRecipient,
} from "./livekitSipPolicy";

const MAX_CALL_DURATION_SECONDS = 5 * 60;
const RINGING_TIMEOUT_SECONDS = 25;
const DIAL_REQUEST_TIMEOUT_SECONDS = 35;

type DispatchResult = {
  success: boolean;
  engine: "disabled" | "livekit";
  suppressed?: boolean;
  idempotent?: boolean;
  callSessionId?: string;
  participantId?: string;
  sipCallId?: string;
  reason?: string;
};

function readRequiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function assertLiveKitUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("LIVEKIT_URL is not a valid URL");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("LIVEKIT_URL must use HTTP(S) or WS(S)");
  }
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * Feature-gated dispatcher for user-triggered calls only.
 *
 * VOICE_ENGINE=livekit is the sole setting that may reach a provider. Missing,
 * disabled, legacy, or unknown values fail closed without making any call.
 */
export const dispatchManualVoiceCall = internalAction({
  args: {
    aiCallId: v.id("aiCalls"),
    kind: v.union(v.literal("intake"), v.literal("follow_up")),
    attemptNumber: v.optional(v.number()),
    lastContactChannel: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DispatchResult> => {
    const engine = process.env.VOICE_ENGINE?.trim().toLowerCase();

    let callContext;
    try {
      callContext = await ctx.runQuery(
        internal.aiCalls.voiceCalls.getLiveOutboundCallContext,
        { aiCallId: args.aiCallId },
      );
    } catch {
      try {
        await ctx.runMutation(
          internal.aiCalls.voiceCalls.markVoiceDialNotPlaced,
          {
            aiCallId: args.aiCallId,
            status: "failed",
            reason: "Outbound voice validation failed",
            diagnosticOnly: true,
          },
        );
      } catch {
        // The authoritative relationship may itself be missing. Do not weaken
        // validation merely to update a malformed record.
      }
      return {
        success: false,
        engine: engine === "livekit" ? "livekit" : "disabled",
        reason: "Outbound voice validation failed",
      };
    }

    if (engine !== "livekit") {
      await ctx.runMutation(
        internal.aiCalls.voiceCalls.markVoiceDialNotPlaced,
        {
          aiCallId: args.aiCallId,
          status: "suppressed",
          reason: "Voice engine is disabled or unsupported",
          diagnosticOnly: true,
        },
      );
      return {
        success: false,
        engine: "disabled",
        suppressed: true,
        reason: "Voice engine is disabled or unsupported",
      };
    }

    if (callContext.existingSession) {
      if (
        callContext.existingSession.livekitParticipantId &&
        callContext.existingSession.livekitSipCallId
      ) {
        return {
          success: true,
          engine: "livekit",
          idempotent: true,
          callSessionId: String(callContext.existingSession.callSessionId),
          participantId: callContext.existingSession.livekitParticipantId,
          sipCallId: callContext.existingSession.livekitSipCallId,
        };
      }

      // A prior attempt may have placed a call but crashed before persisting
      // the provider response. Never redial an uncertain recipient.
      return {
        success: false,
        engine: "livekit",
        idempotent: true,
        callSessionId: String(callContext.existingSession.callSessionId),
        reason: "A prior dial has an unresolved outcome; refusing to redial",
      };
    }

    let livekitUrl: string;
    let apiKey: string;
    let apiSecret: string;
    let outboundTrunkId: string;
    try {
      livekitUrl = readRequiredEnvironment("LIVEKIT_URL");
      apiKey = readRequiredEnvironment("LIVEKIT_API_KEY");
      apiSecret = readRequiredEnvironment("LIVEKIT_API_SECRET");
      outboundTrunkId = readRequiredEnvironment(
        "LIVEKIT_SIP_OUTBOUND_TRUNK_ID",
      );
      assertLiveKitUrl(livekitUrl);
    } catch {
      await ctx.runMutation(
        internal.aiCalls.voiceCalls.markVoiceDialNotPlaced,
        {
          aiCallId: args.aiCallId,
          status: "failed",
          reason: "LiveKit SIP configuration is incomplete or invalid",
          diagnosticOnly: true,
        },
      );
      return {
        success: false,
        engine: "livekit",
        reason: "LiveKit SIP configuration is incomplete or invalid",
      };
    }

    const settings = await ctx.runQuery(
      internal.admin.settings.getInternalSystemSettings,
      {},
    );
    const isTestMode = isOutboundCallTestMode({
      callTestMode: process.env.CALL_TEST_MODE,
      outreachTestMode: process.env.OUTREACH_TEST_MODE,
      globalTestMode: process.env.TEST_MODE,
      settingsTestMode: settings?.testModeEnabled,
    });
    const recipientResolution = resolveOutboundRecipient({
      isTestMode,
      candidatePhone: callContext.candidatePhone,
      testRecipient:
        process.env.CALL_TEST_RECIPIENT ??
        process.env.TEST_PHONE_NUMBER ??
        settings?.testPhoneNumber,
    });

    if (recipientResolution.outcome === "suppressed") {
      await ctx.runMutation(
        internal.aiCalls.voiceCalls.markVoiceDialNotPlaced,
        {
          aiCallId: args.aiCallId,
          status: "suppressed",
          reason:
            "Test mode suppressed the call: no valid E.164 test recipient",
          diagnosticOnly: true,
          isTestCall: true,
        },
      );
      return {
        success: false,
        engine: "livekit",
        suppressed: true,
        reason: "Test mode has no valid E.164 test recipient",
      };
    }
    if (recipientResolution.outcome === "invalid_candidate") {
      await ctx.runMutation(
        internal.aiCalls.voiceCalls.markVoiceDialNotPlaced,
        {
          aiCallId: args.aiCallId,
          status: "failed",
          reason: "Candidate phone number is not valid E.164",
          diagnosticOnly: false,
        },
      );
      return {
        success: false,
        engine: "livekit",
        reason: "Candidate phone number is not valid E.164",
      };
    }
    const recipient = recipientResolution.recipient;

    const nonce = crypto.randomUUID();
    const roomName = `voice-${nonce}`;
    const participantIdentity = `candidate-${nonce}`;
    const externalSessionId = `livekit:${String(args.aiCallId)}:${nonce}`;
    const started = await ctx.runMutation(
      internal.aiCalls.voiceCalls.startVoiceCallSession,
      {
        externalSessionId,
        aiCallId: args.aiCallId,
        candidateId: callContext.candidateId,
        applicationId: callContext.applicationId,
        jobId: callContext.jobId,
        mode: isTestMode ? "test" : "live",
        livekitRoomName: roomName,
        livekitParticipantIdentity: participantIdentity,
      },
    );

    const participantMetadata = JSON.stringify({
      schemaVersion: 1,
      mode: isTestMode ? "simulation" : "live",
      sessionMode: isTestMode ? "test" : "live",
      kind: args.kind,
      callSessionId: String(started.callSessionId),
      stateVersion: started.stateVersion,
      consentStatus: isTestMode ? "not_required" : "pending",
      aiCallId: String(args.aiCallId),
      candidateId: String(callContext.candidateId),
      applicationId: String(callContext.applicationId),
      jobId: String(callContext.jobId),
      candidateName: truncate(callContext.candidateName, 100),
      jobTitle: truncate(callContext.jobTitle, 160),
      jobDescription: truncate(callContext.jobDescription, 2_000),
      customScript: "",
      customQuestions: callContext.customQuestions
        .slice(0, 8)
        .map((question: string) => truncate(question, 300)),
      callScriptUsed: callContext.callScriptUsed,
      companyHidden: callContext.companyHidden,
      maxCallDurationSeconds: MAX_CALL_DURATION_SECONDS,
    });

    let participant;
    try {
      const roomClient = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
      await roomClient.createRoom({
        name: roomName,
        emptyTimeout: RINGING_TIMEOUT_SECONDS + 35,
        departureTimeout: 10,
        maxParticipants: 3,
        metadata: participantMetadata,
      });

      const sipClient = new SipClient(livekitUrl, apiKey, apiSecret);
      participant = await sipClient.createSipParticipant(
        outboundTrunkId,
        recipient,
        roomName,
        {
          participantIdentity,
          participantName: "Candidate",
          participantMetadata,
          participantAttributes: {
            "career141.callSessionId": String(started.callSessionId),
            "career141.aiCallId": String(args.aiCallId),
            "career141.mode": isTestMode ? "test" : "live",
          },
          hidePhoneNumber: true,
          ringingTimeout: RINGING_TIMEOUT_SECONDS,
          maxCallDuration: MAX_CALL_DURATION_SECONDS,
          waitUntilAnswered: true,
          timeout: DIAL_REQUEST_TIMEOUT_SECONDS,
        },
      );
    } catch {
      await ctx.runMutation(internal.aiCalls.voiceCalls.failVoiceCallDial, {
        callSessionId: started.callSessionId,
        reason: "LiveKit SIP rejected or timed out the outbound dial",
      });
      return {
        success: false,
        engine: "livekit",
        callSessionId: String(started.callSessionId),
        reason: "LiveKit SIP rejected or timed out the outbound dial",
      };
    }

    if (
      !participant.participantId ||
      !participant.participantIdentity ||
      !participant.roomName ||
      !participant.sipCallId
    ) {
      // The provider may already have connected the call. Preserve the active
      // prepared session and refuse future redials instead of guessing.
      throw new Error(
        "LiveKit returned incomplete SIP participant identifiers",
      );
    }

    await ctx.runMutation(
      internal.aiCalls.voiceCalls.recordLivekitSipParticipant,
      {
        callSessionId: started.callSessionId,
        roomName: participant.roomName,
        participantId: participant.participantId,
        participantIdentity: participant.participantIdentity,
        sipCallId: participant.sipCallId,
        status: "answered",
      },
    );

    return {
      success: true,
      engine: "livekit",
      callSessionId: String(started.callSessionId),
      participantId: participant.participantId,
      sipCallId: participant.sipCallId,
    };
  },
});
