import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { handleWhatChimpWebhook } from "./communications/whatchimp";
import { verifyElevenLabsSignature, verifyTokenMatches } from "./lib/webhookSecurity";
import {
  partnerCompleteCvUpload,
  partnerCreateCvUpload,
  partnerReadCv,
  partnerReadTable,
  partnerReadTableIndex,
} from "./integrations/partnerReadHttp";
import type { Id } from "./_generated/dataModel";
import {
  isFreshVoiceAgentTimestamp,
  parseVoiceAgentEvent,
  verifyVoiceAgentSignature,
} from "./lib/voiceAgentWebhook";

const http = httpRouter();

// The partner integration is authenticated and scoped to these explicit routes;
// no database admin credential is given to the Capacity Planner.
// Note: Convex httpRouter supports exact `path` or `pathPrefix` only — no
// `:param` placeholders. The handlers extract the table name / upload ID from
// the URL pathname themselves (2026-10-13: fixed 404 on parameterised routes).
http.route({ path: "/integrations/v1/tables", method: "GET", handler: partnerReadTableIndex });
http.route({ pathPrefix: "/integrations/v1/tables/", method: "GET", handler: partnerReadTable });
http.route({ path: "/integrations/v1/cv/uploads", method: "POST", handler: partnerCreateCvUpload });
http.route({ path: "/integrations/v1/cv/uploads/complete", method: "POST", handler: partnerCompleteCvUpload });
http.route({ pathPrefix: "/integrations/v1/cv/", method: "GET", handler: partnerReadCv });

/**
 * Meta's webhook verification handshake.
 *
 * This used to accept three tokens written into this file
 * ("career141-secure-key", "whatchimp_secret", "career141") and, when nothing
 * was configured, anything at all — which is how the Verify token field in the
 * app configuration could be saved blank. Anyone who read this file, or
 * guessed, could point the subscription somewhere else (23 September).
 *
 * Now: only `META_VERIFY_TOKEN`, and no token configured means the handshake
 * fails rather than passes. Set it on the deployment *before* changing the
 * value in Meta — the handshake re-runs the moment that field is saved.
 */
const handleMetaVerification = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    console.error("[Meta Verification] META_VERIFY_TOKEN is not set — refusing the handshake.");
    return new Response("Webhook not configured", { status: 503 });
  }

  if (mode === "subscribe" && verifyTokenMatches(token, expected)) {
    return new Response(challenge ?? "OK", { status: 200 });
  }
  console.warn("[Meta Verification] Rejected a handshake with a wrong or missing verify token.");
  return new Response("Forbidden", { status: 403 });
});

http.route({ path: "/api/whatsapp", method: "GET", handler: handleMetaVerification });
http.route({ path: "/whatsapp", method: "GET", handler: handleMetaVerification });
http.route({ path: "/api/whatsapp-whatchimp", method: "GET", handler: handleMetaVerification });
http.route({ path: "/whatsapp-whatchimp", method: "GET", handler: handleMetaVerification });

// Meta / WhatChimp Inbound POST Events (supports both /api/whatsapp-whatchimp and /whatsapp-whatchimp)
http.route({
  path: "/api/whatsapp",
  method: "POST",
  handler: handleWhatChimpWebhook,
});

http.route({
  path: "/whatsapp",
  method: "POST",
  handler: handleWhatChimpWebhook,
});

http.route({
  path: "/api/whatsapp-whatchimp",
  method: "POST",
  handler: handleWhatChimpWebhook,
});

http.route({
  path: "/whatsapp-whatchimp",
  method: "POST",
  handler: handleWhatChimpWebhook,
});


// /api/test-job, a Postman endpoint that created and published a job, was
// removed on 2 Oct 2026: it compared the deployment admin key with `!==` on a
// public route, and nothing calls it.

// /api/twilio-callback was removed on 2 Oct 2026. Nothing places Twilio calls
// any more, and the route checked no signature, so anyone could post a CallSid
// and advance or reject an application.

// ==========================================
// ELEVENLABS WEBHOOKS
// ==========================================

const verifyElevenLabsSecret = async (request: Request, rawBody: string) => {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) throw new Error("ELEVENLABS_WEBHOOK_SECRET not set");
  const signature = request.headers.get("x-elevenlabs-signature");
  const isValid = await verifyElevenLabsSignature(rawBody, signature, secret);
  if (!isValid) {
    throw new Error("Unauthorized");
  }
};

http.route({
  path: "/api/elevenlabs/save-intake",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const rawBody = await request.text();
      // Signed like post-call-webhook (2 Oct 2026). Without it anyone could
      // write salary and notice period onto any candidate by id. Fails closed
      // when ELEVENLABS_WEBHOOK_SECRET is unset.
      await verifyElevenLabsSecret(request, rawBody);
      const body = JSON.parse(rawBody);
      console.log("[save-intake] Received tool payload from AI:", body);

      
      const candidate_id = body.candidate_id;
      const application_id = body.application_id;
      const conversation_id = body.conversation_id;
      const {
        current_salary,
        expected_salary,
        notice_period_days,
        candidate_questions,
        custom_question_answers,
      } = body;
      if (!candidate_id) throw new Error("Missing candidate_id");

      let aiCall: any = null;

      // Idempotency: Check if already processed
      if (conversation_id) {
        aiCall = await ctx.runQuery(internal.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
        if (aiCall && aiCall.currentSalary === current_salary && aiCall.expectedSalary === expected_salary && aiCall.noticePeriodDays === notice_period_days) {
           return new Response(JSON.stringify({ success: true, note: "Already processed" }), { status: 200 });
        }
      }

      let finalCurrentSalary = current_salary;
      if (typeof finalCurrentSalary === "string") finalCurrentSalary = parseInt(finalCurrentSalary.replace(/[^0-9]/g, ""), 10);
      
      let finalExpectedSalary = expected_salary;
      if (typeof finalExpectedSalary === "string") finalExpectedSalary = parseInt(finalExpectedSalary.replace(/[^0-9]/g, ""), 10);
      
      let finalNotice = notice_period_days;
      if (typeof finalNotice === "string") {
        // If AI passes "2 months" or "two months", convert words to digits then extract number
        let lower = finalNotice.toLowerCase();
        
        // Map common spelled-out numbers
        const wordToNum: Record<string, string> = {
          "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", 
          "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
          "a month": "1 month", "a week": "1 week"
        };
        for (const [word, digit] of Object.entries(wordToNum)) {
          lower = lower.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
        }

        let num = parseInt(lower.replace(/[^0-9]/g, ""), 10);
        if (lower.includes("month")) num = num * 30;
        else if (lower.includes("week")) num = num * 7;
        finalNotice = num;
      }
      
      if (finalCurrentSalary === null || isNaN(finalCurrentSalary)) finalCurrentSalary = undefined;
      if (finalExpectedSalary === null || isNaN(finalExpectedSalary)) finalExpectedSalary = undefined;
      if (finalNotice === null || isNaN(finalNotice)) finalNotice = undefined;

      let finalNoticeText = undefined;
      if (typeof notice_period_days === "string") {
        finalNoticeText = notice_period_days;
      } else if (typeof notice_period_days === "number") {
        finalNoticeText = `${notice_period_days} Days`;
      }

      // 1. Write to global candidate profile
      await ctx.runMutation(internal.candidates.candidates.updateCandidateDetails, {
        candidateId: candidate_id as any,
        currentSalary: finalCurrentSalary,
        expectedSalary: finalExpectedSalary,
        noticePeriodDays: finalNotice,
        noticePeriod: finalNoticeText,
        candidateQuestions: candidate_questions,
      });

      // 1b. Save custom question answers to aiCalls if available
      if (aiCall && custom_question_answers && Array.isArray(custom_question_answers)) {
        await ctx.runMutation(internal.applications.applications.saveCustomQuestionAnswers, {
          aiCallId: aiCall._id,
          customQuestionAnswers: custom_question_answers,
        });
      }

      // 2. If application_id is present, update per-application flags too
      // If it is missing (because ElevenLabs didn't pass it back) OR if it no longer exists, find the application via candidate_id
      let appIdsToUpdate: string[] = [];
      let foundValidApp = false;
      
      if (application_id) {
        const existingApp = await ctx.runQuery(internal.applications.applications.getApplication, { id: application_id as any }).catch(() => null);
        if (existingApp) {
          appIdsToUpdate.push(application_id);
          foundValidApp = true;
        }
      } 
      
      if (!foundValidApp && candidate_id) {
        // Fallback: find any application for this candidate in follow_up or ai_call stage
        const apps = await ctx.runQuery(internal.applications.applications.getApplicationsByCandidateId, { candidateId: candidate_id as any });
        if (apps) {
          for (const app of apps) {
            if (app.currentStage === "follow_up" || app.currentStage === "ai_call" || app.currentStage === "ta_shortlist") {
              appIdsToUpdate.push(app._id);
            }
          }
        }
      }

      for (const appId of appIdsToUpdate) {
        const flagUpdates: any = {};
        if (finalCurrentSalary !== undefined && finalCurrentSalary !== null) flagUpdates.followUpCurrentSalary = true;
        if (finalExpectedSalary !== undefined && finalExpectedSalary !== null) flagUpdates.followUpExpectedSalary = true;
        if (finalNotice !== undefined && finalNotice !== null) flagUpdates.followUpNoticePeriod = true;

        if (Object.keys(flagUpdates).length > 0) {
          await ctx.runMutation(internal.applications.applications.setApplicationFlags, {
            applicationId: appId as any,
            ...flagUpdates,
          });
        }
      }
      
      // Update aiCall to reflect saved data for idempotency tracking
      if (conversation_id) {
        const aiCall = await ctx.runQuery(internal.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
        if (aiCall) {
          // You don't have a specific mutation to update aiCall data in applications.ts, but updateAiCallStatus is there.
          // Idempotency relies on currentSalary/expectedSalary which we just verified above. We need a way to store them.
          // Since we don't have an updateAiCallData mutation, the idempotency check for save-intake might be enough if we just check candidates table, but it's safe to just let it overwrite.
        }
      }

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e: any) {
      console.error("[save-intake] Error:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: e.message === "Unauthorized" ? 401 : 500 });
    }
  }),
});

http.route({
  path: "/api/elevenlabs/mark-declined",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const rawBody = await request.text();
      // Signed like post-call-webhook (2 Oct 2026). Unsigned, anyone could mark
      // any candidate do-not-contact or reject an application by id.
      await verifyElevenLabsSecret(request, rawBody);
      const body = JSON.parse(rawBody);
      const candidate_id = body.candidate_id;
      const application_id = body.application_id;
      const conversation_id = body.conversation_id || body.system__conversation_id;
      const { reason } = body;
      
      if (!candidate_id) throw new Error("Missing candidate_id");

      if (conversation_id) {
        const aiCall = await ctx.runQuery(internal.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
        if (aiCall && aiCall.callStatus === "failed") { // If we mark it failed/rejected already
           // Idempotency: if already processed, return 200
        }
      }

      if (reason === "opt_out") {
        await ctx.runMutation(internal.candidates.candidates.setDoNotContact, {
          candidateId: candidate_id as any,
          reason: "Opted out via AI Call",
        });
        
        if (application_id) {
          const app = await ctx.runQuery(internal.applications.applications.getApplication, { id: application_id as any });
          if (app && app.currentStage !== "rejected") {
            await ctx.runMutation(internal.applications.applications.rejectApplication, {
              applicationId: application_id as any,
              reason: "Candidate opted out via AI Call",
              stage: "rejected",
            });
          }
        }
      } else if (reason === "bad_timing" || reason === "not_interested") {
        if (application_id) {
          const app = await ctx.runQuery(internal.applications.applications.getApplication, { id: application_id as any });
          if (app && app.currentStage !== "follow_up" && app.currentStage !== "rejected") {
            const now = Date.now();
            await ctx.runMutation(internal.pipeline.stages.setPipelineStage, {
              applicationId: application_id as any,
              newStage: "follow_up",
              note: `AI call declined. Reason: ${reason}`,
            });
            // Set the 7-day clock entry point
            await ctx.runMutation(internal.applications.applications.setFollowUpEnteredAt, {
              applicationId: application_id as any,
              enteredAt: now,
            });
          }
        }
      }

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: e.message === "Unauthorized" ? 401 : 500 });
    }
  }),
});

http.route({
  path: "/api/elevenlabs/post-call-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const rawBody = await request.text();
      await verifyElevenLabsSecret(request, rawBody);
      const body = JSON.parse(rawBody);
      
      const conversationId = body.conversation_id;
      const status = body.status; // "done" | "failed"
      // Data extracted by ElevenLabs agent and passed back in the webhook
      const currentSalary = body.current_salary;
      const expectedSalary = body.expected_salary;
      const noticePeriodDays = body.notice_period_days;
      const candidateQuestions = body.candidate_questions;
      
      const aiCall = await ctx.runQuery(internal.applications.applications.findAiCallByElevenLabsId, { conversationId });
      if (!aiCall) {
        console.warn("[ElevenLabs] No aiCalls record found for conversation:", conversationId);
        return new Response("OK", { status: 200 });
      }

      // Idempotency: if this conversation is already processed as completed or failed, ignore.
      if (aiCall.callStatus === "completed" || aiCall.callStatus === "failed" || aiCall.callStatus === "no_answer") {
        return new Response(JSON.stringify({ success: true, note: "Already processed" }), { status: 200 });
      }

      let mappedStatus = "in_progress";
      if (status === "done" || status === "success") mappedStatus = "completed";
      else if (status === "failed") mappedStatus = "failed";

      await ctx.runMutation(internal.applications.applications.updateAiCallStatus, {
        aiCallId: aiCall._id,
        callStatus: mappedStatus as any,
      });

      // Path 2 routing: complete call → check if all 3 fields captured
      if (mappedStatus === "completed" && aiCall.applicationId) {
        const allThreeCaptured =
          (currentSalary !== undefined && currentSalary !== null) &&
          (expectedSalary !== undefined && expectedSalary !== null) &&
          (noticePeriodDays !== undefined && noticePeriodDays !== null);

        // Write salary/notice and questions to candidate global profile
        if (currentSalary !== undefined || expectedSalary !== undefined || noticePeriodDays !== undefined || candidateQuestions !== undefined) {
          await ctx.runMutation(internal.candidates.candidates.updateCandidateDetails, {
            candidateId: aiCall.candidateId,
            currentSalary,
            expectedSalary,
            noticePeriodDays,
            candidateQuestions,
          });
        }

        const now = Date.now();

        if (allThreeCaptured) {
          // All 3 collected on first AI call → skip Follow-up, go straight to 2nd Shortlist
          await ctx.runMutation(internal.applications.applications.setApplicationFlags, {
            applicationId: aiCall.applicationId,
            followUpCurrentSalary: true,
            followUpExpectedSalary: true,
            followUpNoticePeriod: true,
          });
          await ctx.runMutation(internal.pipeline.stages.setPipelineStage, {
            applicationId: aiCall.applicationId,
            newStage: "second_shortlist",
            note: "AI call completed — all 3 fields captured. Skipping Follow-up.",
          });
        } else {
          // Partial or no answer → move to Follow-up and start 7-day clock
          const flagUpdates: any = {};
          if (currentSalary !== undefined && currentSalary !== null) flagUpdates.followUpCurrentSalary = true;
          if (expectedSalary !== undefined && expectedSalary !== null) flagUpdates.followUpExpectedSalary = true;
          if (noticePeriodDays !== undefined && noticePeriodDays !== null) flagUpdates.followUpNoticePeriod = true;

          if (Object.keys(flagUpdates).length > 0) {
            await ctx.runMutation(internal.applications.applications.setApplicationFlags, {
              applicationId: aiCall.applicationId,
              ...flagUpdates,
            });
          }

          const app = await ctx.runQuery(internal.applications.applications.getApplication, { id: aiCall.applicationId });
          if (app && app.currentStage !== "follow_up") {
            await ctx.runMutation(internal.pipeline.stages.setPipelineStage, {
              applicationId: aiCall.applicationId,
              newStage: "follow_up",
              note: "AI call completed — missing data fields. Entering Follow-up.",
            });
            // Set precise 7-day clock start
            await ctx.runMutation(internal.applications.applications.setFollowUpEnteredAt, {
              applicationId: aiCall.applicationId,
              enteredAt: now,
            });
          }
        }
      } else if (mappedStatus === "failed" || mappedStatus === "no_answer") {
        // Call not answered or failed → move to Follow-up
        if (aiCall.applicationId) {
          const now = Date.now();
          const app = await ctx.runQuery(internal.applications.applications.getApplication, { id: aiCall.applicationId });
          if (app && app.currentStage !== "follow_up") {
            await ctx.runMutation(internal.pipeline.stages.setPipelineStage, {
              applicationId: aiCall.applicationId,
              newStage: "follow_up",
              note: `AI call ${mappedStatus} — entering Follow-up for outreach.`,
            });
            await ctx.runMutation(internal.applications.applications.setFollowUpEnteredAt, {
              applicationId: aiCall.applicationId,
              enteredAt: now,
            });
          }
        }
      }

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: e.message === "Unauthorized" ? 401 : 500 });
    }
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph Webhook — Validation Handshake (GET)
// ─────────────────────────────────────────────────────────────────────────────
http.route({
  path: "/api/graph-webhook",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const validationToken = url.searchParams.get("validationToken");

    if (validationToken) {
      // Microsoft requires a synchronous 200 response with the token in plain text
      return new Response(validationToken, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Missing validationToken", { status: 400 });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph Webhook — Change Notifications (POST)
// ─────────────────────────────────────────────────────────────────────────────
http.route({
  path: "/api/graph-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      const notifications = body.value ?? [];

      console.log(
        `[Graph Webhook] Received ${notifications.length} notification(s)`
      );

      /*
       * clientState is the only proof a notification came from our own
       * subscription (2 Oct 2026). It used to be checked only when both sides
       * had one, so a POST without it — or any POST when the variable was
       * unset — was trusted. Now a missing or wrong value is dropped, and no
       * MS_GRAPH_CLIENT_STATE means nothing is accepted. Nothing is lost: the
       * crons in crons.ts poll the same inboxes every few minutes.
       */
      const expectedClientState = process.env.MS_GRAPH_CLIENT_STATE;
      if (!expectedClientState) {
        console.error("[Graph Webhook] MS_GRAPH_CLIENT_STATE is not set — ignoring every notification.");
        return new Response(null, { status: 202 });
      }

      for (const notification of notifications) {
        if (!verifyTokenMatches(typeof notification.clientState === "string" ? notification.clientState : null, expectedClientState)) {
          console.warn("[Graph Webhook] Dropped a notification with a missing or wrong clientState.");
          continue;
        }

        // Extract the mailbox from the resource path:
        //   "users/{email}/mailFolders/inbox/messages" → email
        const resourceMatch = notification.resource?.match(
          /^users\/([^/]+)\/mailFolders/
        );
        const taEmail = resourceMatch?.[1];

        if (!taEmail || taEmail.toLowerCase().includes("sanjeev")) {
          console.warn("[Graph Webhook] Skipping disabled or unparseable taEmail resource:", notification.resource);
          continue;
        }

        // Schedule the inbox read action to retrieve the new messages
        await ctx.scheduler.runAfter(
          0,
          internal.communications.emailAgent.pollEmailInbox,
          { inboxEmail: taEmail }
        );

        console.log(`[Graph Webhook] Scheduled inbox read for ${taEmail}`);
      }

      // Microsoft expects a 202 Accepted
      return new Response(null, { status: 202 });
    } catch (e: any) {
      console.error("[Graph Webhook] Error processing notification:", e.message);
      return new Response("Error", { status: 500 });
    }
  }),
});

// /api/r2-file was removed on 2 Oct 2026. It redirected anyone who asked to a
// signed link for whatever bucket key they named — every CV in R2. The TA app
// never called it: it reads the key out of getCvUploadUrl's `/api/r2-file?key=`
// answer and signs it server-side after checking the person's access
// (src/data/convex/backend.ts, cvLink).

// Authenticated write bridge for the external LiveKit worker. All state writes
// remain internal mutations; the shared secret never grants a public mutation.
http.route({
  path: "/api/voice-agent/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const respond = (status: number, body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const secret = process.env.VOICE_AGENT_SHARED_SECRET;
    if (!secret || secret.length < 32) {
      return respond(503, { success: false, error: "Voice bridge unavailable" });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 120_000) {
      return respond(413, { success: false, error: "Request too large" });
    }

    const timestamp = request.headers.get("x-career141-timestamp");
    const nonce = request.headers.get("x-career141-nonce");
    const signature = request.headers.get("x-career141-signature");
    if (
      !timestamp ||
      !nonce ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      !isFreshVoiceAgentTimestamp(timestamp)
    ) {
      return respond(401, { success: false, error: "Unauthorized" });
    }

    const rawBody = await request.text();
    if (rawBody.length > 120_000) {
      return respond(413, { success: false, error: "Request too large" });
    }
    const verified = await verifyVoiceAgentSignature({
      rawBody,
      timestamp,
      nonce,
      signature,
      secret,
    });
    if (!verified) {
      return respond(401, { success: false, error: "Unauthorized" });
    }

    try {
      await ctx.runMutation(internal.aiCalls.voiceCalls.claimVoiceAgentNonce, {
        nonce,
      });
    } catch {
      return respond(409, { success: false, error: "Request replayed" });
    }

    let event;
    try {
      event = parseVoiceAgentEvent(JSON.parse(rawBody));
    } catch {
      return respond(400, { success: false, error: "Invalid voice event" });
    }

    try {
      if (event.type === "consent") {
        const result = await ctx.runMutation(
          internal.aiCalls.voiceCalls.recordVoiceConsent,
          {
            callSessionId: event.callSessionId as Id<"voiceCallSessions">,
            decision: event.decision,
            idempotencyKey: event.idempotencyKey,
            expectedStateVersion: event.expectedStateVersion,
          },
        );
        return respond(200, {
          success: true,
          stateVersion: result.stateVersion,
        });
      }
      if (event.type === "confirmed_answer") {
        const result = await ctx.runMutation(
          internal.aiCalls.voiceCalls.commitConfirmedVoiceAnswer,
          {
            callSessionId: event.callSessionId as Id<"voiceCallSessions">,
            turnId: event.turnId,
            field: event.field,
            value: event.value,
            ...(event.currency !== undefined
              ? { currency: event.currency }
              : {}),
            expectedStateVersion: event.expectedStateVersion,
          },
        );
        return respond(200, {
          success: true,
          stateVersion: result.stateVersion,
        });
      }

      const result = await ctx.runMutation(
        internal.aiCalls.voiceCalls.finalizeVoiceCallSession,
        {
          callSessionId: event.callSessionId as Id<"voiceCallSessions">,
          expectedStateVersion: event.expectedStateVersion,
          status: event.status,
          durationSeconds: event.durationSeconds,
          transcript: event.transcript,
        },
      );
      return respond(200, {
        success: true,
        stateVersion: result.stateVersion,
      });
    } catch {
      return respond(409, { success: false, error: "Voice event rejected" });
    }
  }),
});

export default http;
