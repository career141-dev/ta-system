// convex/cvs/cvReplace.ts — one CV file per person (2 Oct).
//
// A person who applies again sent us a second copy of their CV, or a newer one.
// Both used to stay in storage and in cvUploads, so the same person had several
// files and the desk could open the wrong one. These keep a single file:
//   - the same file again  → the new upload points at the file already held and
//     its own copy is removed;
//   - a different file of the same person → the new file becomes their CV and every
//     opening they are on points at it. The old file is KEPT, marked replaced
//     (owner, 5 Oct): a wrong match must never delete someone's CV.
// Only an identical copy is ever removed, and only when no other upload row uses it.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

type Upload = Doc<"cvUploads">;

/** Does any other upload row still use this very file? */
async function stillUsed(ctx: MutationCtx, file: { s3Key?: string; storageId?: Id<"_storage"> }, exceptId: Id<"cvUploads">): Promise<boolean> {
  const sameFile = (u: Upload) =>
    u._id !== exceptId && ((file.s3Key && u.s3Key === file.s3Key) || (file.storageId && u.storageId === file.storageId));
  // Rows are found by the file's hash when it has one; older rows without a hash
  // are caught by the candidate's own uploads.
  const old = await ctx.db.get(exceptId);
  if (old?.fileHash) {
    for (const u of await ctx.db.query("cvUploads").withIndex("by_fileHash", (q) => q.eq("fileHash", old.fileHash!)).take(50)) {
      if (sameFile(u)) return true;
    }
  }
  if (old?.candidateId) {
    for (const u of await ctx.db.query("cvUploads").withIndex("by_candidateId", (q) => q.eq("candidateId", old.candidateId!)).take(50)) {
      if (sameFile(u)) return true;
    }
  }
  return false;
}

async function removeFile(ctx: MutationCtx, upload: Upload) {
  if (!upload.s3Key && !upload.storageId) return;
  if (await stillUsed(ctx, { s3Key: upload.s3Key, storageId: upload.storageId }, upload._id)) return;
  await ctx.scheduler.runAfter(0, internal.storage.r2.deleteCvFile, { s3Key: upload.s3Key, storageId: upload.storageId });
}

/**
 * The same file arrived again (same hash). Keep the file already held: the new
 * upload row points at it and its own copy is removed.
 */
export async function reuseHeldFile(ctx: MutationCtx, newUploadId: Id<"cvUploads">, heldUploadId: Id<"cvUploads"> | undefined | null) {
  if (!heldUploadId || heldUploadId === newUploadId) return false;
  const [fresh, held] = await Promise.all([ctx.db.get(newUploadId), ctx.db.get(heldUploadId)]);
  if (!fresh || !held) return false;
  if (!held.s3Key && !held.storageId) return false;
  const sameKey = (fresh.s3Key && fresh.s3Key === held.s3Key) || (fresh.storageId && fresh.storageId === held.storageId);
  if (sameKey) return false;
  await ctx.db.patch(newUploadId, { s3Key: held.s3Key, storageId: held.storageId, storageProvider: held.storageProvider });
  await removeFile(ctx, fresh);
  return true;
}

/**
 * A different file of the same person: the new one is their CV from now on.
 * Every application of theirs that pointed at the old file moves to the new
 * one. The old upload row and its file stay, marked as replaced.
 */
export async function replaceHeldCv(ctx: MutationCtx, candidateId: Id<"candidates">, oldUploadId: Id<"cvUploads"> | undefined | null, newUploadId: Id<"cvUploads">) {
  if (!oldUploadId || oldUploadId === newUploadId) return false;
  const [old, fresh] = await Promise.all([ctx.db.get(oldUploadId), ctx.db.get(newUploadId)]);
  if (!old || !fresh) return false;
  // Same file under another row (a copy that reuseHeldFile already merged): nothing to replace.
  if ((old.s3Key && old.s3Key === fresh.s3Key) || (old.storageId && old.storageId === fresh.storageId)) return false;
  for (const a of await ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId)).take(200)) {
    if (a.cvFileId === oldUploadId) await ctx.db.patch(a._id, { cvFileId: newUploadId, cvFileName: fresh.fileName });
  }
  // The old FILE is kept (owner, 5 Oct). Only the record moves to the new CV:
  // if the match was wrong — two people taken for one, as on 1 Oct — deleting
  // would lose a real person's CV for good, and 2,977 CVs are already missing.
  await ctx.db.patch(oldUploadId, { replacedByUploadId: newUploadId, status: "replaced" });
  return true;
}

/** The same file arrived again: callable from the extraction action. */
export const reuseFile = internalMutation({
  args: { newUploadId: v.id("cvUploads"), heldUploadId: v.optional(v.id("cvUploads")) },
  handler: async (ctx, args) => reuseHeldFile(ctx, args.newUploadId, args.heldUploadId),
});
