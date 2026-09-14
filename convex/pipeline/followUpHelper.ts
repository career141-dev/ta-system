import { Id } from "../_generated/dataModel";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { internal } from "../_generated/api";
import { adjustJobStageStat } from "../jobs/stats";
import { buildStructuredEmailHtml } from "../communications/emailHtml";

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

    const hasCV = app.followUpCvReceived === true || !!candidate.cvUploadId || !!app.cvFileId || candidate.isParsed === true;
    const hasCurrent = candidate.currentSalary !== undefined && candidate.currentSalary !== null;
    const hasExpected = candidate.expectedSalary !== undefined && candidate.expectedSalary !== null;
    const hasNotice = candidate.noticePeriodDays !== undefined && candidate.noticePeriodDays !== null;

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

  if (candidate.currentSalary !== undefined && candidate.currentSalary !== null) {
    if (!app.followUpCurrentSalary) updates.followUpCurrentSalary = true;
    if (app.candidateCurrentSalary !== candidate.currentSalary) updates.candidateCurrentSalary = candidate.currentSalary;
  }

  if (candidate.expectedSalary !== undefined && candidate.expectedSalary !== null) {
    if (!app.followUpExpectedSalary) updates.followUpExpectedSalary = true;
    if (app.candidateExpectedSalary !== candidate.expectedSalary) updates.candidateExpectedSalary = candidate.expectedSalary;
  }

  if (candidate.noticePeriodDays !== undefined && candidate.noticePeriodDays !== null) {
    if (!app.followUpNoticePeriod) updates.followUpNoticePeriod = true;
    if (app.candidateNoticePeriodDays !== candidate.noticePeriodDays) updates.candidateNoticePeriodDays = candidate.noticePeriodDays;
  }

  if (Object.keys(updates).length > 0) {
    await ctx.db.patch(applicationId, updates);
  }
}

/**
 * Initiates the follow-up outreach flow when a candidate first arrives at the follow_up stage.
 * Immediately builds and schedules the Day 0 WhatsApp notification outlining missing fields.
 */
export async function initiateFollowUpOutreach(
  ctx: any,
  applicationId: Id<"applications">,
  options?: { isManual?: boolean }
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

  if (isManual) {
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
  const isNudge = currentAttempts > 0;

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
      });
    }

    // 3. Increment attempts and reschedule nudge for 24h later
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

    // 2. Email Outreach
    let emailCommId: any = undefined;
    if (isEmailEnabled) {
      // Create Email communication record (pending — will be sent via Graph)
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
        sequenceDay: 0,
      });

      // Schedule the actual Email delivery via Microsoft Graph
      const recruiter = await ctx.db.get(job.primaryRecruiterId);
      const taEmail = recruiter?.email;
      const candidateEmail = candidate.email;

      if (taEmail && candidateEmail) {
        const htmlBody = buildStructuredEmailHtml({
          candidateName: candidate.fullName || "there",
          jobTitle: job.title,
          missingHeader: `We're still waiting on the following to progress your application for ${job.title}:`,
          remainingMissing: missingFields,
          ctaText: "Please share these at your earliest convenience. Thank you!",
        });
        await ctx.scheduler.runAfter(0, internal.communications.graphEmail.sendGraphEmail, {
          communicationId: emailCommId,
          candidateJobId: app._id as string,
          taEmail,
          toAddress: candidateEmail,
          subject: `Action Required: Missing info for your ${job.title} application`,
          bodyHtml: htmlBody,
        });
      } else {
        console.warn(
          `[Follow-up Outreach] Skipped email: taEmail=${taEmail ?? "missing"}, candidateEmail=${candidateEmail ?? "missing"}`
        );
        // Mark the email comm as failed if we can't send it
        await ctx.db.patch(emailCommId, {
          deliveryStatus: "failed",
          errorMessage: !taEmail
            ? "Recruiter has no email configured"
            : "Candidate has no email address",
        });
      }
    }

    // 3. Persist state and schedule the next nudge 24 hours out
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
