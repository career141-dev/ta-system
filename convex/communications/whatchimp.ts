import { httpAction, mutation, query, action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import { getOpenAI, getModelForTask } from "../lib/llm";
import { sendMetaFreeText } from "./metaDirectSender";
import { classifyMessage } from "./messageClassifier";
import { findCandidateByPhone } from "./whatsappOutbound";

export function matchJobFromText(jobs: any[], textBody: string): { matchedJob: any | null; matchedKeyword: string; isAmbiguous: boolean } {
  const trimmed = textBody.trim();
  const upperText = trimmed.toUpperCase();
  const strippedUpper = upperText
    .replace(/^(HI|HELLO|HEY)[!.,]?\s+/i, "")
    .replace(/^I('D| WOULD)? LIKE TO APPLY (FOR|TO)\s+/i, "")
    .replace(/^JOB CODE\s*:\s*/i, "")
    .replace(/^APPLY\s+/i, "")
    .trim();

  if (!strippedUpper) return { matchedJob: null, matchedKeyword: "", isAmbiguous: false };

  // Guard against detail replies, numbers, conversational questions, or multi-line messages
  const isConversationalOrDetail =
    trimmed.length > 50 ||
    trimmed.includes("\n") ||
    /\d{3,}/.test(trimmed) || // contains numbers like 120000, 150000, etc.
    /\b(salary|salery|expected|expect|notice|period|portfolio|skills|showreel|drive|link|resume|cv|month|week|lkr|usd|k)\b/i.test(trimmed) ||
    trimmed.includes("?");

  const isExplicitApply = /^(APPLY\s+|JOB CODE\s*:\s*|I('D| WOULD)? LIKE TO APPLY)/i.test(trimmed);

  interface CandidateMatch {
    job: any;
    matchedKeyword: string;
    matchType: "exact" | "prefix" | "substring";
    matchedLength: number;
  }

  const matches: CandidateMatch[] = [];

  for (const job of jobs) {
    const kUpper = (job.keyword || "").trim().toUpperCase();
    const tUpper = (job.title || "").trim().toUpperCase();

    // 1. Check Keyword
    if (kUpper.length >= 2) {
      if (strippedUpper === kUpper) {
        matches.push({ job, matchedKeyword: job.keyword, matchType: "exact", matchedLength: kUpper.length });
      } else if (isExplicitApply && (upperText.startsWith(kUpper) || strippedUpper.startsWith(kUpper))) {
        matches.push({ job, matchedKeyword: job.keyword, matchType: "prefix", matchedLength: kUpper.length });
      } else if (!isConversationalOrDetail && kUpper.length >= 4 && new RegExp(`\\b${kUpper}\\b`, "i").test(strippedUpper)) {
        // Whole word match only for 4+ char keywords when not conversational/detail
        matches.push({ job, matchedKeyword: job.keyword, matchType: "substring", matchedLength: kUpper.length });
      }
    }

    // 2. Check Title
    if (tUpper.length >= 3) {
      if (strippedUpper === tUpper) {
        matches.push({ job, matchedKeyword: job.title, matchType: "exact", matchedLength: tUpper.length });
      } else if (isExplicitApply && (upperText.startsWith(tUpper) || strippedUpper.startsWith(tUpper))) {
        matches.push({ job, matchedKeyword: job.title, matchType: "prefix", matchedLength: tUpper.length });
      } else if (!isConversationalOrDetail && tUpper.length >= 5 && new RegExp(`\\b${tUpper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i").test(strippedUpper)) {
        // Whole title word match
        matches.push({ job, matchedKeyword: job.title, matchType: "substring", matchedLength: tUpper.length });
      }
    }
  }

  if (matches.length === 0) {
    return { matchedJob: null, matchedKeyword: "", isAmbiguous: false };
  }

  const matchTypeScore = { exact: 3, prefix: 2, substring: 1 };
  matches.sort((a, b) => {
    const typeDiff = matchTypeScore[b.matchType] - matchTypeScore[a.matchType];
    if (typeDiff !== 0) return typeDiff;
    return b.matchedLength - a.matchedLength;
  });

  const bestMatch = matches[0];
  return { matchedJob: bestMatch.job, matchedKeyword: bestMatch.matchedKeyword, isAmbiguous: false };
}


export const handleWhatChimpWebhook = httpAction(async (ctx, request) => {
  const bodyText = await request.text();
  console.log("[WhatChimp Webhook] Raw body received (first 500 chars):", bodyText.substring(0, 500));

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch (err: any) {
    console.error("[WhatChimp Webhook] Failed to parse JSON:", err.message);
    return new Response("Invalid JSON", { status: 400 });
  }

  const webhookSecret = process.env.WHATCHIMP_WEBHOOK_SECRET;
  const isStandardMetaPayload = Boolean(body?.entry && body?.entry[0]?.changes);

  if (webhookSecret && !isStandardMetaPayload) {
    const receivedSecret = request.headers.get("x-whatchimp-secret") || request.headers.get("x-webhook-secret") || new URL(request.url).searchParams.get("secret");
    if (receivedSecret !== webhookSecret) {
      console.warn("[WhatChimp Webhook] Unauthorized request missing valid secret.");
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const configuredPhone = process.env.WHATCHIMP_PHONE_NUMBER_ID || "";
  const cleanConfigured = configuredPhone.replace(/[^0-9]/g, "");
  const businessPhone = cleanConfigured;

  // 0. Early return for Meta status-only webhooks (delivery receipts, read receipts)
  // These have entry[0].changes[0].value.statuses but NO .messages — they contain zero text
  if (body.entry && body.entry[0]?.changes && body.entry[0].changes[0]?.value?.statuses && !body.entry[0].changes[0]?.value?.messages) {
    const statusObj = body.entry[0].changes[0].value.statuses[0];
    console.log("[Meta Status Webhook] Status update received:", JSON.stringify(statusObj));
    if (statusObj?.errors) {
      console.error("[Meta Status Webhook ERROR]:", JSON.stringify(statusObj.errors));
    }
    return new Response("OK", { status: 200 });
  }

  // 1. Check if it's a standard Meta WhatsApp Webhook payload
  if (body.entry && body.entry[0]?.changes && body.entry[0].changes[0]?.value?.messages) {
    console.log("[WhatChimp Webhook] Auto-detected standard Meta payload format.");
    const value = body.entry[0].changes[0].value;
    const toNumber = value.metadata?.display_phone_number || "WhatChimp Number";

    for (const message of value.messages) {
      const fromNumber = message.from;
      const cleanFromNumber = fromNumber.replace(/[^0-9]/g, "");

      const isCandidateReply = await ctx.runQuery(internal.communications.whatsappOutbound.isCandidatePhone, { phone: cleanFromNumber });
      const isTaNumber = await ctx.runQuery(internal.settings.whatsappNumbers.isTaNumber, { phone: cleanFromNumber });

      if (!isCandidateReply && (cleanFromNumber === businessPhone || (cleanConfigured && cleanFromNumber === cleanConfigured) || isTaNumber)) {
        console.log("[WhatChimp Webhook] Ignoring Meta message from business/TA number itself.");
        continue;
      }

      if (message.type === "document" || message.type === "image") {
        const originalSenderPhone = message.context?.from ?? message.from;
        const mediaItem = message.document ?? message.image;
        const captionText = mediaItem.caption ?? message.document?.caption ?? message.image?.caption ?? null;

        console.log(`[WhatChimp Webhook] Inbound media detected: ID=${mediaItem.id}, Type=${message.type}, Caption="${captionText ?? ""}"`);
        await ctx.scheduler.runAfter(0, internal.cvs.ingestion.processInboundCV, {
          messageId: message.id,
          toNumber,
          fromNumber,
          originalSenderPhone,
          mediaId: mediaItem.id,
          mimeType: mediaItem.mime_type,
          fileName: mediaItem.filename ?? null,
          captionText,
        });
      } else if (message.type === "text") {
        const textBody = message.text?.body || message.body || message.text || "";
        const cleanSender = cleanFromNumber;
        console.log(`[WhatChimp Webhook] Meta text message from +${cleanSender}: "${String(textBody).substring(0, 200)}" (type=${message.type}, has text.body=${!!message.text?.body})`);

        // 1. Check if sender has active application first (follow-up reply / missing details)
        const checkResult = await ctx.runMutation(internal.communications.whatsappOutbound.checkAndRecordFollowUpReply, {
          senderPhone: cleanSender,
          textBody,
        });

        if (checkResult?.isFollowUpReply) {
          console.log(`[WhatChimp Webhook] Recorded follow-up reply from candidate +${cleanSender}`);
          continue;
        }

        // 2. Check for Keyword / Title Match
        const activeJobs = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo);
        const { matchedJob, matchedKeyword } = matchJobFromText(activeJobs, textBody);

        let isKeyword = false;
        if (matchedJob && matchedJob.status === "active") {
          isKeyword = true;
          console.log(`[WhatChimp Webhook] Received Meta keyword "${matchedKeyword}" from +${cleanSender} for job ${matchedJob.title}`);
          
          // Create/Update Session
          await ctx.runMutation(api.communications.whatchimp.upsertSession, {
            phone: cleanSender,
            jobId: matchedJob._id,
            keyword: matchedKeyword,
            metaSourceUrl: message.referral?.source_url,
            metaSourceId: message.referral?.source_id,
            metaHeadline: message.referral?.headline,
          });

          const fetchedPhoneId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, { 
            targetWhatsAppNumber: toNumber 
          });
          const phoneNumberId = fetchedPhoneId || process.env.META_PHONE_NUMBER_ID || "965783109962872";

          const fullJob = await ctx.runQuery(api.jobs.jobs.getJob, { jobId: matchedJob._id });

          if (phoneNumberId && !fullJob?.muteDefaultWhatsappReply) {
            const replyMessage = `Thank you for your interest in the ${matchedJob.title} position.\n\nPlease upload your latest CV to continue your application.`;
            const metaAccessToken = process.env.META_ACCESS_TOKEN || "";
            await sendMetaFreeText(phoneNumberId, cleanSender, replyMessage, metaAccessToken)
              .then(r => { if (!r.success) console.error("[WhatsApp Webhook] Keyword reply failed:", r.error); })
              .catch(console.error);
          } else if (fullJob?.muteDefaultWhatsappReply) {
            console.log(`[WhatChimp Webhook] Skipped default reply for ${matchedKeyword} because muteDefaultWhatsappReply is true`);
          }
        }

        if (!isKeyword) {
          const session = await ctx.runQuery(api.communications.whatchimp.getSessionByPhone, { phone: cleanSender });
          if (session) {
            console.log(`[WhatChimp Webhook] Pre-application chat detected for +${cleanSender}. Dispatching LLM handler.`);
            await ctx.scheduler.runAfter(0, internal.communications.whatchimp.handlePreApplicationChat, {
              phone: cleanSender,
              textBody,
              jobId: session.jobId,
            });
          }
        }
      }
    }
    return new Response("OK", { status: 200 });
  }

  // 2. Check if it's a flat custom WhatChimp payload format
  const payload = (typeof body.data === "object" && body.data !== null) ? body.data :
                  (typeof body.payload === "object" && body.payload !== null) ? body.payload : body;

  // 1.5 Check for WhatChimp-specific status/echo/outgoing webhooks that should not be processed as candidate inbound
  const isAgentOutbound = !!(payload.agent_name || payload.agent_id || body.agent_name || body.agent_id);
  if (isAgentOutbound) {
    console.log(`[WhatChimp Webhook] Ignoring WhatChimp outbound agent/bot event`);
    return new Response("OK", { status: 200 });
  }

  const wcEventType = String(body.webhook_type || body.event_type || body.event || body.type || body.action || payload?.webhook_type || payload?.event_type || "").toLowerCase();
  if (wcEventType && ["outgoing_message", "outgoing", "sent_message", "message_status", "status_update", "delivery", "read", "sent", "delivered", "failed", "typing", "presence"].includes(wcEventType)) {
    console.log(`[WhatChimp Webhook] Ignoring WhatChimp outgoing/status event type: ${wcEventType}`);
    return new Response("OK", { status: 200 });
  }

  const extractMessageText = (msg: any): string | undefined => {
    if (typeof msg === "string") return msg;
    if (typeof msg === "object" && msg !== null) {
      if (typeof msg.text === "string") return msg.text;
      if (typeof msg.caption === "string") return msg.caption;
      if (typeof msg.body === "string") return msg.body;
      if (typeof msg.message === "string") return msg.message;
      if (typeof msg.content === "string") return msg.content;
      if (typeof msg.message_text === "string") return msg.message_text;
      if (typeof msg.text_body === "string") return msg.text_body;
    }
    return undefined;
  };

  const extractMediaUrl = (msg: any) => {
    if (typeof msg === "object" && msg !== null) {
      if (typeof msg.url === "string") return msg.url;
      if (typeof msg.media_url === "string") return msg.media_url;
      if (typeof msg.file_url === "string") return msg.file_url;
      if (typeof msg.link === "string") return msg.link;
    }
    return undefined;
  };

  const from = payload.chat_id || payload.from || payload.phone || payload.sender || payload.phone_number || payload.mobile || 
               (payload.subscriber_id && typeof payload.subscriber_id === "string" && payload.subscriber_id.split("-")[0]) || payload.subscriber_id ||
               body.chat_id || body.from || body.phone || body.sender || body.phone_number || body.mobile ||
               (body.subscriber_id && typeof body.subscriber_id === "string" && body.subscriber_id.split("-")[0]) || body.subscriber_id;
  
  let text = extractMessageText(payload.user_message) || 
             extractMessageText(payload.message) || 
             extractMessageText(payload.body) || 
             extractMessageText(payload.text) || 
             extractMessageText(payload.content) || 
             extractMessageText(payload.message_text) || 
             extractMessageText(payload.text_body) || 
             extractMessageText(payload.data?.message) || 
             extractMessageText(payload.data?.text) || 
             extractMessageText(body.user_message) || 
             extractMessageText(body.message) || 
             extractMessageText(body.body) || 
             extractMessageText(body.text) || 
             extractMessageText(body.content) || 
             extractMessageText(body.message_text) || "";
  if (typeof text !== "string") {
    text = "";
  }

  const mediaUrl = extractMediaUrl(payload.user_message) || extractMediaUrl(payload.message) || extractMediaUrl(payload.body) || payload.media_url || payload.file_url || payload.mediaUrl || payload.fileUrl ||
                   extractMediaUrl(body.user_message) || extractMediaUrl(body.message) || extractMediaUrl(body.body) || body.media_url || body.file_url || body.mediaUrl || body.fileUrl;
  const fileName = payload.filename || payload.fileName || body.filename || body.fileName || (mediaUrl ? mediaUrl.split("/").pop() : "cv.pdf") || "cv.pdf";
  const mimeType = payload.mime_type || payload.mimeType || body.mime_type || body.mimeType || "application/pdf";
  const to = payload.to || payload.receiver || payload.whatsapp_bot_username || payload.display_phone_number || body.to || body.receiver || body.whatsapp_bot_username || body.display_phone_number || "WhatChimp Number";

  if (!from) {
    console.warn("[WhatChimp Webhook] No sender identifier found in payload.");
    return new Response("Sender not found", { status: 400 });
  }

  const cleanFrom = String(from).replace(/[^0-9]/g, "");
  const cleanTo = String(to).replace(/[^0-9]/g, "");

  console.log(`[WhatChimp Webhook] Flat payload parsed: From=+${cleanFrom}, Text="${text?.substring(0, 200)}", TextLength=${text?.length || 0}, Has Media=${!!mediaUrl}`);

  // GUARD: If there's no text, no media, and no sender — this is a status/echo webhook, skip it
  if (!text && !mediaUrl) {
    console.log(`[WhatChimp Webhook] No text and no media from +${cleanFrom}. Likely a status/echo webhook. Skipping.`);
    return new Response("OK", { status: 200 });
  }

  // Non-media text message processing (Keywords, Pre-App Questions, Follow-up Replies)
  if (!mediaUrl && text) {
    const evalResult = await ctx.runMutation(internal.communications.whatchimp.processInboundTextWebhook, {
      cleanFrom,
      cleanTo,
      text,
    });

    if (evalResult.action === "send_keyword_reply") {
      if (!evalResult.muteDefaultReply) {
        const fetchedPhoneId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, { 
          targetWhatsAppNumber: cleanTo 
        });
        const phoneNumberId = fetchedPhoneId || process.env.META_PHONE_NUMBER_ID || "965783109962872";
        const replyMessage = `Thank you for your interest in the ${evalResult.jobTitle} position.\n\nPlease upload your latest CV to continue your application.`;
        const metaAccessToken = process.env.META_ACCESS_TOKEN || "";
        await sendMetaFreeText(phoneNumberId, cleanFrom, replyMessage, metaAccessToken)
          .then(r => { if (!r.success) console.error("[WhatsApp Webhook] Keyword reply failed:", r.error); })
          .catch(console.error);
      }
      return new Response("OK", { status: 200 });
    }

    if (evalResult.action === "dispatch_pre_app_chat") {
      console.log(`[WhatChimp Webhook] Pre-application chat detected for +${cleanFrom}. Dispatching LLM handler.`);
      await ctx.scheduler.runAfter(0, internal.communications.whatchimp.handlePreApplicationChat, {
        phone: cleanFrom,
        textBody: text,
        jobId: evalResult.jobId as any,
      });
      return new Response("OK", { status: 200 });
    }

    if (evalResult.action === "follow_up_handled") {
      console.log(`[WhatChimp Webhook] Follow-up reply processed for candidate +${cleanFrom}`);
      return new Response("OK", { status: 200 });
    }

    if (evalResult.action === "send_job_prompt") {
      console.log(`[WhatChimp Webhook] No keyword and no session for +${cleanFrom}. Sending context-aware prompt.`);
      const fetchedPhoneId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, { 
        targetWhatsAppNumber: cleanTo 
      });
      const phoneNumberId = fetchedPhoneId || process.env.META_PHONE_NUMBER_ID || "965783109962872";
      const replyMessage = evalResult.hasCv
        ? `Hello! Thank you for reaching out to Career141.\n\nWe have your CV on file. Could you please let us know how we can assist you with your application?`
        : `Hello! Thank you for reaching out to Career141.\n\nWhich position are you interested in applying for? Please reply with the job title or keyword (e.g., Graphic Designer, Video Editor) or upload your CV as a PDF to apply!`;
      const metaAccessToken = process.env.META_ACCESS_TOKEN || "";
      await sendMetaFreeText(phoneNumberId, cleanFrom, replyMessage, metaAccessToken)
        .then(r => { if (!r.success) console.error("[WhatsApp Webhook] Job prompt reply failed:", r.error); })
        .catch(console.error);
      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  }

  // ── Classify and handle incoming media / text with URLs ────────────────────
  if (mediaUrl) {
    const classification = classifyMessage(text || "", mediaUrl, mimeType, fileName);
    console.log(`[WhatChimp Webhook] Message classified as: ${classification.type} from +${cleanFrom}`);

    if (classification.type === "cv_document") {
      // Real CV (PDF/DOCX) — dispatch to Node worker for R2 upload + ingestion
      console.log(`[WhatChimp Webhook] CV document from +${cleanFrom}. Dispatching to Node worker.`);
      await ctx.scheduler.runAfter(0, internal.communications.whatchimpActions.processInboundMedia, {
        mediaUrl,
        fileName: fileName ?? "cv.pdf",
        mimeType: mimeType || "application/pdf",
        cleanFrom,
        cleanTo,
        text: text || "",
      });
      return new Response("OK", { status: 200 });
    }

    // Non-CV media (image, sticker, audio, video) — ignore silently
    console.log(`[WhatChimp Webhook] Ignoring non-CV media (${classification.type}): ${fileName}`);
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
});

export const processInboundTextWebhook = internalMutation({
  args: {
    cleanFrom: v.string(),
    cleanTo: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const { cleanFrom, cleanTo, text } = args;

    // 1. Check for Active Candidate Follow-Up Reply using normalized phone lookup
    const candidate = await findCandidateByPhone(ctx, cleanFrom);

    if (candidate) {
      const apps = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate._id))
        .collect();

      const activeApp = apps.find(
        (a: any) => a.currentStage !== "rejected" && a.currentStage !== "placed"
      );

      if (activeApp) {
        // Deduplication check (30 seconds)
        const thirtySecAgo = Date.now() - 30 * 1000;
        const recentInbound = await ctx.db
          .query("communications")
          .withIndex("by_candidate_time", (q: any) => q.eq("candidateId", candidate._id))
          .order("desc")
          .filter((q: any) => q.and(q.eq(q.field("direction"), "inbound"), q.eq(q.field("channel"), "whatsapp")))
          .first();

        if (!recentInbound || Number(recentInbound.sentAt) <= thirtySecAgo || recentInbound.body !== text) {
          await ctx.db.insert("communications", {
            candidateId: candidate._id,
            applicationId: activeApp._id,
            jobId: activeApp.jobId,
            direction: "inbound",
            channel: "whatsapp",
            body: text,
            deliveryStatus: "read",
            sentAt: Date.now(),
            stoppedSequence: false,
          });

          await ctx.db.patch(activeApp._id, {
            lastCandidateReplyAt: Date.now(),
          });

          // Check if message contains URLs (e.g. portfolio, drive, youtube)
          const urlClassification = classifyMessage(text);
          if (urlClassification.detectedUrl) {
            const existingSession = await ctx.db
              .query("whatsappSessions")
              .withIndex("by_phone", (q: any) => q.eq("phone", cleanFrom))
              .first();
            if (existingSession) {
              const existingUrls = existingSession.portfolioUrls || [];
              if (!existingUrls.includes(urlClassification.detectedUrl)) {
                await ctx.db.patch(existingSession._id, {
                  portfolioUrls: [...existingUrls, urlClassification.detectedUrl],
                  lastInteractionAt: Date.now(),
                });
              }
            }
          }

          if (text.trim().length > 2) {
            await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText, {
              candidateId: candidate._id,
              textBody: text,
            });
          }
        }

        // Ensure session exists and knows CV is received
        let activeSession = await ctx.db
          .query("whatsappSessions")
          .withIndex("by_phone", (q: any) => q.eq("phone", cleanFrom))
          .first();

        if (activeSession) {
          await ctx.db.patch(activeSession._id, {
            jobId: activeApp.jobId,
            cvReceived: true,
            lastInteractionAt: Date.now(),
          });
        } else {
          await ctx.db.insert("whatsappSessions", {
            phone: cleanFrom,
            jobId: activeApp.jobId,
            keyword: "AUTO_ACTIVE",
            cvReceived: true,
            lastInteractionAt: Date.now(),
          });
        }

        return { action: "follow_up_handled", jobId: activeApp.jobId };
      }
    }

    // 2. Fetch active & paused jobs directly from DB for Keyword / Title Match
    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .collect();
    const pausedJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q: any) => q.eq("status", "on_hold"))
      .collect();
    const allJobs = [...activeJobs, ...pausedJobs];

    const { matchedJob, matchedKeyword } = matchJobFromText(allJobs, text);

    if (matchedJob) {
      const existingSession = await ctx.db
        .query("whatsappSessions")
        .withIndex("by_phone", (q: any) => q.eq("phone", cleanFrom))
        .first();

      if (existingSession) {
        await ctx.db.patch(existingSession._id, {
          jobId: matchedJob._id,
          keyword: matchedKeyword,
          lastInteractionAt: Date.now(),
        });
      } else {
        await ctx.db.insert("whatsappSessions", {
          phone: cleanFrom,
          jobId: matchedJob._id,
          keyword: matchedKeyword,
          lastInteractionAt: Date.now(),
        });
      }

      if (candidate) {
        const apps = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidate._id))
          .collect();

        const alreadyInJob = apps.some((a: any) => a.jobId === matchedJob._id);
        if (!alreadyInJob) {
          const now = Date.now();
          await ctx.db.insert("applications", {
            candidateId: candidate._id,
            jobId: matchedJob._id,
            currentStage: "new_cvs",
            sourceChannel: "whatsapp",
            createdAt: now,
            isActive: true,
            lastStageChangedAt: now,
            loopIteration: 0,
            stageHistory: [{
              stage: "new_cvs",
              enteredAt: new Date(now).toISOString(),
              changedBy: "system",
            }],
          });
          console.log(`[processInboundTextWebhook] Auto-linked candidate ${candidate.fullName} (+${cleanFrom}) to job ${matchedJob.title} in new_cvs!`);
        }
      }

      return {
        action: "send_keyword_reply",
        jobTitle: matchedJob.title as string,
        muteDefaultReply: matchedJob.muteDefaultWhatsappReply === true,
      };
    }

    // 3. Pre-App Chat Session (if session exists for candidate)
    let session = await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q: any) => q.eq("phone", cleanFrom))
      .first();

    if (session) {
      const job = await ctx.db.get(session.jobId);
      if (job && !job.muteDefaultWhatsappReply) {
        return { action: "dispatch_pre_app_chat", jobId: job._id };
      }
    }

    // 4. Fallback: Prompt candidate for job title (with CV awareness)
    const hasCv = !!(candidate?.cvUploadId || session?.cvReceived);
    return { action: "send_job_prompt", hasCv };
  },
});

export const getSessionByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
  },
});

export const upsertSession = mutation({
  args: {
    phone: v.string(),
    jobId: v.id("jobs"),
    keyword: v.string(),
    metaSourceUrl: v.optional(v.string()),
    metaSourceId: v.optional(v.string()),
    metaHeadline: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        jobId: args.jobId,
        keyword: args.keyword,
        lastInteractionAt: now,
        metaSourceUrl: args.metaSourceUrl ?? existing.metaSourceUrl,
        metaSourceId: args.metaSourceId ?? existing.metaSourceId,
        metaHeadline: args.metaHeadline ?? existing.metaHeadline,
      });
      return existing._id;
    } else {
      return await ctx.db.insert("whatsappSessions", {
        phone: args.phone,
        jobId: args.jobId,
        keyword: args.keyword,
        lastInteractionAt: now,
        metaSourceUrl: args.metaSourceUrl,
        metaSourceId: args.metaSourceId,
        metaHeadline: args.metaHeadline,
      });
    }
  },
});

export const deleteSession = mutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Updates the chatbot conversation state on an active session.
 * Called after a real CV is ingested, a portfolio URL is received,
 * or an employment preference is detected.
 */
export const updateSessionState = mutation({
  args: {
    phone: v.string(),
    cvReceived: v.optional(v.boolean()),
    portfolioUrl: v.optional(v.string()),
    employmentPreference: v.optional(v.string()),
    lastBotReplyAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    if (!session) return;

    const patch: Record<string, any> = {};
    if (args.cvReceived !== undefined) patch.cvReceived = args.cvReceived;
    if (args.portfolioUrl) {
      const existing = session.portfolioUrls || [];
      if (!existing.includes(args.portfolioUrl)) {
        patch.portfolioUrls = [...existing, args.portfolioUrl];
      }
    }
    if (args.employmentPreference) patch.employmentPreference = args.employmentPreference;
    if (args.lastBotReplyAt !== undefined) patch.lastBotReplyAt = args.lastBotReplyAt;
    patch.lastInteractionAt = Date.now();

    await ctx.db.patch(session._id, patch);
  },
});

export const getConfiguredNumbers = action({
  args: {},
  handler: async (ctx) => {
    const apiToken = process.env.WHATCHIMP_API_TOKEN;
    if (!apiToken) {
      console.warn("[WhatChimp] No WHATCHIMP_API_TOKEN configured");
      return [];
    }
    
    try {
      // Pass apiToken as a query parameter for the GET request
      const response = await fetch(`https://app.whatchimp.com/api/v1/whatsapp/numbers?apiToken=${encodeURIComponent(apiToken)}`);
      if (!response.ok) {
        console.error("[WhatChimp] Failed to fetch numbers, status:", response.status);
        return [];
      }
      
      const data = await response.json();
      // Assuming the response is an array of number objects like [{ number: "94770000001", id: "123" }, ...]
      // or { data: [...] }
      const numbersList = Array.isArray(data) ? data : (data.data || []);
      
      // Extract just the phone strings, cleaning them up
      return numbersList
        .map((n: any) => n.phone_number || n.number || n.phone || n.display_phone_number || typeof n === 'string' ? n : null)
        .filter(Boolean)
        .map((n: string) => "+" + n.replace(/[^0-9]/g, ""));
    } catch (err: any) {
      console.error("[WhatChimp] Error fetching numbers:", err.message);
      return [];
    }
  },
});

export const testFetchWhatChimp = action({
  args: {},
  handler: async (ctx) => {
    const apiToken = process.env.WHATCHIMP_API_TOKEN;
    if (!apiToken) return { error: "No API token" };
    try {
      const response = await fetch(`https://app.whatchimp.com/api/v1/whatsapp/numbers?apiToken=${encodeURIComponent(apiToken)}`);
      const text = await response.text();
      return { status: response.status, body: text };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

export const handlePreApplicationChat = internalAction({
  args: {
    phone: v.string(),
    textBody: v.string(),
    // jobId is optional here — we resolve from session if null
    jobId: v.optional(v.id("jobs")),
    // Set by the flat-payload URL handler when a portfolio/video link is detected
    urlType: v.optional(v.string()),
    detectedUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      // ── 1. Resolve job from session if not provided directly ───────────────
      let jobId = args.jobId;
      const session = await ctx.runQuery(api.communications.whatchimp.getSessionByPhone, { phone: args.phone });
      if (!jobId && session) jobId = session.jobId;
      if (!jobId) {
        console.log(`[PreApp Chat] No job resolved for +${args.phone}. Skipping.`);
        return;
      }

      const job = await ctx.runQuery(api.jobs.jobs.getJob, { jobId });
      if (!job) return;

      // ── 2. Dedup guard — prevent double replies within 8 seconds ──────────
      const lastReplyAt = session?.lastBotReplyAt ?? 0;
      if (Date.now() - lastReplyAt < 8_000) {
        console.log(`[PreApp Chat] Dedup guard: reply sent ${Date.now() - lastReplyAt}ms ago. Skipping duplicate for +${args.phone}.`);
        return;
      }

      // Fetch candidate document for CV status & conversation history
      const candidate = await ctx.runQuery(internal.communications.whatchimp.getCandidateByPhone, { phone: args.phone });
      const cvReceived = session?.cvReceived === true || !!candidate?.cvUploadId;
      const portfolioUrls = session?.portfolioUrls || [];
      const employmentPreference = session?.employmentPreference || null;

      let conversationHistory = "No previous messages.";
      if (candidate) {
        const recentMessages = await ctx.runQuery(internal.communications.whatchimp.getRecentMessages, {
          candidateId: candidate._id,
          limit: 5,
        });
        if (recentMessages.length > 0) {
          conversationHistory = recentMessages
            .map((m: any) => `${m.direction === "inbound" ? "Candidate" : "Bot"}: ${m.body}`)
            .join("\n");
        }
      }

      // ── 4. Handle portfolio / video URL with a targeted response ─────────
      const resolvedUrlType = args.urlType || classifyMessage(args.textBody).type;
      const resolvedDetectedUrl = args.detectedUrl || classifyMessage(args.textBody).detectedUrl;

      if (resolvedDetectedUrl && (resolvedUrlType === "youtube_url" || resolvedUrlType === "portfolio_url" || resolvedUrlType === "drive_url")) {
        // Store portfolio URL in session
        await ctx.runMutation(api.communications.whatchimp.updateSessionState, {
          phone: args.phone,
          portfolioUrl: resolvedDetectedUrl,
        });

        let portfolioReply: string;
        if (resolvedUrlType === "youtube_url") {
          portfolioReply = cvReceived
            ? `Thank you for sharing your work sample! 🎬 We've noted it against your application for the ${job.title} role.`
            : `Thank you for sharing your work sample! 🎬 We've noted it. To complete your application for the ${job.title} role, please also send your CV as a PDF.`;
        } else if (resolvedUrlType === "drive_url") {
          portfolioReply = cvReceived
            ? `Thank you for sharing your file link. We've noted it against your ${job.title} application.`
            : `Thanks for the link! To complete your ${job.title} application, please also send your CV as a PDF.`;
        } else {
          portfolioReply = cvReceived
            ? `Thank you for sharing your portfolio! 🎨 We've noted it against your ${job.title} application.`
            : `Thank you for sharing your portfolio! 🎨 We've noted it. To complete your application, please also send your CV as a PDF.`;
        }

        await ctx.runMutation(api.communications.whatchimp.updateSessionState, { phone: args.phone, lastBotReplyAt: Date.now() });
        await sendReply(ctx, args.phone, jobId, portfolioReply);
        return;
      }

      // ── 5. Build context-aware system prompt ──────────────────────────────
      const isFullTimeOnly = job.recruitmentType === "job_posting" || job.recruitmentType === "headhunting";

      const cvStatus = cvReceived
        ? "✅ CV has been RECEIVED and is being processed. Do NOT ask for it again."
        : "❌ CV has NOT been received yet.";

      const portfolioStatus = portfolioUrls.length > 0
        ? `Portfolio/work samples shared: ${portfolioUrls.join(", ")}`
        : "No portfolio shared yet.";

      const prefContext = employmentPreference
        ? `Candidate stated employment preference: ${employmentPreference}`
        : "Employment preference: not stated.";

      const toneMap: Record<string, string> = {
        warm_friendly: "Warm, encouraging, conversational, and helpful with natural emojis. Speak like a friendly talent acquisition colleague.",
        professional_formal: "Polite, clear, structured, corporate, and precise.",
        casual_tech: "Direct, tech-savvy, conversational, concise, and peer-to-peer.",
        direct_concise: "Short, prompt, to-the-point with minimal extra words.",
      };
      const selectedTone = toneMap[job.conversationTone || "professional_formal"] || (job.conversationTone ? `Custom tone: ${job.conversationTone}` : toneMap.professional_formal);

      const systemPrompt = `You are a warm, human Talent Acquisition colleague for Career141 — NOT a robotic script.
You are helping a candidate apply for the following role:

JOB: ${job.title}
COMPANY: ${job.isConfidential ? `Confidential Search (do NOT reveal client name; explain politely that this is a confidential search by Career141 for a premier ${job.clientIndustry || "organization"})` : (job.clientName || "Career141 client")}
LOCATION: ${job.location || "Not specified"}
EMPLOYMENT TYPE: ${job.recruitmentType === "both" ? "Full-time or Freelance" : isFullTimeOnly ? "Full-time only" : "Freelance/Contract"}
SALARY: ${job.salaryMin ? `${job.salaryMin}–${job.salaryMax} ${job.salaryCurrency || ""}` : "Not disclosed"}
JOB DESCRIPTION: ${(job.jobDescription || "").substring(0, 500)}

CONVERSATION TONE TO USE:
${selectedTone}

CANDIDATE STATE:
${cvStatus}
${portfolioStatus}
${prefContext}

RECENT CONVERSATION (oldest → newest):
${conversationHistory}

RULES — follow these strictly:
1. ANSWER THE CANDIDATE'S ACTUAL QUESTION first. Use job details above. Do not ignore it.
2. If the CV is already received (✅ above): NEVER ask for the CV again. Just continue the conversation naturally.
3. If the candidate said they only do freelance AND the job is full-time only:
   - Politely inform them that this specific role requires full-time commitment.
   - Offer to keep their CV on file for future freelance opportunities.
   - Do NOT keep pushing the CV for this job.
4. NEVER claim to have reviewed, evaluated, or analyzed any attachment, video, or URL unless the CANDIDATE STATE above explicitly confirms it.
5. Never send multiple responses. Write ONE reply only.
6. If CV has NOT been received AND the conversation naturally warrants it, you MAY add ONE gentle line at the end asking them to share their CV as a PDF. Do not add it robotically to every message.
7. Keep your reply under 3 sentences. Be warm, human and friendly — not a scripted bot.
8. If the candidate asks if you are an AI: confirm it honestly, explain you're Career141's recruitment assistant, and ask if they have any questions about the role.
9. NEVER repeat generic "Thank you for reaching out to Career141" or "Which position are you interested in" greetings. Speak naturally as a helpful recruitment colleague.`;

      // ── 6. Call LLM ───────────────────────────────────────────────────────
      const openai = getOpenAI("jd_matching");
      const model = getModelForTask("jd_matching");

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: args.textBody },
        ],
        temperature: 0.4,
      });

      const replyMessage = completion.choices[0]?.message?.content?.trim();
      if (!replyMessage) return;

      // ── 7. Store employment preference if detected ────────────────────────
      if (args.textBody.match(/\bfreelance\b|\bproject[- ]based\b|\bcontract[- ]only\b/i)) {
        await ctx.runMutation(api.communications.whatchimp.updateSessionState, {
          phone: args.phone,
          employmentPreference: "freelance",
        });
      }

      // ── 8. Mark last bot reply time (dedup guard) ─────────────────────────
      await ctx.runMutation(api.communications.whatchimp.updateSessionState, {
        phone: args.phone,
        lastBotReplyAt: Date.now(),
      });

      console.log(`[PreApp Chat] Replying to +${args.phone} (cvReceived=${cvReceived}): ${replyMessage.substring(0, 120)}...`);
      await sendReply(ctx, args.phone, jobId, replyMessage);

    } catch (e: any) {
      console.error("[PreApp Chat] Error:", e);
    }
  }
});

/** Helper — resolves the correct Meta phone number ID and sends a free-text reply. */
async function sendReply(ctx: any, phone: string, jobId: any, message: string) {
  const outboundNumber = await ctx.runQuery(internal.communications.whatsappOutbound.getJobOutboundWhatsAppNumber, { jobId });
  let phoneNumberId = process.env.META_PHONE_NUMBER_ID || "965783109962872";
  if (outboundNumber) {
    const fetchedId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, {
      targetWhatsAppNumber: outboundNumber,
    });
    if (fetchedId) phoneNumberId = fetchedId;
  }
  const metaAccessToken = process.env.META_ACCESS_TOKEN || "";
  await sendMetaFreeText(phoneNumberId, phone, message, metaAccessToken)
    .then((r: any) => { if (!r.success) console.error("[PreApp Chat] Meta send failed:", r.error); })
    .catch(console.error);
}

/** Internal query helpers used by handlePreApplicationChat */
export const getCandidateByPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    return await findCandidateByPhone(ctx, args.phone);
  },
});

export const getRecentMessages = internalQuery({
  args: { candidateId: v.id("candidates"), limit: v.number() },
  handler: async (ctx, args) => {
    const msgs = await ctx.db.query("communications")
      .withIndex("by_candidate_time", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .take(args.limit);
    return msgs.reverse();
  },
});


