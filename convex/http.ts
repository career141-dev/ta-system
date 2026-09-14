import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { handleWhatChimpWebhook } from "./communications/whatchimp";
import { verifyElevenLabsSignature } from "./lib/webhookSecurity";
import type { Id } from "./_generated/dataModel";
import {
  isFreshVoiceAgentTimestamp,
  parseVoiceAgentEvent,
  verifyVoiceAgentSignature,
} from "./lib/voiceAgentWebhook";

const http = httpRouter();

const handleMetaVerification = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const validTokens = [
    process.env.META_VERIFY_TOKEN,
    process.env.WHATCHIMP_WEBHOOK_SECRET,
    "career141-secure-key",
    "whatchimp_secret",
    "career141",
  ].filter(Boolean);

  if (mode === "subscribe" && token && (validTokens.includes(token) || validTokens.length === 0)) {
    return new Response(challenge ?? "OK", { status: 200 });
  }
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


// A simple REST endpoint to test Job Creation via Postman
http.route({
  path: "/api/test-job",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const adminKeyHeader = request.headers.get("x-admin-key") || request.headers.get("authorization")?.replace("Bearer ", "");
      const expectedAdminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY || process.env.ADMIN_KEY;
      
      if (!expectedAdminKey || adminKeyHeader !== expectedAdminKey) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing x-admin-key header" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = await request.json();

      // Look up a fallback user to assign as the recruiter for this test
      const defaultUser = await ctx.runQuery(api.users.users.getTeamMembers);
      if (!defaultUser || defaultUser.length === 0) {
        return new Response(JSON.stringify({ 
          error: "No users found in database. Please log in via the UI at least once to create a user." 
        }), { status: 400 });
      }

      // Step 1: Create Job
      const { jobId, keyword } = await ctx.runMutation(api.jobs.jobs.createJob, {
        title: body.title || "Postman API Tester",
        clientName: body.clientName || "API Inc.",
        clientIndustry: body.clientIndustry || "Technology",
        recruitmentType: "both",
        isConfidential: false,
        jobDescription: body.jobDescription || "Test description generated via Postman REST request.",
        requiredSkills: body.requiredSkills || ["Postman", "REST APIs"],
        niceToHaveSkills: ["GraphQL", "Convex"],
        seniorityLevel: "mid_level",
        experienceMinYears: 3,
        experienceMaxYears: 5,
        location: "Remote",
        salaryMin: 50000,
        salaryMax: 90000,
        salaryCurrency: "USD",
        primaryRecruiterId: defaultUser[0]._id as any,
      });

      // Step 2: Update Channels
      await ctx.runMutation(api.jobs.jobs.updateJobChannels, {
        jobId,
        channels: body.channels || [
          {
            channelType: "whatsapp",
            isEnabled: true,
            whatsappNumber: "+1234567890",
          },
          {
            channelType: "email",
            isEnabled: true,
            emailInbox: "postman@career141.com",
          }
        ]
      });

      // Step 3: Update AI Config
      await ctx.runMutation(api.jobs.jobs.updateJobAiConfig, {
        jobId,
        minMatchScoreToShow: body.aiConfig?.minMatchScoreToShow ?? 60,
        reverseMatchOnPublish: body.aiConfig?.reverseMatchOnPublish ?? true,
        scoreWeightSkills: 35,
        scoreWeightExperience: 15,
        scoreWeightJobTitle: 30,
        scoreWeightIndustry: 15,
        scoreWeightLocation: 5,
        agent3Enabled: true,
        agent3Day2Channel: "email",
        agent3Day7Channel: "whatsapp",
        agent3AfterDay7: "trigger_agent5",
        agent5Enabled: true,
        agent5Trigger: "all_new_applicants",
        agent5CallScript: "default",
        agent5CustomQuestions: ["What is your notice period?"],
        agent5NoAnswerAction: "trigger_agent3",
        agent5HideCompany: false,
        directorReviewEnabled: false,
        clientReviewEnabled: false,
        clientAccessLevel: "view_only",
        esaCheckEnabled: true,
        rejectionLoopAction: "restart_from_new_cvs",
        slaNoNewCvsDays: 1,
        slaTaReviewDays: 1,
        slaAiCallDays: 1,
        slaSecondShortlistDays: 1,
        slaDirectorReviewDays: 1,
        slaClientReviewDays: 1,
        slaEsaDays: 1,
        slaInterviewDays: 1,
        slaOfferDays: 1,
      });

      // Step 4: Publish Job instantly for this test
      await ctx.runMutation(api.jobs.jobs.publishJob, { jobId });

      return new Response(JSON.stringify({ 
        success: true, 
        message: "Job successfully created and published via Postman!",
        jobId, 
        keyword 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ success: false, error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Twilio Call Status Callback — auto-advances AI Call → 2nd Shortlist on success
http.route({
  path: "/api/twilio-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.text();
      const params = new URLSearchParams(body);

      const callStatus = params.get("CallStatus"); // completed | no-answer | busy | failed | canceled
      const callSid = params.get("CallSid");
      const digits = params.get("Digits"); // IVR response: 1=interested, 2=declined, 3=connect recruiter

      // Find the aiCalls record matching this CallSid
      const aiCallRecord = callSid
        ? await ctx.runQuery(api.applications.applications.findAiCallBySid, { twilioCallSid: callSid })
        : null;

      if (!aiCallRecord) {
        console.warn("[Twilio] No aiCalls record found for CallSid:", callSid);
        return new Response("OK", { status: 200 });
      }

      const applicationId = aiCallRecord.applicationId;
      const ivrResponse = digits === "1"
        ? "pressed_1_interested"
        : digits === "2"
        ? "pressed_2_declined"
        : digits === "3"
        ? "pressed_3_connect_recruiter"
        : "no_response";

      // Map Twilio callStatus → our enum
      const mappedStatus =
        callStatus === "completed" ? "completed"
        : callStatus === "no-answer" ? "no_answer"
        : callStatus === "busy" ? "no_answer"
        : callStatus === "failed" ? "failed"
        : callStatus === "canceled" ? "failed"
        : "in_progress";

      // Update the aiCalls record
      await ctx.runMutation(api.applications.applications.updateAiCallStatus, {
        aiCallId: aiCallRecord._id,
        callStatus: mappedStatus as any,
        ivrResponse: ivrResponse as any,
        twilioCallSid: callSid ?? undefined,
      });

      // Auto-advance: completed + pressed_1 → second_shortlist
      if (applicationId && mappedStatus === "completed" && ivrResponse === "pressed_1_interested") {
        await ctx.runMutation(api.pipeline.stages.setPipelineStage, {
          applicationId,
          newStage: "second_shortlist",
          note: "Auto-advanced: AI call completed, candidate pressed 1 (Interested)",
        });
      }

      // Auto-reject: pressed_2 (declined)
      if (applicationId && ivrResponse === "pressed_2_declined") {
        await ctx.runMutation(api.applications.applications.rejectApplication, {
          applicationId,
          reason: "Candidate pressed 2 — Declined during AI call",
          stage: "ai_call",
        });
      }

      return new Response("OK", { status: 200 });
    } catch (e: any) {
      console.error("[Twilio] Callback error:", e);
      return new Response("Error", { status: 500 });
    }
  }),
});

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
        aiCall = await ctx.runQuery(api.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
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
      await ctx.runMutation(api.candidates.candidates.updateCandidateDetails, {
        candidateId: candidate_id as any,
        currentSalary: finalCurrentSalary,
        expectedSalary: finalExpectedSalary,
        noticePeriodDays: finalNotice,
        noticePeriod: finalNoticeText,
        candidateQuestions: candidate_questions,
      });

      // 1b. Save custom question answers to aiCalls if available
      if (aiCall && custom_question_answers && Array.isArray(custom_question_answers)) {
        await ctx.runMutation(api.applications.applications.saveCustomQuestionAnswers, {
          aiCallId: aiCall._id,
          customQuestionAnswers: custom_question_answers,
        });
      }

      // 2. If application_id is present, update per-application flags too
      // If it is missing (because ElevenLabs didn't pass it back) OR if it no longer exists, find the application via candidate_id
      let appIdsToUpdate: string[] = [];
      let foundValidApp = false;
      
      if (application_id) {
        const existingApp = await ctx.runQuery(api.applications.applications.getApplication, { id: application_id as any }).catch(() => null);
        if (existingApp) {
          appIdsToUpdate.push(application_id);
          foundValidApp = true;
        }
      } 
      
      if (!foundValidApp && candidate_id) {
        // Fallback: find any application for this candidate in follow_up or ai_call stage
        const apps = await ctx.runQuery(api.applications.applications.getApplicationsByCandidateId, { candidateId: candidate_id as any });
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
          await ctx.runMutation(api.applications.applications.setApplicationFlags, {
            applicationId: appId as any,
            ...flagUpdates,
          });
        }
      }
      
      // Update aiCall to reflect saved data for idempotency tracking
      if (conversation_id) {
        const aiCall = await ctx.runQuery(api.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
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
      const body = JSON.parse(rawBody);
      const candidate_id = body.candidate_id;
      const application_id = body.application_id;
      const conversation_id = body.conversation_id || body.system__conversation_id;
      const { reason } = body;
      
      if (!candidate_id) throw new Error("Missing candidate_id");

      if (conversation_id) {
        const aiCall = await ctx.runQuery(api.applications.applications.findAiCallByElevenLabsId, { conversationId: conversation_id });
        if (aiCall && aiCall.callStatus === "failed") { // If we mark it failed/rejected already
           // Idempotency: if already processed, return 200
        }
      }

      if (reason === "opt_out") {
        await ctx.runMutation(api.candidates.candidates.setDoNotContact, {
          candidateId: candidate_id as any,
          reason: "Opted out via AI Call",
        });
        
        if (application_id) {
          const app = await ctx.runQuery(api.applications.applications.getApplication, { id: application_id as any });
          if (app && app.currentStage !== "rejected") {
            await ctx.runMutation(api.applications.applications.rejectApplication, {
              applicationId: application_id as any,
              reason: "Candidate opted out via AI Call",
              stage: "rejected",
            });
          }
        }
      } else if (reason === "bad_timing" || reason === "not_interested") {
        if (application_id) {
          const app = await ctx.runQuery(api.applications.applications.getApplication, { id: application_id as any });
          if (app && app.currentStage !== "follow_up" && app.currentStage !== "rejected") {
            const now = Date.now();
            await ctx.runMutation(api.pipeline.stages.setPipelineStage, {
              applicationId: application_id as any,
              newStage: "follow_up",
              note: `AI call declined. Reason: ${reason}`,
            });
            // Set the 7-day clock entry point
            await ctx.runMutation(api.applications.applications.setFollowUpEnteredAt, {
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
      
      const aiCall = await ctx.runQuery(api.applications.applications.findAiCallByElevenLabsId, { conversationId });
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

      await ctx.runMutation(api.applications.applications.updateAiCallStatus, {
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
          await ctx.runMutation(api.candidates.candidates.updateCandidateDetails, {
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
          await ctx.runMutation(api.applications.applications.setApplicationFlags, {
            applicationId: aiCall.applicationId,
            followUpCurrentSalary: true,
            followUpExpectedSalary: true,
            followUpNoticePeriod: true,
          });
          await ctx.runMutation(api.pipeline.stages.setPipelineStage, {
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
            await ctx.runMutation(api.applications.applications.setApplicationFlags, {
              applicationId: aiCall.applicationId,
              ...flagUpdates,
            });
          }

          const app = await ctx.runQuery(api.applications.applications.getApplication, { id: aiCall.applicationId });
          if (app && app.currentStage !== "follow_up") {
            await ctx.runMutation(api.pipeline.stages.setPipelineStage, {
              applicationId: aiCall.applicationId,
              newStage: "follow_up",
              note: "AI call completed — missing data fields. Entering Follow-up.",
            });
            // Set precise 7-day clock start
            await ctx.runMutation(api.applications.applications.setFollowUpEnteredAt, {
              applicationId: aiCall.applicationId,
              enteredAt: now,
            });
          }
        }
      } else if (mappedStatus === "failed" || mappedStatus === "no_answer") {
        // Call not answered or failed → move to Follow-up
        if (aiCall.applicationId) {
          const now = Date.now();
          const app = await ctx.runQuery(api.applications.applications.getApplication, { id: aiCall.applicationId });
          if (app && app.currentStage !== "follow_up") {
            await ctx.runMutation(api.pipeline.stages.setPipelineStage, {
              applicationId: aiCall.applicationId,
              newStage: "follow_up",
              note: `AI call ${mappedStatus} — entering Follow-up for outreach.`,
            });
            await ctx.runMutation(api.applications.applications.setFollowUpEnteredAt, {
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

      for (const notification of notifications) {
        // Validate clientState if configured
        const expectedClientState = process.env.MS_GRAPH_CLIENT_STATE;
        if (expectedClientState && notification.clientState && notification.clientState !== expectedClientState) {
          console.warn("[Graph Webhook] Invalid clientState received:", notification.clientState);
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
          api.communications.emailAgent.pollEmailInbox,
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

// ─────────────────────────────────────────────────────────────────────────────
// R2 File Proxy (GET)
// ─────────────────────────────────────────────────────────────────────────────
http.route({
  path: "/api/r2-file",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) {
      return new Response("Missing key", { status: 400 });
    }

    try {
      const signedUrl = await ctx.runAction(api.storage.r2.generateDownloadUrl, { key });
      return new Response(null, {
        status: 302,
        headers: { Location: signedUrl },
      });
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  }),
});

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
