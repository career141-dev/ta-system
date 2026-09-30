import { Id } from "../_generated/dataModel";
import { hasCurrentSalary, hasExpectedSalary, hasNoticePeriod, noticePeriodToDays } from "../lib/answered";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { internal } from "../_generated/api";
import { adjustJobStageStat } from "../jobs/stats";
import { buildStructuredEmailHtml, initialReachOutEmail } from "../communications/emailHtml";
import { resolveRecipient } from "../lib/outreachSafety";

/**
 * Checks per-application follow-up completion flags.
 * If all 4 are true, auto-advances the application to second_shortlist.
 *
 * Uses per-application flags (followUpCvReceived etc.) rather than global
 * candidate fields to prevent cross-job contamination in multi-job scenarios.
 */
export async function checkAndAdvanceFollowUp(
  ctx: any,
  candidateId: Id<"candidates">
): Promise<void> {
  const apps = await ctx.db
    .query("applications")
    .withIndex("by_candidateId", (q: any) => q.eq("candidateId", candidateId))
    .collect();

  for (const app of apps) {
    const isFollowUp = app.currentStage === "follow_up" || app.currentStage === "ta_shortlist";
    const isAutoRejected = app.currentStage === "rejected" && app.taRejectionReason === "Did not complete requirements within 7-day window";

    if (!isFollowUp && !isAutoRejected) continue;

    const candidate = await ctx.db.get(candidateId);
    if (!candidate) continue;

    const job = await ctx.db.get(app.jobId);
    if (!job) continue;

    /*
     * A CV means a CV file. `|| candidate.isParsed === true` used to be part of
     * this, and `isParsed` only means the candidate RECORD was processed — a
     * headhunted profile gets it with no CV anywhere. So every headhunted
     * candidate was credited with a CV they had never sent, the checklist read
     * "Everything is in", and they were auto-advanced to Second Shortlist and
     * offered to Director Review without one (23 September, seen on the first
     * real conversation; inherited from the CV pipeline in f9f5d46).
     */
    const hasCV = app.followUpCvReceived === true || !!candidate.cvUploadId || !!app.cvFileId;
    // The same rules as updateFollowUpFlags: words count, not only figures.
    const hasCurrent = hasCurrentSalary(candidate);
    const hasExpected = hasExpectedSalary(candidate);
    const hasNotice = hasNoticePeriod(candidate);

    // Auto-fix any flags that should be true based on actual candidate data
    const updates: any = {};
    if (hasCV && !app.followUpCvReceived) updates.followUpCvReceived = true;
    if (hasCurrent && !app.followUpCurrentSalary) updates.followUpCurrentSalary = true;
    if (hasExpected && !app.followUpExpectedSalary) updates.followUpExpectedSalary = true;
    if (hasNotice && !app.followUpNoticePeriod) updates.followUpNoticePeriod = true;

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(app._id, updates);
      Object.assign(app, updates); // apply updates locally for the next check
    }

    // Verify custom questions are completed
    const customQuestions = job.customFollowUpQuestions || [];
    const customAnswers = app.customFollowUpAnswers || {};
    let customQuestionsComplete = true;
    for (const q of customQuestions) {
      if (!customAnswers[q]) {
        customQuestionsComplete = false;
        break;
      }
    }

    const allComplete =
      app.followUpCvReceived === true &&
      app.followUpCurrentSalary === true &&
      app.followUpExpectedSalary === true &&
      app.followUpNoticePeriod === true &&
      customQuestionsComplete;

    if (allComplete) {
      const note = isAutoRejected 
        ? "Candidate provided late response. Reopened to Second Shortlist."
        : "Auto-advanced from Follow-up: all requirements completed.";

      await ctx.db.patch(app._id, {
        currentStage: "second_shortlist",
        taRejectionReason: undefined, // Clear rejection reason if reopening
        lastStageChangedAt: Date.now(),
        stageHistory: [
          ...(app.stageHistory ?? []),
          {
            stage: "second_shortlist",
            enteredAt: new Date().toISOString(),
            changedBy: "system" as any,
            note,
          },
        ],
      });
      await adjustJobStageStat(ctx, app.jobId, app.currentStage, "second_shortlist");
      await syncCandidateOverallStatus(ctx, candidateId);
    }
  }
}

/**
 * Sets one or more per-application follow-up flags based on what was just collected.
 * Call this after any data is written to the candidate record via TA call, AI call webhook,
 * or manual field edit.
 *
 * @param applicationId  The specific application to update
 * @param candidate      The full candidate record (used to derive flag values)
 */
export async function updateFollowUpFlags(
  ctx: any,
  applicationId: Id<"applications">,
  candidate: any
): Promise<void> {
  const app = await ctx.db.get(applicationId);
  if (!app) return;

  const updates: Record<string, any> = {};

  // CV: check cvUploadId on candidate OR on the application itself
  const hasCV = !!candidate.cvUploadId || !!app.cvFileId;
  if (hasCV && !app.followUpCvReceived) updates.followUpCvReceived = true;

  /*
   * A question is answered when the candidate has answered it — not only when
   * they gave a number. "Negotiable" and "two months" are answers; treating
   * them as silence is what made the chase ask the same thing four times
   * (23 September, see lib/answered.ts).
   */
  if (hasCurrentSalary(candidate)) {
    if (!app.followUpCurrentSalary) updates.followUpCurrentSalary = true;
    if (candidate.currentSalary !== undefined && candidate.currentSalary !== null
        && app.candidateCurrentSalary !== candidate.currentSalary) {
      updates.candidateCurrentSalary = candidate.currentSalary;
    }
  }

  if (hasExpectedSalary(candidate)) {
    if (!app.followUpExpectedSalary) updates.followUpExpectedSalary = true;
    if (candidate.expectedSalary !== undefined && candidate.expectedSalary !== null
        && app.candidateExpectedSalary !== candidate.expectedSalary) {
      updates.candidateExpectedSalary = candidate.expectedSalary;
    }
  }

  if (hasNoticePeriod(candidate)) {
    if (!app.followUpNoticePeriod) updates.followUpNoticePeriod = true;
    // Days when the words carry a number we can trust, so the schedule still works.
    const days = candidate.noticePeriodDays ?? noticePeriodToDays(candidate.noticePeriod);
    if (days !== null && days !== undefined && app.candidateNoticePeriodDays !== days) {
      updates.candidateNoticePeriodDays = days;
    }
  }

  if (Object.keys(updates).length > 0) {
    await ctx.db.patch(applicationId, updates);
  }
}

/**
 * The mailbox a candidate's follow-up emails are sent from: the TA assigned to
 * them — whoever shortlisted them — or, before anybody has, the opening's
 * primary recruiter. Undefined when neither has an email address, and the
 * sender falls back to the system inbox.
 */
export async function assignedTaEmail(ctx: any, app: any, job: any): Promise<string | undefined> {
  return (await assignedTa(ctx, app, job))?.email;
}

/**
 * The TA a candidate's follow-up is written as. Several TAs can share one
 * opening, each on their own post (30 Sep), so: whoever shortlisted them, then
 * the TA of the post they applied through, then the opening's primary recruiter.
 */
export async function assignedTa(ctx: any, app: any, job: any): Promise<{ name: string; email: string } | undefined> {
  const post = app?.jobPostId ? await ctx.db.get(app.jobPostId) : null;
  for (const userId of [app?.ownerTaId, post?.assignedTaId, job?.primaryRecruiterId]) {
    if (!userId) continue;
    const user = await ctx.db.get(userId);
    const email = (user?.email ?? "").trim();
    if (email) return { name: (user?.fullName ?? "").trim(), email };
  }
  return undefined;
}

/**
 * Initiates the follow-up outreach flow when a candidate first arrives at the follow_up stage.
 * Immediately builds and schedules the Day 0 WhatsApp notification outlining missing fields.
 */
export async function initiateFollowUpOutreach(
  ctx: any,
  applicationId: Id<"applications">,
  options?: {
    isManual?: boolean;
    /** A TA sending one channel only (the TA System's WhatsApp / Email buttons). */
    only?: "whatsapp" | "email";
    /**
     * The other channel of a round a TA already sent a moment ago: the same
     * message kind, and the attempt count and schedule are left as they are.
     */
    sameRound?: boolean;
    /** Filled in with what happened, for callers that need to say so. */
    report?: { sent: boolean; kind?: "initial" | "reminder"; blocked?: boolean };
  }
): Promise<Id<"communications"> | undefined> {
  const app = await ctx.db.get(applicationId);
  if (!app) return;

  const candidate = await ctx.db.get(app.candidateId);
  if (!candidate) return;

  const job = await ctx.db.get(app.jobId);
  if (!job) return;

  const isManual = options?.isManual === true;

  if (!isManual && (!job.agent3Enabled || (job.enableWhatsAppFollowUp !== true && job.enableEmailFollowUp !== true))) {
    console.log(`[Follow-up Outreach] Follow-up sequence is disabled for job "${job.title}". Skipping initiation.`);
    return;
  }

  // Derive complete/missing status
  const hasCV =
    app.followUpCvReceived === true ||
    (app.followUpCvReceived === undefined && (!!candidate.cvUploadId || !!app.cvFileId));

  const hasCurrentSalary =
    app.followUpCurrentSalary === true ||
    (app.followUpCurrentSalary === undefined && candidate.currentSalary !== undefined);

  const hasExpectedSalary =
    app.followUpExpectedSalary === true ||
    (app.followUpExpectedSalary === undefined && candidate.expectedSalary !== undefined);

  const hasNoticePeriod =
    app.followUpNoticePeriod === true ||
    (app.followUpNoticePeriod === undefined && candidate.noticePeriodDays !== undefined);

  const customQuestions = job.customFollowUpQuestions || [];
  const customAnswers = app.customFollowUpAnswers || {};
  let customQuestionsComplete = true;
  for (const q of customQuestions) {
    if (!customAnswers[q]) {
      customQuestionsComplete = false;
      break;
    }
  }

  const allComplete = hasCV && hasCurrentSalary && hasExpectedSalary && hasNoticePeriod && customQuestionsComplete;
  if (allComplete) return; // All data points already gathered, no outreach needed
  const sameRound = options?.sameRound === true;

  const missingFields: string[] = [];
  if (!hasCV) missingFields.push("CV / Resume");
  if (!hasCurrentSalary) missingFields.push("Current Salary");
  if (!hasExpectedSalary) missingFields.push("Expected Salary");
  if (!hasNoticePeriod) missingFields.push("Notice Period");
  for (const q of customQuestions) {
    if (!customAnswers[q]) {
      missingFields.push(q);
    }
  }
  
  const formattedMissingFields = missingFields.map(f => `• ${f}`).join("\n");

  const configRow = await ctx.db.query("appSettings")
    .withIndex("by_key", (q: any) => q.eq("key", "system"))
    .first();
  const companyName = configRow?.brandName || "our company";

  let body = "";
  if (job.followUpInitialTemplate) {
    body = job.followUpInitialTemplate
      .replace(/{candidate_name}/g, candidate.fullName || "there")
      .replace(/{job_title}/g, job.title || "the role")
      .replace(/{missing_fields}/g, formattedMissingFields)
      .replace(/{company_name}/g, companyName);
  } else {
    body = [
      `Hi ${candidate.fullName || "there"},`,
      `We're still waiting on the following to progress your application for **${job.title}**:`,
      formattedMissingFields,
      `Please share these at your earliest convenience. Thank you!`,
    ].join("\n\n");
  }

  // Determine Email Subject & Body (supporting Custom Email Templates)
  let emailSubject = `Action Required: Missing info for your ${job.title} application`;
  if (job.followUpEmailSubjectTemplate) {
    emailSubject = job.followUpEmailSubjectTemplate
      .replace(/{candidate_name}/g, candidate.fullName || "there")
      .replace(/{job_title}/g, job.title || "the role")
      .replace(/{company_name}/g, companyName);
  }

  let emailBody = body;
  if (job.enableEmailFollowUpTemplate && job.followUpEmailBodyTemplate) {
    emailBody = job.followUpEmailBodyTemplate
      .replace(/{candidate_name}/g, candidate.fullName || "there")
      .replace(/{job_title}/g, job.title || "the role")
      .replace(/{missing_fields}/g, formattedMissingFields)
      .replace(/{company_name}/g, companyName);
  }

  const now = Date.now();
  const NUDGE_RESCHEDULE_MS = 24 * 60 * 60 * 1000; // 24 hours

  let isWhatsAppEnabled = job.enableWhatsAppFollowUp !== false;
  let isEmailEnabled = job.enableEmailFollowUp !== false;

  if (isManual && options?.only) {
    // A TA chose the channel: that one, whatever the job's own toggles say.
    isWhatsAppEnabled = options.only === "whatsapp";
    isEmailEnabled = options.only === "email";
  } else if (isManual) {
    // Override: if both are disabled, manual trigger sends on both channels.
    if (!isWhatsAppEnabled && !isEmailEnabled) {
      isWhatsAppEnabled = true;
      isEmailEnabled = true;
    }
  } else {
    // Automatic trigger check: abort if both are disabled
    if (!isWhatsAppEnabled && !isEmailEnabled) {
      console.log(`[Follow-up Outreach] Both WhatsApp and Email follow-ups are disabled for job "${job.title}". Aborting outreach.`);
      return;
    }
  }

  const currentAttempts = app.followUpAttemptCount || 0;
  // Within a round the count already includes this round, so the round's kind
  // is read from the count before it.
  const isNudge = sameRound ? currentAttempts > 1 : currentAttempts > 0;
  // Whether any channel of this round can actually reach someone. With
  // outreach off and no test recipient every message is stopped by the safety
  // guard — and each stopped round still counted as one of the three, so a
  // candidate "used up" their follow-ups without receiving one (21 Sep).
  // Stopped rounds are still recorded; they are not counted or rescheduled.
  const deliverable =
    (isWhatsAppEnabled && resolveRecipient("whatsapp", candidate.phone ?? "").ok) ||
    (isEmailEnabled && resolveRecipient("email", candidate.email ?? "").ok);

  if (!isManual && app.currentStage === "ta_shortlist" && !deliverable) {
    console.log(`[Follow-up Outreach] Candidate ${candidate.fullName} has no deliverable contact channels. Transferring to TA Follow-up.`);
    const now = Date.now();
    await ctx.db.patch(applicationId, {
      currentStage: "follow_up",
      lastStageChangedAt: now,
      aiFollowUpNoReply: true,
      stageHistory: [
        ...(app.stageHistory ?? []),
        {
          stage: "follow_up",
          enteredAt: new Date().toISOString(),
          changedBy: "system" as any,
          note: "Transferred to TA Follow-up: No deliverable phone or email for AI follow-up.",
        },
      ],
    });
    await ctx.db.insert("pipelineEvents", {
      applicationId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      eventType: "ai_followup_no_contact_to_ta",
      fromStage: "ta_shortlist",
      toStage: "follow_up",
      actorType: "system",
      notes: "No deliverable phone or email for AI follow-up. Transferred to TA Follow-up.",
      createdAt: now,
    });
    await adjustJobStageStat(ctx, app.jobId, "ta_shortlist", "follow_up");
    await syncCandidateOverallStatus(ctx, app.candidateId);
    return;
  }

  if (options?.report) {
    options.report.sent = true;
    options.report.kind = isNudge ? "reminder" : "initial";
    options.report.blocked = !deliverable;
  }

  if (isNudge) {
    // === NUDGE REMINDER FLOW ===
    let messageToSend = app.nextFollowUpMessage || job.followUpSampleTemplate;
    if (!messageToSend) {
      messageToSend = `Hi ${candidate.fullName || "Candidate"},\n\nThis is a friendly reminder that we still need the following details for your ${job.title} application:\n${formattedMissingFields}\n\nPlease share them at your earliest convenience. Thank you!`;
    } else {
      messageToSend = messageToSend
        .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
        .replace(/{job_title}/g, job.title || "Job")
        .replace(/{missing_fields}/g, formattedMissingFields)
        .replace(/{company_name}/g, companyName);
    }

    // 1. WhatsApp Nudge
    let whatsappCommId: any = undefined;
    if (isWhatsAppEnabled) {
      whatsappCommId = await ctx.db.insert("communications", {
        candidateId: app.candidateId,
        jobId: app.jobId,
        applicationId: app._id,
        direction: "outbound",
        channel: "whatsapp",
        subject: `Follow-up: Missing info for your ${job.title} application`,
        body: messageToSend,
        deliveryStatus: "pending",
        sentAt: now,
        stoppedSequence: false,
        sequenceDay: app.followUpState?.lastContactDay || 0,
      });

      await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.sendWhatsApp, {
        communicationId: whatsappCommId,
        candidateId: app.candidateId,
        jobId: app.jobId,
        body: messageToSend,
      });
    }

    // 2. Email Nudge
    let emailCommId: any = undefined;
    if (isEmailEnabled && candidate.email) {
      let emailSubject = job.followUpEmailSubjectTemplate || `Action Required: Missing info for your ${job.title} application`;
      emailSubject = emailSubject
        .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
        .replace(/{job_title}/g, job.title || "Job");

      let emailBody = job.followUpEmailBodyTemplate || messageToSend;
      emailBody = emailBody
        .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
        .replace(/{job_title}/g, job.title || "Job")
        .replace(/{missing_fields}/g, formattedMissingFields)
        .replace(/{company_name}/g, companyName);

      const emailBodyHtml = buildStructuredEmailHtml({
        candidateName: candidate.fullName || "there",
        jobTitle: job.title,
        prelude: `This is a friendly reminder that your application for ${job.title} is still missing a few details.`,
        remainingMissing: missingFields,
      });

      emailCommId = await ctx.db.insert("communications", {
        candidateId: app.candidateId,
        jobId: app.jobId,
        applicationId: app._id,
        direction: "outbound",
        channel: "email",
        subject: emailSubject,
        body: emailBody,
        deliveryStatus: "pending",
        sentAt: now,
        stoppedSequence: false,
        sequenceDay: app.followUpState?.lastContactDay || 0,
      });

      await ctx.scheduler.runAfter(0, internal.communications.emailAgent.sendFollowUpEmail, {
        communicationId: emailCommId,
        candidateEmail: candidate.email,
        subject: emailSubject,
        body: emailBody,
        bodyHtml: emailBodyHtml,
        fromEmail: await assignedTaEmail(ctx, app, job),
      });
    }

    // 3. Increment attempts and reschedule nudge for 24h later
    if (sameRound) return whatsappCommId || emailCommId;
    if (!deliverable) {
      await ctx.db.patch(app._id, { nextFollowUpScheduledAt: undefined });
      return whatsappCommId || emailCommId;
    }
    await ctx.db.patch(app._id, {
      nextFollowUpScheduledAt: now + NUDGE_RESCHEDULE_MS,
      nextFollowUpMessage: undefined,
      followUpAttemptCount: currentAttempts + 1,
      followUpState: {
        ...app.followUpState,
        lastContactDay: currentAttempts === 1 ? 4 : 6, // Day 0 -> Day 4 -> Day 6
      }
    });

    console.log(`[Follow-up Nudge] Manual reminder sent to ${candidate.fullName}. Rescheduled next nudge.`);
    return whatsappCommId || emailCommId;

  } else {
    // === INITIAL OUTREACH FLOW (Day 0) ===
    // 1. WhatsApp Outreach
    if (isWhatsAppEnabled) {
      // Guard: only send WhatsApp if the candidate has a phone number.
      // sendMetaTemplate will throw if phone is empty — guard here prevents a crash in the scheduler.
      const candidatePhone = (candidate.phone || "").replace(/\D/g, "");
      if (candidatePhone) {
        // Schedule the actual WhatsApp delivery using Meta Approved Template
        await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
          applicationId: app._id,
          templateType: "initial_outreach",
        });
      } else {
        console.warn(
          `[Follow-up Outreach] Skipped WhatsApp for application ${applicationId}: candidate ${candidate.fullName ?? candidate._id} has no phone number. Email channel will still run.`
        );
      }
    }

    // 2. Email Outreach — the desk's approved first email (30 Sep), written as
    // the candidate's TA, naming the client only by its industry.
    let emailCommId: any = undefined;
    if (isEmailEnabled) {
      const ta = await assignedTa(ctx, app, job);
      const client = job.clientId ? await ctx.db.get(job.clientId) : null;
      const first = initialReachOutEmail({
        candidateName: candidate.fullName,
        gender: candidate.gender,
        taName: ta?.name,
        taEmail: ta?.email,
        jobTitle: job.title,
        clientIndustry: client?.industry,
        // "Colombo, Sri Lanka" → "Sri Lanka"
        country: (job.location ?? "").split(",").pop()?.trim(),
        asks: missingFields,
      });
      // Create Email communication record (pending — will be sent via Graph)
      emailCommId = await ctx.db.insert("communications", {
        candidateId: app.candidateId,
        jobId: app.jobId,
        applicationId: app._id,
        direction: "outbound",
        channel: "email",
        subject: first.subject,
        body: first.text,
        deliveryStatus: "pending",
        sentAt: now,
        stoppedSequence: false,
        sequenceDay: 0,
      });

      // Schedule the actual Email delivery via Microsoft Graph, from the TA's
      // mailbox (the system inbox when they have none).
      const candidateEmail = candidate.email;
      if (candidateEmail) {
        await ctx.scheduler.runAfter(0, internal.communications.graphEmail.sendGraphEmail, {
          communicationId: emailCommId,
          candidateJobId: app._id as string,
          taEmail: ta?.email ?? "",
          toAddress: candidateEmail,
          subject: first.subject,
          bodyHtml: first.html,
        });
      } else {
        console.warn(`[Follow-up Outreach] Skipped email for application ${applicationId}: candidate has no email address`);
        await ctx.db.patch(emailCommId, {
          deliveryStatus: "failed",
          errorMessage: "Candidate has no email address",
        });
      }
    }

    // 3. Persist state and schedule the next nudge 24 hours out
    if (sameRound) return emailCommId;
    if (!deliverable) {
      await ctx.db.patch(app._id, { followUpEnteredAt: app.followUpEnteredAt ?? now, nextFollowUpScheduledAt: undefined });
      return emailCommId;
    }
    const followUpState = app.followUpState;
    await ctx.db.patch(app._id, {
      followUpEnteredAt: app.followUpEnteredAt ?? now,
      nextFollowUpScheduledAt: now + NUDGE_RESCHEDULE_MS, // Schedule next sweep
      followUpAttemptCount: 1, // Set attempt count to 1 (Day 0 outreach complete)
      followUpState: {
        lastContactDay: 0,
        firstChannelUsed: followUpState?.firstChannelUsed ?? (isWhatsAppEnabled ? "whatsapp" : "email"),
      },
    });

    console.log(`[Follow-up Outreach] Day 0 outreach completed/scheduled for application ${applicationId}. Next sweep in 24 hours.`);
    return emailCommId;
  }
}

/**
 * Stops and cancels all pending/scheduled follow-up communications (both WhatsApp and Email)
 * for an application when it moves out of the follow_up stage (e.g. to ta_shortlist, interview, etc.).
 */
export async function stopFollowUpSequenceForApp(
  ctx: any,
  applicationId: Id<"applications">
): Promise<void> {
  const app = await ctx.db.get(applicationId);
  if (!app) return;

  // 1. Clear scheduled follow-up timestamps & TA review flags on the application
  await ctx.db.patch(applicationId, {
    nextFollowUpScheduledAt: undefined,
    nextFollowUpMessage: undefined,
    flaggedForTaReview: false,
    taReviewReason: undefined,
  });

  // 2. Mark any pending communications for this application as stopped/failed
  const pendingComms = await ctx.db
    .query("communications")
    .withIndex("by_applicationId", (q: any) => q.eq("applicationId", applicationId))
    .filter((q: any) => q.eq(q.field("deliveryStatus"), "pending"))
    .collect();

  for (const comm of pendingComms) {
    await ctx.db.patch(comm._id, {
      deliveryStatus: "failed",
      stoppedSequence: true,
      errorMessage: "Follow-up sequence stopped: Candidate moved out of follow_up stage.",
    });
  }
}
