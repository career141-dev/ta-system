import { query, mutation, internalMutation } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import { requireUser, requireJobAssignment } from "../lib/permissions";
import { checkAndAdvanceFollowUp, updateFollowUpFlags, initiateFollowUpOutreach } from "../pipeline/followUpHelper";
import { syncCandidateOverallStatus } from "../candidates/candidates";
import { adjustJobStageStat } from "../jobs/stats";
import { adjustGlobalStat } from "../stats/statsHelper";
import { assertNoPendingVoiceCall } from "../aiCalls/voiceCallGuards";
export const getApplicationsByCandidateId = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .collect();
  }
});

export const triggerManualAiCall = mutation({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");
    if (
      String(app.candidateId) !== String(args.candidateId) ||
      String(app.jobId) !== String(args.jobId)
    ) {
      throw new Error("Application does not belong to the candidate and job");
    }
    if (app.isActive === false) throw new Error("Application is not active");
    await requireJobAssignment(ctx, app.jobId, ["primary_recruiter", "supporting_recruiter"]);

    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.doNotContact) throw new Error("Candidate is marked do-not-contact");
    await assertNoPendingVoiceCall(ctx, app._id);

    const now = Date.now();
    const callId = await ctx.db.insert("aiCalls", {
      candidateId: app.candidateId,
      applicationId: app._id,
      jobId: app.jobId,
      triggeredBy: user._id,
      triggerType: "manual_ta_trigger",
      callStatus: "scheduled",
      callScriptUsed: "initial_screening",
      companyHidden: false,
      calledAt: now,
      followUpTriggered: false,
      attempts: 1,
      firstAttemptAt: now,
      attemptNumber: 1
    });

    await ctx.scheduler.runAfter(0, internal.integrations.livekitSip.dispatchManualVoiceCall, {
      aiCallId: callId,
      kind: "intake",
    });

    return callId;
  }
});

export const getByJobId = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);

    let actualJobId = ctx.db.normalizeId("jobs", args.jobId);
    if (!actualJobId) {
      const job = await ctx.db.query("jobs").withIndex("by_keyword", q => q.eq("keyword", args.jobId)).first();
      if (!job) return [];
      actualJobId = job._id;
    }

    const rawApps = await ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) => q.eq("jobId", actualJobId!))
      .collect();

    const applications = rawApps.filter(app => app.isActive !== false);

    const uniqueCandidateIds = Array.from(new Set(applications.map((app) => app.candidateId)));
    const candidateDocs = await Promise.all(uniqueCandidateIds.map((id) => ctx.db.get(id)));
    const candidateMap = new Map(
      candidateDocs.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id, c])
    );

    const enriched = applications.map((app) => {
      const dbCandidate = candidateMap.get(app.candidateId);
      
      const cvUploadId = dbCandidate?.cvUploadId || app.candidateCvUploadId;

      let candidateObj: any = dbCandidate ? {
        _id: dbCandidate._id,
        fullName: dbCandidate.fullName || app.candidateName || "Unknown Candidate",
        email: dbCandidate.email || app.candidateEmail,
        phone: dbCandidate.phone || app.candidatePhone,
        currentTitle: dbCandidate.currentJobTitle || dbCandidate.currentTitle || app.candidateTitle,
        totalExperienceYears: dbCandidate.totalExperienceYears ?? app.candidateExperience,
        cvUploadId: cvUploadId,
        location: dbCandidate.location,
        skills: dbCandidate.skills,
        seniorityLevel: dbCandidate.seniorityLevel,
        currentSalary: dbCandidate.currentSalary ?? app.candidateCurrentSalary,
        expectedSalary: dbCandidate.expectedSalary ?? app.candidateExpectedSalary,
        noticePeriodDays: dbCandidate.noticePeriodDays ?? app.candidateNoticePeriodDays,
        overallStatus: dbCandidate.overallStatus,
        sourceChannel: dbCandidate.sourceChannel || dbCandidate.firstSourceChannel || (dbCandidate as any).source,
        source: (dbCandidate as any).source || dbCandidate.sourceChannel || dbCandidate.firstSourceChannel,
      } : {
        _id: app.candidateId,
        fullName: app.candidateName ?? "Unknown Candidate",
        email: app.candidateEmail,
        phone: app.candidatePhone,
        currentTitle: app.candidateTitle,
        totalExperienceYears: app.candidateExperience,
        cvUploadId: cvUploadId,
        currentSalary: app.candidateCurrentSalary,
        expectedSalary: app.candidateExpectedSalary,
        noticePeriodDays: app.candidateNoticePeriodDays,
        sourceChannel: app.sourceChannel,
        source: app.sourceChannel,
      };

      return {
        ...app,
        candidate: candidateObj,
        cv: app.cvFileName ? { fileName: app.cvFileName } : (cvUploadId ? { storageId: cvUploadId } : null),
      };
    }).filter(Boolean);

    return enriched;
  },
});

// All applications for a single candidate, joined with job details
export const getByCandidate = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    let validId = ctx.db.normalizeId("candidates", args.candidateId);
    if (!validId) {
      const upload = await ctx.db.get(args.candidateId as any);
      if (upload && (upload as any).candidateId) {
        validId = (upload as any).candidateId;
      }
    }
    if (!validId) return [];

    const applications = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", validId!))
      .collect();

    return await Promise.all(
      applications.map(async (app) => {
        const job = await ctx.db.get(app.jobId);
        return {
          ...app,
          jobTitle: job?.title ?? "Unknown Job",
          clientName: job?.clientName ?? "",
        };
      })
    );
  },
});

// Unresponsive candidates for a specific job (to show inside the Follow-up tab)
export const getUnresponsiveForJob = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);

    let actualJobId = ctx.db.normalizeId("jobs", args.jobId);
    if (!actualJobId) {
      const jobRecord = await ctx.db
        .query("jobs")
        .withIndex("by_keyword", (q) => q.eq("keyword", args.jobId))
        .first();
      if (!jobRecord) return [];
      actualJobId = jobRecord._id;
    }

    const applications = await ctx.db
      .query("applications")
      .withIndex("by_job_stage", (q) => q.eq("jobId", actualJobId!).eq("currentStage", "unresponsive"))
      .collect();

    const now = Date.now();

    // Cache the job fetch — all applications are for the same job
    const job = await ctx.db.get(actualJobId);
    const jobTitle = job?.title ?? "Unknown Job";

    // Deduplicate candidate IDs for applications missing denormalized name
    const missingCandidateIds = Array.from(
      new Set(applications.filter((app) => !app.candidateName).map((app) => app.candidateId))
    );
    const candidateDocs = await Promise.all(missingCandidateIds.map((id) => ctx.db.get(id)));
    const candidateMap = new Map(
      candidateDocs.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => [c._id, c])
    );

    return applications.map((app) => {
      // Use denormalized data first, fallback to cached candidate lookup
      let candidateName = app.candidateName;
      let candidatePhone = app.candidatePhone;
      let candidateEmail = app.candidateEmail;
      let currentSalary = app.candidateCurrentSalary;
      let expectedSalary = app.candidateExpectedSalary;
      let noticePeriodDays = app.candidateNoticePeriodDays;
      let cvUploadId = app.candidateCvUploadId;

      if (!candidateName) {
        const candidate = candidateMap.get(app.candidateId);
        if (candidate) {
          candidateName = candidate.fullName;
          candidatePhone = candidate.phone;
          candidateEmail = candidate.email;
          currentSalary = candidate.currentSalary;
          expectedSalary = candidate.expectedSalary;
          noticePeriodDays = candidate.noticePeriodDays;
          cvUploadId = candidate.cvUploadId;
        }
      }

      // Compute which fields are still missing
      const missingFields: string[] = [];
      const hasCV = app.followUpCvReceived === true ||
        (app.followUpCvReceived === undefined && (!!cvUploadId || !!app.cvFileId));
      const hasCurrentSalary = app.followUpCurrentSalary === true ||
        (app.followUpCurrentSalary === undefined && currentSalary !== undefined);
      const hasExpectedSalary = app.followUpExpectedSalary === true ||
        (app.followUpExpectedSalary === undefined && expectedSalary !== undefined);
      const hasNoticePeriod = app.followUpNoticePeriod === true ||
        (app.followUpNoticePeriod === undefined && noticePeriodDays !== undefined);

      if (!hasCV) missingFields.push("CV");
      if (!hasCurrentSalary) missingFields.push("Current Salary");
      if (!hasExpectedSalary) missingFields.push("Expected Salary");
      if (!hasNoticePeriod) missingFields.push("Notice Period");

      const daysUnresponsive = app.lastStageChangedAt
        ? Math.floor((now - app.lastStageChangedAt) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        applicationId: app._id,
        candidateId: app.candidateId,
        candidateName: candidateName ?? "Unknown",
        candidatePhone: candidatePhone ?? null,
        candidateEmail: candidateEmail ?? null,
        jobTitle,
        missingFields,
        daysUnresponsive,
        lastStageChangedAt: app.lastStageChangedAt,
        currentSalary,
        expectedSalary,
        noticePeriodDays,
        hasCurrentSalary,
        hasExpectedSalary,
        hasNoticePeriod,
      };
    });
  },
});



// Chronological event log for a candidate (newest first)
export const getCandidateTimeline = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    let validId = ctx.db.normalizeId("candidates", args.candidateId);
    if (!validId) {
      const upload = await ctx.db.get(args.candidateId as any);
      if (upload && (upload as any).candidateId) {
        validId = (upload as any).candidateId;
      }
    }
    if (!validId) return [];

    const events = await ctx.db
      .query("pipelineEvents")
      .withIndex("by_candidate", (q) => q.eq("candidateId", validId!))
      .order("desc")
      .collect();

    // Cache job lookups to avoid N+1 reads
    const jobCache = new Map<string, string>();
    return await Promise.all(
      events.map(async (e) => {
        let jobTitle = jobCache.get(e.jobId);
        if (jobTitle === undefined) {
          const job = await ctx.db.get(e.jobId);
          jobTitle = job?.title ?? "Unknown Job";
          jobCache.set(e.jobId, jobTitle);
        }
        return { ...e, jobTitle };
      })
    );
  },
});

// AI call log for a candidate (newest first)
export const getCandidateAiCalls = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    let validId = ctx.db.normalizeId("candidates", args.candidateId);
    if (!validId) {
      const upload = await ctx.db.get(args.candidateId as any);
      if (upload && (upload as any).candidateId) {
        validId = (upload as any).candidateId;
      }
    }
    if (!validId) return [];

    const calls = await ctx.db
      .query("aiCalls")
      .withIndex("by_candidate", (q) => q.eq("candidateId", validId!))
      .order("desc")
      .collect();

    // Cache job lookups to avoid N+1 reads
    const jobCache = new Map<string, string>();
    return await Promise.all(
      calls.map(async (call) => {
        let jobTitle = jobCache.get(call.jobId);
        if (jobTitle === undefined) {
          const job = await ctx.db.get(call.jobId);
          jobTitle = job?.title ?? "Unknown Job";
          jobCache.set(call.jobId, jobTitle);
        }
        return { ...call, jobTitle };
      })
    );
  },
});

export const createApplication = mutation({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    cvFileId: v.optional(v.id("cvUploads")),
    sourceChannel: v.string(),
    stage: v.optional(v.string()),
    metaCampaignId: v.optional(v.string()),
    metaSourceUrl: v.optional(v.string()),
    metaSourceId: v.optional(v.string()),
    metaHeadline: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Fetch candidate and resolve survivor ID if ghost candidate was merged during deduplication
    let targetCandidateId = args.candidateId;
    let candidate = await ctx.db.get(targetCandidateId);
    if (candidate && candidate.mergedInto) {
      targetCandidateId = candidate.mergedInto;
      candidate = await ctx.db.get(targetCandidateId);
    }
    if (!candidate) {
      console.warn(`[createApplication] Candidate ${args.candidateId} no longer exists in database. Skipping application creation.`);
      return null;
    }

    const isDatabaseOrManual =
      args.sourceChannel === "database" ||
      (typeof args.sourceChannel === "string" && (
        args.sourceChannel.toLowerCase().includes("manual") ||
        args.sourceChannel.toLowerCase().includes("directory") ||
        args.sourceChannel.toLowerCase().includes("folder")
      ));

    // Check if application already exists for this candidate and job
    const existing = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", targetCandidateId))
      .filter((q) => q.eq(q.field("jobId"), args.jobId))
      .first();

    if (existing) {
      let updates: any = {};
      
      if (args.stage) {
        updates.currentStage = args.stage as any;
        updates.lastStageChangedAt = Date.now();
      } else if (isDatabaseOrManual || existing.currentStage === "new_cvs" || existing.currentStage === "rejected") {
        updates.currentStage = "matched_candidates" as any;
        updates.lastStageChangedAt = Date.now();
      }

      if (existing.isActive === false) {
        updates.isActive = true;
      }
      
      if (args.cvFileId && existing.cvFileId !== args.cvFileId) {
        updates.cvFileId = args.cvFileId;
      }

      // ALWAYS sync the latest denormalized candidate data to the application
      updates.candidateName = candidate.fullName || undefined;
      updates.candidateEmail = candidate.email || undefined;
      updates.candidatePhone = candidate.phone || undefined;
      updates.candidateTitle = candidate.currentJobTitle || undefined;
      updates.candidateExperience = candidate.totalExperienceYears || undefined;
      updates.candidateCurrentSalary = candidate.currentSalary || undefined;
      updates.candidateExpectedSalary = candidate.expectedSalary || undefined;
      updates.candidateNoticePeriodDays = candidate.noticePeriodDays || undefined;
      
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
        
        if (updates.currentStage) {
          await adjustJobStageStat(ctx, args.jobId, existing.currentStage, updates.currentStage);
          await syncCandidateOverallStatus(ctx, targetCandidateId);
          
          if (existing.sourceChannel === "whatsapp" && updates.currentStage === "matched_candidates") {
            await ctx.runMutation(internal.meta.trigger.triggerMetaEventIfEligible, {
              applicationId: existing._id,
              eventName: "QualifiedLead"
            });
          }
        }
        
        if (updates.cvFileId && candidate) {
          await updateFollowUpFlags(ctx, existing._id, candidate);
          await checkAndAdvanceFollowUp(ctx, targetCandidateId);
        }
      }

      // Trigger AI scoring if score is missing or when adding from database / manual directory
      if (!existing.aiMatchScore && isDatabaseOrManual) {
        await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
          candidateId: targetCandidateId,
          jobId: args.jobId,
        });
      }

      return existing._id;
    }

    const now = Date.now();
    const initialStage = args.stage || (isDatabaseOrManual ? "matched_candidates" : "new_cvs");
    
    const appId = await ctx.db.insert("applications", {
      candidateId: targetCandidateId,
      jobId: args.jobId,
      cvFileId: args.cvFileId,
      sourceChannel: args.sourceChannel,
      candidateName: candidate?.fullName,
      candidateEmail: candidate?.email,
      candidatePhone: candidate?.phone,
      candidateTitle: candidate?.currentTitle || candidate?.currentJobTitle,
      candidateExperience: candidate?.totalExperienceYears || candidate?.yearsOfExperience,
      candidateCvUploadId: candidate?.cvUploadId,
      candidateCurrentSalary: candidate?.currentSalary,
      candidateExpectedSalary: candidate?.expectedSalary,
      candidateNoticePeriodDays: candidate?.noticePeriodDays,
      currentStage: initialStage as any,
      loopIteration: 1,
      isActive: true,
      lastStageChangedAt: now,
      createdAt: now,
      metaCampaignId: args.metaCampaignId,
      metaAdId: args.metaSourceId, // Store sourceId as AdId
      metaConversionSentFor: [],
    });

    if (isDatabaseOrManual) {
      await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
        candidateId: args.candidateId,
        jobId: args.jobId,
      });
    }
    
    await adjustJobStageStat(ctx, args.jobId, null, initialStage as any, true);
    await adjustGlobalStat(ctx, "new_application");
    await syncCandidateOverallStatus(ctx, args.candidateId);
    
    // Trigger Meta Conversions API
    if (args.sourceChannel === "whatsapp") {
      const eventName = initialStage === "matched_candidates" ? "QualifiedLead" : "Lead";
      await ctx.runMutation(internal.meta.trigger.triggerMetaEventIfEligible, {
        applicationId: appId,
        eventName: eventName
      });
    }

    return appId;
  },
});

export const logManualCall = mutation({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    outcome: v.string(), // "Interested", "Not Interested", "No Answer"
    currentSalary: v.optional(v.union(v.number(), v.string())),
    expectedSalary: v.optional(v.union(v.number(), v.string())),
    noticePeriodDays: v.optional(v.union(v.number(), v.string())),
    cvUploadId: v.optional(v.id("cvUploads")),
    customCallFields: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Update candidate global profile
    const candidateUpdates: any = {};
    let customCallFields = args.customCallFields || [];

    if (args.currentSalary !== undefined) {
      if (typeof args.currentSalary === 'number') {
        candidateUpdates.currentSalary = args.currentSalary;
      } else if (args.currentSalary.trim()) {
        customCallFields.push({ key: "Current Salary (Note)", value: args.currentSalary.trim() });
      }
    }
    
    if (args.expectedSalary !== undefined) {
      if (typeof args.expectedSalary === 'number') {
        candidateUpdates.expectedSalary = args.expectedSalary;
      } else if (args.expectedSalary.trim()) {
        customCallFields.push({ key: "Expected Salary (Note)", value: args.expectedSalary.trim() });
      }
    }
    
    if (args.noticePeriodDays !== undefined) {
      if (typeof args.noticePeriodDays === 'number') {
        candidateUpdates.noticePeriodDays = args.noticePeriodDays;
      } else if (args.noticePeriodDays.trim()) {
        customCallFields.push({ key: "Notice Period (Note)", value: args.noticePeriodDays.trim() });
      }
    }

    if (args.cvUploadId) candidateUpdates.cvUploadId = args.cvUploadId;

    // Save custom fields from TA call into candidate's customCallData
    if (customCallFields.length > 0) {
      const existing = (await ctx.db.get(args.candidateId)) as any;
      const prevCustom = existing?.customCallData || {};
      const merged: Record<string, string> = { ...prevCustom };
      for (const field of customCallFields) {
        if (field.key.trim() && field.value.trim()) {
          merged[field.key.trim()] = field.value.trim();
        }
      }
      candidateUpdates.customCallData = merged;
    }

    if (Object.keys(candidateUpdates).length > 0) {
      await ctx.db.patch(args.candidateId, candidateUpdates);
    }

    const candidate = await ctx.db.get(args.candidateId);

    // 2. Determine next stage based on outcome
    if (args.outcome === "Not Interested") {
      await ctx.db.patch(args.applicationId, {
        manualCallOutcome: args.outcome,
        currentStage: "rejected",
        taRejectionReason: "Not Interested during initial call",
        lastStageChangedAt: now,
      });
      await syncCandidateOverallStatus(ctx, args.candidateId);
      return;
    }

    // For "Interested" or "No Answer" — update per-application flags first
    await updateFollowUpFlags(ctx, args.applicationId, candidate);
    
    // Manually force flags if they were provided as strings, and save customFollowUpAnswers
    const manualAppUpdates: Record<string, any> = {};
    if (typeof args.currentSalary === 'string' && args.currentSalary.trim()) manualAppUpdates.followUpCurrentSalary = true;
    if (typeof args.expectedSalary === 'string' && args.expectedSalary.trim()) manualAppUpdates.followUpExpectedSalary = true;
    if (typeof args.noticePeriodDays === 'string' && args.noticePeriodDays.trim()) manualAppUpdates.followUpNoticePeriod = true;
    
    if (customCallFields.length > 0) {
      const existingApp = await ctx.db.get(args.applicationId);
      const prevAnswers = existingApp?.customFollowUpAnswers || {};
      const mergedAnswers: Record<string, string> = { ...prevAnswers };
      for (const field of customCallFields) {
        if (field.key.trim() && field.value.trim()) {
          mergedAnswers[field.key.trim()] = field.value.trim();
        }
      }
      manualAppUpdates.customFollowUpAnswers = mergedAnswers;
    }

    if (Object.keys(manualAppUpdates).length > 0) {
      await ctx.db.patch(args.applicationId, manualAppUpdates);
    }

    const updatedApp = await ctx.db.get(args.applicationId);
    const job = updatedApp?.jobId ? await ctx.db.get(updatedApp.jobId) : null;
    const customQuestions = job?.customFollowUpQuestions || [];
    const appAnswers = updatedApp?.customFollowUpAnswers || {};
    let customQuestionsComplete = true;
    for (const q of customQuestions) {
      if (!appAnswers[q]) {
        customQuestionsComplete = false;
        break;
      }
    }

    const allComplete =
      updatedApp?.followUpCvReceived === true &&
      updatedApp?.followUpCurrentSalary === true &&
      updatedApp?.followUpExpectedSalary === true &&
      updatedApp?.followUpNoticePeriod === true &&
      customQuestionsComplete;

    if (args.outcome === "Interested" && allComplete) {
      // All 4 fields captured on the first TA call — skip Follow-up, go straight to 2nd Shortlist
      await ctx.db.patch(args.applicationId, {
        manualCallOutcome: args.outcome,
        currentStage: "second_shortlist",
        lastStageChangedAt: now,
        stageHistory: [
          ...(updatedApp?.stageHistory ?? []),
          {
            stage: "second_shortlist",
            enteredAt: new Date().toISOString(),
            changedBy: "system" as any,
            note: "All 4 data points collected on first TA call — skipped Follow-up.",
          },
        ],
      });
    } else {
      // Incomplete — move to Follow-up and start 7-day clock
      const appBeforeUpdate = await ctx.db.get(args.applicationId);
      const alreadyInFollowUp = appBeforeUpdate?.currentStage === "follow_up";
      await ctx.db.patch(args.applicationId, {
        manualCallOutcome: args.outcome,
        currentStage: "follow_up",
        lastStageChangedAt: now,
        followUpEnteredAt: alreadyInFollowUp ? (appBeforeUpdate?.followUpEnteredAt ?? now) : now,
        stageHistory: [
          ...(updatedApp?.stageHistory ?? []),
          {
            stage: "follow_up",
            enteredAt: new Date().toISOString(),
            changedBy: "system" as any,
            note: `TA call logged (${args.outcome}) — missing data, entering Follow-up.`,
          },
        ],
      });
    }
    await syncCandidateOverallStatus(ctx, args.candidateId);
    if (args.outcome !== "Not Interested" && !allComplete) {
      await initiateFollowUpOutreach(ctx, args.applicationId);
    }
  },
});

export const rejectApplication = mutation({
  args: {
    applicationId: v.id("applications"),
    reason: v.string(),
    stage: v.optional(v.string()), // the stage they're being rejected from
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");

    const fromStage = args.stage ?? app.currentStage;

    await ctx.db.patch(args.applicationId, {
      currentStage: "rejected",
      taRejectionReason: args.reason,
      rejectedFromStage: fromStage,
      lastStageChangedAt: Date.now(),
    });

    // Write audit event
    await ctx.db.insert("pipelineEvents", {
      applicationId: args.applicationId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      eventType: "rejected",
      fromStage,
      toStage: "rejected",
      actorType: "user",
      actorId: user._id,
      notes: args.reason,
      createdAt: Date.now(),
    });
    await syncCandidateOverallStatus(ctx, app.candidateId);
  },
});

export const triggerAiCall = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");
    if (app.isActive === false) throw new Error("Application is not active");

    await requireJobAssignment(ctx, app.jobId, ["primary_recruiter", "supporting_recruiter"]);

    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.doNotContact) throw new Error("Candidate is marked do-not-contact");
    await assertNoPendingVoiceCall(ctx, app._id);

    // Insert aiCalls record
    const callId = await ctx.db.insert("aiCalls", {
      candidateId: app.candidateId,
      applicationId: args.applicationId,
      jobId: app.jobId,
      triggeredBy: user._id,
      triggerType: "manual_ta_trigger",
      callStatus: "scheduled",
      callScriptUsed: "default",
      companyHidden: false,
      calledAt: Date.now(),
      firstAttemptAt: Date.now(),
      attemptNumber: 1,
      followUpTriggered: false,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.livekitSip.dispatchManualVoiceCall, {
      aiCallId: callId,
      kind: "intake",
    });

    return callId;
  },
});

export const createHeadhuntApplication = mutation({
  args: {
    jobId: v.id("jobs"),
    fullName: v.string(),
    currentSalary: v.number(),
    expectedSalary: v.number(),
    noticePeriodDays: v.number(),
    cvUploadId: v.id("cvUploads"),          // Hard-required: no follow-up chase at 2nd shortlist
    candidateConsent: v.boolean(),           // Must confirm awareness of opportunity
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireJobAssignment(ctx, args.jobId, ["primary_recruiter", "supporting_recruiter"]);

    // Hard gates — the 2nd Shortlist is the final validation point before Director review
    if (!args.candidateConsent) {
      throw new Error("Candidate consent is required for headhunted uploads.");
    }
    if (!args.currentSalary || !args.expectedSalary || !args.noticePeriodDays) {
      throw new Error("Current salary, expected salary, and notice period are required for headhunted uploads.");
    }

    // Create candidate record
    const candidateId = await ctx.db.insert("candidates", {
      fullName: args.fullName,
      email: args.email,
      phone: args.phone,
      currentSalary: args.currentSalary,
      expectedSalary: args.expectedSalary,
      noticePeriodDays: args.noticePeriodDays,
      firstSourceChannel: "headhunting",
      firstSourceJobId: args.jobId,
      firstSeenAt: Date.now(),
      lastUpdatedAt: Date.now(),
      overallStatus: "active",
      cvUploadId: args.cvUploadId,
      candidateConsent: true,
    });
    
    await adjustGlobalStat(ctx, "new_candidate");

    // Create application directly at second_shortlist with all flags set
    const now = Date.now();
    const applicationId = await ctx.db.insert("applications", {
      candidateId,
      jobId: args.jobId,
      cvFileId: args.cvUploadId,
      sourceChannel: "headhunting",
      currentStage: "second_shortlist",
      loopIteration: 1,
      isActive: true,
      lastStageChangedAt: now,
      createdAt: now,
      // Mark all follow-up flags as complete (headhunted candidates skip follow-up)
      followUpCvReceived: true,
      followUpCurrentSalary: true,
      followUpExpectedSalary: true,
      followUpNoticePeriod: true,
    });
    
    await adjustJobStageStat(ctx, args.jobId, null, "second_shortlist", true);
    await adjustGlobalStat(ctx, "new_application");

    // Log pipeline event
    await ctx.db.insert("pipelineEvents", {
      applicationId,
      candidateId,
      jobId: args.jobId,
      eventType: "headhunt_added",
      toStage: "second_shortlist",
      actorType: "user",
      actorId: user._id,
      notes: `Headhunt candidate added directly to 2nd Shortlist by ${user.fullName}`,
      createdAt: now,
    });

    await syncCandidateOverallStatus(ctx, candidateId);

    return { candidateId, applicationId };
  },
});

export const removeApplication = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (app) {
      await adjustJobStageStat(ctx, app.jobId, app.currentStage, app.currentStage, false, true);
      await ctx.db.delete(args.applicationId);
      await adjustGlobalStat(ctx, "deleted_application");
      await syncCandidateOverallStatus(ctx, app.candidateId);
    }
  }
});

export const updatePipelineCandidateDetails = mutation({
  args: {
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    field: v.union(v.literal("currentSalary"), v.literal("expectedSalary"), v.literal("noticePeriodDays")),
    value: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");
    
    // Permission: Recruiter or higher assigned to the job
    await requireJobAssignment(ctx, app.jobId, ["primary_recruiter", "supporting_recruiter"]);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");

    // Capture old value
    const oldValue = candidate[args.field] !== undefined ? String(candidate[args.field]) : "—";
    const newValue = String(args.value);

    if (oldValue === newValue) return;

    // 1. Patch candidate global profile
    await ctx.db.patch(args.candidateId, {
      [args.field]: args.value,
    });

    // 2. Append history
    const history = app.salaryNoticeEditHistory || [];
    const newEntry = {
      field: args.field,
      oldValue,
      newValue,
      editedBy: user._id,
      editedAt: new Date().toISOString(),
    };

    await ctx.db.patch(args.applicationId, {
      salaryNoticeEditHistory: [...history, newEntry],
    });

    // 3. Update per-application follow-up flags with the fresh candidate data
    const updatedCandidate = await ctx.db.get(args.candidateId);
    if (updatedCandidate) {
      await updateFollowUpFlags(ctx, args.applicationId, updatedCandidate);
    }

    // 4. Since a field was updated, check if we can auto-advance from follow_up
    await checkAndAdvanceFollowUp(ctx, args.candidateId);
  },
});

// Twilio webhook helper: find aiCalls record by Twilio CallSid
export const findAiCallBySid = query({
  args: { twilioCallSid: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiCalls")
      .withIndex("by_twilio", (q) => q.eq("twilioCallSid", args.twilioCallSid))
      .first();
  },
});

export const findAiCallByElevenLabsId = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("aiCalls")
      .withIndex("by_elevenlabs", (q) => q.eq("elevenlabsConversationId", args.conversationId))
      .first();
  },
});

// Twilio webhook helper: update call status + IVR response
export const updateAiCallStatus = mutation({
  args: {
    aiCallId: v.id("aiCalls"),
    callStatus: v.union(
      v.literal("scheduled"), v.literal("in_progress"), v.literal("completed"),
      v.literal("no_answer"), v.literal("failed"), v.literal("declined")
    ),
    ivrResponse: v.optional(v.union(
      v.literal("pressed_1_interested"), v.literal("pressed_2_declined"),
      v.literal("pressed_3_connect_recruiter"), v.literal("no_response")
    )),
    twilioCallSid: v.optional(v.string()),
    elevenLabsConversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.aiCallId);
    if (!call) throw new Error("AI call record not found");

    const updates: any = {
      callStatus: args.callStatus,
      ivrResponse: args.ivrResponse,
    };
    if (args.twilioCallSid) updates.twilioCallSid = args.twilioCallSid;
    if (args.elevenLabsConversationId) updates.elevenLabsConversationId = args.elevenLabsConversationId;
    if (args.callStatus === "completed" || args.callStatus === "failed" || args.callStatus === "no_answer") {
      updates.completedAt = Date.now();
    }

    await ctx.db.patch(args.aiCallId, updates);

    // Reflect status on the application record if linked
    if (call.applicationId) {
      await ctx.db.patch(call.applicationId, {
        aiCallStatus: args.callStatus,
        aiCallIvrResponse: args.ivrResponse,
      });
    }
  },
});

export const saveCustomQuestionAnswers = mutation({
  args: {
    aiCallId: v.id("aiCalls"),
    customQuestionAnswers: v.array(v.object({ question: v.string(), answer: v.string() })),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.aiCallId, { customQuestionAnswers: args.customQuestionAnswers });
  },
});

// ─── Per-application follow-up helpers ────────────────────────────────────────

/** Sets the timestamp when a candidate entered the Follow-up stage.
 *  Used by webhooks and mutations to start the precise 7-day clock. */
export const setFollowUpEnteredAt = mutation({
  args: {
    applicationId: v.id("applications"),
    enteredAt: v.number(),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;
    // Only set if not already set (don't reset clock on re-entry signals)
    if (!app.followUpEnteredAt) {
      await ctx.db.patch(args.applicationId, { followUpEnteredAt: args.enteredAt });
    }
  },
});

/** Writes individual per-application follow-up completion flags.
 *  Called by ElevenLabs webhooks after a call captures partial data. */
export const setApplicationFlags = mutation({
  args: {
    applicationId: v.id("applications"),
    followUpCvReceived: v.optional(v.boolean()),
    followUpCurrentSalary: v.optional(v.boolean()),
    followUpExpectedSalary: v.optional(v.boolean()),
    followUpNoticePeriod: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { applicationId, ...flags } = args;
    const updates: Record<string, boolean> = {};
    if (flags.followUpCvReceived !== undefined) updates.followUpCvReceived = flags.followUpCvReceived;
    if (flags.followUpCurrentSalary !== undefined) updates.followUpCurrentSalary = flags.followUpCurrentSalary;
    if (flags.followUpExpectedSalary !== undefined) updates.followUpExpectedSalary = flags.followUpExpectedSalary;
    if (flags.followUpNoticePeriod !== undefined) updates.followUpNoticePeriod = flags.followUpNoticePeriod;
    if (Object.keys(updates).length > 0) {
      const app = await ctx.db.get(applicationId);
      if (!app) {
        console.warn(`[setApplicationFlags] App ${applicationId} not found, skipping.`);
        return;
      }
      
      await ctx.db.patch(applicationId, updates);
      
      // Now check if they should be auto-advanced
      await checkAndAdvanceFollowUp(ctx, app.candidateId);
    }
  },
});

export const getApplication = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const actualId = ctx.db.normalizeId("applications", args.id);
    if (!actualId) return null;
    return await ctx.db.get(actualId);
  },
});

export const rollbackFollowUpState = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app || !app.followUpState) return;

    const currentState = app.followUpState;
    if (currentState.lastContactDay >= 2) {
      await ctx.db.patch(args.applicationId, {
        followUpState: {
          ...currentState,
          lastContactDay: 1, // Reset to 1 so Day 2 re-triggers next hour
        }
      });
    }
  }
});

export const moveToFollowUp = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");

    const fromStage = app.currentStage;
    const now = Date.now();

    await ctx.db.patch(args.applicationId, {
      currentStage: "follow_up",
      followUpEnteredAt: now,
      lastStageChangedAt: now,
      followUpAttemptCount: 0,
      nextFollowUpScheduledAt: undefined,
      nextFollowUpMessage: undefined,
      waitingForCandidateEta: undefined,
      candidateEtaMs: undefined,
      candidateEtaText: undefined,
      flaggedForTaReview: false,
      taReviewReason: undefined,
      stageHistory: [
        ...(app.stageHistory ?? []),
        {
          stage: "follow_up",
          enteredAt: new Date().toISOString(),
          changedBy: user._id,
          note: `Moved back to Follow-up stage from ${fromStage} with fresh 7-day window.`,
        },
      ],
    });

    await adjustJobStageStat(ctx, app.jobId, fromStage, "follow_up");
    await syncCandidateOverallStatus(ctx, app.candidateId);

    await ctx.db.insert("pipelineEvents", {
      applicationId: args.applicationId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      eventType: "stage_changed",
      fromStage,
      toStage: "follow_up",
      actorType: "user",
      actorId: user._id,
      notes: "Moved back to Follow-up stage with fresh 7-day window",
      createdAt: now,
    });

    console.log(`[Pipeline] Application ${args.applicationId} moved back to Follow-up by user ${user._id}.`);
    return { success: true };
  },
});

export const resetAllUnresponsiveForJob = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_job_stage", q => q.eq("jobId", args.jobId).eq("currentStage", "unresponsive"))
      .collect();

    const now = Date.now();
    for (const app of apps) {
      await ctx.db.patch(app._id, {
        currentStage: "follow_up",
        followUpEnteredAt: now,
        lastStageChangedAt: now,
        followUpAttemptCount: 0,
        nextFollowUpScheduledAt: undefined,
        nextFollowUpMessage: undefined,
        waitingForCandidateEta: undefined,
        candidateEtaMs: undefined,
        candidateEtaText: undefined,
        flaggedForTaReview: false,
        taReviewReason: undefined,
        stageHistory: [
          ...(app.stageHistory ?? []),
          {
            stage: "follow_up",
            enteredAt: new Date().toISOString(),
            changedBy: "system",
            note: "Reset to Follow-up stage with fresh 7-day window.",
          },
        ],
      });
      await adjustJobStageStat(ctx, args.jobId, "unresponsive", "follow_up");
      await syncCandidateOverallStatus(ctx, app.candidateId);
      console.log(`[Follow-Up] Reset application ${app._id} to Follow-up stage.`);
    }
    return { resetCount: apps.length };
  },
});



