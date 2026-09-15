import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

const LOCK_TTL_MS = 60000; // 60 seconds TTL for stale locks

/**
 * Acquire candidate identity locks for a given cvUploadId.
 * Checks email, phone, and linkedinUrl lock keys.
 * If any lock key is held by an active extraction task (< 60s old), returns { acquired: false }.
 */
export const acquireIdentityLocks = internalMutation({
  args: {
    cvUploadId: v.id("cvUploads"),
    lockKeys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cleanKeys = args.lockKeys
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 3);

    if (cleanKeys.length === 0) {
      return { acquired: true, keysLocked: [] };
    }

    // Check if any key is currently locked by another active upload
    for (const key of cleanKeys) {
      const existing = await ctx.db
        .query("candidateLocks")
        .withIndex("by_lockKey", (q) => q.eq("lockKey", key))
        .first();

      if (existing) {
        if (existing.cvUploadId === args.cvUploadId) {
          // Already locked by this same upload
          continue;
        }
        if (now - existing.lockedAt < LOCK_TTL_MS) {
          // Key is locked by another active upload!
          return { acquired: false, conflictingKey: key };
        } else {
          // Stale lock — clean it up
          await ctx.db.delete(existing._id);
        }
      }
    }

    // Acquire lock on all keys
    for (const key of cleanKeys) {
      await ctx.db.insert("candidateLocks", {
        lockKey: key,
        cvUploadId: args.cvUploadId,
        lockedAt: now,
      });
    }

    return { acquired: true, keysLocked: cleanKeys };
  },
});

/**
 * Release all candidate identity locks held by a cvUploadId.
 */
export const releaseIdentityLocks = internalMutation({
  args: {
    cvUploadId: v.id("cvUploads"),
  },
  handler: async (ctx, args) => {
    const locks = await ctx.db
      .query("candidateLocks")
      .withIndex("by_cvUploadId", (q) => q.eq("cvUploadId", args.cvUploadId))
      .collect();

    for (const lock of locks) {
      await ctx.db.delete(lock._id);
    }

    return { releasedCount: locks.length };
  },
});
