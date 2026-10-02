import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { sendMetaFreeText } from "./metaDirectSender";
import { followUpCancelledReason } from "../lib/graphMail";
import { isFollowUpStage } from "../ta/stages";

/**
 * The Meta `phone_number_id` for the line an opening sends from.
 *
 * Returns null when the opening's configured number is not registered, so the
 * caller keeps its own default (`META_PHONE_NUMBER_ID`). It used to return the
 * hardcoded default instead, which meant an opening pointed at a TA's number
 * that nobody had added to `whatsappNumbers` sent from the main Career141 line
 * with nothing in the log to say so — the candidate replied to a number the TA
 * was not watching (23 September). There is no screen for that table, so the
 * mismatch is easy to create and was invisible.
 *
 * Still a fallback rather than a hard failure: a wrong-but-working sender beats
 * an opening that cannot message anyone. The warning is what was missing.
 */
export const getMetaPhoneNumberId = internalQuery({
  args: { targetWhatsAppNumber: v.string() },
  handler: async (ctx, args) => {
    const cleanDigits = args.targetWhatsAppNumber.replace(/\D/g, "");
    if (!cleanDigits) return null;

    const allNumbers = await ctx.db.query("whatsappNumbers").collect();
    // Last nine digits: the same number is written +94 77…, 94 77… and 077….
    const dbNumber = allNumbers.find(
      (n) => n.phone && n.phone.replace(/\D/g, "").slice(-9) === cleanDigits.slice(-9),
    );

    // `whatchimpPhoneId` holds the Meta phone_number_id — the column keeps its
    // old name from before the migration off WhatChimp.
    if (dbNumber && dbNumber.whatchimpPhoneId) {
      return dbNumber.whatchimpPhoneId;
    }

    console.warn(
      `[WhatsApp Outbound] The opening is set to send from ${args.targetWhatsAppNumber}, ` +
        `but no row in whatsappNumbers matches it. Falling back to the default sending ` +
        `number — replies will arrive on the default line, not that one. Add the number ` +
        `via settings.whatsappNumbers:add to fix.`,
    );
    return null;
  },
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

/*
 * `resolveTestModePhone` lived here and is gone (23 September).
 *
 * It mapped an inbound message from the configured test phone onto a candidate
 * — first by looking the number up, then, failing that, by attaching it to
 * whoever received the most recent outbound WhatsApp. That last fallback is
 * how a tester's "hi" ended up recorded against a real candidate's
 * application, and triggered an AI reply about their opening.
 *
 * Inbound is matched on the number that actually sent the message, and nothing
 * else. If the tester wants the conversation to land somewhere, their number
 * goes on a candidate record — which is also what makes the outbound gate a
 * no-op rather than a redirect, so the whole round trip is the real path.
 *
 * It also read a different set of switches from the outbound side
 * (WHATSAPP_TEST_MODE / TEST_PHONE_NUMBER / appSettings.testModeEnabled versus
 * OUTREACH_LIVE / OUTREACH_TEST_PHONE), so the two directions could disagree
 * about whether test mode was even on.
 */

/**
 * The candidate an inbound WhatsApp belongs to.
 *
 * Why this is not a single lookup: the same person is written `+94 77…`,
 * `94 77…` and `077…` across CVs, Excel Tables rows and headhunting, so every
 * form has to be tried. And the same number legitimately appears on more than
 * one record — a candidate re-added from a different source, or a TA testing.
 *
 * It used to take the FIRST row each lookup returned, in lookup order. Meta
 * sends the number with no plus, so a stale record stored as `94753883167`
 * was matched ahead of the live one stored as `+94753883167`, and the reply
 * was filed against a candidate with no open conversation — the candidate got
 * no answer and the TA saw an empty thread (23 September).
 *
 * Now every form is gathered and the one actually in a conversation wins:
 * an open application first, then the most recently created. A duplicate that
 * nobody is talking to can no longer swallow a live reply.
 */
export async function findCandidateByPhone(ctx: any, targetPhone: string) {
  const matches = await candidatesWithPhone(ctx, targetPhone);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // More than one record holds this number. Prefer whoever is mid-conversation.
  const LIVE = ["follow_up", "ta_shortlist", "matched_candidates"];
  let best = null;
  let bestRank = -1;
  for (const c of matches) {
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q: any) => q.eq("candidateId", c._id))
      .collect();
    const open = apps.filter((a: any) => a.currentStage !== "rejected" && a.currentStage !== "placed");
    const rank = open.some((a: any) => LIVE.includes(a.currentStage)) ? 2 : open.length > 0 ? 1 : 0;
    if (rank > bestRank || (rank === bestRank && best && c._creationTime > best._creationTime)) {
      best = c;
      bestRank = rank;
    }
  }

  console.warn(
    `[WhatsApp Inbound] ${matches.length} candidate records share the number ${targetPhone}. ` +
      `Matched ${best?.fullName ?? best?._id} (rank ${bestRank}: 2=in an active follow-up stage, ` +
      `1=has an open application, 0=none). Merge the duplicates to make this unambiguous.`,
  );
  return best;
}

/**
 * Every candidate record holding this number, in any of its spellings.
 * Split out of findCandidateByPhone (2 Oct) so the do-not-contact check
 * (contactGuard.ts) sees all of them, not just the one a reply is filed on.
 */
export async function candidatesWithPhone(ctx: any, targetPhone: string): Promise<any[]> {
  const cleanDigits = targetPhone.replace(/\D/g, "");
  if (!cleanDigits) return [];

  /** Every spelling of this number that might be on a record. */
  const phones = new Set<string>([targetPhone, `+${cleanDigits}`]);
  const cleans = new Set<string>([cleanDigits]);

  if (cleanDigits.startsWith("94") && cleanDigits.length === 11) {
    const local = "0" + cleanDigits.slice(2);
    phones.add(local);
    cleans.add(local);
  } else if (cleanDigits.startsWith("0") && cleanDigits.length === 10) {
    const intl = "94" + cleanDigits.slice(1);
    phones.add("+" + intl);
    phones.add(intl);
    cleans.add(intl);
  }

  const found = new Map<string, any>();
  for (const phone of phones) {
    for (const c of await ctx.db
      .query("candidates")
      .withIndex("by_phone", (q: any) => q.eq("phone", phone))
      .take(20)) {
      found.set(String(c._id), c);
    }
  }
  for (const clean of cleans) {
    for (const c of await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q: any) => q.eq("phoneClean", clean))
      .take(20)) {
      found.set(String(c._id), c);
    }
  }

  // Last resort, unchanged: the tail nine digits against recent candidates,
  // bounded so a wide scan cannot time the mutation out.
  if (found.size === 0 && cleanDigits.length >= 7) {
    const tailDigits = cleanDigits.slice(-9);
    for (const c of await ctx.db.query("candidates").order("desc").take(200)) {
      const digits = c.phoneClean && c.phoneClean.length >= 7
        ? c.phoneClean
        : (c.phone ?? "").replace(/\D/g, "");
      if (digits.length >= 7 && digits.endsWith(tailDigits)) {
        found.set(String(c._id), c);
        break;
      }
    }
  }

  return [...found.values()];
}

export const sendWhatsApp = internalAction({
  args: {
    communicationId: v.id("communications"),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    body: v.string(),
    /**
     * This message answers the candidate rather than chasing them.
     *
     * The guard below stops a chase reaching somebody who has moved on. An
     * answer is the opposite. The assistant collects the last missing detail,
     * the candidate is advanced to Second Shortlist in the same run, and the
     * "thank you, your profile is complete" message was then cancelled for
     * being sent to a candidate no longer in Follow-up — so they heard nothing
     * back at the exact moment they finished what was asked (23 September).
     *
     * Email hit this on 18 September and grew `isReplyToCandidate` then
     * (`lib/graphMail.ts`); WhatsApp never got the same treatment. Same helper,
     * so the two channels cannot drift apart again.
     */
    isReplyToCandidate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const commRecord = await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId });
    const appRecord = commRecord?.applicationId
      ? await ctx.runQuery(internal.communications.whatsappOutbound.getApplicationRecord, { applicationId: commRecord.applicationId })
      : null;
    const cancelled = followUpCancelledReason(commRecord, appRecord, args.isReplyToCandidate === true);
    if (cancelled) {
      console.log(`[WhatsApp Outbound] ${cancelled} (communication ${args.communicationId})`);
      if (commRecord?.deliveryStatus !== "failed") {
        await ctx.runMutation(internal.communications.whatsappOutbound.updateStatus, {
          communicationId: args.communicationId,
          status: "failed",
          error: cancelled,
        });
      }
      return;
    }

    // 1. Fetch candidate contact details
    const candidate = await ctx.runQuery(internal.candidates.candidates.getCandidate, {
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

    /*
     * 2. Is the free 24-hour service window open?
     *
     * This block used to also run a second test mode of its own — WHATSAPP_TEST_MODE /
     * OUTREACH_TEST_MODE / TEST_MODE / the appSettings.testModeEnabled row, with its
     * own recipient list — deciding the destination BEFORE `outreachSafety` ever saw
     * it. Two gates with different rules, and this one had a hole: `activeInboundSession`
     * sent to the REAL candidate's number even with test mode on, because "they wrote to
     * us recently" was treated as consent. On a database restored from production that
     * is a real person (23 September).
     *
     * `resolveRecipient`, inside `sendMetaFreeText`, is now the only thing that decides
     * who a message reaches. It reads OUTREACH_LIVE / OUTREACH_TEST_PHONE from the
     * environment only, and it fails closed. The sending number is untouched by any of
     * this — test mode redirects the recipient, never the sender.
     */
    const targetPhone = candidate.phone;
    const logNote = "";

    const activeInboundSession = await ctx.runQuery(internal.communications.whatsappOutbound.hasRecentInboundComm, {
      candidateId: candidate._id,
      withinMs: 24 * 60 * 60 * 1000,
    });

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

      const result = await sendMetaFreeText(phoneId, cleanPhone, args.body, metaAccessToken, ctx);

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
      } else if (result.outsideWindow) {
        /*
         * Our guess about the 24-hour window was wrong.
         *
         * `hasRecentInboundComm` reads our own rows, and the same phone number
         * sits on several candidate records — so a reply logged against one
         * leaves another looking silent, or looking active when Meta disagrees.
         * When the guess said "open" and Meta said 131047, the free text was
         * rejected and the candidate received NOTHING: the TA pressed Send,
         * saw no error worth noticing, and the message simply never arrived.
         * Sending "hi" from the candidate's phone made the next attempt work,
         * which is what made it look intermittent (25 September).
         *
         * Meta is the authority on its own window. Now its refusal re-opens
         * the conversation with an approved template instead of giving up.
         */
        console.warn(
          `[WhatsApp Outbound] Meta refused free text to +${cleanPhone} as outside the 24h window, ` +
            `though our own records said it was open. Falling back to the approved template.`,
        );
        await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
          applicationId: commRecord?.applicationId,
          candidateId: args.candidateId,
          jobId: args.jobId,
          communicationId: args.communicationId,
          templateType: "reengagement",
        });
        return;
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
    const targetPhone = args.senderPhone;
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
    // An application in Follow-up wins over one that is not: that is the
    // conversation the assistant is having (2 Oct).
    if (!activeApp || !isFollowUpStage(activeApp.currentStage)) {
      activeApp = apps.find((a: any) => isFollowUpStage(a.currentStage)) ?? activeApp;
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

    // Chase only an application in Follow-up, the same rule as email
    // (ta/stages.ts isFollowUpStage). This skipped only rejected and placed, so
    // a candidate at interview or offer was asked again for their details
    // (2 Oct). Anywhere else the message is recorded above and a TA answers.
    // Still "handled" for the webhook, so no keyword or pre-application reply
    // goes out instead.
    if (!isFollowUpStage(activeApp.currentStage)) {
      console.log(`[checkAndRecordFollowUpReply] Application ${activeApp._id} is in ${activeApp.currentStage}, not Follow-up. Recorded; no AI reply.`);
    } else if (args.textBody && args.textBody.trim().length > 2) {
      // ONLY run text extraction if textBody is non-empty (> 2 chars to skip trivial "ok", "hi")
      // Run text extraction in background to parse details
      await ctx.scheduler.runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText, {
        candidateId: candidate._id,
        textBody: args.textBody,
        channel: "whatsapp",
        // The application this reply was matched to, above. Without it the
        // extraction re-guesses from the last outbound on any channel and can
        // land on a different opening.
        applicationId: activeApp._id,
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
    const targetPhone = args.senderPhone;
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

