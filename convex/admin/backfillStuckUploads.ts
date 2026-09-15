import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { matchJobFromText } from "../communications/whatchimp";

export const auditUnassignedWhatsappUploads = query({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db
      .query("ingestionLog")
      .withIndex("by_channel", (q) => q.eq("channelType", "whatsapp"))
      .order("desc")
      .take(20);

    const cvUploadsToInspect = [];
    for (const log of logs) {
      if (log.cvFileId) {
        const upload = await ctx.db.get(log.cvFileId);
        if (upload && !upload.assignToJob) {
          cvUploadsToInspect.push({
            uploadId: upload._id,
            candidateId: upload.candidateId,
            fileName: upload.fileName,
            status: upload.status,
            logJobId: log.jobId,
          });
        }
      }
    }

    return {
      totalWhatsappLogsInspected: logs.length,
      unassignedUploadsCount: cvUploadsToInspect.length,
      unassignedUploads: cvUploadsToInspect,
    };
  },
});

export const backfillStuckWhatsappUploads = mutation({
  args: {},
  handler: async (ctx) => {
    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    const logs = await ctx.db
      .query("ingestionLog")
      .withIndex("by_channel", (q) => q.eq("channelType", "whatsapp"))
      .order("desc")
      .take(20);

    let totalInspected = 0;
    let totalRepaired = 0;
    const repairedApplications: Array<{
      uploadId: string;
      candidateId: string;
      jobId: string;
      jobTitle: string;
      applicationId: string;
      isNewApp: boolean;
    }> = [];

    for (const log of logs) {
      totalInspected++;
      if (!log.cvFileId) continue;

      const upload = await ctx.db.get(log.cvFileId);
      if (!upload || !upload.candidateId) continue;

      const candidate = await ctx.db.get(upload.candidateId);
      if (!candidate) continue;

      // 1. Try to find matched job from candidate's inbound communications
      const inboundMsgs = await ctx.db
        .query("communications")
        .withIndex("by_candidate_time", (q) => q.eq("candidateId", candidate._id))
        .order("desc")
        .take(5);

      let matchedJob: any = null;
      let matchedKeyword = "";

      for (const msg of inboundMsgs) {
        if (msg.body) {
          const matchResult = matchJobFromText(activeJobs, msg.body);
          if (matchResult.matchedJob) {
            matchedJob = matchResult.matchedJob;
            matchedKeyword = matchResult.matchedKeyword;
            break;
          }
        }
      }

      // 2. Check log's jobId if available
      if (!matchedJob && log.jobId) {
        matchedJob = activeJobs.find((j) => j._id === log.jobId);
      }

      // 3. Fallback: Match against active job titles
      if (!matchedJob) {
        for (const job of activeJobs) {
          const titleUpper = job.title.toUpperCase();
          if (titleUpper.includes("GRAPHIC") || titleUpper.includes("VIDEO")) {
            const searchTerms = titleUpper.split(" ");
            const hasMatch = inboundMsgs.some((m) =>
              m.body && searchTerms.some((st) => m.body.toUpperCase().includes(st))
            );
            if (hasMatch) {
              matchedJob = job;
              matchedKeyword = job.title;
              break;
            }
          }
        }
      }

      if (!matchedJob) continue;

      // Patch upload with assignToJob if missing
      if (!upload.assignToJob) {
        await ctx.db.patch(upload._id, {
          assignToJob: matchedJob._id,
        });
      }

      // Patch ingestionLog routing status
      if (log.routingStatus === "unrouted") {
        await ctx.db.patch(log._id, {
          jobId: matchedJob._id,
          routingStatus: "routed",
        });
      }

      // Check if application already exists for (candidate._id, matchedJob._id)
      const existingApp = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
        .filter((q) => q.eq(q.field("jobId"), matchedJob._id))
        .first();

      let appId: any = null;
      let isNewApp = false;

      if (existingApp) {
        appId = existingApp._id;
        if (existingApp.currentStage === "matched_candidates") {
          await ctx.db.patch(existingApp._id, {
            currentStage: "new_cvs",
            cvFileId: upload._id,
            lastStageChangedAt: Date.now(),
          });
        }
      } else {
        const now = Date.now();
        appId = await ctx.db.insert("applications", {
          candidateId: candidate._id,
          jobId: matchedJob._id,
          cvFileId: upload._id,
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
          candidateName: candidate.fullName || undefined,
          candidatePhone: candidate.phone || undefined,
          candidateEmail: candidate.email || undefined,
          candidateTitle: candidate.currentJobTitle || undefined,
        } as any);
        isNewApp = true;
      }

      totalRepaired++;
      repairedApplications.push({
        uploadId: upload._id,
        candidateId: candidate._id,
        jobId: matchedJob._id,
        jobTitle: matchedJob.title,
        applicationId: appId,
        isNewApp,
      });
    }

    return {
      success: true,
      totalInspected,
      totalRepaired,
      repairedApplications,
    };
  },
});
