// @ts-nocheck
import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { initiateFollowUpOutreach } from "./followUpHelper";
import { requireJobAssignment, requireUser } from "../lib/permissions";
import { assertNoPendingVoiceCall } from "../aiCalls/voiceCallGuards";

// Get AI Calls for Outreach dashboard
export const getAiCalls = query({
  args: {
    jobId: v.optional(v.id("jobs")),
    outcome: v.optional(v.string()),
    dateRange: v.optional(v.string()), // 'today', '7days'
  },
  handler: async (ctx, args) => {
    let callsQuery;
    if (args.jobId) {
      callsQuery = ctx.db.query("aiCalls").withIndex("by_job", q => q.eq("jobId", args.jobId as any));
    } else {
      callsQuery = ctx.db.query("aiCalls");
    }
    let calls = await callsQuery.order("desc").take(100);

    // Join with candidates and jobs
    const enrichedCalls = await Promise.all(
      calls.map(async (call) => {
        const candidate = await ctx.db.get(call.candidateId);
        const job = await ctx.db.get(call.jobId);
        
        return {
          ...call,
          candidateName: candidate?.fullName || "Unknown",
          candidateCurrentTitle: candidate?.currentTitle || candidate?.currentJobTitle || "",
          candidateNoticePeriod: candidate?.noticePeriodDays || candidate?.noticePeriod || "",
          candidateExpectedSalary: candidate?.expectedSalary || "",
          candidateCurrentSalary: candidate?.currentSalary || "",
          jobTitle: job?.title || "Unknown Job",
          clientName: job?.clientName || "",
        };
      })
    );

    let filtered = enrichedCalls;

    if (args.outcome && args.outcome !== "All Outcomes") {
      filtered = filtered.filter(c => {
        if (args.outcome === "Interested") return c.ivrResponse === "pressed_1_interested";
        if (args.outcome === "Declined") return c.ivrResponse === "pressed_2_declined";
        if (args.outcome === "No Answer") return c.callStatus === "no_answer";
        return true;
      });
    }

    if (args.dateRange === "Today") {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      filtered = filtered.filter(c => c.calledAt >= startOfToday.getTime());
    } else if (args.dateRange === "Last 7 Days") {
      const startOf7Days = new Date();
      startOf7Days.setDate(startOf7Days.getDate() - 7);
      startOf7Days.setHours(0, 0, 0, 0);
      filtered = filtered.filter(c => c.calledAt >= startOf7Days.getTime());
    }

    return filtered;
  },
});

// Trigger a new AI call
export const triggerAiCall = mutation({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    callScriptUsed: v.union(
      v.literal("default"),
      v.literal("initial_screening"),
      v.literal("technical_prescreen")
    ),
    companyHidden: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireJobAssignment(ctx, args.jobId, ["primary_recruiter", "supporting_recruiter"]);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.doNotContact) throw new Error("Candidate is marked do-not-contact");

    const app = await ctx.db.query("applications")
      .withIndex("by_candidate_job", q => q.eq("candidateId", args.candidateId).eq("jobId", args.jobId))
      .first();
    if (!app) throw new Error("Candidate has no application for this job");
    if (app.isActive === false) throw new Error("Application is not active");
    await assertNoPendingVoiceCall(ctx, app._id);

    const newCallId = await ctx.db.insert("aiCalls", {
      candidateId: args.candidateId,
      applicationId: app._id,
      jobId: args.jobId,
      triggeredBy: user._id,
      triggerType: "manual_ta_trigger",
      callStatus: "scheduled",
      callScriptUsed: args.callScriptUsed,
      companyHidden: args.companyHidden,
      calledAt: Date.now(),
      firstAttemptAt: Date.now(),
      attemptNumber: 1,
      followUpTriggered: false,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.livekitSip.dispatchManualVoiceCall, {
      aiCallId: newCallId,
      kind: "intake",
    });

    return newCallId;
  },
});

// Get communications
export const getCommunications = query({
  args: {
    jobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    let commsQuery;
    if (args.jobId) {
      commsQuery = ctx.db.query("communications").withIndex("by_job", q => q.eq("jobId", args.jobId as any));
    } else {
      commsQuery = ctx.db.query("communications");
    }
    let comms = await commsQuery.order("desc").take(100);
    
    return Promise.all(
      comms.map(async (c) => {
        const candidate = await ctx.db.get(c.candidateId);
        let jobTitle = "Unknown";
        if (c.jobId) {
          const job = await ctx.db.get(c.jobId);
          if (job) jobTitle = job.title;
        }
        return {
          ...c,
          candidateName: candidate?.fullName || "Unknown",
          jobTitle,
        };
      })
    );
  }
});

// Send message
export const sendMessage = mutation({
  args: {
    candidateId: v.id("candidates"),
    jobId: v.optional(v.id("jobs")),
    channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms")),
    subject: v.optional(v.string()),
    body: v.string(),
    setupFollowUps: v.boolean(),
  },
  handler: async (ctx, args) => {
    const isEmail = args.channel === "email";
    const isWhatsApp = args.channel === "whatsapp";

    // 1. Resolve application for candidate (by jobId if provided, or latest application)
    let application = null;
    if (args.jobId) {
      application = await ctx.db
        .query("applications")
        .withIndex("by_candidate_job", (q) =>
          q.eq("candidateId", args.candidateId).eq("jobId", args.jobId!)
        )
        .first();
    }

    if (!application) {
      application = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
        .order("desc")
        .first();
    }

    const targetJobId = args.jobId || application?.jobId;

    // 2. Insert communication record with pending delivery
    const commId = await ctx.db.insert("communications", {
      candidateId: args.candidateId,
      jobId: targetJobId,
      applicationId: application?._id,
      direction: "outbound",
      channel: args.channel,
      subject: args.subject ?? (isWhatsApp ? "WhatsApp Template Outreach" : "Career141 Communication"),
      body: args.body,
      deliveryStatus: "pending",
      sentAt: Date.now(),
      stoppedSequence: !args.setupFollowUps,
      senderAgent: "system",
    });

    if (isEmail && targetJobId) {
      // Schedule actual Graph email delivery
      const candidate = await ctx.db.get(args.candidateId);
      const job = await ctx.db.get(targetJobId);
      const recruiter = job ? await ctx.db.get(job.primaryRecruiterId) : null;

      const taEmail = recruiter?.email;
      const toAddress = candidate?.email;

      if (taEmail && toAddress) {
        const htmlBody = args.body.replace(/\n/g, "<br>");
        await ctx.scheduler.runAfter(0, internal.communications.graphEmail.sendGraphEmail, {
          communicationId: commId,
          candidateJobId: commId as string,
          taEmail,
          toAddress,
          subject: args.subject ?? "Career141 Communication",
          bodyHtml: htmlBody,
        });
      } else {
        await ctx.db.patch(commId, { deliveryStatus: "failed", errorMessage: "Missing TA or candidate email" });
      }
    } else if (isWhatsApp) {
      // For WhatsApp: Dispatch approved Meta Cloud API template directly to the candidate's phone
      const candidate = await ctx.db.get(args.candidateId);
      const cleanPhone = candidate?.phone ? candidate.phone.replace(/\D/g, "") : "";

      if (cleanPhone) {
        await ctx.scheduler.runAfter(0, internal.communications.metaTemplateSender.sendMetaTemplate, {
          applicationId: application?._id,
          candidateId: args.candidateId,
          jobId: targetJobId,
          communicationId: commId,
          templateType: "initial_outreach",
        });
      } else {
        await ctx.db.patch(commId, {
          deliveryStatus: "failed",
          errorMessage: `Candidate ${candidate?.fullName || "unknown"} has no valid phone number`,
        });
      }
    }

    return commId;
  }
});


// Get follow-up candidates
export const getFollowUpCandidates = query({
  args: {
    jobId: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args) => {
    let apps = await ctx.db
      .query("applications")
      .withIndex("by_stage", (q) => q.eq("currentStage", "follow_up"))
      .collect();

    if (args.jobId) {
      apps = apps.filter((app) => app.jobId === args.jobId);
    }

    return Promise.all(
      apps.map(async (app) => {
        const candidate = await ctx.db.get(app.candidateId);
        const job = await ctx.db.get(app.jobId);
        
        const hasCV = app.followUpCvReceived === true || (app.followUpCvReceived === undefined && (!!candidate?.cvUploadId || !!app.cvFileId));
        const hasCurrentSalary = app.followUpCurrentSalary === true || (app.followUpCurrentSalary === undefined && candidate?.currentSalary !== undefined);
        const hasExpectedSalary = app.followUpExpectedSalary === true || (app.followUpExpectedSalary === undefined && candidate?.expectedSalary !== undefined);
        const hasNoticePeriod = app.followUpNoticePeriod === true || (app.followUpNoticePeriod === undefined && candidate?.noticePeriodDays !== undefined);

        const enteredAt = app.followUpEnteredAt ?? app.lastStageChangedAt ?? Date.now();
        const daysInStage = Math.floor((Date.now() - enteredAt) / (24 * 60 * 60 * 1000));

        let nextAction = "Waiting";
        if (daysInStage === 0) nextAction = "Day 0 WhatsApp";
        else if (daysInStage === 1) nextAction = "Wait (Day 2)";
        else if (daysInStage === 2) nextAction = "Day 2 AI Call";
        else if (daysInStage === 3) nextAction = "Wait (Day 4)";
        else if (daysInStage === 4) nextAction = "Day 4 WhatsApp";
        else if (daysInStage === 5) nextAction = "Wait (Day 6)";
        else if (daysInStage === 6) nextAction = "Day 6 Final Ping";
        else if (daysInStage >= 7) nextAction = "Auto Reject Pending";

        return {
          applicationId: app._id,
          candidateId: app.candidateId,
          jobId: app.jobId,
          candidateName: candidate?.fullName || "Unknown",
          jobTitle: job?.title || "Unknown Job",
          daysInStage,
          nextAction,
          hasCV,
          hasCurrentSalary,
          hasExpectedSalary,
          hasNoticePeriod
        };
      })
    );
  }
});

// Force trigger an AI call for a follow up candidate
export const forceTriggerFollowUpCall = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("App not found");
    if (app.isActive === false) throw new Error("Application is not active");
    await requireJobAssignment(ctx, app.jobId, ["primary_recruiter", "supporting_recruiter"]);
    
    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found");
    if (candidate.doNotContact) throw new Error("Candidate is marked do-not-contact");
    await assertNoPendingVoiceCall(ctx, app._id);

    const now = Date.now();
    const newAiCallId = await ctx.db.insert("aiCalls", {
      candidateId: app.candidateId,
      jobId: app.jobId,
      applicationId: app._id,
      triggeredBy: user._id,
      triggerType: "followup_retry",
      callStatus: "scheduled",
      callScriptUsed: "initial_screening",
      companyHidden: false,
      calledAt: now,
      followUpTriggered: true,
      attempts: 1,
      firstAttemptAt: now,
      attemptNumber: 1,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.livekitSip.dispatchManualVoiceCall, {
      aiCallId: newAiCallId,
      kind: "follow_up",
      attemptNumber: 1,
      lastContactChannel: "Manual Trigger",
    });

    return true;
  }
});

// Trigger manual follow-up WhatsApp message
export const triggerWhatsAppFollowUp = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const commId = await initiateFollowUpOutreach(ctx, args.applicationId, { isManual: true });
    return { success: true, communicationId: commId };
  },
});

// Trigger manual follow-up Email message
export const triggerEmailFollowUp = mutation({
  args: {
    applicationId: v.id("applications"),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Application not found");

    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("Candidate not found");

    const job = await ctx.db.get(app.jobId);
    if (!job) throw new Error("Job not found");

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

    const now = Date.now();

    // Create Email communication record (pending — will be sent via Graph)
    const emailCommId = await ctx.db.insert("communications", {
      candidateId: app.candidateId,
      jobId: app.jobId,
      applicationId: app._id,
      direction: "outbound",
      channel: "email",
      subject: `Action Required: Missing info for your ${job.title} application`,
      body,
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
      const htmlBody = body.replace(/\n/g, "<br>");
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
        `[Manual Follow-up Outreach] Skipped email: taEmail=${taEmail ?? "missing"}, candidateEmail=${candidateEmail ?? "missing"}`
      );
      await ctx.db.patch(emailCommId, {
        deliveryStatus: "failed",
        errorMessage: !taEmail
          ? "Recruiter has no email configured"
          : "Candidate has no email address",
      });
    }

    return { success: true, communicationId: emailCommId };
  },
});


// Trigger bulk manual follow-up outreach for multiple applications
export const triggerBulkFollowUp = mutation({
  args: {
    applicationIds: v.array(v.id("applications")),
  },
  handler: async (ctx, args) => {
    for (const appId of args.applicationIds) {
      await initiateFollowUpOutreach(ctx, appId, { isManual: true });
    }
    return { success: true };
  },
});

// Get communication status by ID for frontend polling
export const getCommunicationStatus = query({
  args: {
    communicationId: v.id("communications"),
  },
  handler: async (ctx, args) => {
    const comm = await ctx.db.get(args.communicationId);
    return comm ? { deliveryStatus: comm.deliveryStatus, errorMessage: comm.errorMessage } : null;
  },
});
