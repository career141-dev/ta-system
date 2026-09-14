"use node";

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel.d.ts";
import { runCvExtraction } from "../cvs/cvExtraction";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function workableUrl(subdomain: string, path: string) {
  return `https://${subdomain}.workable.com/spi/v3${path}`;
}

type WorkableCandidateDetail = {
  candidate: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    resume_url?: string;
    resume?: { url?: string; file_url?: string };
    attachments?: Array<{ url?: string; file_url?: string; type?: string; name?: string }>;
  };
};

/**
 * 5-Tier Fallback Resume URL Resolver:
 * 1. Top-level resume_url (most reliable)
 * 2. Nested resume object (url or file_url)
 * 3. Attachments explicitly typed as resume or cv
 * 4. Any attachment whose name contains "cv" or "resume"
 * 5. Fallback to ANY attachment with a URL
 */
function extractResumeUrl(detail: WorkableCandidateDetail["candidate"]): string | undefined {
  if (detail.resume_url) return detail.resume_url;
  if (detail.resume?.url) return detail.resume.url;
  if (detail.resume?.file_url) return detail.resume.file_url;

  const typedAttachment = detail.attachments?.find(
    (a) => a.type === "resume" || a.type === "cv"
  );
  if (typedAttachment?.url) return typedAttachment.url;
  if (typedAttachment?.file_url) return typedAttachment.file_url;

  const namedAttachment = detail.attachments?.find((a) => {
    const name = (a.name ?? "").toLowerCase();
    return name.includes("cv") || name.includes("resume");
  });
  if (namedAttachment?.url) return namedAttachment.url;
  if (namedAttachment?.file_url) return namedAttachment.file_url;

  const anyAttachment = detail.attachments?.find((a) => a.url ?? a.file_url);
  if (anyAttachment?.url) return anyAttachment.url;
  if (anyAttachment?.file_url) return anyAttachment.file_url;

  return undefined;
}

type WorkableCandidatesPage = {
  candidates: Array<{ id: string; name: string }>;
  paging?: { next?: string };
};

async function fetchPage(
  subdomain: string,
  apiKey: string,
  nextUrl?: string
): Promise<WorkableCandidatesPage> {
  const url = nextUrl ?? workableUrl(subdomain, "/candidates?limit=20");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 429) throw new Error("RATE_LIMIT_429");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Workable API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<WorkableCandidatesPage>;
}

async function fetchCandidateDetail(
  subdomain: string,
  apiKey: string,
  candidateId: string
): Promise<{ resumeUrl?: string; name: string; email?: string; phone?: string }> {
  // Throttle 700ms to stay safely under Workable rate limits (~1 req/sec)
  await new Promise((r) => setTimeout(r, 700));
  const url = workableUrl(subdomain, `/candidates/${candidateId}`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 429) throw new Error("RATE_LIMIT_429");
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const data = (await res.json()) as WorkableCandidateDetail;
  return {
    name: data.candidate.name,
    email: data.candidate.email,
    phone: data.candidate.phone,
    resumeUrl: extractResumeUrl(data.candidate),
  };
}

function detectFileType(url: string, contentType: string): string {
  const normalizedUrl = url.toLowerCase();
  const ext = normalizedUrl.match(/\.(pdf|docx?|rtf|txt)$/)?.[1] ?? "";

  if (ext === "pdf" || contentType.includes("pdf")) return "pdf";
  if (ext === "docx" || ext === "doc" || contentType.includes("word") || contentType.includes("docx")) return "docx";
  if (ext === "rtf") return "rtf";
  if (ext === "txt") return "txt";

  return "pdf";
}

async function downloadResume(
  resumeUrl: string
): Promise<{ buffer: ArrayBuffer; contentType: string; fileType: string } | null> {
  try {
    const res = await fetch(resumeUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "application/pdf";
    const fileType = detectFileType(resumeUrl, contentType);
    return { buffer: await res.arrayBuffer(), contentType, fileType };
  } catch {
    return null;
  }
}

// ─── Test connection ──────────────────────────────────────────────────────────

export const testConnection = action({
  args: { subdomain: v.string(), apiKey: v.string() },
  handler: async (_ctx, args): Promise<{ ok: boolean; error?: string }> => {
    try {
      await fetchPage(args.subdomain, args.apiKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
    }
  },
});

// ─── Start bulk import ────────────────────────────────────────────────────────

export const startBulkImport = action({
  args: {
    subdomain: v.string(),
    apiKey: v.string(),
    userId: v.optional(v.string()),
    maxCandidates: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ importId: string }> => {
    let currentUserId = args.userId;
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      currentUserId = identity.tokenIdentifier;
    }
    if (!currentUserId) {
      throw new ConvexError({ message: "Not authenticated", code: "UNAUTHENTICATED" });
    }

    const maxCandidates = args.maxCandidates ?? 500; // Default target cap 500 for this run

    const lastJob: any = await ctx.runQuery(internal.integrations.workable.getLatestImportJob as any, {});
    const nextUrl = lastJob && lastJob.userId === currentUserId ? lastJob.lastCursor : undefined;

    const importId = await ctx.runMutation(internal.integrations.workable.createImportJob, {
      userId: currentUserId,
      totalCandidates: 0,
      maxCandidates,
      subdomain: args.subdomain,
      apiKey: args.apiKey,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.workableActions.runImportBatch, {
      importId,
      subdomain: args.subdomain,
      apiKey: args.apiKey,
      userId: currentUserId,
      nextUrl: nextUrl,
      imported: 0,
      skipped: 0,
      deduplicated: 0,
      failed: 0,
      maxCandidates,
    });

    return { importId };
  },
});

// ─── Get latest import status ─────────────────────────────────────────────────

export const getLatestImportStatus = action({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    let currentUserId = args.userId;
    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      currentUserId = identity.tokenIdentifier;
    }
    const job: any = await ctx.runQuery(internal.integrations.workable.getLatestImportJob as any, {});
    if (!job) return null;
    if (currentUserId && job.userId !== currentUserId) return null;
    return { ...job, deduplicated: job.deduplicated ?? 0 };
  },
});

export const getImportStatus = action({
  args: { importId: v.id("workableImports") },
  handler: async (ctx, args): Promise<any> => {
    const job: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!job) return null;
    return { ...job, deduplicated: job.deduplicated ?? 0 };
  },
});

// ─── Retry / Resume a stopped or failed import ─────────────────────────────

export const retryImport = action({
  args: {
    importId: v.id("workableImports"),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    maxCandidates: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const job: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!job) throw new ConvexError({ message: "Import job not found", code: "NOT_FOUND" });

    const subdomain = args.subdomain ?? job.subdomain;
    const apiKey = args.apiKey ?? job.apiKey;
    const maxCandidates = args.maxCandidates ?? job.maxCandidates ?? 500;
    if (!subdomain || !apiKey) {
      throw new ConvexError({ message: "Please enter your Workable subdomain and API key.", code: "BAD_REQUEST" });
    }

    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      status: "running",
      errorMessage: "",
      maxCandidates,
      subdomain,
      apiKey,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.workableActions.runImportBatch, {
      importId: args.importId,
      subdomain,
      apiKey,
      userId: job.userId,
      nextUrl: job.lastCursor ?? undefined,
      imported: job.imported,
      skipped: job.skipped,
      deduplicated: job.deduplicated ?? 0,
      failed: job.failed,
      maxCandidates,
    });
  },
});

// ─── Retry skipped (no CV) candidates from the beginning ─────────────────────

export const retrySkipped = action({
  args: {
    importId: v.id("workableImports"),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const job: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!job) throw new ConvexError({ message: "Import job not found", code: "NOT_FOUND" });

    const subdomain = args.subdomain ?? job.subdomain;
    const apiKey = args.apiKey ?? job.apiKey;
    if (!subdomain || !apiKey) {
      throw new ConvexError({ message: "Please enter your Workable subdomain and API key.", code: "BAD_REQUEST" });
    }

    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      status: "running",
      errorMessage: "",
      skipped: 0,
      failed: 0,
      subdomain,
      apiKey,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.workableActions.runImportBatch, {
      importId: args.importId,
      subdomain,
      apiKey,
      userId: job.userId,
      nextUrl: undefined, 
      imported: job.imported,
      skipped: 0,
      deduplicated: job.deduplicated ?? 0,
      failed: 0,
      maxCandidates: job.maxCandidates ?? 500,
    });
  },
});

// ─── Stop a running import ────────────────────────────────────────────────────

// ─── Pause a running import ──────────────────────────────────────────────────

export const pauseImport = action({
  args: { importId: v.id("workableImports") },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      status: "paused",
    });
  },
});

// ─── Resume a paused import ──────────────────────────────────────────────────

export const resumeImport = action({
  args: {
    importId: v.id("workableImports"),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const job: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!job) throw new ConvexError({ message: "Import job not found", code: "NOT_FOUND" });

    const subdomain = args.subdomain ?? job.subdomain;
    const apiKey = args.apiKey ?? job.apiKey;
    if (!subdomain || !apiKey) {
      throw new ConvexError({ message: "Please enter your Workable subdomain and API key.", code: "BAD_REQUEST" });
    }

    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      status: "running",
      errorMessage: "",
      subdomain,
      apiKey,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.workableActions.runImportBatch, {
      importId: args.importId,
      subdomain,
      apiKey,
      userId: job.userId,
      nextUrl: job.lastCursor ?? undefined,
      imported: job.imported,
      skipped: job.skipped,
      deduplicated: job.deduplicated ?? 0,
      failed: job.failed,
      maxCandidates: job.maxCandidates ?? 500,
    });
  },
});

// ─── Stop a running import ────────────────────────────────────────────────────

export const stopImport = action({
  args: { importId: v.id("workableImports") },
  handler: async (ctx, args): Promise<void> => {
    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      status: "stopped",
      errorMessage: "Import stopped by user.",
    });
  },
});

// ─── Core import batch runner (20 per API page, configurable max limit e.g. 500) ──

export const runImportBatch = internalAction({
  args: {
    importId: v.id("workableImports"),
    subdomain: v.string(),
    apiKey: v.string(),
    userId: v.string(),
    nextUrl: v.optional(v.string()),
    candidateIndex: v.optional(v.number()),
    imported: v.number(),
    skipped: v.number(),
    deduplicated: v.number(),
    failed: v.number(),
    maxCandidates: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const startTime = Date.now();
    const MAX_ACTION_DURATION_MS = 35000; // Yield execution after 35s to prevent Convex Action Timeout (120s limit)

    let imported = args.imported;
    let skipped = args.skipped;
    let deduplicated = args.deduplicated;
    let failed = args.failed;
    const maxLimit = args.maxCandidates ?? 500;
    const startIndex = args.candidateIndex ?? 0;

    const currentJob: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!currentJob || currentJob.status === "stopped" || currentJob.status === "paused" || currentJob.status === "done") return;

    // Check if target imported candidates count has been reached
    if (maxLimit > 0 && imported >= maxLimit) {
      await ctx.runMutation(internal.integrations.workable.updateImportJob, {
        importId: args.importId,
        status: "done",
      });
      return;
    }

    const currentUrl = args.nextUrl ?? workableUrl(args.subdomain, "/candidates?limit=20");

    let page: WorkableCandidatesPage;
    try {
      page = await fetchPage(args.subdomain, args.apiKey, currentUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      if (msg === "RATE_LIMIT_429") {
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          imported,
          skipped,
          deduplicated,
          failed,
          lastCursor: currentUrl,
        });
        await ctx.scheduler.runAfter(90000, internal.integrations.workableActions.runImportBatch, {
          ...args,
          nextUrl: currentUrl,
          imported,
          skipped,
          deduplicated,
          failed,
        });
        return;
      }
      await ctx.runMutation(internal.integrations.workable.updateImportJob, {
        importId: args.importId,
        status: "error",
        errorMessage: msg,
        imported,
        skipped,
        deduplicated,
        failed,
      });
      return;
    }

    if (page.candidates.length > 0 && startIndex === 0) {
      const job: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
      if (job) {
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          totalCandidates: (job.totalCandidates ?? 0) + page.candidates.length,
        });
      }
    }

    for (let i = startIndex; i < page.candidates.length; i++) {
      const candidate = page.candidates[i];

      // Time budget check: if running close to Convex action timeout limit, yield execution & schedule next batch
      if (Date.now() - startTime > MAX_ACTION_DURATION_MS) {
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          imported,
          skipped,
          deduplicated,
          failed,
          lastCursor: currentUrl,
          candidateIndex: i,
        });
        await ctx.scheduler.runAfter(200, internal.integrations.workableActions.runImportBatch, {
          ...args,
          nextUrl: currentUrl,
          imported,
          skipped,
          deduplicated,
          failed,
          candidateIndex: i,
        });
        return;
      }

      // Re-verify if job was stopped or paused mid-batch or target max reached
      const checkJob: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
      if (!checkJob || checkJob.status === "stopped" || checkJob.status === "paused") return;

      if (maxLimit > 0 && imported >= maxLimit) {
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          imported,
          skipped,
          deduplicated,
          failed,
          status: "done",
          lastCursor: currentUrl,
          candidateIndex: i,
        });
        return;
      }

      try {
        const existing: any = await ctx.runQuery(internal.integrations.workable.findCandidateByWorkableId as any, {
          workableCandidateId: candidate.id,
        });
        if (existing) {
          deduplicated++;
          await ctx.runMutation(internal.integrations.workable.updateImportJob, {
            importId: args.importId,
            deduplicated,
          });
          continue;
        }

        let detail: { resumeUrl?: string; name: string; email?: string; phone?: string };
        try {
          detail = await fetchCandidateDetail(args.subdomain, args.apiKey, candidate.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (msg === "RATE_LIMIT_429") {
            await ctx.runMutation(internal.integrations.workable.updateImportJob, {
              importId: args.importId,
              imported,
              skipped,
              deduplicated,
              failed,
              lastCursor: currentUrl,
              candidateIndex: i,
            });
            await ctx.scheduler.runAfter(90000, internal.integrations.workableActions.runImportBatch, {
              ...args,
              nextUrl: currentUrl,
              imported,
              skipped,
              deduplicated,
              failed,
              candidateIndex: i,
            });
            return;
          }
          if (msg.startsWith("HTTP_")) {
            await ctx.runMutation(internal.integrations.workable.updateImportJob, {
              importId: args.importId,
              errorMessage: `API error fetching candidate ${candidate.id}: ${msg}`,
            });
          }
          failed++;
          continue;
        }

        if (!detail.resumeUrl) {
          skipped++;
          await ctx.runMutation(internal.integrations.workable.updateImportJob, {
            importId: args.importId,
            skipped,
          });
          continue;
        }

        const downloaded = await downloadResume(detail.resumeUrl);
        if (!downloaded) {
          failed++;
          await ctx.runMutation(internal.integrations.workable.updateImportJob, {
            importId: args.importId,
            failed,
          });
          continue;
        }

        const fileName = `${detail.name || candidate.id}.${downloaded.fileType}`;
        const base64Data = Buffer.from(downloaded.buffer).toString("base64");
        
        // Upload CV binary buffer to Cloudflare R2 storage
        const s3Key = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
          fileName,
          contentType: downloaded.contentType,
          base64Data,
        });

        // Insert cvUploads record referencing Cloudflare R2 storage
        const cvUploadId = await ctx.runMutation(internal.integrations.workable.insertCvUpload, {
          s3Key,
          storageProvider: "r2",
          fileName,
          fileType: downloaded.fileType,
          fileSize: downloaded.buffer.byteLength,
          userId: args.userId,
        });

        // Schedule background AI CV extraction (DeepSeek V4 Flash) via Convex Scheduler
        await ctx.scheduler.runAfter(imported * 1000, api.cvs.cvExtraction.processCvExtraction, {
          s3Key,
          storageProvider: "r2",
          fileType: downloaded.fileType,
          sourceChannel: "Workable",
          uploadedBy: args.userId,
          cvUploadId,
          workableCandidateId: candidate.id,
          skipLLM: false,
          preExtractedData: {
            fullName: detail.name || candidate.name,
            email: detail.email,
            phone: detail.phone,
          },
        });

        imported++;
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          imported,
          skipped,
          deduplicated,
          failed,
          lastCursor: currentUrl,
          candidateIndex: i + 1,
        });
      } catch (err) {
        console.error(`[WorkableImport] Error processing candidate ${candidate.id}:`, err);
        failed++;
        await ctx.runMutation(internal.integrations.workable.updateImportJob, {
          importId: args.importId,
          imported,
          skipped,
          deduplicated,
          failed,
          lastCursor: currentUrl,
          candidateIndex: i + 1,
        });
      }
    }

    // Save batch progress and page cursor
    await ctx.runMutation(internal.integrations.workable.updateImportJob, {
      importId: args.importId,
      imported,
      skipped,
      deduplicated,
      failed,
      lastCursor: page.paging?.next ?? undefined,
      candidateIndex: 0,
    });

    // Chain to next page if next cursor exists, job is running, and imported target limit not reached
    const checkEndJob: any = await ctx.runQuery(internal.integrations.workable.getImportJob as any, { importId: args.importId });
    if (!checkEndJob || checkEndJob.status === "stopped" || checkEndJob.status === "paused") return;

    if (page.paging?.next && (maxLimit === 0 || imported < maxLimit)) {
      await ctx.scheduler.runAfter(500, internal.integrations.workableActions.runImportBatch, {
        importId: args.importId,
        subdomain: args.subdomain,
        apiKey: args.apiKey,
        userId: args.userId,
        nextUrl: page.paging.next,
        candidateIndex: 0,
        imported,
        skipped,
        deduplicated,
        failed,
        maxCandidates: maxLimit,
      });
    } else {
      await ctx.runMutation(internal.integrations.workable.updateImportJob, {
        importId: args.importId,
        status: "done",
      });
    }
  },
});
