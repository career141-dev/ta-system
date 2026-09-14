import { v } from "convex/values";
import { query, mutation, action } from "../_generated/server";
import { api } from "../_generated/api";
import { adjustJobStageStat } from "../jobs/stats";
import { syncCandidateOverallStatus } from "../candidates/candidates";

function isManualDirectoryChannel(channel: string | undefined | null): boolean {
  if (!channel) return false;
  const lower = channel.toLowerCase();
  return lower.includes("manual") || lower.includes("directory") || lower.includes("folder");
}

/**
 * Preview query: Counts all applications currently in 'new_cvs' that originate
 * from manual directory / folder uploads, grouped by job.
 */
export const previewManualDirectoryApps = query({
  args: {},
  handler: async (ctx) => {
    const appsInNewCvs = await ctx.db
      .query("applications")
      .withIndex("by_stage", (q) => q.eq("currentStage", "new_cvs"))
      .collect();

    const manualApps = appsInNewCvs.filter((a) => isManualDirectoryChannel(a.sourceChannel));

    const jobCounts: Record<string, { title: string; count: number }> = {};
    for (const app of manualApps) {
      const jId = String(app.jobId);
      if (!jobCounts[jId]) {
        const job = await ctx.db.get(app.jobId);
        jobCounts[jId] = {
          title: job?.title || "Unknown Job",
          count: 0,
        };
      }
      jobCounts[jId].count++;
    }

    return {
      totalInNewCvs: appsInNewCvs.length,
      stuckManualInNewCvs: manualApps.length,
      affectedJobsCount: Object.keys(jobCounts).length,
      jobsBreakdown: jobCounts,
    };
  },
});

/**
 * Batch mutation: Migrates up to `batchSize` stuck applications from 'new_cvs'
 * to 'matched_candidates', updating job stats and candidate statuses.
 */
export const migrateManualDirectoryAppsBatch = mutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.batchSize ?? 200;
    const now = Date.now();

    const appsInNewCvs = await ctx.db
      .query("applications")
      .withIndex("by_stage", (q) => q.eq("currentStage", "new_cvs"))
      .take(limit * 3); // Fetch a buffer to filter manual channels

    const toMigrate = appsInNewCvs
      .filter((a) => isManualDirectoryChannel(a.sourceChannel))
      .slice(0, limit);

    if (toMigrate.length === 0) {
      return {
        migratedCount: 0,
        isDone: true,
      };
    }

    const affectedCandidates = new Set<string>();

    for (const app of toMigrate) {
      const stageHistory = app.stageHistory || [];
      stageHistory.push({
        stage: "matched_candidates" as any,
        enteredAt: new Date(now).toISOString(),
        changedBy: "system",
      });

      await ctx.db.patch(app._id, {
        currentStage: "matched_candidates" as any,
        lastStageChangedAt: now,
        stageHistory,
      });

      // Update stage counts on job (decrement new_cvs, increment matched_candidates)
      await adjustJobStageStat(ctx, app.jobId, "new_cvs", "matched_candidates");

      affectedCandidates.add(String(app.candidateId));
    }

    // Sync overall status for candidates affected in this batch
    for (const candIdStr of affectedCandidates) {
      await syncCandidateOverallStatus(ctx, candIdStr as any);
    }

    return {
      migratedCount: toMigrate.length,
      isDone: toMigrate.length < limit,
    };
  },
});

/**
 * Action runner: Iteratively processes batches until all stuck manual directory apps
 * are moved from 'new_cvs' to 'matched_candidates'.
 */
export const runFullManualDirectoryMigration = action({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 150;
    let totalMigrated = 0;
    let iterations = 0;
    const maxIterations = 50; // Safety brake

    while (iterations < maxIterations) {
      iterations++;
      const res: any = await ctx.runMutation(
        api.admin.migrateManualDirectoryApps.migrateManualDirectoryAppsBatch,
        { batchSize }
      );

      totalMigrated += res.migratedCount;
      console.log(`[Migration] Iteration #${iterations}: Migrated ${res.migratedCount} applications (Total: ${totalMigrated})`);

      if (res.isDone || res.migratedCount === 0) {
        break;
      }
    }

    return {
      success: true,
      totalMigrated,
      iterations,
    };
  },
});

/**
 * Moves manual directory / database applications out of the pipeline
 * and into the job's reverseMatchResults (the 'Matches' tab).
 * Genuine pipeline channels (linkedin, whatsapp, headhunt, email, email_campaign, etc.) are preserved.
 */
export const moveJobManualAppsToMatches = mutation({
  args: {
    jobId: v.id("jobs"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found: " + args.jobId);

    const limit = args.limit ?? 50;

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    // Allowed genuine pipeline channels:
    const genuinePipelineChannels = new Set([
      "linkedin",
      "whatsapp",
      "headhunt",
      "email",
      "email_campaign",
      "meta",
      "job_board",
      "portal",
    ]);

    const allManualApps = apps.filter((a) => {
      if (!a.sourceChannel) return true;
      const lower = a.sourceChannel.toLowerCase().trim();
      if (genuinePipelineChannels.has(lower)) return false;
      return (
        lower.includes("manual") ||
        lower.includes("directory") ||
        lower.includes("folder") ||
        lower === "database"
      );
    });

    if (allManualApps.length === 0) {
      return {
        jobTitle: job.title,
        jobId: args.jobId,
        movedCount: 0,
        remainingInJob: 0,
        alreadyClean: true,
      };
    }

    const batch = allManualApps.slice(0, limit);

    const existingMatchResults = job.reverseMatchResults || [];
    const existingCvIds = new Set(existingMatchResults.map((r) => String(r.cvId)));
    const newMatches = [...existingMatchResults];
    let addedCount = 0;

    const stageCounts = { ...(job.stageCounts || {}) };
    let totalApplications = job.totalApplications || 0;

    for (const app of batch) {
      const cvId = String(app.candidateId);
      if (!existingCvIds.has(cvId)) {
        newMatches.push({
          cvId,
          candidateName: app.candidateName || "Candidate",
          candidateRole: app.candidateTitle || "Candidate",
          candidateExp: app.candidateExperience,
          overallScore: app.aiMatchScore ?? 70,
          reason: app.aiMatchExplanation || "Matched from database / manual directory import",
          sourceLevel1: "Database",
          matchedSkills: [],
          missingSkills: [],
          breakdown: { skills: 70, experience: 70, seniority: 70, industry: 70, location: 70 },
        });
        existingCvIds.add(cvId);
        addedCount++;
      }

      // Decrement stage stat in memory
      totalApplications = Math.max(0, totalApplications - 1);
      if (app.currentStage && stageCounts[app.currentStage]) {
        stageCounts[app.currentStage] = Math.max(0, stageCounts[app.currentStage] - 1);
      }

      // Delete the pipeline application
      await ctx.db.delete(app._id);
    }

    // Save updated job document ONCE per batch
    await ctx.db.patch(args.jobId, {
      reverseMatchResults: newMatches,
      reverseMatchStatus: "done",
      reverseMatchedAt: new Date().toISOString(),
      stageCounts,
      totalApplications,
    });

    return {
      jobTitle: job.title,
      jobId: args.jobId,
      movedCount: batch.length,
      remainingInJob: allManualApps.length - batch.length,
      addedToMatches: addedCount,
      totalMatchesNow: newMatches.length,
      remainingPipelineApps: apps.length - batch.length,
    };
  },
});

/**
 * Action runner to iterate across all active jobs and move all manual directory/database
 * applications from the pipeline to each job's reverseMatchResults (the 'Matches' tab).
 */
export const moveAllJobsManualAppsToMatchesAction = action({
  args: {},
  handler: async (ctx) => {
    const activeJobs: any = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo, {});
    const results = [];

    for (const job of (activeJobs || [])) {
      try {
        const res: any = await ctx.runMutation(
          api.admin.migrateManualDirectoryApps.moveJobManualAppsToMatches,
          { jobId: job._id }
        );
        if (res.movedCount > 0) {
          console.log(`[MoveToMatches] Job "${res.jobTitle}": moved ${res.movedCount} apps to Matches (total matches: ${res.totalMatchesNow}, remaining pipeline: ${res.remainingPipelineApps})`);
          results.push(res);
        }
      } catch (err: any) {
        console.error(`[MoveToMatches] Error processing job "${job.title}":`, err.message);
      }
    }

    return {
      totalJobsProcessed: (activeJobs || []).length,
      affectedJobsCount: results.length,
      totalMovedToMatches: results.reduce((sum, r) => sum + r.movedCount, 0),
      jobDetails: results,
    };
  },
});

