import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

// Healer tuning
export const HEALER_INTERVAL_MINUTES = 31; // must match crons.ts "bg-healer-cv-extractor"
const HEAL_BATCH_SIZE = 5; // records dispatched per tick
const MAX_HEAL_ATTEMPTS = 3; // dispatches before a record is flagged for human review
const STUCK_HEALING_MS = 15 * 60 * 1000; // "healing" with no extraction start after this is considered lost
const CANDIDATE_SCAN_SIZE = 50; // candidates inspected per tick

/**
 * Checks if a candidate profile is COMPLETELY EMPTY (all 5 core fields are missing/empty).
 * Per requirements: Re-extraction only occurs if ALL 5 fields are empty.
 * If ANY of the 5 fields are present, do NOT heal that candidate.
 *
 * 1. Name (fullName)
 * 2. Contact (email or phone)
 * 3. Skills (skills array)
 * 4. Experience (jobHistory array)
 * 5. Summary (summary string)
 */
function isCandidateCompletelyEmpty(c: any): boolean {
  if (!c) return true;
  const hasName = Boolean(c.fullName && c.fullName.trim());
  const hasContact = Boolean((c.email && c.email.trim()) || (c.phone && c.phone.trim()) || (c.phoneClean && c.phoneClean.trim()));
  const hasSkills = Array.isArray(c.skills) && c.skills.length > 0;
  const hasJobHistory = Array.isArray(c.jobHistory) && c.jobHistory.length > 0;
  const hasSummary = Boolean(c.summary && c.summary.trim());

  // If ANY of the 5 fields exist, candidate is NOT completely empty (do NOT heal)
  const hasAnyField = hasName || hasContact || hasSkills || hasJobHistory || hasSummary;
  return !hasAnyField;
}

type HealTarget = {
  cvUploadId: Id<"cvUploads">;
  candidateId?: Id<"candidates">;
  storageId?: Id<"_storage">;
  s3Key: string;
  storageProvider: string;
  fileName: string;
  fileType: string;
  source: string;
  uploadedBy: string;
  healAttempt: number;
};

function toTarget(upload: Doc<"cvUploads">, healAttempt: number, fallbackSource?: string): HealTarget {
  return {
    cvUploadId: upload._id,
    candidateId: upload.candidateId ?? undefined,
    storageId: upload.storageId,
    s3Key: upload.s3Key || "",
    storageProvider: upload.storageProvider || "r2",
    fileName: upload.fileName || "document.pdf",
    fileType: upload.fileType || "pdf",
    source: upload.source || fallbackSource || "Direct Import",
    uploadedBy: upload.uploadedBy || "System Worker",
    healAttempt,
  };
}

/**
 * Claims up to HEAL_BATCH_SIZE records for re-extraction, in priority order:
 *   1. Records stuck in "healing" (dispatched but extraction never started) — retried up to
 *      MAX_HEAL_ATTEMPTS, then moved to "needs_review".
 *   2. "uploaded" uploads not yet heal-attempted.
 *   3. Completely empty candidates (isHealAttempted false or never set) with a stored CV file.
 * Every record inspected is marked, so the scan always advances instead of re-reading the same rows.
 */
export const claimHealBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const targets: HealTarget[] = [];
    let recoveredStuck = 0;
    let flaggedForReview = 0;
    let candidatesChecked = 0;

    // 1. Recover records stuck in "healing"
    const healing = await ctx.db
      .query("cvUploads")
      .withIndex("by_status", (q) => q.eq("status", "healing"))
      .take(50);

    for (const upload of healing) {
      if (targets.length >= HEAL_BATCH_SIZE) break;
      const lastDispatch = upload.lastHealAt ?? upload.processingStartedAt ?? upload._creationTime;
      if (now - lastDispatch < STUCK_HEALING_MS) continue; // still in flight

      // Legacy records predate attempt counting; they already had one dispatch.
      const attempts = upload.healAttempts ?? 1;
      if (attempts >= MAX_HEAL_ATTEMPTS || (!upload.s3Key && !upload.storageId)) {
        await ctx.db.patch(upload._id, {
          status: "needs_review",
          errorMessage: !upload.s3Key && !upload.storageId
            ? "File missing permanently (neither R2 nor Convex storage)"
            : `Healer dispatched extraction ${attempts} times but it never completed. Flagged for review.`,
        });
        flaggedForReview++;
        continue;
      }

      await ctx.db.patch(upload._id, { healAttempts: attempts + 1, lastHealAt: now });
      targets.push(toTarget(upload, attempts + 1));
      recoveredStuck++;
    }

    // 2. Fresh "uploaded" records not yet heal-attempted
    if (targets.length < HEAL_BATCH_SIZE) {
      const uploaded = await ctx.db
        .query("cvUploads")
        .withIndex("by_status", (q) => q.eq("status", "uploaded"))
        .take(20);

      for (const upload of uploaded) {
        if (targets.length >= HEAL_BATCH_SIZE) break;
        // Already heal-attempted "uploaded" records are left to the main extraction queue cron.
        if (upload.isHealAttempted) continue;

        if (!upload.s3Key && !upload.storageId) {
          await ctx.db.patch(upload._id, {
            isHealAttempted: true,
            status: "failed",
            errorMessage: "File missing permanently (neither R2 nor Convex storage)",
          });
          continue;
        }

        if (upload.candidateId) {
          const candidate = await ctx.db.get(upload.candidateId);
          if (candidate && !isCandidateCompletelyEmpty(candidate)) {
            await ctx.db.patch(upload._id, { status: "processed", isHealAttempted: true });
            continue;
          }
          await ctx.db.patch(upload.candidateId, { isHealAttempted: true });
        }

        await ctx.db.patch(upload._id, {
          status: "healing",
          isHealAttempted: true,
          healAttempts: 1,
          lastHealAt: now,
        });
        targets.push(toTarget(upload, 1));
      }
    }

    // 3. Completely empty candidates (flag false, or never set on legacy rows)
    if (targets.length < HEAL_BATCH_SIZE) {
      const notAttempted = await ctx.db
        .query("candidates")
        .withIndex("by_isHealAttempted", (q) => q.eq("isHealAttempted", false))
        .take(CANDIDATE_SCAN_SIZE);
      const neverFlagged = notAttempted.length < CANDIDATE_SCAN_SIZE
        ? await ctx.db
            .query("candidates")
            .withIndex("by_isHealAttempted", (q) => q.eq("isHealAttempted", undefined))
            .take(CANDIDATE_SCAN_SIZE - notAttempted.length)
        : [];

      for (const candidate of [...notAttempted, ...neverFlagged]) {
        if (targets.length >= HEAL_BATCH_SIZE) break;
        candidatesChecked++;

        // Mark every inspected candidate so the next tick moves on to new rows.
        await ctx.db.patch(candidate._id, { isHealAttempted: true });

        if (!isCandidateCompletelyEmpty(candidate) || !candidate.cvUploadId) continue;

        const upload = await ctx.db.get(candidate.cvUploadId);
        if (!upload || (!upload.s3Key && !upload.storageId)) continue;
        // Don't steal a record that another worker is actively extracting.
        if (upload.status === "processing" || upload.status === "healing") continue;

        await ctx.db.patch(upload._id, {
          status: "healing",
          isHealAttempted: true,
          healAttempts: (upload.healAttempts ?? 0) + 1,
          lastHealAt: now,
        });
        targets.push(toTarget(upload, (upload.healAttempts ?? 0) + 1, candidate.sourceChannel));
      }
    }

    return { targets, recoveredStuck, flaggedForReview, candidatesChecked };
  },
});

/**
 * Records the outcome of a healer tick so status reporting reflects real activity.
 */
export const recordHealerRun = internalMutation({
  args: {
    dispatched: v.number(),
    recoveredStuck: v.number(),
    flaggedForReview: v.number(),
    candidatesChecked: v.number(),
    dispatchErrors: v.number(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("healerState")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    const lastRun = {
      at: now,
      dispatched: args.dispatched,
      recoveredStuck: args.recoveredStuck,
      flaggedForReview: args.flaggedForReview,
      candidatesChecked: args.candidatesChecked,
      dispatchErrors: args.dispatchErrors,
      lastError: args.lastError,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastRunAt: now,
        lastRun,
        totalRuns: existing.totalRuns + 1,
        totalDispatched: existing.totalDispatched + args.dispatched,
        totalRecoveredStuck: existing.totalRecoveredStuck + args.recoveredStuck,
        totalFlaggedForReview: existing.totalFlaggedForReview + args.flaggedForReview,
        lastDispatchAt: args.dispatched > 0 ? now : existing.lastDispatchAt,
      });
    } else {
      await ctx.db.insert("healerState", {
        key: "singleton",
        lastRunAt: now,
        lastRun,
        totalRuns: 1,
        totalDispatched: args.dispatched,
        totalRecoveredStuck: args.recoveredStuck,
        totalFlaggedForReview: args.flaggedForReview,
        lastDispatchAt: args.dispatched > 0 ? now : undefined,
      });
    }
  },
});

export const releaseFailedClaim = internalMutation({
  args: {
    cvUploadId: v.id("cvUploads"),
    candidateId: v.optional(v.id("candidates")),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.cvUploadId, {
      status: "failed",
      isHealAttempted: true,
      errorMessage: args.errorMessage,
    });
    if (args.candidateId) {
      await ctx.db.patch(args.candidateId, { isHealAttempted: true });
    }
  },
});

/**
 * Healer status — real counts (bounded) and the last recorded run.
 */
export const getHealerStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const COUNT_CAP = 1000;

    const [queuedUploads, healingUploads, needsReview, state] = await Promise.all([
      ctx.db.query("cvUploads").withIndex("by_status", (q) => q.eq("status", "uploaded")).take(COUNT_CAP),
      ctx.db.query("cvUploads").withIndex("by_status", (q) => q.eq("status", "healing")).take(COUNT_CAP),
      ctx.db.query("cvUploads").withIndex("by_status", (q) => q.eq("status", "needs_review")).take(COUNT_CAP),
      ctx.db.query("healerState").withIndex("by_key", (q) => q.eq("key", "singleton")).first(),
    ]);

    const stuckHealing = healingUploads.filter((u) => {
      const lastDispatch = u.lastHealAt ?? u.processingStartedAt ?? u._creationTime;
      return now - lastDispatch >= STUCK_HEALING_MS;
    }).length;

    const lastRunAt = state?.lastRunAt;
    // Allow one missed tick plus slack before declaring the healer stalled.
    const stallThresholdMs = (HEALER_INTERVAL_MINUTES * 2 + 5) * 60 * 1000;
    const status = !lastRunAt
      ? "never_run"
      : now - lastRunAt <= stallThresholdMs
        ? "running"
        : "stalled";

    const fmt = (n: number) => (n >= COUNT_CAP ? `${COUNT_CAP}+` : n);

    return {
      status,
      healerActive: status === "running",
      intervalMinutes: HEALER_INTERVAL_MINUTES,
      batchSize: HEAL_BATCH_SIZE,
      maxHealAttempts: MAX_HEAL_ATTEMPTS,
      lastRunAt: lastRunAt ?? null,
      minutesSinceLastRun: lastRunAt ? Math.round((now - lastRunAt) / 60000) : null,
      lastDispatchAt: state?.lastDispatchAt ?? null,
      lastRun: state?.lastRun ?? null,
      totals: state
        ? {
            runs: state.totalRuns,
            dispatched: state.totalDispatched,
            recoveredStuck: state.totalRecoveredStuck,
            flaggedForReview: state.totalFlaggedForReview,
          }
        : null,
      counts: {
        uploadedQueued: fmt(queuedUploads.length),
        healing: fmt(healingUploads.length),
        stuckHealing: fmt(stuckHealing),
        needsReview: fmt(needsReview.length),
      },
      // Extraction model chain used by processCvExtraction: OpenRouter primary, NVIDIA NIM fallback.
      extractionModels: {
        primary: "deepseek/deepseek-v4-flash (OpenRouter)",
        fallback: "meta/llama-3.3-70b-instruct (NVIDIA NIM)",
      },
    };
  },
});
