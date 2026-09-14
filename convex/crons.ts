import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { adjustJobStageStat } from "./jobs/stats";
import { buildStructuredEmailHtml } from "./communications/emailHtml";

const crons = cronJobs();

export const evaluateFollowUpStage = internalMutation({
  args: {},
  handler: async (ctx) => {
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

    const followUpJobs = activeJobs.filter(
      (j) => j.agent3Enabled === true && (j.enableWhatsAppFollowUp === true || j.enableEmailFollowUp === true)
    );
    const followUpJobIds = new Set(followUpJobs.map((j) => j._id));

    // 2. Fetch applications ONLY for active follow-up jobs (Capped to 10 per stage to prevent cron lock)
    const followUpApps = await ctx.db
      .query("applications")
      .withIndex("by_stage", (q) => q.eq("currentStage", "follow_up"))
      .take(10);

    const taShortlistApps = await ctx.db
      .query("applications")
      .withIndex("by_stage", (q) => q.eq("currentStage", "ta_shortlist"))
      .take(10);

    const appsToEvaluate = [
      ...followUpApps.filter((a) => followUpJobIds.has(a.jobId)),
      ...taShortlistApps.filter((a) => followUpJobIds.has(a.jobId)),
    ];

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

      // 3. Enforce Max Attempt Ceiling (Terminal Stop Condition)
      const maxAttempts = job.maxFollowUpAttempts ?? 3;
      const currentAttempts = app.followUpAttemptCount || 0;

      if (currentAttempts >= maxAttempts) {
        console.log(`[Follow-Up Cron] Max attempts (${maxAttempts}) reached for application ${app._id}. Moving to unresponsive.`);
        await ctx.db.patch(app._id, {
          currentStage: "unresponsive",
          lastStageChangedAt: now,
          nextFollowUpScheduledAt: undefined,
          stageHistory: [
            ...(app.stageHistory ?? []),
            {
              stage: "unresponsive",
              enteredAt: new Date().toISOString(),
              changedBy: "system" as any,
              note: `Auto-moved to Unresponsive: Reached max follow-up attempt limit (${maxAttempts} attempts).`,
            },
          ],
        });
        await ctx.db.insert("pipelineEvents", {
          applicationId: app._id,
          candidateId: app.candidateId,
          jobId: app.jobId,
          eventType: "unresponsive_max_attempts",
          fromStage: app.currentStage,
          toStage: "unresponsive",
          actorType: "system",
          notes: `Auto-moved to Unresponsive: Exceeded ${maxAttempts} max follow-up attempts.`,
          createdAt: now,
        });
        await adjustJobStageStat(ctx, app.jobId, app.currentStage, "unresponsive");
        await ctx.scheduler.runAfter(0, internal.candidates.candidates.syncCandidateOverallStatusInternal, { candidateId: app.candidateId });
        continue;
      }

      // ── Per-application completion flags (not global candidate fields) ──────
      // Falls back to candidate record for legacy apps that predate the flags.
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

      let customQuestionsComplete = true;
      const customQuestions = job.customFollowUpQuestions || [];
      const customAnswers = app.customFollowUpAnswers || {};
      for (const q of customQuestions) {
        if (!customAnswers[q]) {
          customQuestionsComplete = false;
          break;
        }
      }

      const allFourComplete = hasCV && hasCurrentSalary && hasExpectedSalary && hasNoticePeriod && customQuestionsComplete;

      if (allFourComplete) {
        // All data collected — auto-advance to Second Shortlist immediately
        await ctx.db.patch(app._id, {
          currentStage: "second_shortlist",
          lastStageChangedAt: now,
          followUpCvReceived: true,
          followUpCurrentSalary: true,
          followUpExpectedSalary: true,
          followUpNoticePeriod: true,
          stageHistory: [
            ...(app.stageHistory ?? []),
            {
              stage: "second_shortlist",
              enteredAt: new Date().toISOString(),
              changedBy: "system" as any,
              note: customQuestions.length > 0 
                ? "Auto-advanced from Follow-up: All standard data and custom questions confirmed."
                : "Auto-advanced from Follow-up: All 4 standard data points confirmed.",
            },
          ],
        });
        await adjustJobStageStat(ctx, app.jobId, app.currentStage, "second_shortlist");
        await ctx.scheduler.runAfter(0, internal.candidates.candidates.syncCandidateOverallStatusInternal, { candidateId: app.candidateId });
        continue;
      }

      // Fallback to lastStageChangedAt or _creationTime if followUpEnteredAt is not set
      const enteredAt = app.followUpEnteredAt || app.lastStageChangedAt || app._creationTime;
      const timeInStage = now - enteredAt;
      const daysInStage = Math.floor(timeInStage / (24 * 60 * 60 * 1000));

      // 1. Check expiration if maxFollowUpDays is set
      const maxDaysMs = (typeof job.maxFollowUpDays === "number" && job.maxFollowUpDays > 0)
        ? job.maxFollowUpDays * 24 * 60 * 60 * 1000
        : null;

      if (maxDaysMs && timeInStage >= maxDaysMs && !allFollowUpsPaused) {
        // move to unresponsive
        await ctx.db.patch(app._id, {
          currentStage: "unresponsive",
          lastStageChangedAt: now,
          stageHistory: [
            ...(app.stageHistory ?? []),
            {
              stage: "unresponsive",
              enteredAt: new Date().toISOString(),
              changedBy: "system" as any,
              note: `Auto-moved to Unresponsive: Profile still incomplete after ${job.maxFollowUpDays} days.`,
            },
          ],
        });
        await ctx.db.patch(app._id, {
          followUpState: {
            lastContactDay: app.followUpState?.lastContactDay ?? 0,
            firstChannelUsed: app.followUpState?.firstChannelUsed,
            replyChannel: "unresponsive",
          }
        });
        await adjustJobStageStat(ctx, app.jobId, app.currentStage, "unresponsive");
        await ctx.scheduler.runAfter(0, internal.candidates.candidates.syncCandidateOverallStatusInternal, { candidateId: app.candidateId });
        continue;
      }

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

      // --- LEGACY STATIC FLOW ---
      // 1. First, check if 7 days have elapsed without collecting all required fields.
      // If 7 days elapsed, move to Unresponsive (not rejected)
      // DA will manually call these candidates using the Unresponsive sub-section
      // in the Follow-up tab. AI voice call is suspended.
      // Note: We suspend the 7-day expiration timer if ALL follow-up channels are globally paused.
      if (timeInStage >= SEVEN_DAYS_MS && !allFollowUpsPaused) {
        await ctx.db.patch(app._id, {
          currentStage: "unresponsive",
          lastStageChangedAt: now,
          stageHistory: [
            ...(app.stageHistory ?? []),
            {
              stage: "unresponsive",
              enteredAt: new Date().toISOString(),
              changedBy: "system" as any,
              note: "Auto-moved to Unresponsive: Profile still incomplete after 7 days in Follow-up.",
            },
          ],
        });
        await ctx.db.patch(app._id, {
          followUpState: {
            lastContactDay: app.followUpState?.lastContactDay ?? 0,
            firstChannelUsed: app.followUpState?.firstChannelUsed,
            replyChannel: "unresponsive",
          }
        });
        await adjustJobStageStat(ctx, app.jobId, app.currentStage, "unresponsive");
        await ctx.scheduler.runAfter(0, internal.candidates.candidates.syncCandidateOverallStatusInternal, { candidateId: app.candidateId });
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
        // Do NOT halt sequence forever, just let the scheduling below handle the next nudge if fields are still missing.
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
      let triggerEmail = false;
      let triggerAiCall = false;

      if (targetDay === 0 || targetDay === 4 || targetDay === 6) {
        triggerWhatsApp = !whatsappFollowUpPaused;
        triggerEmail = !emailFollowUpPaused;
      } else if (targetDay === 2) {
        // AI voice call suspended (Sri Lankan phone number not yet available).
        // Backend code in elevenlabs.ts remains intact for future reactivation.
        // Day 2 is intentionally silent — next contact is Day 4 WhatsApp/Email.
        continue;
      }

      // If all scheduled actions for this day are paused, skip the rest to avoid empty states
      if (!triggerWhatsApp && !triggerEmail && !triggerAiCall) continue;

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

      if (triggerEmail) {
        const formattedMissingFields = missingFields.map(f => `• ${f}`).join("\n");
        const companyName = (configRow as any)?.brandName || "our company";

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

        await ctx.db.insert("communications", {
          candidateId: app.candidateId,
          jobId: app.jobId,
          applicationId: app._id,
          direction: "outbound",
          channel: "email",
          subject: emailSubject,
          body: emailBody,
          deliveryStatus: "sent",
          sentAt: now,
          stoppedSequence: false,
          sequenceDay: targetDay,
        });
        console.log(`[Follow-up Day ${targetDay}] Sent email to ${candidate.fullName ?? "unknown"}`);
      }

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
  internal.crons.evaluateFollowUpStage
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
  api.communications.emailAgent.pollEmailInbox,
  { inboxEmail: "linkedin@career141.com" }
);

// Poll general CV inbox every 11 minutes
crons.interval(
  "poll-cv-inbox",
  { minutes: 11 },
  api.communications.emailAgent.pollEmailInbox,
  { inboxEmail: "cv@career141.com" }
);

// Poll job sender mailbox every 3 minutes for candidate email follow-up replies.
// Kept the shortest of the email polls — this is the candidate-facing reply path.
crons.interval(
  "poll-jobs-sender-inbox",
  { minutes: 3 },
  api.communications.emailAgent.pollEmailInbox,
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

    const apps = await ctx.db.query("applications")
      .withIndex("by_active", q => q.eq("isActive", true))
      .take(500); // Safety cap: process max 500 per daily run

    const jobCache = new Map<string, any>();

    for (const app of apps) {
      if (!app.lastStageChangedAt) continue;

      let job = jobCache.get(app.jobId);
      if (job === undefined) {
        job = await ctx.db.get(app.jobId);
        jobCache.set(app.jobId, job);
      }
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

export default crons;


