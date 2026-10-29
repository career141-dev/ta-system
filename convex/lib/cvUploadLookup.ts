import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * The upload behind an upload, candidate or application id, with the file-hash
 * fallback. Shared by getCvUploadUrl and cvFileNames so both find the same file.
 */
export async function findCvUpload(ctx: QueryCtx, cvUploadId: string) {
  let validId = ctx.db.normalizeId("cvUploads", cvUploadId);
  let upload: any = validId ? await ctx.db.get(validId) : null;
  let candidate: any = null;

  if (!upload) {
    // 2. Try candidate ID lookup
    const candidateId = ctx.db.normalizeId("candidates", cvUploadId);
    if (candidateId) {
      candidate = await ctx.db.get(candidateId);
      if (candidate && candidate.cvUploadId) {
        upload = await ctx.db.get(candidate.cvUploadId as Id<"cvUploads">);
      }
    }
  }

  if (!upload) {
    // 3. Try application ID lookup
    const appId = ctx.db.normalizeId("applications", cvUploadId);
    if (appId) {
      const app = await ctx.db.get(appId);
      if (app) {
        if (app.cvFileId) {
          upload = await ctx.db.get(app.cvFileId as Id<"cvUploads">);
        }
        if (!upload && app.candidateId) {
          candidate = await ctx.db.get(app.candidateId);
          if (candidate && candidate.cvUploadId) {
            upload = await ctx.db.get(candidate.cvUploadId as Id<"cvUploads">);
          }
        }
      }
    }
  }

  // 4. File hash fallback
  if ((!upload || (!upload.storageId && !upload.s3Key)) && candidate?.fileHash) {
    const hashUpload = await ctx.db.query("cvUploads")
      .withIndex("by_fileHash", q => q.eq("fileHash", candidate.fileHash!))
      .first();
    if (hashUpload) upload = hashUpload;
  }
  return { upload, candidate };
}

/** The rows among `ids` with a stored CV file, by id: see candidates/candidates:cvFileNames. */
export async function cvFileNamesFor(ctx: QueryCtx, ids: string[]) {
  if (ids.length > 50) throw new Error("Ask for at most 50 CV file names at a time.");
  const names: Record<string, string> = {};
  for (const id of ids) {
    const { upload } = await findCvUpload(ctx, id);
    if (!upload) continue;
    // The same order getCvUploadUrl tests: an R2 key, else a stored file.
    const stored = (upload.storageProvider === "r2" || !upload.storageProvider) && upload.s3Key
      ? true
      : upload.storageId ? !!(await ctx.db.system.get(upload.storageId)) : false;
    if (stored) names[id] = upload.fileName || "CV.pdf";
  }
  return names;
}
