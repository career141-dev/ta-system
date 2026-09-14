// V8 runtime — mutations and queries for ZIP bulk export import job management
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel.d.ts";

/**
 * Called after uploading a file to Cloudflare R2 storage during ZIP bulk import.
 * Creates the cvUploads record and schedules background CV text extraction.
 */
export const createCvFromZip = mutation({
  args: {
    s3Key: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    fileHash: v.string(),
    sourceLevel1: v.optional(v.string()),
    sourceLevel2: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"cvUploads">> => {
    let userId = "system";
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      userId = identity.tokenIdentifier;
    }

    const cvUploadId = await ctx.db.insert("cvUploads", {
      s3Key: args.s3Key,
      storageProvider: "r2",
      fileName: args.fileName,
      fileType: args.fileType,
      fileSize: args.fileSize,
      fileHash: args.fileHash,
      source: "Workable_ZIP",
      uploadedBy: userId,
      status: "pending",
    });

    // Schedule background CV extraction with a small staggered delay
    const delayMs = Math.floor(Math.random() * 3000);
    await ctx.scheduler.runAfter(delayMs, api.cvs.cvExtraction.processCvExtraction, {
      s3Key: args.s3Key,
      storageProvider: "r2",
      fileType: args.fileType,
      sourceChannel: "Workable_ZIP",
      uploadedBy: userId,
      cvUploadId,
      skipLLM: true,
    });

    return cvUploadId;
  },
});

/**
 * Returns true if a CV with this file hash already exists (SHA-256 duplicate check).
 */
export const checkDuplicateHash = mutation({
  args: { fileHash: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const existingUpload = await ctx.db
      .query("cvUploads")
      .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash))
      .first();
    
    if (existingUpload !== null) {
      // If candidate record was created, it's a true duplicate
      if (existingUpload.candidateId) return true;

      // If upload failed and has remaining attempts (< 1), it is retry-eligible -> not duplicate
      const attempts = existingUpload.extractionAttempts ?? 0;
      if (existingUpload.status === "failed" && attempts < 1) {
        return false;
      }
      
      // In-flight, needs_review, soft-terminal, or attempt cap reached -> treat as duplicate (block bulk import)
      return true;
    }

    const existingCandidate = await ctx.db
      .query("candidates")
      .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash))
      .first();
    return existingCandidate !== null;
  },
});

// ─── Create a new ZIP import job ──────────────────────────────────────────────

export const createJob = mutation({
  args: {
    urls: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"zipImportJobs">> => {
    let userId = "admin";
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      userId = identity.tokenIdentifier;
    }

    const now = new Date().toISOString();
    return ctx.db.insert("zipImportJobs", {
      userId,
      urls: args.urls,
      currentUrlIndex: 0,
      currentFileIndex: 0,
      status: "running",
      totalFound: 0,
      imported: 0,
      duplicates: 0,
      notCv: 0,
      errors: 0,
      startedAt: now,
      updatedAt: now,
    });
  },
});

// ─── Pause / Resume / Stop status ─────────────────────────────────────────────

export const setStatus = mutation({
  args: {
    jobId: v.id("zipImportJobs"),
    status: v.union(
      v.literal("running"),
      v.literal("paused"),
      v.literal("stopped"),
      v.literal("done"),
      v.literal("error")
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.jobId, { status: args.status, updatedAt: new Date().toISOString() });
  },
});

// ─── Update progress from client loop ─────────────────────────────────────────

export const updateProgressPublic = mutation({
  args: {
    jobId: v.id("zipImportJobs"),
    currentUrlIndex: v.number(),
    currentFileIndex: v.number(),
    totalFound: v.number(),
    imported: v.number(),
    duplicates: v.number(),
    notCv: v.number(),
    errors: v.number(),
    status: v.union(
      v.literal("running"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("error"),
      v.literal("stopped")
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.jobId, {
      currentUrlIndex: args.currentUrlIndex,
      currentFileIndex: args.currentFileIndex,
      totalFound: args.totalFound,
      imported: args.imported,
      duplicates: args.duplicates,
      notCv: args.notCv,
      errors: args.errors,
      status: args.status,
      updatedAt: new Date().toISOString(),
      errorMessage: args.errorMessage,
    });
  },
});

// ─── Queries ──────────────────────────────────────────────────────────────────

export const getJob = query({
  args: { jobId: v.id("zipImportJobs") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.jobId);
  },
});

export const listJobs = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity ? identity.tokenIdentifier : "admin";
    return ctx.db
      .query("zipImportJobs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
  },
});
