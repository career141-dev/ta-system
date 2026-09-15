import { mutation, internalMutation, query } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

/**
 * Adjusts the stageCounts on a job document when an application moves stages.
 * This eliminates the need for expensive polling/crons.
 */
export async function adjustJobStageStat(
  ctx: any,
  jobId: Id<"jobs">,
  oldStage: string | null,
  newStage: string,
  isNewApplication = false,
  isDeletedApplication = false
) {
  const job = await ctx.db.get(jobId);
  if (!job) return;

  const stageCounts = job.stageCounts || {};
  let totalApplications = job.totalApplications || 0;

  if (isNewApplication) {
    totalApplications += 1;
    stageCounts[newStage] = (stageCounts[newStage] || 0) + 1;
  } else if (isDeletedApplication) {
    totalApplications = Math.max(0, totalApplications - 1);
    if (oldStage && stageCounts[oldStage]) {
      stageCounts[oldStage] = Math.max(0, stageCounts[oldStage] - 1);
    }
  } else if (oldStage !== newStage) {
    // Moving between stages
    if (oldStage && stageCounts[oldStage]) {
      stageCounts[oldStage] = Math.max(0, stageCounts[oldStage] - 1);
    }
    stageCounts[newStage] = (stageCounts[newStage] || 0) + 1;
  }

  await ctx.db.patch(jobId, {
    stageCounts,
    totalApplications,
  });
}

// Optional: Wrap in an internal mutation if it needs to be called from an action.
export const adjustStats = internalMutation({
  args: {
    jobId: v.id("jobs"),
    oldStage: v.union(v.string(), v.null()),
    newStage: v.string(),
    isNewApplication: v.optional(v.boolean()),
    isDeletedApplication: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await adjustJobStageStat(
      ctx,
      args.jobId,
      args.oldStage,
      args.newStage,
      args.isNewApplication,
      args.isDeletedApplication
    );
  },
});

/**
 * Real-time query for dashboard "Needs Attention" items:
 * - Aging Jobs: Jobs created over 1 month ago (>= 30 days) that remain open/unfilled
 * - Stalled Candidates: Candidates in active stages past SLA thresholds
 */
export const getNeedsAttention = query({
  args: {
    jobFilter: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ONE_DAY_MS = 1000 * 60 * 60 * 24;

    // Optional user identity lookup for "My Jobs"
    let currentUserId: Id<"users"> | null = null;
    try {
      const identity = await ctx.auth.getUserIdentity();
      if (identity) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
          .first();
        if (user) currentUserId = user._id;
      }
    } catch (_) {}

    // Bounded queries for active and on-hold jobs
    const activeJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(100);

    const onHoldJobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "on_hold"))
      .take(50);

    let allJobs = [...activeJobs, ...onHoldJobs];

    if (args.jobFilter === "Active Jobs") {
      allJobs = activeJobs;
    } else if (args.jobFilter === "My Jobs" && currentUserId) {
      allJobs = allJobs.filter(
        (j) =>
          j.primaryRecruiterId === currentUserId ||
          j.supportingRecruiterIds?.includes(currentUserId!)
      );
    }

    // Pre-fetch user map for recruiters to avoid N+1 queries
    const recruiterIds = new Set<Id<"users">>();
    for (const job of allJobs) {
      if (job.primaryRecruiterId) recruiterIds.add(job.primaryRecruiterId);
    }

    const userDocs = await Promise.all(
      Array.from(recruiterIds).map((id) => ctx.db.get(id))
    );
    const userMap = new Map<string, any>();
    for (const u of userDocs) {
      if (u) userMap.set(u._id, u);
    }

    const items: Array<{
      id: string;
      type: "aging_job" | "stalled_candidate";
      jobId: string;
      candidateId?: string;
      candidateName?: string;
      jobTitle: string;
      clientName: string;
      stage: string;
      days: number;
      daysColor: string;
      alertMessage: string;
      recruiterName: string;
      initials: string;
      avatarColor: string;
      status: string;
      createdAt: string;
    }> = [];

    const getInitials = (name?: string, email?: string) => {
      if (name) {
        const parts = name.trim().split(" ");
        if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
        return name.slice(0, 2).toUpperCase();
      }
      if (email) return email.slice(0, 2).toUpperCase();
      return "TA";
    };

    const AVATAR_COLORS = [
      "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
      "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    ];

    for (const job of allJobs) {
      const createdDate = new Date(job.createdAt).getTime();
      const daysOpen = isNaN(createdDate) ? 0 : Math.floor((now - createdDate) / ONE_DAY_MS);

      // Check if job is aging (open >= 30 days / 1 month+)
      if (daysOpen >= 30) {
        const recruiter = userMap.get(job.primaryRecruiterId);
        const recruiterName =
          recruiter?.fullName || recruiter?.name || recruiter?.email?.split("@")[0] || "Unassigned";
        const initials = getInitials(recruiter?.fullName || recruiter?.name, recruiter?.email);

        let daysColor = "text-amber-600 dark:text-amber-400";
        let alertMessage = `Opened over 1 month ago (${daysOpen}d) — Still open`;

        if (daysOpen >= 60) {
          daysColor = "text-red-600 dark:text-red-400";
          alertMessage = `Critical: Opened ${daysOpen}d ago (> 2 months) — Unfilled`;
        }

        const colorIdx = (job._id.charCodeAt(0) || 0) % AVATAR_COLORS.length;

        items.push({
          id: job._id,
          type: "aging_job",
          jobId: job._id,
          jobTitle: job.title,
          clientName: job.clientName,
          stage: job.status === "active" ? "Active (Unfilled)" : "On Hold",
          days: daysOpen,
          daysColor,
          alertMessage,
          recruiterName,
          initials,
          avatarColor: AVATAR_COLORS[colorIdx],
          status: job.status,
          createdAt: job.createdAt,
        });
      }
    }

    // Sort items: longest open first
    items.sort((a, b) => b.days - a.days);

    return items;
  },
});

