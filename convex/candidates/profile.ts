import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel.d.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuthUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ message: "Not authenticated", code: "UNAUTHENTICATED" });
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!user) throw new ConvexError({ message: "User not found", code: "NOT_FOUND" });
  return user;
}

// ─── Full candidate profile with quick stats ─────────────────────────────────

export const getFullProfile = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) return null;

    // Get all CVs for this candidate to extract the latest parsed info
    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .collect();

    // Get latest CV for structured data
    const latestCv = cvs.find((cv) => cv.isStructured) ?? cvs[0] ?? null;

    // Quick stats — pipeline entries for this candidate's CVs
    const cvIds = cvs.map((cv) => cv._id);

    // Count pipelines across all CVs of this candidate
    let applicationCount = 0;
    let placementCount = 0;
    let lastActivity: number | null = null;

    for (const cvId of cvIds) {
      const entries = await ctx.db
        .query("pipeline")
        .withIndex("by_cv", (q) => q.eq("cvId", cvId))
        .collect();
      applicationCount += entries.length;
      for (const entry of entries) {
        if (entry.stage === "hired") placementCount++;
        const movedTs = new Date(entry.movedAt).getTime();
        if (!lastActivity || movedTs > lastActivity) lastActivity = movedTs;
      }
    }

    return {
      ...candidate,
      latestCv,
      quickStats: {
        applicationCount,
        placementCount,
        cvCount: cvs.length,
        lastActivity,
      },
    };
  },
});

// ─── Tab: CVs ────────────────────────────────────────────────────────────────

export const getCandidateCvs = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .order("desc")
      .collect();

    return await Promise.all(
      cvs.map(async (cv) => {
        let url = await ctx.storage.getUrl(cv.storageId);
        if (url) {
          url = url.replace(/^http:\/\/(127\.0\.0\.1|localhost|convex|0\.0\.0\.0)(:\d+)?/, "https://api.career141.com");
        }
        return { ...cv, fileUrl: url };
      })
    );
  },
});

// ─── Tab: Applications (Cross-Job View) ──────────────────────────────────────

export const getCandidateApplications = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    // Get all CVs for this candidate
    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    const cvIds = new Set(cvs.map((cv) => cv._id));

    // Get all pipeline entries for these CVs
    const allEntries: Array<Doc<"pipeline"> & { job: Doc<"jobs"> | null; cvFileName: string }> = [];

    // Cache job lookups to avoid repeated fetches for the same job
    const jobCache = new Map<string, Doc<"jobs"> | null>();
    for (const cv of cvs) {
      const entries = await ctx.db
        .query("pipeline")
        .withIndex("by_cv", (q) => q.eq("cvId", cv._id))
        .collect();

      for (const entry of entries) {
        let job = jobCache.get(entry.jobId);
        if (job === undefined) {
          job = await ctx.db.get(entry.jobId);
          jobCache.set(entry.jobId, job);
        }
        allEntries.push({ ...entry, job, cvFileName: cv.fileName });
      }
    }

    // Sort: active first, then by date
    return allEntries.sort((a, b) => {
      const aActive = a.stage !== "hired" && a.stage !== "rejected";
      const bActive = b.stage !== "hired" && b.stage !== "rejected";
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return new Date(b.movedAt).getTime() - new Date(a.movedAt).getTime();
    });
  },
});

// ─── Tab: Notes (event log + legacy pipeline notes for backward compat) ──────

export const getCandidateNotes = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const notes: Array<{
      id: string;
      note: string;
      jobTitle: string;
      jobId: Id<"jobs">;
      authorName: string;
      movedAt: string;
    }> = [];

    // 1. Notes from the immutable event log (with author attribution)
    const events = await ctx.db
      .query("pipelineEvents")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    // Track which (job:cv) pairs have logged note events so we don't duplicate
    const pairsWithNoteEvents = new Set<string>();
    // Cache job lookups to avoid repeated fetches
    const jobCache = new Map<string, string>();

    for (const e of events) {
      if (e.eventType !== "note_added" || !e.notes) continue;
      pairsWithNoteEvents.add(`${e.jobId}:${e.cvId}`);
      let jobTitle = jobCache.get(e.jobId);
      if (jobTitle === undefined) {
        const job = await ctx.db.get(e.jobId);
        jobTitle = job?.title ?? "Unknown Job";
        jobCache.set(e.jobId, jobTitle);
      }
      notes.push({
        id: e._id,
        note: e.notes,
        jobTitle,
        jobId: e.jobId,
        authorName: e.actorName ?? (e.actorType === "system" ? "System" : "Recruiter"),
        movedAt: new Date(e._creationTime).toISOString(),
      });
    }

    // 2. Legacy notes stored directly on pipeline entries (pre-event-log)
    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    for (const cv of cvs) {
      const entries = await ctx.db
        .query("pipeline")
        .withIndex("by_cv", (q) => q.eq("cvId", cv._id))
        .collect();

      for (const entry of entries) {
        if (!entry.notes) continue;
        // Skip if this pair already has note events (avoids duplication)
        if (pairsWithNoteEvents.has(`${entry.jobId}:${entry.cvId}`)) continue;
        let jobTitle = jobCache.get(entry.jobId);
        if (jobTitle === undefined) {
          const job = await ctx.db.get(entry.jobId);
          jobTitle = job?.title ?? "Unknown Job";
          jobCache.set(entry.jobId, jobTitle);
        }
        notes.push({
          id: entry._id,
          note: entry.notes ?? "",
          jobTitle,
          jobId: entry.jobId,
          authorName: "Recruiter",
          movedAt: entry.movedAt,
        });
      }
    }

    return notes.sort((a, b) => new Date(b.movedAt).getTime() - new Date(a.movedAt).getTime());
  },
});

// ─── Tab: Timeline (event log + legacy pipeline entries + CV uploads) ────────

export const getCandidateTimeline = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    const events: Array<{
      id: string;
      type: string;
      jobTitle: string;
      jobId: Id<"jobs">;
      stage: string;
      fromStage: string | undefined;
      actorName: string | undefined;
      actorType: string | undefined;
      isBackwardMove: boolean | undefined;
      notes: string | undefined;
      movedAt: string;
      cvFileName: string;
    }> = [];

    // 1. Full audit trail from the event log
    const eventLog = await ctx.db
      .query("pipelineEvents")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    // Track (job:cv) pairs that have logged events
    const pairsWithEvents = new Set<string>();
    // Cache job lookups to avoid repeated fetches
    const jobCache = new Map<string, string>();

    for (const e of eventLog) {
      pairsWithEvents.add(`${e.jobId}:${e.cvId}`);
      let jobTitle = jobCache.get(e.jobId);
      if (jobTitle === undefined) {
        const job = await ctx.db.get(e.jobId);
        jobTitle = job?.title ?? "Unknown Job";
        jobCache.set(e.jobId, jobTitle);
      }
      events.push({
        id: e._id,
        type: e.eventType,
        jobTitle,
        jobId: e.jobId,
        stage: e.toStage ?? "",
        fromStage: e.fromStage,
        actorName: e.actorName ?? (e.actorType === "system" ? "System" : undefined),
        actorType: e.actorType,
        isBackwardMove: e.isBackwardMove,
        notes: e.notes,
        movedAt: new Date(e._creationTime).toISOString(),
        cvFileName: "",
      });
    }

    // 2. Legacy pipeline entries with no events (pre-event-log) — show current stage
    for (const cv of cvs) {
      const entries = await ctx.db
        .query("pipeline")
        .withIndex("by_cv", (q) => q.eq("cvId", cv._id))
        .collect();

      for (const entry of entries) {
        if (pairsWithEvents.has(`${entry.jobId}:${entry.cvId}`)) continue;
        let jobTitle = jobCache.get(entry.jobId);
        if (jobTitle === undefined) {
          const job = await ctx.db.get(entry.jobId);
          jobTitle = job?.title ?? "Unknown Job";
          jobCache.set(entry.jobId, jobTitle);
        }
        events.push({
          id: entry._id,
          type: "stage_change",
          jobTitle,
          jobId: entry.jobId,
          stage: entry.stage,
          fromStage: undefined,
          actorName: undefined,
          actorType: undefined,
          isBackwardMove: undefined,
          notes: entry.notes,
          movedAt: entry.movedAt,
          cvFileName: cv.fileName,
        });
      }
    }

    // 3. Include CV uploads as timeline events
    for (const cv of cvs) {
      events.push({
        id: `cv-${cv._id}`,
        type: "cv_uploaded",
        jobTitle: "",
        jobId: "" as Id<"jobs">,
        stage: "",
        fromStage: undefined,
        actorName: undefined,
        actorType: undefined,
        isBackwardMove: undefined,
        notes: undefined,
        movedAt: new Date(cv._creationTime).toISOString(),
        cvFileName: cv.fileName,
      });
    }

    return events.sort((a, b) => new Date(b.movedAt).getTime() - new Date(a.movedAt).getTime());
  },
});

// ─── Add note (delegates to the logged pipeline note mutation) ───────────────

export const addNote = mutation({
  args: {
    jobId: v.id("jobs"),
    cvId: v.id("cvs"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ message: "Not authenticated", code: "UNAUTHENTICATED" });
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!user) throw new ConvexError({ message: "User not found", code: "NOT_FOUND" });
    if (!args.note.trim()) throw new ConvexError({ message: "Note cannot be empty", code: "BAD_REQUEST" });

    const cv = await ctx.db.get(args.cvId);
    const candidateId = cv?.candidateId;

    const existing = await ctx.db
      .query("pipeline")
      .withIndex("by_job_and_cv", (q) => q.eq("jobId", args.jobId).eq("cvId", args.cvId))
      .unique();

    if (existing) {
      const existingNotes = existing.notes ? `${existing.notes}\n---\n${args.note.trim()}` : args.note.trim();
      await ctx.db.patch(existing._id, { notes: existingNotes });
    } else {
      await ctx.db.insert("pipeline", {
        jobId: args.jobId,
        cvId: args.cvId,
        candidateId,
        stage: "new",
        notes: args.note.trim(),
        movedAt: new Date().toISOString(),
        movedBy: user._id,
      });
    }

    await ctx.db.insert("pipelineEvents", {
      jobId: args.jobId,
      cvId: args.cvId,
      candidateId,
      eventType: "note_added",
      actorType: "user",
      actorId: user._id,
      actorName: user.fullName ?? user.email ?? "Recruiter",
      notes: args.note.trim(),
      createdAt: Date.now(),
    });
  },
});

// ─── Get active jobs for this candidate (for the note dropdown) ─────────────

export const getCandidateActiveJobs = query({
  args: { candidateId: v.id("candidates") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const cvs = await ctx.db
      .query("cvs")
      .withIndex("by_candidate", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    const jobIds = new Set<string>();
    const activeJobs: Array<{ jobId: Id<"jobs">; cvId: Id<"cvs">; title: string }> = [];

    for (const cv of cvs) {
      const entries = await ctx.db
        .query("pipeline")
        .withIndex("by_cv", (q) => q.eq("cvId", cv._id))
        .collect();

      for (const entry of entries) {
        if (entry.stage !== "hired" && entry.stage !== "rejected" && !jobIds.has(entry.jobId)) {
          jobIds.add(entry.jobId);
          const job = await ctx.db.get(entry.jobId);
          if (job) {
            activeJobs.push({ jobId: job._id, cvId: cv._id, title: job.title });
          }
        }
      }
    }

    return activeJobs;
  },
});
