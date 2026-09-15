"use node";

import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";

export const triggerIntakeCall = internalAction({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; conversationId: string }> => {
    // 1. Fetch data for dynamic variables
    const candidate: any = await ctx.runQuery(api.candidates.candidates.getCandidate, { id: args.candidateId });
    const job: any = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: args.jobId });
    
    if (!candidate || !candidate.phone) {
      throw new Error("Candidate has no phone number");
    }

    if (!job) {
      throw new Error("Job not found");
    }

    const agentId = process.env.ELEVENLABS_INTAKE_AGENT_ID;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!agentId || !apiKey) {
      throw new Error("ElevenLabs credentials not configured");
    }

    // Test mode recipient resolution
    const systemSettings = await ctx.runQuery(internal.admin.settings.getInternalSystemSettings);
    const isTestMode = 
      process.env.CALL_TEST_MODE === "true" || 
      process.env.OUTREACH_TEST_MODE === "true" || 
      process.env.TEST_MODE === "true" || 
      systemSettings?.testModeEnabled !== false;

    const testRecipient = 
      process.env.CALL_TEST_RECIPIENT || 
      process.env.WHATSAPP_TEST_RECIPIENT || 
      process.env.TEST_PHONE_NUMBER || 
      systemSettings?.testPhoneNumber;

    let recipientPhone = candidate.phone;
    if (isTestMode) {
      const candidateDigits = candidate.phone.replace(/\D/g, "");
      const testDigits = testRecipient ? testRecipient.replace(/\D/g, "") : "";
      if (testDigits && candidateDigits === testDigits) {
        recipientPhone = candidate.phone;
      } else if (testRecipient) {
        recipientPhone = testRecipient;
      } else {
        console.warn(`[ElevenLabs] Test mode active: Suppressed intake call to real candidate ${candidate.phone}`);
        return { success: false, conversationId: "suppressed_test_mode" };
      }
    }

    // 2. Call ElevenLabs API
    const response = await fetch("https://api.elevenlabs.io/v1/convai/outbound-call", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        recipient_phone_number: recipientPhone,
        dynamic_variables: {
          candidate_name: candidate.fullName || "Candidate",
          job_title: job.title || "the open role",
          company_name: "Career141",
          custom_questions: job.agent5CustomQuestions?.join(", ") || "None",
          candidate_id: args.candidateId,
          job_id: args.jobId,
          application_id: args.applicationId,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ElevenLabs] Failed to trigger call:", errorText);
      throw new Error(`ElevenLabs API error: ${response.status} ${errorText}`);
    }

    const data: any = await response.json();
    const conversationId: string = data.conversation_id;

    // 3. Log the call in our DB
    // We already have a mutation in applications to update this!
    // But we need to make sure we create or update an aiCall.
    // Wait, the UI might have already created an aiCalls record and then called this.
    // Let's just return the conversation ID, and the caller can update the aiCall record.
    return {
      success: true,
      conversationId
    };
  }
});

export const triggerFollowUpCall = internalAction({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    attemptNumber: v.number(),
    lastContactChannel: v.string(),
    aiCallId: v.id("aiCalls"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; conversationId?: string; skipped?: boolean }> => {
    const candidate: any = await ctx.runQuery(api.candidates.candidates.getCandidate, { id: args.candidateId });
    const job: any = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: args.jobId });
    const application: any = await ctx.runQuery(api.applications.applications.getApplication, { id: args.applicationId });
    
    if (!candidate || !candidate.phone) {
      throw new Error("Candidate has no phone number");
    }
    if (!job) {
      throw new Error("Job not found");
    }
    if (!application) {
      throw new Error("Application not found");
    }

    // Determine missing fields
    const missing: string[] = [];
    if (!application.followUpCvReceived && !candidate.cvUploadId) missing.push("CV");
    if (!application.followUpCurrentSalary) missing.push("current salary");
    if (!application.followUpExpectedSalary) missing.push("expected salary");
    if (!application.followUpNoticePeriod) missing.push("notice period");

    if (missing.length === 0) {
      console.log(`Skipping follow-up call for ${args.applicationId}: all fields already captured.`);
      return { success: true, skipped: true };
    }

    const agentId = process.env.ELEVENLABS_FOLLOWUP_AGENT_ID;
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!agentId || !apiKey) {
      console.error("ElevenLabs Follow-Up credentials not configured");
      return { success: false };
    }

    const sipPhoneNumberId = process.env.ELEVENLABS_SIP_PHONE_NUMBER_ID;
    
    if (!sipPhoneNumberId) {
      console.error("ELEVENLABS_SIP_PHONE_NUMBER_ID not configured for SIP trunk calling.");
      return { success: false };
    }

    // Test mode recipient resolution
    const systemSettings = await ctx.runQuery(internal.admin.settings.getInternalSystemSettings);
    const isTestMode = 
      process.env.CALL_TEST_MODE === "true" || 
      process.env.OUTREACH_TEST_MODE === "true" || 
      process.env.TEST_MODE === "true" || 
      systemSettings?.testModeEnabled !== false;

    const testRecipient = 
      process.env.CALL_TEST_RECIPIENT || 
      process.env.WHATSAPP_TEST_RECIPIENT || 
      process.env.TEST_PHONE_NUMBER || 
      systemSettings?.testPhoneNumber;

    let targetPhone = candidate.phone;
    if (isTestMode) {
      const candidateDigits = candidate.phone.replace(/\D/g, "");
      const testDigits = testRecipient ? testRecipient.replace(/\D/g, "") : "";
      if (testDigits && candidateDigits === testDigits) {
        targetPhone = candidate.phone;
      } else if (testRecipient) {
        targetPhone = testRecipient;
      } else {
        console.warn(`[ElevenLabs] Test mode active: Suppressed follow-up call to real candidate ${candidate.phone}`);
        return { success: false, skipped: true };
      }
    }

    const response = await fetch("https://api.elevenlabs.io/v1/convai/conversation/outbound-call", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: sipPhoneNumberId,
        to_number: targetPhone,
        conversation_initiation_client_data: {
          dynamic_variables: {
            candidate_name: candidate.fullName ? candidate.fullName.split(' ')[0] : "Candidate",
            job_title: job.title || "the open role",
            company_name: "Career141",
            missing_fields_list: missing.join(", "),
            custom_questions: job.agent5CustomQuestions?.join(", ") || "",
            company_hidden: job.agent5HideCompany ? "true" : "false",
            attempt_number: String(args.attemptNumber),
            last_contact_channel: args.lastContactChannel,
            candidate_id: args.candidateId,
            job_id: args.jobId,
            application_id: args.applicationId,
          }
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ElevenLabs] Failed to trigger follow-up call:", errorText);
      
      // ROLLBACK: Call failed to place (e.g. ElevenLabs down)
      await ctx.runMutation(api.applications.applications.updateAiCallStatus, { 
        aiCallId: args.aiCallId, 
        callStatus: "failed" 
      });
      await ctx.runMutation(api.applications.applications.rollbackFollowUpState, { 
        applicationId: args.applicationId 
      });

      return { success: false };
    }

    const data: any = await response.json();
    
    // SUCCESS: Save the conversation ID so webhooks can find it!
    await ctx.runMutation(api.applications.applications.updateAiCallStatus, {
      aiCallId: args.aiCallId,
      callStatus: "scheduled",
      elevenLabsConversationId: data.conversation_id
    });

    return {
      success: true,
      conversationId: data.conversation_id
    };
  }
});
