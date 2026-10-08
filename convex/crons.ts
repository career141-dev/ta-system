import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildStructuredEmailHtml } from "./communications/emailHtml";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { sweepCovers } from "./lib/followUpScope";
import { assignedTaEmail } from "./pipeline/followUpHelper";
import { readCursor, writeCursor, readWindow, parseWindowCursor } from "./lib/cronCursor";
import { executeStageTransition } from "./pipeline/pipelineStateMachine";
import { directorReviewBlockers } from "./ta/stages";
import type { MutationCtx } from "./_generated/server";

/**
 * A stage move the sweep makes, through the state machine like every other
 * move. Patching `currentStage` here skipped what the state machine does on
 * the way: a candidate closed as unresponsive stayed active with no reason,
 * their pending reminders were not stopped, and no pipeline event recorded the
 * move (2 Oct). Nothing is started on the way in — the sweep's own moves never
 * sent anything, and still do not.
 */
async function sweepMove(
  ctx: MutationCtx,
  appId: Id<"applications">,
  targetStage: "follow_up" | "second_shortlist" | "unresponsive",
  reason: string,
) {
  await executeStageTransition(ctx, {
    applicationId: appId,
    targetStage,
    actorId: "system",
    reason,
    bypassRoleCheck: true,
    skipAutoOutreach: true,
  });
}

const crons = cronJobs();

export const evaluateFollowUpStage = internalMutation({
  args: {
    /** Only TA System openings (`followUpStartsOnSend`) — the staging sweep, see the bottom of this file. */
    taOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const taOnly = args.taOnly === true;
    // 1. Check Kill Switch
    const configRow = await ctx.db.query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", "system"))
      .first();
    if (configRow && configRow.autopilotEnabled === false) {
      console.log("Autopilot disabled via appSettings - skipping sweep");
      return;
    }
    
    const toggles = configRow?.channel_toggles;
    const whatsappFollowUpPaused = toggles?.whatsappFollowUp === false;
    const emailFollowUpPaused = toggles?.emailFollowUp === false;
    const allFollowUpsPaused = whatsappFollowUpPaused && emailFollowUpPaused;

    // 1. Fetch active jobs that have follow-up enabled (Dynamic across all active jobs)
    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    const followUpJobs = activeJobs.filter((j) => sweepCovers(j, taOnly));

    // 2. Fetch applications per follow-up job (capped to prevent cron lock).
    // Read per job rather than the first ten in the stage overall: those ten
    // could all belong to jobs with follow-up off, and the jobs that have it on
    // would never be reached. Candidates with nothing sent yet are included:
    // shortlisting sends the first message, and the sweep covers the ones where
    // that did not happen.
    //
    // Carried on from where the last run stopped (lib/cronCursor.ts), not
    // the oldest ten per stage every time. Rows the sweep then passes over —
    // flagged, do-not-contact, a TA opening waiting for its first Send — kept
    // those ten places for ever: nobody from the eleventh on was reminded,
    // advanced or closed, and once six openings filled the 60 no newer
    // opening was reached at all (2 Oct). Flagged rows, which the sweep never
    // touches, are left out of the read itself.
    const MAX_APPS_PER_RUN = 60;
    const cursorName = taOnly ? "followUpSweep.taOnly" : "followUpSweep";
    const picked = await readWindow(
      followUpJobs.flatMap((job) => (["follow_up", "ta_shortlist"] as const).map((stage) => `${job._id}|${stage}`)),
      parseWindowCursor(await readCursor(ctx, cursorName)),
      MAX_APPS_PER_RUN,
      (key, after, n) => {
        const [jobId, stage] = key.split("|");
        return ctx.db
          .query("applications")
          .withIndex("by_job_stage", (i) =>
            i.eq("jobId", jobId as Id<"jobs">).eq("currentStage", stage as any).gt("_creationTime", after),
          )
          .filter((q) => q.neq(q.field("flaggedForTaReview"), true))
          .take(n);
      },
    );
    await writeCursor(ctx, cursorName, picked.cursor ? JSON.stringify(picked.cursor) : null);
    const appsToEvaluate: any[] = picked.rows;

    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_CALLS_PER_RUN = 20;
    let aiCallsTriggeredThisRun = 0;

    function isWithinCallingHours(phone?: string) {
      if (!phone) return true; // Default allow if no phone available to check
      let offsetHours = 0; 
      if (phone.startsWith("+44") || phone.startsWith("07")) offsetHours = 0; // UK
      else if (phone.startsWith("+971")) offsetHours = 4; // UAE
      else if (phone.startsWith("+94")) offsetHours = 5.5; // Sri Lanka
      else if (phone.startsWith("+65")) offsetHours = 8; // Singapore
      else if (phone.startsWith("+1")) offsetHours = -5; // US EST roughly
      else if (phone.startsWith("+61")) offsetHours = 10; // Australia (AEST)
      
      const currentUtcHour = new Date().getUTCHours();
      const localHour = (currentUtcHour + offsetHours + 24) % 24;
      return localHour >= 9 && localHour < 20; // 9 AM to 8 PM
    }

    const jobCache = new Map<string, any>();

    // Batch candidate reads across all appsToEvaluate in a single parallel fetch (O(1) round-trip instead of N queries)
    const uniqueCandidateIds = Array.from(new Set(appsToEvaluate.map((a) => a.candidateId)));
    const candidateDocs = await Promise.all(
      uniqueCandidateIds.map((id) => ctx.db.get(id))
    );
    const candidateMap = new Map<string, any>();
    for (let i = 0; i < uniqueCandidateIds.length; i++) {
      if (candidateDocs[i]) {
        candidateMap.set(uniqueCandidateIds[i], candidateDocs[i]);
      }
    }

    /**
     * AI Follow-up to TA Follow-up. The follow-up clock keeps running from
     * when it started: the state machine restarts it on entering Follow-up,
     * which would restart the CV pipeline's day-tier reminders and its 7-day
     * close — more messages, not fewer.
     */
    const toTaFollowUp = async (app: any, reason: string) => {
      await sweepMove(ctx, app._id, "follow_up", reason);
      await ctx.db.patch(app._id, {
        aiFollowUpNoReply: true,
        nextFollowUpScheduledAt: undefined,
        nextFollowUpMessage: undefined,
        followUpEnteredAt: app.followUpEnteredAt,
      });
    };

    for (const app of appsToEvaluate) {
      // 1. Skip if application is flagged for TA review (automated nudging paused)
      if (app.flaggedForTaReview === true) {
        console.log(`[Follow-Up Cron] Application ${app._id} is flagged for TA review (${app.taReviewReason}). Skipping automated nudge.`);
        continue;
      }

      const candidate = candidateMap.get(app.candidateId);
      if (!candidate) continue;

      // 2. Enforce doNotContact
      if (candidate.doNotContact) {
        continue;
      }

      let job = jobCache.get(app.jobId);
      if (job === undefined) {
        job = await ctx.db.get(app.jobId);
        jobCache.set(app.jobId, job);
      }
      
      if (!job) continue;
      if (job.status !== "active") continue;
      // The first message now goes when the candidate is shortlisted
      // (ta/applications.ts). If it never went — no phone, no email, a provider
      // error — the sweep sends it rather than leaving the candidate waiting.

      // For AI Follow-up (ta_shortlist): Move to TA Follow-up within 1 day if candidate did not reply,
      // or if candidate has no contact channel.
      const enteredAt = app.followUpEnteredAt || app.lastStageChangedAt || app._creationTime;
      const timeInStage = now - enteredAt;
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const hasPhone = !!(candidate.phone ?? "").replace(/\D/g, "");
      const hasEmail = !!candidate.email;

      if (app.currentStage === "ta_shortlist") {
        const noContact = !hasPhone && !hasEmail;
        const oneDayExpiredNoReply = timeInStage >= ONE_DAY_MS && !app.lastCandidateReplyAt;

        if (noContact || oneDayExpiredNoReply) {
          console.log(`[Follow-Up Cron] AI Follow-up ${app._id} ${noContact ? "has no contact info" : "did not reply within 1 day"}. Moving to TA Follow-up.`);
          await toTaFollowUp(
            app,
            noContact
              ? "Moved to TA Follow-up: No phone or email available for AI follow-up."
              : "Moved to TA Follow-up: Candidate did not reply to AI follow-up within 1 day.",
          );
          continue;
        }
      }

      // 3. Enforce Max Attempt Ceiling (Terminal Stop Condition)
      const maxAttempts = job.maxFollowUpAttempts ?? 3;
      const currentAttempts = app.followUpAttemptCount || 0;
      // A TA System opening gives the last reminder its 24 hours before closing,
      // rather than closing at the next sweep, minutes after it went.
      const lastReminderStillOpen =
        job.followUpStartsOnSend === true && !!app.nextFollowUpScheduledAt && now < app.nextFollowUpScheduledAt;

      if (currentAttempts >= maxAttempts && !lastReminderStillOpen) {
        if (app.currentStage === "ta_shortlist") {
          console.log(`[Follow-Up Cron] Max attempts (${maxAttempts}) reached for AI follow-up ${app._id}. Moving to TA Follow-up.`);
          await toTaFollowUp(app, `Moved to TA Follow-up: Candidate did not reply after ${maxAttempts} AI follow-up attempts.`);
          continue;
        }
        console.log(`[Follow-Up Cron] Max attempts (${maxAttempts}) reached for application ${app._id}. Moving to unresponsive.`);
        await sweepMove(ctx, app._id, "unresponsive", `No reply after ${maxAttempts} follow-up attempts.`);
        continue;
      }

      // ── Per-application completion flags (not global candidate fields) ──────
      // Falls back to candidate record for legacy apps that predate the flags.
      // Complete means what Director Review accepts (ta/stages.ts): a CV,
      // expected salary and notice, where words like "Negotiable" count, and
      // current salary is not required. The sweep had its own stricter rule,
      // so somebody the desk could send on was chased and closed (2 Oct).
      const blockers = directorReviewBlockers(app, candidate);
      const hasCV = !blockers.includes("a CV");
      const hasExpectedSalary = !blockers.includes("expected salary");
      const hasNoticePeriod = !blockers.includes("notice period");
      // Still asked for in the reminders, but no longer holds anyone back.
      const hasCurrentSalary =
        app.followUpCurrentSalary === true ||
        (app.followUpCurrentSalary === undefined && candidate.currentSalary !== undefined);

      let customQuestionsComplete = true;
      const customQuestions = job.customFollowUpQuestions || [];
      const customAnswers = app.customFollowUpAnswers || {};
      for (const q of customQuestions) {
        if (!customAnswers[q]) {
          customQuestionsComplete = false;
          break;
        }
      }

      const allComplete = blockers.length === 0 && customQuestionsComplete;

      if (allComplete) {
        // All data collected — auto-advance to Second Shortlist immediately.
        // Current salary is not marked received: it is not required, and
        // marking it said the candidate had given it (2 Oct).
        await ctx.db.patch(app._id, {
          followUpCvReceived: true,
          followUpExpectedSalary: true,
          followUpNoticePeriod: true,
        });
        await sweepMove(
          ctx,
          app._id,
          "second_shortlist",
          customQuestions.length > 0
            ? "Auto-advanced from Follow-up: CV, expected salary, notice period and custom questions confirmed."
            : "Auto-advanced from Follow-up: CV, expected salary and notice period confirmed.",
        );
        continue;
      }

      const daysInStage = Math.floor(timeInStage / (24 * 60 * 60 * 1000));

      // 1. Check expiration if maxFollowUpDays is set
      const maxDaysMs = (typeof job.maxFollowUpDays === "number" && job.maxFollowUpDays > 0)
        ? job.maxFollowUpDays * 24 * 60 * 60 * 1000
        : null;

      if (maxDaysMs && timeInStage >= maxDaysMs && !allFollowUpsPaused) {
        await sweepMove(ctx, app._id, "unresponsive", `Profile still incomplete after ${job.maxFollowUpDays} days.`);
        await ctx.db.patch(app._id, {
          followUpState: {
            lastContactDay: app.followUpState?.lastContactDay ?? 0,
            firstChannelUsed: app.followUpState?.firstChannelUsed,
            replyChannel: "unresponsive",
          }
        });
        continue;
      }

      /*
       * A reply does NOT stop the sequence, by design (18 September).
       *
       * `communications/inboundExtraction.ts` answers it instead: DeepSeek
       * reads what the candidate wrote, records the salary, notice period and
       * the opening's own questions, writes back naming what is still missing,
       * and schedules the next nudge — honouring any date the candidate
       * promises. The sweep's job is only to carry on where that conversation
       * goes quiet. A person is pulled in when the AI cannot help
       * (`flaggedForTaReview`), not on every reply.
       */
      // 2. Check if a dynamic message is scheduled and it's time to send
      if (app.nextFollowUpScheduledAt && now >= app.nextFollowUpScheduledAt) {
        // ANTI-DUPLICATE LOCK: Clear nextFollowUpScheduledAt immediately so that
        // any concurrent cron run sees undefined and skips this app.
        // This is the first DB write in this block — it acts as a mutex.
        await ctx.db.patch(app._id, { nextFollowUpScheduledAt: undefined });

        // If we were waiting for Candidate's promised ETA:
        if (app.waitingForCandidateEta === true) {
          await ctx.db.patch(app._id, {
            waitingForCandidateEta: undefined,
            candidateEtaMs: undefined,
            candidateEtaText: undefined,
          });
          console.log(`[Dynamic Follow-up] ETA passed for ${candidate.fullName}. Resuming outreach.`);
        }
          // Check attempt count
          const currentAttempts = app.followUpAttemptCount || 0;
          if (job.maxFollowUpAttempts && currentAttempts >= job.maxFollowUpAttempts) {
             console.log(`[Dynamic Follow-up] Max attempts reached for ${candidate.fullName}. Skipping message.`);
             // nextFollowUpScheduledAt already cleared above
             continue; 
          }

          const missingList: string[] = [];
          if (!hasCV) missingList.push("• CV Document");
          if (!hasCurrentSalary) missingList.push("• Current Salary");
          if (!hasExpectedSalary) missingList.push("• Expected Salary");
          if (!hasNoticePeriod) missingList.push("• Notice Period");
          for (const q of customQuestions) {
            if (!customAnswers[q]) missingList.push(`• ${q}`);
          }
          const missingFormatted = missingList.join("\n");

          let messageToSend = app.nextFollowUpMessage || job.followUpInitialTemplate;
          if (!messageToSend) {
            messageToSend = `Hi ${candidate.fullName || "Candidate"},\n\nThank you for applying for the ${job.title} role!\n\nTo progress your application, please provide the following details:\n${missingFormatted}\n\nPlease reply at your earliest convenience.\n\nBest regards,\nTalent Acquisition Team`;
          } else {
            messageToSend = messageToSend
              .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
              .replace(/{job_title}/g, job.title || "Job")
              .replace(/{missing_fields}/g, missingFormatted);
          }

          // Send via WhatsApp if enabled
          if (!whatsappFollowUpPaused && (job.enableWhatsAppFollowUp !== false)) { 
            if (currentAttempts === 0 && !app.nextFollowUpMessage) {
              await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
                applicationId: app._id,
                templateType: "initial_outreach",
              });
              console.log(`[Dynamic Follow-up] Dispatched initial Meta template outreach for ${candidate.fullName}`);
            } else {
              const commId = await ctx.db.insert("communications", {
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
                sequenceDay: daysInStage,
              });

              await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.sendWhatsApp, {
                communicationId: commId,
                candidateId: app.candidateId,
                jobId: app.jobId,
                body: messageToSend,
              });
            }
          }

          // Send via Email if enabled
          if (!emailFollowUpPaused && (job.enableEmailFollowUp !== false) && candidate.email) {
            let emailSubject = job.followUpEmailSubjectTemplate || `Action Required: Missing info for your ${job.title} application`;
            emailSubject = emailSubject
              .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
              .replace(/{job_title}/g, job.title || "Job");

            let emailBody = job.followUpEmailBodyTemplate || messageToSend;
            emailBody = emailBody
              .replace(/{candidate_name}/g, candidate.fullName || "Candidate")
              .replace(/{job_title}/g, job.title || "Job")
              .replace(/{missing_fields}/g, missingFormatted);

            // Clean natural-text HTML rendering for the nudge email
            const emailBodyHtml = buildStructuredEmailHtml({
              candidateName: candidate.fullName || "there",
              jobTitle: job.title,
              prelude: `This is a friendly reminder that your application for ${job.title} is still missing a few details.`,
              remainingMissing: missingList.length > 0
                ? missingList.map((m) => m.replace(/^•\s*/, ""))
                : undefined,
            });

            const commId = await ctx.db.insert("communications", {
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
              sequenceDay: daysInStage,
            });

            await ctx.scheduler.runAfter(0, internal.communications.emailAgent.sendFollowUpEmail, {
              communicationId: commId,
              candidateEmail: candidate.email,
              subject: emailSubject,
              body: emailBody,
              bodyHtml: emailBodyHtml,
              // From the assigned TA's own mailbox.
              fromEmail: await assignedTaEmail(ctx, app, job),
            });
          }

          // Increment the attempt counter and auto-reschedule the next fallback nudge
          // for 24 hours out. The profile is still incomplete at this point (otherwise
          // the app would have been auto-advanced to second_shortlist above), and the
          // max-attempt ceiling check at the top of this loop will transition the app
          // to unresponsive once the final nudge has been dispatched.
          const NUDGE_RESCHEDULE_MS = 24 * 60 * 60 * 1000; // 24 hours (1 day)
          await ctx.db.patch(app._id, {
            nextFollowUpScheduledAt: now + NUDGE_RESCHEDULE_MS,
            nextFollowUpMessage: undefined,
            followUpAttemptCount: currentAttempts + 1,
          });

          console.log(`[Dynamic Follow-up] Sent scheduled message to ${candidate.fullName}. Auto-rescheduling next nudge in 24 hours (attempt ${currentAttempts + 1}).`);
          continue;
        }

      // A TA System opening runs on the scheduled reminders above only. The
      // day-tier flow below would send a second message on day 4 and 6 on top
      // of them.
      if (job.followUpStartsOnSend === true) continue;

      // --- LEGACY STATIC FLOW ---
      // 1. First, check if 7 days have elapsed without collecting all required fields.
      // If 7 days elapsed, move to Unresponsive (not rejected)
      // DA will manually call these candidates using the Unresponsive sub-section
      // in the Follow-up tab. AI voice call is suspended.
      // Note: We suspend the 7-day expiration timer if ALL follow-up channels are globally paused.
      if (timeInStage >= SEVEN_DAYS_MS && !allFollowUpsPaused) {
        await sweepMove(ctx, app._id, "unresponsive", "Profile still incomplete after 7 days in Follow-up.");
        await ctx.db.patch(app._id, {
          followUpState: {
            lastContactDay: app.followUpState?.lastContactDay ?? 0,
            firstChannelUsed: app.followUpState?.firstChannelUsed,
            replyChannel: "unresponsive",
          }
        });
        continue;
      }

      // 2. If under 7 days, check if candidate promised an ETA and handle the hold window
      if (app.waitingForCandidateEta === true) {
        if (now < (app.candidateEtaMs || 0)) {
          console.log(`[Follow-up] Candidate ${candidate.fullName} is within promised ETA window. Skipping static check-in.`);
          continue; // Hold sequence
        } else {
          // ETA passed! Clear the ETA flags.
          await ctx.db.patch(app._id, {
            waitingForCandidateEta: undefined,
            candidateEtaMs: undefined,
            candidateEtaText: undefined,
          });
          console.log(`[Follow-up] Candidate ${candidate.fullName} missed promised ETA. Resuming static flow.`);
        }
      }

      const inboundComms = await ctx.db.query("communications")
        .withIndex("by_applicationId", (q: any) => q.eq("applicationId", app._id))
        .filter((q: any) => q.eq(q.field("direction"), "inbound"))
        .collect();

      const hasRepliedMessage = inboundComms.some((c: any) => {
        const sentAtMs = typeof c.sentAt === "number" ? c.sentAt : Number(c.sentAt);
        return sentAtMs >= enteredAt;
      });

      const completedCalls = await ctx.db.query("aiCalls")
        .withIndex("by_application", (q: any) => q.eq("applicationId", app._id))
        .filter((q: any) => q.eq(q.field("callStatus"), "completed"))
        .collect();

      const hasCompletedCall = completedCalls.some((c: any) => c.calledAt >= enteredAt);

      const hasReplied = hasRepliedMessage || hasCompletedCall;

      if (hasReplied) {
        // Record the platform they replied on if not already done
        if (!app.followUpState?.replyChannel) {
          let replyChannel = "unknown";
          if (hasRepliedMessage) {
            const sortedReplies = inboundComms
              .filter((c: any) => {
                const sentAtMs = typeof c.sentAt === "number" ? c.sentAt : Number(c.sentAt);
                return sentAtMs >= enteredAt;
              })
              .sort((a: any, b: any) => {
                const aTime = typeof a.sentAt === "number" ? a.sentAt : Number(a.sentAt);
                const bTime = typeof b.sentAt === "number" ? b.sentAt : Number(b.sentAt);
                return aTime - bTime;
              });
            replyChannel = sortedReplies[0]?.channel ?? "unknown";
          } else if (hasCompletedCall) {
            replyChannel = "phone";
          }
          await ctx.db.patch(app._id, {
            followUpState: {
              lastContactDay: app.followUpState?.lastContactDay ?? 0,
              firstChannelUsed: app.followUpState?.firstChannelUsed,
              replyChannel,
            }
          });
        }

        // The pause itself is handled once for both flows, above (1c).
      }

      // Day-tier outreach scheduling
      let targetDay: number | null = null;
      if (daysInStage === 0) targetDay = 0;
      else if (daysInStage === 2) targetDay = 2; // Day 3
      else if (daysInStage === 4) targetDay = 4; // Day 5
      else if (daysInStage === 6) targetDay = 6; // Day 7

      if (targetDay === null) continue; // Off-days (1, 3, 5) intentionally silent

      // Idempotency: skip if this day tier (or later) was already dispatched
      const followUpState = app.followUpState;
      if (followUpState !== undefined && followUpState.lastContactDay >= targetDay) continue;

      let triggerWhatsApp = false;
      let triggerAiCall = false;

      // WhatsApp only. This flow also "sent" an email: it wrote a
      // communications row marked sent and nothing ever delivered it, so the
      // candidate's history showed emails they never got (2 Oct). The row is
      // gone; no email is sent in its place.
      if (targetDay === 0 || targetDay === 4 || targetDay === 6) {
        triggerWhatsApp = !whatsappFollowUpPaused;
      } else if (targetDay === 2) {
        // AI voice call suspended (Sri Lankan phone number not yet available).
        // Backend code in elevenlabs.ts remains intact for future reactivation.
        // Day 2 is intentionally silent — next contact is Day 4 WhatsApp/Email.
        continue;
      }

      // If all scheduled actions for this day are paused, skip the rest to avoid empty states
      if (!triggerWhatsApp && !triggerAiCall) continue;

      // 3 & 4. Rate Limiting and Calling Hours for AI Calls
      if (triggerAiCall) {
        if (aiCallsTriggeredThisRun >= MAX_CALLS_PER_RUN) {
          console.log(`[Follow-up Day 2] Deferring AI Call for ${candidate.fullName ?? "unknown"} - Max calls per run reached.`);
          continue;
        }
        if (!isWithinCallingHours(candidate.phone)) {
          console.log(`[Follow-up Day 2] Deferring AI Call for ${candidate.fullName ?? "unknown"} - Outside calling hours for phone ${candidate.phone}.`);
          continue;
        }
      }

      // Persist updated state AFTER passing deferral checks
      await ctx.db.patch(app._id, {
        followUpState: {
          ...(followUpState ?? {}),
          lastContactDay: targetDay,
          firstChannelUsed: followUpState?.firstChannelUsed ?? "whatsapp",
        },
      });

      // ── Send message (only about MISSING fields) ─────────────────────────────
      const missingFields: string[] = [];
      if (!hasCV) missingFields.push("CV / Resume");
      if (!hasCurrentSalary) missingFields.push("Current Salary");
      if (!hasExpectedSalary) missingFields.push("Expected Salary");
      if (!hasNoticePeriod) missingFields.push("Notice Period");

      const body = [
        `Hi ${candidate.fullName || "there"},`,
        `We're still waiting on the following to progress your application for **${job.title}**:`,
        missingFields.map(f => `• ${f}`).join("\n"),
        `Please share these at your earliest convenience. Thank you!`,
      ].join("\n\n");

      if (triggerWhatsApp) {
        if (targetDay === 0) {
          await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
            applicationId: app._id,
            templateType: "initial_outreach",
          });
          console.log(`[Follow-up Day 0] Dispatched Meta template outreach for ${candidate.fullName ?? "unknown"}`);
        } else {
          const commId = await ctx.db.insert("communications", {
            candidateId: app.candidateId,
            jobId: app.jobId,
            applicationId: app._id,
            direction: "outbound",
            channel: "whatsapp",
            subject: `Action Required: Missing info for your ${job.title} application`,
            body,
            deliveryStatus: "pending",
            sentAt: now,
            stoppedSequence: false,
            sequenceDay: targetDay,
          });

          await ctx.scheduler.runAfter(0, internal.communications.whatsappOutbound.sendWhatsApp, {
            communicationId: commId,
            candidateId: app.candidateId,
            jobId: app.jobId,
            body,
          });

          console.log(`[Follow-up Day ${targetDay}] Scheduled WhatsApp to ${candidate.fullName ?? "unknown"}`);
        }
      }

      // ── Follow-up AI call (Day 2 elapsed / Day 3) ─────────────────────────
      if (triggerAiCall) {
        aiCallsTriggeredThisRun++;
        
        const newAiCallId = await ctx.db.insert("aiCalls", {
          candidateId: app.candidateId,
          jobId: app.jobId,
          applicationId: app._id,
          triggerType: "followup_retry",
          callStatus: "scheduled",
          callScriptUsed: "initial_screening",
          companyHidden: false,
          calledAt: now,
          followUpTriggered: true,
          attempts: 1,
        });

        await ctx.scheduler.runAfter(0, internal.integrations.livekitSip.dispatchManualVoiceCall, {
          aiCallId: newAiCallId,
          kind: "follow_up",
          attemptNumber: 1,
          lastContactChannel: "WhatsApp",
        });

        console.log(`[Follow-up Day ${targetDay}] AI Follow-up call queued for ${candidate.fullName ?? "unknown"}`);
      }
    }
  },
});

// ── CRON STAGGERING ──────────────────────────────────────────────────────────
// crons.interval anchors every job to the same deploy timestamp, so jobs sharing
// an interval fire on the same tick forever. Ten jobs previously shared 1/2/5/10
// minute intervals and collided constantly, saturating the backend. Each
// recurring job now uses a distinct prime interval, so no two ever re-align.
crons.interval(
  "evaluate-follow-up",
  { minutes: 7 },
  internal.crons.evaluateFollowUpStage,
  {}
);

crons.interval(
  "fail-stale-voice-sessions",
  { minutes: 23 },
  internal.aiCalls.voiceCalls.failStaleVoiceCallSessions,
);

crons.daily(
  "renew-graph-subscriptions",
  { hourUTC: 3, minuteUTC: 0 }, // Runs daily at 03:00 UTC
  internal.communications.graphSubscriptions.renewExpiringSubscriptions
);

// Poll linkedin's inbox every 13 minutes
crons.interval(
  "poll-linkedin-inbox",
  { minutes: 13 },
  internal.communications.emailAgent.pollEmailInbox,
  { inboxEmail: "linkedin@career141.com" }
);

// Poll general CV inbox every 11 minutes
crons.interval(
  "poll-cv-inbox",
  { minutes: 11 },
  internal.communications.emailAgent.pollEmailInbox,
  { inboxEmail: "cv@career141.com" }
);

// Poll job sender mailbox every 3 minutes for candidate email follow-up replies.
// Kept the shortest of the email polls — this is the candidate-facing reply path.
crons.interval(
  "poll-jobs-sender-inbox",
  { minutes: 3 },
  internal.communications.emailAgent.pollEmailInbox,
  { inboxEmail: "job@career141.com" }
);

// Poll per-job dedicated email inboxes (configured via job channel settings) every 17 minutes.
// System inboxes (linkedin@, cv@, job@) are excluded from this run — they have their own cron entries above.
crons.interval(
  "poll-per-job-email-inboxes",
  { minutes: 17 },
  internal.communications.emailAgent.scheduleEmailPolling,
  {}
);

export const checkSlaBreaches = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Check Kill Switch
    const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    if (configRow && configRow.autopilotEnabled === false) return;

    // Only the stages it has a limit for, on active openings, carried on from
    // where the last run stopped (lib/cronCursor.ts). It read the 500 oldest
    // active applications every day — whatever their stage or opening — so
    // anything newer was never checked (2 Oct). Safety cap: 500 per run.
    const SLA_STAGES = ["ta_shortlist", "director_shortlist", "client_review", "interview", "offer", "second_shortlist", "ai_call"];
    const activeJobs = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "active")).collect();
    const picked = await readWindow(
      activeJobs.flatMap((job) => SLA_STAGES.map((stage) => `${job._id}|${stage}`)),
      parseWindowCursor(await readCursor(ctx, "slaBreaches")),
      500,
      (key, after, n) => {
        const [jobId, stage] = key.split("|");
        return ctx.db
          .query("applications")
          .withIndex("by_job_stage", (i) =>
            i.eq("jobId", jobId as Id<"jobs">).eq("currentStage", stage as any).gt("_creationTime", after),
          )
          .filter((q) => q.eq(q.field("isActive"), true))
          .take(n);
      },
    );
    await writeCursor(ctx, "slaBreaches", picked.cursor ? JSON.stringify(picked.cursor) : null);

    const jobCache = new Map<string, any>(activeJobs.map((j) => [j._id as string, j]));

    for (const app of picked.rows) {
      if (!app.lastStageChangedAt) continue;

      const job = jobCache.get(app.jobId);
      if (!job || job.status !== "active") continue;

      let slaLimit = 0;
      let stageName = "";
      switch (app.currentStage) {
        case "ta_shortlist":
          slaLimit = job.slaTaReviewDays ?? 2;
          stageName = "TA Review";
          break;
        case "director_shortlist":
          slaLimit = job.slaDirectorReviewDays ?? 3;
          stageName = "Director Review";
          break;
        case "client_review":
          slaLimit = job.slaClientReviewDays ?? 5;
          stageName = "Client Review";
          break;
        case "interview":
          slaLimit = job.slaInterviewDays ?? 3;
          stageName = "Interview";
          break;
        case "offer":
          slaLimit = job.slaOfferDays ?? 2;
          stageName = "Offer";
          break;
        case "second_shortlist":
          slaLimit = job.slaSecondShortlistDays ?? 2;
          stageName = "2nd Shortlist";
          break;
        case "ai_call":
          slaLimit = job.slaAiCallDays ?? 1;
          stageName = "AI Call";
          break;
        default:
          continue;
      }

      const msElapsed = Date.now() - app.lastStageChangedAt;
      const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);

      if (daysElapsed > slaLimit) {
        // Check for existing notification using index - avoid full-table filter scan
        const existingNotifs = await ctx.db.query("notifications")
          .withIndex("by_user", q => q.eq("userId", job.primaryRecruiterId!))
          .filter(q => q.and(
            q.eq(q.field("type"), "sla_breached"),
            q.eq(q.field("candidateId"), app.candidateId),
            q.eq(q.field("jobId"), app.jobId)
          )).collect();
        
        // Prevent spam: only alert once per stage entry
        const recentNotif = existingNotifs.find(n => new Date(n.createdAt).getTime() > app.lastStageChangedAt);
        
        if (!recentNotif && job.primaryRecruiterId) {
           const candidate = await ctx.db.get(app.candidateId);
           await ctx.db.insert("notifications", {
              userId: job.primaryRecruiterId,
              type: "sla_breached",
              title: "Pipeline SLA Breached",
              body: `${candidate?.fullName || "A candidate"} has been stuck in ${stageName} for ${Math.floor(daysElapsed)} days (Limit: ${slaLimit}).`,
              candidateId: app.candidateId,
              jobId: app.jobId,
              read: false,
              createdAt: new Date().toISOString()
           });
           console.log(`[SLA] Breached for ${candidate?.fullName} in ${stageName}`);
        }
      }
    }
  }
});

crons.daily(
  "check-sla-breaches",
  { hourUTC: 8, minuteUTC: 0 },
  internal.crons.checkSlaBreaches
);

crons.interval(
  "update-dashboard-stats-cache",
  { minutes: 19 },
  internal.stats.stats.updateDashboardStatsCache
);

crons.interval(
  "recover-stuck-uploads",
  { minutes: 29 },
  internal.cvs.cvUploads.recoverStuckUploads
);

crons.interval(
  "process-unextracted-cv-queue",
  { minutes: 2 },
  internal.cvs.cvExtraction.processUnextractedQueueCron
);

// Background healer: recovers stuck "healing" uploads and re-extracts empty profiles
// (up to 5 per tick). Keep HEALER_INTERVAL_MINUTES in cvs/healer.ts in sync.
crons.interval(
  "bg-healer-cv-extractor",
  { minutes: 31 },
  internal.cvs.healerActions.healNextUnparsedCandidate
);

crons.interval(
  "watchdog-mailbox-scan-healer",
  { minutes: 5 },
  internal.communications.emailBackfillMutations.recoverStalledMailboxScans
);

crons.interval(
  "bg-sept5-reextractor",
  { minutes: 1 },
  internal.cvs.sept5ReextractorActions.runSept5ReextractionTick
);

/**
 * The background automation, switchable off.
 *
 * These jobs were written for the production deployment: they poll three
 * mailboxes, work the CV extraction queue, reap voice sessions and chase
 * candidates. On a development machine restored from a production backup they
 * do none of that usefully — there are no credentials and no network path —
 * but they still run every few minutes, restart isolates on timeout and starve
 * the backend of the capacity a deploy needs. A push that took seconds began
 * taking two minutes and then failing outright.
 *
 * `C141_DISABLE_CRONS=true` on the deployment turns them off. It defaults to
 * ON so that production behaviour is unchanged by this file existing: a
 * deployment that has never heard of the variable keeps every job it had.
 */
const disabled = (process.env.C141_DISABLE_CRONS ?? "").trim().toLowerCase() === "true";

/**
 * TA System mail intake (convex/mailIntake), kept apart from everything above.
 *
 * It reads linkedin@, cv@ and job@ through Graph delta queries and never marks
 * mail read, moves it or replies — so the CV platform's own polling above sees
 * every message exactly as before, and nothing here depends on it.
 *
 * Registered only with `C141_MAIL_INTAKE=on`, and each mailbox is switched on
 * separately in Settings → Mailboxes. Because it contacts nobody it also runs
 * where `C141_DISABLE_CRONS=true` has switched the rest off (staging).
 */
const mailIntakeOn = (process.env.C141_MAIL_INTAKE ?? "").trim().toLowerCase() === "on";

function addMailIntake(registry: ReturnType<typeof cronJobs>) {
  if (!mailIntakeOn) return;
  registry.interval("ta-mail-intake-sync", { minutes: 5 }, internal.mailIntake.sync.syncAll, {});
  registry.interval("ta-mail-intake-process", { minutes: 1 }, internal.mailIntake.process.processReady, {});
}

/**
 * Keeping the CV pipeline unstuck, where the rest of the automation is off.
 *
 * A CV that fails extraction — a timeout, a rate limit, a bad page — sits in
 * `processing` for ever unless something frees it. The CV platform runs these
 * three the whole time; without them, the TA System's own arrivals quietly
 * pile up (17 September: 141 CVs stuck behind one timeout). None of them
 * contacts anybody: they read files, re-read a record and move a status.
 *
 * `C141_TA_MAINTENANCE=on` registers them where `C141_DISABLE_CRONS=true` has
 * switched the CV platform's own jobs off. The healer takes one record per
 * tick and never retries the same one twice, so a poison file cannot loop and
 * the model spend stays bounded.
 */
const maintenanceOn = (process.env.C141_TA_MAINTENANCE ?? "").trim().toLowerCase() === "on";

function addMaintenance(registry: ReturnType<typeof cronJobs>) {
  if (!maintenanceOn) return;
  registry.interval("ta-cv-queue", { minutes: 2 }, internal.cvs.cvExtraction.processUnextractedQueueCron, {});
  registry.interval("ta-cv-stuck-uploads", { minutes: 29 }, internal.cvs.cvUploads.recoverStuckUploads, {});
  registry.interval("ta-cv-healer", { minutes: 31 }, internal.cvs.healerActions.healNextUnparsedCandidate, {});
  // Nothing outbound: it writes a notification for the recruiter on a stage
  // that has overrun its SLA.
  registry.daily("ta-sla-breaches", { hourUTC: 8, minuteUTC: 0 }, internal.crons.checkSlaBreaches, {});
}

/**
 * Empty the Bin: clients and openings deleted seven days ago go for good
 * (ta/bin.ts). It removes only our own records and sends nothing, so it runs
 * on both registries.
 */
function addBin(registry: ReturnType<typeof cronJobs>) {
  registry.daily("ta-empty-bin", { hourUTC: 21, minuteUTC: 30 }, internal.ta.bin.emptyDue, {});
}

/** A sent end-of-day email's copies are deleted once their month is over (8 Oct). On both registries, like the Bin. */
function addEodCopies(registry: ReturnType<typeof cronJobs>) {
  registry.interval("ta-purge-eod-copies", { minutes: 41 }, internal.ta.eodCopies.purgeExpired, {});
}

addMailIntake(crons);
addBin(crons);
addEodCopies(crons);
const quiet = cronJobs();
addMailIntake(quiet);
addBin(quiet);
addEodCopies(quiet);
// Only on the quiet registry: where every cron runs, the CV platform's own
// queue, healer and SLA jobs above already cover this.
addMaintenance(quiet);

/**
 * The follow-up reminders for TA System openings only, where the rest is off.
 *
 * `C141_TA_FOLLOW_UP=on` registers the sweep with `taOnly`, so a deployment
 * with `C141_DISABLE_CRONS=true` (staging) can run the reminders for openings
 * switched on from the TA System without waking the CV platform's own jobs.
 * It does message people, so it only belongs where the outreach gate and the
 * outbound lock keep those messages to the test recipients. Where every cron
 * runs, the full sweep above already covers these openings.
 */
if ((process.env.C141_TA_FOLLOW_UP ?? "").trim().toLowerCase() === "on") {
  quiet.interval("ta-evaluate-follow-up", { minutes: 7 }, internal.crons.evaluateFollowUpStage, { taOnly: true });
}

export default disabled ? quiet : crons;


