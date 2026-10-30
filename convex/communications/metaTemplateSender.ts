import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { emailAllowed, phoneAllowed, outboundLocked, suppressed } from "../lib/outboundGuard";
import { resolveRecipient } from "../lib/outreachSafety";
import { refuseIfDoNotContact } from "../lib/doNotContact";
import { followUpCancelledReason } from "../lib/graphMail";
import { dailyTemplateCap, startOfUtcDay, withinTemplateBudget } from "../lib/templateBudget";
import { TEMPLATE_NAME, initialOutreachText, roleLink, templatePayload } from "../lib/whatsappTemplates";
import { isNumberLevelError } from "../lib/senderRouting";

// The access token is a live credential and is read from the deployment's
// environment only. It used to sit here as a literal fallback, which meant a
// working WhatsApp Business token was in source control and in every clone of
// the repository. Set it with `npx convex env set META_ACCESS_TOKEN …`.
//
// With no token configured, sending fails closed and says so — which is the
// right behaviour for a machine that was never meant to message candidates.

// Primary Career141 WhatsApp Business Phone Number ID (+94 74 219 7476).
// An identifier rather than a credential: it names the sending number and
// grants nothing on its own, so it stays here as a default.
export const DEFAULT_META_PHONE_ID = "965783109962872";

export const sendMetaTemplate = internalAction({
  args: {
    applicationId: v.optional(v.id("applications")),
    candidateId: v.optional(v.id("candidates")),
    jobId: v.optional(v.id("jobs")),
    communicationId: v.optional(v.id("communications")),
    templateType: v.union(v.literal("initial_outreach"), v.literal("reengagement")),
  },
  handler: async (ctx, args) => {
    const metaAccessToken = process.env.META_ACCESS_TOKEN;
    if (!metaAccessToken) {
      console.error("[Meta Template Sender] META_ACCESS_TOKEN is not configured.");
      throw new Error("META_ACCESS_TOKEN is missing");
    }

    // 1. Resolve Application, Candidate, and Job
    let app = args.applicationId
      ? await ctx.runQuery(internal.communications.metaTemplateSender.getApplicationById, {
          applicationId: args.applicationId,
        })
      : null;

    if (!app && args.candidateId) {
      app = await ctx.runQuery(internal.communications.metaTemplateSender.getApplicationForCandidate, {
        candidateId: args.candidateId,
        jobId: args.jobId,
      });
    }

    const resolvedCandidateId = app?.candidateId || args.candidateId;
    if (!resolvedCandidateId) {
      throw new Error("Cannot dispatch Meta template: candidateId is missing");
    }

    const candidate = await ctx.runQuery(internal.communications.metaTemplateSender.getCandidateById, {
      candidateId: resolvedCandidateId,
    });
    if (!candidate) {
      throw new Error(`Candidate ${resolvedCandidateId} not found`);
    }

    const resolvedJobId = app?.jobId || args.jobId;
    const job = resolvedJobId
      ? await ctx.runQuery(internal.communications.metaTemplateSender.getJobById, { jobId: resolvedJobId })
      : null;

    // Every refusal below is written onto the row, so the conversation says
    // why nothing went instead of showing a message that never existed.
    const refuse = async (reason: string) => {
      console.warn(`[Meta Template Sender] ${reason}`);
      await ctx.runMutation(internal.communications.metaTemplateSender.logTemplateCommunication, {
        communicationId: args.communicationId,
        applicationId: app?._id,
        candidateId: resolvedCandidateId,
        jobId: resolvedJobId,
        body: `[${args.templateType} template not sent] ${reason}`,
        status: "failed",
        error: reason,
      });
    };

    // No job, no template. This used to fall back to the first active job in
    // the database, so a candidate whose job could not be found was messaged
    // by name about somebody else's opening (2 Oct).
    if (!job) {
      await refuse("Not sent: the job this message is about could not be found.");
      return;
    }

    const refusal = await refuseIfDoNotContact(ctx, "WhatsApp template", {
      candidateId: resolvedCandidateId,
      phone: candidate.phone,
    });
    if (refusal) {
      await refuse(refusal);
      return;
    }

    // A template is a chase, so it gets the same guard as the free-text sender
    // and the follow-up email: one queued before the TA stopped the sequence,
    // or before the candidate moved on, used to go anyway (2 Oct).
    const queued = args.communicationId
      ? await ctx.runQuery(internal.communications.whatsappOutbound.getCommunicationRecord, { communicationId: args.communicationId })
      : null;
    const cancelled = followUpCancelledReason(queued, app);
    if (cancelled) {
      await refuse(cancelled);
      return;
    }

    // 2. The sending number: the candidate's TA's own number once it is
    // ready, else the main line (lib/senderRouting, 30 Oct).
    const mainPhoneId = process.env.META_PHONE_NUMBER_ID || DEFAULT_META_PHONE_ID;
    let phoneId =
      (await ctx.runQuery(internal.communications.whatsappOutbound.senderPhoneId, {
        jobId: job._id,
        applicationId: app?._id,
      })) ?? mainPhoneId;

    // Clean destination phone number digits
    if (!candidate.phone || !candidate.phone.replace(/\D/g, "")) {
      throw new Error(`Candidate ${candidate.fullName || "unknown"} has no valid phone number`);
    }
    // Templates reach phones that have never messaged us — the one send that
    // most needs the gate, and the one that never had it.
    const decision = resolveRecipient("whatsapp", candidate.phone);
    if (!decision.ok) {
      await refuse(decision.reason);
      return;
    }
    const cleanRecipientPhone = decision.to;
    if (decision.note) console.log(`[Meta Template Sender] Template${decision.note}`);

    /*
     * The day's budget. Every WhatsApp we pay Meta for passes through here —
     * initial outreach, re-engagement, and the fallback when free text is
     * refused — so this is the one place a cap belongs.
     *
     * Free text inside the candidate's 24-hour window costs nothing, so the
     * bill is concentrated in cold templates. A bulk send can spend a month's
     * budget in an afternoon, and the invoice arrives long afterwards. The cap
     * refuses rather than reports.
     *
     * `C141_WHATSAPP_TEMPLATE_DAILY_CAP` unset means no cap, so a deployment
     * that has not opted in sends exactly as it did before.
     */
    const cap = dailyTemplateCap(process.env.C141_WHATSAPP_TEMPLATE_DAILY_CAP);
    if (cap !== null) {
      const sentToday = await ctx.runQuery(
        internal.communications.metaTemplateSender.countBillableTemplatesToday,
        { since: startOfUtcDay(Date.now()) },
      );
      if (!withinTemplateBudget(sentToday, cap)) {
        const reason =
          `Not sent — the daily WhatsApp template limit of ${cap} has been reached ` +
          `(${sentToday} sent today). It will be tried again tomorrow.`;
        console.warn(`[Meta Template Sender] ${reason}`);
        await ctx.runMutation(internal.communications.metaTemplateSender.logTemplateCommunication, {
          communicationId: args.communicationId,
          applicationId: app?._id,
          candidateId: resolvedCandidateId,
          jobId: resolvedJobId || job?._id,
          body: `[${args.templateType} template held back] ${reason}`,
          status: "failed",
          error: reason,
        });
        // Tomorrow, not never: the sweep clears its own schedule before
        // sending, so without this the candidate would simply be dropped.
        if (app?._id) {
          await ctx.runMutation(internal.communications.metaTemplateSender.retryTemplateTomorrow, {
            applicationId: app._id,
          });
        }
        return;
      }
    }

    // 3. Construct parameters and text representations based on template type
    let templateName = "";
    let parameters: any[] = [];
    let loggedBody = "";

    // Helper to sanitize template parameter text (Meta Error 132018: no newlines, tabs, or >4 spaces)
    const sanitizeParam = (str: string): string => {
      if (!str) return "";
      return str
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    };

    const cleanName = (candidate.fullName || "Candidate").replace(/\s*\([+0-9\s-]+\)\s*$/g, "").trim();
    const candidateName = sanitizeParam(cleanName || "Candidate");
    const jobTitle = sanitizeParam(job.title || "the role");

    if (args.templateType === "initial_outreach") {
      templateName = TEMPLATE_NAME.initial_outreach;

      // Build missing fields list
      const missingList: string[] = [];
      const hasCV = app?.followUpCvReceived === true || !!candidate.cvUploadId || !!app?.cvFileId;
      const hasCurrentSalary = app?.followUpCurrentSalary === true || candidate.currentSalary !== undefined;
      const hasExpectedSalary = app?.followUpExpectedSalary === true || candidate.expectedSalary !== undefined;
      const hasNoticePeriod = app?.followUpNoticePeriod === true || candidate.noticePeriodDays !== undefined;

      if (!hasCV) missingList.push("CV / Resume");
      if (!hasCurrentSalary) missingList.push("Current Salary");
      if (!hasExpectedSalary) missingList.push("Expected Salary");
      if (!hasNoticePeriod) missingList.push("Notice Period");

      const customQuestions = job?.customFollowUpQuestions || [];
      const customAnswers = app?.customFollowUpAnswers || {};
      for (const q of customQuestions) {
        if (!customAnswers[q]) missingList.push(q);
      }

      const missingFormatted = sanitizeParam(missingList.map((m) => `• ${m}`).join(" | ") || "• None (all submitted)");

      // {{3}} is where the candidate reads the role — the LinkedIn job, else
      // the short apply link, else a sentence (the owner, 30 Oct). It used to
      // be a skills list or a cut of the job description.
      const links = await ctx.runQuery(internal.communications.metaTemplateSender.getOpeningLinks, { jobId: job._id });
      const link = roleLink(links.posts, links.shortApplyLink);

      parameters = [
        { type: "text", text: candidateName },
        { type: "text", text: jobTitle },
        { type: "text", text: link },
        { type: "text", text: missingFormatted },
      ];

      loggedBody = initialOutreachText(candidateName, jobTitle, link, missingFormatted);
    } else {
      templateName = TEMPLATE_NAME.reengagement;

      parameters = [
        { type: "text", text: candidateName },
        { type: "text", text: jobTitle },
      ];

      loggedBody = `Hi ${candidateName}, we're still looking forward to progressing your application for the *${jobTitle}* role at Career141.\n\nWe just need a few details from you to move things forward. Could you please reply to this message at your earliest convenience?\n\nWe'd love to keep you in the process! 😊`;
    }

    // 4. Send request to Meta Cloud API with fallback for language locale (en_US / en)
    // `en` first: both approved templates on this account are in `en`, and
    // asking for `en_US` costs a failed call and a 132001 in the log before the
    // fallback succeeds (checked against Meta, 18 September).
    const languagesToTry = ["en", "en_US"];
    let sentSuccess = false;
    let errorMessage = "";

    // A TA number Meta will not send from is switched off and the template goes
    // once more from the main line, where both templates are approved — the
    // candidate still gets their message, the TA lead sees why in Settings.
    for (let attempt = 0; attempt < 2 && !sentSuccess; attempt++) {
      if (attempt === 1) {
        if (phoneId === mainPhoneId || !isNumberLevelError(errorMessage)) break;
        await ctx.runMutation(internal.communications.whatsappOutbound.markNumberNotReady, {
          phoneId,
          reason: errorMessage.slice(0, 300),
        });
        phoneId = mainPhoneId;
      }
      for (const langCode of languagesToTry) {
        const payload = templatePayload(args.templateType, cleanRecipientPhone, parameters.map((p) => p.text), langCode);

        if (!phoneAllowed(cleanRecipientPhone)) {
          throw new Error(suppressed("WhatsApp template", cleanRecipientPhone));
        }

        try {
          console.log(`[Meta Template Sender] Dispatching template "${templateName}" (${langCode}) to target phone +${cleanRecipientPhone} using phone_number_id ${phoneId}`);
          const metaUrl = `https://graph.facebook.com/v19.0/${phoneId}/messages`;

          const response = await fetch(metaUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${metaAccessToken}`,
            },
            body: JSON.stringify(payload),
          });

          const responseText = await response.text();
          if (response.ok) {
            const responseData = JSON.parse(responseText);
            if (responseData.messages && responseData.messages.length > 0) {
              sentSuccess = true;
              console.log(`[Meta Template Sender] Successfully sent template message with language ${langCode}. Meta Msg ID: ${responseData.messages[0].id}`);
              break;
            } else {
              errorMessage = `Response payload missing message ID: ${responseText}`;
            }
          } else {
            errorMessage = `HTTP ${response.status}: ${responseText}`;
            console.error(`[Meta Template Sender] Meta API returned failure for lang ${langCode}: ${errorMessage}`);
            // If error is not a translation/locale error (132001), break early
            if (!responseText.includes("132001")) {
              break;
            }
          }
        } catch (err: any) {
          errorMessage = err.message || String(err);
          console.error(`[Meta Template Sender] HTTP request exception for phoneId ${phoneId}: ${errorMessage}`);
          break;
        }
      }
    }

    // 5. Record / Update the message in communications history
    await ctx.runMutation(internal.communications.metaTemplateSender.logTemplateCommunication, {
      communicationId: args.communicationId,
      applicationId: app?._id,
      candidateId: resolvedCandidateId,
      jobId: resolvedJobId,
      body: loggedBody,
      status: sentSuccess ? "sent" : "failed",
      error: errorMessage || undefined,
      // Counts against tomorrow's cap only if Meta actually took it.
      billableTemplate: sentSuccess,
    });

    if (!sentSuccess) {
      throw new Error(`Failed to send WhatsApp Meta Template: ${errorMessage}`);
    }

    return { success: true };
  },
});

export const logTemplateCommunication = internalMutation({
  args: {
    communicationId: v.optional(v.id("communications")),
    applicationId: v.optional(v.id("applications")),
    candidateId: v.id("candidates"),
    jobId: v.optional(v.id("jobs")),
    body: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    error: v.optional(v.string()),
    /** True only when Meta accepted it, so the cap counts real spend. */
    billableTemplate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.communicationId) {
      await ctx.db.patch(args.communicationId, {
        deliveryStatus: args.status,
        errorMessage: args.error,
        body: args.body,
        sentAt: Date.now(),
        ...(args.applicationId ? { applicationId: args.applicationId } : {}),
        ...(args.jobId ? { jobId: args.jobId } : {}),
        ...(args.billableTemplate === true ? { billableTemplate: true } : {}),
      });
    } else {
      await ctx.db.insert("communications", {
        candidateId: args.candidateId,
        applicationId: args.applicationId,
        jobId: args.jobId,
        direction: "outbound",
        channel: "whatsapp",
        subject: args.status === "sent" ? "WhatsApp Template Outreach Sent" : "WhatsApp Template Outreach Failed",
        body: args.body,
        deliveryStatus: args.status === "sent" ? "sent" : "failed",
        errorMessage: args.error,
        sentAt: Date.now(),
        stoppedSequence: false,
        ...(args.billableTemplate === true ? { billableTemplate: true } : {}),
      });
    }
  },
});

// Internal query helpers — used by sendMetaTemplate action to load db records
export const getApplicationById = internalQuery({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.applicationId);
  },
});

export const getCandidateById = internalQuery({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.candidateId);
  },
});

export const getJobById = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

/** The opening's adverts and short apply link, for `roleLink`. */
export const getOpeningLinks = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const posts = await ctx.db
      .query("jobPosts")
      .withIndex("by_opening", (q) => q.eq("openingId", args.jobId))
      .collect();
    const assets = await ctx.db
      .query("job_assets")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .first();
    return {
      posts: posts.map((p) => ({ channel: p.channel, status: p.status, externalUrl: p.externalUrl })),
      shortApplyLink: assets?.shortApplyLink ?? null,
    };
  },
});

/**
 * The candidate's application for this job, or null.
 *
 * It used to fall back to the candidate's newest application for ANY job, so a
 * template meant for one opening went out naming another (2 Oct). No job, or
 * no application for it, now means no application.
 */
export const getApplicationForCandidate = internalQuery({
  args: { candidateId: v.id("candidates"), jobId: v.optional(v.id("jobs")) },
  handler: async (ctx, args) => {
    if (!args.jobId) return null;
    return await ctx.db
      .query("applications")
      .withIndex("by_candidate_job", (q) =>
        q.eq("candidateId", args.candidateId).eq("jobId", args.jobId!)
      )
      .first();
  },
});

/**
 * Billable templates sent since `since`, for the daily cap.
 *
 * Counted off `by_channel_time`, so the scan is one day of WhatsApp rows
 * rather than the whole table.
 */
export const countBillableTemplatesToday = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("communications")
      .withIndex("by_channel_time", (q) => q.eq("channel", "whatsapp").gte("sentAt", args.since))
      .collect();
    const demos = await ctx.db.query("demoTemplateSends")
      .withIndex("by_sentAt", (q) => q.gte("sentAt", args.since)).collect();
    return rows.filter((r) => r.billableTemplate === true && r.direction === "outbound").length + demos.length;
  },
});

/** Only a timestamp: demo sends count toward the cap without candidate data. */
export const logDemoTemplateSent = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("demoTemplateSends", { sentAt: Date.now() });
  },
});

/**
 * Put a candidate held back by the cap at the front of tomorrow's queue.
 *
 * The sweep clears `nextFollowUpScheduledAt` before it sends, as its guard
 * against sending twice. Without putting a time back, a candidate the cap
 * refused would never be chased again — the cap would quietly drop people
 * instead of delaying them.
 */
export const retryTemplateTomorrow = internalMutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;
    const tomorrow = startOfUtcDay(Date.now()) + 24 * 60 * 60 * 1000;
    await ctx.db.patch(args.applicationId, { nextFollowUpScheduledAt: tomorrow });
    console.log(
      `[Meta Template Sender] Application ${args.applicationId} held back by the daily cap; rescheduled for ${new Date(tomorrow).toISOString()}.`,
    );
  },
});
