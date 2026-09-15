import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { sendMetaFreeText } from "./metaDirectSender";

// Internal query to fetch the correct Meta phone_number_id based on the whatsapp number string from the database
export const getMetaPhoneNumberId = internalQuery({
  args: { targetWhatsAppNumber: v.string() },
  handler: async (ctx, args) => {
    const cleanDigits = args.targetWhatsAppNumber.replace(/\D/g, "");
    if (!cleanDigits) return "965783109962872";

    const allNumbers = await ctx.db.query("whatsappNumbers").collect();
    const dbNumber = allNumbers.find(n => n.phone && n.phone.replace(/\D/g, "").slice(-9) === cleanDigits.slice(-9));

    // whatchimpPhoneId stores the Meta phone_number_id
    if (dbNumber && dbNumber.whatchimpPhoneId) {
      return dbNumber.whatchimpPhoneId;
    }

    return "965783109962872";
  }
});

export const isCandidatePhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const candidate = await findCandidateByPhone(ctx, args.phone);
    return candidate;
  },
});

export const hasRecentInboundComm = internalQuery({
  args: {
    candidateId: v.id("candidates"),
    withinMs: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.withinMs;
    const recent = await ctx.db
      .query("communications")
      .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .filter((q: any) => q.and(q.eq(q.field("direction"), "inbound"), q.eq(q.field("channel"), "whatsapp")))
      .first();

    return recent ? Number(recent.sentAt) > cutoff : false;
  },
});

// WhatChimp labels are no longer available after migrating to Meta Cloud API direct.
// This function is kept as a no-op so existing call sites don't break.
export const assignAiFollowUpLabel = internalAction({
  args: {
    candidatePhone: v.string(),
    jobId: v.id("jobs"),
  },
  handler: async (_ctx, args) => {
    console.log(`[Meta Migration] assignAiFollowUpLabel is disabled — Meta Cloud API has no label equivalent. Skipping for ${args.candidatePhone}.`);
  },
});

export const getJobWhatsAppChannel = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobChannels")
      .withIndex("by_job", (q: any) => q.eq("jobId", args.jobId))
      .filter((q: any) => q.eq(q.field("channelType"), "whatsapp"))
      .collect();
  }
});

export const getJobOutboundWhatsAppNumber = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;

    // 1. Prioritize explicit TA Outreach Number configured on the Job
    if (job.outreachWhatsAppNumber) {
      return job.outreachWhatsAppNumber;
    }

    // 2. Fallback to inbound channel configuration for backward compatibility
    const channels = await ctx.db
      .query("jobChannels")
      .withIndex("by_job", (q: any) => q.eq("jobId", args.jobId))
      .filter((q: any) => q.eq(q.field("channelType"), "whatsapp"))
      .collect();

    const activeChannel = channels.find((ch: any) => ch.isEnabled && ch.whatsappNumber);
    return activeChannel ? activeChannel.whatsappNumber : null;
  }
});

async function resolveTestModePhone(ctx: any, senderPhone: string): Promise<string> {
  const systemSettings = await ctx.runQuery(internal.admin.settings.getInternalSystemSettings);
  const isTestMode =
    process.env.WHATSAPP_TEST_MODE === "true" ||
    process.env.OUTREACH_TEST_MODE === "true" ||
    process.env.TEST_MODE === "true" ||
    systemSettings?.testModeEnabled === true;

  const testRecipient =
    process.env.WHATSAPP_TEST_RECIPIENT ||
    process.env.TEST_PHONE_NUMBER ||
    systemSettings?.testPhoneNumber;

  const cleanNum = (p: string) => p.replace(/[^0-9]/g, "");

  if (isTestMode && testRecipient && cleanNum(senderPhone) === cleanNum(testRecipient)) {
    // 1. FIRST check if the test sender phone directly matches a candidate in the DB with an active application
    const directCandidate = await findCandidateByPhone(ctx, senderPhone);
    if (directCandidate) {
      const apps = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q: any) => q.eq("candidateId", directCandidate._id))
        .collect();
      const activeApp = apps.find((a: any) => a.currentStage !== "rejected" && a.currentStage !== "placed");
      if (activeApp) {
        console.log(`[WhatsApp Test Mode] Direct candidate match found for test sender ${senderPhone}: ${directCandidate.fullName} (${directCandidate._id})`);
        return senderPhone;
      }
    }

    // 2. Fallback to lastOutbound only if test sender is not a candidate themselves
    const lastOutbound = await ctx.db
      .query("communications")
      .withIndex("by_direction_channel_time", (q: any) =>
        q.eq("direction", "outbound").eq("channel", "whatsapp")
      )
      .order("desc")
      .first();

    if (lastOutbound) {
      const testCandidate = await ctx.db.get(lastOutbound.candidateId);
      if (testCandidate && testCandidate.phone) {
        console.log(`[WhatsApp Test Mode] Mapped test sender ${senderPhone} to last contacted candidate phone: ${testCandidate.phone}`);
        return testCandidate.phone;
      }
    }
  }
  return senderPhone;
}

export async function findCandidateByPhone(ctx: any, targetPhone: string) {
  const cleanDigits = targetPhone.replace(/\D/g, "");
  if (!cleanDigits) return null;

  // 1. Direct search by exact phone (+digits or exact match)
  let candidate = await ctx.db
    .query("candidates")
    .withIndex("by_phone", (q: any) => q.eq("phone", targetPhone))
    .first();

  if (!candidate && targetPhone !== `+${cleanDigits}`) {
    candidate = await ctx.db
      .query("candidates")
      .withIndex("by_phone", (q: any) => q.eq("phone", `+${cleanDigits}`))
      .first();
  }

  // 2. Search by phoneClean index (exact clean digits)
  if (!candidate) {
    candidate = await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q: any) => q.eq("phoneClean", cleanDigits))
      .first();
  }

  // 3. Alternate format search (convert between Sri Lanka 94... and 0... or vice versa)
  if (!candidate && cleanDigits.startsWith("94") && cleanDigits.length === 11) {
    const localPhone = "0" + cleanDigits.slice(2);
    candidate = await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q: any) => q.eq("phoneClean", localPhone))
      .first();

    if (!candidate) {
      candidate = await ctx.db
        .query("candidates")
        .withIndex("by_phone", (q: any) => q.eq("phone", localPhone))
        .first();
    }
  } else if (!candidate && cleanDigits.startsWith("0") && cleanDigits.length === 10) {
    const intlClean = "94" + cleanDigits.slice(1);
    const intlPhone = "+" + intlClean;
    candidate = await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q: any) => q.eq("phoneClean", intlClean))
      .first();

    if (!candidate) {
      candidate = await ctx.db
        .query("candidates")
        .withIndex("by_phone", (q: any) => q.eq("phone", intlPhone))
        .first();
    }
  }

  // 4. Bounded tail-digits matching (top 200 recent candidates only) to avoid mutation timeouts
  if (!candidate && cleanDigits.length >= 7) {
    const tailDigits = cleanDigits.slice(-9);
    const recentCandidates = await ctx.db.query("candidates").order("desc").take(200);
    candidate = recentCandidates.find((c: any) => {
      if (c.phoneClean && c.phoneClean.length >= 7) {
        return c.phoneClean.endsWith(tailDigits);
      }
      if (c.phone) {
        const cClean = c.phone.replace(/\D/g, "");
        return cClean.length >= 7 && cClean.endsWith(tailDigits);
      }
      return false;
    }) ?? null;
  }

  return candidate;
}

export const sendWhatsApp = internalAction({
  args: {
    communicationId: v.id("communications"),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    // Check communication status & stage guard — DO NOT send automated follow-up if candidate moved out of follow_up stage (e.g. to ta_shortlist)
    const commRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId });
    if (commRecord?.stoppedSequence || commRecord?.deliveryStatus === "failed") {
      console.log(`[WhatsApp Outbound] Communication ${args.communicationId} was cancelled/stopped. Skipping delivery.`);
      return;
    }

    if (commRecord?.applicationId) {
      const appRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getApplicationRecord, { applicationId: commRecord.applicationId });
      if (appRecord && appRecord.currentStage !== "follow_up" && appRecord.currentStage !== "ta_shortlist" && appRecord.currentStage !== "matched_candidates") {
        console.log(`[WhatsApp Outbound] Application ${commRecord.applicationId} is in stage "${appRecord.currentStage}" (not "follow_up", "ta_shortlist", or "matched_candidates"). Aborting WhatsApp follow-up delivery.`);
        await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: `Cancelled: Application is in stage ${appRecord.currentStage}`,
        });
        return;
      }
    }

    // 1. Fetch candidate contact details
    const candidate = await ctx.runQuery(api.candidates.candidates.getCandidate, {
      id: args.candidateId,
    });

    if (!candidate || !candidate.phone) {
      console.error(`[WhatsApp Outbound] Candidate ${args.candidateId} has no phone number or was not found.`);
      await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
        communicationId: args.communicationId,
        status: "failed",
        error: "Candidate has no phone number or was not found",
      });
      return;
    }

    // 2. Resolve destination phone number based on test mode
    const systemSettings = await ctx.runQuery(internal.admin.settings.getInternalSystemSettings);
    const isTestMode =
      process.env.WHATSAPP_TEST_MODE === "true" ||
      process.env.OUTREACH_TEST_MODE === "true" ||
      process.env.TEST_MODE === "true" ||
      systemSettings?.testModeEnabled === true;

    const testRecipient =
      process.env.WHATSAPP_TEST_RECIPIENT ||
      process.env.TEST_PHONE_NUMBER ||
      systemSettings?.testPhoneNumber;

    let targetPhone = candidate.phone;
    let logNote = "";

    const activeInboundSession = await ctx.runQuery(internal.communications.whatsappOutbound.hasRecentInboundComm, {
      candidateId: candidate._id,
      withinMs: 24 * 60 * 60 * 1000,
    });

    if (isTestMode) {
      const candidateDigits = candidate.phone.replace(/\D/g, "");
      const testDigits = testRecipient ? testRecipient.replace(/\D/g, "") : "";

      const isExactOrTailMatch = testDigits && (candidateDigits === testDigits || candidateDigits.endsWith(testDigits.slice(-9)) || testDigits.endsWith(candidateDigits.slice(-9)));

      if (isExactOrTailMatch || activeInboundSession) {
        // Candidate IS the test phone OR candidate actively sent an inbound message in last 24h -> send directly
        targetPhone = candidate.phone;
        logNote = activeInboundSession ? ` [ACTIVE INBOUND SESSION]` : ` [TEST CANDIDATE]`;
      } else if (testRecipient) {
        // Redirect to test recipient number
        targetPhone = testRecipient;
        logNote = ` [REDIRECTED TO TEST NUMBER: ${testRecipient}]`;
      } else {
        // Real candidate, no test recipient configured -> SUPPRESS OUTREACH
        console.warn(`[WhatsApp Outbound] Test mode active: Suppressed outreach to real candidate ${candidate.phone}`);
        await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: "Test mode is active: Automated WhatsApp outreach to real candidates is suppressed during testing phase.",
        });
        return;
      }
    }
    // 3. Send message directly via Meta Cloud API
    try {
      const metaAccessToken = process.env.META_ACCESS_TOKEN;
      if (!metaAccessToken) {
        console.error("[WhatsApp Outbound] META_ACCESS_TOKEN env variable is not set.");
        await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: "META_ACCESS_TOKEN is not configured in environment variables.",
        });
        return;
      }

      // Fetch job's designated outbound TA number (or fallback to default)
      const outboundNumber = await ctx.runQuery(internal.communications.whatsappOutbound.getJobOutboundWhatsAppNumber, { jobId: args.jobId });
      let phoneId = process.env.META_PHONE_NUMBER_ID || "965783109962872";

      if (outboundNumber) {
        const fetchedId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, {
          targetWhatsAppNumber: outboundNumber,
        });
        if (fetchedId) {
          phoneId = fetchedId;
          console.log(`[WhatsApp Outbound] Using TA assigned number: ${outboundNumber} (ID: ${phoneId})`);
        }
      }

      const cleanPhone = targetPhone.replace(/[^0-9]/g, "");
      const isSessionOpen = activeInboundSession;

      if (!isSessionOpen) {
        console.log(`[WhatsApp Outbound] 24h window closed for +${cleanPhone}. Dispatching Meta approved template instead.`);
        // Outside the 24h window, free-text fails — send an approved template to re-open it.
        try {
          await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
            applicationId: commRecord?.applicationId,
            candidateId: args.candidateId,
            jobId: args.jobId,
            communicationId: args.communicationId,
            templateType: "reengagement",
          });
          return;
        } catch (templateErr: any) {
          console.error(`[WhatsApp Outbound] Failed to send re-engagement template:`, templateErr.message);
          await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
            communicationId: args.communicationId,
            status: "failed",
            error: `Failed to dispatch template: ${templateErr.message}`,
          });
          return;
        }
      }

      console.log(`[WhatsApp Outbound] Sending message to +${cleanPhone}${logNote} via Meta Cloud API`);

      const result = await sendMetaFreeText(phoneId, cleanPhone, args.body, metaAccessToken);

      if (result.success) {
        await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
          communicationId: args.communicationId,
          status: "sent",
          error: undefined,
        });
        console.log(`[WhatsApp Outbound] Message successfully sent via Meta Cloud API. Message ID: ${result.messageId}`);

        // No-op: WhatChimp label tagging removed — Meta has no equivalent
        await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.assignAiFollowUpLabel, {
          candidatePhone: targetPhone,
          jobId: args.jobId,
        });
      } else {
        throw new Error(result.error || "Failed to send WhatsApp message via Meta");
      }

    } catch (err: any) {
      console.error("[WhatsApp Outbound] Failed to dispatch via Meta Cloud API:", err.message);
      await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
        communicationId: args.communicationId,
        status: "failed",
        error: err.message,
      });
    }
  },
});

export const updateStatus = internalMutation({
  args: {
    communicationId: v.id("communications"),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("delivered")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.communicationId, {
      deliveryStatus: args.status,
      status: args.status === "failed" ? "failed" : "sent",
      errorMessage: args.error,
    });
  },
});

export const checkAndRecordFollowUpReply = internalMutation({
  args: {
    senderPhone: v.string(),
    textBody: v.string(),
  },
  handler: async (ctx, args) => {
    const targetPhone = await resolveTestModePhone(ctx, args.senderPhone);
    const candidate = await findCandidateByPhone(ctx, targetPhone);

    if (!candidate) {
      console.log(`[checkAndRecordFollowUpReply] No candidate found for phone ${args.senderPhone} (resolved: ${targetPhone}). Skipping.`);
      return { isFollowUpReply: false, candidateId: null, jobId: null };
    }

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate._id))
      .collect();

    // Match inbound reply to the application that sent the candidate their most recent outbound communication
    const recentOutbound = await ctx.db
      .query("communications")
      .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", candidate._id))
      .order("desc")
      .filter((q: any) => q.and(q.eq(q.field("direction"), "outbound"), q.eq(q.field("channel"), "whatsapp")))
      .first();

    let activeApp = recentOutbound?.applicationId
      ? apps.find((a: any) => a._id === recentOutbound.applicationId && a.currentStage !== "rejected" && a.currentStage !== "placed")
      : null;

    if (!activeApp) {
      activeApp = apps.find(
        (a: any) => a.currentStage !== "rejected" && a.currentStage !== "placed"
      );
    }

    console.log(`[checkAndRecordFollowUpReply] Sender: ${args.senderPhone} -> Candidate: ${candidate.fullName} (${candidate._id}). Active stage: ${activeApp?.currentStage || "NONE"}. Text length: ${args.textBody?.length || 0}. Text preview: "${(args.textBody || "").substring(0, 100)}"`);

    if (!activeApp) return { isFollowUpReply: false, candidateId: null, jobId: null };

    // Skip system template echoes (e.g. outbound follow-up template messages echoed back via WhatChimp webhooks)
    if (args.textBody && args.textBody.startsWith("Hi ") && (args.textBody.includes("We've recorded your update") || args.textBody.includes("still waiting on the following"))) {
      console.log(`[checkAndRecordFollowUpReply] ECHO GUARD: Skipping outbound template echo message.`);
      return { isFollowUpReply: false, candidateId: candidate._id, jobId: activeApp.jobId };
    }

    // Inbound Deduplication: check if identical message was received from this candidate in the last 30 seconds to absorb Webhook retries
    const thirtySecAgo = Date.now() - 30 * 1000;
    const recentInbound = await ctx.db
      .query("communications")
      .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", candidate._id))
      .order("desc")
      .filter((q: any) => q.and(q.eq(q.field("direction"), "inbound"), q.eq(q.field("channel"), "whatsapp")))
      .first();

    if (recentInbound && Number(recentInbound.sentAt) > thirtySecAgo && recentInbound.body === args.textBody) {
      console.log(`[checkAndRecordFollowUpReply] DEDUPLICATION: Skipping duplicate retried inbound message "${args.textBody}" from candidate ${candidate._id} within 30 seconds.`);
      return { isFollowUpReply: true, candidateId: candidate._id, jobId: activeApp.jobId };
    }

    // Insert inbound communication
    await ctx.db.insert("communications", {
      candidateId: candidate._id,
      applicationId: activeApp._id,
      jobId: activeApp.jobId,
      direction: "inbound",
      channel: "whatsapp",
      body: args.textBody,
      deliveryStatus: "read",
      sentAt: Date.now(),
      stoppedSequence: false,
    });

    // Update lastCandidateReplyAt on application
    await ctx.db.patch(activeApp._id, {
      lastCandidateReplyAt: Date.now(),
    });

    // ONLY run text extraction if textBody is non-empty (> 2 chars to skip trivial "ok", "hi")
    if (args.textBody && args.textBody.trim().length > 2) {
      // Run text extraction in background to parse details
      await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText, {
        candidateId: candidate._id,
        textBody: args.textBody,
      });
      console.log(`[checkAndRecordFollowUpReply] Dispatched extractDetailsFromText for candidate ${candidate._id} with text: "${args.textBody.substring(0, 100)}"`);
    } else {
      console.warn(`[checkAndRecordFollowUpReply] Skipping AI extraction — text body is empty or trivial: "${args.textBody}"`);
    }

    return { isFollowUpReply: true, candidateId: candidate._id, jobId: activeApp.jobId };
  },
});

export const processLocalWhatsappInbound = internalMutation({
  args: {
    senderPhone: v.string(),
    textBody: v.string(),
  },
  handler: async (ctx, args) => {
    const targetPhone = await resolveTestModePhone(ctx, args.senderPhone);
    const candidate = await findCandidateByPhone(ctx, targetPhone);

    let activeApp = null;
    let job = null;

    if (candidate) {
      // Find active application
      activeApp = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate!._id))
        .filter((q: any) => q.eq(q.field("isActive"), true))
        .first();

      if (!activeApp) {
        // Fallback to any application
        activeApp = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate!._id))
          .first();
      }

      if (activeApp) {
        job = await ctx.db.get(activeApp.jobId);
      }
    }

    // Save inbound communication to the database if candidate exists
    let inboundCommId = null;
    if (candidate) {
      inboundCommId = await ctx.db.insert("communications", {
        candidateId: candidate._id,
        applicationId: activeApp?._id,
        jobId: activeApp?.jobId,
        direction: "inbound",
        channel: "whatsapp",
        body: args.textBody,
        deliveryStatus: "read",
        sentAt: Date.now(),
        stoppedSequence: false,
      });

      if (activeApp) {
        await ctx.db.patch(activeApp._id, {
          lastCandidateReplyAt: Date.now(),
        });
      }
    }

    // Get last 5 messages for chat history context
    let history: any[] = [];
    if (candidate) {
      const messages = await ctx.db
        .query("communications")
        .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", candidate!._id))
        .order("desc")
        .take(6); // take(6) is a terminal method in Convex returning the array

      const previousMessages = inboundCommId
        ? messages.filter((m: any) => m._id !== inboundCommId)
        : messages;

      history = previousMessages
        .slice(0, 5)
        .reverse()
        .map((m: any) => ({
          direction: m.direction,
          body: m.body,
        }));
    }

    return {
      candidate: candidate
        ? {
          _id: candidate._id,
          fullName: candidate.fullName,
          email: candidate.email,
          phone: candidate.phone,
          currentJobTitle: candidate.currentJobTitle,
          skills: candidate.skills,
          summary: candidate.summary,
        }
        : null,
      applicationId: activeApp?._id || null,
      jobId: activeApp?.jobId || null,
      job: job
        ? {
          _id: job._id,
          title: job.title,
          jobDescription: job.jobDescription,
          keyword: job.keyword,
        }
        : null,
      history,
    };
  },
});

export const getCommunicationRecord = internalQuery({
  args: { communicationId: v.id("communications") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.communicationId);
  },
});

export const getApplicationRecord = internalQuery({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.applicationId);
  },
});

export const recordLocalWhatsappOutbound = internalMutation({
  args: {
    candidateId: v.id("candidates"),
    applicationId: v.optional(v.id("applications")),
    jobId: v.optional(v.id("jobs")),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    // Outbound Deduplication: skip if identical outbound message was recorded within last 30s
    const thirtySecAgo = Date.now() - 30000;
    const recentOutbound = await ctx.db
      .query("communications")
      .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .filter((q: any) => q.and(q.eq(q.field("direction"), "outbound"), q.eq(q.field("channel"), "whatsapp")))
      .first();

    if (recentOutbound && Number(recentOutbound.sentAt) > thirtySecAgo && recentOutbound.body === args.body) {
      console.log(`[recordLocalWhatsappOutbound] DEDUPLICATION: Suppressing duplicate outbound communication for candidate ${args.candidateId}.`);
      return null;
    }

    return await ctx.db.insert("communications", {
      candidateId: args.candidateId,
      applicationId: args.applicationId,
      jobId: args.jobId,
      direction: "outbound",
      channel: "whatsapp",
      body: args.body,
      deliveryStatus: "sent",
      sentAt: Date.now(),
      senderAgent: "system",
      stoppedSequence: false,
    });
  },
});

