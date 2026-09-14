import { query, action, mutation } from "./_generated/server";
import { api } from "./_generated/api";
import OpenAI from "openai";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { initiateFollowUpOutreach } from "./pipeline/followUpHelper";

export const ping = query({
  args: {},
  handler: async () => {
    return "ok";
  },
});

export const getRecentUploads = query({
  args: {},
  handler: async (ctx) => {
    const recentCvUploads = await ctx.db
      .query("cvUploads")
      .order("desc")
      .take(20);
    return recentCvUploads;
  },
});



export const getBacklogCompositionMetrics = query({
  args: {},
  handler: async (ctx) => {
    const uploaded = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "uploaded"))
      .collect();

    const processing = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .collect();

    const needsReview = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "needs_review"))
      .collect();

    const now = Date.now();
    const fortyEightHoursMs = 48 * 60 * 60 * 1000;

    let groupA = 0; // Text (PDF, DOCX, DOC, TXT, RTF)
    let groupB = 0; // Image / Scanned (PNG, JPG, JPEG, WEBP, TIFF)
    let freshCount = 0; // < 48 hours old
    let historicalCount = 0; // >= 48 hours old

    for (const item of uploaded) {
      const ext = (item.fileType || item.fileName || "").toLowerCase();
      if (ext.includes("png") || ext.includes("jpg") || ext.includes("jpeg") || ext.includes("webp") || ext.includes("tiff") || ext.includes("image")) {
        groupB++;
      } else {
        groupA++;
      }

      if (now - item._creationTime < fortyEightHoursMs) {
        freshCount++;
      } else {
        historicalCount++;
      }
    }

    return {
      totalUploaded: uploaded.length,
      totalProcessing: processing.length,
      totalNeedsReview: needsReview.length,
      groupA_text: groupA,
      groupB_scanned: groupB,
      freshUnder48h: freshCount,
      historicalOver48h: historicalCount,
      sampleUploadedIds: uploaded.slice(0, 25).map((u) => ({
        id: u._id,
        fileName: u.fileName,
        fileType: u.fileType,
        creationTime: new Date(u._creationTime).toISOString(),
      })),
    };
  },
});

export const resetStuckProcessingToUploaded = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const processing = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(limit);

    let resetCount = 0;
    for (const item of processing) {
      if (item.storageId || item.s3Key) {
        await ctx.db.patch(item._id, {
          status: "uploaded",
          processingStartedAt: undefined,
          errorMessage: undefined,
        });
        resetCount++;
      }
    }
    return { resetCount, remainingProcessing: processing.length - resetCount };
  },
});

export const getCandidateDetailsForQa = query({
  args: { candidateId: v.string() },
  handler: async (ctx, args) => {
    const validId = ctx.db.normalizeId("candidates", args.candidateId);
    if (!validId) return null;
    const cand = await ctx.db.get(validId);
    if (!cand) return null;
    return {
      id: cand._id,
      fullName: cand.fullName,
      email: cand.email,
      phone: cand.phone,
      skills: cand.skills,
      jobHistory: cand.jobHistory,
    };
  },
});

export const triggerTestCV = action({
  args: {},
  handler: async (ctx) => {
    const testHash = "e6ab5333bdce41b47020c775aa17f63cb39bedba6a59ae09577aba88ccb240e6";
    const testKey = "cvs/2026-07/1784723522530-JAYANDHARAN_P_.pdf";
    
    await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
      jobId: "m17abwpzg8ekcqq34e4kw5y6jx8b1p7r" as any,
      sourceChannel: "linkedin",
      rawSender: "test-linkedin-app@career141.com",
      s3Key: testKey,
      storageProvider: "r2",
      fileHash: testHash,
      fileName: "TEST_LINKEDIN_IT_APPLICANT.pdf",
      fileType: "application/pdf",
      fileSizeBytes: 48404,
      extractionDelayMs: 0,
    });
    
    return { success: true, message: "Ingestion triggered successfully! Watch the dashboard." };
  },
});

export const deleteItDummy = mutation({
  args: {},
  handler: async (ctx) => {
    const candidateId = "j978zd52crzdy6fmb3skxqpkn58b0e69" as Id<"candidates">;
    
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId))
      .collect();
    for (const a of apps) {
      await ctx.db.delete(a._id);
    }
    
    const resumes = await ctx.db
      .query("candidateResumes")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId))
      .collect();
    for (const r of resumes) {
      await ctx.db.delete(r._id);
    }
    
    const exists = await ctx.db.get(candidateId);
    if (exists) {
      await ctx.db.delete(candidateId);
    }

    // Recalculate and update job stats for Head of IT job
    const jobId = "m17abwpzg8ekcqq34e4kw5y6jx8b1p7r" as Id<"jobs">;
    const remainingApps = await ctx.db
      .query("applications")
      .withIndex("by_job_active", (q) => q.eq("jobId", jobId))
      .collect();
      
    const newStageCounts: Record<string, number> = {};
    for (const app of remainingApps) {
      if (app.isActive) {
        newStageCounts[app.currentStage] = (newStageCounts[app.currentStage] || 0) + 1;
      }
    }
    
    await ctx.db.patch(jobId, {
      totalApplications: remainingApps.length,
      stageCounts: newStageCounts,
    });
    
    return { success: true };
  },
});

export const reprocessFailedITUploads = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("cvUploads").collect();
    const failedIT = all.filter(
      (u) =>
        u.assignToJob === "m17abwpzg8ekcqq34e4kw5y6jx8b1p7r" &&
        (u.status === "failed" || u.status === "failed_retry")
    );
    
    let count = 0;
    for (const upload of failedIT) {
      await ctx.db.patch(upload._id, { status: "pending", errorMessage: undefined });
      
      const delayOffset = count * 4000;
      await ctx.scheduler.runAfter(delayOffset, api.cvs.cvExtraction.processCvExtraction, {
        storageId: upload.storageId,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider,
        fileType: upload.fileType,
        sourceChannel: upload.source ?? "email",
        uploadedBy: "system",
        cvUploadId: upload._id,
      });
      count++;
    }
    return { success: true, count };
  },
});

export const getUploadById = query({
  args: { cvUploadId: v.id("cvUploads") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.cvUploadId);
  },
});

export const getIngestionLogForFile = query({
  args: { cvFileId: v.id("cvUploads") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ingestionLog")
      .withIndex("by_cvFileId", (q: any) => q.eq("cvFileId", args.cvFileId))
      .first();
  },
});

export const getIngestionLogShabeen = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("ingestionLog")
      .withIndex("by_cvFileId", (q: any) => q.eq("cvFileId", "jd7acvpnxa2ya50btd5v1xdbk58b0h3h"))
      .first();
  },
});

export const getUploadStatusDetails = query({
  args: {},
  handler: async (ctx) => {
    const ids = [
      "jd7b72zqn5np6d786pype144fh8b01ma", // Wasantha
      "jd7ce95dkrvabgxfj7zdwh8vn98b1pxh", // Deepal
      "jd7acvpnxa2ya50btd5v1xdbk58b0h3h", // Shabeen
      "jd72jyv919w931y5tm7zza6pm58b0kvn", // Aruna
    ];
    const results = [];
    for (const id of ids) {
      const doc = (await ctx.db.get(id as any)) as any;
      results.push({ id, fileName: doc?.fileName, status: doc?.status, errorMessage: doc?.errorMessage });
    }
    return results;
  },
});

export const setUploadPending = mutation({
  args: { cvUploadId: v.id("cvUploads") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.cvUploadId, { status: "pending", errorMessage: undefined });
  },
});

export const reprocessSingleUpload = action({
  args: { cvUploadId: v.id("cvUploads") },
  handler: async (ctx, args) => {
    const upload = await ctx.runQuery(api.health.getUploadById, { cvUploadId: args.cvUploadId });
    if (!upload) return { success: false, reason: "not_found" };
    
    await ctx.runMutation(api.health.setUploadPending, { cvUploadId: args.cvUploadId });
    
    await ctx.runAction(api.cvs.cvExtraction.processCvExtraction, {
      storageId: upload.storageId,
      s3Key: upload.s3Key,
      storageProvider: upload.storageProvider,
      fileType: upload.fileType,
      sourceChannel: upload.source ?? "email",
      uploadedBy: "system",
      cvUploadId: upload._id,
    });
    
    return { success: true };
  },
});

export const resetBinathToNewCvs = mutation({
  args: {},
  handler: async (ctx) => {
    const job = await ctx.db
      .query("jobs")
      .withIndex("by_keyword", (q) => q.eq("keyword", "DEV-TEST"))
      .first();

    if (!job) throw new Error("DEV-TEST job not found");

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) => q.eq("jobId", job._id))
      .collect();

    for (const app of apps) {
      await ctx.db.patch(app._id, {
        currentStage: "new_cvs",
        followUpEnteredAt: undefined,
        followUpState: undefined,
        followUpCvReceived: false,
        followUpCurrentSalary: false,
        followUpExpectedSalary: false,
        followUpNoticePeriod: false,
        lastStageChangedAt: Date.now(),
        isActive: true,
      });

      const candidate = await ctx.db.get(app.candidateId);
      if (candidate) {
        await ctx.db.patch(candidate._id, {
          fullName: "Binath Test Candidate",
          email: "hdbinath@gmail.com",
          phone: "+94742625552",
          currentSalary: undefined,
          expectedSalary: undefined,
          noticePeriodDays: undefined,
          cvUploadId: undefined,
        });
      }
    }

    return { success: true, count: apps.length };
  },
});

export const triggerShortlistFollowUpInternal = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.applicationId, {
      currentStage: "ta_shortlist",
      followUpEnteredAt: Date.now(),
      lastStageChangedAt: Date.now(),
    });
    const commId = await initiateFollowUpOutreach(ctx, args.applicationId);
    return { success: true, commId };
  },
});

export const addTestCandidateForDevJob = mutation({
  args: {
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const targetEmail = args.email || "hdbinath@gmail.com";
    const targetPhone = args.phone || "0742625552";
    const formattedPhone = targetPhone.startsWith("+") ? targetPhone : `+94${targetPhone.replace(/^0/, "")}`;

    // 1. Find Development Test Job
    let job = await ctx.db
      .query("jobs")
      .withIndex("by_keyword", (q) => q.eq("keyword", "DEV-TEST"))
      .first();

    if (!job) {
      const allJobs = await ctx.db.query("jobs").collect();
      job = allJobs.find(j => j.title.toLowerCase().includes("development test")) || null;
    }

    if (!job) {
      throw new Error("Development Test Job not found in database");
    }

    // 2. Find or Create Candidate
    let candidate = await ctx.db
      .query("candidates")
      .withIndex("by_email", (q) => q.eq("email", targetEmail))
      .first();

    let candidateId;
    const now = Date.now();

    if (candidate) {
      candidateId = candidate._id;
      await ctx.db.patch(candidateId, {
        fullName: "Binath Test Candidate",
        phone: formattedPhone,
      });
    } else {
      candidateId = await ctx.db.insert("candidates", {
        fullName: "Binath Test Candidate",
        email: targetEmail,
        phone: formattedPhone,
        currentJobTitle: "Software Developer",
        totalExperienceYears: 3,
        status: "active",
        overallStatus: "new_cvs",
      });
    }

    // 3. Find or Create Application in "new_cvs" stage
    let app = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId))
      .filter((q) => q.eq(q.field("jobId"), job._id))
      .first();

    let applicationId;
    if (app) {
      applicationId = app._id;
      await ctx.db.patch(app._id, {
        currentStage: "new_cvs",
        isActive: true,
        candidateName: "Test Candidate (Binath)",
        candidateEmail: targetEmail,
        candidatePhone: formattedPhone,
        lastStageChangedAt: now,
      });
    } else {
      applicationId = await ctx.db.insert("applications", {
        candidateId,
        jobId: job._id,
        sourceChannel: "email",
        candidateName: "Test Candidate (Binath)",
        candidateEmail: targetEmail,
        candidatePhone: formattedPhone,
        currentStage: "new_cvs",
        loopIteration: 1,
        isActive: true,
        lastStageChangedAt: now,
        createdAt: now,
      });
    }

    return {
      success: true,
      jobId: job._id,
      jobTitle: job.title,
      candidateId,
      applicationId,
      email: targetEmail,
      phone: formattedPhone,
    };
  },
});



export const listStuckScheduledTasks = query({
  args: {},
  handler: async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled.map((job) => ({
      id: job._id,
      name: job.name,
      state: job.state,
      scheduledTime: job.scheduledTime,
      completedTime: job.completedTime,
    }));
  },
});

export const cancelStuckScheduledTasks = mutation({
  args: {},
  handler: async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    let canceledCount = 0;
    const canceledNames: string[] = [];

    for (const job of scheduled) {
      if (job.state.kind === "pending" || job.state.kind === "inProgress") {
        try {
          await ctx.scheduler.cancel(job._id);
          canceledCount++;
          canceledNames.push(job.name);
        } catch (err) {
          console.warn(`[cancelStuckScheduledTasks] Could not cancel task ${job._id}:`, err);
        }
      }
    }

    return {
      success: true,
      canceledCount,
      canceledNames,
    };
  },
});

export const inspectProcessingUploads = query({
  args: {},
  handler: async (ctx) => {
    const list = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(10);
    return list.map((u) => ({
      id: u._id,
      fileName: u.fileName,
      status: u.status,
      creationTime: u._creationTime,
      processingStartedAt: (u as any).processingStartedAt,
      ageMinutes: Math.round((Date.now() - ((u as any).processingStartedAt ?? u._creationTime)) / 60000),
    }));
  },
});

export const recoverStuckUploadsDirect = mutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(50);

    let count = 0;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const upload of stuck) {
      const processingStartMs = (upload as any).processingStartedAt ?? upload._creationTime;
      if (processingStartMs < tenMinutesAgo) {
        await ctx.db.patch(upload._id, {
          status: "failed",
          errorMessage: "Process interrupted or timed out (>10m)",
        });
        count++;
      }
    }
    return { recoveredCount: count };
  },
});

